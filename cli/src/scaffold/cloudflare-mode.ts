// Cloudflare-Workers-specific tweaks applied AFTER `pruneToClientOnly`.
//
// Sibling of pages-mode.ts. The client-only prune strips the server
// package but leaves the Next config configured for a standalone
// server + `/api/*` rewrites that assume a backend, and leaves the
// GHCR/Coolify image workflow in place. Workers Static Assets serves
// flat files; none of that wiring makes sense here.
//
// The file set mirrors the fractal.garden migration (28.09.2026),
// which is the reference implementation for this mode:
//
//   wrangler.jsonc                 — what to serve and how to 404
//   .node-version                  — pin the CI toolchain
//   packages/client/public/_headers — no-cache rules (see worker-assets.ts)
//   scripts/carry-static.mjs       — carries old hashed chunks into each upload
//   .github/workflows/deploy.yml   — build, carry, upload, then activate
//
// Everything here is idempotent: each step checks for the desired end
// state first, so re-running against an already-converted project is a
// no-op rather than a duplicate.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPackageName, readWorkspacePackageNames } from "./pkg-json.js";
import { removeIfExists } from "./starter-files.js";
import {
  CARRY_SCRIPT_REL_PATH,
  WRANGLER_PACKAGE,
  defaultCompatibilityDate,
  migrateHeaders,
  renderWorkerHeaders,
  writeCarryScript,
} from "./worker-assets.js";

/** Repo-relative directory `pnpm build` static-exports the client into.
 *  Kept as a named export because three other modules need to agree on
 *  it: the wrangler config, the deploy workflow, and the create flow's
 *  summary line. */
export const CLOUDFLARE_PUBLISH_DIR = "packages/client/out";

/** Repo-relative folder Next copies verbatim into the export. `_headers`
 *  has to land at the root of the *served* output, so it goes here. */
export const CLOUDFLARE_PUBLIC_DIR = "packages/client/public";

export const CLOUDFLARE_WRANGLER_REL_PATH = "wrangler.jsonc";
export const CLOUDFLARE_NODE_VERSION_REL_PATH = ".node-version";
export const CLOUDFLARE_HEADERS_REL_PATH = `${CLOUDFLARE_PUBLIC_DIR}/_headers`;
export const CLOUDFLARE_WORKFLOW_REL_PATH = ".github/workflows/deploy.yml";

/** The GHCR-image workflow the starter ships for the Coolify path. A
 *  Workers-hosted static site has no image to build and no Coolify to
 *  poke, so the workflow would fail on every push. */
const COOLIFY_WORKFLOW_REL_PATH = ".github/workflows/build-and-deploy.yml";

/** Node major pinned into `.node-version`. Matches the starter's
 *  `.nvmrc`; kept as its own constant because Cloudflare's build image
 *  reads `.node-version`, not `.nvmrc`, and the two are allowed to
 *  drift if a project ever needs them to. */
const DEFAULT_NODE_VERSION = "24";

export interface CloudflareModeInput {
  /** Worker name. Must be unique within the Cloudflare account and is
   *  what `<name>.<subdomain>.workers.dev` is built from. */
  workerName: string;
  /** `compatibility_date` for the Worker runtime. Defaults to two weeks back —
   *  injectable so tests get a stable fixture. */
  compatibilityDate?: string;
  /** Default branch the deploy workflow triggers on. */
  defaultBranch?: string;
  /** Node major written to `.node-version`. */
  nodeVersion?: string;
  /** Public URL the site is served at (`https://<domain>`). The deploy
   *  workflow's carry step reads the live release manifest from here.
   *  Absent (a site on *.workers.dev only) skips the carry. */
  siteUrl?: string;
}

/** Apply every cloudflare-specific change to a scaffolded project that
 *  has already gone through `pruneToClientOnly`. */
export function applyCloudflareMode(
  outputDir: string,
  input: CloudflareModeInput,
  modifications: string[],
): void {
  const compatibilityDate = input.compatibilityDate ?? defaultCompatibilityDate();
  const branch = input.defaultBranch ?? "main";
  const nodeVersion = input.nodeVersion ?? DEFAULT_NODE_VERSION;

  patchNextConfig(outputDir, modifications);
  writeWranglerConfig(outputDir, input.workerName, compatibilityDate, modifications);
  writeNodeVersion(outputDir, nodeVersion, modifications);
  writeHeaders(outputDir, modifications);
  writeCarryScript(outputDir, modifications);
  writeDeployWorkflow(outputDir, branch, input.siteUrl, modifications);
  dropCoolifyWorkflow(outputDir, modifications);
}

