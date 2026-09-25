<!-- hatchkit:doc Blocks between a `hatchkit:if <cond>` marker and the matching -->
<!-- hatchkit:doc `hatchkit:endif` are pruned at scaffold time by -->
<!-- hatchkit:doc cli/src/scaffold/claude-md.ts. Markers also work inline, spanning part -->
<!-- hatchkit:doc of a line. Every hatchkit marker is stripped from generated projects, so -->
<!-- hatchkit:doc what ships is plain Markdown. Conditions: server, client, fullstack, -->
<!-- hatchkit:doc static, backend, newsletter, native, desktop, mobile, websocket, -->
<!-- hatchkit:doc stripe. -->

# node-realtime-starter

A stampable starter repo for multiplayer web games and SaaS apps. Express backend, Next.js frontend, MongoDB, tRPC, better-auth, Stripe, WebSocket support.

## Hatchkit Context

This starter is normally generated and maintained by `hatchkit`.
If `.hatchkit.json` exists at the project root, treat the repo as a
Hatchkit-managed project.

Useful Hatchkit commands from inside a generated project:

```bash
hatchkit overview --json                 # inspect manifest/project state
hatchkit update                          # add supported features additively
hatchkit add <project> [services]        # provision GlitchTip/OpenPanel/Plausible/Listmonk+SES/S3/email/search
hatchkit keys push <project>             # push dotenvx private key to Coolify/GitHub Actions
hatchkit sync                            # sync/deploy existing project state
hatchkit rename-domain                   # update domain-related deploy config
hatchkit regen-infra                     # regenerate infra/deploy files
hatchkit provision s3                    # create project buckets + env entries
hatchkit assets pull                     # mirror remote object storage assets locally
```

<!-- hatchkit:if newsletter -->
Newsletter / Listmonk + SES smoke commands (run from the project root
once `hatchkit add <project> listmonk-ses` has populated env):

```bash
pnpm newsletter:verify              # full smoke — API reach, list ids, subscriber, real tx send
pnpm newsletter:test-tx             # send one /api/tx email to LISTMONK_TEST_RECIPIENT
pnpm newsletter:welcome             # send emails/welcome.html to LISTMONK_TEST_RECIPIENT
pnpm newsletter:draft emails/digest-sample.html --subject "Issue 1"   # stage digest as a Listmonk draft
NODE_ENV=production pnpm newsletter:send emails/digest-sample.html --subject "..." --confirm   # real broadcast
```

Hatchkit auto-subscribes your default forwarding email onto
`<project>-test` and writes it to `.env.development` as
`LISTMONK_TEST_RECIPIENT`, so the smoke scripts work end-to-end on a
fresh provision with no extra setup.

<!-- hatchkit:endif -->
Before giving Hatchkit setup advice, run `hatchkit status --json` and
read `providers[]`, `nextStep`, and `suggestions[]`. For provider failures,
run `hatchkit doctor --json` and surface the failing `checks[].hint[]`
lines. Never print dotenvx private keys unless the user specifically asks.

If a Hatchkit command breaks in this project, report the failing command,
cwd, Hatchkit version, output, suspected source area, and safe undo path.
When asking another agent to fix it, include a repair prompt with those details
and tell it to preserve existing user setups, use `--dry-run` where possible,
and ask before provider/DNS/Coolify/Terraform/keychain mutations.

Do not run commands that may alter existing infrastructure unless the user
explicitly asks. Prefer giving the command to the user, or using preview modes
such as `hatchkit destroy <project> --recipe`, `hatchkit gh-pages --undo
--dry-run`, and other command-specific `--dry-run` options.

## Tech Stack

<!-- hatchkit:if server -->
- **Backend:** Express + TypeScript, tRPC for typed API, better-auth for authentication<!-- hatchkit:if stripe -->, Stripe for payments<!-- hatchkit:endif -->
<!-- hatchkit:endif -->
<!-- hatchkit:if fullstack -->
- **Frontend:** Next.js (App Router) + Tailwind CSS + shadcn/ui, tRPC React Query client
<!-- hatchkit:endif -->
<!-- hatchkit:if static -->
- **Frontend:** Next.js (App Router) + Tailwind CSS + shadcn/ui
<!-- hatchkit:endif -->
<!-- hatchkit:if server -->
- **Database:** MongoDB (Mongoose) + Redis (ioredis)
<!-- hatchkit:endif -->
<!-- hatchkit:if websocket -->
- **Real-time:** Native `ws` WebSocket on same Express process
<!-- hatchkit:endif -->
<!-- hatchkit:if fullstack -->
- **Monorepo:** pnpm workspaces — `packages/server`, `packages/client`, `packages/shared`
<!-- hatchkit:endif -->
<!-- hatchkit:if backend -->
- **Monorepo:** pnpm workspaces — `packages/server`, `packages/shared`
<!-- hatchkit:endif -->
<!-- hatchkit:if static -->
- **Monorepo:** pnpm workspaces — `packages/client`, `packages/shared`
<!-- hatchkit:endif -->

## How to Run

<!-- hatchkit:if server -->
```bash
pnpm install                          # install all dependencies
pnpm run dev:infra                    # start MongoDB, Redis, local S3 (Docker, one-time)
pnpm run seed:assets                  # populate local S3 from seed/assets/ (idempotent)
pnpm run dev                          # start server + client (random ports)
pnpm run dev:fixed                    # start on fixed ports (client=3000, server=5000)
```

Drop fixtures into `seed/assets/` to have them auto-populate the
local bucket — see `seed/README.md`. To copy a real-prod bucket into
local for realistic dev data, `hatchkit assets pull` (treat the copy
as production data — same handling rules apply).
<!-- hatchkit:endif -->
<!-- hatchkit:if static -->
```bash
pnpm install                          # install all dependencies
pnpm run dev                          # start the Next.js client
pnpm run build                        # production build
```
<!-- hatchkit:endif -->

## How to Test

<!-- hatchkit:if fullstack -->
```bash
pnpm run test:unit                    # server unit tests (node:test)
pnpm run test:client                  # client unit tests (Vitest)
pnpm run test:e2e                     # Playwright E2E tests
pnpm run build                        # build all packages
```
<!-- hatchkit:endif -->
<!-- hatchkit:if backend -->
```bash
pnpm run test:unit                    # server unit tests (node:test)
pnpm run build                        # build all packages
```
<!-- hatchkit:endif -->
<!-- hatchkit:if static -->
```bash
pnpm run test:client                  # client unit tests (Vitest)
pnpm run build                        # build all packages
```
<!-- hatchkit:endif -->

