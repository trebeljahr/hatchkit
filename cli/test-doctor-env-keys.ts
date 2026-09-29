/**
 * `hatchkit doctor` — `.env.keys` hygiene and git history.
 *
 * collection-of-beauty committed `.env.keys` in 98f3e695, untracked it
 * two days later, never rotated the key, and then encrypted every later
 * secret to it. The repo later went public. Doctor said "ok: .env.keys
 * present on disk and not tracked by git" the whole time, because it only
 * asked whether the file was tracked NOW.
 *
 * The properties that keep the check useful:
 *   1. An untracked `.env.keys` the repo doesn't ignore FAILS: the next
 *      `git add -A` commits it. One ignored only by a global or
 *      `.git/info/exclude` pattern WARNS, since other machines and CI
 *      don't have that pattern. The hint gives the exact command.
 *   2. A tracked `.env.keys` fails, and the hint untracks it, then
 *      rotates the key, then mentions a history purge — in that order.
 *   3. A committed key that is still in use FAILS, even after the file
 *      was untracked (the CoB shape), and even on a machine without
 *      `.env.keys` (the working tree's public key still answers).
 *   4. A committed key that has been rotated since WARNS, with a count
 *      and date range of the env versions encrypted to it. With nothing
 *      on disk to compare against, it warns that the key may be live.
 *   5. It reads `.env.keys` at the root and in the server dir.
 *   6. No git, or a shallow clone, never crashes it.
 *   7. No detail, hint or output carries a private key, or a sha256 of one.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PrivateKey } from "eciesjs";
import { execa } from "execa";
import { checkProjectKeyState } from "./src/doctor.js";

const failures: string[] = [];

async function expect(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

console.log("\n  test-doctor-env-keys\n");

const PROJECT = "hk-doctor-env-keys-fixture";

interface Key {
  priv: string;
  pub: string;
}

function newKey(): Key {
  const sk = new PrivateKey();
  return { priv: Buffer.from(sk.secret).toString("hex"), pub: sk.publicKey.toHex() };
}

const keys = { a: newKey(), b: newKey() };

/** Every string that must never reach a result or the terminal. */
const secrets = Object.values(keys).flatMap((k) => [
  k.priv,
  k.priv.toUpperCase(),
  createHash("sha256").update(k.priv).digest("hex"),
]);

const keysFile = (k: Key) => `DOTENV_PRIVATE_KEY_PRODUCTION="${k.priv}"\n`;
const prodFile = (k: Key, value: string) =>
  `DOTENV_PUBLIC_KEY_PRODUCTION="${k.pub}"\nDATABASE_URL="encrypted:${value}"\n`;

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await execa("git", args, { cwd: dir });
  return r.stdout;
}

/** A repo that ignores the machine's global excludes file, so a global
 *  `.env.keys` pattern can't make a "not ignored" case pass. */
async function repo(prefix: string): Promise<string> {
  const dir = tempDir(prefix);
  await git(dir, "init", "--quiet", "--initial-branch=main");
  await git(dir, "config", "user.email", "t@t.t");
  await git(dir, "config", "user.name", "test");
  await git(dir, "config", "commit.gpgsign", "false");
  await git(dir, "config", "core.excludesFile", "/dev/null");
  write(dir, { ".hatchkit.json": JSON.stringify({ name: PROJECT }) });
  return dir;
}

async function commit(dir: string, message: string, date: string, ...paths: string[]) {
  if (paths.length > 0) await git(dir, "add", "-f", ...paths);
  await execa("git", ["commit", "--quiet", "-m", message], {
    cwd: dir,
    env: { GIT_AUTHOR_DATE: `${date}T12:00:00Z`, GIT_COMMITTER_DATE: `${date}T12:00:00Z` },
  });
  return (await git(dir, "rev-parse", "HEAD")).trim().slice(0, 8);
}

/** Everything the check printed while it ran. */
const captured: string[] = [];

type Result = Awaited<ReturnType<typeof checkProjectKeyState>>[number];

