/*
 * cli/src/features/i18n/parity.ts — The catalog parity checker.
 *
 * This is the real implementation, living in hatchkit where hatchkit's own
 * suite exercises it; the generated project's catalog-parity.test.ts is a
 * thin wrapper over the same algorithm. Putting it here means the shipped
 * template catalogs are themselves checked (cli/test-i18n-parity.ts runs
 * this over every rendered target locale), so hatchkit cannot scaffold a
 * project whose very first test run fails.
 *
 * It checks exactly what the type system cannot see. `Translation<typeof
 * source>` already proves the two catalogs have the same keys and the same
 * shape, and the compiler cannot look inside a string. So:
 *
 *   · A renamed ICU argument type-checks perfectly and renders raw —
 *     "{projekt}" for "{project}" ships literal braces to the reader.
 *   · A dropped or renamed markup tag silently loses the bold, or throws
 *     at render time in the middle of a page.
 *   · A malformed message ("{count, plural, one {…}}" with no `other`)
 *     throws only for the plural category that hits it, which in English
 *     testing is often never.
 *   · A whole source sentence copied into the translation file is a
 *     forgotten string, not a translation — and it type-checks.
 *
 * Deliberately a structural check, not a full ICU parser: it must run in a
 * project's vitest with no dependency, and every failure mode above is
 * structural. It understands ICU apostrophe quoting because a message like
 * "Use '{' for a brace" is otherwise reported as unbalanced.
 */

export interface ParityIssue {
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

/** ICU simple-argument and submessage types. Anything else in the type
 *  slot is a typo, and a typo there renders the message raw. */
const KNOWN_ARG_TYPES = new Set(["number", "date", "time", "plural", "select", "selectordinal"]);

/** The types whose options hold nested messages to walk into. */
const SUBMESSAGE_TYPES = new Set(["plural", "select", "selectordinal"]);

/** `<b>`, `</b>`, `<br/>` — the tag names a message hands to the host. */
const TAG_RE = /<\/?([A-Za-z][A-Za-z0-9_-]*)\s*\/?>/g;

/** Extract ICU argument names ({x}, {x, plural, …}, {x, number}) and tag
 *  names (<b>…</b>) from one message. Nested plural/select branches count:
 *  "{count, plural, one {# {thing}} other {# {thing}s}}" yields count AND
 *  thing, and missing the inner one is the whole point of the check. */
export function messagePlaceholders(message: string): { args: Set<string>; tags: Set<string> } {
  const plain = stripIcuQuotes(message);
  const args = new Set<string>();
  const tags = new Set<string>();
  for (const match of plain.matchAll(TAG_RE)) tags.add(match[1]);
  collectArgs(plain, args);
  return { args, tags };
}

/** Structural ICU validation: balanced braces, a non-empty argument name,
 *  known simple-arg types, plural/select with at least an `other` branch.
 *  Returns null when the message is fine, else one human-readable reason —
 *  one, because the first structural error usually explains the rest. */
export function validateIcu(message: string): string | null {
  const plain = stripIcuQuotes(message);
  const balance = checkBraceBalance(plain);
  if (balance) return balance;
  return validateArguments(plain);
}

/** Turn a nested catalog object into dotted keys. Non-string leaves are
 *  dropped: they are not messages, and reporting them would turn a parity
 *  failure into a shape complaint. */
export function flattenCatalog(obj: unknown, prefix = ""): Record<string, string> {
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

export interface CheckCatalogParityArgs {
  namespace: string;
  sourceLocale: string;
  source: Record<string, string>;
  translations: Record<string /*locale*/, Record<string, string>>;
  /** Messages that may legitimately stay byte-identical in every language:
   *  brand names, "OK", "E-Mail", a URL. An entry suppresses the
   *  `untranslated` report when it matches EITHER the dotted key or the
   *  exact source message — nothing else is relaxed, so a genuinely
   *  forgotten sentence on an allow-listed key still fails ICU and
   *  placeholder checks. The generated test documents its own list inline
   *  so a reviewer sees what was excused and why. */
  allowUntranslated?: readonly string[];
}

export function checkCatalogParity(args: CheckCatalogParityArgs): ParityIssue[] {
  const { namespace, sourceLocale, source, translations } = args;
  const allow = new Set(args.allowUntranslated ?? []);
  const issues: ParityIssue[] = [];

  // Validate the source once, not once per target locale: a broken source
  // message is a single bug, and one copy per language buries the real
  // translation problems under duplicates.
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
      // Same reason in the other direction: comparing against a source we
      // could not parse would blame the translator for our own bug.
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

/* ------------------------------------------------------------------ *
 * internals
 * ------------------------------------------------------------------ */

/** A single word or a bare token is a plausible translation of itself
 *  ("OK", "Email", a product name). A sentence is not: a space plus a
 *  letter is the cheapest signal that somebody forgot the string. */
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

/** Drop ICU-quoted literals. An apostrophe only starts quoting before a
 *  syntax character, so "don't" stays intact while "'{'" disappears — and
 *  what disappears cannot be mistaken for an argument, a tag or an
 *  unbalanced brace. The result is structure only; never show it to a user. */
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

/** Split "count, plural, one {…} other {…}" into its three slots on
 *  TOP-LEVEL commas only — a nested branch is full of its own. */
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

/** Split plural/select options into `key {message}` pairs. `offset:N` is a
 *  plural modifier, not a branch, and carries no body. */
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
  // reader's language actually hits — which in English testing is often
  // never, and in Polish is Tuesday.
  if (!branches.keys.includes("other")) {
    return `"${name}" (${type}) has no \`other\` branch`;
  }
  for (const message of branches.messages) {
    const err = validateArguments(message);
    if (err) return err;
  }
  return null;
}
