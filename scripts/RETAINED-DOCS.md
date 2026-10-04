# Retained documentation releases

The site image keeps the current static export and two prior exports. Each
snapshot has its own `version.json` and directory under `__releases/<SHA>`.
Those directories cannot be fetched directly. nginx selects one only from a
validated `x-deployment-id` request header. Missing or expired releases return
404; malformed IDs return 400. Neither case falls through to current RSC.

Every container mounts the **same named volume** `hatchkit-docs-releases` at
`/var/lib/hatchkit-docs-releases`. The host must assert its exact Docker mount
name, type, destination and write mode. Startup also requires a real writable
mountpoint and this exact `.store-identity.json` marker:

```json
{"schema":1,"app":"trebeljahr/hatchkit","volume":"hatchkit-docs-releases","purpose":"immutable-docs-releases"}
```

Before nginx starts, a serialized publisher copies complete SHA snapshots by
atomic rename, verifies immutable collisions, and atomically installs shared
lifetime metadata. Both old and new containers read their chunks and selected
RSC from this volume. Thus a C HTML page can fetch C files from B during overlap.
Lifetime checks also read shared metadata, so B cannot incorrectly expire C.
Current HTML and `version.json` stay local to each image for serving identity.

Each running container holds a kernel shared lock on its own SHA until nginx
exits. Cleanup keeps the latest prepared window of three snapshots **plus every
leased running image** (at most three live release IDs). A retiring tree cannot
be pruned. Unleased assets outside that set are removed except the fixed legacy
baseline. Empty lease files remain to avoid unlink/reopen lock races. File and
byte budgets (20,000 files; 256 MiB, including incoming image files) fail closed
before further writes, including after interrupted initialization.

A restart within the current window never rewinds metadata. An expired image
restart is refused. A candidate that seeds files but never becomes healthy can
leave a prepared head; reconcile that exact candidate before a new image whose
parent differs. Never erase the volume or rewind its metadata while containers
still serve it. These are reproducible build artifacts, not application data.
First adoption requires a controlled transition because legacy A does not read
the shared volume. Certify actual B/C mixed routing before automatic activation.

The root serves current HTML/version metadata. Its `_next/static` directory is
an immutable union of the three retained snapshots plus one fixed legacy baseline.
The baseline is the 39 hashed assets (1,649,720 bytes) from the exact A image
pinned in `docs-bootstrap.mjs`. Its sorted path/size/SHA-256 inventory is checked
on every build and inherited separately under the inaccessible `__legacy-assets`
directory inside each image. It does not retain old HTML or RSC outside the three-release window.
Any same-path/different-byte collision fails the build. Copying snapshots from
their isolated directories prevents old unions from growing without bound.

Next 16 uses `x-nextjs-deployment-id` in the response to compare navigation
versions. Exported Flight bodies contain build IDs, which can differ from the
configured deployment ID. nginx therefore echoes the validated selected SHA in
that response header. RSC responses use no-store and vary on x-deployment-id.

`ReleaseLifetime` checks the window on focus and every minute. An expired docs
tab reloads its exact URL. It uses `location.reload()`: replacing an identical
URL with a fragment would only perform same-document navigation. These docs
have no editor state. Stateful applications need persistence before reloading.
Legacy A tabs have no deployment ID or expiry guard. Their hashed JavaScript
remains available indefinitely from the fixed baseline, but their unversioned
page-data requests select the current export. A navigation may therefore switch
to the current page. This does not promise old RSC compatibility for legacy tabs.

Build ancestry is fixed before Docker starts:

- `latest`, its source-SHA tag, and both journal markers must identify the same
  byte-verified digest, followed by stable public HTML/version verification.
- The single initial adoption exception names the reviewed A digest/SHA in
  `docs-bootstrap.mjs`. Both journal markers must be absent. A partial
  journal is never accepted, and this exception claims no prior continuity.
- An existing target-SHA tag is never overwritten or rebuilt. Use its recorded
  image digest, or create a new source commit.
- Docker imports the pinned parent image. OCI labels and `build-inputs.json`
  record that parent. Deployment rejects it if the serving baseline changes.

Local checks:

```sh
node --test scripts/release.test.mjs scripts/rolling-release.test.mjs scripts/retained-docs.test.mjs scripts/shared-docs-releases.test.mjs
RUN_DOCKER_TESTS=1 node --test scripts/retained-docs-http.test.mjs scripts/shared-docs-http.test.mjs
```

For browser compatibility, build B and C with different deployment IDs and a
real change to `release-window-details.tsx` plus an MDX page. Open B without
clicking its release-window button. Disable browser cache, replace its backend
with C, first alternate requests between B and C, then remove B. The first button click must fetch B's old lazy chunk from
C. Route navigation must retain B's version and receive B's RSC. Finally expire
B in fixture metadata: focus must load C without changing the URL query or
fragment. Use actual retained-tree pruning tests alongside that expiry fixture.

First adoption of an unversioned site is a separate check. Keep an A tab open,
retire A, and follow its existing links against B. This does not prove indefinite
compatibility for clients that predate the lifetime guard.
