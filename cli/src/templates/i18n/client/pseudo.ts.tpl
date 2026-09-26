/*
 * The pseudo-locale: the source catalog, accented, padded and bracketed, so a
 * layout can be checked against a longer language before that language
 * exists.
 *
 * `?locale=pseudo` turns it on (the pre-paint script persists it),
 * `?locale=off` turns it off, and the picker in components/language-picker.tsx
 * offers it in a development build. Two bugs it finds that no translation test
 * can:
 *
 *   · Text that shows up UNACCENTED was never extracted. It is a hardcoded
 *     string in a component, and no translator will ever see it.
 *   · Text that is clipped, truncated or wraps badly at
 *     __HATCHKIT_PSEUDO_EXPANSION__ more characters will do the same in
 *     __HATCHKIT_TARGET_LABEL_EN__, which runs about a third longer than
 *     "__HATCHKIT_SOURCE_LOCALE__" for the same sentence.
 *
 * NOT PRESENT IN A PRODUCTION BUILD. This whole module is written only when
 * the feature was configured with the pseudo-locale on, and nothing that
 * always exists imports it — it registers itself with the store on import
 * instead. `import "@/i18n/pseudo";` once, anywhere in the client, is the
 * whole wiring; with nothing registered the switch renders the source
 * language, which is the right failure for a development tool.
 *
 * Placeholders, plural selectors, `#` and tags come through untouched, so the
 * result is still a valid ICU message with the same arguments — the parity
 * check would otherwise fail on the pseudo-locale itself.
 */

import { setMessageTransform } from "@/i18n/store";

export const PSEUDO_LOCALE = "pseudo";

/** False in a production build, by a comparison the bundler folds. */
export function isPseudoAvailable(): boolean {
  return process.env.NODE_ENV !== "production";
}

const ACCENTS: Record<string, string> = {
  a: "á", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "í",
  j: "ĵ", k: "ķ", l: "ļ", m: "ɱ", n: "ñ", o: "ó", p: "þ", q: "ǫ", r: "ŕ",
  s: "š", t: "ţ", u: "ú", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "Á", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Í",
  J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ", N: "Ñ", O: "Ó", P: "Þ", Q: "Ǫ", R: "Ŕ",
  S: "Š", T: "Ţ", U: "Ú", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};

/** How much longer than the source the result is. The token is the ratio, so
 *  1 + it is the multiplier — kept in this shape because the hatchkit test
 *  reads the same number. */
const EXPANSION = 1 + __HATCHKIT_PSEUDO_EXPANSION__;

/** Longest unbroken run of padding — about one long compound word. */
const PSEUDO_WORD = 8;

const SELECT_TYPES = new Set(["plural", "select", "selectordinal"]);

/**
 * Apply `map` to the human-readable text of an ICU message and to nothing
 * else.
 *
 * A hand-written walker rather than a regular expression because plural and
 * select BRANCHES contain text that must be mapped while their selectors must
 * not, and because ICU's apostrophe quoting (`Use '{' here`) means a brace is
 * not always a placeholder.
 */
