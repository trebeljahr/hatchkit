import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeVersioned,
  decodeVersionedValue,
  encodeVersioned,
  versioned,
  type VersionedSpec,
} from "../versioned-storage.js";

type Point = { x: number };

const readPoint = (value: unknown): Point | null => {
  if (typeof value !== "object" || value === null) return null;
  const { x } = value as { x?: unknown };
  return typeof x === "number" ? { x } : null;
};

const spec: VersionedSpec<Point> = {
  version: 2,
  decode: readPoint,
  legacy: (value) => readPoint(value),
  older: {
    1: (data) => (typeof data === "number" ? { x: data } : null),
  },
};

test("the envelope is the shape it says it is", () => {
  assert.deepEqual(versioned(2, { x: 3 }), { v: 2, data: { x: 3 } });
  assert.equal(encodeVersioned(2, { x: 3 }), JSON.stringify({ v: 2, data: { x: 3 } }));
});

test("round trips the current version", () => {
  const raw = encodeVersioned(2, { x: 3 });
  assert.deepEqual(JSON.parse(raw), { v: 2, data: { x: 3 } });
  assert.deepEqual(decodeVersioned(raw, spec), { x: 3 });
});

test("reads a legacy unversioned value through the legacy decoder", () => {
  // Keys are contracts and are never renamed, so the same key holds both shapes
  // for as long as an old install can still be updated.
  assert.deepEqual(decodeVersioned(JSON.stringify({ x: 5 }), spec), { x: 5 });
  const withoutLegacy: VersionedSpec<Point> = { version: 2, decode: readPoint };
  assert.equal(decodeVersioned(JSON.stringify({ x: 5 }), withoutLegacy), null);
});

test("reads an older version only through its own reader", () => {
  assert.deepEqual(decodeVersioned(encodeVersioned(1, 9), spec), { x: 9 });
  const noOlder: VersionedSpec<Point> = { version: 2, decode: readPoint };
  assert.equal(decodeVersioned(encodeVersioned(1, 9), noOlder), null);
});

test("a higher version is a miss, even when its data looks readable", () => {
  // A newer build wrote it and this one cannot know what the fields mean now.
  assert.equal(decodeVersioned(encodeVersioned(3, { x: 1 }), spec), null);
});

test("garbage is a miss", () => {
  for (const raw of [null, undefined, "", "{nope", "42", "null", "[]", '"x"']) {
    assert.equal(decodeVersioned(raw, spec), null, String(raw));
  }
  assert.equal(decodeVersioned(encodeVersioned(2, { x: "1" }), spec), null);
  assert.equal(
    decodeVersioned(JSON.stringify({ v: "2", data: { x: 1 } }), spec),
    null,
  );
  assert.equal(
    decodeVersioned(JSON.stringify({ v: 0, data: { x: 1 } }), spec),
    null,
  );
  assert.equal(decodeVersionedValue(null, spec), null);
  assert.equal(decodeVersionedValue(undefined, spec), null);
});

test("never throws, whatever the decoders do", () => {
  // A store that cannot be read must never take down the surface that was only
  // trying to paint faster.
  const throwing: VersionedSpec<Point> = {
    version: 1,
    decode: () => {
      throw new Error("decode");
    },
    legacy: () => {
      throw new Error("legacy");
    },
  };
  assert.equal(decodeVersioned(encodeVersioned(1, {}), throwing), null);
  assert.equal(decodeVersioned("{}", throwing), null);
  assert.equal(decodeVersionedValue(undefined, throwing), null);
});
