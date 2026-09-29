/**
 * Regression tests for the paths that can put a secret into git.
 *
 * On 2026-04-29 `hatchkit adopt` generated `.env.keys` in a repo whose
 * `.gitignore` covered `.env`, `.env.local` and `.env.*.local` but not
 * `.env.keys`, and `git add -A` committed the production dotenvx
 * private key. Every scenario below starts from that repo shape.
 *
 *   · The staged-secret guard (`utils/git-safety.ts`) refuses the file
 *     at every commit site, whatever `.gitignore` says.
 *   · The dotenvx wrapper (`utils/dotenvx-safe.ts`) gitignores
 *     `.env.keys` before dotenvx can create it, and it is the only
 *     importer of dotenvx's `set`.
 *
 * No real providers: every repo is a throwaway `git init` in tmpdir.
 *
 * Run: `pnpm test` (or `tsx test-secret-hygiene.ts`).
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Keep git hermetic. Above all, no machine-wide excludes file: git
// reads ~/.config/git/ignore even when no config names it, and a
// developer's copy that lists `.env.keys` hides exactly the gap under
// test. It hid it on the machine this incident happened on, too.
process.env.GIT_CONFIG_GLOBAL = join(tmpdir(), "hk-secret-hygiene-gitconfig");
writeFileSync(process.env.GIT_CONFIG_GLOBAL, `[core]\n\texcludesFile = ${devNull}\n`);
process.env.GIT_CONFIG_NOSYSTEM = "1";

const { dotenvxSet } = await import("./src/utils/dotenvx-safe.js");
const { StagedSecretsError, assertNothingSecretStaged, secretFileReason, stageAllSafely } =
  await import("./src/utils/git-safety.js");
const { writeProdEnv } = await import("./src/provision/write-env.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const failures: string[] = [];

async function expect(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message.split("\n")[0]}`);
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/** The collection-of-beauty repo shape: `.env*` patterns, no `.env.keys`. */
const COB_GITIGNORE = "node_modules/\n.env\n.env.local\n.env.*.local\n.env.production.local\n";

/** A realistic `.env.keys`. Fake key: 64 hex chars, never valid anywhere. */
const ENV_KEYS = `#/------------------!DOTENV_PRIVATE_KEYS!-------------------/
#/ private decryption keys. DO NOT commit to source control /
#/     [how it works](https://dotenvx.com/encryption)       /
#/----------------------------------------------------------/

# .env.production
DOTENV_PRIVATE_KEY_PRODUCTION=${"0f".repeat(32)}
`;

function cobRepo(opts: { gitInit?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "hk-secret-hygiene-"));
  writeFileSync(join(root, ".gitignore"), COB_GITIGNORE);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cob" }));
  if (opts.gitInit !== false) {
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "test");
    git(root, "config", "commit.gpgsign", "false");
  }
  return root;
}

/** Exit status of a git command, for the ones that answer by status. */
function spawnGit(cwd: string, ...args: string[]): number {
  return spawnSync("git", args, { cwd }).status ?? 1;
}

function staged(root: string): string[] {
  return git(root, "diff", "--cached", "--name-only").split("\n").filter(Boolean);
}

async function refusal(
  fn: () => Promise<unknown>,
): Promise<InstanceType<typeof StagedSecretsError>> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof StagedSecretsError) return err;
    throw err;
  }
  throw new Error("expected a StagedSecretsError, got none");
}

console.log("\n── staged-secret guard ─────────────────────────────────────────");

