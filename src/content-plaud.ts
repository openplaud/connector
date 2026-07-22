/**
 * Content script that runs on https://web.plaud.ai/*.
 *
 * Job: harvest the Plaud access token + the regional API base the user's
 * account is provisioned in, then forward both to the background service
 * worker so it can deliver them to the Riffado tab that initiated the
 * bridge.
 *
 * Capture strategy (deterministic, all from localStorage):
 *
 *   1. TOKEN
 *      - Primary: localStorage["pld_tokenstr"]. Plaud stores it as a
 *        JSON-encoded string of the shape `"bearer eyJ…"` (literal
 *        wrapping quotes, then a `bearer ` prefix, then a JWT).
 *      - Fallback: scan every localStorage key starting with `pld_` for a
 *        value that, after JSON-unwrap and `bearer ` strip, matches JWT
 *        shape. Picks the longest match (the access token is by far the
 *        largest JWT in storage). Logs a console.debug if the primary
 *        key was missing so future drift is visible.
 *
 *   2. apiBase (regional API host)
 *      - Primary: any `pld_<userId>:workspaceList` key. JSON.parse, take
 *        `[0].domain` (Plaud writes it explicitly, e.g.
 *        `https://api.plaud.ai`).
 *      - Secondary: decode the JWT payload, read the `region` claim, map
 *        AWS regions to Plaud API hosts:
 *           aws:us-west-2      -> https://api.plaud.ai          (global)
 *           aws:eu-central-1   -> https://api-euc1.plaud.ai     (EU)
 *           aws:ap-southeast-1 -> https://api-apse1.plaud.ai    (APAC)
 *      - Tertiary: default to https://api.plaud.ai. Only correct for
 *        global users; the workspaceList path catches everyone else.
 *
 * The previous in-isolated-world `window.fetch` monkey-patch has been
 * removed: content scripts run in an isolated JS world, so patching
 * `window.fetch` from here never intercepted Plaud's actual API calls.
 * That capture path was dead-on-arrival and contributed nothing.
 */

import {
    type ConnectorTokenPayload,
    type PlaudRegion,
    type RuntimeMessage,
    type RuntimeResponse,
} from "./lib/messages";

const POLL_INTERVAL_MS = 750;
const POLL_TIMEOUT_MS = 90_000;
// If the same candidate token fails verification, don't hammer
// chrome.runtime/Plaud on every 750ms tick -- wait this long before
// re-attempting the unchanged value.
const RETRY_UNCHANGED_MS = 3_000;

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

console.debug("[riffado-connector] active on web.plaud.ai");

function unwrapJsonString(raw: string): string {
    const s = raw.trim();
    if (s.startsWith('"') && s.endsWith('"')) {
        try {
            const parsed = JSON.parse(s);
            if (typeof parsed === "string") return parsed;
        } catch {
            // fall through; treat as plain string
        }
    }
    return s;
}

function stripBearer(s: string): string {
    return s.trim().replace(/^bearer\s+/i, "");
}

function extractJwtCandidate(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const candidate = stripBearer(unwrapJsonString(raw));
    return JWT_RE.test(candidate) ? candidate : null;
}

function readPlaudToken(): string | null {
    try {
        // Primary path — the documented key for this Plaud version.
        const primary = extractJwtCandidate(
            window.localStorage.getItem("pld_tokenstr"),
        );
        if (primary) return primary;

        // Fallback: scan all pld_* keys for a JWT-shaped value. Skip keys
        // we know hold non-access JWTs (workspace tokens, refresh tokens,
        // Frill SSO). Pick the longest remaining match — the user-level
        // access token is by far the largest JWT in this storage.
        let bestLen = 0;
        let best: string | null = null;
        let bestKey: string | null = null;
        for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i);
            if (!key || !key.startsWith("pld_")) continue;
            if (key.endsWith(":workspaceList")) continue;
            if (key.endsWith(":frillSsoToken")) continue;
            const value = window.localStorage.getItem(key);
            const candidate = extractJwtCandidate(value);
            if (candidate && candidate.length > bestLen) {
                bestLen = candidate.length;
                best = candidate;
                bestKey = key;
            }
        }
        if (best && bestKey) {
            console.debug(
                `[riffado-connector] token read from fallback key '${bestKey}'`,
            );
        }
        return best;
    } catch {
        return null;
    }
}

function decodeJwtRegion(token: string): string | null {
    try {
        const parts = token.split(".");
        if (parts.length !== 3) return null;
        // base64url -> base64
        const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const json = atob(padded);
        const claims = JSON.parse(json) as { region?: unknown };
        return typeof claims.region === "string" ? claims.region : null;
    } catch {
        return null;
    }
}

