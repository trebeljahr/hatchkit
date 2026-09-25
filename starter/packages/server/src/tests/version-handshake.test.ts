/**
 * The version handshake, server side (docs/versioning.md).
 *
 * Four claims, each of which fails without an error anywhere:
 *
 *  - What a request DECLARES is read the same off a Fetch `Headers` and off
 *    Node's plain header object, and garbage is read as "declared nothing"
 *    rather than as level 0.
 *  - A request declaring a level below the floor is refused; one declaring a
 *    level at or above it is served.
 *  - A request that declares NOTHING is always served. It is a client from
 *    before the handshake, and the floor exists to refuse clients that can say
 *    how old they are — never to lock out ones that cannot.
 *  - The refusal status is 412, and 412 is NOT in the offline queue's permanent
 *    set. That last one is the rule that keeps version skew from deleting work
 *    somebody already did: a permanent status makes the queue DROP the row, so
 *    a floor served as 400 or 422 would quietly delete a person's offline
 *    edits the first time they opened an old build against a new server.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  API_LEVEL,
  API_LEVEL_HEADER,
  CLIENT_ID_HEADER,
  CLIENT_TOO_OLD,
  CLIENT_VERSION_HEADER,
  MIN_CLIENT_API_LEVEL,
  VERSION_REFUSAL_HTTP_STATUS,
  compareVersions,
  parseApiLevel,
  parseClientVersion,
  versionHeaders,
} from "@starter/shared";
import { isPermanentRejectionStatus } from "@starter/core";

import {
  CLIENT_TOO_OLD_MESSAGE,
  declaredClient,
  parseDeclaredClientLabel,
  versionRefusalFor,
} from "../auth/client-version.js";

// ── what a request declares ──────────────────────────────────────────

test("declaredClient reads Node's header object and a Fetch Headers alike", () => {
  assert.deepEqual(
    declaredClient({ [CLIENT_VERSION_HEADER]: "0.2.0", [API_LEVEL_HEADER]: "1" }),
    { clientVersion: "0.2.0", apiLevel: 1 },
  );
  assert.deepEqual(
    declaredClient(new Headers({ [CLIENT_VERSION_HEADER]: "0.2.0", [API_LEVEL_HEADER]: "1" })),
    { clientVersion: "0.2.0", apiLevel: 1 },
  );
  // Node hands a repeated header over as an array; the first value wins.
  assert.deepEqual(declaredClient({ [API_LEVEL_HEADER]: ["2", "9"] }), {
    clientVersion: null,
    apiLevel: 2,
  });
});

test("declaredClient reads a missing header, and a missing source, as nothing", () => {
  assert.deepEqual(declaredClient({}), { clientVersion: null, apiLevel: null });
  assert.deepEqual(declaredClient(new Headers()), { clientVersion: null, apiLevel: null });
  assert.deepEqual(declaredClient(undefined), { clientVersion: null, apiLevel: null });
  assert.deepEqual(declaredClient(null), { clientVersion: null, apiLevel: null });
});

test("declaredClient treats a malformed level as legacy, not as level 0", () => {
  // null, not 0. A proxy that mangles a header must not be able to get a
  // working client refused — see `versionRefusalFor`.
  assert.equal(declaredClient({ [API_LEVEL_HEADER]: "two" }).apiLevel, null);
  assert.equal(declaredClient({ [API_LEVEL_HEADER]: "-1" }).apiLevel, null);
  assert.equal(declaredClient({ [API_LEVEL_HEADER]: "" }).apiLevel, null);
  // A real "0" is a different thing: a peer released before the handshake that
  // says so, which the floor may refuse.
  assert.equal(declaredClient({ [API_LEVEL_HEADER]: "0" }).apiLevel, 0);
});

test("declaredClient drops an over-long version rather than storing it", () => {
  const overlong = `1.2.3-${"x".repeat(80)}`;
  assert.equal(declaredClient({ [CLIENT_VERSION_HEADER]: overlong }).clientVersion, null);
  assert.equal(declaredClient({ [CLIENT_VERSION_HEADER]: "latest" }).clientVersion, null);
  assert.equal(declaredClient({ [CLIENT_VERSION_HEADER]: "1.0.0-rc.2" }).clientVersion, "1.0.0-rc.2");
});

// ── the floor ────────────────────────────────────────────────────────

test("versionRefusalFor refuses a declared level below the floor", () => {
  assert.equal(versionRefusalFor({ [API_LEVEL_HEADER]: "0" }, 1), CLIENT_TOO_OLD);
  assert.equal(versionRefusalFor({ [API_LEVEL_HEADER]: "2" }, 3), CLIENT_TOO_OLD);
  assert.equal(versionRefusalFor(new Headers({ [API_LEVEL_HEADER]: "1" }), 4), CLIENT_TOO_OLD);
});

test("versionRefusalFor serves a declared level at or above the floor", () => {
  assert.equal(versionRefusalFor({ [API_LEVEL_HEADER]: "3" }, 3), null);
  assert.equal(versionRefusalFor({ [API_LEVEL_HEADER]: "4" }, 3), null);
  // The level this build declares is, by construction, served by this build.
  assert.equal(versionRefusalFor({ [API_LEVEL_HEADER]: String(API_LEVEL) }), null);
  assert.ok(MIN_CLIENT_API_LEVEL <= API_LEVEL);
});

test("versionRefusalFor ALWAYS serves a request that declares nothing", () => {
  // However high the floor is raised. Raising it never locks a pre-handshake
  // client out silently; that would need a separate, deliberate decision.
  assert.equal(versionRefusalFor({}, 99), null);
  assert.equal(versionRefusalFor(new Headers(), 99), null);
  assert.equal(versionRefusalFor(undefined, 99), null);
  // An unreadable level is a missing one.
  assert.equal(versionRefusalFor({ [API_LEVEL_HEADER]: "not-a-number" }, 99), null);
  // A client label alone is not a declared level: the handshake ignores it.
  assert.equal(versionRefusalFor({ [CLIENT_ID_HEADER]: "web" }, 99), null);
});

test("the refusal message says nothing was deleted", () => {
  // The one sentence a refused client shows. It has to answer "did I just lose
  // my work" before anything else, because that is what a person asks when an
  // app stops syncing.
  assert.match(CLIENT_TOO_OLD_MESSAGE, /Update the app/);
  assert.match(CLIENT_TOO_OLD_MESSAGE, /nothing stored on this device has been deleted/);
});

// ── the parsers the floor is built on ────────────────────────────────

test("parseApiLevel accepts a level and rejects everything else", () => {
  assert.equal(parseApiLevel("3"), 3);
  assert.equal(parseApiLevel("0"), 0);
  assert.equal(parseApiLevel(" 7 "), 7);
  assert.equal(parseApiLevel(2), 2);
  assert.equal(parseApiLevel("-1"), null);
  assert.equal(parseApiLevel("1.5"), null);
  assert.equal(parseApiLevel("two"), null);
  assert.equal(parseApiLevel(undefined), null);
});

test("parseClientVersion keeps a release string and rejects noise", () => {
  assert.equal(parseClientVersion("0.3.1"), "0.3.1");
  assert.equal(parseClientVersion("1.0.0-rc.2"), "1.0.0-rc.2");
  assert.equal(parseClientVersion("1.0.0+build.7"), "1.0.0+build.7");
  assert.equal(parseClientVersion("latest"), null);
  assert.equal(parseClientVersion(""), null);
  assert.equal(parseClientVersion("1.2.3".padEnd(80, "0")), null);
  assert.equal(parseClientVersion(42), null);
});

test("compareVersions orders releases numerically, a prerelease before its release", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  // The one that a lexical sort gets wrong: an rc is OLDER than its release.
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  // Unparseable input compares equal to anything, so it never wins a decision.
  assert.equal(compareVersions("junk", "1.0.0"), 0);
});

// ── the headers a client sends ───────────────────────────────────────

test("versionHeaders always carries the level, the version only when parseable", () => {
  assert.deepEqual(versionHeaders("0.3.1"), {
    [API_LEVEL_HEADER]: String(API_LEVEL),
    [CLIENT_VERSION_HEADER]: "0.3.1",
  });
  // The level is the half the floor reads, so it is never omitted.
  assert.deepEqual(versionHeaders(null), { [API_LEVEL_HEADER]: String(API_LEVEL) });
  assert.deepEqual(versionHeaders(undefined), { [API_LEVEL_HEADER]: String(API_LEVEL) });
  assert.deepEqual(versionHeaders("nightly"), { [API_LEVEL_HEADER]: String(API_LEVEL) });
});

test("the client label is read separately and is never a level", () => {
  assert.equal(parseDeclaredClientLabel({ [CLIENT_ID_HEADER]: "web" }), "web");
  assert.equal(parseDeclaredClientLabel(new Headers({ [CLIENT_ID_HEADER]: " web " })), "web");
  assert.equal(parseDeclaredClientLabel({}), null);
  assert.equal(parseDeclaredClientLabel({ [CLIENT_ID_HEADER]: "a".repeat(64) }), null);
  assert.equal(parseDeclaredClientLabel({ [CLIENT_ID_HEADER]: "<script>" }), null);
  // Reading the label tells the handshake nothing, in either direction.
  assert.equal(declaredClient({ [CLIENT_ID_HEADER]: "web" }).apiLevel, null);
});

// ── the status, and the rule that depends on it ──────────────────────

test("a version refusal is a 412", () => {
  assert.equal(VERSION_REFUSAL_HTTP_STATUS, 412);
});

test("412 is NOT permanent, so version skew never deletes queued work", () => {
  // The whole reason the floor answers 412. The offline queue drops a row on a
  // permanent rejection status, so if this assertion ever flips, an old client
  // meeting a new server loses every mutation it had queued — silently, with
  // no error the person ever sees.
  assert.equal(
    isPermanentRejectionStatus("PRECONDITION_FAILED", VERSION_REFUSAL_HTTP_STATUS),
    false,
  );
  // The statuses that ARE permanent, for contrast: a 412 must not join them.
  for (const status of [400, 403, 404, 409, 410, 422]) {
    assert.equal(isPermanentRejectionStatus("BAD_REQUEST", status), true, `${status} is permanent`);
    assert.notEqual(status, VERSION_REFUSAL_HTTP_STATUS);
  }
});
