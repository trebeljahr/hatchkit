// Migration and index-preparation tests.
//
// Everything above the divider is pure and runs everywhere, including in a CI
// job with no services: the sequence rules, the readable check and the
// critical-vs-warning classification are the three things that fail QUIETLY in
// production, so they are the three that must be checked on every commit
// rather than only when somebody remembers to start a database.
//
// Below the divider the runner is exercised against a real MongoDB. Those
// tests skip unless TEST_MONGODB_URI is set, and each uses a throwaway
// database of its own so a run never touches development data:
//
//   TEST_MONGODB_URI=mongodb://127.0.0.1:27017 pnpm test
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MongoClient } from "mongodb";
import {
  CRITICAL_INDEXES,
  type IndexOutcome,
  isCritical,
  reportIndexOutcomes,
} from "../db/indexes.js";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  SchemaTooNewError,
  assertMigrationSequence,
  assertReadable,
  type Migration,
  type MigrationRecord,
  type MigrationState,
  migrationStatus,
  pendingMigrations,
  runMigrations,
} from "../services/migrations/index.js";

// ── The registry ──────────────────────────────────────────────────────────

test("the registry is contiguous from 1 and every entry declares a reader floor", () => {
  assertMigrationSequence(MIGRATIONS);
  assert.ok(MIGRATIONS.length > 0, "there is always at least the baseline");
  MIGRATIONS.forEach((migration, index) => {
    assert.equal(migration.id, index + 1);
    assert.equal(typeof migration.minReaderSchema, "number");
    assert.ok(Number.isInteger(migration.minReaderSchema));
    assert.ok(migration.minReaderSchema >= 0 && migration.minReaderSchema <= migration.id);
    assert.notEqual(migration.description.trim(), "");
  });
});

test("SCHEMA_VERSION is the id of the last migration", () => {
  assert.equal(SCHEMA_VERSION, MIGRATIONS[MIGRATIONS.length - 1]?.id);
});

test("a gap, a reorder or a reader floor above the migration itself is rejected", () => {
  const up = async () => {};
  assert.throws(
    () =>
      assertMigrationSequence([
        { id: 1, description: "a", minReaderSchema: 0, up },
        { id: 3, description: "c", minReaderSchema: 0, up },
      ]),
    /ids must be 1, 2, 3/,
  );
  assert.throws(
    () =>
      assertMigrationSequence([
        { id: 2, description: "b", minReaderSchema: 0, up },
        { id: 1, description: "a", minReaderSchema: 0, up },
      ]),
    /ids must be 1, 2, 3/,
  );
  assert.throws(
    () => assertMigrationSequence([{ id: 1, description: "a", minReaderSchema: 2, up }]),
    /minReaderSchema/,
  );
});

// ── The readable check ────────────────────────────────────────────────────

function stateWith(records: Array<Partial<MigrationRecord> & { _id: number }>): MigrationState {
  const applied = records.map((record) => ({
    description: "",
    minReaderSchema: 0,
    appliedAt: new Date(0),
    release: "",
    ...record,
  }));
  let raisedBy: MigrationRecord | null = null;
  for (const record of applied) {
    if (record.minReaderSchema > (raisedBy?.minReaderSchema ?? 0)) raisedBy = record;
  }
  return { applied, requiredReaderSchema: raisedBy?.minReaderSchema ?? 0, raisedBy };
}

test("an additive history stays readable by every build", () => {
  const state = stateWith([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);
  assert.equal(state.requiredReaderSchema, 0);
  assert.doesNotThrow(() => assertReadable(state, 0));
  assert.doesNotThrow(() => assertReadable(state, 1));
});

test("a build older than the reader floor is refused, and told which release raised it", () => {
  const state = stateWith([{ _id: 1 }, { _id: 4, minReaderSchema: 4, release: "2.0.0" }]);
  assert.equal(state.requiredReaderSchema, 4);
  assert.doesNotThrow(() => assertReadable(state, 4), "the release that raised it still boots");
  assert.doesNotThrow(() => assertReadable(state, 7), "a newer build still boots");
  assert.throws(
    () => assertReadable(state, 3),
    (error: unknown) => {
      assert.ok(error instanceof SchemaTooNewError);
      assert.equal(error.requiredReaderSchema, 4);
      assert.equal(error.schemaVersion, 3);
      assert.match(error.message, /2\.0\.0/);
      return true;
    },
  );
});

test("pending skips what is recorded, including ids applied out of this build's range", () => {
  const up = async () => {};
  const migrations: Migration[] = [
    { id: 1, description: "a", minReaderSchema: 0, up },
    { id: 2, description: "b", minReaderSchema: 0, up },
  ];
  assert.deepEqual(
    pendingMigrations(stateWith([{ _id: 1 }]), migrations).map((m) => m.id),
    [2],
  );
  assert.deepEqual(pendingMigrations(stateWith([{ _id: 1 }, { _id: 2 }]), migrations), []);
  // A newer release applied 3; this build has never heard of it and has
  // nothing pending because of it.
  assert.deepEqual(
    pendingMigrations(stateWith([{ _id: 1 }, { _id: 2 }, { _id: 3 }]), migrations),
    [],
  );
});

// ── Index classification ──────────────────────────────────────────────────

const outcome = (over: Partial<IndexOutcome>): IndexOutcome => ({
  model: "Item",
  collection: "items",
  keys: { ownerId: 1 },
  unique: false,
  critical: false,
  error: null,
  ...over,
});

test("only the listed unique indexes count as critical", () => {
  for (const entry of CRITICAL_INDEXES) {
    assert.ok(isCritical(entry.model, entry.keys));
  }
  assert.ok(!isCritical("Item", { ownerId: 1 }), "a lookup index must never stop the boot");
  assert.ok(!isCritical("Unknown", { userId: 1 }), "the model name is part of the match");
  assert.ok(!isCritical("Profile", { userId: -1 }), "the key direction is part of the match");
});

test("a critical failure is fatal, a plain one warns, and a success says nothing", () => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger = {
    warn: (message: string) => warnings.push(message),
    error: (message: string) => errors.push(message),
  };
  const fatal = reportIndexOutcomes(
    [
      outcome({}),
      outcome({ error: "duplicate key" }),
      outcome({
        model: "Profile",
        collection: "profiles",
        keys: { userId: 1 },
        unique: true,
        critical: true,
        error: "E11000 duplicate key",
      }),
    ],
    logger,
  );
  assert.equal(fatal.length, 1);
  assert.equal(fatal[0]?.model, "Profile");
  assert.equal(errors.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /queries still work/);
});

