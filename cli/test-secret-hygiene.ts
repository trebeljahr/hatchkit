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
import { execFileSync } from "node:child_process";
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

console.log("");
if (failures.length > 0) {
  console.error(`  ${failures.length} test(s) failed:`);
  for (const f of failures) console.error(`    · ${f}`);
  process.exit(1);
} else {
  console.log("  all tests passed");
}
