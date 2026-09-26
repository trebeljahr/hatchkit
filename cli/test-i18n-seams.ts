/**
 * i18n template seam tests.
 *
 * The generated project files live under `cli/src/templates/i18n/` as TEXT.
 * Hatchkit's own `tsc` never compiles them, and neither does biome, so a
 * broken import between two templates is invisible to every gate in this
 * repository — it surfaces in a user's project, after `hatchkit add i18n`
 * has already edited their layout. This file is the compiler those templates
 * never get.
 *
 * Two classes of seam:
 *
 *   1. IMPORTS. Every named import in every rendered file must be something
 *      the target module actually exports. The bug this caught while the
 *      feature was being written was a template writing
 *      `@__HATCHKIT_PKG_SCOPE__/shared` where the token already carries its
 *      `@` — `@@starter/shared`, an import resolving nowhere.
 *   2. THE GATE ATTRIBUTE NAMES. `store.ts`, `pre-paint.ts`, the CSS rule in
 *      rewriter.ts and `locale-root.tsx` each name the same two attributes.
 *      A disagreement between any two of them leaves the app permanently
 *      invisible, or lifts the gate on the wrong language, and nothing else
 *      in the suite would notice: each file is individually correct.
 *
 * Run: pnpm --filter hatchkit test:i18n-seams
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { DEFAULT_NAMESPACES } from "./src/features/i18n/locales.js";
import { planI18nFiles, shippedNamespaces } from "./src/features/i18n/plan.js";
import { getFeatureTemplateDir } from "./src/features/templates.js";
import { runI18nSetup } from "./src/features/i18n/index.js";
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

const SCOPE = "@starter";
const CONFIG: I18nConfig = {
  sourceLocale: "en",
  targetLocales: ["de"],
  namespaces: ["common", "app", "marketing"],
  publicPages: true,
  serverCatalogs: true,
  pseudoLocale: true,
  gateFailsafeMs: 4000,
};

/** Modules the STARTER provides. A template may import these; they are not
 *  ours to resolve, and each is listed deliberately so a typo in a template
 *  cannot hide behind a wildcard. */
const STARTER_MODULES = new Set(["@/lib/trpc", "@/hooks/use-auth", "@/lib/utils"]);

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

/** Exported names of one module, read off the source text. Good enough for
 *  the shapes these templates use, and it does not need a TypeScript
 *  program — which is the point: this must run in the CLI's own suite. */
function exportedNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(
    /^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // `export { a, b as c }` and `export type { A }`.
  for (const m of src.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Drop comments without touching string contents, so a comment that names
 *  a forbidden API is not read as a use of it. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === quote) break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Named imports of one module, as (specifier, names) pairs. */
function namedImports(src: string): Array<{ spec: string; names: string[] }> {
  const out: Array<{ spec: string; names: string[] }> = [];
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
    const names = m[1]
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    out.push({ spec: m[2], names });
  }
  return out;
}

