/**
 * Catalog parity tests.
 *
 * `parity.ts` is the checker for everything the TYPE system cannot see. The
 * types prove a translation has the same keys as its source; they say nothing
 * about what is inside a message. Three failures pass `tsc` and then break in
 * front of a reader:
 *
 *   · a renamed ICU argument (`{project}` → `{projekt}`) type-checks and
 *     renders literal braces;
 *   · malformed ICU throws or renders raw at runtime, per message;
 *   · a whole source sentence left in the source language is simply not
 *     translated, and nothing complains.
 *
 * This file drives the checker over hand-built cases for each of those, then
 * over the REAL rendered catalogs for every target locale hatchkit offers.
 * That second half is what keeps the shipped templates honest: if a template
 * author renames a placeholder in a translation, this test fails here rather
 * than in a user's project.
 *
 * Run: pnpm --filter hatchkit test:i18n-parity
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SUPPORTED_LOCALES } from "./src/features/i18n/locales.js";
import {
  checkCatalogParity,
  flattenCatalog,
  messagePlaceholders,
  validateIcu,
} from "./src/features/i18n/parity.js";
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

function kinds(issues: { kind: string }[]): string[] {
  return [...new Set(issues.map((i) => i.kind))].sort();
}

// ---------------------------------------------------------------------------
// 1. messagePlaceholders — including the nested case.
//
// A naive regex finds `{count}` in `{count, plural, ...}` but misses
// `{thing}` used only inside a plural BRANCH. A placeholder the checker
// cannot see is a placeholder it cannot protect, so this is the case that
// decides whether the whole parity idea works.
// ---------------------------------------------------------------------------
console.log("\n── messagePlaceholders ──────────────────────────────────────────────────────");
{
  const flat = messagePlaceholders("Hello {name}, you have {n} items");
  assert(
    flat.args.has("name") && flat.args.has("n") && flat.args.size === 2,
    "flat arguments extracted",
  );

  const nested = messagePlaceholders(
    "{count, plural, one {# {thing} left} other {# {thing}s left}}",
  );
  assert(
    nested.args.has("count") && nested.args.has("thing"),
    "an argument used only inside a plural branch is found (the case a regex misses)",
  );

  const select = messagePlaceholders(
    "{status, select, draft {Saved as draft by {author}} other {Published by {author}}}",
  );
  assert(select.args.has("status") && select.args.has("author"), "select branches are walked");

  const tagged = messagePlaceholders("Read the <b>terms</b> and the <link>policy</link>");
  assert(
    tagged.tags.has("b") && tagged.tags.has("link") && tagged.tags.size === 2,
    "tag names extracted",
  );

  const quoted = messagePlaceholders("Use '{' to open a placeholder");
  assert(quoted.args.size === 0, "an ICU-quoted brace contributes no argument");

  const typed = messagePlaceholders("Due {date, date, medium} — {amount, number}");
  assert(
    typed.args.has("date") && typed.args.has("amount") && typed.args.size === 2,
    "simple-argument types do not leak into the argument names",
  );
}

// ---------------------------------------------------------------------------
// 2. validateIcu.
// ---------------------------------------------------------------------------
console.log("\n── validateIcu ──────────────────────────────────────────────────────────────");
{
  assert(validateIcu("Plain text") === null, "plain text is valid");
  assert(validateIcu("Hello {name}") === null, "a simple argument is valid");
  assert(
    validateIcu("{n, plural, one {# item} other {# items}}") === null,
    "a plural with an `other` branch is valid",
  );
  assert(validateIcu("Use '{' here") === null, "ICU apostrophe quoting is honoured");

  assert(validateIcu("Hello {name") !== null, "an unbalanced brace is reported");
  assert(validateIcu("Hello {}") !== null, "an empty argument name is reported");
  assert(
    validateIcu("{n, plural, one {# item}}") !== null,
    "a plural with no `other` branch is reported",
  );
  assert(
    validateIcu("{n, select, a {A}}") !== null,
    "a select with no `other` branch is reported",
  );
  assert(
    validateIcu("{n, ordinal, other {#th}}") !== null,
    "an unknown argument type is reported (use selectordinal)",
  );
  assert(
    validateIcu("{n, selectordinal, other {#th}}") === null,
    "selectordinal is a known type",
  );
}

// ---------------------------------------------------------------------------
// 3. flattenCatalog.
// ---------------------------------------------------------------------------
console.log("\n── flattenCatalog ───────────────────────────────────────────────────────────");
{
  const flat = flattenCatalog({ a: "A", b: { c: "C", d: { e: "E" } } });
  assert(flat["a"] === "A" && flat["b.c"] === "C" && flat["b.d.e"] === "E", "dotted keys produced");
  assert(Object.keys(flat).length === 3, "no intermediate nodes leak into the flat map");
  const withJunk = flattenCatalog({ a: "A", n: 1, u: undefined });
  assert(
    Object.keys(withJunk).length === 1 && withJunk["a"] === "A",
    "non-string leaves are dropped rather than reported",
  );
}

// ---------------------------------------------------------------------------
// 4. checkCatalogParity — one case per failure kind.
// ---------------------------------------------------------------------------
console.log("\n── checkCatalogParity: each failure kind ────────────────────────────────────");
{
  const source = {
    greet: "Hello {name}",
    count: "{n, plural, one {# item} other {# items}}",
    terms: "Read the <b>terms</b>",
    sentence: "Your session has expired, please sign in again",
    brand: "Hatchkit",
  };
  const good = {
    greet: "Hallo {name}",
    count: "{n, plural, one {# Eintrag} other {# Einträge}}",
    terms: "Lies die <b>Bedingungen</b>",
    sentence: "Deine Sitzung ist abgelaufen, bitte melde dich erneut an",
    brand: "Hatchkit",
  };

  const clean = checkCatalogParity({
    namespace: "t",
    sourceLocale: "en",
    source,
    translations: { de: good },
    allowUntranslated: ["brand"],
  });
  assert(clean.length === 0, `a correct pair reports nothing (got ${kinds(clean).join(", ")})`);

  // The renamed placeholder — the reason this checker exists.
  const renamed = checkCatalogParity({
    namespace: "t",
    sourceLocale: "en",
    source,
    translations: { de: { ...good, greet: "Hallo {vorname}" } },
    allowUntranslated: ["brand"],
  });
  assert(
    renamed.some((i) => i.kind === "placeholder-mismatch" && i.key === "greet"),
    "a renamed placeholder is reported as placeholder-mismatch",
  );

  const renamedTag = checkCatalogParity({
    namespace: "t",
    sourceLocale: "en",
    source,
    translations: { de: { ...good, terms: "Lies die <fett>Bedingungen</fett>" } },
    allowUntranslated: ["brand"],
  });
  assert(
    renamedTag.some((i) => i.kind === "tag-mismatch" && i.key === "terms"),
    "a renamed tag is reported as tag-mismatch",
  );

  const missing = { ...good } as Record<string, string>;
  delete missing["count"];
  const missingIssues = checkCatalogParity({
    namespace: "t",
    sourceLocale: "en",
    source,
    translations: { de: missing },
    allowUntranslated: ["brand"],
  });
  assert(
    missingIssues.some((i) => i.kind === "missing-key" && i.key === "count"),
    "a missing key is reported",
  );

  const extra = checkCatalogParity({
    namespace: "t",
    sourceLocale: "en",
    source,
    translations: { de: { ...good, leftover: "Alt" } },
    allowUntranslated: ["brand"],
  });
  assert(
    extra.some((i) => i.kind === "extra-key" && i.key === "leftover"),
    "an extra key is reported",
  );

  const badTarget = checkCatalogParity({
    namespace: "t",
    sourceLocale: "en",
    source,
    translations: { de: { ...good, greet: "Hallo {name" } },
    allowUntranslated: ["brand"],
  });
  assert(
    badTarget.some((i) => i.kind === "invalid-icu" && i.locale === "de"),
    "invalid ICU in the translation is reported against the translation",
  );

  const badSource = checkCatalogParity({
    namespace: "t",
    sourceLocale: "en",
    source: { ...source, greet: "Hello {name" },
    translations: { de: good },
    allowUntranslated: ["brand"],
  });
  assert(
    badSource.some((i) => i.kind === "invalid-icu" && i.locale === "en"),
    "invalid ICU in the SOURCE is reported too — our bug, not the translator's",
  );
  assert(
    badSource.filter((i) => i.kind === "invalid-icu" && i.locale === "en").length === 1,
    "a malformed source message is reported once, not once per target locale",
  );
  assert(
    !badSource.some((i) => i.kind === "placeholder-mismatch" && i.key === "greet"),
    "a malformed source message does not also blame the translator for a mismatch",
  );

  const untranslated = checkCatalogParity({
    namespace: "t",
    sourceLocale: "en",
    source,
    translations: {
      de: { ...good, sentence: "Your session has expired, please sign in again" },
    },
    allowUntranslated: ["brand"],
  });
  assert(
    untranslated.some((i) => i.kind === "untranslated" && i.key === "sentence"),
    "a whole source sentence left untranslated is reported",
  );

  // Without the allow-list the brand name would trip too — that is why the
  // escape hatch exists, and why it is per-key rather than a global switch.
  const noAllow = checkCatalogParity({
    namespace: "t",
    sourceLocale: "en",
    source: { brand: "Hatchkit Pro", s: "Hello there friend" },
    translations: { de: { brand: "Hatchkit Pro", s: "Hallo Freund" } },
  });
  assert(
    noAllow.some((i) => i.kind === "untranslated" && i.key === "brand"),
    "without an allow-list entry a deliberate passthrough is reported",
  );
  const allowed = checkCatalogParity({
    namespace: "t",
    sourceLocale: "en",
    source: { brand: "Hatchkit Pro", s: "Hello there friend" },
    translations: { de: { brand: "Hatchkit Pro", s: "Hallo Freund" } },
    allowUntranslated: ["brand"],
  });
  assert(allowed.length === 0, "an allow-list entry suppresses it");

  // An allow-listed key is still checked for everything else.
  const allowedStillChecked = checkCatalogParity({
    namespace: "t",
    sourceLocale: "en",
    source: { brand: "Hello {name}" },
    translations: { de: { brand: "Hallo {vorname}" } },
    allowUntranslated: ["brand"],
  });
  assert(
    allowedStillChecked.some((i) => i.kind === "placeholder-mismatch"),
    "an allow-listed key is still checked for placeholders",
  );

  // Single words never trip the untranslated check without an allow-list:
  // "OK" and "Name" are the same in plenty of languages.
  const singleWords = checkCatalogParity({
    namespace: "t",
    sourceLocale: "en",
    source: { ok: "OK", name: "Name" },
    translations: { de: { ok: "OK", name: "Name" } },
  });
  assert(
    singleWords.length === 0,
    "a single word identical in both languages is not reported as untranslated",
  );
}

// ---------------------------------------------------------------------------
// 5. The real catalogs.
//
// Render for every target locale hatchkit offers and run the checker over
// what actually ships. The catalog templates carry one worked German
// translation, so a non-German target renders German stubs — which is
// structurally correct and loudly documented in the template header. What
// must hold for EVERY target is the part a translator cannot fix later:
// identical placeholders, identical tags, valid ICU, and no source sentence
// left in place.
// ---------------------------------------------------------------------------
console.log("\n── the shipped catalogs, per target locale ──────────────────────────────────");

/** Pull `export const <name>... = { … };` out of a rendered catalog and
 *  evaluate the object literal. The catalogs are string-valued nested
 *  objects, so this is a safe read — and it is the only way to see them
 *  from here, since a rendered file's `import type` lines do not resolve
 *  outside a real project.
 *
 *  `todo()` is the seeded-stub marker the server translation catalogs use
 *  (`todo("Receipt")` renders as `TODO(de) Receipt`). It is evaluated with
 *  the SAME wording the template defines, so the checker sees the string
 *  that would really ship — a stub is visibly wrong in a preview rather
 *  than looking like a deliberate choice, and it is not byte-identical to
 *  the source, so it is a stub rather than an untranslated sentence. */
