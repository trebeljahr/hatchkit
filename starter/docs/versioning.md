# Versioning: client and server compatibility

This file is the contract between a server and every client that talks to it.
The names it describes live in `packages/shared/src/api-level.ts`,
`packages/shared/src/sync-protocol.ts`, `packages/server/src/auth/client-version.ts`
and `packages/server/src/contract/`.

Read it before you add a tRPC procedure, an input field, an enum value or a sync
event kind. Every rule below is followed by what breaks when it is ignored,
because none of them break loudly.

## Three clocks, and why a release number cannot answer compatibility

A project with more than one surface runs three clocks at once.

- **The server lags.** A self-hosted deployment updates when somebody decides
  to. Months behind is normal.
- **Store clients lead.** A browser extension, a launcher extension and the
  phone builds update themselves, often within a day, and are frequently
  *newer* than the server they point at.
- **Long-lived clients trail.** A desktop build nobody restarted, a browser tab
  left open across a deploy. These keep talking to the server with the code
  they were loaded with.

So "server 1.4.0 and client 1.4.0" answers nothing, because a server and a
client of the same release were never guaranteed to be deployed together, and in
a self-hosted setup they are guaranteed not to be. A release number describes
*when a thing was built*, and compatibility is a question about *what a thing
knows*.

The answer is an integer **API level**: the set of procedures, input fields,
enum values and sync event kinds a build knows. Each side declares its level,
and each side names the lowest level of the other it still works with.

- `API_LEVEL` — the level this build speaks.
- `API_LEVEL_CHANGES` — what each level added, oldest first.
- `MIN_CLIENT_API_LEVEL` — the lowest client level this server serves.
- `MIN_SERVER_API_LEVEL` (`@starter/core`) — the lowest server level a client
  works against.

Level 0 is not a row in the table. It is every build released before the
handshake existed: it declares nothing and reports nothing.

## Bumping the API level

**Bump `API_LEVEL` whenever something is ADDED**: a tRPC procedure, an input
field, an enum value a client may send or receive, or a sync event kind. Add a
row to `API_LEVEL_CHANGES` in the same change, naming what a peer at that level
can now rely on. Never lower the level, and never renumber a row that has
shipped.

The rows are checked by `packages/server/src/tests/api-level.test.ts`: levels are
1..n with no gaps, the last row is `API_LEVEL`, and every row names what it
added.

Without the bump, a client has no way to ask whether the feature is there. It
either calls the procedure anyway — and gets NOT_FOUND from an older server,
which the offline queue has to be taught not to treat as "this row is
impossible" — or it hides the feature on servers that do have it. Without the
row, the next author writes a capability gate against a guessed number, because
nothing says what level 4 means.

## The floor and the refusal codes

`MIN_CLIENT_API_LEVEL` is the floor. A request that **declares** a level below
it is refused with `CLIENT_TOO_OLD`. The mirror case — a client that finds a
server below its own `MIN_SERVER_API_LEVEL` — is `SERVER_TOO_OLD`, decided by
the client from the health response rather than by a refusal.

Three rules, all of them easy to get wrong:

- **No header is legacy, never level 0.** A request that declares nothing is a
  client from before the handshake and is always served. So is a request whose
  level cannot be parsed: a proxy that mangles headers must not be able to get a
  working client refused. Treat a malformed level as level 0 and you refuse
  clients over a header rewrite nobody controls.
- **`health.*` is never refused.** The version floor skips every path starting
  `health.`, so a refused client can still read the server's level and say
  *which side* needs updating. Refuse the health check too and the only thing a
  client can tell the person is "something went wrong", which is what a network
  error already says.
- **The refusal is 412** (`VERSION_REFUSAL_HTTP_STATUS`), carried as
  `data.versionRefusal` on a tRPC error alongside `code:
  "PRECONDITION_FAILED"`. This is not cosmetic. The offline queue DROPS a row on
  a permanent rejection status — 400, 403, 404, 409, 410, 422
  (`isPermanentRejectionStatus` in `@starter/core`) — so a floor served as 400
  would delete every mutation an old client had queued, silently, the first time
  it met a new server. A 412 keeps the row for a build that can send it.

The refusal is also a **code, not a message**. Clients match on
`data.versionRefusal`, never on prose: prose changes the next time somebody
improves the wording, and in a translated build matching it never worked.

A declared level is **self-reported**, and so is the client version. Anyone can
send any value. That is fine, because the floor protects honest old clients from
a server they would misread — it is not a security boundary, and nothing about
what a request is *allowed* to do may ever be decided by a declared level.

## The headers

Two request headers carry the handshake:

| Header | Value |
| --- | --- |
| `x-starter-api-level` (`API_LEVEL_HEADER`) | the client's `API_LEVEL` |
| `x-starter-client-version` (`CLIENT_VERSION_HEADER`) | the client's release, e.g. `0.3.1` |

`versionHeaders()` in `@starter/shared` builds both: the level always, the
version only when it parses. The server reads them with `declaredClient()`.

A third header is **not** part of the handshake. `x-starter-client`
(`CLIENT_ID_HEADER`) names the client in a device list — "web", "desktop", a
launcher extension. It is a label and never a permission, it is read by
`parseDeclaredClientLabel()`, and the floor ignores it completely. Wire it into
an authorization decision and every client can grant itself that decision by
editing one header.

