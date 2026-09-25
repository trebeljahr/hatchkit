/*
 * Surface-aware pruning for `hatchkit create`.
 *
 * The full-stack starter ships with packages/{server,client,shared} plus
 * a multi-service docker-compose. When the user picks a narrower surface
 * (backend / static) we strip the unused half AFTER the copy. The
 * `fullstack` and `split` modes keep both packages — split only differs
 * at provisioner time (two observability projects per vendor instead of
 * one), the on-disk layout is identical.
 *
 *   · backend — remove packages/client + client-side top-level
 *     scaffolding (Next.js / Electron / Capacitor / e2e), strip the
 *     `client` service from docker-compose.yml, rewrite the root
 *     package.json scripts to drop client/test/e2e/native targets.
 *     Clean by construction: the server has zero `@starter/client`
 *     imports.
 *
 *   · static — remove packages/server + every client-side route /
 *     provider / hook / lib that talks to the server (the (protected)
 *     route group, auth pages, tRPC wiring, Better Auth client),
 *     strip the server/mongo/redis services from docker-compose,
 *     rewrite the landing page so it doesn't link to auth pages we
 *     just deleted, and drop the now-unused @trpc/* + better-auth
 *     dependencies. Mobile/desktop wrappers stay valid because they
 *     wrap the client.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig, Surface } from "../prompts.js";
import { CLIENT_WORKFLOW_REL_PATH } from "./client-build-args.js";
import { stripClientDockerfileApiUrlAssertion } from "./deploy-verification.js";
import { setPackageJsonScript, stripPackageJsonDeps, stripPackageJsonScripts } from "./pkg-json.js";
import { removeIfExists, rewriteFile } from "./starter-files.js";

/** Apply surface-aware pruning to a freshly-copied starter. Mutates
 *  `modifications` in place so the orchestrator's spinner summary
 *  reflects what changed. */
export function pruneToSurface(
  config: ProjectConfig,
  outputDir: string,
  modifications: string[],
): void {
  if (config.surfaces === "fullstack" || config.surfaces === "split") return;
  if (config.surfaces === "backend") pruneToServerOnly(outputDir, modifications);
  else {
    pruneToClientOnly(outputDir, modifications);
    // Pages needs additional config tweaks on top of the static
    // prune — the prune drops the `/api/*` rewrites and the API-URL
    // guard but leaves `output: "standalone"`, which assumes a Node
    // server Pages can't run.
    if (config.deploymentMode === "gh-pages") {
      // Lazy import to avoid pulling node:fs deeper than needed for
      // the non-pages paths. The dep graph here is already heavy.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { applyPagesMode } = require("./pages-mode.js") as typeof import("./pages-mode.js");
      applyPagesMode(outputDir, modifications);
    }
  }
}

// ── backend ────────────────────────────────────────────────────────────

