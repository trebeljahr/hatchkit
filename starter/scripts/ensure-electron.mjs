#!/usr/bin/env node
/*
 * Make sure node_modules/electron has its binary, and say clearly when not.
 *
 * Electron 42's package has NO install script. The binary is downloaded the
 * first time something calls `require("electron")` (or runs the package's
 * `install.js`), so a fresh `pnpm install` leaves `node_modules/electron/dist`
 * absent and the first user of it — `pnpm dev:desktop`, Playwright's
 * `_electron.launch` — downloads 100+ MB mid-run, or fails. Adding `electron`
 * to pnpm's `allowBuilds` does nothing, because there is no build to allow.
 *
 * So the desktop build, the desktop e2e harness and CI call this first.
 *
 * Measured trap (2026-09-16): under Node 26, install.js's extract-zip step
 * stops partway and the process still exits 0 — `dist/` holds a truncated
 * Electron.app and no `path.txt`. Node 24 (this repo's .nvmrc) extracts it
 * fully. The checks below catch the truncated state instead of trusting the
 * exit code.
 *
 * Usage: node scripts/ensure-electron.mjs   (prints the executable path)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "package.json"));

/** The Node major the extraction was measured to complete under. */
export const SUPPORTED_NODE_MAJOR = 24;

export function electronPackageDir() {
  return dirname(require.resolve("electron/package.json"));
}

/** The executable path when the install is complete, else a reason string. */
function inspect(dir) {
  const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const pathFile = join(dir, "path.txt");
  const versionFile = join(dir, "dist", "version");
  if (!existsSync(pathFile)) return { problem: "no path.txt" };
  if (!existsSync(versionFile)) return { problem: "no dist/version" };
  const installed = readFileSync(versionFile, "utf8").trim().replace(/^v/, "");
  if (installed !== version) return { problem: `dist is ${installed}, package is ${version}` };
  const executable = join(dir, "dist", readFileSync(pathFile, "utf8").trim());
  if (!existsSync(executable)) return { problem: `missing ${executable}` };
  return { executable };
}

export function ensureElectron({ quiet = false } = {}) {
  const dir = electronPackageDir();
  let state = inspect(dir);
  if (state.executable) return state.executable;

  if (!quiet) console.log(`  Electron binary not installed (${state.problem}); downloading…`);
  const result = spawnSync(process.execPath, [join(dir, "install.js")], {
    cwd: dir,
    stdio: "inherit",
  });
  state = inspect(dir);
  if (result.status === 0 && state.executable) return state.executable;

  const major = Number(process.versions.node.split(".")[0]);
  throw new Error(
    `Electron's binary is still not usable after install.js (${state.problem}).\n` +
      (major !== SUPPORTED_NODE_MAJOR
        ? `  You are on Node ${process.versions.node}; this repo pins ` +
          `Node ${SUPPORTED_NODE_MAJOR}\n` +
          `  (.nvmrc), and under Node 26 install.js was measured to stop mid-extraction\n` +
          "  and exit 0.\n"
        : "") +
      `  Delete ${join(dir, "dist")} and ${join(dir, "path.txt")}, then re-run this with ` +
      `Node ${SUPPORTED_NODE_MAJOR}.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    console.log(ensureElectron());
  } catch (err) {
    console.error(`\n  ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
}
