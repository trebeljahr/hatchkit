#!/usr/bin/env node
// Renders the four GitHub social preview candidates (1280x640 PNG) from
// docs/marketing/social-preview/template.html, plus a labelled review sheet.
//
//   node scripts/marketing/render-social-preview.mjs [--review-dir <dir>]
//   (or: pnpm marketing:social)
//
// Writes social-preview-{a,b,c,d}.png next to the template. With --review-dir,
// also copies the four PNGs there and writes review-sheet.jpg (A-D in a
// labelled 2x2 grid). Run capture-screenshots.mjs first: variant C embeds
// its create-secrets.png.

import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FONTS_HREF, SOCIAL_DIR, launchChromium } from "./lib.mjs";

const VARIANTS = [
  ["a", "A (dark): one command, nine things set up, keys included"],
  ["b", "B (light): the per-project setup list, all ticked"],
  ["c", "C (dark): real capture of the secrets steps"],
  ["d", "D (light): six secrets, made by and delivered to"],
];
const reviewIdx = process.argv.indexOf("--review-dir");
const reviewDir = reviewIdx > -1 ? process.argv[reviewIdx + 1] : null;

const browser = await launchChromium();
try {
  const template = pathToFileURL(join(SOCIAL_DIR, "template.html")).href;
  for (const [v] of VARIANTS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
    await page.goto(`${template}?v=${v}`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const out = join(SOCIAL_DIR, `social-preview-${v}.png`);
    await page.screenshot({ path: out });
    await page.close();
    const kb = Math.round(statSync(out).size / 1024);
    if (kb > 1000) throw new Error(`${out} is ${kb} KB; GitHub wants under 1 MB`);
    console.log(`wrote ${out} (${kb} KB)`);
  }

  if (reviewDir) {
    mkdirSync(reviewDir, { recursive: true });
    const tiles = VARIANTS.map(([v, label]) => {
      const file = `social-preview-${v}.png`;
      copyFileSync(join(SOCIAL_DIR, file), join(reviewDir, file));
      const data = readFileSync(join(SOCIAL_DIR, file)).toString("base64");
      return `<figure><img src="data:image/png;base64,${data}"><figcaption>${label}</figcaption></figure>`;
    }).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS_HREF}">
<style>body{margin:0;background:#e9ebf2;font-family:Inter,sans-serif}
.sheet{display:grid;grid-template-columns:640px 640px;gap:36px 32px;padding:40px;width:max-content}
figure{margin:0;display:flex;flex-direction:column;gap:14px}
img{width:640px;height:320px;display:block;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.18)}
figcaption{font-size:22px;font-weight:600;color:#10131b}</style></head>
<body><div class="sheet">${tiles}</div></body></html>`;
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const out = join(reviewDir, "review-sheet.jpg");
    await page.locator(".sheet").screenshot({ path: out, type: "jpeg", quality: 88 });
    await page.close();
    console.log(`wrote ${out}`);
  }
} finally {
  await browser.close();
}
