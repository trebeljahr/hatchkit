/*
 * Surface-aware pruning for `hatchkit create`.
 *
 * The full-stack starter ships with packages/{server,client,shared} plus
 * a multi-service docker-compose. When the user picks a narrower surface
 * (server-only / client-only) we strip the unused half AFTER the copy.
 *
 *   · server-only — remove packages/client + client-side top-level
 *     scaffolding (Next.js / Electron / Capacitor / e2e), strip the
 *     `client` service from docker-compose.yml, rewrite the root
 *     package.json scripts to drop client/test/e2e/native targets.
 *     Clean by construction: the server has zero `@starter/client`
 *     imports.
 *
 *   · client-only — remove packages/server + every client-side route /
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
  if (config.surfaces === "both") return;
  if (config.surfaces === "server-only") pruneToServerOnly(outputDir, modifications);
  else {
    pruneToClientOnly(outputDir, modifications);
    // Pages needs additional config tweaks on top of the client-only
    // prune — the prune leaves `output: "standalone"` + `/api/*`
    // rewrites in place, both of which assume a running backend.
    if (config.deploymentMode === "gh-pages") {
      // Lazy import to avoid pulling node:fs deeper than needed for
      // the non-pages paths. The dep graph here is already heavy.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { applyPagesMode } = require("./pages-mode.js") as typeof import("./pages-mode.js");
      applyPagesMode(outputDir, modifications);
    }
  }
}

// ── server-only ────────────────────────────────────────────────────────

function pruneToServerOnly(outputDir: string, modifications: string[]): void {
  // Drop the client package outright. The server has no `@starter/client`
  // imports (verified by the test suite), so this is safe.
  removeIfExists(join(outputDir, "packages/client"));
  modifications.push("server-only: removed packages/client/");

  // Top-level dirs/files that only make sense alongside a client. Mobile
  // and desktop are already feature-gated so they're usually gone by
  // this point — these calls are belt-and-braces for the case where the
  // user picks server-only + desktop/mobile (a contradiction we don't
  // bother validating; the strip just wins).
  for (const rel of CLIENT_SIDE_TOP_LEVEL) removeIfExists(join(outputDir, rel));
  modifications.push("server-only: removed client-side top-level scaffolding");

  // Strip the `client` service from compose. Keep `server`, `mongo`,
  // `redis`, and the `mongo-data` volume — the server still needs all
  // three.
  for (const rel of ["docker-compose.yml", "docker-compose.dev.yml"]) {
    const p = join(outputDir, rel);
    if (existsSync(p)) rewriteFile(p, (c) => stripComposeServices(c, ["client"]));
  }
  modifications.push("server-only: removed client service from docker-compose");

  dropWorkspaceEntry(outputDir, "docs-site");

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
  modifications.push("server-only: rewrote root package.json scripts");
}

// ── client-only ────────────────────────────────────────────────────────

function pruneToClientOnly(outputDir: string, modifications: string[]): void {
  // The full server package and any shared types only the server router
  // exposes. ml-types is re-exported by packages/shared/src/index.ts,
  // so we patch the barrel after this.
  removeIfExists(join(outputDir, "packages/server"));
  removeIfExists(join(outputDir, "packages/shared/src/ml-types.ts"));
  modifications.push("client-only: removed packages/server/ and packages/shared/src/ml-types.ts");

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
  modifications.push("client-only: removed auth/tRPC routes, providers, libs, hooks");

  // app/layout.tsx still imports the providers we just deleted and
  // wraps children in them. Rewrite to a minimal layout that just
  // renders {children} (analytics + mobile bridge stay — neither
  // depends on the server).
  rewriteClientLayoutForClientOnly(outputDir);

  // app/page.tsx links to /login and /signup, both gone now. Replace
  // it with a static "Get started" stub. The user is meant to replace
  // this with their own marketing content anyway.
  rewriteLandingForClientOnly(outputDir);

  // packages/client/package.json: drop the deps we no longer use. The
  // client still keeps Next.js, React, Sentry, OpenPanel, Tailwind,
  // class-variance-authority, etc.
  stripPackageJsonDeps(join(outputDir, "packages/client"), [
    "@trpc/client",
    "@trpc/react-query",
    "@tanstack/react-query",
    "better-auth",
  ]);
  modifications.push("client-only: pruned @trpc/* + better-auth from packages/client/package.json");

  // Strip server-oriented services from compose. The starter's compose
  // has `server`, `client`, `mongo`, `redis` plus a `mongo-data`
  // volume. For client-only we keep just `client`.
  for (const rel of ["docker-compose.yml", "docker-compose.dev.yml"]) {
    const p = join(outputDir, rel);
    if (existsSync(p)) {
      rewriteFile(p, (c) => stripComposeServices(c, ["server", "mongo", "redis"]));
      rewriteFile(p, removeMongoDataVolume);
    }
  }
  modifications.push("client-only: removed server/mongo/redis from docker-compose");

  // docs-site doubles as the starter's marketing docs. It's a separate
  // app and not particularly useful in a client-only scaffold; drop it
  // so the workspace stays minimal.
  removeIfExists(join(outputDir, "docs-site"));
  removeIfExists(join(outputDir, "e2e"));
  removeIfExists(join(outputDir, "playwright.config.ts"));
  removeIfExists(join(outputDir, "seed"));
  dropWorkspaceEntry(outputDir, "docs-site");

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
  modifications.push("client-only: rewrote root package.json scripts");
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

/** Remove the top-level `volumes:` block + its `mongo-data:` entry. Used
 *  after stripping the mongo service so the compose doesn't reference
 *  an orphaned volume. The starter only declares one volume, so we
 *  drop the whole block; if a future starter adds more, this'll need
 *  to become entry-aware. */
function removeMongoDataVolume(content: string): string {
  return content.replace(/\nvolumes:\s*\n\s+mongo-data:\s*\n?/m, "\n");
}

// ── shared helpers ─────────────────────────────────────────────────────

function dropWorkspaceEntry(outputDir: string, name: string): void {
  const path = join(outputDir, "pnpm-workspace.yaml");
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  const next = content.replace(new RegExp(`^\\s*-\\s*"${name}"\\s*\\n`, "m"), "");
  if (next !== content) writeFileSync(path, next, "utf-8");
}

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
 *  this surface keep a server?" without duplicating the string check. */
export function surfaceHasServer(surface: Surface): boolean {
  return surface !== "client-only";
}

/** Same for the client half. */
export function surfaceHasClient(surface: Surface): boolean {
  return surface !== "server-only";
}
