/** Unattended commands must not open macOS authorization dialogs. */
export function assertKeychainAccess(): void {
  if (
    process.env.HATCHKIT_TEST_KEYCHAIN_DIR &&
    (globalThis as Record<symbol, unknown>)[Symbol.for("hatchkit.test-keychain-loaded")] !== true
  ) {
    throw new Error("Test fixture store is not loaded; native keychain access refused.");
  }
  const mode = process.env.HATCHKIT_KEYCHAIN_ACCESS;
  if (mode !== undefined && mode !== "allow" && mode !== "deny") {
    throw new Error("HATCHKIT_KEYCHAIN_ACCESS must be allow or deny.");
  }
  if (mode === "deny" || (mode !== "allow" && !process.stdin.isTTY)) {
    throw new Error(
      "OS keychain access is disabled for this unattended command. " +
        "Run it in an interactive terminal, or explicitly set HATCHKIT_KEYCHAIN_ACCESS=allow " +
        "when credential access is intended. Tests must use the isolated test runner.",
    );
  }
}

/** Serialize access and stop after the first backend failure. A denied
 * request must not turn a parallel provider check into a queue of dialogs. */
export function createKeychainQueue(checkAccess: () => void = assertKeychainAccess) {
  let tail: Promise<unknown> = Promise.resolve();
  let failed = false;
  let failure: unknown;
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    checkAccess();
    const next = tail.then(async () => {
      checkAccess();
      if (failed) {
        throw new Error("Keychain access stopped after an earlier failure; no retry was made.", {
          cause: failure,
        });
      }
      try {
        return await operation();
      } catch (err) {
        failed = true;
        failure = err;
        throw err;
      }
    });
    tail = next.catch(() => {});
    return next;
  };
}
