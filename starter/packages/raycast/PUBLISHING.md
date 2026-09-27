# Publishing this extension

Not copied into the exported package. This file is for whoever ships it.

## `name` and `author` are permanent

Raycast keys the extension's encrypted `LocalStorage` by the **(name, author)**
pair. Everything this extension keeps lives there:

- the session credential and the origin that issued it,
- the durable queue of changes that have not reached the server,
- the optimistic overlay and the read cache,
- the per-origin capability cache,
- this install's stable origin id.

Change either half after the first publish and every installed copy starts with
an empty store. Nobody is signed out with an error — they are signed out with
no explanation, and whatever was queued is gone. There is no migration path,
because the old keys are addressed by a pair that no longer exists.

The store listing's identity is the same pair.

So: decide both once, before the first submission, and never again.

- `name` in `package.json` is written at scaffold time from the project's
  identifier set. Do not hand-edit it.
- `author` is your Raycast Store handle. The repository copy carries a
  placeholder, and the only place the real one is written is the export's
  `--author` flag.

## Publish from the export, never from here

`npm run publish` in this package is a guard that exits. The repository copy
carries the placeholder author, a development build flag pointing at
`localhost`, scripts that need this repository, and comments about tooling a
store reader cannot see.

```bash
node scripts/export-store.mjs ../../../launcher-store \
    --license MIT --author your-store-handle --lint
```

`--license` and `--author` have no defaults on purpose. Both are decisions, and
a wrong value committed here would otherwise be published silently.

The export writes an npm-installable copy: the store's own scripts, plain
registry ranges, no build output. It refuses a dependency that cannot be
installed from the public registry, a README that names the repository, and any
user-visible string in `src/` that does.

Then, inside the exported directory:

```bash
npm install
npx @raycast/api@latest publish
```

## Before you submit

- `assets/extension-icon.png` must exist, or `ray build` and `ray develop` both
  fail. It is 512×512.
- The release origins in `src/lib/preferences.ts` must point at the deployed
  service. The export refuses placeholder origins unless you pass `--draft`.
- `src/lib/version.ts` must match the repository's version. A test fails when
  it does not — the store submission is this directory alone, so the number
  cannot be read from anywhere else at build time.
- The README is the store page. The numbers in it — how many commands, how
  often the menu bar refreshes — are claims about the code, and a test fails
  when they stop matching the manifest.
- `--author` must be a Raycast handle that exists.
  `pnpm --filter @starter/raycast run lint:store` checks it against the store's
  own API, which is why that command is not part of the repository's `lint`
  aggregate: it cannot pass with the placeholder, and it needs the network.
