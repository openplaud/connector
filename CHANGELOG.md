# Changelog

All notable changes to Riffado Connector will be documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [SemVer](https://semver.org/).

## [Unreleased]

## [0.2.2] — 2026-07-22

### Fixed
- **Login could silently fail after v0.2.1's verify-before-close change,
  because a stray value could be captured as if it were the access token.**
  `content-plaud.ts`'s JWT-candidate check only required "three
  dot-separated base64url-charset segments" — a coincidental non-token
  value under some other `pld_*` localStorage key (e.g. an app-version
  string like `1.3.6`) satisfied that shape check trivially and could be
  picked up before the real token was written, sent to Plaud as
  `Authorization: Bearer 1.3.6`, and correctly rejected with `400 bad
  request` — which (correctly, per v0.2.1's fix) kept the tab open and
  polling, but never recovered if a real token capture kept losing to the
  bogus one. `looksLikeJwt()` now requires realistic segment lengths and a
  decodable JWT header (`{"alg":...}`) before treating a value as a token
  candidate. Confirmed via curl that a real token round-trips fine against
  `/team-app/workspaces/list` regardless of request Origin, so v0.2.1's
  verify-before-close approach itself is correct — this was purely a
  token-capture false positive.

## [0.2.1] — 2026-07-22

### Fixed
- **Self-hosted instances now show as connected.** The bridge content
  script that exposes `window.__riffadoConnector` was declared statically
  for `riffado.com` only; pairing a self-hosted origin via the popup
  granted host permission but never started the script there (MV3 doesn't
  run a statically-declared content script on a newly permitted origin).
  The app showed "Install Riffado Connector" indefinitely even though
  pairing appeared to succeed. The background worker now registers the
  bridge dynamically for every paired origin via `chrome.scripting`,
  reconciled on startup/install and whenever the paired-origins list
  changes. (#2)
- **The plaud.ai tab no longer closes mid-login.** `content-plaud.ts` treated
  the mere presence of any JWT-shaped value under a `pld_*` localStorage key
  as "login complete" and forwarded it immediately; `background.ts` then
  closed the plaud.ai tab the instant it received that message. A
  leftover/expired token already sitting in storage (or a transient value
  Plaud writes mid-handshake during an SSO redirect) looked identical to a
  real one, so the tab could close before the user ever finished signing in
  — and the dead token then failed to connect on the Riffado side. The
  background worker now verifies a captured token against Plaud
  (`/team-app/workspaces/list`, the same check the Riffado server runs)
  before delivering it to the bridge and closing the tab; an unverified
  capture is ignored and the content script keeps polling. (riffado/riffado#231)
- **Self-hosted instances over plain HTTP can now be paired.** Adding an
  `http://` origin (e.g. a LAN/localhost Riffado at `http://192.168.1.107:3000`)
  silently failed because `optional_host_permissions` only declared
  `https://*/*`, so `chrome.permissions.request` threw and the popup's "Add"
  button appeared to do nothing. Re-added `http://*/*` and wrapped the
  permission request so a failed grant surfaces an error instead of dying
  silently. (#1)

## [0.2.0] — 2026-05-30

### Changed
- **Rebranded from OpenPlaud to Riffado.** Extension name is now "Riffado
  Connector"; the hosted instance moved from `openplaud.com` to
  `riffado.com` (manifest `host_permissions` and the bridge content-script
  match updated accordingly). Package renamed to `riffado-connector` and
  release artifacts/repo URLs now point at `github.com/riffado/connector`.
- **Page-world contract renamed to match the Riffado web app.** The injected
  global is now `window.__riffadoConnector` (was `window.__openplaudConnector`)
  and the internal postMessage marker is `__riffado` (was `__openplaud`).
  The connect payload shape and bridge `version` (1) are unchanged. Requires
  the Riffado web app build that detects `window.__riffadoConnector`.

### Unchanged
- All references to the external **Plaud** service (`web.plaud.ai`,
  `api*.plaud.ai`, region detection, token capture) are deliberately left
  as-is — only the OpenPlaud→Riffado destination brand changed.
- The `chrome.storage.local` key (`openplaudOrigins`) is kept so existing
  users' paired self-hosted origins survive the upgrade.

## [0.1.3] — 2026-05-09

### Fixed
- **Plaud tab never auto-closed; OpenPlaud never received the token.**
  `content-plaud.ts` was reading `localStorage["access_token"]`, but the
  current Plaud web app stores the bearer at `pld_tokenstr` as a
  JSON-encoded string with a literal `bearer ` prefix. With the wrong
  key + wrong shape, the token was never detected and the 90s poll
  timed out silently.
  Fix: read `pld_tokenstr`, JSON-unwrap, strip `bearer ` (case-insensitive),
  validate JWT shape. Falls back to scanning all `pld_*` keys for a
  JWT-shaped value (longest match wins, after excluding workspace and
  Frill SSO tokens) so the next Plaud rename doesn't break us.
- **Wrong region for non-global users.** apiBase was hardcoded to
  `api.plaud.ai`; the previous fetch-sniffing fallback never worked
  because content scripts run in an isolated JS world (their
  `window.fetch` doesn't intercept page calls).
  Fix: read apiBase deterministically from
  `pld_<userId>:workspaceList[0].domain` (Plaud writes it explicitly).
  Falls back to decoding the JWT payload's `region` claim and mapping
  AWS regions to Plaud API hosts. Final fallback defaults to global.
- Removed the dead in-isolated-world `window.fetch` monkey-patch from
  `content-plaud.ts`.

### Added
- `console.debug` markers on web.plaud.ai for `script active`, fallback
  key usage, and JWT-region resolution — makes future field debugging
  one open-DevTools-and-look glance away.

## [0.1.2] — 2026-05-09

### Fixed
- **Extension was not detected by openplaud.com.** `dist/page-bridge.js`
  was emitted as an ES module (with an `import` of two shared constants),
  but `content-bridge.ts` injects it via a classic `<script>` tag. Chrome
  threw `Cannot use import statement outside a module` and aborted the
  script before `window.__openplaudConnector` could be defined, so the
  OpenPlaud page kept showing the "Install OpenPlaud Connector" CTA even
  with the extension active.
  Fix: inline `PAGE_MARKER` and `BRIDGE_VERSION` (and the type aliases)
  directly into `page-bridge.ts` so Rollup emits a self-contained
  classic-script file. Added a header comment pinning the duplicated
  constants to `src/lib/messages.ts` so they don't drift.

### Style
- Match the OpenPlaud color palette (warm cream + terracotta, OKLCH) in
  the popup and welcome page.

## [0.1.1] — 2026-05-08

First sideload-distributable release. Not yet on the Chrome Web Store —
icons and store assets still pending. Install via the GitHub release zip
(see README).

### Added
- First-run welcome page with three-step onboarding, opened automatically
  on install.
- "Open openplaud.com" primary action and "How it works" link in the
  popup.
- `STORE_LISTING.md` with paste-ready Chrome Web Store copy and
  per-permission justifications.
- `PRIVACY.md` as the source of truth for
  <https://openplaud.com/privacy/connector>.
- GitHub Actions release workflow: tag `v*` builds and attaches the
  extension zip to the GitHub release.
- `homepage_url` and `minimum_chrome_version: "114"` in the manifest.

### Changed
- Narrowed `optional_host_permissions` from `https://*/*` + `http://*/*`
  to `https://*/*` only. Self-hosted OpenPlaud over plain HTTP isn't a
  realistic deployment and dropping HTTP shrinks the CWS review surface.
- README rewritten for non-technical users: Chrome Web Store install
  first, sideload from GitHub release second, development last.
- `pnpm zip` script now creates `dist-zip/` if missing.

### Pending before Chrome Web Store submission
- Icons (16/32/48/128) — wire up via `manifest.icons` and
  `action.default_icon`.
- Promo tile (440×280).
- Publish `PRIVACY.md` at <https://openplaud.com/privacy/connector>.

## [0.1.0] — initial

- Bridge flow between `web.plaud.ai` and an OpenPlaud tab.
- Popup for managing self-hosted instances via runtime
  `chrome.permissions` requests.
