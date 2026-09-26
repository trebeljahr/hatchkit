/*
 * The server's own catalogs, and the two precedence tables that decide the
 * language of something a person keeps.
 *
 * Three silent failures live here, none of them visible to the compiler:
 *
 *   · A renamed ICU argument in a translated email — "{name}" become
 *     "{Name}" — type-checks and mails literal braces to a customer. The
 *     parity checker below is the same algorithm the client test runs, and
 *     the same one hatchkit runs over the catalogs it ships.
 *   · A resolver that treats "system" as a device answer. The server has no
 *     device. Guessing here sends a German invoice to somebody who never
 *     asked for German, and the only witness is the invoice.
 *   · A document whose language is recomputed at render time. A PDF or an
 *     email is snapshotted in the language it was issued in; re-rendering it
 *     in today's preference changes a document somebody already holds.
 *
 * Runner: `node --import tsx --test src/tests/*.test.ts`, like the rest of
 * this package.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  isSupportedLocale,
  SOURCE_LOCALE,
  SUPPORTED_LOCALES,
  type LocalePreference,
  type SupportedLocale,
} from "__HATCHKIT_PKG_SCOPE__/shared";
import { serverMessages, serverT, type ServerNamespace } from "../i18n/index.js";
import { resolveDocumentLocale, resolveEmailLocale } from "../i18n/resolve.js";

const TARGET_LOCALE = "__HATCHKIT_TARGET_LOCALE__" as SupportedLocale;

/** `satisfies` rather than a hand-written union: add a namespace to
 *  `serverMessages` and this line is where the compiler asks for its tests. */
const NAMESPACES = ["email", "document"] as const satisfies readonly ServerNamespace[];

const TARGET_LOCALES = SUPPORTED_LOCALES.filter((locale) => locale !== SOURCE_LOCALE);

/** The locales `serverMessages` actually carries. A third language's catalog
 *  FILES are written by hatchkit, but its two imports and its map entry are a
 *  manual step, and until they exist `serverT` falls back to the source
 *  language on purpose — so the parity loop reads the files while the
 *  translator check below reads the map. */
const REGISTERED = Object.keys(serverMessages).filter(isSupportedLocale);

/** A dynamic import so ONE test file covers every configured language: the
 *  catalogs are one directory per locale and the list of locales lives in the
 *  shared package, so a language added there is checked here without an
 *  import line for somebody to forget. Each file exports its namespace by
 *  name (`export const email = …`). */
async function loadCatalog(
  locale: SupportedLocale,
  namespace: ServerNamespace,
): Promise<Record<string, string>> {
  const mod = (await import(`../i18n/messages/${locale}/${namespace}.js`)) as Record<
    string,
    unknown
  >;
  const catalog = flattenCatalog(mod[namespace]);
  assert.ok(
    Object.keys(catalog).length > 0,
    `messages/${locale}/${namespace}.ts exports no "${namespace}" catalog`,
  );
  return catalog;
}

for (const namespace of NAMESPACES) {
  for (const locale of TARGET_LOCALES) {
    test(`${namespace}/${locale}: same ICU arguments, same tags, valid syntax`, async () => {
      const issues = checkCatalogParity({
        namespace,
        sourceLocale: SOURCE_LOCALE,
        source: await loadCatalog(SOURCE_LOCALE, namespace),
        translations: { [locale]: await loadCatalog(locale, namespace) },
      });
      assert.deepEqual(issues.map(describeIssue), []);
    });
  }
}