// ── Against a real database ───────────────────────────────────────────────

const TEST_MONGODB_URI = process.env.TEST_MONGODB_URI;
const skip = TEST_MONGODB_URI
  ? false
  : "set TEST_MONGODB_URI to run the database-backed migration tests";

const silent = { log: () => {}, error: () => {} };

/** Run `body` against an empty database nothing else uses, and drop it. */
async function withThrowawayDb(
  body: (db: import("mongodb").Db) => Promise<void>,
): Promise<void> {
  const client = new MongoClient(TEST_MONGODB_URI ?? "");
  await client.connect();
  const db = client.db(`migrations_test_${randomUUID().replace(/-/g, "")}`);
  try {
    await body(db);
  } finally {
    await db.dropDatabase().catch(() => undefined);
    await client.close();
  }
}

test("a run applies what is pending, records it, and a second run does nothing", { skip }, async () => {
  await withThrowawayDb(async (db) => {
    const applied = await runMigrations({
      db,
      migrations: MIGRATIONS,
      schemaVersion: SCHEMA_VERSION,
      owner: "test-a",
      release: "test",
      logger: silent,
    });
    assert.deepEqual(
      applied,
      MIGRATIONS.map((migration) => migration.id),
    );

    const again = await runMigrations({
      db,
      migrations: MIGRATIONS,
      schemaVersion: SCHEMA_VERSION,
      owner: "test-b",
      release: "test",
      logger: silent,
    });
    assert.deepEqual(again, [], "a second boot re-applies nothing");

    const status = await migrationStatus(db, MIGRATIONS, SCHEMA_VERSION);
    assert.equal(status.readable, true);
    assert.deepEqual(status.pending, []);
    assert.equal(status.applied.length, MIGRATIONS.length);
    assert.equal(status.applied[0]?.release, "test");
  });
});

test("an interrupted migration runs again on the next start", { skip }, async () => {
  await withThrowawayDb(async (db) => {
    let calls = 0;
    const flaky: Migration[] = [
      {
        id: 1,
        description: "fails once, then succeeds",
        minReaderSchema: 0,
        up: async () => {
          calls += 1;
          if (calls === 1) throw new Error("killed mid-run");
        },
      },
    ];
    await assert.rejects(
      runMigrations({
        db,
        migrations: flaky,
        schemaVersion: 1,
        owner: "test-a",
        release: "test",
        logger: silent,
      }),
      /killed mid-run/,
    );
    // Nothing was recorded, so the next boot retries it — and the lock was
    // given back, so the next boot is not stuck waiting for a dead process.
    assert.deepEqual(
      (await migrationStatus(db, flaky, 1)).pending.map((migration) => migration.id),
      [1],
    );
    const applied = await runMigrations({
      db,
      migrations: flaky,
      schemaVersion: 1,
      owner: "test-b",
      release: "test",
      logger: silent,
    });
    assert.deepEqual(applied, [1]);
    assert.equal(calls, 2);
  });
});

test("a build older than the recorded reader floor refuses to run", { skip }, async () => {
  await withThrowawayDb(async (db) => {
    const breaking: Migration[] = [
      { id: 1, description: "baseline", minReaderSchema: 0, up: async () => {} },
      { id: 2, description: "breaking", minReaderSchema: 2, up: async () => {} },
    ];
    await runMigrations({
      db,
      migrations: breaking,
      schemaVersion: 2,
      owner: "new",
      release: "2.0.0",
      logger: silent,
    });

    // The rolled-back build knows only migration 1.
    const old = breaking.slice(0, 1);
    await assert.rejects(
      runMigrations({
        db,
        migrations: old,
        schemaVersion: 1,
        owner: "old",
        release: "1.0.0",
        logger: silent,
      }),
      SchemaTooNewError,
    );
    const status = await migrationStatus(db, old, 1);
    assert.equal(status.readable, false);
    assert.equal(status.requiredReaderSchema, 2);
    assert.equal(status.unknownApplied.length, 1, "id 2 came from a release this build lacks");
  });
});
