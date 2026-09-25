/*
 * Regression test for THE CENTRAL TRAP documented in native-session.ts:
 * returning a Capacitor plugin handle from an `async` function deadlocks,
 * because the handle is a Proxy that answers `then` with a callable and the
 * promise machinery adopts it as a thenable.
 *
 * This test is written so it GENUINELY FAILS against the bad version rather
 * than merely asserting a shape: the fake plugin's `then` never calls its
 * resolve or reject, so `return plugin` produces a promise that never settles,
 * and the Promise.race below times out. Do not replace the race with a plain
 * `await` — that would hang the whole suite instead of failing this one test.
 *
 * Runs in plain Node. The plugin package is never imported: the importer is
 * injected, which is the only reason that injection point exists.
 */
import { describe, expect, it } from "vitest";
import { loadSecureStorage } from "./native-session";

/**
 * Stand-in for a Capacitor plugin handle: a Proxy that answers EVERY property
 * with a callable, `then` included. `then` deliberately does nothing with its
 * arguments — that is precisely the production failure.
 */
function neverSettlingPluginHandle(): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return function then(_resolve: unknown, _reject: unknown) {
            /* the bridge has no native "then" — nothing ever answers */
          };
        }
        return async () => "value-from-bridge";
      },
    },
  );
}

const TIMEOUT_MS = 250;

async function withTimeout<T>(promise: Promise<T>): Promise<T | "TIMED_OUT"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"TIMED_OUT">((resolve) => {
    timer = setTimeout(() => resolve("TIMED_OUT"), TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe("loadSecureStorage", () => {
  it("resolves even though the plugin handle is a never-settling thenable", async () => {
    const result = await withTimeout(
      loadSecureStorage(async () => ({
        SecureStorage: neverSettlingPluginHandle(),
      })),
    );

    expect(result).not.toBe("TIMED_OUT");
  });

  it("returns a plain object, not the plugin handle", async () => {
    const store = await withTimeout(
      loadSecureStorage(async () => ({
        SecureStorage: neverSettlingPluginHandle(),
      })),
    );

    expect(store).not.toBe("TIMED_OUT");
    const api = store as { then?: unknown; get?: unknown } | null;
    // A plugin handle answers `then` with a function. A plain object does not.
    // If this is ever a function again, every caller of the boot path hangs
    // on a splash screen with no console attached.
    expect(api?.then).toBeUndefined();
    expect(typeof api?.get).toBe("function");
  });

  it("wraps the handle rather than proxying straight through", async () => {
    const store = await loadSecureStorage(async () => ({
      SecureStorage: {
        get: async () => "stored",
        set: async () => {},
        remove: async () => {},
      },
    }));

    expect(await store?.get("k")).toBe("stored");
  });

  it("resolves to null when there is no plugin", async () => {
    expect(await loadSecureStorage(async () => null)).toBeNull();
    expect(await loadSecureStorage(async () => ({}))).toBeNull();
  });

  it("resolves to null when the import itself throws", async () => {
    const result = await withTimeout(
      loadSecureStorage(async () => {
        throw new Error("plugin not installed");
      }),
    );
    expect(result).toBeNull();
  });

  it("swallows a keychain read failure instead of rejecting", async () => {
    // The keychain is unreadable while the device is locked. A rejection here
    // would surface as a boot crash rather than a signed-out app.
    const store = await loadSecureStorage(async () => ({
      SecureStorage: {
        get: async () => {
          throw new Error("errSecInteractionNotAllowed");
        },
        set: async () => {},
        remove: async () => {},
      },
    }));

    await expect(store?.get("k")).resolves.toBeNull();
  });
});