test("serverT answers in the locale it is handed", async () => {
  for (const namespace of NAMESPACES) {
    const source = await loadCatalog(SOURCE_LOCALE, namespace);
    // Probed with a message that takes no arguments, chosen from the catalog
    // rather than hardcoded so the assertion survives a rewording. The cast
    // is the price of a runtime key against a translator typed on literals.
    const key = Object.keys(source).find((k) => !/[{<]/.test(source[k]));
    assert.ok(key, `${namespace} has no argument-free message to probe with`);

    for (const locale of REGISTERED) {
      const catalog = await loadCatalog(locale, namespace);
      const t = serverT(locale, namespace) as unknown as (k: string) => string;
      assert.equal(t(key), catalog[key], `serverT("${locale}", "${namespace}") answered ${key}`);
    }
  }
});

interface EmailRow {
  name: string;
  recipient?: LocalePreference;
  sender?: LocalePreference;
  expected: SupportedLocale;
}

/** Recipient's explicit preference, then the sender's, then the source. */
const EMAIL_ROWS: readonly EmailRow[] = [
  { name: "the recipient chose a language", recipient: TARGET_LOCALE, expected: TARGET_LOCALE },
  {
    // An invitation to an address with no account: there is no recipient to
    // ask, so the sender's language is the best guess available.
    name: "no recipient preference, the sender chose one",
    sender: TARGET_LOCALE,
    expected: TARGET_LOCALE,
  },
  {
    // "system" is a question about a device, and mail has none.
    name: '"system" from the recipient falls through to the sender',
    recipient: "system",
    sender: TARGET_LOCALE,
    expected: TARGET_LOCALE,
  },
  {
    name: "the recipient outranks the sender",
    recipient: SOURCE_LOCALE,
    sender: TARGET_LOCALE,
    expected: SOURCE_LOCALE,
  },
  { name: '"system" on both sides', recipient: "system", sender: "system", expected: SOURCE_LOCALE },
  { name: "nobody chose anything", expected: SOURCE_LOCALE },
];

for (const row of EMAIL_ROWS) {
  test(`resolveEmailLocale: ${row.name}`, () => {
    assert.equal(
      resolveEmailLocale({ recipient: row.recipient, sender: row.sender }),
      row.expected,
    );
  });
}

interface DocumentRow {
  name: string;
  override?: LocalePreference;
  subject?: LocalePreference;
  issuer?: LocalePreference;
  expected: SupportedLocale;
}

/** Override, then the subject's preference, then the issuer's, then the
 *  source. The override is how a snapshot is replayed. */
const DOCUMENT_ROWS: readonly DocumentRow[] = [
  { name: "an explicit override", override: TARGET_LOCALE, expected: TARGET_LOCALE },
  { name: "no override, the subject chose", subject: TARGET_LOCALE, expected: TARGET_LOCALE },
  {
    name: "no override, no subject preference, the issuer chose",
    subject: "system",
    issuer: TARGET_LOCALE,
    expected: TARGET_LOCALE,
  },
  {
    name: "the subject outranks the issuer",
    subject: SOURCE_LOCALE,
    issuer: TARGET_LOCALE,
    expected: SOURCE_LOCALE,
  },
  { name: "nobody chose anything", expected: SOURCE_LOCALE },
];

for (const row of DOCUMENT_ROWS) {
  test(`resolveDocumentLocale: ${row.name}`, () => {
    assert.equal(
      resolveDocumentLocale({
        override: row.override,
        subject: row.subject,
        issuer: row.issuer,
      }),
      row.expected,
    );
  });
}

test("a snapshotted document locale comes back unchanged", () => {
  // The document row already holds the language it was issued in. Replaying
  // it as the override must return it verbatim, whatever the subject and the
  // issuer prefer today — a re-render must never change the language of a
  // document somebody already holds.
  assert.equal(
    resolveDocumentLocale({
      override: TARGET_LOCALE,
      subject: SOURCE_LOCALE,
      issuer: SOURCE_LOCALE,
    }),
    TARGET_LOCALE,
  );
  assert.equal(
    resolveDocumentLocale({
      override: SOURCE_LOCALE,
      subject: TARGET_LOCALE,
      issuer: TARGET_LOCALE,
    }),
    SOURCE_LOCALE,
  );
});

/* ------------------------------------------------------------------ *
 * The checker — a port of hatchkit's cli/src/features/i18n/parity.ts,
 * identical to the copy in the client's catalog-parity.test.ts. Change
 * one, change all three: they exist so that the invariant is tested
 * where each set of catalogs actually lives.
 * ------------------------------------------------------------------ */

interface ParityIssue {
  kind:
    | "missing-key"
    | "extra-key"
    | "placeholder-mismatch"
    | "tag-mismatch"
    | "invalid-icu"
    | "untranslated";
  namespace: string;
  locale: string;
  key: string;
  detail: string;
}

interface CheckCatalogParityArgs {
  namespace: string;
  sourceLocale: string;
  source: Record<string, string>;
  translations: Record<string, Record<string, string>>;
  /** Messages that may legitimately read the same in every language: brand
   *  names, "OK", a URL. Suppresses the "identical to the source" report
   *  and nothing else. */
  allowUntranslated?: readonly string[];
}

/** ICU simple-argument and submessage types. Anything else in the type slot
 *  is a typo, and a typo there renders the message raw. */
const KNOWN_ARG_TYPES = new Set(["number", "date", "time", "plural", "select", "selectordinal"]);
const SUBMESSAGE_TYPES = new Set(["plural", "select", "selectordinal"]);
const TAG_RE = /<\/?([A-Za-z][A-Za-z0-9_-]*)\s*\/?>/g;

function describeIssue(issue: ParityIssue): string {
  return `[${issue.kind}] ${issue.namespace}/${issue.locale} ${issue.key}: ${issue.detail}`;
}

function flattenCatalog(obj: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (obj === null || typeof obj !== "object") return out;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else if (value !== null && typeof value === "object") {
      Object.assign(out, flattenCatalog(value, path));
    }
  }
  return out;
}

