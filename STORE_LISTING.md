# Chrome Web Store — Listing Copy

Paste-ready text for the Chrome Web Store dashboard. Update version and
screenshots per release.

---

## Pre-submission blockers

These must be resolved before clicking Submit on the CWS dashboard. They
do not block sideloading or GitHub release zips.

1. **Icons.** Add `src/icons/icon-16.png`, `icon-32.png`, `icon-48.png`,
   `icon-128.png`, then wire them up in `src/manifest.ts` via `icons: { … }`
   and `action.default_icon`. CWS rejects submissions without at least a
   128×128 icon.
2. **Promo tile.** Add `docs/store/promo-tile-440x280.png` (PNG, 440×280).
   Required for store listing.
3. **Privacy policy page.** Publish `PRIVACY.md` at
   <https://riffado.com/privacy/connector>. The URL is already linked
   from the welcome page, popup footer (via README), and from the listing
   below.

---

## Listing fields

### Name
Riffado Connector

### Summary (≤132 chars)
Bridges your Plaud login to Riffado. Sign in to Plaud with Google, Apple, or email and use the token in your Riffado instance.

### Category
Productivity

### Language
English

### Single purpose
Forward a Plaud access token from a logged-in `web.plaud.ai` session to a
user-chosen Riffado instance, so the user can use Riffado with the
same Plaud account they sign in to with Google or Apple.

### Detailed description

Riffado Connector is a tiny bridge between your Plaud account and your
Riffado instance — hosted at riffado.com, or self-hosted at a URL
you control.

**Why this exists.** Plaud's email-OTP login produces a different account
than Plaud's Google or Apple sign-in. A real "Sign in with Google" button
inside Riffado is structurally blocked by Google's authorized-origins
policy on Plaud's OAuth client. The connector solves that by letting you
sign in to web.plaud.ai normally — Google, Apple, or email — and then
forwarding the resulting access token to Riffado.

**How it works.**

1. On the Riffado connect screen, the extension adds a "Continue with
   Plaud" button.
2. Clicking it opens web.plaud.ai in a new tab.
3. You sign in there however you normally do. The extension never sees
   your password and never interacts with Google or Apple.
4. Once Plaud has issued you a token, the extension verifies it against
   Plaud and hands it to your Riffado tab. The Plaud tab closes
   automatically.
5. Your Riffado tab POSTs the token to its own backend over HTTPS.

**What it does not do.**

- No analytics. No telemetry. No crash reporting.
- No data is sent to the connector's developers or to any third party.
- The token never leaves your browser except in the final HTTPS request
  your Riffado tab makes to your Riffado server.

**Open source.** AGPL-3.0. Source at github.com/riffado/connector.

**Privacy policy.** <https://riffado.com/privacy/connector>

---

## Permission justifications

CWS requires a one- to two-sentence justification per non-trivial
permission. These are the answers to paste into the dashboard.

### `storage`
Remembers the user's list of paired self-hosted Riffado origins so they
don't have to re-add them. Stored locally via `chrome.storage.local`; not
synced and never transmitted.

### `tabs`
Used to open `web.plaud.ai` in a new tab so the user can sign in, and to
close that tab automatically once the token has been captured and
verified. Also used to open the welcome page on first install.

### `scripting`
Registers the bridge content script for self-hosted Riffado origins the
user pairs at runtime via the popup. The hosted origin's bridge is
declared statically in the manifest instead; granting a host permission
alone does not start a statically-declared content script on a new
origin, so paired instances need explicit registration.

### `cookies`
Reads Plaud's `pld_ut` session cookie, which carries the user's access
token, from a tab where the user is already signed in to Plaud. That
cookie is `HttpOnly`, so no page JavaScript -- including a content
script -- can read it via `document.cookie`; `chrome.cookies` is the only
API that can read an `HttpOnly` cookie's value, and it's the intended use
case for exactly this kind of session handoff. Scoped by the
`https://*.plaud.ai/*` host permission below, not `<all_urls>`.

### Host permission: `https://*.plaud.ai/*`
The extension reads the access token from Plaud's `pld_ut` cookie via
`chrome.cookies`, and verifies it against Plaud's own API before treating
a connect as complete. This is the only way to obtain the token without
asking the user for their password.

### Host permission: `https://riffado.com/*`
The extension injects a small bridge into the hosted Riffado app so it
can render the "Continue with Plaud" button and receive the token from
the service worker. No other communication with riffado.com.

### Optional host permission: `https://*/*`
Self-hosted Riffado users add their instance URL through the popup or
welcome page. Each addition triggers a per-origin `chrome.permissions.request`
prompt, so the user explicitly approves every origin. Removing an origin
from the popup also revokes the corresponding host permission. Broad
optional pattern is required because the extension cannot know in advance
where users self-host. The connector never auto-grants or silently uses
this permission.

### Remote code
The extension does not load or execute remote code. All scripts ship in
the extension package.

### Data usage disclosures (CWS form)

- "Personally identifiable information": **No**, the extension does not
  collect PII. The Plaud access token is held transiently in memory and
  forwarded to the user's own Riffado instance.
- "Health information": No.
- "Financial / payment information": No.
- "Authentication information": **Yes** — Plaud access token is handled
  transiently as described in the privacy policy. Not stored. Not
  transmitted to third parties.
- "Personal communications": No.
- "Location": No.
- "Web history": No.
- "User activity": No.
- "Website content": No.

Affirmations to check:

- ✅ I do not sell or transfer user data to third parties outside of the
  approved use cases.
- ✅ I do not use or transfer user data for purposes unrelated to the
  item's single purpose.
- ✅ I do not use or transfer user data to determine creditworthiness or
  for lending purposes.

---

## Screenshots

Place 1280×800 PNGs under `docs/store/`. Recommended set:

1. `screenshot-1.png` — Riffado connect screen with the "Continue with
   Plaud" button visible.
2. `screenshot-2.png` — The welcome / onboarding page (three steps).
3. `screenshot-3.png` — The popup with a self-hosted instance paired.

See `docs/store/README.md` for capture instructions.
