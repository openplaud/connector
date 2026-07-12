/**
 * Service worker.
 *
 * Coordinates the bridge flow:
 *   1. content-bridge (running on the user's Riffado origin) sends
 *      `bridge:request-connect` when the user clicks "Continue with Plaud".
 *   2. We open https://web.plaud.ai in a new focused tab and remember which
 *      Riffado tab to send the result back to.
 *   3. content-plaud (running on web.plaud.ai) sends `plaud:token-captured`
 *      with the access token + detected region.
 *   4. We forward the token back to the originating Riffado tab and close
 *      (or leave) the plaud.ai tab.
 *
 * Only one bridge request can be in flight at a time \u2014 starting a second
 * cancels the first. Keeps the model simple; the user is never juggling
 * two connect attempts.
 */

import type {
    ConnectorTokenPayload,
    RuntimeMessage,
    RuntimeResponse,
} from "./lib/messages";
import { getPairedOrigins, ORIGINS_STORAGE_KEY } from "./lib/storage";

interface BridgeState {
    bridgeTabId: number;
    plaudTabId?: number;
    startedAt: number;
}

let pending: BridgeState | null = null;
const BRIDGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function clearPending(): void {
    pending = null;
}

function isStale(state: BridgeState): boolean {
    return Date.now() - state.startedAt > BRIDGE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Dynamic bridge registration for paired self-hosted origins.
//
// The bridge content script is declared statically in the manifest only for
// the hosted origin (riffado.com). Self-hosted instances are paired at
// runtime via the popup, which grants host permission for the origin — but in
// MV3 granting a host permission does NOT make a statically-declared content
// script start running on a new origin. Without registering the script for
// paired origins, `window.__riffadoConnector` is never defined there and the
// app shows the "Install Riffado Connector" CTA forever.
//
// We mirror the manifest's bridge script onto every paired origin via
// chrome.scripting, reading its built path out of the runtime manifest so we
// never hardcode a bundler-hashed filename.
// ---------------------------------------------------------------------------

const DYNAMIC_BRIDGE_PREFIX = "riffado-bridge:";

function bridgeScriptFiles(): string[] {
    const manifest = chrome.runtime.getManifest();
    const bridge = (manifest.content_scripts ?? []).find((cs) =>
        (cs.matches ?? []).some((m) => m.includes("riffado.com")),
    );
    return bridge?.js ?? [];
}

async function syncPairedContentScripts(): Promise<void> {
    const js = bridgeScriptFiles();
    if (js.length === 0) return; // no bridge script in the manifest to mirror

    const paired = await getPairedOrigins();
    const wanted = new Map<string, string>(); // registration id -> match glob
    for (const { origin } of paired) {
        wanted.set(`${DYNAMIC_BRIDGE_PREFIX}${origin}`, `${origin}/*`);
    }

    let registered: chrome.scripting.RegisteredContentScript[] = [];
    try {
        registered = await chrome.scripting.getRegisteredContentScripts();
    } catch {
        return; // scripting API unavailable; nothing to do
    }
    const ours = registered.filter((s) =>
        s.id.startsWith(DYNAMIC_BRIDGE_PREFIX),
    );

    // Drop registrations for origins the user has un-paired.
    const stale = ours.filter((s) => !wanted.has(s.id)).map((s) => s.id);
    if (stale.length > 0) {
        await chrome.scripting
            .unregisterContentScripts({ ids: stale })
            .catch(() => {});
    }

    // Register newly-paired origins we actually hold host permission for.
    const existing = new Set(ours.map((s) => s.id));
    for (const [id, matches] of wanted) {
        if (existing.has(id)) continue;
        const granted = await chrome.permissions
            .contains({ origins: [matches] })
            .catch(() => false);
        if (!granted) continue; // permission revoked out-of-band; skip
        try {
            await chrome.scripting.registerContentScripts([
                {
                    id,
                    js,
                    matches: [matches],
                    runAt: "document_start",
                    allFrames: false,
                    persistAcrossSessions: true,
                },
            ]);
        } catch (err) {
            console.warn(
                "[riffado-connector] failed to register bridge for",
                matches,
                err,
            );
        }
    }
}

// Keep dynamic registrations in step with the paired-origins list as the
// popup adds/removes instances.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(ORIGINS_STORAGE_KEY in changes)) return;
    syncPairedContentScripts().catch((err) =>
        console.warn("[riffado-connector] content-script sync failed:", err),
    );
});