await expect("CoB shape: stageAllSafely refuses .env.keys and leaves it unstaged", async () => {
  const root = cobRepo();
  try {
    writeFileSync(join(root, ".env.keys"), ENV_KEYS);
    writeFileSync(join(root, "index.ts"), "export {};\n");
    const err = await refusal(() =>
      stageAllSafely(root, { project: "cob", retry: "hatchkit adopt --resume" }),
    );
    assert.deepEqual(
      err.findings.map((f) => f.path),
      [".env.keys"],
    );
    assert.ok(!staged(root).includes(".env.keys"), ".env.keys still staged after refusal");
    assert.ok(staged(root).includes("index.ts"), "unrelated files were unstaged too");
    assert.ok(existsSync(join(root, ".env.keys")), "the file on disk was touched");
    const msg = err.message;
    assert.match(msg, /\.env\.keys\s+dotenvx private keys/);
    assert.match(msg, /echo '\.env\.keys' >> \.gitignore/);
    assert.match(msg, /hatchkit keys rotate cob/);
    assert.match(msg, /Then re-run: hatchkit adopt --resume/);
    assert.ok(!msg.includes("0f0f0f0f"), "the refusal printed the key value");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("a key file under any name is refused by content", async () => {
  const root = cobRepo();
  try {
    mkdirSync(join(root, "backup"));
    writeFileSync(join(root, "backup/keys.txt"), ENV_KEYS);
    const err = await refusal(() => stageAllSafely(root));
    assert.deepEqual(
      err.findings.map((f) => f.path),
      ["backup/keys.txt"],
    );
    assert.match(err.findings[0].reason, /DOTENV_PRIVATE_KEY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("every name on the denylist is refused", async () => {
  const root = cobRepo();
  try {
    const files: Record<string, string> = {
      ".env.me": "DOTENVX_TOKEN=x\n",
      "packages/server/.env.development.local": "LISTMONK_API_TOKEN=x\n",
      "android/app/release.keystore": "bin",
      "android/app/upload.jks": "bin",
      "signing/dist.p12": "bin",
      "signing/AuthKey_ABC123.p8": "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
      "infra/terraform.tfstate": "{}",
      "infra/terraform.tfstate.backup": "{}",
      "deploy/id_ed25519": "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n",
      "certs/server.pem": "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n",
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    // .env.development.local is covered by COB_GITIGNORE's .env.*.local,
    // so force it into the index the way a careless `git add -f` would.
    git(root, "add", "-f", "packages/server/.env.development.local");
    const err = await refusal(() => stageAllSafely(root));
    assert.deepEqual(err.findings.map((f) => f.path).sort(), Object.keys(files).sort());
    assert.deepEqual(
      staged(root).filter((p) => p in files),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("public keys, certificates and ordinary sources are not refused", async () => {
  const root = cobRepo();
  try {
    const files: Record<string, string> = {
      "deploy/id_ed25519.pub": "ssh-ed25519 AAAA test\n",
      "certs/ca.pem": "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n",
      "certs/pub.pem": "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----\n",
      // An encrypted env file carries the PUBLIC key in its header.
      "packages/server/.env.production": `DOTENV_PUBLIC_KEY_PRODUCTION="02${"ab".repeat(32)}"\nX="encrypted:abc"\n`,
      // The starter's config/env.ts names the variable in a comment.
      "packages/server/src/config/env.ts":
        "// It looks for `DOTENV_PRIVATE_KEY_*` either in the process env\nexport {};\n",
      // A workflow reads the secret by name.
      ".github/workflows/deploy.yml":
        "env:\n  DOTENV_PRIVATE_KEY_PRODUCTION: ${{ secrets.DOTENV_PRIVATE_KEY_PRODUCTION }}\n",
      Dockerfile: "ENV DOTENV_PRIVATE_KEY_PRODUCTION=${DOTENV_PRIVATE_KEY_PRODUCTION}\n",
      "infra/main.tf": "terraform {}\n",
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    await stageAllSafely(root);
    for (const rel of Object.keys(files))
      assert.ok(staged(root).includes(rel), `${rel} not staged`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("a .env.keys committed long ago is refused on the next commit", async () => {
  const root = cobRepo();
  try {
    writeFileSync(join(root, ".env.keys"), ENV_KEYS);
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "the 2026-04-29 commit");
    writeFileSync(join(root, "later.ts"), "export {};\n");
    const err = await refusal(() => stageAllSafely(root, { project: "cob" }));
    assert.equal(err.findings[0].path, ".env.keys");
    assert.equal(err.findings[0].tracked, true);
    assert.match(err.message, /git rm --cached -- \.env\.keys/);
    assert.match(err.message, /secret is burned/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("assertNothingSecretStaged guards a pathspec stage too", async () => {
  const root = cobRepo();
  try {
    writeFileSync(join(root, ".env.keys"), ENV_KEYS);
    git(root, "add", "-f", "--", ".env.keys");
    const err = await refusal(() => assertNothingSecretStaged(root));
    assert.equal(err.findings[0].path, ".env.keys");
    assert.deepEqual(staged(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("paths are resolved from the repo root when cwd is a subdir", async () => {
  const root = cobRepo();
  try {
    mkdirSync(join(root, "packages/server"), { recursive: true });
    writeFileSync(join(root, "packages/server/.env.keys"), ENV_KEYS);
    const err = await refusal(() => stageAllSafely(join(root, "packages/server")));
    assert.deepEqual(
      err.findings.map((f) => f.path),
      ["packages/server/.env.keys"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("setupGitHub's Initial scaffold commit refuses .env.keys (no remote)", async () => {
  const root = cobRepo({ gitInit: false });
  try {
    writeFileSync(join(root, ".env.keys"), ENV_KEYS);
    const { setupGitHub } = await import("./src/deploy/github.js");
    const config = { name: "cob", createGithubRepo: false } as Parameters<typeof setupGitHub>[0];
    await refusal(() => setupGitHub(config, root));
    assert.equal(
      execFileSync("git", ["rev-list", "--all"], { cwd: root, encoding: "utf-8" }).trim(),
      "",
      "a commit was created",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("secretFileReason is name-only without an absolute path", () => {
  assert.equal(secretFileReason("keys.txt"), undefined);
  assert.equal(secretFileReason("a/b/.env.keys")?.ignorePattern, ".env.keys");
});

console.log("\n── every commit site goes through the guard ───────────────────");

/** All `.ts` files under `dir`, repo-relative to `cli/`. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      // Templates are files hatchkit writes into projects, not CLI code.
      if (name !== "templates") out.push(...sources(abs));
    } else if (name.endsWith(".ts")) {
      out.push(relative(HERE, abs));
    }
  }
  return out;
}

const SRC = sources(join(HERE, "src"));

await expect("no `git add -A` / `git add .` outside utils/git-safety.ts", () => {
  const offenders = SRC.filter((f) => f !== "src/utils/git-safety.ts").filter((f) =>
    /\[\s*"add"\s*,\s*"(-A|--all|\.)"/.test(readFileSync(join(HERE, f), "utf-8")),
  );
  assert.deepEqual(offenders, [], `route these through stageAllSafely: ${offenders.join(", ")}`);
});

console.log("\n── dotenvx writes gitignore .env.keys first ───────────────────");

await expect("CoB shape: dotenvxSet appends .env.keys before the keypair exists", async () => {
  const root = cobRepo();
  try {
    dotenvxSet("HELLO", "world", { path: join(root, ".env.production"), encrypt: true });
    assert.ok(existsSync(join(root, ".env.keys")), "dotenvx did not create .env.keys");
    assert.match(readFileSync(join(root, ".gitignore"), "utf-8"), /^\.env\.keys$/m);
    git(root, "add", "-A");
    assert.ok(!staged(root).includes(".env.keys"), ".env.keys staged by git add -A");
    assert.ok(staged(root).includes(".env.production"), "encrypted env not staged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("a global excludes file does not count: the repo gets its own entry", async () => {
  const root = cobRepo();
  const globalIgnore = join(root, "..", `hk-global-ignore-${Date.now()}`);
  try {
    writeFileSync(globalIgnore, ".env.keys\n");
    git(root, "config", "core.excludesFile", globalIgnore);
    writeProdEnv(join(root, "packages/server/.env.production"), [{ key: "A", value: "b" }]);
    assert.match(readFileSync(join(root, ".gitignore"), "utf-8"), /^\.env\.keys$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(globalIgnore, { force: true });
  }
});

await expect("a repo that already ignores .env.keys (via .env*) is left alone", async () => {
  const root = cobRepo();
  try {
    writeFileSync(join(root, ".gitignore"), ".env*\n!.env.production\n");
    writeProdEnv(join(root, ".env.production"), [{ key: "A", value: "b" }]);
    assert.equal(readFileSync(join(root, ".gitignore"), "utf-8"), ".env*\n!.env.production\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("before git init: the project root's .gitignore gets the entry", async () => {
  const root = cobRepo({ gitInit: false });
  try {
    writeFileSync(join(root, ".hatchkit.json"), JSON.stringify({ name: "cob" }));
    writeProdEnv(join(root, "packages/server/.env.production"), [{ key: "A", value: "b" }]);
    assert.match(readFileSync(join(root, ".gitignore"), "utf-8"), /^\.env\.keys$/m);
    assert.ok(!existsSync(join(root, "packages/server/.gitignore")), "nested .gitignore created");
    git(root, "init", "--quiet");
    git(root, "add", "-A");
    assert.ok(!staged(root).includes("packages/server/.env.keys"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("no module imports dotenvx's `set` except utils/dotenvx-safe.ts", () => {
  const importsSet = (text: string): boolean => {
    for (const m of text.matchAll(
      /(?:import\s*(?:type\s*)?\{([^}]*)\}\s*from|\{([^}]*)\}\s*=\s*await\s+import\()\s*["']@dotenvx\/dotenvx["']/g,
    )) {
      const names = (m[1] ?? m[2]).split(",").map((n) => n.trim().split(/\s+|:/)[0]);
      if (names.includes("set")) return true;
    }
    // A namespace or default import can reach `.set` without naming it.
    return /import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s*["']@dotenvx\/dotenvx["']/.test(text);
  };
  const offenders = SRC.filter((f) => f !== "src/utils/dotenvx-safe.ts").filter((f) =>
    importsSet(readFileSync(join(HERE, f), "utf-8")),
  );
  assert.deepEqual(
    offenders,
    [],
    `import dotenvxSet from utils/dotenvx-safe.ts: ${offenders.join(", ")}`,
  );
  // The detector itself must catch the three shapes it guards against.
  assert.ok(importsSet('import { set as dotenvxSet } from "@dotenvx/dotenvx";'));
  assert.ok(importsSet('const { set: dotenvxSet } = await import("@dotenvx/dotenvx");'));
  assert.ok(importsSet('import * as dotenvx from "@dotenvx/dotenvx";'));
  assert.ok(!importsSet('import { parse as dotenvxParse } from "@dotenvx/dotenvx";'));
});

console.log("\n── dev credentials stay out of the committed .env.development ──");

const { devLocalEnvPath, migrateDevSecretsToLocal, retrofitDevEnvSecrets, writeDevEnv } =
  await import("./src/provision/write-env.js");
const { CURRENT_LOADER, LEGACY_LOADER, upgradeServerEnvLoader } = await import(
  "./src/utils/dev-env-loader.js"
);
const { SECRET_IGNORE_RULES, ensureSecretFilesIgnored } = await import("./src/utils/gitignore.js");
const { loadProjectEnv } = await import("./src/assets/env.js");
const { checkProjectDevEnvSecretsState } = await import("./src/doctor.js");

/** Fake credentials: shaped like the real thing, valid nowhere. */
const FAKE_TOKEN = "hk-test-listmonk-token-0000";
const FAKE_SMTP = "hk-test-smtp-password-0000";

/** `.env.development` the way `hatchkit add` left it before 2026-09-29:
 *  starter defaults plus provisioned values, secrets included. */
const LEGACY_DEV_ENV = `PORT=5000
AWS_SECRET_ACCESS_KEY=hatchkit-dev
LISTMONK_URL=https://listmonk.example.test
LISTMONK_API_TOKEN=${FAKE_TOKEN}
SES_SMTP_PASSWORD="${FAKE_SMTP}"
STRIPE_SECRET_KEY=CHANGE_ME_STRIPE_SECRET_KEY
`;

/** The loader module as every starter shipped it before `.local`. */
const LEGACY_ENV_TS = `import { config as dotenvxConfig } from "@dotenvx/dotenvx";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(__dirname, "../..");
${LEGACY_LOADER}
export const env = {};
`;

/** A scaffolded project from before the fix: manifest, starter layout,
 *  secrets in the committed .env.development, all of it committed. */
function legacyProject(): string {
  const root = cobRepo();
  writeFileSync(join(root, ".hatchkit.json"), JSON.stringify({ name: "cob" }));
  mkdirSync(join(root, "packages/server/src/config"), { recursive: true });
  writeFileSync(join(root, "packages/server/.env.development"), LEGACY_DEV_ENV);
  writeFileSync(join(root, "packages/server/src/config/env.ts"), LEGACY_ENV_TS);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "scaffold");
  return root;
}

await expect("writeDevEnv refuses the committed .env.development", () => {
  const root = cobRepo();
  try {
    assert.throws(
      () => writeDevEnv(join(root, ".env.development"), [{ key: "A", value: "b" }]),
      /refuses .*\.env\.development is committed/,
    );
    assert.ok(!existsSync(join(root, ".env.development")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("writeDevEnv gitignores .env.*.local first, so git add -A skips it", () => {
  const root = cobRepo();
  try {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.env\n");
    const path = devLocalEnvPath(join(root, "packages/server"));
    writeDevEnv(path, [{ key: "LISTMONK_API_TOKEN", value: FAKE_TOKEN }]);
    assert.match(readFileSync(join(root, ".gitignore"), "utf-8"), /^\.env\.\*\.local$/m);
    git(root, "add", "-A");
    assert.ok(!staged(root).includes("packages/server/.env.development.local"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("the first dev write moves provisioned secrets out of .env.development", () => {
  const root = legacyProject();
  const serverDir = join(root, "packages/server");
  try {
    writeFileSync(join(serverDir, ".env.development.local"), `SES_SMTP_PASSWORD=newer-local\n`);
    writeDevEnv(devLocalEnvPath(serverDir), [{ key: "LISTMONK_TEST_LIST_ID", value: "7" }]);
    const dev = readFileSync(join(serverDir, ".env.development"), "utf-8");
    const local = readFileSync(join(serverDir, ".env.development.local"), "utf-8");
    assert.ok(
      !dev.includes(FAKE_TOKEN) && !dev.includes(FAKE_SMTP),
      "secret left in .env.development",
    );
    assert.match(dev, /^AWS_SECRET_ACCESS_KEY=hatchkit-dev$/m, "placeholder moved");
    assert.match(dev, /^STRIPE_SECRET_KEY=CHANGE_ME/m, "CHANGE_ME moved");
    assert.match(dev, /^LISTMONK_URL=/m, "non-secret moved");
    assert.match(local, new RegExp(`^LISTMONK_API_TOKEN=${FAKE_TOKEN}$`, "m"));
    assert.match(local, /^SES_SMTP_PASSWORD=newer-local$/m, "local value overwritten");
    assert.ok(!local.includes(FAKE_SMTP), "stale committed value copied over the local one");
    assert.match(local, /^LISTMONK_TEST_LIST_ID=7$/m);
    // And the next migration is a no-op.
    assert.deepEqual(migrateDevSecretsToLocal(serverDir).moved, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("the legacy server loader is upgraded once, a custom one is left alone", () => {
  const root = legacyProject();
  const serverDir = join(root, "packages/server");
  try {
    assert.equal(upgradeServerEnvLoader(serverDir).status, "upgraded");
    const text = readFileSync(join(serverDir, "src/config/env.ts"), "utf-8");
    assert.ok(text.includes(CURRENT_LOADER) && !text.includes(LEGACY_LOADER));
    assert.equal(upgradeServerEnvLoader(serverDir).status, "current");
    writeFileSync(join(serverDir, "src/config/env.ts"), 'import "dotenv/config";\n');
    assert.equal(upgradeServerEnvLoader(serverDir).status, "custom");
    assert.equal(
      readFileSync(join(serverDir, "src/config/env.ts"), "utf-8"),
      'import "dotenv/config";\n',
    );
    assert.equal(upgradeServerEnvLoader(join(root, "nowhere")).status, "absent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("the starter's env.ts carries the exact block the retrofit writes", () => {
  const starterEnv = readFileSync(
    join(HERE, "../starter/packages/server/src/config/env.ts"),
    "utf-8",
  );
  assert.ok(starterEnv.includes(CURRENT_LOADER), "starter loader drifted from CURRENT_LOADER");
});

await expect("the upgraded loader reads .env.development.local over .env.development", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-secret-hygiene-loader-"));
  try {
    writeFileSync(join(dir, ".env.development"), "A=committed\nB=committed\n");
    writeFileSync(join(dir, ".env.development.local"), "A=local\n");
    // Run CURRENT_LOADER itself with dotenvx, not a paraphrase of it.
    const body = CURRENT_LOADER.replace(
      /dotenvxConfig\(\{ path: envPaths \}\)/,
      "dotenvxConfig({ path: envPaths, processEnv: out, quiet: true })",
    );
    const run = new Function(
      "process",
      "resolve",
      "existsSync",
      "serverRoot",
      "dotenvxConfig",
      "out",
      body,
    );
    const out: Record<string, string> = {};
    const { config } = await import("@dotenvx/dotenvx");
    run(
      { env: { NODE_ENV: "development" } },
      (...p: string[]) => join(...p),
      existsSync,
      dir,
      config,
      out,
    );
    assert.deepEqual(out, { A: "local", B: "committed" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await expect("loadProjectEnv(dev) layers .env.development.local over .env.development", () => {
  const root = legacyProject();
  try {
    retrofitDevEnvSecrets(root);
    const env = loadProjectEnv({ projectDir: root, mode: "dev" });
    assert.equal(env.LISTMONK_API_TOKEN, FAKE_TOKEN);
    assert.equal(env.PORT, "5000");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect(
  "doctor fails on a committed .env.development with credentials, names keys only",
  async () => {
    const root = legacyProject();
    try {
      const before = await checkProjectDevEnvSecretsState(root);
      assert.equal(before.length, 1);
      assert.equal(before[0].status, "fail");
      assert.match(before[0].detail ?? "", /LISTMONK_API_TOKEN, SES_SMTP_PASSWORD/);
      const printed = JSON.stringify(before);
      assert.ok(
        !printed.includes(FAKE_TOKEN) && !printed.includes(FAKE_SMTP),
        "doctor printed a value",
      );
      assert.ok(!printed.includes("AWS_SECRET_ACCESS_KEY"), "flagged the MinIO placeholder");
      // `hatchkit update`'s retrofit clears it.
      const moved = retrofitDevEnvSecrets(root);
      assert.deepEqual(moved[0]?.moved, ["LISTMONK_API_TOKEN", "SES_SMTP_PASSWORD"]);
      assert.deepEqual(await checkProjectDevEnvSecretsState(root), []);
      const env = readFileSync(join(root, "packages/server/src/config/env.ts"), "utf-8");
      assert.ok(env.includes(CURRENT_LOADER), "retrofit did not upgrade the loader");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

await expect("doctor fails on an .env.development.local the repo does not ignore", async () => {
  const root = legacyProject();
  try {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    writeFileSync(join(root, "packages/server/.env.development"), "PORT=5000\n");
    writeFileSync(
      join(root, "packages/server/.env.development.local"),
      `LISTMONK_API_TOKEN=${FAKE_TOKEN}\n`,
    );
    const res = await checkProjectDevEnvSecretsState(root);
    assert.equal(res.length, 1);
    assert.match(res[0].name, /\.env\.development\.local/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log("\n── .gitignore covers every secret file hatchkit can generate ──");

await expect("the starter's .gitignore covers every SECRET_IGNORE_RULES sample", () => {
  const root = cobRepo();
  try {
    writeFileSync(
      join(root, ".gitignore"),
      readFileSync(join(HERE, "../starter/.gitignore"), "utf-8"),
    );
    const uncovered = SECRET_IGNORE_RULES.filter(
      ({ sample }) => spawnGit(root, "check-ignore", "-q", "--no-index", "--", sample) !== 0,
    ).map((r) => r.sample);
    assert.deepEqual(uncovered, []);
    // The negations still win: both committed env files stay committable.
    for (const kept of ["packages/server/.env.development", "packages/server/.env.production"]) {
      assert.notEqual(
        spawnGit(root, "check-ignore", "-q", "--no-index", "--", kept),
        0,
        `${kept} ignored`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await expect("ensureSecretFilesIgnored completes a CoB .gitignore and is idempotent", () => {
  const root = cobRepo();
  try {
    const first = ensureSecretFilesIgnored(root);
    assert.ok(first.added.includes(".env.keys") && first.added.includes("*.keystore"));
    assert.ok(!first.added.includes(".env.*.local"), "re-added a pattern the repo had");
    assert.deepEqual(ensureSecretFilesIgnored(root).added, []);
    for (const { sample } of SECRET_IGNORE_RULES) {
      assert.equal(spawnGit(root, "check-ignore", "-q", "--no-index", "--", sample), 0, sample);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log("");
if (failures.length > 0) {
  console.error(`  ${failures.length} test(s) failed:`);
  for (const f of failures) console.error(`    · ${f}`);
  process.exit(1);
} else {
  console.log("  all tests passed");
}
