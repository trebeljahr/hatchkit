// Shared helpers for the marketing capture scripts: load Playwright, turn the
// CLI's ANSI output into HTML, and render a page to PNG.
//
// Playwright is not a dependency of this repo. The loader tries
// PLAYWRIGHT_MODULE (an absolute path to playwright's index.mjs), then the
// bare `playwright` and `@playwright/test` specifiers. Chromium falls back to
// the installed Google Chrome (headless) when Playwright's own build is absent.

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MARKETING_DIR = join(REPO_ROOT, "docs", "marketing");
export const SCREENSHOT_DIR = join(MARKETING_DIR, "screenshots");
export const SOCIAL_DIR = join(MARKETING_DIR, "social-preview");

export const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=block";

export async function launchChromium() {
  const specs = [process.env.PLAYWRIGHT_MODULE, "playwright", "@playwright/test"].filter(Boolean);
  let chromium;
  for (const spec of specs) {
    try {
      const url = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
      const mod = await import(url);
      chromium = (mod.default ?? mod).chromium ?? mod.chromium;
      if (chromium) break;
    } catch {}
  }
  if (!chromium) {
    throw new Error(
      "Playwright not found. Install it (npm i -g playwright) and set PLAYWRIGHT_MODULE to its index.mjs.",
    );
  }
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return await chromium.launch({ headless: true, channel: "chrome" });
  }
}

// Renders `html` at `width`x`height` CSS px and writes a PNG. With `selector`,
// only that element is captured (its own size wins over `height`).
export async function renderHtml(browser, html, out, opts = {}) {
  const { width = 1280, height = 640, scale = 1, selector, transparent = false } = opts;
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  if (selector) {
    await page.locator(selector).screenshot({ path: out, omitBackground: transparent });
  } else {
    await page.screenshot({ path: out, omitBackground: transparent });
  }
  await page.close();
}

const ESC_HTML = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ESC_HTML[c]);

// The 16 ANSI colours, tuned to the docs site's palette (indigo accent on
// near-black). Index 0-7 normal, 8-15 bright.
export const ANSI_PALETTE = [
  "#1a1f2e", "#f87171", "#34d399", "#fbbf24", "#818cf8", "#c084fc", "#67e8f9", "#d7dbe4",
  "#5b6375", "#fca5a5", "#6ee7b7", "#fde68a", "#a5b4fc", "#d8b4fe", "#a5f3fc", "#ffffff",
];

function xterm256(n) {
  if (n < 16) return ANSI_PALETTE[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const c = (x) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
}

// Converts one line of SGR-coloured text to HTML spans. Other escape
// sequences (cursor moves, OSC links) are dropped.
export function ansiLineToHtml(line) {
  const clean = line
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-HJKSTfhilnsu]/g, "");
  let state = {};
  let html = "";
  let last = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  const flush = (text) => {
    if (!text) return;
    const style = [];
    if (state.fg) style.push(`color:${state.fg}`);
    if (state.bg) style.push(`background:${state.bg}`);
    if (state.bold) style.push("font-weight:700");
    if (state.dim) style.push("opacity:.62");
    if (state.italic) style.push("font-style:italic");
    if (state.underline) style.push("text-decoration:underline");
    const t = escapeHtml(text);
    html += style.length ? `<span style="${style.join(";")}">${t}</span>` : t;
  };
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    flush(clean.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) state = {};
      else if (c === 1) state.bold = true;
      else if (c === 2) state.dim = true;
      else if (c === 3) state.italic = true;
      else if (c === 4) state.underline = true;
      else if (c === 22) state.bold = state.dim = false;
      else if (c === 23) state.italic = false;
      else if (c === 24) state.underline = false;
      else if (c >= 30 && c <= 37) state.fg = ANSI_PALETTE[c - 30];
      else if (c >= 90 && c <= 97) state.fg = ANSI_PALETTE[c - 90 + 8];
      else if (c === 39) state.fg = undefined;
      else if (c >= 40 && c <= 47) state.bg = ANSI_PALETTE[c - 40];
      else if (c >= 100 && c <= 107) state.bg = ANSI_PALETTE[c - 100 + 8];
      else if (c === 49) state.bg = undefined;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        state[c === 38 ? "fg" : "bg"] = xterm256(codes[i + 2]);
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        state[c === 38 ? "fg" : "bg"] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      }
    }
  }
  flush(clean.slice(last));
  return html;
}

export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