<!-- hatchkit:if client-core -->
## Shared Client Core

`packages/core` (`@starter/core`) is host-free: no React, no Next, no DOM
assumption, and nothing in it opens a store or a socket on its own. Every
surface beyond the web app — a browser extension's service worker, a launcher
extension, an Electron renderer, a phone WebView — binds its own storage and
uses the same kit, so a mutation queued on one surface is a row any of them can
describe.

```bash
pnpm --filter @starter/core run test        # node:test suites
pnpm --filter @starter/core run typecheck
pnpm run contract:emit                      # rewrite the tRPC contract snapshot
```

`docs/versioning.md` is the client/server compatibility contract. The rules
below fail quietly when broken — each one shipped green somewhere before it was
written down.

### Three stores, and they answer different questions

- The **session token** belongs in real secret storage (Keychain, the Android
  keystore, `chrome.storage.session`). It is a credential. Capacitor
  Preferences is plain `UserDefaults` and is readable from an unencrypted
  backup.
- The **offline queue** belongs in a platform store — Capacitor Preferences,
  `chrome.storage.local`, a file beside Electron's userData. What is in it is
  work the person did that no server has ever seen, and WKWebView classifies
  `localStorage` as *non-critical web data* and reclaims it after low disk or
  roughly a week of not opening the app. `webStorage()` swallows every throw,
  so that loss would be silent.
- Everything else — a remembered filter, the theme — stays in `localStorage`,
  where eviction costs nothing.

Moving a store is `migrateStore()`: once, behind its own marker key, never over
a value already at the target, and the source is left in place so a rollback
still finds it. Without that step, *changing the address is the data loss*.

### The queue owns the work; the overlay owns the screen

`offline-queue.ts` is the durable FIFO of what still has to be sent.
`offline-overlay.ts` is its visible consequence — without it, a record created
with no signal is a row in storage and nothing on screen. `local-cache.ts` is
the last good answer to every read, which is what lets a surface with no
rendered state work offline.

- **The stored queue is `{ v: 1, data: rows }`.** A bare array still reads as
  v1. An unreadable value is copied to `<storagePrefix>.offline-queue.corrupt.<ms>`
  before the reset. A `v` newer than `QUEUE_FORMAT_VERSION` LOCKS the queue:
  its rows are held `unknown-op`, `enqueue`/`remove` throw
  `OfflineQueueLockedError`, and `clear` and adoption do nothing. Never read it
  through `decodeVersioned` — whose answer to a newer version is a miss, i.e.
  an empty queue the next enqueue overwrites.
- **Every row is stamped** with the account (`owner`), the server origin
  (`server`), the tenant (`tenantId`) and the writing build's `apiLevel`. Each
  stamp is optional forever, because rows written before it existed are
  somebody's work. The next account cannot replay the previous one's rows
  (`isReplayableBy`), and a row queued in one tenant is not retargeted at
  another after a switch (`isReplayableIn`).
- **Held rows are kept, counted, explained and only discarded deliberately** —
  never on a timer, never age-based. `HoldReason` is a union that will grow;
  `HOLD_RELEASE` makes forgetting a new member a type error. `unknown-op` is
  never written onto a row, so a newer build that can decode it releases it;
  `server-too-old` is decided by the server's level, not the clock.
- **One classifier.** `classifyReplayOutcome` turns a failed replay into
  `retry-later` / `hold` / `drop` for every surface. A host supplies only its
  transport test and its membership re-check. A row refused for version skew
  comes back 412, which is deliberately not a permanent rejection — a 400, 403,
  404, 409, 410 or 422 drops a row, and version skew must never delete work.
- **Holds and drops follow the temp-id chain.** A row that depends on a
  `items.create` which has not landed is held with it; replaying it alone would
  address the wrong record or nothing at all.
- **The queue drains from the reads** where there is no long-lived process to
  own a loop (`drainThenRead`), and writes drain first and then queue if
  anything is still waiting (`writingThroughQueue`) — sending a new mutation
  ahead of older queued ones lands it out of order. Reads fall back to the
  cache on a TRANSPORT failure only: a 401 is a real answer and has to reach
  the sign-in handling.

### Network truth comes from the radio, not the browser

`navigator.onLine` reports `true` on a dead radio in a WKWebView and never
fires for airplane mode, so a host installs its platform probe with
`setNetworkProbe()` and everything reads one verdict through `isOnline()`.

**The mutations the offline queue owns run in `networkMode: "always"`** — and
only those (`OFFLINE_QUEUED_MUTATION` in
`packages/client/src/lib/query-client.ts`). React Query otherwise *pauses* a
mutation while it believes the device is offline: `mutationFn` never runs,
`onError` never fires, and `onError` is where the offline work is queued. The
queue is this app's pause mechanism and it needs the failure to happen. It is
deliberately NOT a `defaultOptions.mutations`, which would take pause-and-resume
away from every mutation that queues nothing — on the web as much as on a phone.

### The sync feed is one-way, and its room is the session

`packages/server/src/sync/` and `packages/core/src/sync-client.ts`.

- **A subscriber's room is its authenticated user id and nothing else.** No
  query parameter, no first frame, no path segment picks it. A room a client can
  name is a room a client can name somebody else's, and the feed carries every
  change to that account's data.
- **The server never reads a frame from the socket.** There is no `send` on
  `SyncClient`. A socket that accepts commands is a second, unaudited write path
  beside tRPC with its own parsing and authorisation bugs.
- An unknown event kind or scope means **refetch**, never ignore. Keep the
  `never` defaults — they fail the build — but let them fall through to the
  refetch at runtime.
- `SESSION_REVOKED_CLOSE_CODE` (4401) latches: reconnection stops and stays
  stopped, because the credential this client was built with will never be
  accepted again. Clearing it is the host's job.

### Client/server version handshake

Self-hosted servers lag, store clients lead, desktop builds and open tabs
trail. `docs/versioning.md` is the contract.

- **Bump `API_LEVEL` whenever a tRPC procedure, input field, enum value or sync
  event kind is added**, with a row in `API_LEVEL_CHANGES`. Never lower it.