function pruneToServerOnly(outputDir: string, modifications: string[]): void {
  // Drop the client package outright. The server has no `@starter/client`
  // imports (verified by the test suite), so this is safe.
  removeIfExists(join(outputDir, "packages/client"));
  modifications.push("backend: removed packages/client/");

  // Top-level dirs/files that only make sense alongside a client. Mobile
  // and desktop are already feature-gated so they're usually gone by
  // this point — these calls are belt-and-braces for the case where the
  // user picks backend + desktop/mobile (a contradiction we don't
  // bother validating; the strip just wins).
  for (const rel of CLIENT_SIDE_TOP_LEVEL) removeIfExists(join(outputDir, rel));
  modifications.push("backend: removed client-side top-level scaffolding");

  // Strip the `client` service from compose. Keep `server`, `mongo`,
  // `redis`, and the `mongo-data` volume — the server still needs all
  // three.
  for (const rel of ["docker-compose.yml", "docker-compose.dev.yml"]) {
    const p = join(outputDir, rel);
    if (existsSync(p)) rewriteFile(p, (c) => stripComposeServices(c, ["client"]));
  }
  modifications.push("backend: removed client service from docker-compose");

  dropWorkspaceEntry(outputDir, "docs-site");

  // CI workflow: the client image job builds `packages/client/Dockerfile`,
  // which we just deleted, and the e2e job drives Playwright against a
  // browser surface that no longer exists (its `e2e/` dir went with
  // CLIENT_SIDE_TOP_LEVEL). Both fail on the first push. The `test:client`
  // step goes too — the script is stripped from the root package.json
  // below.
  pruneCiWorkflow(outputDir, modifications, {
    label: "backend",
    jobs: ["build-client", "e2e"],
    steps: [/^[ \t]*- run: pnpm run test:client[ \t]*\r?\n/m],
    note: "dropped build-client + e2e jobs and the test:client step from build-and-deploy.yml",
  });

  // Root package.json scripts: drop client/test/e2e/native targets and
  // rewrite the build/test/dev orchestrators to point at the server
  // only.
  stripPackageJsonScripts(outputDir, [
    "dev:fixed",
    "dev:docs",
    "dev:docs:fixed",
    "build:client",
    "test:client",
    "test:e2e",
    ...NATIVE_SCRIPTS,
  ]);
  setPackageJsonScript(outputDir, "dev", "pnpm --filter @starter/server dev");
  setPackageJsonScript(
    outputDir,
    "build",
    "pnpm --filter @starter/shared run build && pnpm --filter @starter/server run build",
  );
  setPackageJsonScript(outputDir, "test", "pnpm run test:unit");
  setPackageJsonScript(outputDir, "typecheck", "pnpm -r run typecheck");
  modifications.push("backend: rewrote root package.json scripts");
}

// ── static ─────────────────────────────────────────────────────────────

