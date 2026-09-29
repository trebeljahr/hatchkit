/**
 * newsletter-confirm-origin.ts: the newsletter confirm-link retrofit.
 *
 * Until 2026-09-29 the starter's newsletter routes built the emailed
 * confirm link on the site URL (NEWSLETTER_SITE_URL ?? FRONTEND_URL). Under
 * the split topology the client host serves no /api routes, so the link
 * 404s. `hatchkit update` moves an existing project's link onto
 * BETTER_AUTH_URL; these tests pin that.
 *
 *  1. **The starter already builds the link on `apiUrl()`**, so a new
 *     project needs no retrofit and the transform leaves it alone.
 *  2. **The pre-fix shape is patched into today's starter file**, byte for
 *     byte. The starter's own `newsletter.test.ts` proves that file's
 *     behaviour, so equality carries it over. The confirm route's
 *     redirects stay on `siteUrl()`.
 *  3. **Idempotence.** `update` runs this on every invocation. A second pass
 *     must report nothing written.
 *  4. **Scope.** A link the project built on another origin is left alone,
 *     and a shape the transform cannot rewrite safely is reported as a
 *     manual step instead.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FeatureLedger } from "./src/features/contract.js";
import {
  API_URL_FUNCTION,
  NEWSLETTER_ROUTES_REL_PATH,
  retrofitNewsletterConfirmOrigin,
  upgradeNewsletterConfirmOrigin,
} from "./src/scaffold/newsletter-confirm-origin.js";

const STARTER = join(import.meta.dirname, "..", "starter");

const failures: string[] = [];
function expect(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        console.log(`  ✓ ${label}`);
      },
      (err: Error) => {
        failures.push(`${label}: ${err.message}`);
        console.log(`  ✗ ${label}`);
      },
    );
}

const STARTER_ROUTES = readFileSync(join(STARTER, NEWSLETTER_ROUTES_REL_PATH), "utf-8");

/** Replace `from` with `to` exactly once, or fail: a fixture built from a
 *  string that is no longer in the starter would test nothing. */
function swap(source: string, from: string, to: string): string {
  assert.equal(source.split(from).length, 2, `expected one ${JSON.stringify(from)} in the starter`);
  return source.replace(from, to);
}

const SITE_URL_DOC =
  "/** Origin of the client app. The `/sub/confirmed` and `/sub/error`\n" +
  " *  pages live here, so the confirm route redirects to it. */\n";

/** The routes as they shipped before the fix: today's starter file with
 *  the link, its guard and both helper comments put back the old way. */
const PRE_FIX_ROUTES = [
  (s: string) => swap(s, SITE_URL_DOC, ""),
  (s: string) => swap(s, `\n\n${API_URL_FUNCTION}`, ""),
  (s: string) =>
    swap(
      s,
      [
        "    const api = apiUrl();",
        "    if (!api) {",
        '      log("error", "subscribe", "no_api_url");',
        "      res.status(500).json({",
        '        error: "config",',
        '        message: "Newsletter API URL is not configured.",',
      ].join("\n"),
      [
        "    const base = siteUrl();",
        "    if (!base) {",
        '      log("error", "subscribe", "no_site_url");',
        "      res.status(500).json({",
        '        error: "config",',
        '        message: "Newsletter site URL is not configured.",',
      ].join("\n"),
    ),
  (s: string) => swap(s, "`${api}/api/newsletter/confirm?", "`${base}/api/newsletter/confirm?"),
].reduce((source, step) => step(source), STARTER_ROUTES);

const PRE_FIX_LINK =
  "const confirmUrl = `${base}/api/newsletter/confirm?token=${encodeURIComponent(token)}`;";

function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "newsletter-confirm-origin-"));
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), contents, "utf-8");
  }
  return dir;
}

/** The body of the `app.get("/api/newsletter/confirm", …)` handler. */
function confirmHandler(source: string): string {
  const start = source.indexOf('app.get("/api/newsletter/confirm"');
  assert.notEqual(start, -1, "no confirm route");
  return source.slice(start);
}

// ── 1. The starter ────────────────────────────────────────────────────
console.log("\nstarter:");

await expect("the starter builds the emailed link on apiUrl(), which reads BETTER_AUTH_URL", () => {
  assert.ok(STARTER_ROUTES.includes("`${api}/api/newsletter/confirm?"));
  assert.ok(STARTER_ROUTES.includes("const api = apiUrl();"));
  assert.ok(
    STARTER_ROUTES.includes(API_URL_FUNCTION),
    "the inserted helper is the starter's helper",
  );
  const result = upgradeNewsletterConfirmOrigin(STARTER_ROUTES);
  assert.equal(result.outcome, "already");
  assert.equal(result.source, STARTER_ROUTES);
});

// ── 2. The pre-fix shape ──────────────────────────────────────────────
console.log("\npre-fix newsletter/routes.ts:");

await expect("the pre-fix fixture builds the link on siteUrl()", () => {
  assert.ok(PRE_FIX_ROUTES.includes(PRE_FIX_LINK));
  assert.ok(PRE_FIX_ROUTES.includes("    const base = siteUrl();\n    if (!base) {"));
  assert.doesNotMatch(PRE_FIX_ROUTES, /apiUrl|BETTER_AUTH_URL/);
});

await expect("the patch reproduces today's starter file exactly", () => {
  const result = upgradeNewsletterConfirmOrigin(PRE_FIX_ROUTES);
  assert.equal(result.outcome, "patched");
  assert.equal(result.source, STARTER_ROUTES);
});

