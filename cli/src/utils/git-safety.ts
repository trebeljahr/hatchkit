/*
 * Refuse to commit secrets.
 *
 * Every hatchkit code path that stages files and commits them goes
 * through `stageAllSafely` (for `git add -A`) or
 * `assertNothingSecretStaged` (after a pathspec `git add`). One guard,
 * one list of refused files, so a new commit site cannot quietly skip
 * the check the others make.
 *
 * Why it exists: on 2026-04-29 `hatchkit adopt` generated `.env.keys`
 * in a repo whose `.gitignore` did not list it, and the next
 * `git add -A` committed the production dotenvx private key. A
 * `.gitignore` entry is the first defence; this guard is the last one,
 * and it holds whatever the ignore rules say.
 *
 * On a refusal the guard also unstages the files it refused. An index
 * that still holds `.env.keys` after hatchkit exits is a trap: the
 * user's next `git commit` would finish what hatchkit refused to do.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { exec } from "./exec.js";
import { looksLikeDotenvxPrivateKey } from "./gitignore.js";

/** One file the guard refuses, with the reason and the `.gitignore`
 *  pattern that keeps it out next time. */
export interface SecretFileFinding {
  /** Path relative to the repo root, as git prints it. */
  path: string;
  reason: string;
  /** Pattern to add to `.gitignore` so the file stays out of `git add -A`. */
  ignorePattern: string;
  /** True when the file is already in the index at HEAD, which means it
   *  is in history and the secret must be treated as burned. */
  tracked: boolean;
}

interface NameRule {
  test: (name: string) => boolean;
  reason: string;
  ignorePattern: string;
}

/** Refused by file name alone. Checked against the basename, so a match
 *  anywhere in the tree counts. */
const NAME_RULES: NameRule[] = [
  {
    test: (n) => n === ".env.keys",
    reason: "dotenvx private keys",
    ignorePattern: ".env.keys",
  },
  {
    test: (n) => n === ".env.me",
    reason: "dotenvx account credential",
    ignorePattern: ".env.me",
  },
  {
    // `hatchkit add` writes provisioned development credentials to
    // `.env.development.local` in plaintext. `.env.local` is the same
    // convention without a mode.
    test: (n) => n === ".env.local" || /^\.env\..+\.local$/.test(n),
    reason: "local env file with plaintext credentials",
    ignorePattern: ".env.*.local",
  },
  {
    test: (n) => /\.(keystore|jks)$/i.test(n),
    reason: "Java/Android keystore",
    ignorePattern: "*.keystore",
  },
  {
    test: (n) => /\.(p12|pfx)$/i.test(n),
    reason: "PKCS#12 bundle with a private key",
    ignorePattern: "*.p12",
  },
  {
    test: (n) => /\.p8$/i.test(n),
    reason: "Apple .p8 private key",
    ignorePattern: "*.p8",
  },
  {
    // terraform.tfstate, terraform.tfstate.backup, and the timestamped
    // backups Terraform writes next to them. State holds every provider
    // secret a plan touched, in plaintext.
    test: (n) => /\.tfstate(\..+)?$/i.test(n),
    reason: "Terraform state (holds provider secrets in plaintext)",
    ignorePattern: "*.tfstate*",
  },
  {
    // The private halves of the default ssh-keygen names. The `.pub`
    // halves are public and fall through.
    test: (n) => /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/.test(n),
    reason: "SSH private key",
    ignorePattern: "id_*",
  },
];

/** Classify one path. `absPath` enables the content checks (a `.pem` or
 *  `.key` that holds a private key, and any file that holds a dotenvx
 *  private key value). Returns undefined for a file that is safe to
 *  commit. */
export function secretFileReason(
  relPath: string,
  absPath?: string,
): Omit<SecretFileFinding, "path" | "tracked"> | undefined {
  const name = basename(relPath);
  for (const rule of NAME_RULES) {
    if (rule.test(name)) return { reason: rule.reason, ignorePattern: rule.ignorePattern };
  }
  if (!absPath || !existsSync(absPath)) return undefined;
  // A public certificate or public key in a `.pem` is fine to commit, so
  // `.pem` and `.key` are refused by content, not by name.
  if (/\.(pem|key)$/i.test(name) && hasPemPrivateKey(absPath)) {
    return { reason: "PEM private key", ignorePattern: `/${relPath}` };
  }
  if (looksLikeDotenvxPrivateKey(absPath)) {
    return { reason: "contains a DOTENV_PRIVATE_KEY_* value", ignorePattern: `/${relPath}` };
  }
  return undefined;
}

const PEM_PRIVATE_KEY = /^-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/m;

function hasPemPrivateKey(absPath: string): boolean {
  const head = readHead(absPath, 64 * 1024);
  return head !== undefined && PEM_PRIVATE_KEY.test(head);
}

