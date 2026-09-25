/**
 * A version stamp for structured values a client persists on the device.
 *
 * Every client keeps JSON in some local store — Capacitor Preferences,
 * `chrome.storage.local`, a launcher's own store — and every one of those values
 * outlives the build that wrote it. The next build reads it, and so does the
 * previous one when a person rolls back, installs an older store build, or runs
 * a stale unpacked extension beside a new one. Without a version, a reader can
 * only guess whether a value is a shape it understands, and a wrong guess
 * becomes an `undefined.trim()` or a screen seeded from garbage.
 *
 * So a structured value is written as `{ v, data }`, and read back through a
 * spec that says which versions this build understands:
 *
 *  - `v` equal to the current version → `decode(data)`.
 *  - no envelope at all → `legacy(value)`, for values written before the
 *    envelope existed. Keys are contracts and are never renamed, so the same key
 *    holds both shapes for as long as an old install can still be updated.
 *  - an older `v` → `older[v](data)` when the spec has one, a miss otherwise.
 *  - a HIGHER `v` → a miss. A newer build wrote it and this one cannot know what
 *    the fields mean now.
 *
 * A miss is `null`, and for a cache that is the right answer: the caller
 * refetches. Nothing here ever throws — a store that cannot be read must never
 * take down the surface that was only trying to paint faster.
 *
 * NOT for user data that has no other copy (the offline queue): a value that
 * cannot be decoded there must be held, never read as a miss and overwritten.
 * See `offline-queue.ts`, which carries the same envelope and its own reader.
 */

export type VersionedValue = { v: number; data: unknown };

export type VersionedSpec<T> = {
  /** The version this build writes. A positive integer, bumped per shape change. */
  version: number;
  /** Validate `data` of the current version. Null rejects it. */
  decode: (data: unknown) => T | null;
  /**
   * Read a value written before the envelope existed. Omitted means such a
   * value is a miss.
   */
  legacy?: (value: unknown) => T | null;
  /** Readers for older envelope versions, by version. */
  older?: Readonly<Record<number, (data: unknown) => T | null>>;
};

const isEnvelope = (value: unknown): value is VersionedValue => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.v) &&
    (record.v as number) > 0 &&
    Object.prototype.hasOwnProperty.call(record, "data") &&
    Object.keys(record).length === 2
  );
};

/** The envelope for a value, as the object to store. */
export const versioned = (version: number, data: unknown): VersionedValue => ({
  v: version,
  data,
});

/** The envelope for a value, serialized. */
export const encodeVersioned = (version: number, data: unknown): string =>
  JSON.stringify(versioned(version, data));

const attempt = <T>(read: () => T | null): T | null => {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
};

/** Decode an already-parsed value. Never throws. */
export const decodeVersionedValue = <T>(
  value: unknown,
  spec: VersionedSpec<T>,
): T | null =>
  attempt(() => {
    if (value === null || value === undefined) return null;
    if (!isEnvelope(value)) {
      return spec.legacy ? spec.legacy(value) : null;
    }
    if (value.v === spec.version) return spec.decode(value.data);
    if (value.v > spec.version) return null;
    const reader = spec.older?.[value.v];
    return reader ? reader(value.data) : null;
  });

/**
 * Parse and decode a stored string. `null`, bad JSON and anything unknown are
 * a miss.
 */
export const decodeVersioned = <T>(
  raw: string | null | undefined,
  spec: VersionedSpec<T>,
): T | null =>
  attempt(() => {
    if (raw === null || raw === undefined || raw === "") return null;
    return decodeVersionedValue(JSON.parse(raw) as unknown, spec);
  });
