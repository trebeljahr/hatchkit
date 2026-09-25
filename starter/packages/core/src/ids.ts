let counter = 0;

/**
 * UUID-ish identifier that works in every host this package targets. Prefers
 * `crypto.randomUUID`, falls back to a time+counter+random string so older
 * WebViews and Node builds without webcrypto still get unique ids.
 */
export const createId = (): string => {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  counter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `id-${Date.now().toString(36)}-${counter.toString(36)}-${random}`;
};

/**
 * The device's IANA zone, e.g. "Europe/Berlin".
 *
 * Read on demand and stable for a session. Anything recorded from this device
 * can be stamped with it so a wall-clock time reads the same wherever the row
 * is later opened. Falls back to UTC where the runtime cannot say.
 */
export const deviceTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};
