/*
 * cli/src/features/site-basics/layout.ts — wiring the site defaults into
 * the project's root layout, which is the project's own file.
 *
 * Three edits, each guarded by its own result so the transform is a fixed
 * point (`wire(wire(x)) === wire(x)`):
 *
 *   1. `export const metadata = { … }` becomes
 *      `export const metadata = withSiteMetadata({ … })`. The object is kept
 *      as it is — every field the layout sets still wins — except for the
 *      starter's two placeholders, which are not anybody's choice: the
 *      "My App" title (always) and the "A full-stack web application"
 *      description (when the manifest has a real one). Both were found in
 *      production on deployed starter apps. A layout with no metadata export
 *      gets one; a `generateMetadata` is left alone with a note, because what
 *      it returns is computed.
 *   2. `<SiteJsonLd />` directly inside `<body>`.
 *   3. `<PlausibleScript />` inside `<head>` (or `<body>` without one), only
 *      when the layout does not already read NEXT_PUBLIC_PLAUSIBLE_DOMAIN —
 *      the starter renders the tracker inline, and two trackers would count
 *      every visit twice.
 *
 * Positions are found on the source with its comments blanked out, the way
 * deploy-recovery's mount does it: the starter's own layout says `<body>` in
 * prose, and a match there would splice an element into a comment.
 */

/** Root layout candidates, relative to the client source root. */
export const LAYOUT_CANDIDATES = ["app/layout.tsx", "app/layout.jsx", "app/layout.js"] as const;

/** The starter's placeholder title block, exactly as it ships. */
const PLACEHOLDER_TITLE =
  /\n[ \t]*title:\s*\{\s*default:\s*"My App",\s*template:\s*"%s \| My App",?\s*\},?[ \t]*(?=\n)/;
/** The starter's placeholder description, exactly as it ships. */
const PLACEHOLDER_DESCRIPTION =
  /\n[ \t]*description:\s*"A full-stack web application",?[ \t]*(?=\n)/;

export interface LayoutWiringOptions {
  /** Module specifier of the generated `lib/site` folder, as the layout
   *  should import it: `@/lib/site` or a relative path. */
  importBase: string;
  /** Remove the starter's placeholder description. Only when the manifest
   *  has a description to put in its place. */
  replaceDescription: boolean;
}

export interface LayoutWiring {
  content: string;
  changed: boolean;
  /** One line per edit that could not be made, and why. */
  blocked: string[];
}

/** The source with block comments, line comments and JSX comments blanked
 *  to spaces, newlines kept, so offsets match the original. Strings are
 *  skipped over so a "//" inside a URL is not taken for a comment. */
export function blankComments(source: string): string {
  const out = source.split("");
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Index just past the string literal that opens at `start`. */
function skipString(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && ch === "$" && source[i + 1] === "{") {
      i = matchBrace(source, i + 1) + 1;
      continue;
    }
    if (ch === quote) return i + 1;
    // A newline ends an unterminated ' or " string (JSX text with an
    // apostrophe, say) rather than swallowing the rest of the file.
    if (ch === "\n" && quote !== "`") return i;
    i++;
  }
  return i;
}

/** Index of the `}` that closes the `{` at `open`, skipping strings and
 *  comments. `-1` when it never closes. */
