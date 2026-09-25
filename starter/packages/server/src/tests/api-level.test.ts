/**
 * The API level table (`packages/shared/src/api-level.ts`).
 *
 * The table is the only written record of what a peer at a given level can rely
 * on, and every failure it has is a quiet one:
 *
 *  - A level bumped without a row leaves a client unable to find out what it
 *    gained, so the next author writes the gate against a guessed number.
 *  - A gap or a repeat in the levels breaks the one property every comparison
 *    in the handshake assumes — that a level is an ordinal, so "at least 3"
 *    means "has everything 1, 2 and 3 added".
 *  - A floor above `API_LEVEL` refuses every client there is, including the one
 *    shipped from this very commit, which reads to a person as "the server is
 *    down".
 *  - A `Capability` gated above `API_LEVEL` is a feature the client hides on a
 *    server that in fact has it, forever, with nothing logged anywhere.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  API_LEVEL,
  API_LEVEL_CHANGES,
  MIN_CLIENT_API_LEVEL,
  serverSupports,
  type Capability,
} from "@starter/shared";

test("API_LEVEL_CHANGES is not empty", () => {
  // Level 0 is not a row — it is every peer released before the handshake
  // existed — so the table starts at 1 and always has at least that.
  assert.ok(API_LEVEL_CHANGES.length > 0);
});

test("its levels are 1..n, strictly increasing, with no gaps", () => {
  API_LEVEL_CHANGES.forEach((change, index) => {
    assert.equal(change.level, index + 1, `row ${index} is level ${index + 1}`);
  });
  for (let index = 1; index < API_LEVEL_CHANGES.length; index += 1) {
    const previous = API_LEVEL_CHANGES[index - 1]!.level;
    const current = API_LEVEL_CHANGES[index]!.level;
    assert.ok(current > previous, `level ${current} follows ${previous}`);
  }
});

test("its last row is the level this build declares", () => {
  assert.equal(API_LEVEL_CHANGES.at(-1)?.level, API_LEVEL);
});

test("every row names what it added, and the release it shipped in", () => {
  for (const change of API_LEVEL_CHANGES) {
    assert.ok(change.added.length > 0, `level ${change.level} names what it added`);
    for (const added of change.added) {
      assert.notEqual(added.trim(), "", `level ${change.level} has no empty entries`);
    }
    assert.notEqual(change.release.trim(), "", `level ${change.level} names a release`);
  }
});

test("the floor is a real level this server could serve", () => {
  assert.ok(MIN_CLIENT_API_LEVEL >= 1, "a floor of 0 refuses nothing and means nothing");
  assert.ok(
    MIN_CLIENT_API_LEVEL <= API_LEVEL,
    "a floor above API_LEVEL refuses the client shipped from this commit",
  );
});

/**
 * Every capability, as a record so `tsc` fails when one is added to the
 * `Capability` union and not listed here — a list this test builds by hand is a
 * list that goes stale the first time somebody is in a hurry.
 */
const ALL_CAPABILITIES: Readonly<Record<Capability, true>> = {
  "sync.feed": true,
  "items.update": true,
};

test("every capability is gated at a level this server has", () => {
  const capabilities = Object.keys(ALL_CAPABILITIES) as Capability[];
  assert.ok(capabilities.length > 0);
  for (const capability of capabilities) {
    assert.equal(
      serverSupports(capability, API_LEVEL),
      true,
      `${capability} is gated above API_LEVEL, so this server hides its own feature`,
    );
    // And the gate is a real level: a capability every level 0 peer has is a
    // capability that needed no gate.
    assert.equal(
      serverSupports(capability, 0),
      false,
      `${capability} claims a server from before the handshake has it`,
    );
  }
});

test("a server that has not answered yet is treated optimistically", () => {
  // `null` is "nobody asked", not "no". Treating unknown as no hides a working
  // feature behind a health read that has not landed — and it never recovers if
  // the read fails, because the gate is checked on render.
  for (const capability of Object.keys(ALL_CAPABILITIES) as Capability[]) {
    assert.equal(serverSupports(capability, null), true);
  }
});
