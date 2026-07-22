/**
 * Wire format for messages between content scripts, the background service
 * worker, and the page-world bridge. Each direction is annotated; keep this
 * file the single source of truth so refactors don't drift.
 *
 *   page-bridge (page world)
 *      \u2192 window.postMessage  \u2192  content-bridge (isolated world)
 *      \u2192 chrome.runtime      \u2192  background
 *      \u2192 chrome.tabs         \u2192  content-plaud (web.plaud.ai)
 *
 *   content-plaud (token captured)
 *      \u2192 chrome.runtime      \u2192  background
 *      \u2192 chrome.tabs         \u2192  content-bridge
 *      \u2192 window.postMessage  \u2192  page-bridge \u2192 caller's Promise resolves
 */

export type PlaudRegion = "global" | "euc1" | "apse1" | "unknown";

export interface ConnectorTokenPayload {
    accessToken: string;
    apiBase: string;
    region: PlaudRegion;
    capturedAt: number;
}

// \u2500\u2500 Page \u2194 content (window.postMessage) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// Every message carries `__riffado` so the listener can ignore unrelated
// postMessage traffic on the page.

export const PAGE_MARKER = "__riffado" as const;

export type PageRequest =
    | {
          [PAGE_MARKER]: true;
          kind: "ping";
          requestId: string;
      }
    | {
          [PAGE_MARKER]: true;
          kind: "connect";
          requestId: string;
      };

export type PageResponse =
    | {
          [PAGE_MARKER]: true;
          kind: "pong";
          requestId: string;
          version: number;
      }
    | {
          [PAGE_MARKER]: true;
          kind: "connect-result";
          requestId: string;
          ok: true;
          payload: ConnectorTokenPayload;
      }
    | {
          [PAGE_MARKER]: true;
          kind: "connect-result";
          requestId: string;
          ok: false;
          error: string;
      };

// \u2500\u2500 Content \u2194 background (chrome.runtime.sendMessage) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type RuntimeMessage =
    | { type: "bridge:request-connect"; bridgeTabId?: number }
    | { type: "plaud:token-captured"; payload: ConnectorTokenPayload }
    | { type: "bridge:cancel" };

export interface RuntimeResponse {
    ok: boolean;
    error?: string;
    /**
     * Only meaningful on the `plaud:token-captured` response. `true` means
     * the background worker confirmed the captured token actually
     * authenticates against Plaud before delivering it to the bridge tab
     * and closing the plaud.ai tab. `false`/`undefined` means the sender
     * should keep polling instead of assuming the connect finished
     * (see content-plaud.ts).
     */
    verified?: boolean;
}

export const BRIDGE_VERSION = 1;