- **No header is legacy, never level 0.** The floor refuses only a request that
  DECLARES a lower level, as 412 (`data.versionRefusal`). `health.*` is never
  refused, so a refused client can still learn which side is too old.
- **Never add the handshake headers to `/api/health`**: a custom header forces a
  preflight that an untrusted origin fails, which reads as "unreachable".
- **The client-label header is untouched** by the handshake (`CLIENT_ID_HEADER`) — it is a label, never a
  permission.
- **The tRPC contract is a committed snapshot.** `pnpm run contract:emit` writes
  `packages/server/contract/trpc-contract.json`;
  `packages/server/src/tests/trpc-contract.test.ts` fails when it is stale and
  says whether the change is breaking (raise `MIN_CLIENT_API_LEVEL` and
  `API_LEVEL`), additive (bump `API_LEVEL`) or neither.
- A sync kind is added in three places: the `SyncEvent` union,
  `SYNC_EVENT_KIND_SET`, and `contract/sync-events.ts` — `tsc` enforces the
  last two.

<!-- hatchkit:endif -->
<!-- hatchkit:if native -->
## Native Shells

All native targets wrap the Next.js client as a **static export** (`output: "export"`).
<!-- hatchkit:if server -->
The Express server is always remote — the client talks to it over HTTPS.
<!-- hatchkit:endif -->

<!-- hatchkit:if desktop -->
### Desktop (Electron)

```bash
NEXT_PUBLIC_API_URL=… pnpm build:desktop     # export (out-desktop) + electron/dist, no packaging
NEXT_PUBLIC_API_URL=… pnpm electron:preview  # the same, then an unpacked app in release/
NEXT_PUBLIC_API_URL=… pnpm electron:build    # the same, then electron-builder → dmg/zip/exe/AppImage
pnpm dev:desktop                             # Next dev server + a window (UI iteration only)
pnpm electron:ensure                         # download the Electron binary if it is missing
pnpm test:electron                           # node:test over electron/src
pnpm test:e2e:desktop                        # Playwright harness, its own API
pnpm test:desktop:linux                      # containerised smoke test under Xvfb
pnpm icons:desktop                           # regenerate icns/ico from build/icon.png
pnpm desktop:rollout v1.4.0 25               # offer a published release to 25 % of installs
```

Replace `build/icon.png` with a 512×512 logo before shipping.

What is built, and the rules that fail quietly if broken:

- **The packaged app serves the export from `app://-`** (`electron/src/protocol.ts`,
  a privileged standard scheme), resolving paths in `resolve-app-path.ts`.
  Never `file://`: that origin is the string `null`, so sign-in is refused and
  every route but `/` blanks. **Never change the scheme or the host** — the
  origin keys `localStorage`, IndexedDB and every server's `TRUSTED_ORIGINS`.
  The profile directory name (`electron/src/profile.ts`) is permanent for the
  same reason.
- **Its own export directory, `packages/client/out-desktop`,** written only by
  `scripts/build-desktop.mjs`, which requires `NEXT_PUBLIC_API_URL`, asserts the
  literal reached an emitted chunk, refuses `"./_next` in any HTML and refuses
  to run while a dev server owns `packages/client/.next`. There is no
  `assetPrefix` anywhere.
- **Main and preload are esbuild bundles in `electron/dist/`.** The package
  holds only those, the export and package.json (`electron-builder.config.mjs`
  `files`, with `!node_modules/**` — electron-builder otherwise packs the root
  `dependencies`). The build lists the asar and fails on anything else.
- **`window.electronAPI`'s type is `DesktopBridge` in
  `packages/shared/src/desktop-bridge.ts`**, imported by the preload and by
  `packages/client/src/types/electron.d.ts`, with the IPC channel names beside it.
- **Every IPC handler registers through `handle()` in `ipc.ts`,** which refuses
  a sender frame outside `app://-` (or the dev URL, unpackaged only). A packaged
  app ignores `ELECTRON_DEV_URL`.
- **Security baseline** (`security.ts`, decisions in `security-model.ts`):
  navigation and `window.open` never leave the app origin (http(s) goes to the
  OS browser), no `<webview>`, every permission denied but notifications; a CSP
  response header on HTML (`csp.ts`, so the web export is untouched);
  `devTools: false` and no Reload/DevTools menu items outside dev; fuses
  (RunAsNode, NODE_OPTIONS and `--inspect` off, asar integrity and
  only-load-from-asar on). The inspector fuse means Playwright's
  `_electron.launch` cannot drive a **packaged** build; drive it with
  `--remote-debugging-port` and `chromium.connectOverCDP`, or use the harness,
  which runs the same `electron/dist/main.js` unpackaged.
- **Tests and agents run headless** (`electron/src/headless.ts`). The window is
  never shown or focused, and on macOS the app takes the accessory activation
  policy with no Dock icon, so a launch never steals focus from whoever is using
  the machine. Headless also creates no tray, registers no OS shortcut, posts no
  notification, touches no login item, appends `use-mock-keychain` so no real
  credential item is created, records external opens instead of performing them,
  and uses its own profile. Each effect is recorded on
  `globalThis.__desktopTestHooks` for the specs. A hidden window keeps painting,
  but reading a frame back OUT of one is per platform: on macOS
  `page.screenshot()` works; on X11 an unmapped window has no surface to copy
  from and the capture hangs, so the paint assertion is skipped on Linux and the
  Linux smoke test runs the window shown instead.
- **One instance per profile** (`requestSingleInstanceLock`); a second launch
  focuses the first and exits. The profile is pinned by name in `profile.ts`,
  never derived from package.json, and the unpackaged run gets its own so
  `dev:desktop` never shares the installed app's lock. The user-data-dir
  environment variable moves it — the harness uses it.
- **The tray and global shortcuts are views of renderer state.** The renderer
  publishes a `DesktopTrayState` (including every already-translated string) and
  commands come back through the bridge. The accelerator grammar is shared in
  `packages/shared/src/desktop-shortcuts.ts`, with one default
  (`CommandOrControl+Alt+Shift+Space`).