await expect("the confirm route still redirects to the site URL", () => {
  const patched = upgradeNewsletterConfirmOrigin(PRE_FIX_ROUTES).source;
  const handler = confirmHandler(patched);
  assert.equal(handler, confirmHandler(PRE_FIX_ROUTES));
  assert.ok(handler.includes("const base = siteUrl();"));
  assert.ok(handler.includes("`${base}/sub/confirmed`"));
});

await expect("an apiUrl() the project already declares is reused, not declared twice", () => {
  const partial = swap(
    PRE_FIX_ROUTES,
    "function siteName()",
    `${API_URL_FUNCTION}\n\nfunction siteName()`,
  );
  const result = upgradeNewsletterConfirmOrigin(partial);
  assert.equal(result.outcome, "patched");
  assert.equal(result.source.split("function apiUrl(").length, 2);
  assert.ok(result.source.includes("`${api}/api/newsletter/confirm?"));
});

// ── 3. Idempotence ────────────────────────────────────────────────────
console.log("\nidempotence:");

await expect("the transform is a fixed point", () => {
  const once = upgradeNewsletterConfirmOrigin(PRE_FIX_ROUTES).source;
  const twice = upgradeNewsletterConfirmOrigin(once);
  assert.equal(twice.outcome, "already");
  assert.equal(twice.source, once);
});

await expect("a dry run reports the patch and writes nothing", () => {
  const dir = makeProject({ [NEWSLETTER_ROUTES_REL_PATH]: PRE_FIX_ROUTES });
  const result = retrofitNewsletterConfirmOrigin(new FeatureLedger(dir, true));
  assert.equal(result.outcome, "patched");
  assert.equal(result.action, "would-write");
  assert.equal(readFileSync(join(dir, NEWSLETTER_ROUTES_REL_PATH), "utf-8"), PRE_FIX_ROUTES);
});

await expect("a second update writes nothing", () => {
  const dir = makeProject({ [NEWSLETTER_ROUTES_REL_PATH]: PRE_FIX_ROUTES });
  const first = retrofitNewsletterConfirmOrigin(new FeatureLedger(dir, false));
  assert.equal(first.action, "written");
  assert.equal(readFileSync(join(dir, NEWSLETTER_ROUTES_REL_PATH), "utf-8"), STARTER_ROUTES);
  const second = new FeatureLedger(dir, false);
  const again = retrofitNewsletterConfirmOrigin(second);
  assert.equal(again.outcome, "already");
  assert.equal(again.action, "unchanged");
  assert.deepEqual(second.summary().written, []);
});

// ── 4. Scope ──────────────────────────────────────────────────────────
console.log("\nscope:");

await expect("a link the project built on another origin is left alone", () => {
  const chosen = swap(
    PRE_FIX_ROUTES,
    "    const base = siteUrl();\n    if (!base) {",
    '    const base = (process.env.PUBLIC_API_URL ?? "").replace(/\\/$/, "");\n    if (!base) {',
  );
  const result = upgradeNewsletterConfirmOrigin(chosen);
  assert.equal(result.outcome, "already");
  assert.equal(result.source, chosen);
});

await expect("a site-URL variable used again after the link is reported, not forced", () => {
  const dir = makeProject({
    [NEWSLETTER_ROUTES_REL_PATH]: swap(
      PRE_FIX_ROUTES,
      '    log("info", "subscribe", "confirmation_sent", { ip });',
      '    log("info", "subscribe", "confirmation_sent", { ip, base });',
    ),
  });
  const before = readFileSync(join(dir, NEWSLETTER_ROUTES_REL_PATH), "utf-8");
  const ledger = new FeatureLedger(dir, false);
  const result = retrofitNewsletterConfirmOrigin(ledger);
  assert.equal(result.outcome, "no-anchor");
  assert.equal(result.action, "conflict");
  assert.deepEqual(
    ledger.conflicts().map((entry) => entry.file),
    [NEWSLETTER_ROUTES_REL_PATH],
  );
  assert.equal(readFileSync(join(dir, NEWSLETTER_ROUTES_REL_PATH), "utf-8"), before);
});

await expect("a link with siteUrl() inline is reported, not forced", () => {
  const inline = swap(
    PRE_FIX_ROUTES,
    PRE_FIX_LINK,
    PRE_FIX_LINK.replace("${base}", "${siteUrl()}"),
  );
  assert.equal(upgradeNewsletterConfirmOrigin(inline).outcome, "no-anchor");
});

await expect("routes with no confirm link have nothing to patch", () => {
  const noLink = [
    'import type { Express } from "express";',
    "",
    "export function registerNewsletterRoutes(app: Express): void {",
    '  app.post("/api/newsletter/subscribe", (_req, res) => res.json({ ok: true }));',
    "}",
    "",
  ].join("\n");
  const dir = makeProject({ [NEWSLETTER_ROUTES_REL_PATH]: noLink });
  const result = retrofitNewsletterConfirmOrigin(new FeatureLedger(dir, false));
  assert.equal(result.outcome, "no-link");
  assert.equal(result.action, "unchanged");
  assert.equal(readFileSync(join(dir, NEWSLETTER_ROUTES_REL_PATH), "utf-8"), noLink);
});

await expect("a project without the newsletter is absent, not an error", () => {
  const dir = makeProject({});
  const ledger = new FeatureLedger(dir, false);
  const result = retrofitNewsletterConfirmOrigin(ledger);
  assert.equal(result.outcome, "absent");
  assert.equal(ledger.touched, false);
});

// ── Result ────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nAll newsletter confirm-origin tests passed.\n");
