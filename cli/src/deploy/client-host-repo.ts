/*
 * Repo side of moving a fullstack project's client onto Cloudflare
 * Workers static assets: what in the client cannot be a static export
 * (each finding names its file), and the files the move writes.
 *
 * Nothing here touches the network or a provider. `hatchkit
 * migrate-client --dry-run` prints the scan; `--repo-only` writes the
 * files and stops.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CLOUDFLARE_WRANGLER_REL_PATH } from "../scaffold/cloudflare-mode.js";
import { RECORD_SHIP_ACTION_REL_PATH, writeRecordShipAction } from "../scaffold/record-ship.js";
import {
  defaultCompatibilityDate,
  findImmutable404Rules,
  findWranglerBillingKeys,
  migrateHeaders,
  renderWorkerHeaders,
  writeCarryScript,
} from "../scaffold/worker-assets.js";
import {
  type ClientWorkflowInput,
  rewriteWorkflowForWorkerClient,
} from "./client-host-workflow.js";

export const CLIENT_DIR = "packages/client";
export const CLIENT_EXPORT_DIR = `${CLIENT_DIR}/out`;
export const WORKFLOW_REL_PATH = ".github/workflows/build-and-deploy.yml";

/** Workers Free limits per version. */
export const MAX_FILES = 20_000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface ClientScan {
  /** Things the static export cannot do; each blocks the move. */
  blocking: string[];
  /** Things to look at; none blocks. */
  warnings: string[];
  /** `_redirects` lines converted from next.config `redirects()`. */
  redirects: string[];
  /** Client export build steps, from the client Dockerfile. */
  buildCommands: string[];
  /** `.nvmrc` or `.node-version`. */
  nodeVersionFile: string;
  /** next.config file, repo-relative. */
  nextConfig?: string;
}

const NEXT_CONFIGS = ["next.config.ts", "next.config.mjs", "next.config.js"];

