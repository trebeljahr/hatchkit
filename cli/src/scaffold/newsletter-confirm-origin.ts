/*
 * Newsletter confirm link origin — retrofitted onto the newsletter routes
 * of a project scaffolded before 2026-09-29.
 *
 * Why this exists: the starter's
 * `packages/server/src/services/newsletter/routes.ts` built the emailed
 * confirm link as `${siteUrl()}/api/newsletter/confirm?token=…`, where
 * `siteUrl()` is NEWSLETTER_SITE_URL ?? FRONTEND_URL — the client's host.
 * Under the `split` topology the client (`<domain>`) serves no `/api`
 * routes; the API answers on `api.<domain>`. The link answers with a
 * trailing-slash 308 and then a 404, so nobody can confirm. Subscribing
 * still succeeds and the email still arrives, so nothing flags it.
 *
 * The fix builds the link on BETTER_AUTH_URL, the API's own public origin.
 * The server requires that variable at boot (`config/env.ts`), and under
 * `single-origin` it names the same host as FRONTEND_URL, so the link does
 * not move there. The confirm route's `/sub/confirmed` and `/sub/error`
 * redirects stay on `siteUrl()`: those pages belong to the client.
 */

import type { FeatureLedger, FileAction } from "../features/contract.js";

export const NEWSLETTER_ROUTES_REL_PATH = "packages/server/src/services/newsletter/routes.ts";

export type ConfirmOriginOutcome =
  /** The confirm link now uses `apiUrl()`. */
  | "patched"
  /** The link's origin is not `siteUrl()` — the starter's `apiUrl()`, or
   *  something the project chose. Left alone either way. */
  | "already"
  /** The file builds no confirm link, so there is nothing to move. */
  | "no-link"
  /** The link is built on `siteUrl()`, but not in the shape the starter
   *  shipped. Reported as a manual step, never forced. */
  | "no-anchor";

export interface ConfirmOriginRewrite {
  source: string;
  outcome: ConfirmOriginOutcome;
}

/** The emailed link: a template literal whose origin is one `${…}`
 *  expression, followed by the confirm route's path. */
