import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { assertKeychainAccess, createKeychainQueue } from "./src/utils/keychain-access.js";
import {
  clearAllSecrets,
  deleteSecret,
  getSecret,
  migrateProjectSecrets,
  setSecret,
} from "./src/utils/secrets.js";

assert.ok(process.env.HATCHKIT_TEST_KEYCHAIN_DIR, "requires the isolated runner");
const savedMode = process.env.HATCHKIT_KEYCHAIN_ACCESS;
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
Object.defineProperty(process.stdin, "isTTY", {
  value: false,
  configurable: true,
});
try {
  Reflect.deleteProperty(process.env, "HATCHKIT_KEYCHAIN_ACCESS");
  assert.throws(assertKeychainAccess, /unattended command/);
  process.env.HATCHKIT_KEYCHAIN_ACCESS = "deny";
  await assert.rejects(getSecret("must-not-read"), /OS keychain access is disabled/);
  process.env.HATCHKIT_KEYCHAIN_ACCESS = "invalid";
  assert.throws(assertKeychainAccess, /must be allow or deny/);
} finally {
  if (savedMode === undefined) Reflect.deleteProperty(process.env, "HATCHKIT_KEYCHAIN_ACCESS");
  else process.env.HATCHKIT_KEYCHAIN_ACCESS = savedMode;
  if (ttyDescriptor) Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
  else Reflect.deleteProperty(process.stdin, "isTTY");
}

await clearAllSecrets();
assert.equal(await getSecret("fixture"), null);
await setSecret("fixture", "test-only");
assert.equal(await getSecret("fixture"), "test-only");

// A child CLI sees the parent's fixtures, but still cannot load native keytar.
const child = execFileSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
  import keytar from 'keytar';
  import assert from 'node:assert/strict';
  assert.equal(await keytar.getPassword('hatchkit', 'fixture'), 'test-only');
  await keytar.setPassword('hatchkit', 'from-child', 'fixture-value');
  console.log('fixture child passed');
`,
  ],
  { encoding: "utf8" },
);
assert.match(child, /fixture child passed/);
assert.equal(await getSecret("from-child"), "fixture-value");

// require() must be redirected too; a CJS caller must not escape the fake.
const require = createRequire(import.meta.url);
const cjsStore = require("keytar").default;
assert.equal(await cjsStore.getPassword("hatchkit", "fixture"), "test-only");
assert.ok(!Object.keys(require.cache).some((path) => /keytar.*\.node$/.test(path)));
assert.throws(
  () => execFileSync("/usr/bin/security", ["find-generic-password"]),
  /Tests cannot invoke/,
);

await setSecret("dotenvx:old:production-private-key", "fixture-key");
await setSecret("dotenvx:other:production-private-key", "other-fixture");
const migrated = await migrateProjectSecrets("old", "new");
assert.equal(migrated.moved.length, 1);
assert.equal(await getSecret("dotenvx:old:production-private-key"), null);
assert.equal(await getSecret("dotenvx:new:production-private-key"), "fixture-key");
assert.equal(await getSecret("dotenvx:other:production-private-key"), "other-fixture");
assert.equal(await deleteSecret("fixture"), true);
assert.equal(await deleteSecret("fixture"), false);
await clearAllSecrets();
assert.equal(await getSecret("from-child"), null);

let backendCalls = 0;
const deniedQueue = createKeychainQueue(() => {});
const rejected = await Promise.allSettled(
  Array.from({ length: 30 }, () =>
    deniedQueue(async () => {
      backendCalls++;
      throw new Error("Access denied by fixture");
    }),
  ),
);
assert.equal(backendCalls, 1, "one denial stops every queued backend call");
assert.equal(rejected.filter((item) => item.status === "rejected").length, 30);

let active = 0;
let maxActive = 0;
const queue = createKeychainQueue(() => {});
await Promise.all(
  Array.from({ length: 10 }, () =>
    queue(async () => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
    }),
  ),
);
assert.equal(maxActive, 1, "keychain calls never run concurrently");

// Drop the preload deliberately: source must still refuse unattended access
// before loading keytar, even when the service/config names look like tests.
const unwrapped = execFileSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `
  import assert from 'node:assert/strict';
  import { getSecret } from './src/utils/secrets.ts';
  await assert.rejects(getSecret('must-not-read'), /Test fixture store is not loaded/);
  console.log('unwrapped access refused');
`,
  ],
  {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", HATCHKIT_KEYCHAIN_ACCESS: "allow" },
  },
);
assert.match(unwrapped, /unwrapped access refused/);

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
for (const [name, command] of Object.entries<string>(pkg.scripts)) {
  if (name === "test" || name.startsWith("test:")) {
    assert.match(
      command,
      /^node scripts\/test\.mjs(?: test-[\w-]+\.ts)*$/,
      `${name} must use fixture credentials for every test`,
    );
  }
}
console.log("Keychain isolation checks passed (no OS credential access).");
