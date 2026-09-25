/*
 * The hand-over is a one-shot, irreversible data move: it deletes the web copy.
 * These tests pin the three rules that keep it safe to interrupt, because a
 * regression here is not a failed test in production — it is a user opening
 * the app to find their content gone, with nothing logged.
 *
 * No jsdom, no Capacitor: every backend is injected. See the note on
 * `createDurableStorage` — the injection point exists for exactly this.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  HANDOVER_MARKER_KEY,
  createDurableStorage,
  handOverLegacyWebStorage,
  type DurableStorage,
  type PreferenceBackend,
  type WebStorageLike,
} from "./preferences-storage";

/** In-memory stand-in for UserDefaults / SharedPreferences. */
function fakeBackend(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  const backend: PreferenceBackend = {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
    async keys() {
      return [...map.keys()];
    },
  };
  return { backend, map };
}

/** In-memory stand-in for localStorage. */
function fakeWeb(seed: Record<string, string> = {}): WebStorageLike & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

describe("createDurableStorage", () => {
  it("reads and writes through the injected backend", async () => {
    const { backend, map } = fakeBackend();
    const storage = createDurableStorage(async () => backend);

    await storage.set("a", "1");
    expect(await storage.get("a")).toBe("1");
    expect(await storage.keys()).toEqual(["a"]);

    await storage.remove("a");
    expect(await storage.get("a")).toBeNull();
    expect(map.size).toBe(0);
  });

  it("resolves the backend once, not per call", async () => {
    const { backend } = fakeBackend();
    let loads = 0;
    const storage = createDurableStorage(async () => {
      loads += 1;
      return backend;
    });

    await Promise.all([storage.get("a"), storage.get("b"), storage.set("c", "3")]);
    expect(loads).toBe(1);
  });

  it("falls back to a working store when the native loader throws", async () => {
    // A missing plugin must not turn every preference read into a rejection.
    const storage = createDurableStorage(async () => {
      throw new Error("plugin not installed");
    });
    await expect(storage.get("anything")).resolves.toBeNull();
  });
});

describe("handOverLegacyWebStorage", () => {
  let durable: DurableStorage;
  let backendMap: Map<string, string>;

  beforeEach(() => {
    const f = fakeBackend();
    backendMap = f.map;
    durable = createDurableStorage(async () => f.backend);
  });

  it("moves legacy web-storage values into the preference store once", async () => {
    const web = fakeWeb({ draft: "hello", progress: "42", unrelated: "x" });

    const result = await handOverLegacyWebStorage(["draft", "progress"], {
      durable,
      web,
    });

    expect(result.completed).toBe(true);
    expect(result.moved.sort()).toEqual(["draft", "progress"]);
    expect(backendMap.get("draft")).toBe("hello");
    expect(backendMap.get("progress")).toBe("42");
    // Web copies are gone for the migrated keys only.
    expect(web.map.has("draft")).toBe(false);
    expect(web.map.has("progress")).toBe(false);
    expect(web.map.get("unrelated")).toBe("x");
    // Rule 3: marker recorded, and recorded in the DURABLE store.
    expect(backendMap.has(HANDOVER_MARKER_KEY)).toBe(true);
  });

  it("is a no-op on re-run", async () => {
    const web = fakeWeb({ draft: "hello" });
    await handOverLegacyWebStorage(["draft"], { durable, web });

    // Simulate a later build writing a fresh web-storage value under the same
    // key. The migration has already run; it must not fire again and clobber
    // the durable copy with whatever is lying around in localStorage.
    web.map.set("draft", "stale-rewrite");

    const second = await handOverLegacyWebStorage(["draft"], { durable, web });

    expect(second.completed).toBe(true);
    expect(second.moved).toEqual([]);
    expect(backendMap.get("draft")).toBe("hello");
    expect(web.map.get("draft")).toBe("stale-rewrite");
  });

  it("never overwrites a key the preference store already holds", async () => {
    // Rule 1. The durable value is newer by definition: it was written by the
    // build that reads the durable store. Losing it rolls the user back.
    backendMap.set("draft", "durable-wins");
    const web = fakeWeb({ draft: "stale-web-copy" });

    const result = await handOverLegacyWebStorage(["draft"], { durable, web });

    expect(result.completed).toBe(true);
    expect(result.moved).toEqual([]);
    expect(result.skipped).toEqual(["draft"]);
    expect(backendMap.get("draft")).toBe("durable-wins");
    // Skipped, so the web copy is left alone rather than deleted.
    expect(web.map.get("draft")).toBe("stale-web-copy");
  });

  it("leaves the web copy intact and the marker unset when a durable write fails", async () => {
    // Rule 2 and rule 3 together. A bridge failure must be retryable on the
    // next launch, which means the data must still be where the old build
    // put it and the marker must not claim the pass is done.
    const failing: DurableStorage = {
      async get() {
        return null;
      },
      async set() {
        throw new Error("bridge unavailable");
      },
      async remove() {},
      async keys() {
        return [];
      },
    };
    const web = fakeWeb({ draft: "hello" });

    const result = await handOverLegacyWebStorage(["draft"], {
      durable: failing,
      web,
    });

    expect(result.completed).toBe(false);
    expect(result.moved).toEqual([]);
    expect(web.map.get("draft")).toBe("hello");
  });

  it("stops at the first failure instead of deleting later keys", async () => {
    let calls = 0;
    const flaky: DurableStorage = {
      async get() {
        return null;
      },
      async set() {
        calls += 1;
        if (calls === 2) throw new Error("bridge unavailable");
      },
      async remove() {},
      async keys() {
        return [];
      },
    };
    const web = fakeWeb({ a: "1", b: "2", c: "3" });

    const result = await handOverLegacyWebStorage(["a", "b", "c"], {
      durable: flaky,
      web,
    });

    expect(result.completed).toBe(false);
    expect(result.moved).toEqual(["a"]);
    // `c` was never touched, so its web copy is still the only copy.
    expect(web.map.get("c")).toBe("3");
  });
});
