# Retained documentation releases

The site image keeps the current static export and two prior exports. Each
snapshot has its own `version.json` and directory under `__releases/<SHA>`.
Those directories cannot be fetched directly. nginx selects one only from a
validated `x-deployment-id` request header. Missing or expired releases return
404; malformed IDs return 400. Neither case falls through to current RSC.

The root serves current HTML/version metadata. Its `_next/static` directory is
an immutable union of the three retained snapshots. Any same-path/different-byte
collision fails the build. Copying snapshots from their isolated directories
prevents old unions from growing without bound.

Next 16 uses `x-nextjs-deployment-id` in the response to compare navigation
versions. Exported Flight bodies contain build IDs, which can differ from the
configured deployment ID. nginx therefore echoes the validated selected SHA in
that response header. RSC responses use no-store and vary on x-deployment-id.

`ReleaseLifetime` checks the window on focus and every minute. An expired docs
tab reloads its exact URL. It uses `location.reload()`: replacing an identical
URL with a fragment would only perform same-document navigation. These docs
have no editor state. Stateful applications need persistence before reloading.
Legacy tabs loaded before the lifetime guard require separate adoption checks.

Build ancestry is fixed before Docker starts:

- `latest`, its source-SHA tag, and both journal markers must identify the same
  byte-verified digest, followed by stable public HTML/version verification.
- The single initial adoption exception names the reviewed A digest/SHA in
  `prepare-docs-build.mjs`. Both journal markers must be absent. A partial
  journal is never accepted, and this exception claims no prior continuity.
- An existing target-SHA tag is never overwritten or rebuilt. Use its recorded
  image digest, or create a new source commit.
- Docker imports the pinned parent image. OCI labels and `build-inputs.json`
  record that parent. Deployment rejects it if the serving baseline changes.

Local checks:

```sh
node --test scripts/release.test.mjs scripts/rolling-release.test.mjs scripts/retained-docs.test.mjs
RUN_DOCKER_TESTS=1 node --test scripts/retained-docs-http.test.mjs
```

For browser compatibility, build B and C with different deployment IDs and a
real change to `release-window-details.tsx` plus an MDX page. Open B without
clicking its release-window button. Disable browser cache, replace its backend
with C, and remove B. The first button click must fetch B's old lazy chunk from
C. Route navigation must retain B's version and receive B's RSC. Finally expire
B in fixture metadata: focus must load C without changing the URL query or
fragment. Use actual retained-tree pruning tests alongside that expiry fixture.

First adoption of an unversioned site is a separate check. Keep an A tab open,
retire A, and follow its existing links against B. This does not prove indefinite
compatibility for clients that predate the lifetime guard.
