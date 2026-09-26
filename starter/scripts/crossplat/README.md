# crossplat — try a build on the other desktop platforms

Two tools for testing a desktop app on Linux and Windows from a Mac.

| Tool | What it does | Who runs it |
|---|---|---|
| `linux-smoke.mjs` | Starts an unpacked Electron Linux build in Docker under Xvfb, drives it over CDP and saves a screenshot. Passes or fails. | Agents, CI, people |
| `vm-drop.mjs` | Copies a build into one shared drop folder, `~/VMShare`, next to a double-click launcher. A Windows or Linux VM opens that folder. | People |

The split is not an accident. Linux can be proven automatically, because the
app is Chromium and a container can read a frame back out of it. Windows
cannot — no Windows container runs a GUI app on a Mac — so the most that half
can do is put a correct build one double-click away from a person.

The folder is **project-agnostic**: nothing in it imports from the repository
around it and nothing in it names an app. All project wiring lives in the root
`package.json` and in `scripts/desktop-linux-smoke.mjs` and
`scripts/desktop-vm-drop.mjs`. Keep it that way — the folder is copied between
projects unchanged.

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

## vm-drop.mjs

```bash
node scripts/crossplat/vm-drop.mjs \
  --project <slug> --platform <windows|linux>-<x64|arm64> \
  --source <unpacked dir or single file> --launch <exe inside the dir> \
  [--note "what is baked in"] [--start-vm "<UTM VM name>"]
```

One shared drop folder serves every project on the machine:

```
~/VMShare/                       (CROSSPLAT_SHARE moves it)
  INDEX.txt                      every drop, newest first
  my-app/windows-arm64/          app/  run.cmd  DROP.json
  another-app/windows-x64/       app/Another_1.2.0_x64-setup.exe  run.cmd  DROP.json
```

Set up one Windows VM and one Linux VM and share this folder with them once.
From then on every project's builds appear there, and in the VM you
double-click `<project>\<platform>\run.cmd` (or `run.sh` on Linux).

Requirements and rules:

- **The launcher mirrors the drop to the guest's own disk before starting it.**
  Windows' WebDAV client, which UTM's shared directory uses, refuses files
  over 50 MB, and an Electron main executable is around 200 MB. An app run
  straight off a share also locks its files, and the host then cannot replace
  them on the next drop.
- **The drop is swapped whole.** It is written to a `.incoming` sibling and
  renamed over the old one, so a guest never sees half of two builds.
- `--source` takes a folder (an unpacked electron-builder build) or a single
  file (an installer downloaded from CI). With a file, the launcher runs it.
- `DROP.json` records the commit, whether the tree was dirty, the source path
  and the note. `INDEX.txt` lists every drop of every project, newest first.
- `--start-vm`, or `CROSSPLAT_UTM_VM`, starts that UTM VM through `utmctl`
  once the drop is written. **This opens UTM's window**, so leave it off in
  agent and CI runs.

## Wiring it into a project

1. Keep this folder as it is.
2. Add a script that builds the unpacked Linux app for the Docker daemon's
   architecture and then calls the smoke runner. In this repository that
   script is `scripts/desktop-linux-smoke.mjs`, behind `pnpm test:desktop:linux`.
3. Add a script that cross-builds the unpacked Windows app and drops it. Here
   that is `scripts/desktop-vm-drop.mjs`, behind `pnpm prod:win`.

Tauri is not covered by the smoke test: it uses WebKitGTK rather than
Chromium, so there is no CDP endpoint to attach to. It can still be dropped —
cross-compiling it for Windows is not practical, so download the installer
from CI and pass that single file as `--source`.
