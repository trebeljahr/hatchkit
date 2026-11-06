#!/usr/bin/env node
// Writes docs/marketing/manifest.json: every image in the marketing folder
// with its purpose, pixel size, bytes, SHA-256 and the command that made it.
// Run after capture-screenshots.mjs and render-social-preview.mjs.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { MARKETING_DIR } from "./lib.mjs";

const SHOTS = "node scripts/marketing/capture-screenshots.mjs";
const SOCIAL = "node scripts/marketing/render-social-preview.mjs";

const META = {
  "screenshots/create-dry-run.png": {
    purpose: "README hero: hatchkit create --dry-run plan for an example project (nimbus)",
    madeBy: SHOTS,
  },
  "screenshots/status.png": {
    purpose: "README quickstart: hatchkit status on a machine with only GitHub configured",
    madeBy: SHOTS,
  },
  "screenshots/help.png": {
    purpose: "Command overview (hatchkit --help, Getting started and Projects groups)",
    madeBy: SHOTS,
  },
  "social-preview/social-preview-a.png": {
    purpose: "GitHub social preview candidate A: screenshot-led",
    madeBy: SOCIAL,
  },
  "social-preview/social-preview-b.png": {
    purpose: "GitHub social preview candidate B: typographic, docs-site brand",
    madeBy: SOCIAL,
  },
  "social-preview/social-preview-c.png": {
    purpose: "GitHub social preview candidate C: light, setup/create/sync/backup strip",
    madeBy: SOCIAL,
  },
};

function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const files = [];
for (const dir of ["screenshots", "social-preview"]) {
  for (const name of readdirSync(join(MARKETING_DIR, dir)).sort()) {
    if (!/\.(png|jpe?g|webp)$/.test(name)) continue;
    const abs = join(MARKETING_DIR, dir, name);
    const rel = relative(MARKETING_DIR, abs);
    const buf = readFileSync(abs);
    const [width, height] = pngSize(buf) ?? [null, null];
    files.push({
      file: rel,
      ...(META[rel] ?? { purpose: "", madeBy: "" }),
      width,
      height,
      bytes: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
      modified: statSync(abs).mtime.toISOString().slice(0, 10),
    });
  }
}

const manifest = { schemaVersion: 1, project: "hatchkit", files };
writeFileSync(join(MARKETING_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${join(MARKETING_DIR, "manifest.json")} (${files.length} files)`);