const root = mkdtempSync(join(tmpdir(), "i18n-seams-"));
try {
  writeI18nFiles({ projectDir: root, config: CONFIG, pkgScope: SCOPE, appName: "Tiao" });
  const files = walk(root).filter((p) => /\.tsx?$/.test(p));
  assert(files.length >= 30, `rendered ${files.length} TypeScript files to check`);

  const exports = new Map<string, Set<string>>();
  for (const f of files) exports.set(f, exportedNames(readFileSync(join(root, f), "utf-8")));

  // `@<scope>/shared` is the barrel, which re-exports every module under
  // packages/shared/src — so the barrel's surface is their union.
  const sharedSurface = new Set<string>();
  for (const f of files) {
    if (!f.startsWith("packages/shared/src/")) continue;
    for (const n of exports.get(f) ?? []) sharedSurface.add(n);
  }

  // -------------------------------------------------------------------------
  // 1. Imports.
  // -------------------------------------------------------------------------
  console.log("\n── every import resolves to a real export ──────────────────────────────────");
  {
    const problems: string[] = [];

    for (const f of files) {
      const src = readFileSync(join(root, f), "utf-8");
      const pkg = f.startsWith("packages/server") ? "server" : "client";

      for (const { spec, names } of namedImports(src)) {
        if (spec === `${SCOPE}/shared`) {
          for (const n of names) {
            if (!sharedSurface.has(n)) problems.push(`${f}: "${n}" is not exported by ${spec}`);
          }
          continue;
        }
        if (STARTER_MODULES.has(spec)) continue;
        // Third-party (use-intl, react, next, zod…) is not ours to check.
        if (!spec.startsWith("@/") && !spec.startsWith(".")) continue;

        const base = spec.startsWith("@/")
          ? `packages/${pkg}/src/${spec.slice(2)}`
          : relative(root, resolve(join(root, dirname(f)), spec)).replace(/\.js$/, "");
        const target = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base].find((p) =>
          files.includes(p),
        );
        if (target === undefined) {
          problems.push(`${f}: unresolved import "${spec}"`);
          continue;
        }
        for (const n of names) {
          if (!exports.get(target)?.has(n)) {
            problems.push(`${f}: "${n}" is not exported by ${target} (via "${spec}")`);
          }
        }
      }
    }

    assert(
      problems.length === 0,
      `every named import resolves${problems.length ? `\n      ${problems.slice(0, 12).join("\n      ")}` : ""}`,
    );
  }

  // No workspace import may double the scope's `@`. The token already
  // carries it, so a template that writes `@__HATCHKIT_PKG_SCOPE__/…`
  // renders an import that resolves nowhere — in a file no gate compiles.
  console.log("\n── the workspace scope is named exactly once ───────────────────────────────");
  {
    const doubled = files.filter((f) => /from\s+"@@/.test(readFileSync(join(root, f), "utf-8")));
    assert(
      doubled.length === 0,
      `no import doubles the scope's "@"${doubled.length ? ` (${doubled.join(", ")})` : ""}`,
    );
    const specs = files.flatMap((f) =>
      [...readFileSync(join(root, f), "utf-8").matchAll(/from\s+"([^"]*\/shared)"/g)].map(
        (m) => m[1],
      ),
    );
    assert(specs.length > 0, `${specs.length} workspace imports found`);
    assert(
      specs.every((s) => s === `${SCOPE}/shared`),
      `all of them are exactly "${SCOPE}/shared" (saw: ${[...new Set(specs)].join(", ")})`,
    );
  }

  // -------------------------------------------------------------------------
  // 2. The gate attribute names.
  //
  // Four files have to agree. The CSS rule is written by rewriter.ts, not by
  // a template, so this is the only place the two halves of the feature are
  // compared against each other at all.
  // -------------------------------------------------------------------------
  console.log("\n── the gate attribute names agree across all four files ────────────────────");
  {
    const store = readFileSync(join(root, "packages/client/src/i18n/store.ts"), "utf-8");
    const prePaint = readFileSync(join(root, "packages/client/src/app/pre-paint.ts"), "utf-8");
    const localeRoot = readFileSync(join(root, "packages/client/src/i18n/locale-root.tsx"), "utf-8");
    const fixed = readFileSync(join(root, "packages/client/src/i18n/fixed-locale.tsx"), "utf-8");

    // store.ts declares the names; everything else must use them.
    const declared = (name: string): string | null =>
      store.match(new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`))?.[1] ?? null;
    const pending = declared("GATE_ATTR");
    const scopeAttr = declared("GATE_SCOPE_ATTR");
    const exempt = declared("GATE_EXEMPT_ATTR");
    assert(pending !== null, `store.ts declares GATE_ATTR (${pending})`);
    assert(scopeAttr !== null, `store.ts declares GATE_SCOPE_ATTR (${scopeAttr})`);
    assert(exempt !== null, `store.ts declares GATE_EXEMPT_ATTR (${exempt})`);

    // The pre-paint script is a STRING, so it cannot import the constant —
    // it has to spell the attribute out, which is exactly why this check
    // exists. Same for the CSS rule.
    assert(
      pending !== null && prePaint.includes(pending),
      `the pre-paint script sets the same pending attribute (${pending})`,
    );
    assert(
      !prePaint.includes("data-locale-gate") || scopeAttr === "data-locale-gate",
      "the pre-paint script does not invent a different subtree attribute",
    );

    // locale-root.tsx clears the mark. It may import the constant or spell
    // it; either is fine, as long as it is the same one.
    const clearsByConstant = /GATE_ATTR/.test(localeRoot);
    assert(
      clearsByConstant || (pending !== null && localeRoot.includes(pending)),
      "locale-root.tsx clears the same pending attribute",
    );
    assert(
      /useLayoutEffect/.test(localeRoot),
      "…from a layout effect, so the mark clears in the same flush as the translated render",
    );
    assert(
      /documentElement/.test(localeRoot),
      "…on <html>, which is where the script set it",
    );

    // <FixedLocale> is what exempts a prerendered per-language page.
    assert(
      /GATE_EXEMPT_ATTR/.test(fixed) || (exempt !== null && fixed.includes(exempt)),
      "fixed-locale.tsx uses the same exempt attribute",
    );

    // And the CSS the rewriter appends must target those same names. Read it
    // out of rewriter.ts's source, since that is where the rule is authored.
    const rewriterSrc = readFileSync(
      join(import.meta.dirname, "src/features/i18n/rewriter.ts"),
      "utf-8",
    );
    assert(
      /GATE_ATTR/.test(rewriterSrc) && /GATE_SCOPE_ATTR/.test(rewriterSrc),
      "rewriter.ts builds the CSS rule from named constants rather than literals",
    );
    // Those constants have to be the same VALUES store.ts ships. rewriter.ts
    // has its own copies (it cannot import from a template), so compare.
    const rewriterValue = (name: string): string | null =>
      rewriterSrc.match(new RegExp(`const ${name}\\s*=\\s*"([^"]+)"`))?.[1] ?? null;
    for (const [name, expected] of [
      ["GATE_ATTR", pending],
      ["GATE_SCOPE_ATTR", scopeAttr],
      ["GATE_EXEMPT_ATTR", exempt],
    ] as const) {
      const actual = rewriterValue(name);
      assert(
        actual === null || actual === expected,
        `rewriter.ts's ${name} matches store.ts (${actual ?? "n/a"} vs ${expected})`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 3. The hydration rule, and the one formatting module.
  //
  // Both are invariants a reviewer can only check by reading every file, so
  // check them mechanically instead.
  // -------------------------------------------------------------------------
  console.log("\n── the hydration rule and the single formatting module ─────────────────────");
  {
    const store = readFileSync(join(root, "packages/client/src/i18n/store.ts"), "utf-8");
    const useT = readFileSync(join(root, "packages/client/src/i18n/use-t.ts"), "utf-8");

    assert(
      /useSyncExternalStore/.test(useT),
      "useLocale reads the store through useSyncExternalStore",
    );
    assert(
      /getServerSnapshot/.test(useT),
      "…with a server snapshot, which is what makes the hydration answer the source locale",
    );
    assert(
      /export function getServerSnapshot[\s\S]{0,200}?SOURCE_LOCALE/.test(store),
      "getServerSnapshot returns SOURCE_LOCALE by construction, not by a runtime check",
    );
    assert(
      /activateResolvedLocale/.test(store) && /activateResolvedLocale/.test(
        readFileSync(join(root, "packages/client/src/i18n/locale-root.tsx"), "utf-8"),
      ),
      "the real language only takes effect via activateResolvedLocale, from <LocaleRoot>",
    );

    // No routing-based i18n library anywhere: its middleware cannot exist
    // under a static export, which is the premise of the whole design.
    const routing = files.filter((f) =>
      /from\s+"next-intl/.test(readFileSync(join(root, f), "utf-8")),
    );
    assert(
      routing.length === 0,
      `no template imports a routing-based i18n library${routing.length ? ` (${routing.join(", ")})` : ""}`,
    );
    // …and the core really is use-intl's React-free entry.
    const useIntlSpecs = files.flatMap((f) =>
      [...readFileSync(join(root, f), "utf-8").matchAll(/from\s+"(use-intl[^"]*)"/g)].map(
        (m) => m[1],
      ),
    );
    assert(useIntlSpecs.length > 0, "the translation core is use-intl");
    assert(
      useIntlSpecs.every((s) => s === "use-intl/core"),
      `every use-intl import is the React-free core (saw: ${[...new Set(useIntlSpecs)].join(", ")})`,
    );

    // Every Intl FORMATTER goes through format.ts. A bare
    // toLocale*(undefined) formats in the DEVICE's language regardless of
    // what the page is rendering, which is a mismatch nothing reports.
    //
    // Comments are stripped first: shared/locale.ts explains at length why
    // it does NOT use Intl.DisplayNames, and a grep that cannot tell a
    // warning from a call would read that as the very thing it forbids.
    // `resolvedOptions()` is allowed — it READS a device setting (the time
    // zone) and renders nothing, so it is a capability query rather than a
    // formatting decision.
    const offenders = files
      .filter((f) => !f.endsWith("i18n/format.ts"))
      .filter((f) => !f.includes(".test."))
      .filter((f) => !f.startsWith("packages/shared/src/format-duration"))
      .filter((f) => {
        const code = stripComments(readFileSync(join(root, f), "utf-8")).replace(
          /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)/g,
          "",
        );
        return /\bIntl\.[A-Z]|\.toLocale(String|DateString|TimeString)\(/.test(code);
      });
    assert(
      offenders.length === 0,
      `no template formats outside format.ts${offenders.length ? ` (${offenders.join(", ")})` : ""}`,
    );
  }

  // -------------------------------------------------------------------------
  // 4. Every template's tokens are ones the plan supplies.
  //
  // An unknown token is left verbatim by design, so it ships as a literal
  // `__HATCHKIT_WHATEVER__` hole. The writer test catches that for the
  // default config; this catches it in the template source, which is where
  // the typo is.
  //
  // The token set is read off a REAL plan rather than scraped out of a
  // renderer's source. i18n renders through the shared
  // `renderFeatureTemplate` (cli/src/features/templates.ts), which
  // substitutes whatever keys it is handed, so the list a template may
  // rely on is exactly what plan.ts's `tokensFor` puts in each job — and
  // asking the plan cannot drift from it the way a second list would.
  // -------------------------------------------------------------------------
  console.log("\n── every template token is one the renderer substitutes ────────────────────");
  {
    const known = new Set(
      planI18nFiles(CONFIG, { pkgScope: SCOPE, appName: "Tiao" }).flatMap((job) =>
        Object.keys(job.tokens),
      ),
    );
    assert(known.size >= 10, `the plan supplies ${known.size} tokens`);

    const templatesDir = getFeatureTemplateDir("i18n");
    const used = new Set<string>();
    const leftovers: string[] = [];
    for (const rel of walk(templatesDir).filter((p) => p.endsWith(".tpl"))) {
      let src = readFileSync(join(templatesDir, rel), "utf-8");
      // Substitute exactly the way render.ts does — by literal replacement
      // of each known token, longest first. A regex cannot do this job: in
      // `__HATCHKIT_TARGET_LOCALE___app` the greedy match reads the token
      // name as `TARGET_LOCALE_`, and reports a correct template as broken.
      for (const token of [...known].sort((a, b) => b.length - a.length)) {
        const needle = `__HATCHKIT_${token}__`;
        if (src.includes(needle)) {
          used.add(token);
          src = src.split(needle).join("");
        }
      }
      // Whatever still looks like a token is one the renderer would leave in
      // place, and it would ship as a literal hole in the user's project.
      if (src.includes("__HATCHKIT_")) {
        leftovers.push(`${rel}: ${src.match(/__HATCHKIT_[A-Z0-9_]*/)?.[0] ?? "?"}`);
      }
    }
    assert(
      leftovers.length === 0,
      `every token used is one the renderer substitutes${leftovers.length ? ` (${leftovers.join(", ")})` : ""}`,
    );
    const unused = [...known].filter((t) => !used.has(t));
    assert(
      unused.length === 0,
      `every token the plan supplies is used${unused.length ? ` (dead: ${unused.join(", ")})` : ""}`,
    );
  }

  // -------------------------------------------------------------------------
  // 5. The namespace set is derived from the templates, not asserted twice.
  //
  // A namespace is a hand-written pair of catalog templates. One hatchkit
  // does not ship has no file to render, and the failure has to name the fix
  // rather than report a missing path.
  // -------------------------------------------------------------------------
  console.log("\n── the shipped namespace set ───────────────────────────────────────────────");
  {
    const shipped = shippedNamespaces();
    assert(
      shipped.length > 0 && DEFAULT_NAMESPACES.every((ns) => shipped.includes(ns)),
      `every default namespace has templates (shipped: ${shipped.join(", ")})`,
    );
    // Derived, not listed: the default set must not claim a namespace the
    // templates do not cover, and the probe must not find one nothing uses.
    assert(
      shipped.length === DEFAULT_NAMESPACES.length,
      `the shipped set and the default set agree (${shipped.join(", ")} vs ${DEFAULT_NAMESPACES.join(", ")})`,
    );

    // A namespace with no template is rejected by name, before anything is
    // written — not by render.ts reporting a path. Needs a project shaped
    // enough to get past the surface check, since a directory that is not a
    // project is refused for that reason first, and rightly so.
    const nsRoot = mkdtempSync(join(tmpdir(), "i18n-seams-ns-"));
    try {
      for (const pkg of ["client", "server", "shared"]) {
        mkdirSync(join(nsRoot, "packages", pkg), { recursive: true });
        writeFileSync(
          join(nsRoot, "packages", pkg, "package.json"),
          `${JSON.stringify({ name: `${SCOPE}/${pkg}`, version: "0.1.0" }, null, 2)}\n`,
          "utf-8",
        );
      }
      const rejected = await runI18nSetup({
        projectDir: nsRoot,
        mode: "create", // quiet: keeps the expected refusal out of the test log
        presets: { namespaces: [...DEFAULT_NAMESPACES, "billing"], confirm: true },
      });
      assert(rejected.ok === false, "an unshipped namespace is refused");
      assert(
        rejected.written.length === 0,
        "…before anything is written, so a refusal leaves no half-generated tree",
      );
      assert(
        rejected.manualResidue.some((s) => s.includes("billing") && /template/i.test(s)),
        `…and the message names the namespace and the fix (${rejected.manualResidue.join(" | ")})`,
      );
      // The default set must still be accepted, or the check is just broken.
      const accepted = await runI18nSetup({
        projectDir: nsRoot,
        mode: "create",
        presets: { namespaces: [...DEFAULT_NAMESPACES], confirm: true },
      });
      assert(accepted.ok === true, "…while the default namespace set is accepted");
    } finally {
      rmSync(nsRoot, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nAll i18n seam tests passed.\n" : `\n${failed} check(s) failed.\n`);
process.exit(failed > 0 ? 1 : 0);
