#!/usr/bin/env node
// Writes docs/marketing/manifest.json: every image in the marketing folder
// with its purpose, pixel size, bytes, SHA-256 and the command that made it.
// Run after capture-screenshots.mjs and render-social-preview.mjs. A file
// whose SHA-256 is unchanged keeps its previous `modified` date, so a fresh
// checkout (where every mtime is today) does not rewrite the dates.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
  "screenshots/create-secrets.png": {
    purpose: "Social preview C: sandboxed create encrypting .env.production, then secrets rotate --dry-run",
    madeBy: SHOTS,
  },
  "social-preview/social-preview-a.png": {
    purpose: "GitHub social preview candidate A (dark): hatchkit create fanning out to the nine things it sets up",
    madeBy: SOCIAL,
  },
  "social-preview/social-preview-b.png": {
    purpose: "GitHub social preview candidate B (light): the per-project setup list, every item ticked",
    madeBy: SOCIAL,
  },
  "social-preview/social-preview-c.png": {
    purpose: "GitHub social preview candidate C (dark): real terminal capture of the secrets steps",
    madeBy: SOCIAL,
  },
  "social-preview/social-preview-d.png": {
    purpose: "GitHub social preview candidate D (light): six secrets, who makes each and where it goes",
    madeBy: SOCIAL,
  },
  "social-preview/social-preview-a3-1.png": {
    purpose: "GitHub social preview round 3, A3-1 (dark): wordmark, hatchkit create pill and nine thing/provider nodes, no other text",
    madeBy: `${SOCIAL} --round 3`,
  },
  "social-preview/social-preview-a3-2.png": {
    purpose: "GitHub social preview round 3, A3-2 (dark): A3-1 plus the line 'Automates the drudgery of starting a new project'",
    madeBy: `${SOCIAL} --round 3`,
  },
  "social-preview/social-preview-a3-3.png": {
    purpose: "GitHub social preview round 3, A3-3 (light): A3-2 in the light palette",
    madeBy: `${SOCIAL} --round 3`,
  },
  "social-preview/og-wordmark.png": {
    purpose: "og:image, 1200x630: the live card A3-2 (wordmark, line, pill and nine nodes) laid out at 1.91:1",
    madeBy: `${SOCIAL} --og`,
  },
  "social-preview/og-clean.png": {
    purpose: "og:image without text, 1200x630: A3-2's pill and nine nodes, no wordmark or line (og-clean.html)",
    madeBy: `${SOCIAL} --og`,
  },
};

const manifestPath = join(MARKETING_DIR, "manifest.json");
const previous = new Map(
  existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")).files.map((f) => [f.file, f])
    : [],
);

// YYYY-MM-DD in the machine's time zone ("sv-SE" formats dates that way).
const localDate = (d) => d.toLocaleDateString("sv-SE");

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
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const prev = previous.get(rel);
    files.push({
      file: rel,
      ...(META[rel] ?? { purpose: "", madeBy: "" }),
      width,
      height,
      bytes: buf.length,
      sha256,
      modified: prev?.sha256 === sha256 ? prev.modified : localDate(statSync(abs).mtime),
    });
  }
}

const manifest = { schemaVersion: 1, project: "hatchkit", files };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${manifestPath} (${files.length} files)`);
