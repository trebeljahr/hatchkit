/*
 * The version constant is hand-kept: a package that is run from a file path
 * rather than installed from a registry has no build-time define to read one
 * from, and nothing else in the pipeline compares the two. A host that reports
 * the wrong version turns a fixed bug into an unreproducible one.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SERVER_NAME, SERVER_VERSION } from "../identity.js";

const packageJson = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
    "utf-8",
  ),
) as { version: string; bin: Record<string, string> };

describe("identity", () => {
  it("keeps the announced version in step with the package", () => {
    assert.equal(SERVER_VERSION, packageJson.version);
  });

  it("keeps the binary name in step with the announced name", () => {
    // Both are written into every user's host configuration file. They are one
    // identifier with two spellings, and a rename of either orphans every
    // configuration that already names it.
    assert.deepEqual(Object.keys(packageJson.bin), [SERVER_NAME]);
  });
});
