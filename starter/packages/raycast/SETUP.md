# Setting up the launcher extension

For whoever runs this from the repository. Not copied into the exported
package — the store page is `README.md`.

## What it does, and what it does not do yet

It does: capture an item from a global hotkey, show the item you touched last
in the menu bar, list your items, create one from a form, and open the web app.
Changes made with no answer from the server are queued on the machine and sent
in order later.

It does not do, and there is no plan in this scaffold: workspaces, profiles,
search across anything but the list it has already read, attachments, or
anything the public web app does that is not one of the five commands.

**The only install path is this repository.** There is no published extension
until somebody publishes one (`PUBLISHING.md`). `ray develop` installs the
working copy into your own Raycast; it is not a release.

## 1. Build it

```bash
pnpm install
pnpm --filter starter-launcher run vendor
pnpm --filter starter-launcher run typecheck
```

`vendor` regenerates `src/vendor/` from `packages/core` and
`packages/shared`. It runs before `dev` and `build` on its own; run it by hand
after changing either of those packages.

## 2. Verify it, BEFORE you install it

Do this first. A launcher command that fails on start reports almost nothing —
Raycast shows that the command errored, and the reason is in a log you have to
go looking for. These two commands answer in your terminal instead.

```bash
pnpm --filter starter-launcher run test
```

Expected output, exactly:

```
# pass 22
# fail 0
```

```bash
pnpm --filter starter-launcher exec node scripts/vendor-core.mjs --check
```

Expected output, exactly:

```
vendor: 17 file(s) in step
```

A `stale:` or `missing:` line there means `src/vendor/` and the source packages
have diverged. Run `vendor` and commit the result.

`pnpm --filter starter-launcher run lint` passes too. It runs eslint and
prettier over this package's own sources, minus `src/vendor/`.

It deliberately does NOT run `ray lint`. That command validates the manifest
against the store's schema and asks the store's HTTP API whether the manifest's
`author` is a real handle — a network call CI has no business making, and one
that cannot pass while the scaffold's placeholder handle is in place. It is
wired up as `lint:store` instead and belongs to the publishing step:

```bash
pnpm --filter starter-launcher run lint:store
```

Expect exactly one error from it until the real handle is set:

```
Invalid author "starter-author". error: 404 - Not found
```

Everything else it checks — the manifest schema, the icon, eslint, prettier —
passes.

## 3. Point it at a server

```bash
pnpm run dev        # the PINNED ports: client 3000, API 5000
```

Use `pnpm run dev`, not `pnpm run dev:auto`. This extension bakes its
development origin in at build time and cannot follow a port that changes per
run. A git worktree runs `dev` in auto-port mode by default, so a worktree does
not serve the ports this extension expects: either run `pnpm run dev:fixed`
there, or set the **API Origin** and **Web App Origin** preferences to the
ports it printed.

## 4. Install it into Raycast

```bash
pnpm --filter starter-launcher run dev
```

This installs the working copy and watches for changes. Stop it with Ctrl-C;
the extension stays installed until you remove it from Raycast's own extension
list.

## 5. Pair it

Run any command and choose **Pair with the Web App**. The approval page opens
in your browser with the code filled in, and the code is also on your
clipboard.

The server has to know this client id before it will start a pairing flow. The
scaffold writes it into the generated `validateClient` rule in
`packages/server/src/auth/auth.ts`; a server that answers `invalid_client` has
a different allowlist.

Which capabilities unlock what:

| The server reports                    | The extension offers                                    |
| ------------------------------------- | ------------------------------------------------------- |
| nothing (never asked, or unreachable) | Reading, creating, deleting. Editing is hidden.         |
| `items.update`                        | Mark Published and Archive, in the list's action panel. |

An action is hidden rather than offered-and-refused: a server one release
behind answers `NOT_FOUND` for a procedure it has never heard of, which reads
to a person as "that item is gone".

## Where the credential lives

In Raycast's own encrypted per-extension store, beside the origin that issued
it. Revoke it from the account's device list in the web app, or run
**Pair with the Web App** again against a different server — the old
credential is then reported as belonging elsewhere and is never sent.

Signing out clears the credential, the read cache and the optimistic overlay.
It deliberately does NOT clear the queue: those rows are work that exists
nowhere else. They are stamped with their owner, so the next account cannot
replay them.
