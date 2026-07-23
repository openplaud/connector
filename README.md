# Riffado Connector

Tiny browser extension that bridges your Plaud session to your
[Riffado](https://github.com/riffado/riffado) instance.

It exists because Plaud's email-OTP login signs you into a different
account than Plaud's Google or Apple sign-in (see
[riffado/riffado#65](https://github.com/riffado/riffado/issues/65)).
Real Sign in with Google / Apple from inside Riffado is structurally
blocked by Google's authorized-origins policy on Plaud's OAuth client.
The connector solves that by letting you sign in to `web.plaud.ai`
normally and then forwarding the resulting access token to Riffado.

The token is the same long-lived (~300 day) JWT Plaud's own web app uses.
Riffado encrypts it at rest with AES-256-GCM.

---

## Install

### Chrome / Edge / Brave / Arc — recommended

> **Install from the Chrome Web Store** _(coming soon — link will land here once listing is live)_

That's the whole install. After it's added you'll see a welcome tab with
three steps. Click **Open riffado.com**, then **Continue with Plaud**,
sign in to Plaud as you normally would (Google, Apple, or email), and
you're done.

### Sideload from a GitHub release

Use this if the Web Store listing isn't live yet, if you want a specific
version, or if you're on a Chromium browser without Web Store access.

1. Download `riffado-connector-<version>.zip` from the
   [latest release](https://github.com/riffado/connector/releases/latest).
2. Unzip it somewhere you won't accidentally delete.
3. Open `chrome://extensions` (or `edge://extensions`, etc.).
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and select the unzipped folder.

The extension stays installed across browser restarts. You'll see a
welcome tab the first time, same as the Web Store install.

> Sideloaded extensions do not auto-update. To get a newer version,
> download the latest release zip and repeat **Load unpacked** on the
> new folder (Chrome will replace the old one).

---

## How it works

1. On the Riffado connect screen, the page detects
   `window.__riffadoConnector` (injected by this extension) and shows a
   **Continue with Plaud** button.
2. Clicking it asks the extension to open `https://web.plaud.ai/` in a
   new tab.
3. You sign in there however you normally do — Google, Apple, or
   email/password. The extension does not see your password and does not
   interact with Google or Apple.
4. Once Plaud has issued you a session, the extension reads your access
   token from Plaud's own `pld_ut` cookie (via `chrome.cookies`, the only
   API that can read it — it's `HttpOnly`, so no page script ever could),
   confirms it actually authenticates against Plaud, closes the Plaud tab,
   and hands the token to the Riffado tab.
5. The Riffado page POSTs the token to its own
   `/api/plaud/auth/connect-token` endpoint with your existing Riffado
   session cookie. Done.

The connector itself **never sends data to anything other than your
Riffado instance**. There is no backend; everything happens in your
browser. Privacy policy:
<https://riffado.com/privacy/connector>.

---

## Permissions and what they're for

| Permission | Why |
| --- | --- |
| `storage` | Remember which self-hosted Riffado origins you've paired. |
| `tabs` | Open `web.plaud.ai` in a new tab and close it after capture; open the welcome tab on first install. |
| `scripting` | Register the bridge on self-hosted origins paired at runtime (the hosted origin's bridge is declared statically instead). |
| `cookies` | Read Plaud's `pld_ut` session cookie, which carries your access token. That cookie is `HttpOnly` — no page JavaScript, including a content script, can read it via `document.cookie`; `chrome.cookies` is the only API that can. Scoped by the `host_permissions` below, not `<all_urls>`. |
| `host_permissions: web.plaud.ai, api*.plaud.ai` | Open the login tab, read the token cookie, and verify it against Plaud before treating a connect as done. |
| `host_permissions: riffado.com` | Inject the bridge into the hosted Riffado app. |
| `optional_host_permissions: https://*/*, http://*/*` | Self-hosted instances can be paired at runtime via the popup (HTTP is allowed for LAN/localhost deployments). Each one prompts you separately. |

Not used: `webRequest`, `<all_urls>` content scripts, anything
Google/Apple-related.

---

## Self-hosted

If you self-host Riffado at, say, `https://my-plaud.example.com`:

1. Install the extension.
2. On the welcome page (or by clicking the toolbar icon) → enter your
   URL → **Add**.
3. Approve the per-origin permission prompt.
4. Open your Riffado connect screen and click **Continue with Plaud**.

You can remove a paired origin from the popup; the extension revokes the
corresponding host permission at the same time.

---

## Architecture (one screen)

```
┌──────────────────────────┐    chrome.runtime    ┌───────────────────────────┐
│  content-bridge.ts       │ ───────────────────▶ │  background.ts            │
│  (your Riffado origin) │                      │  (service worker)         │
│                          │                      │                           │
│  injects ↓               │                      │  - opens web.plaud.ai     │
│                          │                      │  - polls chrome.cookies   │
│  page-bridge.ts          │                      │    for the pld_ut cookie  │
│  (page main world)       │                      │  - verifies the token     │
│                          │                      │    against Plaud          │
│  exposes:                │                      │  - forwards it back +     │
│  window.__riffado        │                      │    closes the plaud tab   │
│      Connector.connect() │                      └─────────────┬─────────────┘
│                          │ ◀─── tab message ─── ┘
└──────────────────────────┘
            │                     chrome.cookies.get() reads Plaud's HttpOnly
            │ Promise<{ accessToken, apiBase }>   pld_ut cookie directly --
            │                     no content script runs on web.plaud.ai at all.
            ▼
┌──────────────────────────┐
│  Riffado page          │
│  POST /api/plaud/auth/   │
│       connect-token      │
│  (session cookie)        │
└──────────────────────────┘
```

The connector is a courier, not a server. It carries one short-lived
secret across two tabs the same browser already trusts.

An earlier version scanned `localStorage` on `web.plaud.ai` for a
token-shaped value via an injected content script. That approach could
never reliably find the real token: Plaud authenticates the web app with
an `HttpOnly` cookie, which by definition no page JavaScript can read.
`chrome.cookies` is the correct, intended API for this.

---

## Security model

Threats considered:

- **Random sites scraping the bridge.** The page-bridge is only injected
  into origins listed in `host_permissions` (or runtime-granted). Other
  origins never see `window.__riffadoConnector`.
- **A paired Riffado origin trying to read my Plaud password.** It
  can't. The connector never sees your password — it only reads the
  post-login access token from Plaud's own page. A malicious Riffado
  origin you've paired could call `connect()` and try to capture the
  token, but you've already granted that origin the right to receive
  tokens by pairing it. Don't pair origins you don't control.
- **A captured value that isn't actually a working token.** Before
  treating a connect as done, the service worker verifies the captured
  token against Plaud's own API (`/team-app/workspaces/list`) -- the same
  check Riffado's server runs when it stores the connection. A stale or
  malformed value never reaches your Riffado instance.
- **Plaud changing their token storage shape.** The connector currently
  reads the `pld_ut` cookie via `chrome.cookies`. If Plaud renames or
  restructures it, we ship a connector update.
- **Token in flight.** Stays inside one browser; never crosses our
  infrastructure. From `web.plaud.ai`'s cookie jar → service worker →
  your Riffado tab → your Riffado server, all over local IPC except the
  final POST which is HTTPS to a host you chose.

---

## Development

```bash
pnpm install
pnpm dev          # vite dev server with HMR for the popup
pnpm build        # type-check + production build into dist/
pnpm zip          # zip dist/ into dist-zip/riffado-connector-<v>.zip
pnpm release      # alias for `pnpm build && pnpm zip`
```

Load the unpacked extension:

1. `pnpm build` (or `pnpm dev` while iterating)
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** →
   select `dist/`.
3. Reload the extension after each rebuild.

### Cutting a release

Tag a commit `vX.Y.Z` and push the tag. The
[release workflow](.github/workflows/release.yml) will build and attach
the zip to the GitHub release. From there it can be uploaded to the
Chrome Web Store dashboard. Listing copy and permission justifications
live in [`STORE_LISTING.md`](./STORE_LISTING.md).

---

## License

AGPL-3.0. Same license as the parent
[Riffado](https://github.com/riffado/riffado) project.
