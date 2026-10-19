/*
 * release-lib — helpers shared by release.mjs and release-packages.mjs.
 *
 * Plain .mjs with no dependencies: the release runs these before
 * anything is built. test-release-flow.ts imports them directly.
 */

import { spawnSync } from "node:child_process";
import { constants, accessSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, extname, join } from "node:path";

/** True when `name` is an executable file in one of env.PATH's directories. */
export function commandOnPath(name, env = process.env) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // not in this directory
    }
  }
  return false;
}

/**
 * How this process can run pnpm, or null when it can't.
 *
 * A release is often started where `pnpm` is not on PATH: Homebrew's
 * Node 25+ ships no corepack, and pnpm then lives only inside an nvm
 * version. The outer `pnpm release` still runs (by absolute path, or
 * from a shell that had it), but pnpm does not put itself on PATH for
 * the scripts it runs, so every nested `pnpm …` failed with "command
 * not found".
 *
 * Order: the pnpm that started this script (npm_execpath), then `pnpm`
 * on PATH, then `corepack pnpm`.
 */
export function resolvePnpm({
  env = process.env,
  execPath = process.execPath,
  onPath = commandOnPath,
} = {}) {
  const entry = env.npm_execpath;
  if (entry && /^pnpm(\.[cm]?js)?$/.test(basename(entry))) {
    // pnpm.cjs / pnpm.mjs under node; a standalone `pnpm` binary runs itself.
    const viaNode = [".js", ".cjs", ".mjs"].includes(extname(entry));
    return viaNode
      ? { command: execPath, args: [entry], source: entry }
      : { command: entry, args: [], source: entry };
  }
  if (onPath("pnpm", env)) return { command: "pnpm", args: [], source: "pnpm on PATH" };
  if (onPath("corepack", env)) {
    return { command: "corepack", args: ["pnpm"], source: "corepack on PATH" };
  }
  return null;
}

/**
 * An env in which a bare `pnpm` runs the resolved pnpm, for every child
 * process. package.json scripts call `pnpm` themselves (the CLI's build
 * runs `pnpm --filter @hatchkit/dev-shared run build`, and publishing
 * runs `prepublishOnly`), so resolving pnpm for our own calls is not
 * enough. Unless the resolved pnpm IS `pnpm` on PATH, a one-line shell
 * shim goes first on PATH. `cleanup()` removes it.
 */
export function envWithPnpm(pnpm, { env = process.env, shimParent = tmpdir() } = {}) {
  if (pnpm.command === "pnpm" && pnpm.args.length === 0) return { env, cleanup: () => {} };
  const dir = mkdtempSync(join(shimParent, "hatchkit-release-pnpm-"));
  const target = [pnpm.command, ...pnpm.args].map(shellQuote).join(" ");
  const shim = join(dir, "pnpm");
  writeFileSync(shim, `#!/bin/sh\nexec ${target} "$@"\n`);
  chmodSync(shim, 0o755);
  return {
    env: { ...env, PATH: `${dir}${delimiter}${env.PATH ?? ""}` },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether name@version is on the registry. `npm view` prints the
 * version when it is, and fails with E404 when the package or that
 * version is missing. Any other failure (offline, auth) throws: a wrong
 * guess either publishes into an error or skips a package that is not
 * on npm.
 */
export function isPublished(name, version, { env = process.env, run = runNpm } = {}) {
  const res = run(["view", `${name}@${version}`, "version"], env);
  if (res.status === 0) return res.stdout.trim().split(/\s+/).includes(version);
  const output = `${res.stderr ?? ""}\n${res.stdout ?? ""}`;
  if (/\bE404\b/.test(output)) return false;
  const reason = output.trim().split("\n")[0] || `exit ${res.status}`;
  throw new Error(`npm view ${name}@${version} failed: ${reason}`);
}

function runNpm(args, env) {
  const res = spawnSync("npm", args, { env, encoding: "utf-8" });
  if (res.error) return { status: 1, stdout: "", stderr: res.error.message };
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * `pnpm publish` for one package directory. stdio is inherited on
 * purpose: with 2FA for publishing, npm prints "Authenticate your
 * account at: <url>" and waits for ENTER. Without a terminal it fails
 * with EOTP instead, which is how the v0.2.19 release stopped.
 *
 * pnpm, not npm, also for the CLI: it rewrites `workspace:*` to the
 * real version. `npm publish` shipped hatchkit 0.2.16–0.2.19 with
 * `"@hatchkit/dev-shared": "workspace:*"`, which npm cannot install.
 *
 * `--no-git-checks`: the release commit and tag are made by
 * release-bump.mjs, and release-prep.mjs checked the tree first.
 */
export function publishCommand(pnpm, cwd, env) {
  return {
    command: pnpm.command,
    args: [...pnpm.args, "publish", "--access", "public", "--no-git-checks"],
    options: { cwd, env, stdio: "inherit" },
  };
}

/** The `git push` that publishes a release: the current branch and its
 *  tag, both or neither (`--atomic`). The tag is named explicitly, so a
 *  lightweight tag from an older release-bump goes out too. */
export function pushArgs({ remote, branchRef, version }) {
  const head = branchRef ? `HEAD:${branchRef}` : "HEAD";
  return ["push", "--atomic", remote, head, `refs/tags/v${version}`];
}
