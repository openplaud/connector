import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json";

/**
 * MV3 manifest.
 *
 * Permission posture (kept minimal on purpose; the README's security section
 * explains each entry):
 *
 *   - `host_permissions`:
 *       - https://*.plaud.ai/*  — read the access token a logged-in user's
 *         browser has already obtained from Plaud's own site.
 *       - https://riffado.com/*  — talk to Riffado's hosted instance.
 *     Self-hosted users grant their own origin via `optional_host_permissions`
 *     through the popup ("Add my Riffado URL").
 *
 *   - `permissions`:
 *       - storage  — remember the user's self-hosted origins between sessions.
 *       - tabs     — open web.plaud.ai in a new tab and watch for it to load
 *                    (see `tabs.onUpdated` listener in background.ts).
 *
 *   - No `cookies`, no `webRequest`, no `<all_urls>`.
 */
export default defineManifest({
    manifest_version: 3,
    name: "Riffado Connector",
    short_name: "Riffado",
    description: pkg.description,
    version: pkg.version,
    homepage_url: pkg.homepage,
    minimum_chrome_version: "114",
    // BLOCKS CWS SUBMISSION: ship 16/32/48/128 PNGs in src/icons/ and wire
    // them up via `icons` and `action.default_icon` before submitting to
    // the Chrome Web Store. Sideload + GitHub release zips work without
    // them — Chrome falls back to the default puzzle-piece icon.
    action: {
        default_popup: "src/popup.html",
        default_title: "Riffado Connector",
    },
    background: {
        service_worker: "src/background.ts",
        type: "module",
    },
    // `scripting` lets the service worker register the bridge content script
    // for self-hosted origins the user pairs at runtime (see background.ts).
    // The statically-declared bridge below only covers the hosted origin;
    // granting a host permission alone never starts a declared content script
    // on a new origin, so paired instances need explicit registration.
    permissions: ["storage", "tabs", "scripting"],
    host_permissions: [
        "https://api.plaud.ai/*",
        "https://api-euc1.plaud.ai/*",
        "https://api-apse1.plaud.ai/*",
        "https://web.plaud.ai/*",
        "https://riffado.com/*",
    ],
    // Self-hosted Riffado is commonly run on a LAN or localhost over plain
    // HTTP (e.g. http://192.168.1.107:3000) to drive a local Ollama. We grant
    // those origins on demand via the popup, so both schemes are allowed here.
    optional_host_permissions: ["https://*/*", "http://*/*"],
    content_scripts: [
        {
            matches: ["https://web.plaud.ai/*"],
            js: ["src/content-plaud.ts"],
            run_at: "document_idle",
        },
        {
            matches: ["https://riffado.com/*"],
            js: ["src/content-bridge.ts"],
            run_at: "document_start",
            all_frames: false,
        },
    ],
    web_accessible_resources: [
        {
            resources: ["page-bridge.js"],
            matches: ["<all_urls>"],
        },
    ],
});
