/**
 * The auth-account-security feature's client code passes the starter's own
 * lint gate.
 *
 * The starter's client runs `eslint . --max-warnings 0`, and its config
 * (eslint-config-next) carries React's hooks rules, `set-state-in-effect`
 * among them. Templates are `.tpl` files, so nothing lints them in this repo:
 * a component that sets state in an effect shipped in three templates and
 * every project that added the feature failed its own `pnpm lint`.
 *
 * So this test stamps a project: it copies the starter's packages, applies
 * the feature, and runs the client's real eslint over the client package,
 * starter files and generated files together. It needs an installed client
 * to borrow eslint and its plugins from (no network here):
 *
 *   - `HATCHKIT_LINT_CLIENT_DIR`, a client package with `node_modules`
 *     (CI points it at a stamped project's client); a value that has no
 *     eslint fails the test rather than skipping it;
 *   - otherwise `starter/packages/client` in this checkout, or in the main
 *     checkout when this is a worktree.
 *
 * With none of them installed the test says so and skips.
 *
 * Run: `node scripts/test.mjs test-auth-account-security-lint.ts`
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

import { applyAuthAccountSecurity } from "./src/features/auth-account-security/index.js";
import {
  AUTH_SECURITY_DEFAULT_OPTIONS,
  AUTH_SECURITY_OPTIONS,
  type AuthSecurityOption,
} from "./src/features/auth-account-security/types.js";

const STARTER = join(import.meta.dirname, "..", "starter");
const ESLINT_BIN = join("node_modules", ".bin", "eslint");

/** A client package whose node_modules holds eslint and its config. */
function installedClientDir(): string | null {
  const fromEnv = process.env.HATCHKIT_LINT_CLIENT_DIR;
  if (fromEnv) {
    if (!existsSync(join(fromEnv, ESLINT_BIN))) {
      throw new Error(`HATCHKIT_LINT_CLIENT_DIR=${fromEnv} has no ${ESLINT_BIN}`);
    }
    return fromEnv;
  }
  const candidates = [join(STARTER, "packages", "client")];
  // A worktree has no install of its own; the main checkout usually does.
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: import.meta.dirname,
    encoding: "utf8",
  });
  if (common.status === 0) {
    candidates.push(join(dirname(common.stdout.trim()), "starter", "packages", "client"));
  }
  return candidates.find((dir) => existsSync(join(dir, ESLINT_BIN))) ?? null;
}

const SKIPPED = new Set(["node_modules", ".next", "out", "dist", ".turbo"]);

/** The starter's packages the feature touches, without build output. */
function stampProject(): string {
  // Real path: eslint reports one, and macOS's tmpdir is a symlink.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "auth-account-security-lint-")));
  const filter = (src: string): boolean => !SKIPPED.has(basename(src));
  for (const rel of ["packages/client", "packages/server", "packages/shared"]) {
    cpSync(join(STARTER, rel), join(dir, rel), { recursive: true, filter });
  }
  for (const rel of ["tsconfig.base.json", "package.json"]) {
    if (existsSync(join(STARTER, rel))) cpSync(join(STARTER, rel), join(dir, rel));
  }
  return dir;
}

type EslintMessage = { ruleId: string | null; line: number; message: string; severity: number };
type EslintResult = { filePath: string; messages: EslintMessage[] };

function lintClient(project: string, installed: string): EslintResult[] {
  const client = join(project, "packages", "client");
  symlinkSync(join(installed, "node_modules"), join(client, "node_modules"), "dir");
  const run = spawnSync(
    join(client, ESLINT_BIN),
    [".", "--max-warnings", "0", "--format", "json"],
    {
      cwd: client,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (run.error) throw run.error;
  // eslint exits 1 on findings and 2 on a crash (a config that does not
  // load, a parser that is missing). Only the first has a JSON report.
  if (run.status !== 0 && run.status !== 1) {
    throw new Error(`eslint crashed (exit ${run.status}):\n${run.stderr}`);
  }
  return JSON.parse(run.stdout) as EslintResult[];
}

const failures: string[] = [];
async function expect(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

const installed = installedClientDir();
if (!installed) {
  console.log(
    "\nauth-account-security lint: skipped. No installed starter client to borrow eslint from; run `pnpm install` in starter/ or set HATCHKIT_LINT_CLIENT_DIR.\n",
  );
  process.exit(0);
}

console.log(`\nauth-account-security lint (eslint from ${installed}):`);

const SELECTIONS: Array<{ label: string; options: readonly AuthSecurityOption[] }> = [
  { label: "every option", options: AUTH_SECURITY_OPTIONS },
  { label: "the default options", options: AUTH_SECURITY_DEFAULT_OPTIONS },
];

for (const selection of SELECTIONS) {
  await expect(`the client lints clean with ${selection.label}`, async () => {
    const project = stampProject();
    try {
      const audit = await applyAuthAccountSecurity({
        projectDir: project,
        projectName: "Lint App",
        options: [...selection.options],
        hasNativeClient: true,
        hasEmailTransport: false,
      });
      const generated = audit.written.filter((rel) => rel.startsWith("packages/client/"));
      assert.ok(generated.length > 0, "the feature wrote no client files");

      const client = join(project, "packages", "client");
      const results = lintClient(project, installed);
      const linted = new Set(results.map((result) => relative(project, result.filePath)));
      for (const rel of generated.filter((file) => /\.tsx?$/.test(file))) {
        assert.ok(linted.has(rel), `eslint never looked at ${rel}`);
      }
      const findings = results.flatMap((result) =>
        result.messages.map(
          (message) =>
            // The React Compiler rules explain themselves over twenty lines;
            // the first one names the problem.
            `${relative(client, result.filePath)}:${message.line} ${message.ruleId ?? "parse"}: ${message.message.split("\n")[0]}`,
        ),
      );
      if (findings.length > 0) {
        assert.fail(`${findings.length} eslint finding(s):\n      ${findings.join("\n      ")}`);
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nThe generated client passes its lint gate.\n");