- **Only direct downloads update themselves** (`updater-model.ts`, `updater.ts`):
  the signed mac build, the NSIS installer and the AppImage, and only with an
  `app-update.yml`. The stores, Snap, Flatpak, deb, rpm and tar.gz never load
  electron-updater. The feed comes from `updateFeedFor` in
  `scripts/lib/desktop-release.mjs` and is **explicitly null** where there is
  none — left undefined, electron-builder guesses a GitHub feed from `GH_TOKEN`,
  which every CI runner has. electron-updater is bundled into `main.js` by
  esbuild, never packed as a dependency.
- **Never restart for an update on the person's behalf.** A download installs on
  quit; `quitAndInstall` has exactly one call site, and `updater-model.test.ts`
  greps the source to keep it that way.
- **One workflow builds every channel, and signing fails closed**
  (`.github/workflows/desktop-release.yml`, `scripts/lib/desktop-release.mjs`).
  No secrets for a channel builds files named `-unsigned`; a partial set refuses
  before the build. A tag builds a DRAFT release a person publishes —
  electron-updater reads only published releases, so publishing is the release
  decision — and every file a feed names is checked against its sha512 and size.
- **A staged rollout is one line in each feed.** `stagingPercentage` is rewritten
  as text by `scripts/lib/desktop-rollout.mjs`, which refuses if anything else
  changed, so the feed's hash and size stay byte-identical. `100` removes the key.
- **The renderer is not wired to the shell yet.** Sign-in must read the bearer
  token from `electronAPI.secureStore` and send `credentials: "omit"`; the tray
  must be fed with `electronAPI.desktop.publishTrayState`; the server needs
  `app://-` in `TRUSTED_ORIGINS` and a bearer plugin. Until then
  `e2e/desktop/shell.spec.ts` passes and `sign-in.spec.ts` and `tray.spec.ts`
  fail — they are the specification of what to build, not a regression.
- **The harness proves auth from the server side.**
  `e2e/desktop/record-requests.mjs` is preloaded into the harness API and logs
  every request's origin, client header, auth scheme and whether a Cookie was
  present; the harness's own Node calls carry a distinct user-agent so they are
  excluded.
<!-- hatchkit:endif -->


<!-- hatchkit:if mobile -->
### Mobile (Capacitor)

```bash
pnpm cap:add:ios                      # one-time — runs `cap add` then applies the overlay
pnpm cap:add:android                  # one-time — requires a JDK + the Android SDK
pnpm cap:overlay                      # re-apply the hand edits to both trees (idempotent repair)
pnpm build:mobile [ios|android]       # THE build: verify, export, sync
pnpm dev:ios                          # live-reload on the Simulator
pnpm dev:android                      # live-reload on an emulator or device
pnpm mobile:headless:ios              # build → install → launch → screenshot, no GUI, no focus
pnpm mobile:headless:android          # the same on a `-no-window` emulator
pnpm mobile:assets                    # regenerate icons/splash from resources/
pnpm build:android:release            # AAB for the Play Store
pnpm build:ios:release                # opens Xcode for an App Store archive
```

**`pnpm build:mobile` is the only supported entry point.** Never a bare
`cap sync` / `cap run ios` / `cap run android`. `scripts/build-mobile.mjs`
requires `NEXT_PUBLIC_API_URL` and then asserts the literal really reached an
emitted chunk; preflights the toolchain; asserts the native identifiers and
versions still agree with `capacitor.config.ts` and the root `package.json`;
refuses to run while a dev server owns `packages/client/.next`; and deletes
`CAP_DEV_URL` from the sync's environment so a stale shell value cannot bake a
dev-server URL into a bundle. A bare `cap` command skips every one of those and
still produces an app that installs and launches. `cap:run:*` and
`build:ios:release` go through the script and then pass `--no-sync`.

An unset `NEXT_PUBLIC_API_URL` is the one worth naming: the bundle then
resolves every request against its own document origin, fails on device, and
builds green.

#### Both native trees are committed

`ios/` and `android/` are tracked. The ATS exception, the orientation set, the
Android debug-only cleartext config, `versionName`/`MARKETING_VERSION` and the
optional signing config are hand edits that live only in those trees, a fresh
checkout has to build the real app without a generator run, and
`.github/workflows/mobile-release.yml` assumes both trees exist while never
running `cap add`. `pnpm cap:add:*` applies all of those edits after `cap add`
(`scripts/lib/native-overlay.mjs`) so nobody has to remember them; re-running
it is the documented repair path and is idempotent.

What `cap add` writes and `cap sync` then never revisits:
`PRODUCT_BUNDLE_IDENTIFIER`, `CFBundleDisplayName`, `namespace`,
`applicationId` and `res/values/strings.xml` all come out correct — **once**. A
later change to `appId` or `appName` in `capacitor.config.ts` silently does not
reach the native trees. That is the drift `build:mobile` asserts against, for
both platforms, along with the versions versus the root `package.json`.

**Generated but TRACKED** — rewritten by every `cap sync`, so a diff after a
build is normal; commit it when the plugin set changed:
`ios/App/CapApp-SPM/Package.swift`, `android/capacitor.settings.gradle`,
`android/app/capacitor.build.gradle`, plus the `Assets.xcassets` catalog and
the Android `res/` icon and splash sets, regenerated by `pnpm mobile:assets`
from `resources/`.

**Generated and NOT tracked** — the holes in `.gitignore`:
`ios/App/App/public/`, `android/app/src/main/assets/public/` and
`android/capacitor-cordova-android-plugins/`. A checkout that has never run
`pnpm build:mobile` therefore **cannot open in Xcode or Gradle at all**. Build
first.

`Package.swift` hardcodes the package manager's content-addressed store paths,
so any lockfile refresh renames those directories and the committed file points
at paths that no longer exist. Run `pnpm build:mobile ios` after any install
and before opening `ios/App` in Xcode directly, or SPM resolution fails.

#### It builds what this machine can build

Both trees are committed, so every checkout has an `android/` whether or not it
has a JDK and an SDK. A platform **named** on the command line
(`pnpm build:mobile android`) is a demand: a missing toolchain is an error, and
naming one also narrows the run so the other tree is not swept in and re-synced.
An **auto-detected** platform is an offer: a missing toolchain is a skip with a
note. So a Mac with no Android SDK and a Linux runner with no Xcode both survive
a bare `pnpm build:mobile`.

#### Its own export directory

