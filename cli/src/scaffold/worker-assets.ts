// Files every Cloudflare Workers Static Assets deploy needs, shared by the
// static-site mode (cloudflare-mode.ts) and a fullstack client served from
// Workers (deploy/client-host.ts).
//
// Two findings from the 2026-10-12 live test shape this module:
//
//   · `_headers` rules also apply to 404 responses, and the edge caches
//     them. A `/_next/static/*` rule with `max-age=31536000, immutable`
//     therefore stores a missing chunk's 404 for a year — in the browser
//     that asked in the seconds after a deploy, or for an old chunk.
//     Hashed output gets no rule at all: Cloudflare's default
//     (`max-age=0, must-revalidate` + ETag) costs only free revalidations.
//   · A Worker version serves only the assets it was uploaded with, so each
//     upload carries the hashed files of the releases before it
//     (templates/client-host/scripts/carry-static.mjs).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the carry script lands in a project. */
export const CARRY_SCRIPT_REL_PATH = "scripts/carry-static.mjs";

/** The manifest carry-static.mjs publishes next to the site. */
export const RELEASE_ASSETS_PATH = "/release-assets.json";

/** wrangler major the workflows run. Upload-then-activate needs
 *  `versions upload` / `versions deploy`, both stable across 4.x. */
export const WRANGLER_PACKAGE = "wrangler@4";

const TEMPLATE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
  "client-host",
  "scripts",
  "carry-static.mjs",
);

/** The carry script's source, as shipped in hatchkit's templates. */
export function carryScriptSource(): string {
  return readFileSync(TEMPLATE, "utf-8");
}

/** Write (or refresh) `scripts/carry-static.mjs`. Overwrites a copy that
 *  differs: the script is hatchkit's, like the workflow that runs it. */
export function writeCarryScript(projectDir: string, modifications: string[]): void {
  const path = join(projectDir, CARRY_SCRIPT_REL_PATH);
  const source = carryScriptSource();
  if (existsSync(path) && readFileSync(path, "utf-8") === source) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf-8");
  modifications.push(`cloudflare: wrote ${CARRY_SCRIPT_REL_PATH} (carries old hashed chunks)`);
}

/** No-cache rules every Workers-served client needs. `extra` is appended
 *  verbatim (security headers, a service worker rule). */
export function renderWorkerHeaders(extra = ""): string {
  const tail = extra.trim() ? `\n${extra.trim()}\n` : "";
  return `# No rule for /_next/static/*: Cloudflare applies _headers to 404s too, and
# an immutable rule would let a browser keep a missing chunk's 404 for a
# year. The default (max-age=0, must-revalidate + ETag) costs only free
# revalidation requests.

# /version.json must never be cached: a tab that outlived a deploy fetches it
# to find out, and a cached copy answers with the commit that tab already has.
# The rule belongs here rather than in next.config's headers() — a static
# export serves files directly and ignores that block entirely.
/version.json
  Cache-Control: no-store, must-revalidate

# Read by the next deploy's carry step (scripts/carry-static.mjs).
${RELEASE_ASSETS_PATH}
  Cache-Control: no-store, must-revalidate
${tail}`;
}

/** The block hatchkit's cloudflare mode wrote before 2026-10-15. */
const LEGACY_IMMUTABLE_BLOCK =
  /# Content-hashed build output never changes under the same URL\.\n\/_next\/static\/\*\n {2}Cache-Control: public, max-age=31536000, immutable\n\n?/;

/**
 * Remove hatchkit's old immutable `/_next/static/*` block and add the
 * `/release-assets.json` rule. Returns null when the file needs no change.
 * Leaves any other immutable rule alone — doctor reports those, since a
 * hand-written rule may cover something else on purpose.
 */
export function migrateHeaders(text: string): string | null {
  let next = text.replace(LEGACY_IMMUTABLE_BLOCK, "");
  if (!next.includes(RELEASE_ASSETS_PATH)) {
    next = `${next.replace(/\n*$/, "\n")}
# Read by the next deploy's carry step (scripts/carry-static.mjs).
${RELEASE_ASSETS_PATH}
  Cache-Control: no-store, must-revalidate
`;
  }
  return next === text ? null : next;
}

export interface HeadersFinding {
  /** The `_headers` path pattern carrying the rule. */
  pattern: string;
  line: number;
}

/**
 * Rules that cache a hashed-asset path for a long time. Cloudflare applies
 * `_headers` to 404s as well, so these turn a missing chunk into a year of
 * 404s. Flags any path rule whose block sets `immutable` or a max-age of a
 * day or more on a pattern under `/_next/` or `/assets/`.
 */
export function findImmutable404Rules(text: string): HeadersFinding[] {
  const findings: HeadersFinding[] = [];
  let pattern: string | null = null;
  let patternLine = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      pattern = line.trim();
      patternLine = i + 1;
      continue;
    }
    if (!pattern || !/^\/(_next|assets)\//.test(pattern)) continue;
    const m = line.match(/^\s+cache-control\s*:\s*(.+)$/i);
    if (!m) continue;
    const maxAge = Number(m[1].match(/max-age\s*=\s*(\d+)/i)?.[1] ?? 0);
    if (/immutable/i.test(m[1]) || maxAge >= 86_400) {
      findings.push({ pattern, line: patternLine });
    }
  }
  return findings;
}

/**
 * wrangler config keys that make asset requests billable or take routes
 * away from hatchkit. Each one is a finding for doctor:
 *
 *   main              a script runs on every request it is routed (counted)
 *   run_worker_first  sends asset paths through the script (counted; 429 over the cap)
 *   cache             Workers Cache bills every request, assets included
 *   routes / route    wrangler then owns routes; hatchkit makes them by API
 *
 * A comment-tolerant key scan, not a parser: enough to find top-level and
 * nested keys by name in JSONC.
 */
export function findWranglerBillingKeys(text: string): string[] {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"])\/\/.*$/, "$1"))
    .join("\n");
  const found: string[] = [];
  for (const key of ["main", "run_worker_first", "cache", "routes", "route"]) {
    if (new RegExp(`"${key}"\\s*:`).test(stripped)) found.push(key);
  }
  return found;
}