/** Argument names and tag names, including the ones nested inside plural and
 *  select branches — losing an inner one in translation is exactly what this
 *  catches. */
function messagePlaceholders(message: string): { args: Set<string>; tags: Set<string> } {
  const plain = stripIcuQuotes(message);
  const args = new Set<string>();
  const tags = new Set<string>();
  for (const match of plain.matchAll(TAG_RE)) tags.add(match[1]);
  collectArgs(plain, args);
  return { args, tags };
}

/** Null when the message is structurally sound, else one reason — one,
 *  because the first structural error usually explains the rest. */
function validateIcu(message: string): string | null {
  const plain = stripIcuQuotes(message);
  const balance = checkBraceBalance(plain);
  if (balance) return balance;
  return validateArguments(plain);
}

function checkCatalogParity(args: CheckCatalogParityArgs): ParityIssue[] {
  const { namespace, sourceLocale, source, translations } = args;
  const allow = new Set(args.allowUntranslated ?? []);
  const issues: ParityIssue[] = [];

  // The source is validated once, not once per language: one bug should
  // report once, not bury the translation problems under duplicates.
  const brokenSourceKeys = new Set<string>();
  for (const [key, message] of Object.entries(source)) {
    const err = validateIcu(message);
    if (!err) continue;
    brokenSourceKeys.add(key);
    issues.push({ kind: "invalid-icu", namespace, locale: sourceLocale, key, detail: err });
  }

  for (const [locale, catalog] of Object.entries(translations)) {
    for (const key of Object.keys(source)) {
      if (!Object.hasOwn(catalog, key)) {
        issues.push({
          kind: "missing-key",
          namespace,
          locale,
          key,
          detail: `not present in the ${locale} catalog`,
        });
      }
    }

    for (const key of Object.keys(catalog)) {
      if (!Object.hasOwn(source, key)) {
        issues.push({
          kind: "extra-key",
          namespace,
          locale,
          key,
          detail: `not present in the ${sourceLocale} catalog`,
        });
      }
    }

    for (const [key, sourceMessage] of Object.entries(source)) {
      const translated = catalog[key];
      if (translated === undefined) continue; // already reported as missing-key

      const err = validateIcu(translated);
      if (err) {
        issues.push({ kind: "invalid-icu", namespace, locale, key, detail: err });
        continue; // placeholders read off a malformed message are noise
      }
      // And the other way round: comparing against a source we could not
      // parse would blame the translator for our own bug.
      if (brokenSourceKeys.has(key)) continue;

      const from = messagePlaceholders(sourceMessage);
      const to = messagePlaceholders(translated);

      const argDiff = describeSetDiff(from.args, to.args);
      if (argDiff) {
        issues.push({ kind: "placeholder-mismatch", namespace, locale, key, detail: argDiff });
      }
      const tagDiff = describeSetDiff(from.tags, to.tags);
      if (tagDiff) {
        issues.push({ kind: "tag-mismatch", namespace, locale, key, detail: tagDiff });
      }

      if (
        translated === sourceMessage &&
        looksLikeSentence(sourceMessage) &&
        !allow.has(key) &&
        !allow.has(sourceMessage)
      ) {
        issues.push({
          kind: "untranslated",
          namespace,
          locale,
          key,
          detail: `identical to the ${sourceLocale} message: ${JSON.stringify(sourceMessage)}`,
        });
      }
    }
  }

  return issues;
}

/** A single word is a plausible translation of itself ("OK", a product
 *  name). A sentence is not: a space plus a letter is the cheapest signal
 *  that somebody forgot the string. */
function looksLikeSentence(message: string): boolean {
  return /\s/.test(message) && /\p{L}/u.test(message);
}