`packages/client/out-mobile`, and `capacitor.config.ts` points `webDir` there.
`out/` is the web build and Playwright (which bakes a throwaway loopback API
port into it), `out-desktop/` is Electron's. `cap run` syncs implicitly, so a
shared directory means a test run can silently be installed as the app.

Under `output: "export"` a custom `distDir` is the *out* dir and the build dir
is forced back to `.next`, which a dev server for this checkout also owns —
hence the refusal. Stop the dev server, or give dev its own instance.

#### The scheme is the origin

iOS serves the bundle from `capacitor://localhost`, Android from
`https://localhost` (`androidScheme` defaults to https, so an `http://localhost`
trust entry would never match). Both are in
`packages/client/src/mobile/origins.ts`, the one place that knows them, and in
the server's `TRUSTED_ORIGINS`.

**Never set a custom `iosScheme`/`androidScheme`.** The document origin keys the
platform preference store, the WebView's own storage and the trust list — so
changing it later orphans every stored preference and invalidates the trust list
at once, with no migration path for either.

**Live reload is not the app.** Under `dev:ios`/`dev:android` the WebView loads
the Next dev server, so the document origin is the *dev server's*
(`http://localhost:<port>`, or `http://10.0.2.2:<port>` for the Android
emulator's host alias) and the API must trust that instead. Neither the real
origin nor its place in the production trust list is exercised by a live-reload
run — verify any auth change against a real `pnpm build:mobile` bundle. Android
live reload additionally needs the dev origin in Next's `allowedDevOrigins`
(Next 16 blocks cross-origin `/_next` dev resources); `scripts/android-dev.sh`
exports `NEXT_DEV_ORIGINS`, which `next.config.ts` merges. Without it the
document is served, every chunk is blocked, and the app sits on a splash that
`launchAutoHide: false` never hides.

#### What survives an OS kill, and where

Three stores, on purpose:

- **Credentials** — the platform keychain (`lib/native-session.ts`). The
  preference store is plain `UserDefaults` and readable from an unencrypted
  backup, so a token cannot live there.
- **Anything the app cannot afford to lose** — the platform preference store
  (`mobile/preferences-storage.ts`, `@capacitor/preferences`). iOS WKWebView
  classifies `localStorage` as *non-critical web data* and reclaims it after low
  disk or roughly a week of not opening the app; every web-storage accessor
  swallows its throws, so that loss is **silent**.
- **Disposable conveniences** (a remembered filter, the theme) — web storage,
  where eviction costs nothing.

`handOverLegacyWebStorage(keys)` moves what an earlier build left in
`localStorage` into the preference store, **once**, behind a marker. Without
that hand-over, changing the address *is* the data loss. It never deletes the
web copy before the durable write resolved, and records the marker only after
the whole pass succeeded.

#### Network truth comes from the radio

`navigator.onLine` reports `true` on a dead radio in WKWebView and never fires
for airplane mode, so `mobile/network.ts` reads `@capacitor/network` on native
and feeds one verdict to `isOnline()`. `isNetworkError()` short-circuits on it,
so a wrong verdict decides whether a refused mutation is queued for replay or
rolled back.

**Resume order is load-bearing** (`mobile/use-native-lifecycle.ts`): reconnect,
tick, flush the queue — and refetch **only** when nothing was queued. Refetching
first asks a server that has never heard of the work the user did with no
signal, gets an empty answer, and blanks local state until the flush lands. The
socket is reconnected because a server that pings and drops on a missed pong is
dead server-side within seconds of every backgrounding, while a frozen socket
delivers no close event and the client still believes it is open.

#### The hardware back button

One module owns the whole behaviour: `mobile/back-button.ts`. Adding a
`backButton` listener *overrides* Capacitor's default, so that callback is all
there is. `event.canGoBack` is not the signal it looks like — a single-page app
accumulates history entries just by moving between tabs, so it is nearly always
true. The order is: close the top overlay, else go to the home route, else
return `false`, which means exit. Overlays register in
`mobile/overlay-stack.ts`; the dialog primitive (`components/ui/dialog.tsx`)
does it **once**, there, rather than at every call site, and only when
controlled — an uncontrolled dialog has no `onOpenChange`, so back would swallow
the press and do nothing.

**With the keyboard up the button takes two presses, one without.** Android
gives the first press to the IME, which dismisses the keyboard; the WebView is
never told, so this module is not called and the open dialog stays open. The
second press reaches it. That is the platform's ordering and the one users
expect — do not import `@capacitor/keyboard` to collapse it into one press,
which would take back away from the keyboard. `back-button.test.ts` pins that
the module never does.

#### Native chrome

`packages/client/src/styles/native.css`, imported by one line from
`globals.css`. Every selector is under `html.cap`, so it is inert on web **by
construction**. Rules that would also be right on web belong in `globals.css`
instead.

`html.cap` is set twice on purpose: by an inline script in `<head>`
(`ROOT_MARKER_SCRIPT` in `mobile/platform.ts`) before the first paint, and again
by `mobile/bridge.ts` after its dynamic imports resolve. The pre-paint one is
what matters on a WebView reload, which has no splash to hide the unpadded
frame.

**The marker is on `<html>`, not `<body>`, and that is a correctness decision.**
A pre-paint script that mutates `<body>` makes the served HTML and the hydrated
DOM disagree about body's attributes, and the only way to silence that is
`suppressHydrationWarning` on `<body>` — which then silences every *other*
body-level mismatch, for the web app, forever. It is also why the script can sit
in `<head>`: `document.documentElement` exists during head parsing,
`document.body` does not. For the same reason nothing that renders may branch on
`isCapacitor()`: under `output: "export"` every page is prerendered in Node,
where `window.Capacitor` cannot exist, so a tree that differs at hydration is a
mismatch React resolves by discarding the served DOM. Phone-only UI ships in the
web bundle and is hidden with CSS.

**`viewport-fit=cover` ships to every host, web included, and the installed web
app is the one that notices.** The `viewport` export is static — one export
serves the browser, the installed web app and both native shells — so there is
no build in which the meta tag can be left out. A normal mobile browser applies
no insets, but an installed web app gets the real ones with none of `native.css`
applying to it, and content runs under the notch. `styles/standalone.css` is the
answer: `@media (display-mode: standalone)` copies of the safe-area rules,
scoped `html:not(.cap)` so they can never double up with the native ones. It is
a separate file precisely because it is *not* inert by construction.

Two things that look like ordinary CSS and are not. Tailwind v4's `translate-*`
utilities compile to the `translate` **property**, so the way to undo a
`translate-y-[-50%]` is `--tw-translate-y: 0`, never a `transform` (which stacks
on top of it). And `native.css` is unlayered while Tailwind's utilities are in
`@layer utilities`, so its rules already beat them — no `!important` is needed,
and adding one would only hide the fact that the cascade is doing the work.

#### Never return a plugin handle from an `async` function

A Capacitor plugin handle is a Proxy that answers **every** property with a
callable, `then` included. Return one from an `async` function and the promise
machinery adopts it as a thenable and calls `Plugin.then(resolve, reject)` — a
bridge message for a native method nobody implements. It neither resolves nor
rejects, and with `launchAutoHide: false` the app freezes on the splash with no
console to read. Wrap the handle in a plain object; `lib/native-session.ts`
does, and `native-session.test.ts` has the regression.

#### Release

`.github/workflows/mobile-release.yml` runs on every `v*` tag, and its `plan`
job decides every job before anything is built. A tag with no signing
credentials builds nothing and **uploads no artifact** — an unsigned `.aab` on a
public tag run reads as a release download. A partial credential set fails. A
prerelease tag goes to Play's internal track only, whatever a dispatch input
asks for. Every `upload-artifact` step is guarded by the plan, and CI runs
`jarsigner -verify` / `codesign --verify` on the artifact, because CI is where
an unsigned build must not pass quietly. Secrets reach the plan as booleans
(`secrets.X != ''`), never as values, so nothing can leak into the plan JSON or
the job summary.

Build numbers come from the run number (`ANDROID_VERSION_CODE`,
`CURRENT_PROJECT_VERSION`); both stores permanently reject a number they have
already seen.

**Signing is environment-driven and optional.** `android/app/build.gradle`
builds a `signingConfigs.release` only when `android/app/release.keystore`
exists *and* `KEYSTORE_PASSWORD`, `KEY_ALIAS` and `KEY_PASSWORD` are all
exported; otherwise it logs and produces an unsigned bundle, so
`./gradlew bundleRelease` works on a checkout with no key. Generating the
keystore and setting the secrets is a one-time manual step — see
`docs/mobile-release.md`.

#### Verifying from a shell, without stealing focus

`pnpm mobile:headless:ios` / `pnpm mobile:headless:android`
(`scripts/mobile-headless.sh`) build, install, launch and screenshot with no
window brought forward: the emulator boots `-no-window`, and Simulator.app is
opened with `open -g` — a plain `open -a` activates it and takes keyboard focus
from whoever is at the Mac. `pnpm dev:ios`/`dev:android` are for a person
iterating on UI. Four traps in that loop, each of which produces a
*working-looking* app that is quietly wrong:

- **Do not pass `CODE_SIGNING_ALLOWED=NO`.** Without the ad-hoc signature Xcode
  applies by default for the simulator SDK, every Keychain call fails with
  `errSecMissingEntitlement` (OS error `-34018`). The token is then never
  stored, the app silently falls back to a cookie, and the bearer path looks
  fine while being entirely untested.
- **The Simulator's WKWebView does send cookies to `http://localhost:<port>`**,
  and its cookie store survives `simctl uninstall`. So cookie auth appears to
  work from `capacitor://localhost` and masks a broken bearer path.
  `xcrun simctl erase` (`--erase`) is the only reliable clean slate; the real
  tell is on the server, where a request from the app must arrive with **no**
  `Cookie` header at all.
- **`simctl` alone never shows the software keyboard.** The Simulator counts the
  Mac's keyboard as connected until Simulator.app itself has read
  `ConnectHardwareKeyboard=false`, so a headless loop screenshots a focused field
  with no keyboard under it and nothing about the layout is being tested.
- **On Android, bake a loopback API URL and `adb reverse` it.** A bundled
  build's origin is `https://localhost`, and a fetch from an https document to a
  plain-http one is blocked as mixed content unless the target is a loopback
  address. `10.0.2.2` works for live reload, where the document is itself http,
  but not for the bundle. Also: `adb shell input text` is split by the
  *device's* shell, so only the first word of `"two words"` arrives — use `%s`
  for spaces. And the first back press with a dialog open is eaten by the IME
  whenever a field is focused (`dumpsys input_method | grep mInputShown` says
  so), even with no on-screen keyboard visible because a hardware keyboard is
  attached.

Bridge, lifecycle, splash, status bar and orientation:
`packages/client/src/mobile/bridge.ts`. Handlers are registered with
`setMobileHandlers`, **never** through `initMobile` — `initMobile` latches on its
first call, and that call is the loader at the app root, before the app shell
exists; handlers passed afterwards are dropped in silence.
<!-- hatchkit:endif -->

<!-- hatchkit:if server -->
### Native client auth

Better-auth uses cookies; native shells need extra CORS/trust origins.
Set `TRUSTED_ORIGINS` on the server (comma-separated):

```
TRUSTED_ORIGINS=capacitor://localhost,https://localhost
```

<!-- hatchkit:if desktop -->
Electron serves the export from `app://-`, the privileged scheme
registered in `electron/src/protocol.ts`, so `app://-` must be in
`TRUSTED_ORIGINS`. `file://` sends `Origin: null`, which no trust list can
match — a file:// shell cannot be fixed from the server side.
<!-- hatchkit:endif -->

<!-- hatchkit:endif -->

### Static export caveats

<!-- hatchkit:if server -->
- `NEXT_PUBLIC_API_URL` is baked at build time — desktop/mobile binaries
  are locked to whichever API URL they were built against. Rebuild to
  retarget.
<!-- hatchkit:endif -->
- No `rewrites()`, no `middleware.ts`, no server components with runtime
  data. Dynamic routes need `generateStaticParams`.
- Next `<Image>` uses the default loader only because `images.unoptimized`
  is set in `next.config.ts`.
<!-- hatchkit:endif -->

<!-- hatchkit:if workspaces -->
## Workspaces, members and invitations

Membership changes go through the app's own API only — `workspaces`,
`members` and `invitations`, one line each over `services/membership/`.
better-auth's organization plugin stays installed for its tables
(`organization`, `member`, `invitation`, the session's
`activeOrganizationId`) and for the server-side `auth.api.createOrganization`
the signup hook calls, but **every `/api/auth/organization/*` request that
arrives over HTTP answers 404** (`auth/organization-lockdown.ts`, wired as
the instance's one `hooks.before`). Those endpoints write `member` and never
`WorkspaceMember`, and they accept roles this app's rules refuse — each one
was a way around the rules below. `tests/organization-http-lockdown.test.ts`
hits all of them against the real library.

Six rules, each of which fails quietly if broken:

- **The mirror grants access; it is written last and deleted first.** The app
  authorizes from `WorkspaceMember` alone. Add writes `member` then the
  mirror; remove deletes the mirror then `member`. A crash in between always
  leaves less access, and re-running the operation finishes it. Remove and
  leave keep the person's own records.
- **Never zero owners.** Transfer promotes the target in both records first,
  then demotes the previous owner — `member` before the mirror, so somebody
  who retries a half-finished transfer is still an owner. The last owner
  cannot leave, be demoted or removed while anybody else remains; the sole
  member cannot leave at all. `tests/membership-lifecycle.test.ts` fails
  every write in turn.
- **Roles are exactly `owner|admin|member`; flags follow the role.** An
  owner's two visibility flags are forced on; everybody else, invited admins
  included, starts closed; a role change never grants a flag. Owner is
  reachable only by transfer — never by invitation or a role update. A stored
  unrecognised role reads as `member`.
- **Foreign ids are NOT_FOUND before any permission is consulted.** Every
  member/invitation lookup carries the actor's `workspaceId` in the query;
  only a real row of the caller's own workspace can earn FORBIDDEN, whose
  message is a stable code from `MEMBERSHIP_REFUSALS`. The matrix is in
  `services/membership/permissions.ts` and
  `tests/members-permissions.test.ts`.
- **Accepting an invitation needs the invited email, not a verified one.**
  The proof is possession of the id — 96 CSPRNG bits, never an adapter
  ObjectId, which is guessable — delivered to that inbox, or handed over by
  the inviter from the link the UI shows when no mail transport is
  configured. Requiring verification would make invitations unusable on
  exactly the self-hosted instances with no mail to verify with. The
  case-insensitive email match is what stops a forwarded link being accepted
  under somebody else's account, and it is checked before the status, so a
  wrong account learns nothing about whether the link is live. The link is
  `${FRONTEND_URL}/invite/?id=<id>` — a query parameter, because a static
  export cannot serve `/invite/<id>`.
- **An explicit `workspaceId` never falls back; a stale session default
  does.** A request naming a workspace the caller is not in is NOT_FOUND — a
  replayed offline row must never land in another workspace. A session whose
  `activeOrganizationId` points at a workspace the person left falls back to
  their oldest membership. `workspaces.setActive` writes the session row,
  which the five-minute cookie cache can hide for that long; first-party
  clients therefore send `workspaceId` explicitly, and every
  `workspaceProcedure` takes an object input that allows it
  (`tests/workspace-resolution.test.ts` walks the router).

Invitations are rows in better-auth's `invitation` collection with the
plugin's field names, so account deletion's invitation cleanup covers them.
A re-invite of a pending address refreshes and re-sends the same row; a
workspace holds at most 50 pending, and an inviter sends at most 20 per hour
(Redis when present, per process otherwise). With no transport, or a failed
send, the invitation is kept, the URL is logged, and `emailSent: false` tells
the inviter to share the link.

### Members screen, invite page and visibility

- **`/invite` lives outside the protected tree and reads a query
  parameter.** Under a protected layout a signed-out invitee is bounced to
  /login before the page can say whose workspace invited them, and an
  `/invite/[id]` segment 404s under `output: "export"`.
- **`?next=` goes through `lib/safe-next.ts` and nothing else.** It accepts
  only a single-`/` path with no backslash, whitespace or control character,
  still on this origin after URL parsing, under an allowlisted prefix. The
  login page is the one everybody trusts, which makes an unvalidated `next` a
  phishing redirect.
- **Switching workspaces is a full page load** (`enterWorkspace`). A
  client-side route change keeps every cached query and socket built for the
  previous workspace's permissions. Anything cached is keyed by workspace.
  The screens' own workspace is the switcher's active id, not the session
  default — otherwise Members manages one workspace while requests address
  another.
- **Cross-member visibility is decided server side**, projected where that is
  honest and refused where it is not. A withheld sensitive slot is `null`,
  never `0`. An aggregate withholds every sensitive figure rather than a
  partial sum and says so.<!-- hatchkit:if websocket --> The sync fan-out is
  per recipient: `ws/membership-sync.ts` reads memberships fresh on every
  publish and projects the event for each member. A new event kind that
  carries a record must be added to its switch.<!-- hatchkit:endif -->

The screens call the app's own typed API only — never
`authClient.organization.*`, whose HTTP endpoints answer 404.
<!-- hatchkit:endif -->

<!-- hatchkit:if server -->
## Environment & Secrets (dotenvx)

The server uses **[dotenvx](https://dotenvx.com)** for env handling — a
drop-in replacement for `dotenv` that transparently decrypts values
marked `encrypted:...`. `packages/server/src/config/env.ts` loads
either `.env.production` (when `NODE_ENV=production`) or
`.env.development` (otherwise).

```
packages/server/
  .env.example        plaintext, committed (reference, no real secrets)
  .env.development    plaintext, committed (local-dev defaults, localhost)
  .env.production     mixed: plaintext config + encrypted secrets,
                      committed to git. Public key lives at the top.
  .env.keys           DOTENV_PRIVATE_KEY_PRODUCTION lives here locally;
                      gitignored. In production, set it as an env var
                      instead.
```

### Setting an encrypted value

```bash
pnpm --filter @starter/server exec dotenvx set STRIPE_SECRET_KEY sk_live_... -f .env.production
```

Writes the encrypted ciphertext into `.env.production` and appends
the private key to `.env.keys` if it wasn't there already.

### Running locally against production values

`.env.keys` is read automatically — no extra step:
```bash
NODE_ENV=production pnpm --filter @starter/server start
```

### Deploying to Coolify

Two roles, easy to conflate:

- **`.env.production` (encrypted, committed) is the at-rest store.**
  `hatchkit secrets rotate` writes into it and `hatchkit sync` reads it.
  Committing it is what keeps the values off a single laptop.
- **Coolify's environment is the runtime source of truth.** `hatchkit
  sync` decrypts the at-rest store locally and pushes the resolved
  values into Coolify's env fields, which is where the running
  container reads them from. `docker-compose.yml` declares each one as
  `${VAR}`, which is what makes Coolify render a field per value.

The encrypted file is **not** shipped into the image — the server
Dockerfile deliberately does not copy it. It could never cover the
client half anyway (`NEXT_PUBLIC_*` are inlined into the browser bundle
at image *build* time and arrive as Docker build args), and pairing
ciphertext with its own decryption key in one image buys little.

`config/env.ts` still calls dotenvx behind an `existsSync` guard, so in
a deployed container the call is a no-op and `process.env` already holds
everything. That guard is why the same file works locally, in CI, and in
production.

Note for machines with a global git ignore: the usual
`~/.config/git/ignore` lists `.env.production`, and a repo `.gitignore`
only overrides a global pattern when it has one of its own — omitting
the file is not enough. This repo's `.gitignore` carries an explicit
`!.env.production` negation for exactly that reason. `hatchkit doctor`
fails if the encrypted file ends up uncommitted anyway.

### Key rotation

```bash
pnpm --filter @starter/server exec dotenvx rotate -f .env.production
# Then `hatchkit sync` to push the re-encrypted values to Coolify.
```

Keep `.env.keys` out of commits. `.gitignore` enforces this.
<!-- hatchkit:endif -->

## Code Style

- TypeScript strict mode everywhere. No `any` — use `unknown` and narrow.
- Prefer `const` over `let`. Never use `var`.
- Named exports only (no default exports except Next.js pages which require them).
- Explicit return types on all public/exported functions.
<!-- hatchkit:if fullstack -->
- Use `@starter/shared` for types shared between client and server.
<!-- hatchkit:endif -->
<!-- hatchkit:if client -->
- Use `@/` path alias for client-side imports within the client package.
<!-- hatchkit:endif -->

## File Organization

<!-- hatchkit:if server -->
```
packages/server/src/
  config/       — environment variables, app config
  db/           — database connections (mongoose, redis)
  models/       — Mongoose schemas and models
  auth/         — better-auth instance and config
  trpc/         — tRPC router, context, procedures
    routers/    — individual tRPC routers (one per domain)
  ws/           — WebSocket handler, room manager, auth
  services/     — external service integrations (Stripe, email, S3)
  middleware/   — Express middleware (error handler, etc.)
  tests/        — server unit tests
```
<!-- hatchkit:endif -->

<!-- hatchkit:if client-core -->
```
packages/core/src/
  storage.ts          — the key/value seam each host binds to its own store
  versioned-storage.ts— the { v, data } envelope for anything persisted
  api-client.ts       — typed caller + the permanent-rejection set
  network.ts          — platform-radio truth, origin comparison, health probe
  server-level.ts     — what each server said about its API level
  sync-client.ts      — the one-way feed subscription
  offline-ops.ts      — the shared op contract and the hold vocabulary
  offline-queue.ts    — the durable, versioned, stamped FIFO
  offline-replay.ts   — the single replay classifier
  offline-overlay.ts  — the optimistic overlay (separate from the queue)
  local-cache.ts      — the read cache + drain-on-read
```
<!-- hatchkit:endif -->

<!-- hatchkit:if fullstack -->
```
packages/client/src/
  app/          — Next.js App Router pages
  lib/          — tRPC client, auth client, utilities
  providers/    — React context providers
  hooks/        — custom React hooks
  components/   — React components
    ui/         — shadcn/ui components
  styles/       — global CSS
```
<!-- hatchkit:endif -->
<!-- hatchkit:if static -->
```
packages/client/src/
  app/          — Next.js App Router pages
  lib/          — utilities
  components/   — React components
    ui/         — shadcn/ui components
  styles/       — global CSS
```
<!-- hatchkit:endif -->

```
packages/shared/src/
  protocol.ts   — WebSocket message types (discriminated unions)
  types.ts      — shared domain types
  schemas.ts    — Zod validation schemas
```

<!-- hatchkit:if server -->
## Critical Middleware Ordering (Express)

The order in `app.ts` is load-bearing. Do not rearrange:

1. `cors()` — CORS with credentials, before every route so preflight succeeds
1. `better-auth` handler at `/api/auth/*` — BEFORE express.json (it handles its own body parsing)
<!-- hatchkit:if stripe -->
1. Stripe webhook at `/api/stripe/webhook` with `express.raw()` — needs raw body for signature verification
<!-- hatchkit:endif -->
1. `express.json()` + `express.urlencoded()` — JSON parsing for everything else
1. `helmet()` + `morgan()` — security headers and HTTP logging
1. tRPC middleware at `/api/trpc`
1. Health endpoint at `/api/health`
1. Error handlers (404 + 500) — must be last

## Environment Variables

- Always add new env vars to `.env.example` with a comment explaining the value
- Add sensible dev defaults to `.env.development` (this file is committed)
- Never commit `.env` or `.env.local` (these are gitignored)
<!-- hatchkit:if server -->
- Server env vars: plain `process.env.X` via `config/env.ts`
<!-- hatchkit:endif -->
<!-- hatchkit:if client -->
- Client env vars: must be prefixed with `NEXT_PUBLIC_` to be available in the browser
<!-- hatchkit:endif -->

## Testing Conventions

<!-- hatchkit:if server -->
- **Server unit tests:** `node:test` module + `assert/strict`. Files in `packages/server/src/tests/*.test.ts`.
<!-- hatchkit:endif -->
<!-- hatchkit:if client -->
- **Client unit tests:** Vitest + @testing-library/react. Files colocated as `*.test.tsx`.
<!-- hatchkit:endif -->
<!-- hatchkit:if fullstack -->
- **E2E tests:** Playwright. Files in `e2e/*.spec.ts`. Helpers in `e2e/helpers.ts`.
- Use `data-testid` attributes for E2E selectors, not CSS classes or text content.
<!-- hatchkit:endif -->

## Commit Messages

Use conventional style: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
Keep the first line under 72 characters. Add a blank line before any body text.

## Branch Naming

`feat/description`, `fix/description`, `refactor/description`.