/** Rewrite `packages/client/next.config.ts` to a static-export config.
 *
 *  Deliberately a full rewrite rather than the regex surgery
 *  pages-mode.ts does. The starter's config picks `output` out of a
 *  ternary keyed on `NEXT_FILE_EXPORT`, so a regex that swaps the first
 *  quoted `output:` value hits the ternary's export branch and leaves
 *  the default build on `standalone` — a silent no-op that produces no
 *  `out/` for wrangler to serve.
 *
 *  Also deliberately NOT `flipNextConfigToStaticExport`. That writes the
 *  config the native shells need, which fails the build unless
 *  `NEXT_PUBLIC_API_URL` is set — correct for a desktop binary that
 *  talks to a remote Express server, wrong here, where there is no API
 *  at all and the guard would just block every deploy.
 *
 *  No `assetPrefix` either: a relative `"./"` prefix resolves `_next/*`
 *  against the current path, so every nested route 404s its own chunks
 *  once the site is served over HTTP.
 */
function patchNextConfig(outputDir: string, modifications: string[]): void {
  const path = join(outputDir, "packages/client/next.config.ts");
  if (!existsSync(path)) return;
  const clientName = readPackageName(join(outputDir, "packages/client"));
  const transpile = readWorkspacePackageNames(outputDir).filter((n) => n !== clientName);
  const transpileList = transpile.map((n) => `"${n}"`).join(", ");
  writeFileSync(
    path,
    `import type { NextConfig } from "next";

// Static export served by Cloudflare Workers Static Assets. There is no
// server and no API, so no NEXT_PUBLIC_API_URL guard: nothing here talks
// to a backend. \`next build\` writes ./out, which wrangler.jsonc serves.
//
// No assetPrefix on purpose — a relative prefix resolves /_next/* against
// the current path, so every nested route would 404 its own chunks.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: [${transpileList}],
};

export default nextConfig;
`,
    "utf-8",
  );
  modifications.push(
    "cloudflare: rewrote packages/client/next.config.ts for static export (output=export)",
  );
}

/** Write `wrangler.jsonc` at the repo root.
 *
 *  `workers_dev: true` is explicit on purpose — see the traps section
 *  of the migration playbook. Adding a `routes` entry later silently
 *  disables the `*.workers.dev` preview URL unless the flag is set,
 *  and the deploy output gives no hint that it happened.
 */
function writeWranglerConfig(
  outputDir: string,
  workerName: string,
  compatibilityDate: string,
  modifications: string[],
): void {
  const path = join(outputDir, CLOUDFLARE_WRANGLER_REL_PATH);
  if (existsSync(path)) return;
  const body = `{
  "name": "${workerName}",
  "compatibility_date": "${compatibilityDate}",
  "assets": {
    // \`pnpm build\` static-exports the client here.
    "directory": "./${CLOUDFLARE_PUBLISH_DIR}",
    // Serve out/404.html for unknown paths instead of an SPA fallback.
    "not_found_handling": "404-page"
  },
  // Keeps <name>.<subdomain>.workers.dev serving. Adding a \`routes\`
  // entry silently disables it unless this is set explicitly, and the
  // preview URL then 404s with nothing in the deploy output.
  "workers_dev": true
}
`;
  writeFileSync(path, body, "utf-8");
  modifications.push(
    `cloudflare: wrote ${CLOUDFLARE_WRANGLER_REL_PATH} (assets → ${CLOUDFLARE_PUBLISH_DIR})`,
  );
}

/** Pin the Node major for CI. Cloudflare's own build image and
 *  `actions/setup-node`'s `node-version-file` both read this. */
function writeNodeVersion(outputDir: string, nodeVersion: string, modifications: string[]): void {
  const path = join(outputDir, CLOUDFLARE_NODE_VERSION_REL_PATH);
  if (existsSync(path)) return;
  writeFileSync(path, `${nodeVersion}\n`, "utf-8");
  modifications.push(`cloudflare: wrote .node-version (${nodeVersion})`);
}