async function run(dir: string): Promise<Result[]> {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const grab = (chunk: string | Uint8Array) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  process.stdout.write = grab as typeof process.stdout.write;
  process.stderr.write = grab as typeof process.stderr.write;
  try {
    const results = await checkProjectKeyState(dir);
    allResults.push(...results);
    return results;
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

const allResults: Result[] = [];

const byName = (results: Result[], label: string) =>
  results.filter((r) => r.name === `Project ${PROJECT} (${label})`);

const one = (results: Result[], label: string): Result => {
  const hits = byName(results, label);
  assert.equal(hits.length, 1, `expected one "${label}" entry, got ${hits.length}`);
  return hits[0];
};

const none = (results: Result[], label: string) =>
  assert.equal(byName(results, label).length, 0, `unexpected "${label}" entry`);

const hintText = (r: Result) => (r.hint ?? []).join("\n");

/** Index of the first hint line containing `needle`, asserting it exists. */
function hintAt(r: Result, needle: string): number {
  const i = (r.hint ?? []).findIndex((h) => h.includes(needle));
  assert.ok(i >= 0, `hint lacks "${needle}":\n${hintText(r)}`);
  return i;
}

/** The CoB shape: key committed, then untracked and ignored, then
 *  `.env.production` committed twice under the same key. */
async function cobShape(prefix: string, sub = ""): Promise<{ dir: string; leakSha: string }> {
  const dir = await repo(prefix);
  const at = (f: string) => (sub ? `${sub}/${f}` : f);
  write(dir, { [at(".env.keys")]: keysFile(keys.a), "README.md": "demo\n" });
  const leakSha = await commit(
    dir,
    "adopt",
    "2026-04-29",
    ".hatchkit.json",
    "README.md",
    at(".env.keys"),
  );
  await git(dir, "rm", "--cached", "--quiet", at(".env.keys"));
  write(dir, { ".gitignore": ".env.keys\n" });
  await commit(dir, "untrack .env.keys", "2026-05-01", ".gitignore");
  write(dir, { [at(".env.production")]: prodFile(keys.a, "one") });
  await commit(dir, "first secret", "2026-05-02", at(".env.production"));
  write(dir, { [at(".env.production")]: prodFile(keys.a, "two") });
  await commit(dir, "second secret", "2026-06-10", at(".env.production"));
  return { dir, leakSha };
}

// (a) clean: ignored by the repo's .gitignore and never committed.
await expect("(a) ignored and never committed → ok", async () => {
  const dir = await repo("hk-envkeys-clean-");
  write(dir, {
    ".gitignore": ".env.keys\n",
    ".env.production": prodFile(keys.a, "one"),
    ".env.keys": keysFile(keys.a),
  });
  await commit(dir, "init", "2026-05-01", ".hatchkit.json", ".gitignore", ".env.production");
  const results = await run(dir);
  const ok = one(results, ".env.keys hygiene");
  assert.equal(ok.status, "ok");
  assert.match(ok.detail ?? "", /ignored by \.gitignore/);
  assert.match(ok.detail ?? "", /never committed/);
  none(results, ".env.keys not ignored");
  none(results, ".env.keys leak");
  none(results, ".env.keys in git history");
});

// (b) present, untracked, not ignored.
await expect("(b) present but not ignored → fail with the .gitignore command", async () => {
  const dir = await repo("hk-envkeys-unignored-");
  write(dir, { ".gitignore": ".env\n", ".env.keys": keysFile(keys.a) });
  await commit(dir, "init", "2026-05-01", ".hatchkit.json", ".gitignore");
  const results = await run(dir);
  const r = one(results, ".env.keys not ignored");
  assert.equal(r.status, "fail");
  assert.match(r.detail ?? "", /git add -A/);
  hintAt(r, "printf '\\n.env.keys\\n' >> .gitignore");
  hintAt(r, "global ignore");
  none(results, ".env.keys hygiene");
});

await expect("(b) ignored only by .git/info/exclude → warn, not portable", async () => {
  const dir = await repo("hk-envkeys-exclude-");
  write(dir, { ".git/info/exclude": ".env.keys\n", ".env.keys": keysFile(keys.a) });
  await commit(dir, "init", "2026-05-01", ".hatchkit.json");
  const results = await run(dir);
  const r = one(results, ".env.keys not ignored");
  assert.equal(r.status, "warn");
  assert.match(r.detail ?? "", /\.git\/info\/exclude/);
  hintAt(r, "printf '\\n.env.keys\\n' >> .gitignore");
});

await expect("(b) re-included by a `!` pattern → fail naming the source", async () => {
  const dir = await repo("hk-envkeys-negated-");
  write(dir, { ".gitignore": "!.env.keys\n", ".env.keys": keysFile(keys.a) });
  await commit(dir, "init", "2026-05-01", ".hatchkit.json", ".gitignore");
  const results = await run(dir);
  const r = one(results, ".env.keys not ignored");
  assert.equal(r.status, "fail");
  hintAt(r, ".gitignore re-includes it");
});

// (c) tracked right now.
await expect("(c) tracked → fail: untrack, then rotate, then purge", async () => {
  const dir = await repo("hk-envkeys-tracked-");
  write(dir, { ".env.keys": keysFile(keys.a) });
  await commit(dir, "leak", "2026-04-29", ".hatchkit.json", ".env.keys");
  const results = await run(dir);
  const r = one(results, ".env.keys leak");
  assert.equal(r.status, "fail");
  const untrack = hintAt(r, "git rm --cached .env.keys");
  const ignore = hintAt(r, "printf '\\n.env.keys\\n' >> .gitignore");
  const burned = hintAt(r, "Treat the key as burned");
  const rotate = hintAt(r, `hatchkit keys rotate ${PROJECT}`);
  const purge = hintAt(r, "purging .env.keys from history");
  assert.ok(untrack < ignore && ignore < burned && burned < rotate && rotate < purge);
  // It's in history too, and it's the key in use.
  assert.equal(one(results, ".env.keys in git history").status, "fail");
  none(results, ".env.keys hygiene");
});

// (d) the CoB shape.
await expect("(d) committed, untracked, same key in use → fail, burned-key hint", async () => {
  const { dir, leakSha } = await cobShape("hk-envkeys-cob-");
  write(dir, { ".env.keys": keysFile(keys.a) });
  const results = await run(dir);
  const r = one(results, ".env.keys in git history");
  assert.equal(r.status, "fail");
  assert.equal(
    r.detail,
    `the current dotenvx private key is in git history (${leakSha}, 2026-04-29)`,
  );
  const burned = hintAt(r, "rotate it BEFORE writing any new value");
  const rotate = hintAt(r, `hatchkit keys rotate ${PROJECT}`);
  const values = hintAt(r, "rotate every value in .env.production");
  const purge = hintAt(r, "GitHub Support");
  assert.ok(burned < rotate && rotate < values && values < purge);
  hintAt(r, "2 committed versions of .env.production (2026-05-02 → 2026-06-10)");
  // The file itself is fine today; that's exactly what used to hide this.
  none(results, ".env.keys leak");
  none(results, ".env.keys not ignored");
  none(results, ".env.keys hygiene");
});

await expect(
  "(d) same shape without .env.keys on disk → still fails via the public key",
  async () => {
    const { dir } = await cobShape("hk-envkeys-cob-ci-");
    const results = await run(dir);
    assert.equal(one(results, ".env.keys in git history").status, "fail");
  },
);

await expect("(d) nothing on disk to compare with → warn that it may be in use", async () => {
  const dir = await repo("hk-envkeys-unknown-");
  write(dir, { ".env.keys": keysFile(keys.a) });
  await commit(dir, "leak", "2026-04-29", ".hatchkit.json", ".env.keys");
  await git(dir, "rm", "--quiet", ".env.keys");
  await commit(dir, "drop", "2026-05-01");
  const results = await run(dir);
  const r = one(results, ".env.keys in git history");
  assert.equal(r.status, "warn");
  assert.match(r.detail ?? "", /whether it is still in use/);
});

// (e) committed once, rotated since.
await expect("(e) committed, key rotated since → warn with count and date range", async () => {
  const { dir, leakSha } = await cobShape("hk-envkeys-rotated-");
  write(dir, { ".env.keys": keysFile(keys.b), ".env.production": prodFile(keys.b, "three") });
  await commit(dir, "rotate", "2026-07-01", ".env.production");
  const results = await run(dir);
  const r = one(results, ".env.keys in git history");
  assert.equal(r.status, "warn");
  assert.match(
    r.detail ?? "",
    new RegExp(`older dotenvx private key .*\\(${leakSha}, 2026-04-29\\)`),
  );
  hintAt(r, "rotated after that key was replaced");
  hintAt(r, "2 committed versions of .env.production (2026-05-02 → 2026-06-10)");
  none(results, ".env.keys hygiene");
});

// (f) no git, missing git, shallow clone.
await expect("(f) not a git repo → skip, no crash", async () => {
  const dir = tempDir("hk-envkeys-nogit-");
  write(dir, {
    ".hatchkit.json": JSON.stringify({ name: PROJECT }),
    ".env.keys": keysFile(keys.a),
  });
  const results = await run(dir);
  assert.equal(one(results, ".env.keys hygiene").status, "skip");
  none(results, ".env.keys in git history");
});

await expect("(f) no git binary on PATH → no crash", async () => {
  const { dir } = await cobShape("hk-envkeys-nobin-");
  write(dir, { ".env.keys": keysFile(keys.a) });
  const path = process.env.PATH;
  process.env.PATH = join(dir, "no-such-bin");
  try {
    const results = await run(dir);
    none(results, ".env.keys in git history");
  } finally {
    process.env.PATH = path;
  }
});

await expect("(f) shallow clone past the leak → no crash, says history is partial", async () => {
  const { dir: origin } = await cobShape("hk-envkeys-shallow-src-");
  const parent = tempDir("hk-envkeys-shallow-");
  await execa("git", ["clone", "--quiet", "--depth=1", `file://${origin}`, "clone"], {
    cwd: parent,
  });
  const dir = join(parent, "clone");
  await git(dir, "config", "core.excludesFile", "/dev/null");
  write(dir, { ".env.keys": keysFile(keys.a) });
  const results = await run(dir);
  none(results, ".env.keys in git history");
  const ok = one(results, ".env.keys hygiene");
  assert.equal(ok.status, "ok");
  assert.match(ok.detail ?? "", /shallow clone/);
});

// (g) split layout.
await expect("(g) packages/server/.env.keys committed, still in use → fail", async () => {
  const { dir, leakSha } = await cobShape("hk-envkeys-split-", "packages/server");
  write(dir, { "packages/server/.env.keys": keysFile(keys.a) });
  const results = await run(dir);
  const r = one(results, ".env.keys in git history");
  assert.equal(r.status, "fail");
  assert.match(r.detail ?? "", new RegExp(`\\(${leakSha}, 2026-04-29\\)`));
  none(results, ".env.keys not ignored");
});

await expect("(g) packages/server/.env.keys not ignored → fail naming that path", async () => {
  const dir = await repo("hk-envkeys-split-unignored-");
  write(dir, {
    ".gitignore": ".env\n",
    ".env.keys": keysFile(keys.a),
    "packages/server/.env.keys": keysFile(keys.a),
  });
  await commit(dir, "init", "2026-05-01", ".hatchkit.json", ".gitignore");
  const results = await run(dir);
  const hits = byName(results, ".env.keys not ignored");
  const details = hits.map((h) => h.detail ?? "");
  assert.equal(hits.length, 2, details.join(" | "));
  assert.ok(details.some((d) => d.startsWith("packages/server/.env.keys ")));
  assert.ok(details.some((d) => d.startsWith(".env.keys ")));
});

await expect("no key and no key fingerprint in any detail, hint or output", () => {
  assert.ok(allResults.length > 0);
  const text = [JSON.stringify(allResults), ...captured].join("\n");
  for (const secret of secrets) assert.ok(!text.includes(secret), "a fixture key leaked");
});

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\n  ${failures.length} failure(s)\n`);
  process.exit(1);
}
console.log("\n  all passed\n");