function apiBaseFromAwsRegion(awsRegion: string): string | null {
    switch (awsRegion) {
        case "aws:us-west-2":
            return "https://api.plaud.ai";
        case "aws:eu-central-1":
            return "https://api-euc1.plaud.ai";
        case "aws:ap-southeast-1":
            return "https://api-apse1.plaud.ai";
        default:
            return null;
    }
}

function hostToRegion(host: string): PlaudRegion {
    if (host === "api.plaud.ai") return "global";
    if (host === "api-euc1.plaud.ai") return "euc1";
    if (host === "api-apse1.plaud.ai") return "apse1";
    return "unknown";
}

function normalizeApiBase(domain: string): string | null {
    try {
        const u = new URL(domain);
        if (u.protocol !== "https:") return null;
        if (!u.hostname.endsWith(".plaud.ai") && u.hostname !== "plaud.ai") {
            return null;
        }
        return `${u.protocol}//${u.hostname}`;
    } catch {
        return null;
    }
}

function readApiBaseFromWorkspaceList(): string | null {
    try {
        for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i);
            if (!key || !key.endsWith(":workspaceList")) continue;
            const raw = window.localStorage.getItem(key);
            if (!raw) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                continue;
            }
            if (!Array.isArray(parsed) || parsed.length === 0) continue;
            const first = parsed[0] as { domain?: unknown };
            if (typeof first?.domain !== "string") continue;
            const normalized = normalizeApiBase(first.domain);
            if (normalized) return normalized;
        }
    } catch {
        // ignore
    }
    return null;
}

function resolveApiBase(token: string): {
    apiBase: string;
    region: PlaudRegion;
} {
    // Primary: workspaceList.domain — explicit, no decoding.
    const fromWorkspace = readApiBaseFromWorkspaceList();
    if (fromWorkspace) {
        return {
            apiBase: fromWorkspace,
            region: hostToRegion(new URL(fromWorkspace).hostname),
        };
    }

    // Secondary: JWT region claim.
    const awsRegion = decodeJwtRegion(token);
    if (awsRegion) {
        const fromJwt = apiBaseFromAwsRegion(awsRegion);
        if (fromJwt) {
            console.debug(
                `[riffado-connector] apiBase resolved from JWT region '${awsRegion}'`,
            );
            return {
                apiBase: fromJwt,
                region: hostToRegion(new URL(fromJwt).hostname),
            };
        }
        console.debug(
            `[riffado-connector] unknown JWT region '${awsRegion}', defaulting to global`,
        );
    }

    // Tertiary: default to global.
    return { apiBase: "https://api.plaud.ai", region: "global" };
}

/**
 * Send a captured token candidate to the background worker and report
 * whether it was verified + delivered.
 *
 * `readPlaudToken()` returns the first JWT-shaped value it finds in
 * storage with no proof a login actually completed -- a leftover token
 * from an earlier/expired session (or a transient value Plaud writes
 * mid-handshake during an SSO redirect) is indistinguishable from a real
 * one at this layer. The background worker verifies the token against
 * Plaud before treating the connect as finished, so a `false` return here
 * means "keep polling", not "something went wrong".
 */
async function tryForward(token: string): Promise<boolean> {
    const { apiBase, region } = resolveApiBase(token);
    const payload: ConnectorTokenPayload = {
        accessToken: token,
        apiBase,
        region,
        capturedAt: Date.now(),
    };
    try {
        const response = (await chrome.runtime.sendMessage({
            type: "plaud:token-captured",
            payload,
        } satisfies RuntimeMessage)) as RuntimeResponse | undefined;
        return response?.verified === true;
    } catch {
        // Background not reachable (extension being reloaded, etc.).
        return false;
    }
}

async function pollUntilForwarded(): Promise<void> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let lastAttempted: string | null = null;
    let lastAttemptAt = 0;
    while (Date.now() < deadline) {
        const token = readPlaudToken();
        if (token) {
            const changed = token !== lastAttempted;
            const dueForRetry = Date.now() - lastAttemptAt > RETRY_UNCHANGED_MS;
            if (changed || dueForRetry) {
                lastAttempted = token;
                lastAttemptAt = Date.now();
                if (await tryForward(token)) return;
            }
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    console.debug(
        "[riffado-connector] timed out waiting for a verified Plaud session",
    );
}

void pollUntilForwarded();
