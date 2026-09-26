# Migrations and indexes at boot

`src/db/prepare.ts` runs right after the database connects and before anything
else — before Redis, before auth, before the HTTP server listens. It does two
things in this order:

1. **Migrations.** Every entry in `src/services/migrations/registry.ts` that
   this database has not recorded yet, applied in id order, under a lease held
   in `app_meta` and recorded in `schema_migrations`.
2. **Indexes.** Every index declared by a model in `src/models/registry.ts`,
   built one at a time, with each failure named.

Migrations go first because one of them may be what removes the duplicate rows
a unique index would otherwise fail to build on.

The boot sequence in `src/index.ts`:

```
connectToDB()  →  prepareDatabase()  →  connectRedis()  →  initAuth()  →  listen
```

## Looking before you upgrade

```bash
pnpm --filter __HATCHKIT_SERVER_PKG__ admin migrate --status    # applied, pending, schema version
pnpm --filter __HATCHKIT_SERVER_PKG__ admin migrate --dry-run   # what an apply would run
pnpm --filter __HATCHKIT_SERVER_PKG__ admin migrate --apply     # apply without starting the server
pnpm --filter __HATCHKIT_SERVER_PKG__ admin doctor              # database, schema and index health
```

`doctor` is read-only, and it reads the same registry, the same collection and
the same model list the boot does. Take a database dump before an upgrade that
has pending migrations; `--status` is how you find out that it does.

## The five rules

Each of these fails quietly when it is broken — no exception, no log line, just
a wrong answer later.

### 1. Migrations are append-only, 1…n, idempotent, and written on the raw driver

Never edit, reorder, renumber or delete a released migration: databases out
there have its id recorded. Fix a released migration by appending the
correction as the next id.

`up` must be idempotent, because two ordinary events re-run it: a process can
die between finishing `up` and writing the record, and a lease can lapse
mid-run so another process takes over. Write the filter so a second run is a
no-op (`{ field: { $exists: false } }`), not so it is merely harmless.

Use the raw `Db`, never today's mongoose models. A migration outlives the model
file it was written beside, and the database it has to fix is the old one — a
model-based migration silently applies validators, defaults and casts that did
not exist when those rows were written.

### 2. `minReaderSchema` stays low unless an older build would misread the result

It is the lowest schema version a build must have to still read the database
after the migration ran, and it is the one field here with a blast radius.

Raising it makes **every older build refuse to start** against this database.
For a breaking change that is the point: the alternative is an old replica
quietly corrupting the new shape. For an additive change it is a self-inflicted
outage, because a rollback — or the old container still draining during the
deploy — can no longer boot. Additive migrations keep it at `0`.

### 3. The readable check runs before the lock

A build too old for the database exits immediately, without writing anything
and without waiting on a lock the newer build is holding while it migrates. A
rolled-back container should fail in seconds with a sentence an operator can
act on, not sit in a restart loop.

### 4. Never sync indexes wholesale

`syncIndexes()` drops every index the current schema does not declare — which
includes every index a newer release added — and it succeeds while doing it.
`src/db/indexes.ts` creates each declared index instead and never drops one.

An index listed in `CRITICAL_INDEXES` stops the boot when it cannot be built:
those are the unique indexes whose absence is a wrong answer the app cannot
detect. Every other failure logs a warning and the server starts, because a
missing lookup index is a slow query, not corruption.

A model that is not imported by `src/models/registry.ts` is checked by neither
the boot nor `doctor`.

### 5. No `enum` on a field a create copies from another stored document

A newer release may have written a value this build has never heard of.
Mongoose runs `enum` validators on `create`, so the older build throws a
`ValidationError` on a value the user never typed. Validate where the value
enters the system, and normalise unknown values where they are read. See
`src/models/README.md`.

## Writing one

Add `src/services/migrations/002-<what-it-does>.ts`, export a `Migration`, and
append it to the array in `registry.ts`. `SCHEMA_VERSION` follows the last id
on its own. `src/tests/migrations.test.ts` fails if the sequence has a gap.