/** Read-only scan of a project's client for the static-export move. */
export function scanClientProject(projectDir: string): ClientScan {
  const scan: ClientScan = {
    blocking: [],
    warnings: [],
    redirects: [],
    buildCommands: [],
    nodeVersionFile: existsSync(join(projectDir, ".nvmrc")) ? ".nvmrc" : ".node-version",
  };
  const clientDir = join(projectDir, CLIENT_DIR);
  if (!existsSync(clientDir)) {
    scan.blocking.push(`${CLIENT_DIR}/ does not exist; migrate-client expects the starter layout.`);
    return scan;
  }
  if (!existsSync(join(projectDir, scan.nodeVersionFile))) {
    scan.warnings.push("No .nvmrc or .node-version; the workflow's setup-node step needs one.");
  }

  // ── next.config ──────────────────────────────────────────────────────
  const configName = NEXT_CONFIGS.find((n) => existsSync(join(clientDir, n)));
  if (!configName) scan.blocking.push(`${CLIENT_DIR} has no next.config.{ts,mjs,js}.`);
  else {
    scan.nextConfig = `${CLIENT_DIR}/${configName}`;
    const text = readFileSync(join(clientDir, configName), "utf-8");
    scanNextConfig(text, scan.nextConfig, scan);
  }

  // ── code a static export cannot serve ────────────────────────────────
  for (const rel of [
    "middleware.ts",
    "middleware.js",
    "src/middleware.ts",
    "src/middleware.js",
    "proxy.ts",
    "src/proxy.ts",
  ]) {
    if (existsSync(join(clientDir, rel))) {
      scan.blocking.push(
        `${CLIENT_DIR}/${rel}: middleware runs per request; a static export has none.`,
      );
    }
  }
  const appDir = ["src/app", "app"].map((d) => join(clientDir, d)).find((d) => existsSync(d));
  if (appDir) {
    for (const file of walk(appDir)) {
      const rel = relative(projectDir, file);
      const base = file.split("/").pop() ?? "";
      if (/^route\.(t|j)sx?$/.test(base)) {
        const src = readFileSync(file, "utf-8");
        if (/export\s+const\s+dynamic\s*=\s*["']force-static["']/.test(src)) continue;
        scan.blocking.push(`${rel}: a route handler runs per request; move it to the server.`);
      }
      if (
        /\/\[[^\]/]+\](\/|$)/.test(relative(appDir, dirname(file)) + "/") &&
        /^page\.(t|j)sx?$/.test(base)
      ) {
        const src = readFileSync(file, "utf-8");
        if (!/generateStaticParams/.test(src)) {
          scan.blocking.push(
            `${rel}: a dynamic segment without generateStaticParams cannot be exported.`,
          );
        }
      }
    }
  }

  // ── build steps, from the client Dockerfile ──────────────────────────
  const dockerfile = join(clientDir, "Dockerfile");
  if (existsSync(dockerfile)) {
    for (const line of readFileSync(dockerfile, "utf-8").split("\n")) {
      const m = line.match(/^RUN\s+(pnpm\s+--filter\s+\S+\s+run\s+build)\s*$/);
      if (m) scan.buildCommands.push(m[1]);
    }
  }
  if (scan.buildCommands.length === 0) {
    scan.buildCommands.push("pnpm run build:client");
    scan.warnings.push(
      `No \`RUN pnpm --filter … run build\` lines in ${CLIENT_DIR}/Dockerfile; the workflow uses \`pnpm run build:client\`.`,
    );
  }

  // ── an existing export, if one is on disk ────────────────────────────
  const out = join(projectDir, CLIENT_EXPORT_DIR);
  if (existsSync(out)) scan.warnings.push(...checkExportDir(out, CLIENT_EXPORT_DIR));
  return scan;
}

/** next.config checks: an export branch with no relative assetPrefix,
 *  `redirects()` converted to `_redirects`, `headers()` and production
 *  `rewrites()` reported. */
export function scanNextConfig(text: string, file: string, scan: ClientScan): void {
  if (!/output:\s*["']export["']/.test(text)) {
    scan.blocking.push(
      `${file}: no \`output: "export"\` branch. Add one behind NEXT_FILE_EXPORT=1 (see the starter's next.config.ts).`,
    );
  }
  // A relative prefix gated on a native-build flag (Electron/Capacitor
  // shells load from file://) never reaches the web export, so it only
  // warns. The text cannot prove the gate holds; checkExportDir can, and
  // the upload and the CI workflow both refuse HTML that has "./_next.
  for (const m of text.matchAll(/assetPrefix\s*:\s*["']\.\/?["']/g)) {
    if (NATIVE_FLAG.test(assetPrefixContext(text, m.index))) {
      scan.warnings.push(
        `${file}: a relative assetPrefix ("./") behind a native-build flag; the web export must not set it (the upload checks the exported HTML).`,
      );
    } else {
      scan.blocking.push(
        `${file}: a relative assetPrefix ("./") makes every nested route 404 its chunks on a real origin. Drop it for the web export.`,
      );
    }
  }
  const trailingSlash = /trailingSlash:\s*true/.test(text);
  if (!trailingSlash) {
    scan.warnings.push(
      `${file}: trailingSlash is not true; the export then writes /x.html and Workers serves it at /x.`,
    );
  }
  const redirectsBody = functionBody(text, "redirects");
  if (redirectsBody !== null) {
    const converted = convertNextRedirects(redirectsBody, trailingSlash);
    if (converted === null) {
      scan.blocking.push(
        `${file}: redirects() uses more than source/destination/permanent; write public/_redirects by hand.`,
      );
    } else scan.redirects.push(...converted);
  }
  const headersBody = functionBody(text, "headers");
  if (headersBody !== null) {
    scan.warnings.push(
      `${file}: headers() is ignored by a static export; move its rules to public/_headers.`,
    );
  }
  const rewritesBody = functionBody(text, "rewrites");
  if (rewritesBody !== null) {
    const sources = [...rewritesBody.matchAll(/source:\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const devProxyOnly = sources.length > 0 && sources.every((s) => s === "/api/:path*");
    if (!devProxyOnly) {
      scan.blocking.push(
        `${file}: rewrites() (${sources.join(", ") || "unparsed"}) is ignored by a static export; those paths need a no-Worker route (originPaths) or a server route.`,
      );
    }
  }
}

const NATIVE_FLAG = /native|capacitor|electron/i;

/** The line holding an assetPrefix match, from the `...(` of a
 *  conditional spread that is still open there (it may start on an
 *  earlier line), with `//` comments dropped. */
function assetPrefixContext(text: string, index: number): string {
  let start = text.lastIndexOf("\n", index) + 1;
  const spread = text.lastIndexOf("...(", index);
  if (spread !== -1) {
    let depth = 0;
    for (let i = spread + 3; i < index; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    if (depth > 0) start = Math.min(start, spread);
  }
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end).replace(/\/\/.*$/gm, "");
}

/** The text between the braces of `async <name>() { … }` (or
 *  `<name>: async () => …`), or null when absent. Brace-counted. */
export function functionBody(text: string, name: string): string | null {
  const m = new RegExp(
    `(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{|${name}\\s*:\\s*async\\s*\\(\\)\\s*=>\\s*\\{`,
  ).exec(text);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(m.index + m[0].length, i);
    }
  }
  return null;
}

/**
 * Next `redirects()` entries → `_redirects` lines. Returns null when an
 * entry uses anything beyond `source`, `destination` and `permanent`
 * (`has`, `missing`, `basePath`, `locale`, regex params).
 *
 *   · `permanent: true` → 308, false → 307 (Next's own codes).
 *   · `:param` passes through; `:path*` becomes a splat.
 *   · With trailingSlash the export serves `/x/`, so the destination path
 *     gets its slash (no extra hop through Workers' slash redirect), and
 *     the source is listed with and without one.
 */
export function convertNextRedirects(body: string, trailingSlash: boolean): string[] | null {
  const entries = [...body.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  const lines: string[] = [];
  for (const entry of entries) {
    const keys = [...entry.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
    if (keys.some((k) => !["source", "destination", "permanent", "statusCode"].includes(k)))
      return null;
    const source = entry.match(/source:\s*["']([^"']+)["']/)?.[1];
    const destination = entry.match(/destination:\s*["']([^"']+)["']/)?.[1];
    const permanent = entry.match(/permanent:\s*(true|false)/)?.[1];
    const statusCode = entry.match(/statusCode:\s*(\d{3})/)?.[1];
    if (!source || !destination || (!permanent && !statusCode)) return null;
    if (/[()]|:[A-Za-z_]\w*[+?]/.test(source)) return null;
    const code = statusCode ?? (permanent === "true" ? "308" : "307");
    const splat = source.match(/:([A-Za-z_]\w*)\*$/);
    let from = source;
    let to = destination;
    if (splat) {
      from = source.replace(/:[A-Za-z_]\w*\*$/, "*");
      to = destination.replace(new RegExp(`:${splat[1]}\\*?`, "g"), ":splat");
    }
    if (trailingSlash && !/^https?:/.test(to)) {
      const [path, query] = to.split("?");
      const last = path.split("/").pop() ?? "";
      if (!path.endsWith("/") && !last.includes(".") && !path.endsWith(":splat")) {
        to = `${path}/${query !== undefined ? `?${query}` : ""}`;
      }
    }
    if (trailingSlash && !from.endsWith("/") && !from.endsWith("*"))
      lines.push(`${from}/ ${to} ${code}`);
    lines.push(`${from} ${to} ${code}`);
  }
  return lines;
}

/** Export checks against the Workers Free limits. */
export function checkExportDir(outDir: string, label: string): string[] {
  const problems: string[] = [];
  const files = walk(outDir);
  if (files.length > MAX_FILES)
    problems.push(`${label}: ${files.length} files (Workers Free limit ${MAX_FILES}).`);
  for (const file of files) {
    const size = statSync(file).size;
    if (size > MAX_FILE_BYTES)
      problems.push(`${relative(outDir, file)}: ${size} bytes (limit ${MAX_FILE_BYTES}).`);
    if (file.endsWith(".html") && readFileSync(file, "utf-8").includes('"./_next')) {
      problems.push(`${relative(outDir, file)}: references "./_next (relative assetPrefix).`);
      break;
    }
  }
  return problems;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface ClientRepoInput {
  worker: string;
  siteUrl: string;
  apiUrl: string;
  compatibilityDate?: string;
  /** Extra `_headers` text the old container sent (security headers). */
  extraHeaders?: string;
}

/** `wrangler.jsonc` for an assets-only client Worker on a route.
 *
 *  No `main`, `routes`, `run_worker_first` or `cache`: each one makes
 *  asset requests billable or takes the routes away from hatchkit, and
 *  doctor flags all of them. `workers_dev: false` keeps a second public
 *  copy of the site off `*.workers.dev`. */
export function renderClientWranglerConfig(worker: string, compatibilityDate: string): string {
  return `{
  // Client of a hatchkit project, served by Cloudflare Workers static
  // assets on the route <domain>/* (hatchkit clientHost "cloudflare").
  // Routes are made by \`hatchkit migrate-client\`, never here: with no
  // "routes" key wrangler leaves them alone.
  //
  // Do not add "main", "run_worker_first" or "cache": each one turns free
  // asset requests into counted Worker requests (Workers Free: 100,000 a
  // day per account; over the cap run_worker_first paths answer 429).
  "name": "${worker}",
  "compatibility_date": "${compatibilityDate}",
  "assets": {
    "directory": "./${CLIENT_EXPORT_DIR}",
    // The export's 404.html for unknown paths, never an SPA fallback.
    "not_found_handling": "404-page"
  },
  "workers_dev": false
}
`;
}

/**
 * Write the repo files of the move. Idempotent; returns one line per
 * file changed. Throws (writing nothing further) when the workflow is
 * not in a shape hatchkit can rewrite.
 */
export function writeClientRepoFiles(
  projectDir: string,
  input: ClientRepoInput,
  scan: ClientScan,
): string[] {
  const changes: string[] = [];
  const write = (rel: string, body: string, label: string): void => {
    const path = join(projectDir, rel);
    if (existsSync(path) && readFileSync(path, "utf-8") === body) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf-8");
    changes.push(`${label}: ${rel}`);
  };

  // Workflow first: it is the one that can refuse.
  const workflowPath = join(projectDir, WORKFLOW_REL_PATH);
  if (!existsSync(workflowPath)) throw new Error(`${WORKFLOW_REL_PATH} not found.`);
  const workflowInput: ClientWorkflowInput = {
    worker: input.worker,
    siteUrl: input.siteUrl,
    apiUrl: input.apiUrl,
    buildCommands: scan.buildCommands,
    exportDir: CLIENT_EXPORT_DIR,
    nodeVersionFile: scan.nodeVersionFile,
  };
  const rewritten = rewriteWorkflowForWorkerClient(
    readFileSync(workflowPath, "utf-8"),
    workflowInput,
  );

  const wranglerPath = join(projectDir, CLOUDFLARE_WRANGLER_REL_PATH);
  if (!existsSync(wranglerPath)) {
    write(
      CLOUDFLARE_WRANGLER_REL_PATH,
      renderClientWranglerConfig(
        input.worker,
        input.compatibilityDate ?? defaultCompatibilityDate(),
      ),
      "wrote",
    );
  }

  const headersRel = `${CLIENT_DIR}/public/_headers`;
  const headersPath = join(projectDir, headersRel);
  if (existsSync(headersPath)) {
    const migrated = migrateHeaders(readFileSync(headersPath, "utf-8"));
    if (migrated !== null) write(headersRel, migrated, "updated");
  } else write(headersRel, renderWorkerHeaders(input.extraHeaders), "wrote");

  if (scan.redirects.length) {
    const redirectsRel = `${CLIENT_DIR}/public/_redirects`;
    const header =
      "# Converted from next.config redirects() by hatchkit migrate-client: a\n" +
      "# static export ignores redirects(), Workers static assets reads this file.\n";
    const existing = existsSync(join(projectDir, redirectsRel))
      ? readFileSync(join(projectDir, redirectsRel), "utf-8")
      : header;
    const missing = scan.redirects.filter((line) => !existing.split("\n").includes(line));
    if (missing.length)
      write(redirectsRel, `${existing.replace(/\n*$/, "\n")}${missing.join("\n")}\n`, "updated");
  }

  const carry: string[] = [];
  writeCarryScript(projectDir, carry);
  if (carry.length) changes.push("wrote: scripts/carry-static.mjs");

  // deploy-client records the web deploy through this local action.
  if (writeRecordShipAction(projectDir)) changes.push(`wrote: ${RECORD_SHIP_ACTION_REL_PATH}`);

  if (rewritten.text !== readFileSync(workflowPath, "utf-8")) {
    writeFileSync(workflowPath, rewritten.text, "utf-8");
    changes.push(`rewrote: ${WORKFLOW_REL_PATH} (${rewritten.notes.join("; ")})`);
  }
  return changes;
}

/** Problems in an existing wrangler config or `_headers` that make a
 *  Workers client cost money or cache 404s. Used by doctor and preflight. */
export function workerConfigFindings(
  projectDir: string,
  opts: { routesOwnedByHatchkit?: boolean } = { routesOwnedByHatchkit: true },
): string[] {
  const findings: string[] = [];
  const wrangler = join(projectDir, CLOUDFLARE_WRANGLER_REL_PATH);
  if (existsSync(wrangler)) {
    for (const key of findWranglerBillingKeys(readFileSync(wrangler, "utf-8"))) {
      if ((key === "routes" || key === "route") && !opts.routesOwnedByHatchkit) continue;
      findings.push(
        key === "routes" || key === "route"
          ? `wrangler.jsonc has "${key}": wrangler then owns the routes hatchkit made; remove it.`
          : `wrangler.jsonc has "${key}": asset requests become counted Worker requests; remove it.`,
      );
    }
  }
  const headers = join(projectDir, CLIENT_DIR, "public", "_headers");
  if (existsSync(headers)) {
    for (const f of findImmutable404Rules(readFileSync(headers, "utf-8"))) {
      findings.push(
        `${CLIENT_DIR}/public/_headers:${f.line} caches ${f.pattern} for a day or more; Cloudflare applies it to 404s too.`,
      );
    }
  }
  return findings;
}
