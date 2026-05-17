/**
 * Unit tests for `hatchkit keys rotate`.
 *
 * Reproduces three coupled bugs originally observed in production:
 *   1. .env.keys accumulates stale comma-listed private keys across
 *      repeated rotations → downstream consumers forward a stale entry.
 *   2. keychain not updated to the new private key.
 *   3. Coolify + GHA secret not propagated automatically, so runtime
 *      decryption fails silently.
 *
 *  Plus Bug 4 (the false-negative "no .env.keys produced" error that
 *  triggered the accidental re-runs that caused Bug 1).
 *
 *  The dotenvx subprocess is stubbed via `_runDotenvxRotate` — we
 *  generate a fresh secp256k1 keypair in-process and mutate the env
 *  files the same way `dotenvx rotate` does (append to .env.keys,
 *  swap public key in .env.production). That lets us assert the
 *  post-rotate cleanup without needing `npx --yes` (sandbox-hostile).
 *
 *  An end-to-end test against a real Coolify/GH target lives behind
 *  the `HATCHKIT_LIVE_ROTATE_E2E` env flag — not run in CI.
 *
 *  Run: pnpm test:keys-rotate
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "eciesjs";

process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-rotate-${process.pid}`;
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "rotate-conf-"));

const {
  rotateProjectKey,
  parseEnvKeysEntries,
  derivePublicKey,
  pruneEnvKeysFile,
  readPublicKey,
} = await import("./src/deploy/keys.js");
const { SECRET_KEYS, getSecret, setSecret, clearAllSecrets } = await import("./src/utils/secrets.js");

interface Keypair {
  privateKey: string;
  publicKey: string;
}

function mintKeypair(): Keypair {
  const sk = new PrivateKey();
  return { privateKey: sk.secret.toString("hex"), publicKey: sk.publicKey.toHex() };
}

function makeProject(opts: { staleEntries?: number } = {}): {
  dir: string;
  original: Keypair;
  staleKeys: string[];
} {
  const dir = mkdtempSync(join(tmpdir(), "rotate-fix-"));
  const original = mintKeypair();
  // Pre-existing stale comma-list entries (simulate a project that
  // already accumulated keys from past rotations).
  const staleKeys: string[] = [];
  for (let i = 0; i < (opts.staleEntries ?? 0); i++) {
    staleKeys.push(mintKeypair().privateKey);
  }
  const allEntries = [...staleKeys, original.privateKey].join(",");
  writeFileSync(
    join(dir, ".env.production"),
    `#/----------------dotenvx----------------/\nDOTENV_PUBLIC_KEY_PRODUCTION="${original.publicKey}"\n\nFOO="value"\n`,
  );
  writeFileSync(join(dir, ".env.keys"), `DOTENV_PRIVATE_KEY_PRODUCTION="${allEntries}"\n`);
  return { dir, original, staleKeys };
}

/** Stub for `dotenvx rotate`: mint new keypair, swap the public key in
 *  .env.production, append the new private key to the .env.keys
 *  comma-list. Mirrors what the real subprocess does. */
function stubRotate(): import("./src/deploy/keys.js").RunDotenvxRotateFn {
  return async ({ envProductionPath }) => {
    const newKp = mintKeypair();
    const dir = envProductionPath.replace(/\/[^/]+$/, "");
    const envProd = readFileSync(envProductionPath, "utf-8");
    writeFileSync(
      envProductionPath,
      envProd.replace(
        /DOTENV_PUBLIC_KEY_PRODUCTION="[0-9a-fA-F]+"/,
        `DOTENV_PUBLIC_KEY_PRODUCTION="${newKp.publicKey}"`,
      ),
    );
    const keysPath = join(dir, ".env.keys");
    const keysContent = readFileSync(keysPath, "utf-8");
    const m = keysContent.match(/^DOTENV_PRIVATE_KEY_PRODUCTION="?([0-9a-fA-F,]+)"?\s*$/m);
    if (!m) throw new Error("stubRotate: no DOTENV_PRIVATE_KEY_PRODUCTION in .env.keys");
    writeFileSync(
      keysPath,
      keysContent.replace(
        /^DOTENV_PRIVATE_KEY_PRODUCTION=.*$/m,
        `DOTENV_PRIVATE_KEY_PRODUCTION="${m[1]},${newKp.privateKey}"`,
      ),
    );
  };
}

const results: Record<string, boolean> = {};

