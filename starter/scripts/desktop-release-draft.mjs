#!/usr/bin/env node
/*
 * Collect what the desktop release matrix built into the files of a DRAFT
 * GitHub Release:
 *
 *   node scripts/desktop-release-draft.mjs --artifacts <dir> --out <dir> \
 *     [--staging-percentage <0-100 or "">]
 *
 * `<artifacts>` holds one folder per leg, named as the workflow uploads them:
 * `desktop-<channel>-<mode>`. The rules for what is attached are `releasePlan`
 * and `feedProblems` in scripts/lib/desktop-release.mjs. This script does the
 * file work: it reads each update feed, checks that every file the feed names is
 * attached with the stated sha512 and size, copies the files to `<out>`, and
 * writes one SHA256SUMS.txt over them. Warnings are printed as workflow
 * annotations; any problem exits 1 and nothing is uploaded.
 *
 * `--staging-percentage` writes `stagingPercentage` into every feed it copies
 * (scripts/lib/desktop-rollout.mjs → `rewriteFeed`: one line, every other byte
 * kept). Empty or 100 leaves the key out, so every install is offered the
 * release. The feeds are checked against the attached files before AND after
 * the rewrite, so the sha512 and size guarantees do not depend on it.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { feedProblems, releasePlan } from "./lib/desktop-release.mjs";
import {
  describeStaging,
  loadFeedParser,
  parseStagingPercentage,
  rewriteFeed,
} from "./lib/desktop-rollout.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Resolved on first use, not at import: the argument checks below must be able
// to refuse a bad value before anything is read, copied or installed.
let feedParser = null;
const yaml = {
  load: (text) => (feedParser ??= loadFeedParser(repoRoot)).load(text),
};

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const artifactsDir = option("--artifacts");
const outDir = option("--out");
if (!artifactsDir || !outDir) {
  console.error(
    'Usage: node scripts/desktop-release-draft.mjs --artifacts <dir> --out <dir> [--staging-percentage <0-100 or "">]',
  );
  process.exit(1);
}
let stagingPercentage;
try {
  stagingPercentage = parseStagingPercentage(option("--staging-percentage"));
} catch (err) {
  console.log(`::error::${err.message}`);
  process.exit(1);
}

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const MODES = new Set(["signed", "unsigned"]);
const legs = [];
for (const name of existsSync(artifactsDir) ? readdirSync(artifactsDir) : []) {
  const match = /^desktop-(.+)-([a-z]+)$/.exec(name);
  if (!match || !MODES.has(match[2])) continue;
  legs.push({ channel: match[1], mode: match[2], files: walk(join(artifactsDir, name)) });
}

const plan = releasePlan(legs);
const problems = [...plan.problems];

const attached = new Map();
for (const file of plan.upload) {
  const name = basename(file);
  if (attached.has(name)) {
    problems.push(`Two legs built a file named ${name}.`);
    continue;
  }
  const bytes = readFileSync(file);
  attached.set(name, {
    file,
    size: bytes.length,
    sha512: createHash("sha512").update(bytes).digest("base64"),
  });
}

const feeds = plan.feeds.map((file) => {
  const text = readFileSync(file, "utf8");
  return { name: basename(file), text, feed: yaml.load(text) };
});
problems.push(...feedProblems(feeds, attached));

// The staged copies are what is uploaded, so they are checked the same way: a
// rewrite that broke a checksum would ship an update every installed app
// downloads and then rejects.
const staged = [];
for (const { name, text } of feeds) {
  try {
    const { text: next } = rewriteFeed({ name, text, percent: stagingPercentage, parse: yaml.load });
    staged.push({ name, text: next, feed: yaml.load(next) });
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
}
problems.push(...feedProblems(staged, attached));

for (const leg of legs) console.log(`${leg.channel}: ${leg.mode}, ${leg.files.length} files`);
for (const warning of plan.warnings) console.log(`::warning::${warning}`);
if (problems.length > 0) {
  for (const problem of problems) console.log(`::error::${problem}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const sums = [];
for (const [name, { file }] of attached) {
  copyFileSync(file, join(outDir, name));
  sums.push(`${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${name}`);
}
for (const { name, text } of staged) writeFileSync(join(outDir, name), text);
const ordered = sums.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n");
writeFileSync(join(outDir, "SHA256SUMS.txt"), `${ordered}\n`);
console.log(`\n${attached.size} files and ${feeds.length} update feeds ready in ${outDir}`);
console.log(`The feeds offer this release to ${describeStaging(stagingPercentage)}.`);