function pruneToClientOnly(outputDir: string, modifications: string[]): void {
  // The full server package and any shared types only the server router
  // exposes. ml-types is re-exported by packages/shared/src/index.ts,
  // so we patch the barrel after this.
  removeIfExists(join(outputDir, "packages/server"));
  removeIfExists(join(outputDir, "packages/shared/src/ml-types.ts"));
  modifications.push("static: removed packages/server/ and packages/shared/src/ml-types.ts");

  // Shared barrel re-exports ml-types — drop the line so the package
  // still builds after the file goes.
  const sharedIndex = join(outputDir, "packages/shared/src/index.ts");
  if (existsSync(sharedIndex)) {
    rewriteFile(sharedIndex, (c) => c.replace(/^export \* from "\.\/ml-types\.js";\n/m, ""));
  }

  // Routes that talk to the server: every authenticated page (which
  // uses tRPC + auth) plus the unauthenticated login/signup pages
  // (which call Better Auth on the server).
  const clientApp = join(outputDir, "packages/client/src/app");
  for (const rel of ["(protected)", "login", "signup", "forgot-password", "reset-password"]) {
    removeIfExists(join(clientApp, rel));
  }
  // The components/ml tree only has consumers inside `(protected)`, so
  // it goes too.
  removeIfExists(join(outputDir, "packages/client/src/components/ml"));
  // Providers, libs, and hooks that only make sense with a backend.
  for (const rel of [
    "src/providers/trpc-provider.tsx",
    "src/providers/auth-provider.tsx",
    "src/lib/trpc.ts",
    "src/lib/auth-client.ts",
    "src/hooks/use-auth.ts",
  ]) {
    removeIfExists(join(outputDir, "packages/client", rel));
  }
  modifications.push("static: removed auth/tRPC routes, providers, libs, hooks");

  // app/layout.tsx still imports the providers we just deleted and
  // wraps children in them. Rewrite to a minimal layout that just
  // renders {children} (analytics + mobile bridge stay — neither
  // depends on the server).
  rewriteClientLayoutForClientOnly(outputDir);

  // app/page.tsx links to /login and /signup, both gone now. Replace
  // it with a static "Get started" stub. The user is meant to replace
  // this with their own marketing content anyway.
  rewriteLandingForClientOnly(outputDir);

  // next.config.ts + tsconfig.json still reference the server we just
  // deleted. Applies to EVERY static deployment mode — gh-pages gets
  // further tweaks from applyPagesMode on top, but Coolify-hosted
  // static scaffolds only get this pass, and without it the image
  // build throws on the NEXT_PUBLIC_API_URL guard.
  patchNextConfigForClientOnly(outputDir, modifications);
  patchClientTsconfigForClientOnly(outputDir, modifications);
  patchClientDockerfileForClientOnly(outputDir, modifications);

  // packages/client/package.json: drop the deps we no longer use. The
  // client still keeps Next.js, React, Sentry, OpenPanel, Tailwind,
  // class-variance-authority, etc.
  stripPackageJsonDeps(join(outputDir, "packages/client"), [
    "@trpc/client",
    "@trpc/react-query",
    "@tanstack/react-query",
    "better-auth",
  ]);
  modifications.push("static: pruned @trpc/* + better-auth from packages/client/package.json");

  // Strip server-oriented services from compose. The starter's compose
  // has `server`, `client`, `mongo` (or `postgres` after the postgres
  // overlay), `redis` plus a `mongo-data` / `postgres-data` volume.
  // For static we keep just `client`.
  for (const rel of ["docker-compose.yml", "docker-compose.dev.yml"]) {
    const p = join(outputDir, rel);
    if (existsSync(p)) {
      rewriteFile(p, (c) => stripComposeServices(c, ["server", "mongo", "postgres", "redis"]));
      rewriteFile(p, removeDbDataVolume);
    }
  }
  modifications.push("static: removed server/mongo/postgres/redis from docker-compose");

  // docs-site doubles as the starter's marketing docs. It's a separate
  // app and not particularly useful in a static scaffold; drop it
  // so the workspace stays minimal.
  removeIfExists(join(outputDir, "docs-site"));
  removeIfExists(join(outputDir, "e2e"));
  removeIfExists(join(outputDir, "playwright.config.ts"));
  removeIfExists(join(outputDir, "seed"));
  dropWorkspaceEntry(outputDir, "docs-site");

  // CI workflow: the server image job builds `packages/server/Dockerfile`,
  // which we just deleted, and the e2e job spins up mongo/redis/SeaweedFS to
  // Playwright-test an API that isn't there (its `e2e/` dir and
  // playwright.config.ts went above). The `test:unit` step is the
  // server's Vitest run — the script is stripped from the root
  // package.json below.
  pruneCiWorkflow(outputDir, modifications, {
    label: "static",
    jobs: ["build-server", "e2e"],
    steps: [/^[ \t]*- run: pnpm run test:unit[ \t]*\r?\n/m],
    note: "dropped build-server + e2e jobs and the test:unit step from build-and-deploy.yml",
  });

  // Root package.json scripts: drop the server / e2e / docs targets
  // and point dev/build/test at the client filter.
  stripPackageJsonScripts(outputDir, [
    "dev:fixed",
    "dev:docs",
    "dev:docs:fixed",
    "build:server",
    "test:unit",
    "test:e2e",
    "seed:assets",
    "assets:push",
    "assets:pull",
  ]);
  setPackageJsonScript(outputDir, "dev", "pnpm --filter @starter/client dev");
  setPackageJsonScript(
    outputDir,
    "build",
    "pnpm --filter @starter/shared run build && pnpm --filter @starter/client run build",
  );
  setPackageJsonScript(outputDir, "test", "pnpm run test:client");
  // Leave typecheck alone — the desktop/mobile feature-flag step
  // handles the electron variant for native scaffolds, and the bare
  // `pnpm -r run typecheck` works for everything else.
  setPackageJsonScript(outputDir, "typecheck", "pnpm -r run typecheck");
  modifications.push("static: rewrote root package.json scripts");
}

function rewriteClientLayoutForClientOnly(outputDir: string): void {
  const path = join(outputDir, "packages/client/src/app/layout.tsx");
  if (!existsSync(path)) return;
  // Surgical edit — drop the two provider imports and unwrap children
  // from <TRPCProvider><AuthProvider>…</AuthProvider></TRPCProvider>.
  // Leaves the rest of the layout (metadata, analytics gate,
  // MobileBridgeLoader when the mobile feature is on) alone so its
  // upstream feature-flag rewrites (stripMobileBridgeFromLayout) still
  // win when they run.
  rewriteFile(path, (content) => {
    let next = content
      .replace(/^import\s*\{\s*TRPCProvider\s*\}\s*from\s*"@\/providers\/trpc-provider";\n/m, "")
      .replace(/^import\s*\{\s*AuthProvider\s*\}\s*from\s*"@\/providers\/auth-provider";\n/m, "");
    // Match either <TRPCProvider><AuthProvider>{children}</AuthProvider></TRPCProvider>
    // or a multi-line variant; whitespace-flexible.
    next = next.replace(
      /<TRPCProvider>\s*<AuthProvider>\s*\{children\}\s*<\/AuthProvider>\s*<\/TRPCProvider>/,
      "{children}",
    );
    return next;
  });
}

