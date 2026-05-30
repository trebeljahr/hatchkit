#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = join(here, "..");
const repoRoot = join(cliDir, "..");
const packagePath = join(cliDir, "package.json");
const changelogPath = join(repoRoot, "CHANGELOG.md");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(`print-changelog: couldn't read ${path}: ${err.message}`);
    process.exit(1);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let changelog;
try {
  changelog = readFileSync(changelogPath, "utf-8").replace(/\r\n/g, "\n");
} catch (err) {
  console.error(`print-changelog: couldn't read ${changelogPath}: ${err.message}`);
  process.exit(1);
}

const version = readJson(packagePath).version;
if (!version) {
  console.error(`print-changelog: missing version in ${packagePath}`);
  process.exit(1);
}

const versionHeading = new RegExp(`^##\\s+\\[?${escapeRegExp(version)}\\]?(?:\\s|$)`);
const lines = changelog.split("\n");
const start = lines.findIndex((line) => versionHeading.test(line));

if (start === -1) {
  console.error(`print-changelog: couldn't find CHANGELOG.md heading "## ${version}"`);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (lines[i].startsWith("## ")) {
    end = i;
    break;
  }
}

const section = lines
  .slice(start + 1, end)
  .join("\n")
  .trim();
if (!section) {
  console.error(`print-changelog: CHANGELOG.md section "## ${version}" is empty`);
  process.exit(1);
}

process.stdout.write(`${section}\n`);
