/** Secret-store backends: env overrides, the opt-in file store, and the
 *  per-platform error hints. Fixture keychain only; no OS store. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAllSecrets,
  deleteSecret,
  describeKeychainError,
  getSecret,
  migrateProjectSecrets,
  secretEnvName,
  secretStoreKind,
  setSecret,
} from "./src/utils/secrets.js";

assert.ok(process.env.HATCHKIT_TEST_KEYCHAIN_DIR, "requires the isolated runner");

function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  return run().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  });
}

// Env names: one per account, stable, shell-safe.
assert.equal(secretEnvName("coolify:token"), "HATCHKIT_SECRET_COOLIFY_TOKEN");
assert.equal(secretEnvName("s3:hetzner:secret-key"), "HATCHKIT_SECRET_S3_HETZNER_SECRET_KEY");
assert.equal(
  secretEnvName("stripe:project:my.app:live:secret-key"),
  "HATCHKIT_SECRET_STRIPE_PROJECT_MY_APP_LIVE_SECRET_KEY",
);

// Store selection.
assert.equal(secretStoreKind({}), "os");
assert.equal(secretStoreKind({ HATCHKIT_SECRET_STORE: "os" }), "os");
assert.equal(secretStoreKind({ HATCHKIT_SECRET_STORE: "file" }), "file");
assert.throws(() => secretStoreKind({ HATCHKIT_SECRET_STORE: "vault" }), /must be os or file/);

// An env override answers without touching the store, so it works even
// where keychain access is denied (CI, cron, headless Linux).
await withEnv(
  { HATCHKIT_SECRET_HETZNER_TOKEN: "from-env", HATCHKIT_KEYCHAIN_ACCESS: "deny" },
  async () => {
    assert.equal(await getSecret("hetzner:token"), "from-env");
    await assert.rejects(getSecret("coolify:token"), /OS keychain access is disabled/);
  },
);
// Blank override falls through to the store.
await withEnv({ HATCHKIT_SECRET_HETZNER_TOKEN: "  " }, async () => {
  await setSecret("hetzner:token", "from-store");
  assert.equal(await getSecret("hetzner:token"), "from-store");
  await deleteSecret("hetzner:token");
});

// File store: round trip, 0600, enumeration for reset and rename.
const dir = mkdtempSync(join(tmpdir(), "hatchkit-secret-file-"));
const file = join(dir, "nested", "secrets.json");
try {
  await withEnv(
    {
      HATCHKIT_SECRET_STORE: "file",
      HATCHKIT_SECRETS_FILE: file,
      HATCHKIT_KEYCHAIN_ACCESS: "deny",
    },
    async () => {
      assert.equal(await getSecret("coolify:token"), null);
      await setSecret("coolify:token", "file-token");
      await setSecret("dotenvx:old:production-private-key", "file-key");
      assert.equal(await getSecret("coolify:token"), "file-token");
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
      const onDisk = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(onDisk.version, 1);
      assert.equal(onDisk.services.hatchkit["coolify:token"], "file-token");

      const migrated = await migrateProjectSecrets("old", "new");
      assert.deepEqual(migrated.moved, [
        { from: "dotenvx:old:production-private-key", to: "dotenvx:new:production-private-key" },
      ]);
      assert.equal(await getSecret("dotenvx:new:production-private-key"), "file-key");

      assert.equal(await deleteSecret("coolify:token"), true);
      assert.equal(await deleteSecret("coolify:token"), false);
      await clearAllSecrets();
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).services, {});
    },
  );
  // The file store never wrote to the fixture keychain.
  assert.equal(await getSecret("dotenvx:new:production-private-key"), null);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// Platform hints.
const linux = describeKeychainError(
  "read",
  "coolify:token",
  new Error("No such interface"),
  "linux",
);
assert.match(linux.message, /Secret Service/);
assert.match(linux.message, /HATCHKIT_SECRET_COOLIFY_TOKEN/);
assert.match(linux.message, /HATCHKIT_SECRET_STORE=file/);
assert.doesNotMatch(linux.message, /Homebrew/);
const windows = describeKeychainError("write", "k", new Error("boom"), "win32");
assert.match(windows.message, /Credential Manager/);
const mac = describeKeychainError("read", "k", new Error("boom"), "darwin");
assert.match(mac.message, /Homebrew/);
assert.doesNotMatch(mac.message, /Secret Service/);
const guarded = describeKeychainError(
  "read",
  "k",
  new Error("OS keychain access is disabled for this unattended command."),
  "linux",
);
assert.doesNotMatch(guarded.message, /Secret Service/);

console.log("Secret store checks passed (env overrides, file store, platform hints).");
