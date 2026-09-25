/**
 * The per-origin level cache, and the two answers every reader takes from it.
 *
 * The distinction this file exists to protect is `null` versus `0`. Null is "we
 * have never asked", and it is optimistic everywhere: no banner, no held row, no
 * feature hidden. Zero is a real answer from a server released before the version
 * handshake, and it supports nothing. Collapsing the two hides working features
 * behind a health read that has not landed yet.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  API_LEVEL,
  CLIENT_TOO_OLD,
  SERVER_TOO_OLD,
  serverSupports,
} from "@starter/shared";
import {
  MIN_SERVER_API_LEVEL,
  sameServerOrigin,
  serverCompatibility,
  type ServerCheck,
} from "../network.js";
import {
  createServerLevelCache,
  SERVER_LEVELS_STORAGE_KEY,
  SERVER_UPGRADE_DOCS_PATH,
} from "../server-level.js";
import { memoryStorage, type KeyValueStorage } from "../storage.js";

const ORIGIN = "https://app.example.com";

const answered = (
  apiLevel: number,
  minClientApiLevel: number | null = 1,
): ServerCheck => ({
  ok: true,
  server: { origin: ORIGIN, apiLevel, minClientApiLevel, release: "0.1.0" },
});

// ── what "unknown" means ─────────────────────────────────────────────

test("an origin never asked is null, and null is optimistic", () => {
  const cache = createServerLevelCache({ check: async () => answered(API_LEVEL) });
  assert.equal(cache.get(ORIGIN), null);
  assert.equal(cache.apiLevel(ORIGIN), null);
  assert.equal(cache.compatibility(ORIGIN), null, "no banner before we asked");
  assert.equal(cache.supports(ORIGIN, "items.update"), true);

  // The rule the cache leans on, asserted where it is read: unknown is yes,
  // level 0 is a pre-handshake server and it has nothing.
  assert.equal(serverSupports("items.update", null), true);
  assert.equal(serverSupports("items.update", 0), false);
  assert.equal(serverSupports("items.update", API_LEVEL), true);
});

// ── recording and reading ────────────────────────────────────────────

test("record then get, apiLevel and compatibility", () => {
  const cache = createServerLevelCache();
  cache.record({
    origin: ORIGIN,
    apiLevel: API_LEVEL,
    minClientApiLevel: 1,
    release: "0.1.0",
  });

  const level = cache.get(ORIGIN);
  assert.ok(level);
  assert.equal(level.apiLevel, API_LEVEL);
  assert.equal(level.minClientApiLevel, 1);
  assert.equal(level.release, "0.1.0");
  assert.equal(level.clientTooOld, false);
  assert.ok(Number.isFinite(Date.parse(level.checkedAt)));

  assert.equal(cache.apiLevel(ORIGIN), API_LEVEL);
  assert.equal(cache.compatibility(ORIGIN), null);
  assert.equal(cache.supports(ORIGIN, "sync.feed"), true);

  // A pre-handshake server is a real, negative answer.
  cache.record({ origin: ORIGIN, apiLevel: 0, minClientApiLevel: null, release: null });
  assert.equal(cache.apiLevel(ORIGIN), 0);
  assert.equal(cache.compatibility(ORIGIN), SERVER_TOO_OLD);
  assert.equal(cache.supports(ORIGIN, "sync.feed"), false);
});

test("the cache is keyed by origin, whatever the case or a trailing slash says", () => {
  assert.equal(sameServerOrigin(ORIGIN, `${ORIGIN}/`), true);
  assert.equal(sameServerOrigin(`${ORIGIN}/`, "https://APP.example.com"), true);
  assert.equal(sameServerOrigin(ORIGIN, "https://app.example.com:443"), true);
  assert.equal(sameServerOrigin(ORIGIN, "https://other.example.com"), false);
  assert.equal(sameServerOrigin(ORIGIN, "http://app.example.com"), false);
  // Neither side parses: still only ever equal to itself.
  assert.equal(sameServerOrigin("app.example.com/", " App.Example.com "), true);

  const cache = createServerLevelCache();
  cache.record({ origin: `${ORIGIN}/`, apiLevel: 2, minClientApiLevel: 1, release: null });
  assert.equal(cache.apiLevel("https://APP.example.com"), 2);
  // One row per server, not one per spelling.
  cache.record({ origin: ORIGIN, apiLevel: 3, minClientApiLevel: 1, release: null });
  assert.equal(cache.apiLevel(`${ORIGIN}/`), 3);
});

// ── refreshing ───────────────────────────────────────────────────────

test("a failed refresh keeps what was known", async () => {
  const answers: ServerCheck[] = [
    answered(2),
    { ok: false, reason: "unreachable" },
    { ok: false, reason: "not-a-server" },
  ];
  let calls = 0;
  const cache = createServerLevelCache({
    check: async () => answers[calls++] ?? { ok: false, reason: "unreachable" },
  });

  await cache.refresh(ORIGIN);
  assert.equal(cache.apiLevel(ORIGIN), 2);
  assert.equal(cache.apiLevel("https://other.example.com"), null);

  await cache.refresh(ORIGIN);
  assert.equal(cache.apiLevel(ORIGIN), 2, "an unreachable server has not changed its level");
  await cache.refresh(ORIGIN);
  assert.equal(cache.apiLevel(ORIGIN), 2, "neither has one behind a proxy");
});

test("concurrent refreshes share one request and notify subscribers once", async () => {
  let calls = 0;
  const cache = createServerLevelCache({
    check: async () => {
      calls += 1;
      return answered(2);
    },
  });
  let notified = 0;
  cache.subscribe(() => {
    notified += 1;
  });

  await Promise.all([cache.refresh(ORIGIN), cache.refresh(ORIGIN), cache.refresh(ORIGIN)]);
  assert.equal(calls, 1, "every surface refreshes on the same triggers — one request");
  assert.equal(notified, 1);

  // The sharing lasts for one flight, not forever.
  await cache.refresh(ORIGIN);
  assert.equal(calls, 2);
});

// ── a refusal a health read never saw ────────────────────────────────

test("noteClientTooOld reports CLIENT_TOO_OLD until a health read clears it", async () => {
  const cache = createServerLevelCache({ check: async () => answered(API_LEVEL) });
  cache.noteClientTooOld(ORIGIN);

  assert.equal(cache.compatibility(ORIGIN), CLIENT_TOO_OLD);
  const level = cache.get(ORIGIN);
  assert.ok(level);
  // A server that refuses by level has the handshake, so it is at least 1.
  assert.equal(level.apiLevel, 1);
  // No health read happened, and the epoch says so, so a throttled refresh asks
  // at once instead of sitting on a refusal it has never verified.
  assert.equal(level.checkedAt, new Date(0).toISOString());

  await cache.refresh(ORIGIN);
  assert.equal(cache.compatibility(ORIGIN), null);
  assert.equal(cache.get(ORIGIN)?.clientTooOld, false);
});

// ── persistence ──────────────────────────────────────────────────────

test("hydrate restores the stored copy, and garbage is a miss", async () => {
  const storage = memoryStorage();
  const first = createServerLevelCache({ storage, check: async () => answered(2) });
  await first.refresh(ORIGIN);
  // The write is fire-and-forget; let it land.
  await new Promise((resolve) => setTimeout(resolve, 0));

  const second = createServerLevelCache({ storage });
  assert.equal(second.apiLevel(ORIGIN), null, "nothing is known before hydrate");
  await second.hydrate();
  assert.equal(second.apiLevel(ORIGIN), 2);
  // Idempotent: a second call reads nothing again.
  await second.hydrate();
  assert.equal(second.apiLevel(ORIGIN), 2);

  await storage.setItem(SERVER_LEVELS_STORAGE_KEY, "garbage");
  const third = createServerLevelCache({ storage });
  await third.hydrate();
  assert.equal(third.apiLevel(ORIGIN), null, "an undecodable store is a miss, not a throw");
});

test("anything learned while the store was being read wins over the stored copy", async () => {
  const seed = memoryStorage();
  const seeding = createServerLevelCache({ storage: seed, check: async () => answered(1) });
  await seeding.refresh(ORIGIN);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stored = await seed.getItem(SERVER_LEVELS_STORAGE_KEY);
  assert.ok(stored);

  // A store slow enough that the race is the normal case rather than a theory.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: KeyValueStorage = {
    getItem: async () => {
      await held;
      return stored;
    },
    setItem: async () => undefined,
    removeItem: async () => undefined,
  };

  const cache = createServerLevelCache({ storage: slow });
  const hydrating = cache.hydrate();
  // Learned from the network while the read was in flight: newer by definition.
  cache.record({ origin: ORIGIN, apiLevel: 9, minClientApiLevel: 1, release: "9.0.0" });
  release();
  await hydrating;

  assert.equal(cache.apiLevel(ORIGIN), 9, "the stored copy overwrote a fresher answer");
});

// ── the two directions of skew ───────────────────────────────────────

test("serverCompatibility names the side that is too old", () => {
  assert.equal(MIN_SERVER_API_LEVEL, 1);
  assert.equal(serverCompatibility({ apiLevel: 0, minClientApiLevel: null }), SERVER_TOO_OLD);
  assert.equal(serverCompatibility({ apiLevel: API_LEVEL, minClientApiLevel: 1 }), null);
  assert.equal(
    serverCompatibility({ apiLevel: API_LEVEL + 5, minClientApiLevel: API_LEVEL + 1 }),
    CLIENT_TOO_OLD,
  );
  // A client raising its own floor refuses a server that used to be fine.
  assert.equal(
    serverCompatibility({ apiLevel: 4, minClientApiLevel: null, minServerApiLevel: 5 }),
    SERVER_TOO_OLD,
  );
  // A server that says nothing about a floor serves every client.
  assert.equal(serverCompatibility({ apiLevel: 1, minClientApiLevel: null }), null);
});

test("every server-too-old banner sends a person to one place", () => {
  assert.equal(SERVER_UPGRADE_DOCS_PATH, "/docs/self-hosting#upgrading");
});
