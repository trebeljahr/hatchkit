#!/usr/bin/env node
// Renders the GitHub social preview candidates (1280x640 PNG) from
// docs/marketing/social-preview/template.html, the two og:image cards
// (1200x630 PNG), plus a labelled review sheet.
//
//   node scripts/marketing/render-social-preview.mjs [--round 2|3] [--review-dir <dir>]
//   node scripts/marketing/render-social-preview.mjs --og
//   (or: pnpm marketing:social)
//
// Writes social-preview-<id>.png next to the template for every variant, or
// only one round's variants with --round. With --review-dir, also copies that
// round's PNGs there as social-preview-a/b/c(/d).png and writes
// review-sheet.jpg with the cards side by side, labelled. Run
// capture-screenshots.mjs first: round 2's variant C embeds its
// create-secrets.png.
//
// Without --round it also writes the og:image cards, og-wordmark.png and
// og-clean.png; --og writes only those two. They are laid out at 1280x672 CSS
// px (the same 1.905:1 shape as 1200x630, so the 1280 px wide layouts hold),
// shot at deviceScaleFactor 2 and downscaled to exactly 1200x630 with
// ImageMagick (`magick`), which must be installed.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FONTS_HREF, SOCIAL_DIR, launchChromium } from "./lib.mjs";

// [template variant id, review-sheet label, review copy letter]
const ROUNDS = {
  2: [
    ["a", "A (dark): one command, nine things set up, keys included", "a"],
    ["b", "B (light): the per-project setup list, all ticked", "b"],
    ["c", "C (dark): real capture of the secrets steps", "c"],
    ["d", "D (light): six secrets, made by and delivered to", "d"],
  ],
  3: [
    ["a3-1", "A (dark): wordmark, command, nine nodes, no line", "a"],
    ["a3-2", "B (dark): A plus \"Automates the drudgery of starting a new project\"", "b"],
    ["a3-3", "C (light): B in the light palette", "c"],
  ],
};
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const round = arg("--round");
const reviewDir = arg("--review-dir");
const ogOnly = process.argv.includes("--og");
if (round && !ROUNDS[round]) throw new Error(`--round must be one of ${Object.keys(ROUNDS).join(", ")}`);
if (reviewDir && !round) throw new Error("--review-dir needs --round, so the sheet holds one round's cards");
if (ogOnly && round) throw new Error("--og and --round do not go together");
const variants = ogOnly ? [] : round ? ROUNDS[round] : Object.values(ROUNDS).flat();

// og:image cards: [output, page in SOCIAL_DIR, query, override CSS, page script].
//   og-wordmark.png  a3-2 as it is (large egg mark and wordmark, the line
//     broken after "starting", the pill at y 368). The 640 px card moves down
//     16 px and only its background stretches 16 px past the top and bottom.
//   og-clean.png     og-clean.html: a3-2 without the wordmark and the line.
const OG_CARDS = [
  [
    "og-wordmark.png",
    "template.html",
    "v=a3-2",
    `html, body { height: 672px !important; }
     body { background: #0b0d12; }
     .card { top: 16px; overflow: visible !important; clip-path: inset(-16px 0); }
     .hatch, .glow { top: -16px !important; bottom: -16px !important; }
     .topline { top: -16px !important; }`,
  ],
  ["og-clean.png", "og-clean.html", "", ""],
];

// Pipes a @2x screenshot through ImageMagick to exactly 1200x630. The date and
// time chunks are left out so an unchanged card keeps its SHA-256.
function downscaleOg(png, out) {
  try {
    execFileSync(
      "magick",
      ["png:-", "-resize", "1200x630!", "-define", "png:exclude-chunks=date,time", out],
      { input: png },
    );
  } catch (err) {
    if (err.code === "ENOENT") throw new Error("ImageMagick's `magick` is needed for the og:image cards (brew install imagemagick)");
    throw err;
  }
}

const browser = await launchChromium();
try {
  const template = pathToFileURL(join(SOCIAL_DIR, "template.html")).href;
  for (const [v] of variants) {
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

  for (const [name, file, query, css, script] of round ? [] : OG_CARDS) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 672 }, deviceScaleFactor: 2 });
    const url = pathToFileURL(join(SOCIAL_DIR, file)).href + (query ? `?${query}` : "");
    await page.goto(url, { waitUntil: "networkidle" });
    if (css) await page.addStyleTag({ content: css });
    if (script) await page.evaluate(script);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
    const out = join(SOCIAL_DIR, name);
    downscaleOg(await page.screenshot(), out);
    await page.close();
    console.log(`wrote ${out} (${Math.round(statSync(out).size / 1024)} KB)`);
  }

  if (reviewDir) {
    mkdirSync(reviewDir, { recursive: true });
    const tiles = variants.map(([v, label, letter]) => {
      const src = join(SOCIAL_DIR, `social-preview-${v}.png`);
      copyFileSync(src, join(reviewDir, `social-preview-${letter}.png`));
      const data = readFileSync(src).toString("base64");
      return `<figure><img src="data:image/png;base64,${data}"><figcaption>${label}</figcaption></figure>`;
    }).join("");
    const cols = variants.length === 3 ? 3 : 2;
    const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS_HREF}">
<style>body{margin:0;background:#e9ebf2;font-family:Inter,sans-serif}
.sheet{display:grid;grid-template-columns:repeat(${cols},640px);gap:36px 32px;padding:40px;width:max-content}
figure{margin:0;display:flex;flex-direction:column;gap:14px}
img{width:640px;height:320px;display:block;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.18)}
figcaption{font-size:22px;font-weight:600;color:#10131b}</style></head>
<body><div class="sheet">${tiles}</div></body></html>`;
    const page = await browser.newPage({ viewport: { width: 2200, height: 900 }, deviceScaleFactor: 1 });
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