function describeSetDiff(expected: Set<string>, actual: Set<string>): string | null {
  const missing = [...expected].filter((v) => !actual.has(v)).sort();
  const extra = [...actual].filter((v) => !expected.has(v)).sort();
  if (missing.length === 0 && extra.length === 0) return null;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(", ")}`);
  if (extra.length > 0) parts.push(`unexpected ${extra.join(", ")}`);
  return parts.join("; ");
}

/** Drop ICU-quoted literals: an apostrophe only quotes before a syntax
 *  character, so "don't" survives while "'{'" disappears — and what
 *  disappears cannot be mistaken for an argument or an unbalanced brace. */
function stripIcuQuotes(message: string): string {
  let out = "";
  let i = 0;
  while (i < message.length) {
    const ch = message[i];
    if (ch !== "'") {
      out += ch;
      i++;
      continue;
    }
    const next = message[i + 1];
    if (next === "'") {
      out += "'";
      i += 2;
      continue;
    }
    if (next === "{" || next === "}" || next === "#" || next === "<") {
      const close = message.indexOf("'", i + 2);
      i = close < 0 ? message.length : close + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function checkBraceBalance(plain: string): string | null {
  let depth = 0;
  for (let i = 0; i < plain.length; i++) {
    if (plain[i] === "{") depth++;
    else if (plain[i] === "}") {
      depth--;
      if (depth < 0) return "unexpected `}`";
    }
  }
  return depth > 0 ? "unbalanced `{`" : null;
}

/** Index of the `}` closing the `{` at `open`, or -1. */
function matchBrace(plain: string, open: number): number {
  let depth = 0;
  for (let i = open; i < plain.length; i++) {
    if (plain[i] === "{") depth++;
    else if (plain[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function indexOfTopLevel(plain: string, needle: string): number {
  let depth = 0;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0 && ch === needle) return i;
  }
  return -1;
}

interface ArgParts {
  name: string;
  type: string | null;
  options: string | null;
}

/** Split "count, plural, one {…} other {…}" on TOP-LEVEL commas only — a
 *  nested branch is full of its own. */
function splitArgument(body: string): ArgParts {
  const first = indexOfTopLevel(body, ",");
  if (first < 0) return { name: body.trim(), type: null, options: null };
  const name = body.slice(0, first).trim();
  const rest = body.slice(first + 1);
  const second = indexOfTopLevel(rest, ",");
  if (second < 0) return { name, type: rest.trim(), options: null };
  return { name, type: rest.slice(0, second).trim(), options: rest.slice(second + 1) };
}

interface Branches {
  keys: string[];
  messages: string[];
  error: string | null;
}

/** `key {message}` pairs. `offset:N` is a plural modifier, not a branch, and
 *  carries no body. */
function parseBranches(options: string): Branches {
  const keys: string[] = [];
  const messages: string[] = [];
  let i = 0;
  while (i < options.length) {
    while (i < options.length && /\s/.test(options[i])) i++;
    if (i >= options.length) break;

    const start = i;
    while (i < options.length && options[i] !== "{" && !/\s/.test(options[i])) i++;
    const key = options.slice(start, i);
    if (key === "") return { keys, messages, error: "a branch has no selector" };
    if (key.startsWith("offset:")) continue;

    while (i < options.length && /\s/.test(options[i])) i++;
    if (options[i] !== "{") {
      return { keys, messages, error: `branch "${key}" has no message body` };
    }
    const end = matchBrace(options, i);
    if (end < 0) return { keys, messages, error: `branch "${key}" has an unbalanced body` };
    messages.push(options.slice(i + 1, end));
    keys.push(key);
    i = end + 1;
  }
  return { keys, messages, error: null };
}

function collectArgs(plain: string, args: Set<string>): void {
  let i = 0;
  while (i < plain.length) {
    if (plain[i] !== "{") {
      i++;
      continue;
    }
    const end = matchBrace(plain, i);
    if (end < 0) return; // malformed; validateIcu is the reporter
    const { name, type, options } = splitArgument(plain.slice(i + 1, end));
    if (name !== "") args.add(name);
    if (type !== null && options !== null && SUBMESSAGE_TYPES.has(type)) {
      for (const branch of parseBranches(options).messages) collectArgs(branch, args);
    }
    i = end + 1;
  }
}

function validateArguments(plain: string): string | null {
  let i = 0;
  while (i < plain.length) {
    if (plain[i] !== "{") {
      i++;
      continue;
    }
    const end = matchBrace(plain, i);
    if (end < 0) return "unbalanced `{`";
    const err = validateArgument(plain.slice(i + 1, end));
    if (err) return err;
    i = end + 1;
  }
  return null;
}

function validateArgument(body: string): string | null {
  const { name, type, options } = splitArgument(body);
  if (name === "") return `empty argument name in "{${body}}"`;
  if (/\s/.test(name)) return `argument name "${name}" contains whitespace`;
  if (type === null) return null;
  if (!KNOWN_ARG_TYPES.has(type)) {
    return `unknown argument type "${type}" for "${name}"`;
  }
  if (!SUBMESSAGE_TYPES.has(type)) return null;

  if (options === null) return `"${name}" is a ${type} with no branches`;
  const branches = parseBranches(options);
  if (branches.error) return `"${name}": ${branches.error}`;
  // Without `other` the message throws for whichever plural category the
  // reader's language actually hits.
  if (!branches.keys.includes("other")) {
    return `"${name}" (${type}) has no \`other\` branch`;
  }
  for (const message of branches.messages) {
    const err = validateArguments(message);
    if (err) return err;
  }
  return null;
}
