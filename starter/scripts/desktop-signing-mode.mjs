#!/usr/bin/env node
/*
 * Print how a desktop channel will be signed, for the release workflow:
 *
 *   node scripts/desktop-signing-mode.mjs <mac|win|linux>
 *
 * Writes `mode=signed|unsigned` to $GITHUB_OUTPUT when it is set. The decision
 * is `resolveSigning` in scripts/lib/desktop-release.mjs, the same function
 * `scripts/build-desktop.mjs` calls, so the workflow's verify steps and the
 * build can never disagree about what signed this artifact.
 *
 * A partial secret set exits 1 here, in seconds, before the export and the
 * packaging run.
 */
import { appendFileSync } from "node:fs";

import { resolveSigning } from "./lib/desktop-release.mjs";

const channel = process.argv[2];
let mode;
try {
  mode = resolveSigning(channel, process.env).mode;
} catch (err) {
  const message = (err instanceof Error ? err.message : String(err)).split("\n")[0];
  console.log(`::error::${message}`);
  process.exit(1);
}
console.log(`${channel}: ${mode}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`);
