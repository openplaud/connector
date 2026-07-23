/**
 * Wire format for messages between content scripts, the background service
 * worker, and the page-world bridge. Each direction is annotated; keep this
 * file the single source of truth so refactors don't drift.
 *
 *   page-bridge (page world)
 *      → window.postMessage  →  content-bridge (isolated world)
 *      → chrome.runtime      →  background
 *
 *   background (polls chrome.cookies for Plaud's pld_ut cookie directly --
 *   no content script runs on web.plaud.ai; that cookie is HttpOnly and no
 *   page JavaScript can ever read it)
 *      → chrome.tabs         →  content-bridge
 *      → window.postMessage  →  page-bridge → caller's Promise resolves
 */

export type PlaudRegion = "global" | "euc1" | "apse1" | "unknown";

export interface ConnectorTokenPayload {
    accessToken: string;
    apiBase: string;
    region: PlaudRegion;
    capturedAt: number;
}

// ── Page ↔ content (window.postMessage) ─────────────────────────────────
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

// ── Content ↔ background (chrome.runtime.sendMessage) ───────────────────

export type RuntimeMessage =
    | { type: "bridge:request-connect"; bridgeTabId?: number }
    | { type: "plaud:token-captured"; payload: ConnectorTokenPayload }
    | { type: "bridge:cancel" };

export interface RuntimeResponse {
    ok: boolean;
    error?: string;
}

export const BRIDGE_VERSION = 1;