export function matchBrace(source: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function indentOfNextLine(content: string, offset: number): string {
  const m = content.slice(offset).match(/\r?\n([ \t]*)\S/);
  return m ? m[1] : "        ";
}

/** Insert `element` on its own line directly after the opening tag `tag`
 *  (`head` or `body`). Returns null when the tag is not there. */
function insertAfterOpenTag(content: string, tag: "head" | "body", element: string): string | null {
  const open = new RegExp(`<${tag}(?:\\s[^>]*?)?>`);
  const match = blankComments(content).match(open);
  if (match === null || match.index === undefined) return null;
  const at = match.index + match[0].length;
  const indent = indentOfNextLine(content, at);
  return `${content.slice(0, at)}\n${indent}${element}${content.slice(at)}`;
}

/** Add `import { name } from "specifier";` after the last import, unless
 *  the name is imported already. */
function ensureImport(content: string, name: string, specifier: string): string {
  if (new RegExp(`import\\s*(?:type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(content)) {
    return content;
  }
  const statement = `import { ${name} } from "${specifier}";\n`;
  let lastEnd = -1;
  const blanked = blankComments(content);
  // `[^;]` keeps one match inside one statement: a lazy `[\s\S]` would run
  // from a side-effect import to the `from` of a later line.
  const importStatement =
    /^import\s*["'][^"']+["'];?[ \t]*\r?\n|^import\b[^;]*?\bfrom\s*["'][^"']+["'];?[ \t]*\r?\n/gm;
  for (const m of blanked.matchAll(importStatement)) {
    if (m.index === undefined) continue;
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd === -1) return statement + content;
  return content.slice(0, lastEnd) + statement + content.slice(lastEnd);
}

const METADATA_DECL = /export\s+const\s+metadata\s*(?::\s*Metadata\s*)?=\s*/;
const GENERATE_METADATA =
  /export\s+(?:async\s+)?function\s+generateMetadata\b|export\s+const\s+generateMetadata\b/;

function wireMetadata(
  content: string,
  options: LayoutWiringOptions,
  blocked: string[],
): { content: string; used: boolean } {
  const blanked = blankComments(content);
  if (/\bwithSiteMetadata\s*\(/.test(blanked)) return { content, used: true };

  const decl = blanked.match(METADATA_DECL);
  if (decl && decl.index !== undefined) {
    const open = decl.index + decl[0].length;
    if (content[open] !== "{") {
      blocked.push(
        "its `metadata` export is not an object literal — wrap the value in withSiteMetadata()",
      );
      return { content, used: false };
    }
    const close = matchBrace(content, open);
    if (close === -1) {
      blocked.push("its `metadata` object could not be read to the end");
      return { content, used: false };
    }
    let body = content.slice(open + 1, close);
    body = body.replace(PLACEHOLDER_TITLE, "");
    if (options.replaceDescription) body = body.replace(PLACEHOLDER_DESCRIPTION, "");
    const call = body.trim() === "" ? "withSiteMetadata()" : `withSiteMetadata({${body}})`;
    return { content: content.slice(0, open) + call + content.slice(close + 1), used: true };
  }

  if (GENERATE_METADATA.test(blanked)) {
    blocked.push(
      "it exports generateMetadata — return withSiteMetadata({ … }) from it to get the site defaults",
    );
    return { content, used: false };
  }

  // No metadata at all: add one, above the default export. No annotation,
  // so no type import is needed — withSiteMetadata returns Metadata.
  const defaultExport = blanked.match(/^export\s+default\b/m);
  const statement = "export const metadata = withSiteMetadata();\n\n";
  if (defaultExport?.index === undefined) {
    return { content: `${content.replace(/\n*$/, "\n\n")}${statement.trimEnd()}\n`, used: true };
  }
  return {
    content: content.slice(0, defaultExport.index) + statement + content.slice(defaultExport.index),
    used: true,
  };
}

/** Wire the site defaults, structured data and analytics into a root
 *  layout. Idempotent; leaves what it cannot place alone and says why. */
export function wireSiteBasicsInLayout(
  content: string,
  options: LayoutWiringOptions,
): LayoutWiring {
  const blocked: string[] = [];
  let out = content;

  const metadata = wireMetadata(out, options, blocked);
  out = metadata.content;

  let jsonLd = /\bSiteJsonLd\b/.test(blankComments(out));
  if (!jsonLd) {
    const next = insertAfterOpenTag(out, "body", "<SiteJsonLd />");
    if (next === null) blocked.push("there is no <body> to mount <SiteJsonLd /> in");
    else {
      out = next;
      jsonLd = true;
    }
  }

  const blankedNow = blankComments(out);
  // A layout that mounts its own Plausible component (one that redacts
  // paths, say) already renders a tracker. A second <PlausibleScript />
  // would count every visit twice and send the unredacted URL.
  const ownTracker = /<[A-Z]\w*Plausible\w*[\s/>]/.test(blankedNow) && !/<PlausibleScript\b/.test(blankedNow);
  let plausible = false;
  if (
    !ownTracker &&
    !/NEXT_PUBLIC_PLAUSIBLE_DOMAIN/.test(out) &&
    !/\bPlausibleScript\b/.test(blankedNow)
  ) {
    const next =
      insertAfterOpenTag(out, "head", "<PlausibleScript />") ??
      insertAfterOpenTag(out, "body", "<PlausibleScript />");
    if (next === null) blocked.push("there is no <head> or <body> to mount <PlausibleScript /> in");
    else {
      out = next;
      plausible = true;
    }
  } else if (/\bPlausibleScript\b/.test(blankedNow)) {
    plausible = true;
  }

  if (metadata.used) out = ensureImport(out, "withSiteMetadata", `${options.importBase}/metadata`);
  if (jsonLd) out = ensureImport(out, "SiteJsonLd", `${options.importBase}/json-ld`);
  if (plausible) out = ensureImport(out, "PlausibleScript", `${options.importBase}/plausible`);

  return { content: out, changed: out !== content, blocked };
}

/** How the layout should import `lib/site`: through the `@/` alias when the
 *  layout already uses it, else relative to the layout (`app/` → `../lib`).
 *  Guessing an alias a project does not have would not compile. */
export function siteImportBase(layoutContent: string): string {
  return /\bfrom\s+["']@\//.test(layoutContent) ? "@/lib/site" : "../lib/site";
}