async function startBridge(bridgeTabId: number): Promise<void> {
    // Cancel any prior bridge request \u2014 we only support one at a time.
    if (pending) {
        try {
            if (pending.plaudTabId !== undefined) {
                await chrome.tabs.remove(pending.plaudTabId);
            }
        } catch {
            // Tab may already be gone. Ignore.
        }
    }

    const tab = await chrome.tabs.create({
        url: "https://web.plaud.ai/",
        active: true,
    });

    pending = {
        bridgeTabId,
        plaudTabId: tab.id,
        startedAt: Date.now(),
    };
}

async function deliverTokenToBridge(
    payload: ConnectorTokenPayload,
): Promise<void> {
    if (!pending) return;
    if (isStale(pending)) {
        clearPending();
        return;
    }

    const { bridgeTabId, plaudTabId } = pending;

    try {
        await chrome.tabs.sendMessage(bridgeTabId, {
            type: "plaud:token-captured",
            payload,
        } satisfies RuntimeMessage);
    } catch (err) {
        // Bridge tab might have been closed or navigated. Nothing useful we
        // can do; surface in the console for debugging.
        console.warn("[riffado-connector] bridge tab unreachable:", err);
    }

    // Close the plaud.ai tab now that we've harvested what we needed.
    if (plaudTabId !== undefined) {
        try {
            await chrome.tabs.remove(plaudTabId);
        } catch {
            // Tab may already be gone.
        }
    }

    clearPending();
}

chrome.runtime.onMessage.addListener(
    (
        msg: RuntimeMessage,
        sender,
        sendResponse: (resp: RuntimeResponse) => void,
    ) => {
        if (msg.type === "bridge:request-connect") {
            const tabId = msg.bridgeTabId ?? sender.tab?.id;
            if (typeof tabId !== "number") {
                sendResponse({
                    ok: false,
                    error: "could not determine originating tab id",
                });
                return false;
            }
            startBridge(tabId).then(
                () => sendResponse({ ok: true }),
                (err: unknown) =>
                    sendResponse({
                        ok: false,
                        error: err instanceof Error ? err.message : String(err),
                    }),
            );
            return true; // async response
        }

        if (msg.type === "plaud:token-captured") {
            deliverTokenToBridge(msg.payload).then(
                () => sendResponse({ ok: true }),
                (err: unknown) =>
                    sendResponse({
                        ok: false,
                        error: err instanceof Error ? err.message : String(err),
                    }),
            );
            return true;
        }

        if (msg.type === "bridge:cancel") {
            if (pending?.plaudTabId !== undefined) {
                chrome.tabs
                    .remove(pending.plaudTabId)
                    .catch(() => {})
                    .finally(() => clearPending());
            } else {
                clearPending();
            }
            sendResponse({ ok: true });
            return false;
        }

        return false;
    },
);

// Garbage-collect stale pending state on startup (service workers can wake
// up after a long sleep). Also reconcile bridge registrations in case the
// paired-origins list changed while the worker was asleep.
chrome.runtime.onStartup.addListener(() => {
    if (pending && isStale(pending)) clearPending();
    void syncPairedContentScripts();
});

// Register the bridge for already-paired origins on install/update (dynamic
// registrations declared with persistAcrossSessions survive, but reconciling
// here covers upgrades from a version that never registered them at all).
chrome.runtime.onInstalled.addListener((details) => {
    void syncPairedContentScripts();

    // First-run onboarding: open the welcome tab once on fresh install. We
    // intentionally do NOT open it on update or browser_update so we don't
    // nag returning users every time they get a new version.
    if (details.reason !== "install") return;
    chrome.tabs
        .create({ url: chrome.runtime.getURL("src/welcome.html") })
        .catch((err) => {
            console.warn(
                "[riffado-connector] failed to open welcome tab:",
                err,
            );
        });
});
