/**
 * i18n rewriter tests.
 *
 * `hatchkit add i18n` writes new files (writer.ts) and EDITS seven the starter
 * already ships. Editing somebody's code is the risky half, so this file pins
 * three promises:
 *
 *   1. The layout edit is correct in the one way that fails silently: the gate
 *      attribute goes on a wrapper INSIDE <body> and never on <body> itself,
 *      the pre-paint script goes in <head>, `{children}` gets wrapped in
 *      <LocaleRoot>, and `<html lang>` keeps saying the SOURCE locale —
 *      because the served markup really is in the source locale until the
 *      script rewrites the attribute before paint.
 *   2. Re-running changes nothing. `hatchkit add i18n` has to be safe to run
 *      again after a hatchkit upgrade.
 *   3. A shape the rewriter does not recognise is reported and left
 *      BYTE-IDENTICAL, with a manual-residue note. Degrading to a documented
 *      manual step beats corrupting a hand-edited file.
 *
 * The fixture is built by COPYING the real starter files, so the transforms
 * are tested against the shapes they actually meet rather than against a
 * paraphrase that drifts.
 *
 * Run: pnpm --filter hatchkit test:i18n-rewriter
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  applyI18nRewrites,
  localePreferenceValues,
  rewriteGlobalsCss,
  rewriteRootLayout,
} from "./src/features/i18n/rewriter.js";
import type { I18nConfig } from "./src/features/i18n/types.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

const STARTER = resolve(join(import.meta.dirname, "..", "starter"));

const CONFIG: I18nConfig = {
  sourceLocale: "en",
  targetLocales: ["de"],
  namespaces: ["common", "app", "marketing"],
  publicPages: true,
  serverCatalogs: true,
  pseudoLocale: true,
  gateFailsafeMs: 4000,
};

/** The files the rewriter touches, copied out of the real starter. */
const FIXTURE_FILES = [
  "packages/client/src/app/layout.tsx",
  "packages/client/src/styles/globals.css",
  "packages/client/package.json",
  "packages/shared/src/index.ts",
  "packages/shared/src/schemas.ts",
  "packages/shared/package.json",
  "packages/server/src/models/Profile.ts",
  "packages/server/src/trpc/routers/profile.ts",
  "packages/server/package.json",
];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "i18n-rewriter-"));
  for (const rel of FIXTURE_FILES) {
    const from = join(STARTER, rel);
    if (!existsSync(from)) continue;
    const to = join(root, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
  return root;
}

/** Everything the rewriter could touch, as a path→content map. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of FIXTURE_FILES) {
    const p = join(root, rel);
    if (existsSync(p)) out[rel] = readFileSync(p, "utf-8");
  }
  return out;
}

// ---------------------------------------------------------------------------
// 0. The fixture is real. If the starter moved a file, these tests would
//    quietly assert nothing, so check the copy landed first.
// ---------------------------------------------------------------------------
console.log("\n── fixture: the real starter files ──────────────────────────────────────────");
{
  assert(existsSync(STARTER), `starter/ found at ${STARTER}`);
  const root = fixture();
  try {
    const missing = FIXTURE_FILES.filter((rel) => !existsSync(join(root, rel)));
    assert(
      missing.length === 0,
      `every fixture file copied from the starter${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. The layout. The one that matters.
// ---------------------------------------------------------------------------
console.log("\n── layout.tsx ──────────────────────────────────────────────────────────────");
{
  const root = fixture();
  try {
    const rel = "packages/client/src/app/layout.tsx";
    const status = rewriteRootLayout({ projectDir: root, config: CONFIG, pkgScope: "@starter" });
    assert(status === "rewritten", `rewriteRootLayout reports rewritten (got ${status})`);
    const after = readFileSync(join(root, rel), "utf-8");

    // The pre-paint script, in <head>.
    const headOpen = after.indexOf("<head>");
    const headClose = after.indexOf("</head>");
    const scriptAt = after.indexOf("LOCALE_SCRIPT", after.indexOf("<head>"));
    assert(headOpen >= 0 && headClose > headOpen, "the layout still has a <head>");
    assert(
      scriptAt > headOpen && scriptAt < headClose,
      "the pre-paint script is inside <head>",
    );
    assert(
      /dangerouslySetInnerHTML=\{\{\s*__html:\s*LOCALE_SCRIPT\s*\}\}/.test(after),
      "the script is inlined, not loaded — a fetched script paints too late",
    );
    // Ahead of the analytics tags: anything above it can paint before the
    // language is known.
    const analyticsAt = after.indexOf("NEXT_PUBLIC_OPENPANEL_CLIENT_ID");
    assert(
      analyticsAt === -1 || scriptAt < analyticsAt,
      "the script comes first in <head>, ahead of the analytics tags",
    );

    // THE invariant: the gate attribute is on a wrapper inside <body>, and
    // <body> itself does not carry it. Hiding <body> would hide the
    // gate-exempt prerendered per-language pages along with everything else.
    assert(
      /<div data-locale-gate>/.test(after),
      "the gate attribute lands on a wrapper element",
    );
    const bodyTag = after.match(/<body[^>]*>/)?.[0] ?? "";
    assert(bodyTag.length > 0, "the layout still has a <body>");
    assert(
      !bodyTag.includes("data-locale-gate") && !bodyTag.includes("data-locale-pending"),
      `<body> itself carries no gate attribute (body tag: ${bodyTag})`,
    );
    const gateAt = after.indexOf("data-locale-gate", after.indexOf("<body"));
    const bodyCloseAt = after.indexOf("</body>");
    assert(
      gateAt > 0 && bodyCloseAt > gateAt,
      "the gate wrapper is nested inside <body>, not around it",
    );

    // {children} wrapped, exactly once, and still inside the providers.
    assert(
      after.includes("<LocaleRoot>{children}</LocaleRoot>"),
      "{children} is wrapped in <LocaleRoot>",
    );
    assert(
      after.split("{children}").length - 1 === 1,
      "there is still exactly one {children} slot",
    );
    const trpcAt = after.indexOf("<TRPCProvider>");
    assert(
      trpcAt === -1 || trpcAt < after.indexOf("<LocaleRoot>"),
      "the existing providers still wrap the gate, so nothing lost its context",
    );

    // <html lang> untouched: the served markup IS the source locale.
    assert(
      /<html lang="en">/.test(after),
      "<html lang> still says the source locale — the script rewrites it before paint",
    );

    // Imports added, and the stylesheet import stays last so the cascade
    // order does not move.
    assert(
      after.includes('import { LocaleRoot } from "@/i18n/locale-root";') &&
        after.includes('import { LOCALE_SCRIPT } from "@/app/pre-paint";'),
      "both imports added",
    );
    const cssAt = after.indexOf('import "@/styles/globals.css";');
    assert(
      cssAt === -1 || after.indexOf('from "@/i18n/locale-root"') < cssAt,
      "the stylesheet import stays last, so CSS cascade order is unchanged",
    );

    // Idempotency, per function.
    const second = rewriteRootLayout({ projectDir: root, config: CONFIG, pkgScope: "@starter" });
    assert(second === "unchanged", `a second call reports unchanged (got ${second})`);
    assert(
      readFileSync(join(root, rel), "utf-8") === after,
      "a second call leaves the file byte-identical",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. globals.css — one rule, behind a sentinel.
// ---------------------------------------------------------------------------
console.log("\n── globals.css ─────────────────────────────────────────────────────────────");
{
  const root = fixture();
  try {
    const rel = "packages/client/src/styles/globals.css";
    const before = readFileSync(join(root, rel), "utf-8");
    assert(
      rewriteGlobalsCss({ projectDir: root, config: CONFIG, pkgScope: "@starter" }) === "rewritten",
      "rewriteGlobalsCss reports rewritten",
    );
    const after = readFileSync(join(root, rel), "utf-8");

    assert(after.startsWith(before.trimEnd()), "the existing stylesheet is left intact, appended to");
    assert(
      /\[data-locale-pending\]\s+\[data-locale-gate\]\s*\{/.test(after),
      "the gate rule is descendant-scoped: <html> carries the mark, the subtree hides",
    );
    assert(
      !/^\s*body\s*\{[^}]*visibility:\s*hidden/m.test(after),
      "the rule never hides <body>",
    );
    assert(
      /visibility:\s*hidden/.test(after) && !/display:\s*none/.test(after.slice(before.length)),
      "visibility, not display — releasing the gate costs no reflow",
    );
    assert(
      /\[data-locale-fixed\]/.test(after),
      "a prerendered per-language page can opt back out of the gate",
    );
    assert(
      (after.match(/\[data-locale-pending\] \[data-locale-gate\]/g) ?? []).length === 1,
      "exactly one gate rule, not one per run",
    );

    const second = rewriteGlobalsCss({ projectDir: root, config: CONFIG, pkgScope: "@starter" });
    assert(second === "unchanged", `a second call reports unchanged (got ${second})`);
    assert(readFileSync(join(root, rel), "utf-8") === after, "and changes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3. The whole set, and the synced preference it wires.
// ---------------------------------------------------------------------------
console.log("\n── applyI18nRewrites: the full set ─────────────────────────────────────────");
{
  const root = fixture();
  try {
    const first = applyI18nRewrites({ projectDir: root, config: CONFIG, pkgScope: "@starter" });
    assert(
      first.skipped.length === 0,
      `nothing skipped on a real starter${first.skipped.length ? ` (${first.skipped.join("; ")})` : ""}`,
    );
    assert(
      first.rewritten.length >= 7,
      `at least seven files rewritten (got ${first.rewritten.length}: ${first.rewritten.join(", ")})`,
    );

    // The shared barrel: the whole feature imports `@<scope>/shared`, so a
    // missing export here is the feature failing to resolve.
    const barrel = readFileSync(join(root, "packages/shared/src/index.ts"), "utf-8");
    assert(
      barrel.includes('export * from "./locale.js";') &&
        barrel.includes('export * from "./format-duration.js";'),
      "the shared barrel exports the resolver and the byte-stable formatter",
    );

    // The synced preference, end to end. "system" is stored and never
    // resolved by the server — it has no device to ask what it means.
    const expectedValues = localePreferenceValues(CONFIG);
    assert(
      expectedValues[0] === "system" && expectedValues.includes("en") && expectedValues.includes("de"),
      `the stored preference is "system" plus every shipped language (${expectedValues.join("|")})`,
    );

    const schemas = readFileSync(join(root, "packages/shared/src/schemas.ts"), "utf-8");
    assert(/locale:\s*z\s*\n?\s*\.?enum\(|locale: z\.enum\(/.test(schemas), "the zod schema gained a locale");
    assert(
      expectedValues.every((v) => new RegExp(`"${v}"`).test(schemas)),
      "the zod enum lists system + every language",
    );
    assert(/notifications/.test(schemas), "the existing preference fields survive");

    const model = readFileSync(join(root, "packages/server/src/models/Profile.ts"), "utf-8");
    assert(/locale/.test(model), "the mongoose schema gained a locale");
    assert(
      /locale\??:\s*(LocalePreference|string)/.test(model),
      "IProfile declares the locale field",
    );
    assert(
      /theme/.test(model) && /notifications/.test(model),
      "the existing mongoose preference fields survive",
    );

    const router = readFileSync(join(root, "packages/server/src/trpc/routers/profile.ts"), "utf-8");
    assert(
      /update\["preferences\.locale"\]/.test(router),
      "the tRPC router writes update[\"preferences.locale\"]",
    );
    assert(
      /input\.preferences\.locale/.test(router),
      "…from input.preferences.locale, so the preference really round-trips",
    );
    assert(
      /update\["preferences\.theme"\]/.test(router),
      "the existing theme passthrough survives",
    );

    const clientPkg = JSON.parse(readFileSync(join(root, "packages/client/package.json"), "utf-8"));
    assert(
      typeof clientPkg.dependencies?.["use-intl"] === "string",
      "use-intl is a client dependency",
    );
    assert(
      clientPkg.dependencies?.["next"] !== undefined,
      "the existing client dependencies survive",
    );
    // No routing-based i18n library: its middleware cannot exist under a
    // static export, which is the reason for the whole design.
    assert(
      clientPkg.dependencies?.["next-intl"] === undefined,
      "no routing-based i18n library is added (middleware cannot exist under a static export)",
    );

    // Idempotency for the whole set.
    const before = snapshot(root);
    const second = applyI18nRewrites({ projectDir: root, config: CONFIG, pkgScope: "@starter" });
    assert(second.rewritten.length === 0, `a second run rewrites nothing (got ${second.rewritten.join(", ")})`);
    assert(second.skipped.length === 0, "a second run skips nothing");
    const after = snapshot(root);
    const drifted = Object.keys(before).filter((k) => before[k] !== after[k]);
    assert(
      drifted.length === 0,
      `a second run leaves every file byte-identical${drifted.length ? ` (drifted: ${drifted.join(", ")})` : ""}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. The degradation promise.
//
// A project whose layout has been hand-edited past recognition must be
// REPORTED, not guessed at. The residue note is what turns a failed rewrite
// into a documented manual step.
// ---------------------------------------------------------------------------
console.log("\n── an unrecognised shape is reported, never corrupted ───────────────────────");
{
  const root = fixture();
  try {
    const rel = "packages/client/src/app/layout.tsx";
    // A layout with no `<head>` on its own line — the anchor the rewriter
    // needs in order to know where to put the script.
    const hostile = [
      'import "@/styles/globals.css";',
      "",
      "export default function RootLayout({ children }: { children: React.ReactNode }) {",
      "  return (",
      '    <html lang="en"><head><title>x</title></head>',
      "      <body>{children}</body>",
      "    </html>",
      "  );",
      "}",
      "",
    ].join("\n");
    writeFileSync(join(root, rel), hostile, "utf-8");

    const status = rewriteRootLayout({ projectDir: root, config: CONFIG, pkgScope: "@starter" });
    assert(status === "absent", `an unrecognised layout reports "absent" (got ${status})`);
    assert(
      readFileSync(join(root, rel), "utf-8") === hostile,
      "…and the file is left byte-identical",
    );

    const outcome = applyI18nRewrites({ projectDir: root, config: CONFIG, pkgScope: "@starter" });
    assert(
      outcome.skipped.some((s) => s.startsWith(rel)),
      "applyI18nRewrites reports the layout as skipped",
    );
    assert(
      outcome.manualResidue.length > 0,
      "…and records a manual-residue note, so the user is told what to wire by hand",
    );
    assert(
      outcome.manualResidue.some((r) => /layout|LocaleRoot|gate|pre-paint/i.test(r)),
      "the note names the layout wiring specifically",
    );
    assert(
      readFileSync(join(root, rel), "utf-8") === hostile,
      "the hostile layout is still byte-identical after the full run",
    );
    // The rest of the set must still land — one unrecognised file is not a
    // reason to leave the project half-wired.
    assert(
      outcome.rewritten.length > 0,
      `the other files are still rewritten (${outcome.rewritten.length})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5. A missing file is out of scope, not an error.
// ---------------------------------------------------------------------------
console.log("\n── a surface that does not exist ───────────────────────────────────────────");
{
  const root = mkdtempSync(join(tmpdir(), "i18n-rewriter-empty-"));
  try {
    const outcome = applyI18nRewrites({
      projectDir: root,
      config: CONFIG,
      pkgScope: "@starter",
      clientSurface: false,
      serverSurface: false,
    });
    assert(outcome.rewritten.length === 0, "an empty project rewrites nothing");
    assert(outcome.skipped.length > 0, "…and says what it skipped");
    assert(
      !outcome.skipped.some((s) => s.includes("rewrite failed")),
      "no rewrite throws on a project that has none of the files",
    );
    // Telling somebody to hand-wire a layout they do not have is worse than
    // saying nothing, so an out-of-scope surface owes no residue note.
    assert(
      outcome.manualResidue.every((r) => !/layout\.tsx/.test(r)),
      "an out-of-scope client surface produces no layout residue note",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(failed === 0 ? "\nAll i18n rewriter tests passed.\n" : `\n${failed} check(s) failed.\n`);
process.exit(failed > 0 ? 1 : 0);