function mapLiterals(message: string, map: (text: string) => string): string {
  let i = 0;

  function readBody(inPlural: boolean, stopAtBrace: boolean): string {
    let out = "";
    let literal = "";

    const flush = (): void => {
      if (literal !== "") {
        out += map(literal);
        literal = "";
      }
    };

    while (i < message.length) {
      const ch = message[i];
      if (stopAtBrace && ch === "}") break;

      if (ch === "'") {
        // "''" is an escaped apostrophe, and prints as one.
        if (message[i + 1] === "'") {
          flush();
          out += "''";
          i += 2;
          continue;
        }
        const next = message[i + 1];
        // "'{" opens a quoted run in which ICU syntax is literal text.
        if (next === "{" || next === "}" || next === "<" || (inPlural && next === "#")) {
          const end = message.indexOf("'", i + 2);
          const stop = end === -1 ? message.length : end + 1;
          flush();
          out += message.slice(i, stop);
          i = stop;
          continue;
        }
        literal += ch;
        i += 1;
        continue;
      }

      if (ch === "#" && inPlural) {
        flush();
        out += "#";
        i += 1;
        continue;
      }

      if (ch === "<") {
        const tag = /^<\/?[A-Za-z][\w-]*\s*\/?>/.exec(message.slice(i));
        if (tag !== null) {
          flush();
          out += tag[0];
          i += tag[0].length;
          continue;
        }
      }

      if (ch === "{") {
        flush();
        out += readArgument();
        continue;
      }

      literal += ch;
      i += 1;
    }

    flush();
    return out;
  }

  function readArgument(): string {
    const start = i;
    i += 1; // {
    const name = /^\s*([^\s,{}]+)\s*/.exec(message.slice(i));
    i += name?.[0].length ?? 0;

    if (message[i] === "}") {
      i += 1;
      return message.slice(start, i);
    }

    i += 1; // ,
    const typeMatch = /^\s*(\w+)\s*/.exec(message.slice(i));
    const type = typeMatch?.[1] ?? "";
    i += typeMatch?.[0].length ?? 0;

    if (!SELECT_TYPES.has(type)) {
      // number, date, time: the style is syntax, and is copied verbatim.
      let depth = 1;
      while (i < message.length && depth > 0) {
        if (message[i] === "{") depth += 1;
        else if (message[i] === "}") depth -= 1;
        i += 1;
      }
      return message.slice(start, i);
    }

    let out = message.slice(start, i);
    if (message[i] === ",") {
      out += ",";
      i += 1;
    }

    // `selector {branch}` pairs, optionally preceded by `offset:n`.
    while (i < message.length) {
      const before = /^\s*/.exec(message.slice(i))?.[0] ?? "";
      out += before;
      i += before.length;
      if (message[i] === "}") {
        i += 1;
        return `${out}}`;
      }
      const selector = /^[^\s{}]+/.exec(message.slice(i))?.[0] ?? "";
      out += selector;
      i += selector.length;
      const after = /^\s*/.exec(message.slice(i))?.[0] ?? "";
      out += after;
      i += after.length;
      if (selector.startsWith("offset:")) continue;
      if (message[i] !== "{") break;
      i += 1;
      // A `select` branch has no `#`; a plural or selectordinal branch does.
      const branch = readBody(type !== "select", true);
      i += 1; // }
      out += `{${branch}}`;
    }

    return out;
  }

  return readBody(false, false);
}

/**
 * One message, pseudo-localised: `"Save"` becomes `"[⟦Šáṽé ~~⟧]"`.
 *
 * The padding comes in word-sized runs, not one long tail: forty unbroken
 * tildes can never wrap, and would report a long sentence as overflowing
 * where a real translation, which wraps between words, fits.
 */
export function pseudoize(message: string): string {
  let letters = 0;
  const body = mapLiterals(message, (text) =>
    text.replace(/[A-Za-z]/g, (ch) => {
      letters += 1;
      return ACCENTS[ch] ?? ch;
    }),
  );
  // A message that is only a placeholder has nothing to lengthen, and
  // bracketing it would only make the layout lie.
  if (letters === 0) return message;

  const padLength = Math.max(1, Math.ceil(letters * EXPANSION) - letters);
  const pad = Array.from({ length: Math.ceil(padLength / PSEUDO_WORD) }, (_, index) =>
    "~".repeat(Math.min(PSEUDO_WORD, padLength - index * PSEUDO_WORD)),
  ).join(" ");

  return `[⟦${body} ${pad}⟧]`;
}

/** Register {@link pseudoize} with the store. Idempotent. */
export function enablePseudoLocale(): void {
  if (!isPseudoAvailable()) return;
  setMessageTransform(pseudoize);
}

// Self-registering, so the single `import "@/i18n/pseudo";` that pulls this
// module in is also the whole wiring. Guarded, so that an import left in by
// accident cannot ship the pseudo-locale.
enablePseudoLocale();