/** Strip the three server-dependent pieces of the starter's Next
 *  config once `packages/server` is gone:
 *
 *    1. The build-time `NEXT_PUBLIC_API_URL` guard. It throws when the
 *       Coolify image build (`HATCHKIT_IMAGE_BUILD=1`) or a native
 *       static export runs without an API URL — correct for a
 *       fullstack scaffold, fatal for a static one where there is no
 *       API to point at.
 *    2. `async rewrites()`, which proxies `/api/*` to an Express
 *       server that no longer exists.
 *    3. `@starter/server` in `transpilePackages`, a deleted workspace
 *       package.
 *
 *  Runs for every static deployment mode. `applyPagesMode` layers the
 *  gh-pages-only changes (output=export) on top and is idempotent
 *  against this pass. */
function patchNextConfigForClientOnly(outputDir: string, modifications: string[]): void {
  const clientDir = join(outputDir, "packages/client");
  const found = NEXT_CONFIG_CANDIDATES.map((c) => join(clientDir, c)).find((p) => existsSync(p));
  if (!found) return;

  rewriteFile(found, (raw) => {
    let out = raw;

    // 1. The guard, plus the comment block explaining it. Both live at
    //    column 0 in the starter, so the closing `}` at column 0
    //    bounds the block.
    out = out.replace(/(?:^\/\/[^\n]*\n)*^if \([\s\S]*?NEXT_PUBLIC_API_URL[\s\S]*?^\}\n+/m, "");

    // 2. The rewrites() block and the comment above it. Same shape as
    //    the pages-mode strip so the two stay consistent.
    out = out.replace(/\n[^\n]*\/\/[^\n]*Proxy API[^\n]*\n/, "\n");
    out = out.replace(/[ \t]*async\s+rewrites\s*\(\s*\)\s*\{[\s\S]*?\n\s*\},?\s*\n/, "");

    // 3. transpilePackages + the tracing comment that names the
    //    deleted package.
    out = out.replace(/(transpilePackages\s*:\s*\[[^\]]*?)\s*,?\s*"@starter\/server"/, "$1");
    out = out.replace(/\(@starter\/shared, @starter\/server\)/, "(@starter/shared)");

    return out;
  });
  modifications.push(
    "static: patched next.config (dropped NEXT_PUBLIC_API_URL guard, /api rewrites, @starter/server)",
  );
}

/** Drop the client image's NEXT_PUBLIC_API_URL assertion.
 *
 *  Same reason `patchNextConfigForClientOnly` drops the build-time guard
 *  from next.config.ts: a static project has no server half, so there is
 *  no API URL to inline and a check demanding one fails every image
 *  build. The `version.json` stamp stays — the deploy pipeline polls the
 *  commit it records, and that works for a static project too. */
function patchClientDockerfileForClientOnly(outputDir: string, modifications: string[]): void {
  const path = join(outputDir, "packages/client/Dockerfile");
  if (!existsSync(path)) return;
  rewriteFile(path, stripClientDockerfileApiUrlAssertion);
  modifications.push("static: patched client Dockerfile (dropped NEXT_PUBLIC_API_URL assertion)");
}

/** Drop the `@starter/server/trpc` path alias from the client's
 *  tsconfig — it points into the package the static prune deletes, so
 *  `tsc --noEmit` fails to resolve it. */
