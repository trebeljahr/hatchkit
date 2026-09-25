# crossplat — try a build on another desktop platform

`linux-smoke.mjs` starts an unpacked Electron Linux build in Docker under
Xvfb, drives it over CDP and saves a screenshot. It passes or fails, so an
agent or CI can run it.

The folder is **project-agnostic**: nothing in it imports from the repository
around it and nothing in it names an app. All project wiring lives in the root
`package.json` and in `scripts/desktop-linux-smoke.mjs`. Keep it that way — the
folder is copied between projects unchanged.

Requires Node 24 or later. Uses no npm dependencies on the host.

## linux-smoke.mjs

```bash
node scripts/crossplat/linux-smoke.mjs \
  --app-dir release/linux-arm64-unpacked --exec <binary> \
  [--expect-url-prefix app://-] [--env KEY=VALUE]... [--arg --flag]... \
  [--settle-ms 5000] [--timeout-ms 60000] [--out test-results/linux-smoke]
```

The test passes when all of these are true:

- the app opens its CDP port;
- a page with the expected URL prefix appears;
- the page throws no uncaught error;
- a screenshot succeeds;
- the process is still running after the settle time.

It writes `result.json`, `screenshot.png` and `app.log` to `--out`. Console
errors are reported but do not fail the run, because an app with no server
behind it logs refused requests.

Requirements and rules:

- **A Docker daemon of the build's architecture.** On an Apple Silicon Mac,
  run `brew install docker colima` and then `colima start`, and build the app
  for arm64. OrbStack and Docker Desktop work too. The runner refuses a binary
  built for the wrong architecture instead of emulating it.
- **The window must be shown.** On X11, a window that was never shown gives
  CDP no frames, and the screenshot waits forever. If the app has its own
  headless switch, leave it off here. Xvfb is a virtual display, so nothing
  reaches a real screen.
- The app runs as the calling user with `--no-sandbox`, a session D-Bus and
  `HOME=/tmp`. System D-Bus errors in `app.log` are expected.
- The image, `crossplat-linux-smoke:1`, is built from `linux-smoke/Dockerfile`
  on the first run and cached after that. Change the tag when the Dockerfile
  changes.

## Wiring it into a project

1. Keep this folder as it is.
2. Add a script that builds the unpacked Linux app for the Docker daemon's
   architecture and then calls this runner. In this repository that script is
   `scripts/desktop-linux-smoke.mjs`, behind `pnpm test:desktop:linux`.

Tauri is not covered: it uses WebKitGTK rather than Chromium, so there is no
CDP endpoint to attach to.