/** First `max` bytes of a file as UTF-8, or undefined when unreadable. */
function readHead(absPath: string, max: number): string | undefined {
  try {
    if (!statSync(absPath).isFile()) return undefined;
    const fd = openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(max);
      const n = readSync(fd, buf, 0, max, 0);
      return buf.subarray(0, n).toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

async function gitLines(cwd: string, args: string[]): Promise<string[]> {
  const res = await exec("git", args, { cwd, silent: true });
  if (res.exitCode !== 0) return [];
  return res.stdout.split("\0").filter((s) => s.length > 0);
}

async function repoRoot(cwd: string): Promise<string> {
  const res = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, silent: true });
  return res.exitCode === 0 && res.stdout.trim() ? res.stdout.trim() : cwd;
}

/** Every file in the index that the guard refuses.
 *
 *  Two passes. Staged additions and modifications are checked by name
 *  AND content. Every other path in the index is checked by name only:
 *  a `.env.keys` committed long ago is not in the staged diff, but the
 *  push that follows this commit publishes it all the same. */
export async function findStagedSecrets(cwd: string): Promise<SecretFileFinding[]> {
  const root = await repoRoot(cwd);
  const staged = new Set(
    await gitLines(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]),
  );
  const inHead = new Set(await gitLines(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]));
  const findings: SecretFileFinding[] = [];
  for (const path of staged) {
    const hit = secretFileReason(path, join(root, path));
    if (hit) findings.push({ path, ...hit, tracked: inHead.has(path) });
  }
  for (const path of await gitLines(root, ["ls-files", "-z"])) {
    if (staged.has(path)) continue;
    const hit = secretFileReason(path);
    if (hit) findings.push({ path, ...hit, tracked: inHead.has(path) });
  }
  return findings;
}

export interface SecretGuardOptions {
  /** Project name for the `hatchkit keys rotate <project>` line. */
  project?: string;
  /** Command the user re-runs once the files are fixed. */
  retry?: string;
}

/** Thrown when the index holds a secret. `findings` names every file. */
export class StagedSecretsError extends Error {
  readonly findings: SecretFileFinding[];
  constructor(findings: SecretFileFinding[], opts: SecretGuardOptions) {
    super(renderRefusal(findings, opts));
    this.name = "StagedSecretsError";
    this.findings = findings;
  }
}

function renderRefusal(findings: SecretFileFinding[], opts: SecretGuardOptions): string {
  const width = Math.max(...findings.map((f) => f.path.length));
  const lines = [
    "Refusing to commit: these files hold secrets and must never reach git:",
    ...findings.map((f) => `      ${f.path.padEnd(width)}  ${f.reason}`),
    "",
    findings.some((f) => !f.tracked)
      ? "  hatchkit took the new ones back out of the index. Nothing was committed, and the files are still on disk."
      : "  Nothing was committed.",
    "",
    "  1. Ignore them, so `git add -A` skips them:",
    ...[...new Set(findings.map((f) => f.ignorePattern))].map(
      (p) => `       echo '${p}' >> .gitignore`,
    ),
  ];
  const tracked = findings.filter((f) => f.tracked);
  if (tracked.length > 0) {
    lines.push(
      "  2. Stop tracking the ones already committed:",
      ...tracked.map((f) => `       git rm --cached -- ${f.path}`),
    );
  }
  const project = opts.project ?? "<project>";
  lines.push(
    `  ${tracked.length > 0 ? 3 : 2}. If any of them was ever committed or pushed, the secret is burned.`,
    "     Removing the file does not remove it from history. Rotate before writing new values:",
    `       hatchkit keys rotate ${project}      # a leaked .env.keys`,
    "     and rotate every credential the other files hold with its provider.",
  );
  if (opts.retry) lines.push("", `  Then re-run: ${opts.retry}`);
  return lines.join("\n");
}

/** Take refused files back out of the index. A path already in HEAD is
 *  reset to HEAD's copy; a new path is removed from the index only. */
async function unstage(root: string, findings: SecretFileFinding[]): Promise<void> {
  const staged = findings.filter((f) => !f.tracked).map((f) => f.path);
  const trackedModified = findings.filter((f) => f.tracked).map((f) => f.path);
  if (staged.length > 0) {
    await exec("git", ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", ...staged], {
      cwd: root,
      silent: true,
    });
  }
  if (trackedModified.length > 0) {
    await exec("git", ["reset", "--quiet", "--", ...trackedModified], { cwd: root, silent: true });
  }
}

/** Throw `StagedSecretsError` when the index holds a secret, after
 *  unstaging the new ones. Call it after any `git add` and before the
 *  `git commit` it prepares. */
export async function assertNothingSecretStaged(
  cwd: string,
  opts: SecretGuardOptions = {},
): Promise<void> {
  const findings = await findStagedSecrets(cwd);
  if (findings.length === 0) return;
  await unstage(await repoRoot(cwd), findings);
  throw new StagedSecretsError(findings, opts);
}

/** `git add -A`, then refuse if that staged a secret. The only way
 *  hatchkit stages a whole tree. */
export async function stageAllSafely(cwd: string, opts: SecretGuardOptions = {}): Promise<void> {
  const add = await exec("git", ["add", "-A"], { cwd, silent: true });
  if (add.exitCode !== 0) {
    throw new Error(`git add -A failed in ${cwd}: ${(add.stderr || add.stdout).trim()}`);
  }
  await assertNothingSecretStaged(cwd, opts);
}
