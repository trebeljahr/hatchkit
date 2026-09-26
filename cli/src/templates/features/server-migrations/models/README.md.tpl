# Models

Two rules keep a database readable by more than one release at once. That
matters more often than it sounds: a deploy briefly runs the old container and
the new one against the same database, and a rollback runs the old one alone
against a database the new one has already written to.

## Absent reads as the default

A new field is optional and carries no `required`. Documents written before the
field existed do not have it, and the code reads the absent value as the
default. Anything that has to rewrite existing documents is a migration in
`src/services/migrations/`, never a side effect of editing a model.

## Never reject a value a newer release may have written

**No `enum` on any field a create copies from another stored document.**

Mongoose runs `enum` validators on `create` and `insertMany`. So an `enum` only
bites when a create copies a value it read from another stored document — and
that is exactly when a newer release may already have written a value this
build has never heard of: a new status, a new locale, a new plan tier. The
older build then throws a `ValidationError` on something the user did not type
and cannot correct, while the request that triggered it looks like a bug in
whatever was being copied.

- **Snapshot and copied fields carry no `enum`.** Check the value where it
  ENTERS the system instead — the zod schema on the request — not where it is
  copied between documents.
- **A create that copies a stored value normalises it first.** An unknown value
  becomes the default or `null`, in one named helper, so the unknown-value
  policy is in one place instead of implied by a validator's absence.
- An `enum` on a field that only a validated request ever writes is fine.

`src/tests/migrations.test.ts` is the place to pin this once a model of your
own copies a stored value.

## Indexes

`src/db/indexes.ts` builds every declared index at boot and logs each failure.
A failed index listed in `CRITICAL_INDEXES` stops the boot; every other failure
warns and the server starts. Never call `syncIndexes()`: it drops indexes a
newer release created, and it succeeds while doing it.

A model must be imported by `registry.ts` to be checked at all — by the boot or
by `admin doctor`.