/** No-cache rules for the served output.
 *
 *  Next copies `public/` verbatim into `out/`, so the file lands at the
 *  root of what the Worker serves, which is where Cloudflare looks for
 *  it. A project scaffolded before 2026-10-15 has an immutable rule on
 *  `/_next/static/*` that caches 404s for a year; a re-run removes
 *  hatchkit's own copy of that rule (see worker-assets.ts).
 */
function writeHeaders(outputDir: string, modifications: string[]): void {
  const publicDir = join(outputDir, CLOUDFLARE_PUBLIC_DIR);
  mkdirSync(publicDir, { recursive: true });
  const path = join(publicDir, "_headers");
  if (existsSync(path)) {
    const migrated = migrateHeaders(readFileSync(path, "utf-8"));
    if (migrated === null) return;
    writeFileSync(path, migrated, "utf-8");
    modifications.push(
      `cloudflare: updated ${CLOUDFLARE_HEADERS_REL_PATH} (no immutable 404s, release manifest no-store)`,
    );
    return;
  }
  writeFileSync(path, renderWorkerHeaders(), "utf-8");
  modifications.push(`cloudflare: wrote ${CLOUDFLARE_HEADERS_REL_PATH}`);
}

/** Write the deploy workflow.
 *
 *  `--no-frozen-lockfile`: the static prune drops `@trpc/*` +
 *  `better-auth` from packages/client/package.json without
 *  regenerating the starter's committed lockfile, so the very first CI
 *  run would fail a frozen install. Once the user has run `pnpm
 *  install` locally and committed the refreshed lockfile they can
 *  tighten this back to `--frozen-lockfile`.
 *
 *  `fetch-depth: 0`: a shallow clone stamps every file's mtime with
 *  the checkout time, which silently breaks any build step that
 *  derives dates from the filesystem (a sitemap's `lastmod` is the
 *  usual victim).
 *
 *  A workflow hatchkit wrote before 2026-10-15 (one-step `wrangler
 *  deploy`, no carry) is replaced; any other existing file is left alone.
 */
function writeDeployWorkflow(
  outputDir: string,
  branch: string,
  siteUrl: string | undefined,
  modifications: string[],
): void {
  const path = join(outputDir, CLOUDFLARE_WORKFLOW_REL_PATH);
  mkdirSync(join(outputDir, ".github", "workflows"), { recursive: true });
  const body = renderDeployWorkflow(branch, siteUrl);
  if (existsSync(path)) {
    const current = readFileSync(path, "utf-8");
    if (current === body) return;
    if (current !== renderLegacyDeployWorkflow(branch)) {
      modifications.push(
        `cloudflare: ${CLOUDFLARE_WORKFLOW_REL_PATH} already exists — left untouched`,
      );
      return;
    }
    writeFileSync(path, body, "utf-8");
    modifications.push(
      `cloudflare: replaced ${CLOUDFLARE_WORKFLOW_REL_PATH} (upload, then activate; carry old chunks)`,
    );
    return;
  }
  writeFileSync(path, body, "utf-8");
  modifications.push(`cloudflare: wrote ${CLOUDFLARE_WORKFLOW_REL_PATH}`);
}

/** Exported for the test suite and for `hatchkit cloudflare`, which
 *  writes the same workflow into an already-scaffolded repo.
 *
 *  Upload, wait, then activate: a one-step `wrangler deploy` left about
 *  15 s in which the new HTML was live and its chunks answered 404
 *  (canary, 2026-10-12). `versions upload`, a 43 s pause and `versions
 *  deploy` had no 404 in 14 samples. The pause here is 30 s. */
