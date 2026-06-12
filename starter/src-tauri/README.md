# Desktop (Tauri + Steamworks)

Tauri wrapper around the Next.js client, intended for games: binaries are an
order of magnitude smaller than Electron, and the Rust side gives you native
Steamworks integration.

`tauri.conf.json` must stay strict JSON (the Tauri CLI schema rejects unknown
keys and Hatchkit's signing rewriter parses it with `JSON.parse`), so the
caveats that would otherwise live as comments in the config are documented
here.

## Requirements

- Rust toolchain (https://rustup.rs) — `tauri dev` / `tauri build` compile a
  Rust binary.
- Platform build deps per https://tauri.app/start/prerequisites/

## Commands (from the repo root)

```bash
pnpm dev:tauri      # Next dev server + Tauri window with HMR
pnpm build:tauri    # static export + native bundle (dmg/msi/AppImage)
pnpm icons:tauri    # regenerate src-tauri/icons/ from build/icon.png
```

## Next.js static-export caveat

The client is built with `output: "export"` (see
`packages/client/next.config.ts`). `build.devUrl` points at the client dev
server; `build.frontendDist` points at the exported static build in
`packages/client/out`. That means:

- `NEXT_PUBLIC_API_URL` is baked at build time — the desktop binary is locked
  to whichever API URL it was built against. Rebuild to retarget.
- No `rewrites()`, no `middleware.ts`, no server components with runtime data.
  Dynamic routes need `generateStaticParams`.

## Server auth (TRUSTED_ORIGINS)

Tauri serves the bundled frontend from `tauri://localhost` (macOS/Linux) and
`http://tauri.localhost` (Windows). Better-auth uses cookies, so both origins
must be present in the server's `TRUSTED_ORIGINS` env var — the scaffold
pre-populates them in `packages/server/.env.example`. Make sure the same
values land in your production env.

## Steamworks

Steam support is compiled in behind the `steam` cargo feature (off by
default — a plain `tauri build` has no Steam dependency):

```bash
pnpm tauri build -- --features steam
```

- Set `STEAM_APP_ID` in `src/main.rs` to your App ID from
  partner.steamgames.com (the placeholder 480 is Valve's "Spacewar" test app).
- A Steam build requires the Steamworks SDK redistributable shipped next to
  the binary: `steam_api64.dll` (Windows), `libsteam_api.dylib` (macOS),
  `libsteam_api.so` (Linux). Download the SDK from
  https://partner.steamgames.com/doc/sdk — the `steamworks` crate links
  against it at build time and the dynamic library must be present at
  runtime.
- For local testing outside Steam, place a `steam_appid.txt` containing the
  App ID next to the binary and have the Steam client running.

## One desktop wrapper per project

This target replaces the Electron (`desktop`) feature — pick one. Both wrap
the same static client export; running two desktop release pipelines against
one client buys nothing.
