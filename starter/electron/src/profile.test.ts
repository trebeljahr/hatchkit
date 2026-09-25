import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  HEADLESS_PROFILE_SUFFIX,
  PACKAGED_PROFILE_NAME,
  UNPACKAGED_PROFILE_NAME,
  userDataDir,
} from "./profile.ts";

describe("userDataDir", () => {
  const appData = path.resolve("/Users/x/Library/Application Support");

  it("pins the packaged profile to a name of its own, not to package.json", () => {
    assert.equal(
      userDataDir({ appData, isPackaged: true }),
      path.join(appData, PACKAGED_PROFILE_NAME),
    );
  });

  it("keeps an unpackaged run out of the installed app's profile and lock", () => {
    assert.notEqual(UNPACKAGED_PROFILE_NAME, PACKAGED_PROFILE_NAME);
    assert.equal(
      userDataDir({ appData, isPackaged: false }),
      path.join(appData, UNPACKAGED_PROFILE_NAME),
    );
  });

  it("honours an explicit override either way, and ignores an empty one", () => {
    for (const isPackaged of [true, false]) {
      assert.equal(
        userDataDir({ appData, isPackaged, override: "/tmp/p" }),
        path.resolve("/tmp/p"),
      );
    }
    assert.equal(
      userDataDir({ appData, isPackaged: true, override: "" }),
      path.join(appData, PACKAGED_PROFILE_NAME),
    );
  });

  it("resolves a relative override against the working directory", () => {
    assert.equal(
      userDataDir({ appData, isPackaged: true, override: "tmp/profile" }),
      path.resolve("tmp/profile"),
    );
  });

  it("never lets a headless run open the installed app's profile", () => {
    // A headless launch runs on the mock keychain (secure-store.ts), where the
    // installed app's token file does not decrypt — and the store deletes a
    // ciphertext it cannot decrypt, which signs that person out.
    assert.equal(
      userDataDir({ appData, isPackaged: true, headless: true }),
      path.join(appData, `${PACKAGED_PROFILE_NAME}${HEADLESS_PROFILE_SUFFIX}`),
    );
    assert.equal(
      userDataDir({ appData, isPackaged: false, headless: true }),
      path.join(appData, `${UNPACKAGED_PROFILE_NAME}${HEADLESS_PROFILE_SUFFIX}`),
    );
  });

  it("lets the e2e harness name the headless profile itself", () => {
    assert.equal(
      userDataDir({ appData, isPackaged: true, headless: true, override: "/tmp/p" }),
      path.resolve("/tmp/p"),
    );
  });
});
