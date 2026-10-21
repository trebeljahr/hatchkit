#!/usr/bin/env node
/*
 * release-packages — publish every package of a hatchkit release that
 * npm does not have yet. release.mjs runs it after build + typecheck
 * and before the push.
 *
 * Publish order is topological, with the CLI last so a scaffold made by
 * the just-published CLI finds its plugin dep on the registry:
 *   1. @hatchkit/dev-shared        (no @hatchkit/* deps)
 *   2. @hatchkit/dev-plugin-next   (depends on dev-shared)
 *   3. @hatchkit/dev-plugin-vite   (depends on dev-shared)
 *   4. @hatchkit/mcp              (operator tools; depends on the SDK)
 *   5. hatchkit                    (the CLI; depends on dev-shared)
 *
 * Version sync: every `@hatchkit/dev-*` package matches the CLI's
 * version. release-bump.mjs bumps them in lockstep; this script refuses
 * to publish if anything drifted (a manual `npm version` in one package
 * would do it).
 *
 * Safe to re-run: a package whose version `npm view` already finds is
 * skipped, so `pnpm release:resume` after a stopped publish only
 * publishes what is missing. Each publish gets the terminal, so npm can
 * ask for 2FA (see publishCommand in release-lib.mjs).
 *
 * RELEASE_SKIP_PACKAGES=1 skips the @hatchkit/dev-* packages; the CLI
 * is still published.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envWithPnpm, isPublished, publishCommand, resolvePnpm } from "./release-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = join(here, "..");
const repoRoot = execSync("git rev-parse --show-toplevel", {
  cwd: cliDir,
  encoding: "utf-8",
}).trim();

const DEV_PACKAGES = ["dev-shared", "dev-plugin-next", "dev-plugin-vite"];

const cliVersion = readJson(join(cliDir, "package.json")).version;
if (!cliVersion) {
  console.error("  release-packages: couldn't read cli/package.json version. Aborting.");
  process.exit(1);
}

// Sanity check: every dev-* package must already be bumped to cliVersion.
// release-bump.mjs does this; if someone skipped it, fail loud.
for (const name of DEV_PACKAGES) {
  const pkgPath = join(repoRoot, "packages", name, "package.json");
  if (!existsSync(pkgPath)) {
    console.error(`  release-packages: missing packages/${name}/package.json — aborting.`);
    process.exit(1);
  }
  const pkg = readJson(pkgPath);
  if (pkg.version !== cliVersion) {
    console.error(
      `  release-packages: packages/${name}/package.json is at ${pkg.version} but CLI is at ${cliVersion}.`,
    );
    console.error(
      "  release-bump.mjs should have aligned these. Did you run a release flow out of order?",
    );
    process.exit(1);
  }
}

if (readJson(join(repoRoot, "mcp", "package.json")).version !== cliVersion) {
  throw new Error("mcp/package.json must match the CLI release version.");
}
const pnpm = resolvePnpm();
if (!pnpm) {
  console.error("  release-packages: pnpm not found (not on PATH, no corepack). Aborting.");
  process.exit(1);
}
const { env, cleanup } = envWithPnpm(pnpm);
process.on("exit", cleanup);

const skipDev = process.env.RELEASE_SKIP_PACKAGES === "1";
if (skipDev) console.log("  release-packages: RELEASE_SKIP_PACKAGES=1 — CLI and operator MCP only.");
const dirs = [...(skipDev ? [] : DEV_PACKAGES.map((name) => join("packages", name))), "mcp", "cli"];

console.log(`  release-packages: publishing v${cliVersion}.`);

for (const dir of dirs) {
  const pkgDir = join(repoRoot, dir);
  const { name } = readJson(join(pkgDir, "package.json"));
  console.log(`\n  ── ${name}@${cliVersion}  (${dir}/)`);

  if (published(name)) {
    console.log("  release-packages: already on npm — skipping.");
    continue;
  }

  // Each dev package builds itself (tsc → dist). The CLI was built by
  // release.mjs, and its prepublishOnly builds it again on publish.
  if (dir !== "cli") run(pnpm.command, [...pnpm.args, "run", "build"], pkgDir);

  const publish = publishCommand(pnpm, pkgDir, env);
  const res = spawnSync(publish.command, publish.args, publish.options);
  if (res.status === 0) continue;

  // A publish that raced another one, or reported failure after the
  // upload, still leaves the version on npm — which is the goal.
  if (published(name)) {
    console.log("  release-packages: on npm after all — continuing.");
    continue;
  }
  console.error(`\n  ✗ release-packages: pnpm publish failed for ${name}@${cliVersion}.`);
  process.exit(1);
}

console.log(`\n  ✓ release-packages: every package of v${cliVersion} is on npm.`);

function published(name) {
  try {
    return isPublished(name, cliVersion, { env });
  } catch (err) {
    console.error(`\n  ✗ release-packages: ${err.message}`);
    process.exit(1);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(`  release-packages: couldn't read ${path} — ${err.message}`);
    process.exit(1);
  }
}

function run(bin, args, cwd) {
  const res = spawnSync(bin, args, { cwd, env, stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`  release-packages: ${bin} ${args.join(" ")} failed (exit ${res.status}).`);
    process.exit(res.status ?? 1);
  }
}