function extractCatalog(src: string, locale: string): Record<string, string> {
  const stripped = stripComments(src);
  const decl = stripped.indexOf("export const ");
  if (decl === -1) throw new Error("no `export const` in catalog");
  const open = stripped.indexOf("{", stripped.indexOf("=", decl));
  if (open === -1) throw new Error("no object literal in catalog");
  const close = matchBrace(stripped, open);
  const literal = stripped.slice(open, close + 1);
  const todo = (message: string): string => `TODO(${locale}) ${message}`;
  // biome-ignore lint/security/noGlobalEval: reading our own rendered template
  const value = new Function("todo", `return (${literal});`)(todo) as unknown;
  return flattenCatalog(value);
}

/** Remove comments without touching braces inside string literals — the
 *  catalogs are full of `{count, plural, …}`, and a naive strip would
 *  unbalance them. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = endOfString(src, i);
      out += src.slice(i, end + 1);
      i = end + 1;
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

function endOfString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i;
    i++;
  }
  return src.length - 1;
}

function matchBrace(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = endOfString(src, i) + 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error("unbalanced braces in catalog");
}

function config(target: string): I18nConfig {
  return {
    sourceLocale: "en",
    targetLocales: [target],
    namespaces: ["common", "app", "marketing"],
    publicPages: true,
    serverCatalogs: true,
    pseudoLocale: true,
    gateFailsafeMs: 4000,
  };
}

const CLIENT_NAMESPACES = ["common", "app", "marketing"];
const SERVER_NAMESPACES = ["email", "document"];
const TARGETS = Object.keys(SUPPORTED_LOCALES).filter((c) => c !== "en");

for (const target of TARGETS) {
  const root = mkdtempSync(join(tmpdir(), `i18n-parity-${target}-`));
  try {
    writeI18nFiles({
      projectDir: root,
      config: config(target),
      pkgScope: "@starter",
      appName: "Tiao",
    });

    const issues: { kind: string; namespace: string; key: string; detail: string }[] = [];

    for (const ns of CLIENT_NAMESPACES) {
      const src = extractCatalog(
        readFileSync(join(root, `packages/client/src/i18n/messages/en/${ns}.ts`), "utf-8"),
        "en",
      );
      const tgt = extractCatalog(
        readFileSync(join(root, `packages/client/src/i18n/messages/${target}/${ns}.ts`), "utf-8"),
        target,
      );
      issues.push(
        ...checkCatalogParity({
          namespace: ns,
          sourceLocale: "en",
          source: src,
          translations: { [target]: tgt },
        }),
      );
    }
    for (const ns of SERVER_NAMESPACES) {
      const src = extractCatalog(
        readFileSync(join(root, `packages/server/src/i18n/messages/en/${ns}.ts`), "utf-8"),
        "en",
      );
      const tgt = extractCatalog(
        readFileSync(join(root, `packages/server/src/i18n/messages/${target}/${ns}.ts`), "utf-8"),
        target,
      );
      issues.push(
        ...checkCatalogParity({
          namespace: `server/${ns}`,
          sourceLocale: "en",
          source: src,
          translations: { [target]: tgt },
        }),
      );
    }

    assert(
      issues.length === 0,
      `${target}: shipped catalogs are clean${
        issues.length
          ? ` — ${issues
              .slice(0, 6)
              .map((i) => `${i.kind} ${i.namespace}.${i.key}: ${i.detail}`)
              .join("; ")}`
          : ""
      }`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The catalogs exercise the machinery they are checked with. A catalog of
// bare strings would pass every check above and prove nothing.
console.log("\n── the shipped catalogs exercise the checker ────────────────────────────────");
{
  const root = mkdtempSync(join(tmpdir(), "i18n-parity-shape-"));
  try {
    writeI18nFiles({
      projectDir: root,
      config: config("de"),
      pkgScope: "@starter",
      appName: "Tiao",
    });
    const all: Record<string, string> = {};
    for (const ns of CLIENT_NAMESPACES) {
      Object.assign(
        all,
        extractCatalog(
          readFileSync(join(root, `packages/client/src/i18n/messages/en/${ns}.ts`), "utf-8"),
          "en",
        ),
      );
    }
    const messages = Object.values(all);
    assert(messages.length >= 40, `source catalogs carry real content (${messages.length} messages)`);
    assert(
      messages.some((m) => /\{[^}]*,\s*plural\s*,/.test(m) && m.includes("#")),
      "at least one ICU plural using `#`",
    );
    assert(
      messages.some((m) => /\{[^}]*,\s*select\s*,/.test(m)),
      "at least one ICU select",
    );
    assert(
      messages.some((m) => /\{[^}]*,\s*(date|time|number)\b/.test(m)),
      "at least one date/number argument",
    );
    assert(
      messages.some((m) => messagePlaceholders(m).tags.size > 0),
      "at least one message with a rich tag",
    );
    assert(
      messages.some((m) => messagePlaceholders(m).args.size >= 2),
      "at least one message with two arguments",
    );

    // The German seed is documented, not accidental: a translator opening
    // the fr catalog must be told it is German.
    const frRoot = mkdtempSync(join(tmpdir(), "i18n-parity-fr-note-"));
    try {
      writeI18nFiles({
        projectDir: frRoot,
        config: config("fr"),
        pkgScope: "@starter",
        appName: "Tiao",
      });
      const fr = readFileSync(
        join(frRoot, "packages/client/src/i18n/messages/fr/common.ts"),
        "utf-8",
      );
      assert(
        /SEEDED FROM GERMAN/i.test(fr),
        "a non-German target catalog says in its header that it is a German stub",
      );
    } finally {
      rmSync(frRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(failed === 0 ? "\nAll i18n parity tests passed.\n" : `\n${failed} check(s) failed.\n`);
process.exit(failed > 0 ? 1 : 0);