export function renderDeployWorkflow(branch: string, siteUrl?: string): string {
  return `name: Deploy to Cloudflare

on:
  push:
    branches: [${branch}]
  workflow_dispatch:

concurrency:
  group: deploy-cloudflare
  # Never cancel a run between upload and activation.
  cancel-in-progress: false

env:
  # Live site the carry step reads /release-assets.json from. Blank skips
  # the carry (a site on *.workers.dev only).
  SITE_URL: "${siteUrl ?? ""}"
  WRANGLER: ${WRANGLER_PACKAGE}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          # A shallow clone stamps every file's mtime with the checkout
          # time. Build steps that read dates off the filesystem (e.g. a
          # sitemap's lastmod) need the real history.
          fetch-depth: 0

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v6
        with:
          node-version-file: .node-version
          cache: pnpm

      # Not --frozen-lockfile: the static scaffold prunes deps out of
      # package.json without regenerating the starter's lockfile. Run
      # \`pnpm install\` locally, commit the refreshed lockfile, then
      # tighten this to --frozen-lockfile.
      - run: pnpm install --no-frozen-lockfile

      # Writes the static site to ${CLOUDFLARE_PUBLISH_DIR}, which
      # wrangler.jsonc serves.
      - run: pnpm run build

      # A Worker version serves only its own files. Carry the hashed files
      # of the last two releases so tabs opened before this deploy keep
      # loading their chunks.
      - name: Carry earlier releases' hashed files
        if: env.SITE_URL != ''
        run: node ${CARRY_SCRIPT_REL_PATH} --site "$SITE_URL" --out ${CLOUDFLARE_PUBLISH_DIR}

      - name: Upload a new Worker version (not live yet)
        id: upload
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          WRANGLER_OUTPUT_FILE_PATH: \${{ runner.temp }}/wrangler-upload.ndjson
        run: |
          pnpm dlx "$WRANGLER" versions upload --tag "$GITHUB_SHA" --message "$GITHUB_SHA"
          id=$(node -e 'const rows=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\\n").map((l)=>JSON.parse(l));const row=rows.find((r)=>r.type==="version-upload");if(!row?.version_id)process.exit(1);console.log(row.version_id)' "$WRANGLER_OUTPUT_FILE_PATH")
          echo "version_id=$id" >> "$GITHUB_OUTPUT"
          echo "Uploaded version $id"

      # Measured on the canary: activating right after a one-step deploy
      # left ~15 s of 404s on new chunks; upload, wait, activate left none.
      - name: Let the upload settle
        run: sleep 30

      - name: Activate the version
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: pnpm dlx "$WRANGLER" versions deploy "\${{ steps.upload.outputs.version_id }}@100%" --message "$GITHUB_SHA" --yes
`;
}

/** The workflow hatchkit wrote before 2026-10-15, kept only so a re-run
 *  can recognise and replace its own file. */
function renderLegacyDeployWorkflow(branch: string): string {
  return `name: Deploy to Cloudflare

on:
  push:
    branches: [${branch}]
  workflow_dispatch:

concurrency:
  group: deploy-cloudflare
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          # A shallow clone stamps every file's mtime with the checkout
          # time. Build steps that read dates off the filesystem (e.g. a
          # sitemap's lastmod) need the real history.
          fetch-depth: 0

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v6
        with:
          node-version-file: .node-version
          cache: pnpm

      # Not --frozen-lockfile: the static scaffold prunes deps out of
      # package.json without regenerating the starter's lockfile. Run
      # \`pnpm install\` locally, commit the refreshed lockfile, then
      # tighten this to --frozen-lockfile.
      - run: pnpm install --no-frozen-lockfile

      # Writes the static site to ${CLOUDFLARE_PUBLISH_DIR}, which
      # wrangler.jsonc serves.
      - run: pnpm run build

      - uses: cloudflare/wrangler-action@v4
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          packageManager: pnpm
`;
}

/** Remove the starter's GHCR/Coolify image workflow. It builds and
 *  pushes a Docker image nothing consumes in this mode, and fails on
 *  every push because the static prune deleted the server package it
 *  builds from. */
function dropCoolifyWorkflow(outputDir: string, modifications: string[]): void {
  const path = join(outputDir, COOLIFY_WORKFLOW_REL_PATH);
  if (!existsSync(path)) return;
  removeIfExists(path);
  modifications.push(`cloudflare: removed ${COOLIFY_WORKFLOW_REL_PATH} (no image to build)`);
}

/** Read the wrangler config back. Used by the test suite and by
 *  `hatchkit doctor`'s project-local check, which compares the
 *  `assets.directory` on disk against what the build actually writes. */
export function readWranglerConfig(projectDir: string): string | null {
  const path = join(projectDir, CLOUDFLARE_WRANGLER_REL_PATH);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}
