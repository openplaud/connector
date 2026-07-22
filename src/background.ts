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

// The statically-declared bridge content script (the one covering the hosted
// origin). We reuse both its built js path and its match list. It's identified
// by its source module name — the bundler emits a hashed filename that still
// contains "content-bridge", an unambiguous fingerprint. Matching on the
// riffado.com origin instead would be fragile: a future unrelated script could
// share that origin (or a `notriffado.com` match would substring-match it).
function bridgeContentScript() {
    const manifest = chrome.runtime.getManifest();
    return (manifest.content_scripts ?? []).find((cs) =>
        (cs.js ?? []).some((f) => f.includes("content-bridge")),
    );
}

function bridgeScriptFiles(): string[] {
    return bridgeContentScript()?.js ?? [];
}

// Origins already covered by the static bridge declaration. Registering these
// dynamically would double-inject the bridge (duplicate connect requests), so
// they're excluded from the dynamic set.
function staticallyCoveredOrigins(): Set<string> {
    const matches = bridgeContentScript()?.matches ?? [];
    return new Set(matches.map((m) => m.replace(/\/\*$/, "")));
}

async function reconcilePairedContentScripts(): Promise<void> {
    const js = bridgeScriptFiles();
    if (js.length === 0) return; // no bridge script in the manifest to mirror

    const covered = staticallyCoveredOrigins();
    const paired = await getPairedOrigins();
    const wanted = new Map<string, string>(); // registration id -> match glob
    for (const { origin } of paired) {
        if (covered.has(origin)) continue; // already injected statically
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

// Serialize + coalesce reconciliations. onStartup, onInstalled and the
// storage.onChanged listener can all fire near-simultaneously; without this,
// two overlapping runs would compute the same "new" origins and race on
// registerContentScripts (duplicate id → thrown, then swallowed as a
// misleading "failed to register" warning). Runs are serialized; requests
// arriving mid-run collapse into a single trailing run.
let reconcileRunning = false;
let reconcileQueued = false;

async function syncPairedContentScripts(): Promise<void> {
    if (reconcileRunning) {
        reconcileQueued = true;
        return;
    }
    reconcileRunning = true;
    try {
        do {
            reconcileQueued = false;
            // Catch per pass: if one reconcile rejects (e.g. a storage read
            // throws), we must still drain any work that was coalesced during
            // it. Letting the rejection escape the loop would reset
            // reconcileRunning in `finally` while leaving reconcileQueued set,
            // silently dropping that trailing pass until an unrelated event
            // happened to trigger another sync.
            try {
                await reconcilePairedContentScripts();
            } catch (err) {
                console.warn(
                    "[riffado-connector] bridge reconciliation pass failed:",
                    err,
                );
            }
        } while (reconcileQueued);
    } finally {
        reconcileRunning = false;
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

/**
 * Confirm a captured token actually authenticates against Plaud before we
 * hand it to the bridge and close the plaud.ai tab.
 *
 * content-plaud.ts captures the first JWT-shaped value it finds under a
 * `pld_*` localStorage key, with no proof that a login actually completed --
 * a leftover token from a prior/expired session (or a transient value Plaud
 * writes mid-handshake during an SSO redirect) looks identical to a real
 * one at that layer. Without this check, the background worker used to
 * close the plaud.ai tab the instant *any* such value appeared, which could
 * happen before the user ever saw the login form. The eventual connect on
 * the Riffado side would then fail against a dead token, surfacing as a
 * confusing server-side error there (see riffado/riffado#231).
 *
 * `/team-app/workspaces/list` is the same endpoint the Riffado server uses
 * to validate a freshly connected token, so "verified here" and "verified
 * server-side" agree. `apiBase` is constrained by `content-plaud.ts` to the
 * hosts covered by `host_permissions` (see `isPermittedApiHost` below),
 * which this function double-checks before fetching -- a request to any
 * other host would be blocked by the browser anyway, but failing fast here
 * gives a clear console message instead of a generic network-error catch.
 */
const VERIFY_TIMEOUT_MS = 8_000;

function isPermittedApiHost(apiBase: string): boolean {
    try {
        const origin = new URL(apiBase).origin;
        const granted: string[] =
            chrome.runtime.getManifest().host_permissions ?? [];
        return granted.some((pattern: string) => {
            try {
                return new URL(pattern).origin === origin;
            } catch {
                return false;
            }
        });
    } catch {
        return false;
    }
}

async function verifyPlaudToken(
    accessToken: string,
    apiBase: string,
): Promise<boolean> {
    if (!isPermittedApiHost(apiBase)) {
        console.warn(
            `[riffado-connector] apiBase '${apiBase}' isn't covered by host_permissions; refusing to verify`,
        );
        return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
        const res = await fetch(
            `${apiBase}/team-app/workspaces/list?need_personal_workspace=true`,
            {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "Content-Type": "application/json",
                },
                signal: controller.signal,
            },
        );
        if (!res.ok) return false;
        const body = (await res.json().catch(() => null)) as {
            status?: number;
            data?: { workspaces?: unknown[] };
        } | null;
        return body?.status === 0 && Array.isArray(body.data?.workspaces);
    } catch {
        // Network error, timeout, Plaud unreachable, or a malformed body --
        // treat as "not verified yet" rather than surfacing an error. The
        // caller keeps polling and will retry against a later (hopefully
        // settled) capture instead of failing the whole connect attempt on
        // a blip.
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Returns whether the token was verified and delivered. `false` means the
 * caller should keep the plaud.ai tab open and keep polling -- the token
 * captured so far doesn't authenticate yet.
 */
async function deliverTokenToBridge(
    payload: ConnectorTokenPayload,
): Promise<boolean> {
    if (!pending) return false;
    if (isStale(pending)) {
        clearPending();
        return false;
    }

    // Snapshot the session *before* the async verification gap. `pending`
    // is a module-level variable a concurrent `startBridge`/`bridge:cancel`
    // can replace or null out while we're awaiting the network round-trip
    // below -- without this snapshot we'd deliver a stale capture to
    // whatever bridge tab happens to be pending afterward, and close its
    // (unrelated) plaud.ai tab out from under it.
    const session = pending;

    const verified = await verifyPlaudToken(payload.accessToken, payload.apiBase);
    if (!verified) return false;

    // The session was replaced or cancelled while we were verifying. This
    // capture no longer belongs to the active attempt; drop it silently
    // rather than acting on state that isn't ours.
    if (pending !== session) return false;

    const { bridgeTabId, plaudTabId } = session;

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
    return true;
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
                (verified) => sendResponse({ ok: true, verified }),
                (err: unknown) =>
                    sendResponse({
                        ok: false,
                        verified: false,
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
