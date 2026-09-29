import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINT_GATE_FILES,
  PREPARE_SCRIPT,
  PRE_PUSH_HOOK_REL_PATH,
  ROOT_LINT_FIX_SCRIPT,
  ROOT_LINT_SCRIPT,
  applyLintGate,
  hasHooksPathPrepare,
  mergePrepareScript,
} from "./src/scaffold/lint-gate.js";

// ── The root command ──────────────────────────────────────────────────

// `--if-present`, not a hardcoded filter list: scaffolding prunes packages a
// feature set does not need, and a root script naming an absent package fails
// for the wrong reason.
assert.match(ROOT_LINT_SCRIPT, /--if-present/);
assert.match(ROOT_LINT_SCRIPT, /^pnpm -r /);
assert.match(ROOT_LINT_FIX_SCRIPT, /lint:fix/);

// ── prepare ───────────────────────────────────────────────────────────

// `prepare` runs on every install, including in CI and outside a git
// checkout, so it must never fail the install.
assert.match(PREPARE_SCRIPT, /\|\| true$/);
assert.match(PREPARE_SCRIPT, /core\.hooksPath \.githooks/);

assert.equal(mergePrepareScript(undefined), PREPARE_SCRIPT);
assert.equal(mergePrepareScript(""), PREPARE_SCRIPT);
assert.equal(mergePrepareScript("   "), PREPARE_SCRIPT);

// An existing `prepare` is appended to, never replaced — it is a popular hook.
assert.equal(mergePrepareScript("pnpm build"), `pnpm build && ${PREPARE_SCRIPT}`);

// Already routed at the tracked hooks, in any spelling → nothing to do.
assert.equal(mergePrepareScript(PREPARE_SCRIPT), null);
assert.equal(mergePrepareScript("git config core.hooksPath .hooks"), null);

assert.equal(hasHooksPathPrepare(JSON.stringify({ scripts: { prepare: PREPARE_SCRIPT } })), true);
assert.equal(hasHooksPathPrepare(JSON.stringify({ scripts: { prepare: "pnpm build" } })), false);
assert.equal(hasHooksPathPrepare(JSON.stringify({ scripts: {} })), false);
assert.equal(hasHooksPathPrepare("{ not json"), false);

// ── The package.json pass ─────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "hatchkit-lint-gate-"));
try {
  const read = () => JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
  const write = (value: unknown) =>
    writeFileSync(join(dir, "package.json"), JSON.stringify(value, null, 2), "utf-8");

  write({ scripts: { build: "pnpm -r build" } });
  // A dry run reports the same scripts and writes none of them, so
  // `hatchkit update --dry-run` can name the retrofit without applying it.
  const before = readFileSync(join(dir, "package.json"), "utf-8");
  const planned = applyLintGate(dir, { dryRun: true });
  assert.equal(planned.changed, true);
  assert.deepEqual(planned.wrote.sort(), ["lint", "lint:fix", "prepare"]);
  assert.equal(readFileSync(join(dir, "package.json"), "utf-8"), before, "dry run writes nothing");

  const first = applyLintGate(dir);
  assert.equal(first.changed, true);
  assert.deepEqual(first.wrote.sort(), ["lint", "lint:fix", "prepare"]);

  const pkg = read();
  assert.equal(pkg.scripts.lint, ROOT_LINT_SCRIPT);
  assert.equal(pkg.scripts["lint:fix"], ROOT_LINT_FIX_SCRIPT);
  assert.equal(pkg.scripts.prepare, PREPARE_SCRIPT);
  assert.equal(pkg.scripts.build, "pnpm -r build", "unrelated scripts survive");

  // Idempotent: a second run writes nothing, so `hatchkit update` can call it
  // unconditionally without touching the file.
  const second = applyLintGate(dir);
  assert.equal(second.changed, false);
  assert.deepEqual(second.wrote, []);

  // An edited root lint command is a project decision. The gate is "there is
  // one root command", not "it is exactly this one".
  write({ scripts: { lint: "biome ci ." } });
  applyLintGate(dir);
  assert.equal(read().scripts.lint, "biome ci .");

  // A missing package.json (an adopted repo mid-setup) must not throw.
  rmSync(join(dir, "package.json"));
  assert.deepEqual(applyLintGate(dir), { changed: false, wrote: [] });

  // Neither must an unparseable one.
  writeFileSync(join(dir, "package.json"), "{ not json", "utf-8");
  assert.deepEqual(applyLintGate(dir), { changed: false, wrote: [] });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── The retrofit file list ────────────────────────────────────────────

assert.ok(LINT_GATE_FILES.includes(PRE_PUSH_HOOK_REL_PATH));
assert.ok(LINT_GATE_FILES.includes(".github/workflows/lint.yml"));
for (const rel of LINT_GATE_FILES) assert.ok(!rel.startsWith("/"), rel);

console.log("lint gate checks ok");
