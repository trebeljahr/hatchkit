/**
 * i18n writer + plan tests.
 *
 * The generated templates are TEXT — hatchkit's `tsc` never compiles them —
 * so the only place their shape can be checked is here. Verifies that:
 *
 *   1. The full expected file set lands for a default config, and every
 *      `__HATCHKIT_*__` token is substituted. An unsubstituted token
 *      type-checks nowhere and renders as a literal hole in the user's
 *      project, which is exactly the kind of break that ships silently.
 *   2. Every entry in I18N_TEMPLATES points at a template that exists.
 *      A missing one throws "template not found" at `hatchkit add i18n`
 *      time — runtime, not build time.
 *   3. The gates subtract what they say they subtract, and multiple target
 *      locales expand to one catalog set and one prefixed page each while
 *      the source catalog stays single.
 *   4. Idempotent re-runs: same input twice → second pass writes 0 files.
 *   5. `app/page.tsx` is never written — the user's landing page is theirs;
 *      the source-locale version ships as `page.i18n.tsx.example`.
 *   6. The per-language page really is a thin re-export of the shared page
 *      component. A hand-written second copy of a page is the thing the
 *      build-once-per-language design exists to avoid.
 *
 * Run: pnpm --filter hatchkit test:i18n-writer
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { I18N_TEMPLATES, planI18nFiles } from "./src/features/i18n/plan.js";
import { getI18nTemplatesDir } from "./src/features/i18n/render.js";
import type { I18nConfig } from "./src/features/i18n/types.js";
import { writeI18nFiles } from "./src/features/i18n/writer.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

function config(overrides: Partial<I18nConfig> = {}): I18nConfig {
  return {
    sourceLocale: "en",
    targetLocales: ["de"],
    namespaces: ["common", "app", "marketing"],
    publicPages: true,
    serverCatalogs: true,
    pseudoLocale: true,
    gateFailsafeMs: 4000,
    ...overrides,
  };
}

const CTX = { pkgScope: "@starter", appName: "Tiao" };

/** Every file under `dir`, as paths relative to it. */
function walk(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const entry of readdirSync(cur)) {
      const full = join(cur, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else out.push(relative(dir, full));
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// 1. Every planned template exists on disk.
//
// plan.ts is the single source of truth for template paths, and nothing
// type-checks a string against the filesystem. A template that was renamed
// or never written throws only when a user runs the command.
// ---------------------------------------------------------------------------
console.log("\n── plan: every template referenced exists ───────────────────────────────────");
{
  const root = getI18nTemplatesDir();
  assert(existsSync(root), `templates dir exists (${root})`);

  // Expand over a config that turns every gate on, so no entry is skipped.
  const jobs = planI18nFiles(config(), CTX);
  const missing = jobs.map((j) => j.template).filter((t) => !existsSync(join(root, t)));
  assert(
    missing.length === 0,
    `all ${jobs.length} planned templates exist${missing.length ? ` (missing: ${[...new Set(missing)].join(", ")})` : ""}`,
  );

  // The reverse direction: a template nobody plans is dead weight that
  // drifts out of sync with the rest of the feature.
  const planned = new Set(jobs.map((j) => j.template));
  const onDisk = walk(root).filter((p) => p.endsWith(".tpl"));
  const orphans = onDisk.filter((p) => !planned.has(p));
  assert(
    orphans.length === 0,
    `no orphan templates${orphans.length ? ` (unplanned: ${orphans.join(", ")})` : ""}`,
  );

  // Guard the expansion contract itself: no unexpanded placeholder may
  // survive into a template path or a destination.
  const unexpanded = jobs.filter(
    (j) => /\{(src|tgt|ns)\}/.test(j.template) || /\{(src|tgt|ns)\}/.test(j.dest),
  );
  assert(unexpanded.length === 0, "no {src}/{tgt}/{ns} placeholder survives planning");
}

// ---------------------------------------------------------------------------
// 2. A full write: the file set, and no leftover tokens.
// ---------------------------------------------------------------------------
console.log("\n── writer: full config ──────────────────────────────────────────────────────");
{
  const root = mkdtempSync(join(tmpdir(), "i18n-writer-full-"));
  try {
    const first = writeI18nFiles({ projectDir: root, config: config(), ...CTX });

    const expected = [
      // core
      "packages/client/src/i18n/store.ts",
      "packages/client/src/i18n/use-t.ts",
      "packages/client/src/i18n/format.ts",
      "packages/client/src/i18n/locale-root.tsx",
      "packages/client/src/i18n/fixed-locale.tsx",
      "packages/client/src/i18n/locale-sync.tsx",
      "packages/client/src/components/language-picker.tsx",
      "packages/client/src/i18n/messages/index.ts",
      "packages/client/src/app/pre-paint.ts",
      "packages/shared/src/locale.ts",
      "packages/shared/src/format-duration.ts",
      // catalogs — source and target, one per namespace
      "packages/client/src/i18n/messages/en/common.ts",
      "packages/client/src/i18n/messages/en/app.ts",
      "packages/client/src/i18n/messages/en/marketing.ts",
      "packages/client/src/i18n/messages/de/common.ts",
      "packages/client/src/i18n/messages/de/app.ts",
      "packages/client/src/i18n/messages/de/marketing.ts",
      "packages/client/src/i18n/GLOSSARY.de.md",
      // pseudo
      "packages/client/src/i18n/pseudo.ts",
      // the tests that pin what the types cannot see
      "packages/client/src/app/pre-paint.test.ts",
      "packages/client/src/i18n/locale-root.test.tsx",
      "packages/client/src/i18n/catalog-parity.test.ts",
      "packages/client/src/i18n/format.test.ts",
      "packages/shared/src/locale.test.ts",
      "packages/shared/src/format-duration.test.ts",
      // public pages
      "packages/client/src/components/marketing/pages/landing-page.tsx",
      "packages/client/src/components/marketing/marketing-shell.tsx",
      "packages/client/src/components/marketing/metadata.ts",
      "packages/client/src/components/marketing/localized-path.ts",
      "packages/client/src/app/page.i18n.tsx.example",
      "packages/client/src/app/de/page.tsx",
      // server
      "packages/server/src/i18n/index.ts",
      "packages/server/src/i18n/resolve.ts",
      "packages/server/src/i18n/messages/en/email.ts",
      "packages/server/src/i18n/messages/en/document.ts",
      "packages/server/src/i18n/messages/de/email.ts",
      "packages/server/src/i18n/messages/de/document.ts",
      "packages/server/src/tests/i18n-catalog.test.ts",
    ];
    const missing = expected.filter((p) => !existsSync(join(root, p)));
    assert(
      missing.length === 0,
      `all ${expected.length} expected files written${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`,
    );
    assert(
      first.written.length === expected.length,
      `writer reports exactly ${expected.length} written (got ${first.written.length})`,
    );

    // The token check. Walk everything, not only the files we listed.
    const leftovers = walk(root).filter((p) =>
      readFileSync(join(root, p), "utf-8").includes("__HATCHKIT_"),
    );
    assert(
      leftovers.length === 0,
      `no rendered file retains a __HATCHKIT_ token${leftovers.length ? ` (${leftovers.join(", ")})` : ""}`,
    );

    // Every workspace import must name the scope exactly once. The scope
    // token already carries its `@`, so a template that writes
    // `@__HATCHKIT_PKG_SCOPE__/shared` renders `@@starter/shared` — an
    // import that resolves nowhere, in a file hatchkit's tsc never sees.
    const badScope = walk(root)
      .map((p) => [p, readFileSync(join(root, p), "utf-8")] as const)
      .filter(([, src]) => /from\s+"@@|from\s+"(?!@)[a-z0-9-]+\/shared"/.test(src))
      .map(([p]) => p);
    assert(
      badScope.length === 0,
      `every workspace import names the scope exactly once${badScope.length ? ` (bad: ${badScope.join(", ")})` : ""}`,
    );
    const scopedImports = walk(root)
      .map((p) => readFileSync(join(root, p), "utf-8"))
      .flatMap((src) => [...src.matchAll(/from\s+"(@[^"]*\/shared)"/g)].map((m) => m[1]));
    assert(
      scopedImports.length > 0 && scopedImports.every((s) => s === "@starter/shared"),
      `all ${scopedImports.length} shared imports are exactly "@starter/shared"`,
    );

    // The user's own landing page is never touched.
    assert(
      !existsSync(join(root, "packages/client/src/app/page.tsx")),
      "app/page.tsx is NOT written (the user's landing page stays theirs)",
    );
    assert(
      existsSync(join(root, "packages/client/src/app/page.i18n.tsx.example")),
      "the source-locale page ships as page.i18n.tsx.example instead",
    );

    // The prefixed page is a thin re-export, not a second copy of the page.
    const dePage = readFileSync(join(root, "packages/client/src/app/de/page.tsx"), "utf-8");
    const codeLines = dePage
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .filter((l) => !l.trim().startsWith("/*"));
    assert(
      codeLines.length <= 12,
      `de/page.tsx is a thin re-export (${codeLines.length} code lines, expected ≤ 12)`,
    );
    assert(
      /landing-page|LandingPage/.test(dePage),
      "de/page.tsx defers to the shared landing page component",
    );
    assert(/"de"|'de'/.test(dePage), "de/page.tsx passes its locale in explicitly");

    // Idempotency.
    const second = writeI18nFiles({ projectDir: root, config: config(), ...CTX });
    assert(second.written.length === 0, `second run writes 0 files (got ${second.written.length})`);
    assert(
      second.unchanged.length === expected.length,
      `second run reports every file unchanged (got ${second.unchanged.length})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3. The gates.
// ---------------------------------------------------------------------------
console.log("\n── writer: gates subtract what they claim ───────────────────────────────────");
{
  const root = mkdtempSync(join(tmpdir(), "i18n-writer-min-"));
  try {
    writeI18nFiles({
      projectDir: root,
      config: config({ publicPages: false, serverCatalogs: false, pseudoLocale: false }),
      ...CTX,
    });
    const files = walk(root);
    const has = (p: string) => files.includes(p);

    assert(!has("packages/client/src/i18n/pseudo.ts"), "pseudoLocale:false omits pseudo.ts");
    assert(
      !has("packages/client/src/app/de/page.tsx") &&
        !has("packages/client/src/components/marketing/marketing-shell.tsx") &&
        !has("packages/client/src/app/page.i18n.tsx.example"),
      "publicPages:false omits the prefixed page and the marketing components",
    );
    assert(
      files.every((p) => !p.startsWith("packages/server/")),
      "serverCatalogs:false omits the whole server tree",
    );

    // What must survive a minimal config: the core, the catalogs and the
    // tests. The tests have no opt-out on purpose — they ARE the contract.
    assert(has("packages/client/src/i18n/store.ts"), "core survives a minimal config");
    assert(
      has("packages/client/src/i18n/messages/de/common.ts"),
      "target catalogs survive a minimal config",
    );
    assert(
      has("packages/client/src/app/pre-paint.test.ts") &&
        has("packages/client/src/i18n/catalog-parity.test.ts"),
      "the parity and first-paint tests have no opt-out",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. Two target locales.
// ---------------------------------------------------------------------------
console.log("\n── writer: two target locales ───────────────────────────────────────────────");
{
  const root = mkdtempSync(join(tmpdir(), "i18n-writer-multi-"));
  try {
    writeI18nFiles({
      projectDir: root,
      config: config({ targetLocales: ["de", "fr"] }),
      ...CTX,
    });
    const files = walk(root);

    for (const tgt of ["de", "fr"]) {
      assert(
        files.includes(`packages/client/src/i18n/messages/${tgt}/common.ts`),
        `${tgt}: client catalog set written`,
      );
      assert(
        files.includes(`packages/client/src/i18n/GLOSSARY.${tgt}.md`),
        `${tgt}: glossary written`,
      );
      assert(
        files.includes(`packages/client/src/app/${tgt}/page.tsx`),
        `${tgt}: prefixed public page written`,
      );
      assert(
        files.includes(`packages/server/src/i18n/messages/${tgt}/email.ts`),
        `${tgt}: server catalogs written`,
      );
    }

    // One source catalog set, however many targets there are.
    const sourceCatalogs = files.filter((p) =>
      p.startsWith("packages/client/src/i18n/messages/en/"),
    );
    assert(sourceCatalogs.length === 3, `exactly one source catalog set (got ${sourceCatalogs.length})`);

    // The core is written once, not once per target.
    const stores = files.filter((p) => p.endsWith("i18n/store.ts"));
    assert(stores.length === 1, `the core is written once, not per target (got ${stores.length})`);

    // The picker and the resolver must know about EVERY language, so they
    // read the full list rather than the primary target.
    const picker = readFileSync(join(root, "packages/client/src/components/language-picker.tsx"), "utf-8");
    const sharedLocale = readFileSync(join(root, "packages/shared/src/locale.ts"), "utf-8");
    assert(
      picker.includes("fr") || sharedLocale.includes("fr"),
      "the second target reaches the picker/resolver, not just the primary one",
    );
    assert(
      /"en"[\s\S]*"de"[\s\S]*"fr"|\["en",\s*"de",\s*"fr"\]/.test(sharedLocale),
      "shared/locale.ts lists the source first, then every target (fallback order)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5. A non-default source locale, and a non-starter package scope.
// ---------------------------------------------------------------------------
console.log("\n── writer: non-default source locale + package scope ────────────────────────");
{
  const root = mkdtempSync(join(tmpdir(), "i18n-writer-de-src-"));
  try {
    writeI18nFiles({
      projectDir: root,
      config: config({ sourceLocale: "de", targetLocales: ["en"] }),
      pkgScope: "@myapp",
      appName: "Meine App",
    });
    const files = walk(root);
    assert(
      files.includes("packages/client/src/i18n/messages/de/common.ts") &&
        files.includes("packages/client/src/i18n/messages/en/common.ts"),
      "source/target directories follow the configured locales, not a hardcoded en",
    );
    const store = readFileSync(join(root, "packages/client/src/i18n/store.ts"), "utf-8");
    assert(
      store.includes("@myapp/shared"),
      "the package scope is a token, not a hardcoded @starter",
    );
    const leftovers = files.filter((p) =>
      readFileSync(join(root, p), "utf-8").includes("__HATCHKIT_"),
    );
    assert(leftovers.length === 0, "no leftover tokens with a non-default config");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 6. The table itself: no duplicate destinations.
//
// Two entries writing the same path means one silently wins, and which one
// depends on array order.
// ---------------------------------------------------------------------------
console.log("\n── plan: no duplicate destinations ──────────────────────────────────────────");
{
  const jobs = planI18nFiles(config({ targetLocales: ["de", "fr"] }), CTX);
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const j of jobs) {
    if (seen.has(j.dest)) dupes.push(j.dest);
    seen.add(j.dest);
  }
  assert(dupes.length === 0, `no destination is planned twice${dupes.length ? ` (${dupes.join(", ")})` : ""}`);
  assert(
    I18N_TEMPLATES.length > 0 && jobs.length > I18N_TEMPLATES.length,
    "expansion produces more jobs than table entries (per-target + per-namespace axes)",
  );
}

console.log(failed === 0 ? "\nAll i18n writer tests passed.\n" : `\n${failed} check(s) failed.\n`);
process.exit(failed > 0 ? 1 : 0);
