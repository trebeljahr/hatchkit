/**
 * Pseudo-locale tests.
 *
 * The pseudo-locale is a development tool with one production requirement: a
 * production build must contain NO TRACE of it. That is not a policy, it is a
 * bundling property — the switch has to sit behind a `process.env.NODE_ENV`
 * comparison in a position the bundler can fold to a constant, or the
 * accented strings and the query-parameter switch ship to users.
 *
 * It also has to be worth running. A pseudo-locale earns its place by finding
 * two bugs no translation test can:
 *
 *   · text that comes out UNACCENTED was never extracted — it is hardcoded in
 *     a component and no translator will ever see it;
 *   · text that clips at ~a third more characters will clip in a real
 *     translation.
 *
 * Both of those depend on the transform touching every letter of the human
 * text and NONE of the ICU syntax. A pseudo-locale that mangles a placeholder
 * tests nothing, because every message then looks broken.
 *
 * These checks run the rendered templates for real: the module is written to a
 * temp dir with its one import pointed at a stub, then imported, so the
 * assertions are about behaviour rather than about the text of a template.
 *
 * Run: pnpm --filter hatchkit test:i18n-pseudo
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PSEUDO_EXPANSION_RATIO } from "./src/features/i18n/plan.js";
import { messagePlaceholders, validateIcu } from "./src/features/i18n/parity.js";
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

const CONFIG: I18nConfig = {
  sourceLocale: "en",
  targetLocales: ["de"],
  namespaces: ["common", "app", "marketing"],
  publicPages: true,
  serverCatalogs: true,
  pseudoLocale: true,
  gateFailsafeMs: 4000,
};

const root = mkdtempSync(join(tmpdir(), "i18n-pseudo-"));

try {
  writeI18nFiles({ projectDir: root, config: CONFIG, pkgScope: "@starter", appName: "Tiao" });

  const pseudoSrc = readFileSync(join(root, "packages/client/src/i18n/pseudo.ts"), "utf-8");
  const prePaintSrc = readFileSync(join(root, "packages/client/src/app/pre-paint.ts"), "utf-8");

  // -------------------------------------------------------------------------
  // 1. The production guarantee, structurally.
  //
  // What matters is not that the string "NODE_ENV" appears but that the
  // pseudo-locale sits on the dead side of a comparison a bundler evaluates
  // at build time. A runtime flag, a config lookup or a function call the
  // bundler cannot see through would all read as "guarded" and still ship.
  // -------------------------------------------------------------------------
  console.log("\n── the production guarantee ─────────────────────────────────────────────────");
  {
    const FOLDABLE = /process\.env\.NODE_ENV\s*!==\s*"production"/;
    assert(FOLDABLE.test(pseudoSrc), "pseudo.ts guards on a foldable NODE_ENV comparison");
    assert(
      FOLDABLE.test(prePaintSrc),
      "pre-paint.ts guards the pseudo branch on a foldable NODE_ENV comparison",
    );

    // The pre-paint script is the one that ships inline in every HTML file,
    // so its guard has to be at MODULE scope: a check inside a function
    // still leaves the accented branch in the bundle.
    const moduleScopeTernary =
      /^export const PSEUDO_BRANCH[^=]*=\s*\n?\s*process\.env\.NODE_ENV\s*!==\s*"production"\s*\n?\s*\?/m;
    assert(
      moduleScopeTernary.test(prePaintSrc),
      "the pseudo branch is a module-scope ternary, not a runtime check inside a function",
    );

    // And the script must be composed from that constant, so folding it to
    // "" really does remove the branch from the emitted script.
    assert(
      /LOCALE_SCRIPT[^=]*=\s*localeScript\(PSEUDO_BRANCH\)/.test(prePaintSrc),
      "LOCALE_SCRIPT is built from the foldable constant rather than inlining the branch",
    );

    // Nothing that always exists may import the pseudo module: an
    // unconditional import would pull it into the graph in every build.
    const alwaysPresent = [
      "packages/client/src/i18n/store.ts",
      "packages/client/src/i18n/use-t.ts",
      "packages/client/src/i18n/format.ts",
      "packages/client/src/i18n/locale-root.tsx",
      "packages/client/src/app/pre-paint.ts",
      "packages/shared/src/locale.ts",
    ];
    const importers = alwaysPresent.filter((p) =>
      /from\s+"[^"]*i18n\/pseudo"|from\s+"\.\/pseudo"/.test(readFileSync(join(root, p), "utf-8")),
    );
    assert(
      importers.length === 0,
      `no always-present module imports pseudo.ts${importers.length ? ` (${importers.join(", ")})` : ""}`,
    );

    // Self-registration is what makes that safe: the single
    // `import "@/i18n/pseudo"` is the whole wiring, and it is guarded.
    assert(
      /enablePseudoLocale\(\);?\s*$/.test(pseudoSrc.trimEnd()),
      "pseudo.ts self-registers, so the one import IS the wiring",
    );
    assert(
      /function enablePseudoLocale[\s\S]{0,200}?isPseudoAvailable\(\)/.test(pseudoSrc),
      "self-registration is itself guarded, so an accidental import cannot ship it",
    );
  }

  // -------------------------------------------------------------------------
  // 2. The two script shapes.
  // -------------------------------------------------------------------------
  console.log("\n── the emitted script, dev vs production ───────────────────────────────────");
  {
    const mod = (await import(
      pathToFileURL(join(root, "packages/client/src/app/pre-paint.ts")).href
    )) as {
      LOCALE_SCRIPT: string;
      PSEUDO_BRANCH: string;
      localeScript: (pseudoBranch: string) => string;
    };

    const production = mod.localeScript("");
    assert(
      !/pseudo/i.test(production),
      "the production script contains no trace of the pseudo-locale",
    );
    assert(
      production.length > 0 && production.includes("lang"),
      "the production script still resolves the language and sets lang",
    );

    // The dev shape is the same script plus the branch — not a different
    // resolver. If the two diverged, the pseudo-locale would be testing a
    // code path that never runs for a reader.
    const dev = mod.localeScript(mod.PSEUDO_BRANCH || 'if(0){}');
    assert(
      dev.length >= production.length,
      "the dev script is the production script plus the branch",
    );
    assert(
      mod.PSEUDO_BRANCH === "" || /locale-pseudo/.test(mod.LOCALE_SCRIPT),
      "with the branch present, the emitted script honours ?locale=pseudo",
    );
    assert(
      mod.PSEUDO_BRANCH === "" ||
        (/q==="pseudo"/.test(mod.PSEUDO_BRANCH) && /q==="off"/.test(mod.PSEUDO_BRANCH)),
      "the branch handles both ?locale=pseudo and ?locale=off",
    );

    // The gate condition has to widen with the branch: a pseudo render is
    // not the source language either, so it must wait behind the gate too,
    // or the reader sees unaccented text flash first.
    assert(
      mod.PSEUDO_BRANCH === "" || /\|\|ps/.test(mod.LOCALE_SCRIPT),
      "the first-paint gate also waits for a pseudo render",
    );
  }

  // -------------------------------------------------------------------------
  // 3. pseudoize, for real.
  // -------------------------------------------------------------------------
  console.log("\n── pseudoize ───────────────────────────────────────────────────────────────");
  {
    // The module's only import is the store, and only `setMessageTransform`
    // is called. Point it at a stub so the rendered file runs unmodified
    // apart from that one specifier.
    const sandbox = join(root, "sandbox");
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(
      join(sandbox, "store-stub.ts"),
      "export type MessageTransform = (m: string) => string;\n" +
        "export let registered: MessageTransform | null = null;\n" +
        "export function setMessageTransform(fn: MessageTransform | null): void { registered = fn; }\n",
      "utf-8",
    );
    writeFileSync(
      join(sandbox, "pseudo.ts"),
      pseudoSrc.replace('from "@/i18n/store"', 'from "./store-stub.js"'),
      "utf-8",
    );

    const mod = (await import(pathToFileURL(join(sandbox, "pseudo.ts")).href)) as {
      pseudoize: (m: string) => string;
      isPseudoAvailable: () => boolean;
      PSEUDO_LOCALE: string;
    };
    const stub = (await import(pathToFileURL(join(sandbox, "store-stub.ts")).href)) as {
      registered: ((m: string) => string) | null;
    };

    const { pseudoize } = mod;
    assert(mod.PSEUDO_LOCALE === "pseudo", 'PSEUDO_LOCALE is "pseudo"');
    assert(
      typeof stub.registered === "function",
      "importing the module registered the transform with the store",
    );

    // Bracketed, so a glance tells you which language you are looking at.
    const simple = pseudoize("Save");
    assert(simple.startsWith("[⟦") && simple.endsWith("⟧]"), `bracketed (${simple})`);

    // Every letter accented. Unaccented text on screen means unextracted
    // text, so a letter this transform skips is a bug it will not find.
    const sentence = "Your session has expired";
    const accented = pseudoize(sentence);
    const plainLetters = [...accented].filter((c) => /[A-Za-z]/.test(c));
    assert(
      plainLetters.length === 0,
      `no unaccented ASCII letter survives${plainLetters.length ? ` (${plainLetters.join("")})` : ""}`,
    );

    // …and none of the ICU syntax touched.
    const cases = [
      "Hello {name}, welcome back",
      "{count, plural, one {# item left} other {# items left}}",
      "{status, select, draft {Saved as a draft} other {Published}}",
      "Read the <b>terms</b> and the <link>privacy policy</link>",
      "Due {date, date, medium} for {amount, number}",
      "{n, plural, offset:1 one {you and # other} other {you and # others}}",
      "Use '{' to open a placeholder",
    ];
    for (const message of cases) {
      const out = pseudoize(message);
      const before = messagePlaceholders(message);
      const after = messagePlaceholders(out);
      const sameArgs =
        before.args.size === after.args.size && [...before.args].every((a) => after.args.has(a));
      const sameTags =
        before.tags.size === after.tags.size && [...before.tags].every((t) => after.tags.has(t));
      assert(sameArgs, `arguments preserved: ${message.slice(0, 44)}`);
      assert(sameTags, `tags preserved: ${message.slice(0, 44)}`);
      assert(validateIcu(out) === null, `still valid ICU: ${message.slice(0, 44)}`);
    }

    // A `#` inside a plural branch is ICU, not a letter to accent.
    const plural = pseudoize("{count, plural, one {# item} other {# items}}");
    assert(
      (plural.match(/#/g) ?? []).length === 2,
      "the plural `#` placeholder survives in every branch",
    );
    // And a plural SELECTOR is syntax: accenting `one`/`other` would make
    // the message select nothing.
    assert(
      /\bone\s*\{/.test(plural) && /\bother\s*\{/.test(plural),
      "plural selectors are left unaccented — they are syntax, not text",
    );

    // Expansion. Measured on letters, which is what the padding is derived
    // from, and tolerant because the pad comes in word-sized runs.
    const long =
      "Everything you save is yours and you can export it at any time from the settings screen";
    const expanded = pseudoize(long);
    const sourceLetters = (long.match(/[A-Za-z]/g) ?? []).length;
    const padChars = (expanded.match(/~/g) ?? []).length;
    const ratio = padChars / sourceLetters;
    assert(
      Math.abs(ratio - PSEUDO_EXPANSION_RATIO) <= 0.05,
      `expansion is ~${PSEUDO_EXPANSION_RATIO} of the source (measured ${ratio.toFixed(3)})`,
    );
    assert(
      expanded.length > long.length,
      "the result is longer than the source, so clipping shows up",
    );
    // Word-sized padding runs: one unbroken tail can never wrap, and would
    // report a sentence as overflowing where a real translation fits.
    const runs = expanded.match(/~+/g) ?? [];
    assert(
      runs.length > 1 && runs.every((r) => r.length <= 8),
      `padding comes in wrappable runs (${runs.length} runs, longest ${Math.max(...runs.map((r) => r.length))})`,
    );

    // A message that is nothing but a placeholder has no text to lengthen,
    // and bracketing it would make the layout lie about its width.
    assert(pseudoize("{count}") === "{count}", "a placeholder-only message is left alone");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nAll i18n pseudo-locale tests passed.\n" : `\n${failed} check(s) failed.\n`);
process.exit(failed > 0 ? 1 : 0);