function patchClientTsconfigForClientOnly(outputDir: string, modifications: string[]): void {
  const path = join(outputDir, "packages/client/tsconfig.json");
  if (!existsSync(path)) return;
  rewriteFile(path, (raw) => {
    // Two shapes: the entry is last (preceded by a comma we must eat
    // too) or it isn't (it carries its own trailing comma).
    const withLeadingComma = raw.replace(/,[^\n]*\n\s*"@starter\/server\/trpc":\s*\[[^\]]*\]/, "");
    if (withLeadingComma !== raw) return withLeadingComma;
    return raw.replace(/^\s*"@starter\/server\/trpc":\s*\[[^\]]*\],?[^\n]*\n/m, "");
  });
  modifications.push("static: dropped @starter/server/trpc path alias from client tsconfig");
}

function rewriteLandingForClientOnly(outputDir: string): void {
  const path = join(outputDir, "packages/client/src/app/page.tsx");
  if (!existsSync(path)) return;
  const next = `export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <main className="mx-auto max-w-2xl text-center">
        <h1 className="mb-4 text-4xl font-bold tracking-tight">
          Welcome to My App
        </h1>
        <p className="mb-8 text-lg text-muted-foreground">
          Edit packages/client/src/app/page.tsx to replace this placeholder.
        </p>
      </main>
    </div>
  );
}
`;
  writeFileSync(path, next, "utf-8");
}

// ── CI workflow helpers ────────────────────────────────────────────────

interface CiWorkflowPrune {
  /** Prefix for the `modifications` line ("backend" / "static"). */
  label: string;
  /** Top-level job names to drop from `jobs:`. */
  jobs: string[];
  /** Step lines to drop wholesale (each regex must match its own
   *  trailing newline so no blank line is left behind). */
  steps: RegExp[];
  /** Human-readable summary for the spinner log. */
  note: string;
}

/** Strip the jobs and steps of build-and-deploy.yml that reference a
 *  package the surface prune just deleted. Without this the generated
 *  workflow fails on its very first push: `docker/build-push-action`
 *  gets a `file:` path that isn't in the repo. No-op when the workflow
 *  is missing (adopted repos, hand-rolled CI). */
function pruneCiWorkflow(outputDir: string, modifications: string[], opts: CiWorkflowPrune): void {
  const path = join(outputDir, CLIENT_WORKFLOW_REL_PATH);
  if (!existsSync(path)) return;
  rewriteFile(path, (raw) => {
    let out = stripWorkflowJobs(raw, opts.jobs);
    for (const step of opts.steps) out = out.replace(step, "");
    return out;
  });
  modifications.push(`${opts.label}: ${opts.note}`);
}

/** Drop top-level workflow jobs by name, then repair every `needs:`
 *  list that referenced them. Removing a job without the second half
 *  leaves an invalid workflow — GitHub rejects the whole file when a
 *  `needs:` names a job that doesn't exist, so `deploy` (which is
 *  `needs: [build-server, build-client]`) must shrink alongside. */
function stripWorkflowJobs(content: string, names: string[]): string {
  let out = content;
  for (const name of names) out = stripOneWorkflowJob(out, name);
  return dropFromNeeds(out, new Set(names));
}

/** Remove a single `  <name>:` block from under `jobs:`. Same
 *  sibling-indent bounding as stripOneComposeService — a line back at
 *  the 2-space job indent (a sibling job OR the comment block that
 *  documents one) or at column 0 ends the block, so a following job's
 *  leading comments survive. */
function stripOneWorkflowJob(content: string, name: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;
  const header = new RegExp(`^ {2}${name}:\\s*$`);
  while (i < lines.length) {
    const line = lines[i];
    if (header.test(line)) {
      i += 1;
      while (i < lines.length) {
        const body = lines[i];
        if (body === "") {
          // Blank lines inside a job body (between steps) stay with the
          // body we're deleting; the one separating this job from the
          // next sibling goes too, so we don't leave a double blank.
          const peek = lines.slice(i + 1).find((l) => l.trim() !== "");
          if (!peek || /^ {2}\S/.test(peek) || /^\S/.test(peek)) {
            i += 1;
            break;
          }
          i += 1;
          continue;
        }
        if (/^ {2}\S/.test(body) || /^\S/.test(body)) break;
        i += 1;
      }
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n");
}

/** Rewrite `needs: [a, b]` flow sequences to drop removed job names,
 *  deleting the key outright when nothing is left (the job then runs
 *  unconditioned rather than gating on a job that no longer exists).
 *  The generated workflow only ever uses the flow form; a hand-edited
 *  block sequence (`needs:` + `- a` lines) is left alone. */
function dropFromNeeds(content: string, removed: Set<string>): string {
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^(\s*)needs:\s*\[([^\]]*)\]\s*$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const kept = m[2]
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n !== "" && !removed.has(n));
    if (kept.length === 0) continue;
    out.push(`${m[1]}needs: [${kept.join(", ")}]`);
  }
  return out.join("\n");
}