function report(label: string, checks: [string, boolean][]): boolean {
  console.log(`\n── ${label} ─────────────────────────────`);
  let ok = true;
  for (const [n, c] of checks) {
    console.log(`  ${c ? "✓" : "✗"} ${n}`);
    if (!c) ok = false;
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Test 1 — happy path: fresh single-key project → rotate → one new key.
// ---------------------------------------------------------------------------
{
  const { dir, original } = makeProject();
  await setSecret(SECRET_KEYS.dotenvxPrivateKey("test-fixture"), original.privateKey);
  const coolifyCalls: { project: string; keyFromKeychain: string }[] = [];
  const ghCalls: { project: string; repo: string; keyFromKeychain: string }[] = [];
  const result = await rotateProjectKey("test-fixture", {
    projectDir: dir,
    _runDotenvxRotate: stubRotate(),
    _coolifyPush: async (p) => {
      const k = await getSecret(SECRET_KEYS.dotenvxPrivateKey(p));
      coolifyCalls.push({ project: p, keyFromKeychain: k! });
      return { uuid: "stub-uuid" };
    },
    _ghPush: async (p, repo) => {
      const k = await getSecret(SECRET_KEYS.dotenvxPrivateKey(p));
      ghCalls.push({ project: p, repo, keyFromKeychain: k! });
    },
    _detectRepoSlug: async () => "acme/test-fixture",
  });
  const entries = parseEnvKeysEntries(readFileSync(join(dir, ".env.keys"), "utf-8"))!;
  const newPublic = readPublicKey(join(dir, ".env.production"))!;
  const keychainKey = await getSecret(SECRET_KEYS.dotenvxPrivateKey("test-fixture"));
  results.basicRotate = report("Test 1: fresh rotate (single key in)", [
    [".env.keys has exactly one entry", entries.length === 1],
    [
      "first (only) entry derives the new public key",
      derivePublicKey(entries[0]).toLowerCase() === newPublic.toLowerCase(),
    ],
    ["entry differs from pre-rotate key", entries[0] !== original.privateKey],
    ["result.newPublicKey matches .env.production", result.newPublicKey === newPublic],
    ["result.rotated true", result.rotated],
    // Pre-state had 1 entry; stub appends 1; prune drops the pre-rotate one.
    ["result.prunedStaleKeys === 1", result.prunedStaleKeys === 1],
    ["keychain updated to new key", keychainKey === entries[0]],
    [
      "Coolify push called with the new key",
      coolifyCalls.length === 1 && coolifyCalls[0].keyFromKeychain === entries[0],
    ],
    [
      "GH push called with the new key + detected repo",
      ghCalls.length === 1 &&
        ghCalls[0].keyFromKeychain === entries[0] &&
        ghCalls[0].repo === "acme/test-fixture",
    ],
    ["result.pushedCoolify present", !!result.pushedCoolify],
    ["result.pushedGh.repo === detected slug", result.pushedGh?.repo === "acme/test-fixture"],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 2 — accumulated comma-list (Bug 1 reproduction). Two prior
// rotations left two stale entries before .env.keys' current key.
// Rotate must prune all stale entries AND the previous "current".
// ---------------------------------------------------------------------------
{
  const { dir, original } = makeProject({ staleEntries: 2 });
  await setSecret(SECRET_KEYS.dotenvxPrivateKey("test-fixture"), original.privateKey);
  const result = await rotateProjectKey("test-fixture", {
    projectDir: dir,
    noPush: true,
    _runDotenvxRotate: stubRotate(),
  });
  const entries = parseEnvKeysEntries(readFileSync(join(dir, ".env.keys"), "utf-8"))!;
  const newPublic = readPublicKey(join(dir, ".env.production"))!;
  const keychainKey = await getSecret(SECRET_KEYS.dotenvxPrivateKey("test-fixture"));
  results.commaListPruned = report("Test 2: prune stale comma-list", [
    [".env.keys has exactly one entry after rotate", entries.length === 1],
    [
      "entry derives the freshly-written public key",
      derivePublicKey(entries[0]).toLowerCase() === newPublic.toLowerCase(),
    ],
    [
      // Pre-state had 3 entries (2 stale + original); rotate appended a 4th;
      // pruneStaleKeys = 4 - 1 = 3.
      "result.prunedStaleKeys === 3",
      result.prunedStaleKeys === 3,
    ],
    ["keychain holds the single new key (not the comma list)", keychainKey === entries[0]],
    ["skippedCoolify === no-push-flag", result.skippedCoolify === "no-push-flag"],
    ["skippedGh === no-push-flag", result.skippedGh === "no-push-flag"],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 3 — Bug 4: file IS present, but the old locate logic threw
// when .env.production lived at root and a server/client candidate
// dir existed but was unrelated. We now read `.env.keys` from the
// .env.production's own dirname, so the false negative is gone.
// ---------------------------------------------------------------------------
{
  const { dir, original } = makeProject();
  await setSecret(SECRET_KEYS.dotenvxPrivateKey("test-fixture"), original.privateKey);
  // Drop in a `packages/server` dir to confuse the old `locateEnvKeysFile`
  // — without the dirname fix, it would return undefined here even
  // though `.env.keys` is sitting at root.
  const decoy = join(dir, "packages/server");
  writeFileSync(join(dir, "decoy.txt"), "");
  rmSync(join(dir, "decoy.txt"));
  // Create the directory:
  await import("node:fs").then(({ mkdirSync }) => mkdirSync(decoy, { recursive: true }));
  let threw = false;
  try {
    await rotateProjectKey("test-fixture", {
      projectDir: dir,
      noPush: true,
      _runDotenvxRotate: stubRotate(),
    });
  } catch (err) {
    threw = true;
    console.error(`  unexpected throw: ${(err as Error).message}`);
  }
  const newPublic = readPublicKey(join(dir, ".env.production"))!;
  const entries = parseEnvKeysEntries(readFileSync(join(dir, ".env.keys"), "utf-8"))!;
  results.bug4FalseNegative = report("Test 3: Bug 4 false-negative gone", [
    ["rotate did not throw", !threw],
    ["new public key written", newPublic.length > 0],
    [
      "kept key derives the new public",
      entries.length === 1 &&
        derivePublicKey(entries[0]).toLowerCase() === newPublic.toLowerCase(),
    ],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 4 — verification catch: if the dotenvx subprocess swaps the
// public key but the .env.keys entry doesn't match (corrupted run,
// partial failure), rotate must throw rather than silently writing a
// broken keychain entry.
// ---------------------------------------------------------------------------
{
  const { dir, original } = makeProject();
  await setSecret(SECRET_KEYS.dotenvxPrivateKey("test-fixture"), original.privateKey);
  // A broken stub: change the public key but DON'T append a matching
  // private key — leaves .env.keys + .env.production permanently
  // mismatched.
  const brokenRotate: import("./src/deploy/keys.js").RunDotenvxRotateFn = async ({
    envProductionPath,
  }) => {
    const orphan = mintKeypair();
    const content = readFileSync(envProductionPath, "utf-8");
    writeFileSync(
      envProductionPath,
      content.replace(
        /DOTENV_PUBLIC_KEY_PRODUCTION="[0-9a-fA-F]+"/,
        `DOTENV_PUBLIC_KEY_PRODUCTION="${orphan.publicKey}"`,
      ),
    );
  };
  let caught: Error | undefined;
  try {
    await rotateProjectKey("test-fixture", {
      projectDir: dir,
      noPush: true,
      _runDotenvxRotate: brokenRotate,
    });
  } catch (err) {
    caught = err as Error;
  }
  const keychainKey = await getSecret(SECRET_KEYS.dotenvxPrivateKey("test-fixture"));
  results.mismatchDetected = report("Test 4: keypair mismatch rejected", [
    ["rotate threw an error", !!caught],
    [
      "error mentions the mismatch / no-match",
      !!caught && /no private key|derives the new/i.test(caught.message),
    ],
    [
      "keychain left untouched (still original)",
      keychainKey === original.privateKey,
    ],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test 5 — pruneEnvKeysFile helper directly: idempotent on a
// single-entry file, drops everything except the kept value otherwise.
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "prune-fix-"));
  const a = mintKeypair().privateKey;
  const b = mintKeypair().privateKey;
  const c = mintKeypair().privateKey;
  const keysPath = join(dir, ".env.keys");

  writeFileSync(keysPath, `DOTENV_PRIVATE_KEY_PRODUCTION="${a},${b},${c}"\n`);
  const r1 = pruneEnvKeysFile(keysPath, c);
  const after1 = parseEnvKeysEntries(readFileSync(keysPath, "utf-8"))!;

  // Idempotency: second prune on already-pruned file is a no-op.
  const r2 = pruneEnvKeysFile(keysPath, c);
  const after2 = parseEnvKeysEntries(readFileSync(keysPath, "utf-8"))!;

  results.pruneHelper = report("Test 5: pruneEnvKeysFile semantics", [
    ["first prune drops two stale entries", r1.pruned === 2],
    ["first prune keeps the requested value", r1.kept === c && after1.length === 1 && after1[0] === c],
    ["second prune is idempotent (pruned=0)", r2.pruned === 0],
    ["file unchanged on idempotent re-prune", after2.length === 1 && after2[0] === c],
  ]);
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Cleanup + summary
// ---------------------------------------------------------------------------
await clearAllSecrets();
if (existsSync(process.env.HATCHKIT_CONF_DIR!)) {
  rmSync(process.env.HATCHKIT_CONF_DIR!, { recursive: true, force: true });
}

console.log("\n=== SUMMARY ===");
let allOk = true;
for (const [name, ok] of Object.entries(results)) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) allOk = false;
}
console.log();
process.exit(allOk ? 0 : 1);
