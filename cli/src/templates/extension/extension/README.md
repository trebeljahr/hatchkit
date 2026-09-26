# __HATCHKIT_PRODUCT_NAME__ browser extension

An MV3 extension with three build targets, no host permissions, and a
bridge that keeps it signed in with the web app.

```bash
pnpm run build:extension          # dist/         -> __HATCHKIT_API_URL_DEV__
pnpm run build:extension:prod     # dist-prod/    -> __HATCHKIT_API_URL_PROD__
pnpm run build:extension:firefox  # dist-firefox/ -> __HATCHKIT_API_URL_PROD__
```

Load `dist/` at `chrome://extensions` (Developer mode -> Load unpacked),
or `dist-firefox/` at `about:debugging` (Load Temporary Add-on ->
`manifest.json`).

`public/` is copied into the build as-is: put the toolbar icons there
(`icons/16.png`, `32`, `48`, `128`) and add an `icons` block to
`buildManifest()` in `manifest.config.ts` when you have them. Both
stores accept a manifest with no icons and show a default one, so a
missing icon fails at submission rather than at install.

## The rules that fail quietly

Each of these produces no error when it is broken. They are pinned by
`src/manifest.test.ts`, `src/background/bridge.test.ts` and
`src/lib/sign-out-marker.test.ts`.

- **A build IS a target.** The default API origin is baked in at build
  time from `manifest.config.ts`, not from `.env.*` — those filenames
  are commonly gitignored, which would make a fresh clone build an
  extension with no URL in it and no error to say so. Each Chromium
  target carries its own name and its own `externally_connectable`, so
  the dev build and the store build can sit in the toolbar together.
- **No host permissions, no `cookies`.** Every request is therefore an
  ordinary cross-origin request, which the server answers only because
  it trusts this extension's origin. That trust is a RELEASE
  PREREQUISITE, not a sign-in detail: without it the extension cannot
  make a single request.
- **A refused origin looks exactly like being offline.** A CORS refusal
  reaches `fetch` as a bare `TypeError` — no status, no body. So a
  transport failure makes the worker re-ask `/api/health` (which answers
  `Access-Control-Allow-Origin: *` and gets through either way) at most
  once a minute, and the popup shows the untrusted-origin notice. Never
  "fix" this by treating a `TypeError` as a refusal: a real outage would
  then be reported as a trust problem and anything queued would be
  dropped on the strength of it.

### Firefox

Same code, `--mode firefox`, and every difference is the engine's:

- **`background.scripts`, not `service_worker`.** Gecko's MV3 background
  is an event page; a manifest carrying `service_worker` loads with no
  background at all — every listener unregistered, and a popup that does
  nothing.
- **No `externally_connectable`, so there is no bridge.** Firefox
  implements it for extensions only, never for web pages.
  `bridgeTarget: "none"` omits the key AND makes
  `registerBridgeListener()` register nothing, so "the page drives"
  stays true on an engine where no page can. Signing in on the web app
  therefore never signs the add-on in; the popup's password form and
  "Sign in with the web app" are the ways in.
- **Its origin is `moz-extension://<random uuid>`, new per install**, so
  no `TRUSTED_ORIGINS` entry can hold it. The server trusts the SHAPE
  instead (`TRUST_EXTENSION_ORIGINS`), narrowed by the request carrying
  no session cookie and by never answering such an origin with
  credentialed CORS.
- **`browser_specific_settings.gecko.id` is permanent** once the add-on
  is listed: AMO keys the listing, and the profile keys its stored data,
  on it.
- **A `moz-extension://` document is a secure context**, so Firefox
  blocks insecure `ws://` and `http://` from it — no loopback exception,
  unlike Chrome, and host permissions do not change it. Against an
  `http://` dev server this build reaches nothing; test it against https.
- **`chrome.runtime.id` is NOT the origin here.** It is the add-on id;
  the origin is the random UUID. Anything that shows somebody their
  origin reads `runtime.getURL("/")`.

## Releasing

`.github/workflows/extension-release.yml` runs on every `v*` tag: one
job uploads to the Chrome Web Store, one signs and submits to
addons.mozilla.org. Both fail closed when only half of their credentials
are set, and neither submits a prerelease.

Before the first release, fill in `store.config.json` (the public half
of the signing key and the id it produces) and add that
`chrome-extension://<id>` origin to the server's `TRUSTED_ORIGINS`.