// ── compose helpers ────────────────────────────────────────────────────

/** Strip one or more top-level services from a Compose document. Looks
 *  for `<name>:` at the canonical 2-space indent under `services:` and
 *  drops every line that belongs to the block (anything indented past
 *  2 spaces). Sibling-key detection — any line at the 2-space sibling
 *  indent or back to column 0 — bounds the block. No-op if a name
 *  isn't present. */
function stripComposeServices(content: string, names: string[]): string {
  let out = content;
  for (const name of names) {
    out = stripOneComposeService(out, name);
  }
  return out;
}

function stripOneComposeService(content: string, name: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;
  const header = new RegExp(`^ {2}${name}:\\s*$`);
  while (i < lines.length) {
    const line = lines[i];
    if (header.test(line)) {
      i += 1;
      while (i < lines.length) {
        const body = lines[i];
        if (body === "") {
          // Drop the trailing blank only if the next non-empty line is
          // a sibling key — otherwise we'd swallow the separator before
          // `volumes:` and similar.
          const peek = lines.slice(i + 1).find((l) => l.trim() !== "");
          if (!peek || /^ {2}\S/.test(peek) || /^\S/.test(peek)) {
            i += 1;
            break;
          }
          out.push(body);
          i += 1;
          continue;
        }
        if (/^ {2}\S/.test(body) || /^\S/.test(body)) break;
        i += 1;
      }
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n");
}

/** Remove the top-level `volumes:` block + its `mongo-data:` (or
 *  `postgres-data:` after the postgres overlay) entry. Used after
 *  stripping the DB service so the compose doesn't reference an
 *  orphaned volume. The starter only declares one volume, so we drop
 *  the whole block; if a future starter adds more, this'll need to
 *  become entry-aware. */
function removeDbDataVolume(content: string): string {
  return content.replace(/\nvolumes:\s*\n\s+(mongo-data|postgres-data):\s*\n?/m, "\n");
}

// ── shared helpers ─────────────────────────────────────────────────────

function dropWorkspaceEntry(outputDir: string, name: string): void {
  const path = join(outputDir, "pnpm-workspace.yaml");
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  const next = content.replace(new RegExp(`^\\s*-\\s*"${name}"\\s*\\n`, "m"), "");
  if (next !== content) writeFileSync(path, next, "utf-8");
}

const NEXT_CONFIG_CANDIDATES = [
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
];

const CLIENT_SIDE_TOP_LEVEL = [
  "electron",
  "ios",
  "android",
  "capacitor.config.ts",
  "docs-site",
  "build",
  "resources",
  "e2e",
  "playwright.config.ts",
  ".github/workflows/desktop-release.yml",
  ".github/workflows/mobile-release.yml",
];

const NATIVE_SCRIPTS = [
  "dev:desktop",
  "dev:electron",
  "build:desktop",
  "electron:compile",
  "electron:build",
  "electron:preview",
  "typecheck:electron",
  "icons:desktop",
  "itch:push:mac",
  "itch:push:win",
  "itch:push:linux",
  "dev:android",
  "dev:ios",
  "build:mobile",
  "cap:add:ios",
  "cap:add:android",
  "cap:sync",
  "cap:run:ios",
  "cap:run:android",
  "build:ios:release",
  "build:android:release",
  "build:android:apk",
  "mobile:assets",
];

/** Tiny export so callers (tests, future surface kinds) can ask "does
 *  this surface keep a server?" without duplicating the string check.
 *  Only `static` has no server runtime — fullstack, split, and backend
 *  all do. */
export function surfaceHasServer(surface: Surface): boolean {
  return surface !== "static";
}

/** Same for the client half. Only `backend` has no client surface. */
export function surfaceHasClient(surface: Surface): boolean {
  return surface !== "backend";
}