**Never send the handshake headers to `/api/health`.** A custom header turns a
plain GET into a preflighted request; an untrusted origin's preflight fails; and
the client reads that failure as "server unreachable". The endpoint that exists
to explain a version problem then becomes the thing that hides it. Send them on
`/api/trpc` and the rest of the API, where the origin is trusted already.

## The health field

`GET /api/health` and the `health.check` procedure both report:

```json
{
  "status": "ok",
  "db": true,
  "version": "<commit sha>",
  "timestamp": "...",
  "apiLevel": 2,
  "minClientApiLevel": 1
}
```

`apiLevel` and `minClientApiLevel` are what let a client name the side that is
too old: its own level below `minClientApiLevel` means "update the app", the
server's `apiLevel` below the client's own floor means "update the server".
`version` is the commit the image was built from and says nothing about
compatibility — a deploy pipeline polls it, a client must not reason from it.

Both fields are also what a capability gate reads (below), so a client typically
fetches health once on startup and caches the level.

## The contract snapshot

`packages/server/contract/trpc-contract.json` is a **committed** artifact: every
procedure's type and input JSON Schema, every sync event kind's schema, and both
level numbers.

```bash
pnpm run contract:emit    # rewrite the snapshot
pnpm run test:unit        # fails when the committed file is stale
```

Run `contract:emit` once after scaffolding — the file is not generated for you,
because a test that writes its own expectation cannot fail — and again in every
change that touches a procedure name, a procedure's input or a sync event kind.
Commit the result.

Why bother, when client and server are typechecked together in this repo:
**they are not deployed together.** An input narrowed here typechecks green and
is a refusal on somebody's phone that no test of this repo would ever run. The
snapshot turns that into a diff in a pull request.

Outputs are deliberately **not** snapshotted. They are TypeScript types and no
client validates them, so a changed output shape cannot refuse a request — at
worst a field reads as `undefined`. Inputs are zod schemas, which is exactly
what the server refuses a request with.

When the snapshot is stale, `trpc-contract.test.ts` classifies the difference
and the failure names the rule:

- **breaking** — an existing client can send something this server now refuses,
  or stops receiving something it relies on. A removed or renamed procedure, an
  input field going optional → required, an enum value removed from an input, a
  nullable input becoming non-null, a tighter length or range bound, a removed
  sync event kind. Raise `MIN_CLIENT_API_LEVEL` **and** `API_LEVEL` in the same
  change.
- **additive** — something new a newer client may rely on. A new procedure, a
  new optional input field, a new enum value, a new sync event kind. Bump
  `API_LEVEL` and add an `API_LEVEL_CHANGES` row.
- **neutral** — neither. A removed input property is *stripped* by zod, never
  refused, so an old client that still sends it is served exactly as before. A
  changed description is not a change at all.

A sync event kind is added in **three** places: the `SyncEvent` union,
`SYNC_EVENT_KIND_SET` (both in `packages/shared/src/sync-protocol.ts`), and
`packages/server/src/contract/sync-events.ts`. `tsc` enforces the last two and
the third throws at module load if the set and the schemas disagree. Miss the
set and nothing fails: every client falls into its unknown-kind branch and
refetches forever.

An unknown kind or an unknown enum value means **refetch**, never ignore. Keep
the `never` defaults that fail the build, and let them fall through to a refetch
at runtime — which is why a widened output enum counts as additive rather than
breaking.

## Gating a feature on the server level

Do not compare numbers at call sites. Name the gate:

```ts
import { serverSupports } from "@starter/shared";

if (serverSupports("items.update", serverApiLevel)) {
  // offer the edit button
}
```

`Capability` in `api-level.ts` has one member per gate, mapped to the level that
introduced it. Add the member in the same change that bumps `API_LEVEL`.

**A null level is optimistic.** `serverSupports(capability, null)` is `true`:
"nobody has asked yet" is not "no". Treating unknown as no hides a working
feature behind a health read that has not landed, and it never recovers if that
read fails, because the gate is checked when the screen renders. Level `0` is a
different answer — a real server from before the handshake — and it has nothing.

## Stored values are versioned too

The same problem exists on disk. A client rollback reads values a newer build
wrote, and an unreadable value is somebody's work.

- Stored values carry a `{ v, data }` envelope. A bare value from before the
  envelope still reads as `v: 1`.
- **A newer `v` LOCKS the offline queue rather than emptying it.** Its rows are
  held, `enqueue` and `remove` throw, and `clear` does nothing. The alternative —
  reading an unknown version as a miss — means the next mutation overwrites
  mutations the person is still waiting to sync, and they never learn.
- **An unreadable value is copied aside before any reset**, to
  `starter.offline-queue.corrupt.<ms>`. A reset that keeps no copy turns a
  parsing bug into permanent data loss, and there is nothing left to work out
  what went wrong from.
- A build from before the envelope reads `{ v, data }` as empty, so a rollback
  past it strands the queue until the next enqueue. That is a known cost of
  rolling back, not a bug to fix by loosening the reader.