const CONFIRM_LINK = /`\$\{([^}]+)\}\/api\/newsletter\/confirm\?/;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** The next route registration after the subscribe handler, which bounds
 *  the handler for the identifier checks below. */
const NEXT_ROUTE = /\bapp\.(?:get|post|put|patch|delete|use|all)\(/g;

const SITE_URL_DOC = [
  "/** Origin of the client app. The `/sub/confirmed` and `/sub/error`",
  " *  pages live here, so the confirm route redirects to it. */",
].join("\n");

/** The helper the starter ships next to `siteUrl()`. */
export const API_URL_FUNCTION = [
  "/** Public origin of this API server. The confirm link in the email must",
  " *  land here: the client host has no route to `/api/newsletter/confirm`",
  " *  when client and API are served from different hosts. */",
  "function apiUrl(): string {",
  '  return (process.env.BETTER_AUTH_URL ?? "").replace(/\\/$/, "");',
  "}",
].join("\n");

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Offset just past the `}` that closes the body of `function siteUrl`,
 *  or -1. Braces are counted, not parsed; the body is one return line. */
function siteUrlFunctionEnd(source: string, start: number): number {
  const open = source.indexOf("{", start);
  if (open === -1) return -1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Move the emailed confirm link from the site origin to the API origin.
 *
 * On the starter's pre-fix shape this reproduces today's starter file:
 * the subscribe handler's `const base = siteUrl();` guard becomes
 * `const api = apiUrl();` (log event and message included), and
 * `apiUrl()` is declared after `siteUrl()`. The confirm handler keeps
 * `siteUrl()`, because its redirects go to client pages.
 *
 * A pure fixed point: once the link's origin is `apiUrl()` the source comes
 * back unchanged.
 */
export function upgradeNewsletterConfirmOrigin(source: string): ConfirmOriginRewrite {
  const link = CONFIRM_LINK.exec(source);
  if (!link) return { source, outcome: "no-link" };
  const origin = (link[1] ?? "").trim();
  const noAnchor: ConfirmOriginRewrite = { source, outcome: "no-anchor" };

  if (!IDENTIFIER.test(origin)) {
    return /^siteUrl\(\s*\)$/.test(origin) ? noAnchor : { source, outcome: "already" };
  }

  // The last declaration of the origin variable before the link.
  const declarations = [
    ...source
      .slice(0, link.index)
      .matchAll(new RegExp(`^[ \\t]*const ${escapeRegExp(origin)} = ([^;\\n]+);`, "gm")),
  ];
  const declaration = declarations.at(-1);
  if (!declaration) return noAnchor;
  if (!/^siteUrl\(\s*\)$/.test((declaration[1] ?? "").trim()))
    return { source, outcome: "already" };

  // The subscribe handler, from the origin's declaration to the next route.
  const regionStart = declaration.index;
  const linkEnd = link.index + link[0].length;
  NEXT_ROUTE.lastIndex = linkEnd;
  const handlerEnd = NEXT_ROUTE.exec(source)?.index ?? source.length;
  const originName = new RegExp(`\\b${escapeRegExp(origin)}\\b`, "g");
  if (origin !== "api") {
    // Renaming the variable only up to the link must not strand a later use.
    if (new RegExp(originName.source).test(source.slice(linkEnd, handlerEnd))) return noAnchor;
    // Nor may the new name collide with an `api` the file already declares.
    if (/\b(?:const|let|var)\s+api\b/.test(source)) return noAnchor;
  }

  const siteUrlStart = source.search(/^function siteUrl\(/m);
  if (siteUrlStart === -1 || siteUrlStart > regionStart) return noAnchor;
  const siteUrlEnd = siteUrlFunctionEnd(source, siteUrlStart);
  if (siteUrlEnd === -1 || siteUrlEnd > regionStart) return noAnchor;

  const region = source
    .slice(regionStart, linkEnd)
    .replace(originName, "api")
    .replace(/\bsiteUrl\(\s*\)/, "apiUrl()")
    .replace(/(["'])no_site_url\1/, "$1no_api_url$1")
    .replace("Newsletter site URL is not configured.", "Newsletter API URL is not configured.");

  const hasApiUrl = /^function apiUrl\(/m.test(source);
  const hasSiteUrlDoc = source.slice(0, siteUrlStart).trimEnd().endsWith("*/");

  return {
    source:
      source.slice(0, siteUrlStart) +
      (hasSiteUrlDoc ? "" : `${SITE_URL_DOC}\n`) +
      source.slice(siteUrlStart, siteUrlEnd) +
      (hasApiUrl ? "" : `\n\n${API_URL_FUNCTION}`) +
      source.slice(siteUrlEnd, regionStart) +
      region +
      source.slice(linkEnd),
    outcome: "patched",
  };
}

export interface ConfirmOriginRetrofit {
  outcome: ConfirmOriginOutcome | "absent";
  /** What the ledger did with the file; `would-write` in a dry run. */
  action: FileAction;
}

/**
 * Apply {@link upgradeNewsletterConfirmOrigin} to the project's newsletter
 * routes, if it has them. A project without the newsletter is `absent`,
 * not an error. A file the transform cannot anchor in is recorded as a
 * ledger conflict carrying the manual fix.
 */
export function retrofitNewsletterConfirmOrigin(ledger: FeatureLedger): ConfirmOriginRetrofit {
  const source = ledger.read(NEWSLETTER_ROUTES_REL_PATH);
  if (source === undefined) return { outcome: "absent", action: "absent" };
  const { outcome, source: next } = upgradeNewsletterConfirmOrigin(source);
  if (outcome === "no-anchor") {
    return {
      outcome,
      action: ledger.conflict(
        NEWSLETTER_ROUTES_REL_PATH,
        "build the emailed /api/newsletter/confirm link on process.env.BETTER_AUTH_URL by hand; " +
          "keep the /sub/* redirects on the site URL",
      ),
    };
  }
  return { outcome, action: ledger.edit(NEWSLETTER_ROUTES_REL_PATH, () => next) };
}
