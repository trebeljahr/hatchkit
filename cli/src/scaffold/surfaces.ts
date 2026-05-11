/*
 * Surface-aware pruning for `hatchkit create`.
 *
 * The full-stack starter ships with packages/{server,client,shared} plus
 * a multi-service docker-compose. When the user picks a narrower surface
 * (server-only / client-only) we strip the unused half AFTER the copy:
 *
 *   · server-only — remove packages/client + client-side top-level
 *     scaffolding (Next.js / Electron / Capacitor / e2e), strip the
 *     `client` service from docker-compose.yml, rewrite the root
 *     package.json scripts to drop client/test/e2e/native targets.
 *     Clean by construction: the server has zero `@starter/client`
 *     imports.
 *
 *   · client-only — currently NOT supported. The starter's client
 *     depends on the server's tRPC AppRouter, Better Auth, and the
 *     entire (protected) route group. Stripping that out cleanly is
 *     a separate piece of work (likely a dedicated client-only starter
 *     rather than surgery on the full-stack one). The prompt is still
 *     plumbed end-to-end so the manifest captures the intent and the
 *     downstream Coolify wiring is surface-aware — only the actual
 *     prune step throws.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig, Surface } from "../prompts.js";
import { setPackageJsonScript, stripPackageJsonScripts } from "./pkg-json.js";
import { removeIfExists, rewriteFile } from "./starter-files.js";

/** Apply surface-aware pruning to a freshly-copied starter. Mutates
 *  `modifications` in place so the orchestrator's spinner summary
 *  reflects what changed. Throws if the surface can't be honoured (e.g.
 *  client-only — see file header). */
export function pruneToSurface(
  config: ProjectConfig,
  outputDir: string,
  modifications: string[],
): void {
  if (config.surfaces === "both") return;

  if (config.surfaces === "client-only") {
    throw new Error(
      "client-only scaffolding isn't supported in `hatchkit create` yet.\n" +
        "  The full-stack starter's client depends on the server's tRPC AppRouter,\n" +
        "  Better Auth, and the (protected) route group — stripping those cleanly is\n" +
        "  out of scope for the in-place pruner. Options:\n" +
        "    · Scaffold with `both`, then remove the server half yourself.\n" +
        "    · Scaffold an empty Next.js app and run `hatchkit adopt` on it.",
    );
  }

  // ── server-only ─────────────────────────────────────────────────────
  pruneToServerOnly(outputDir, modifications);
}

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
  for (const rel of [
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
  ]) {
    removeIfExists(join(outputDir, rel));
  }
  modifications.push("server-only: removed client-side top-level scaffolding");

  // Strip the `client` service from docker-compose.yml. Keep `server`,
  // `mongo`, `redis`, and the `mongo-data` volume — the server still
  // needs all three.
  const composePath = join(outputDir, "docker-compose.yml");
  if (existsSync(composePath)) {
    rewriteFile(composePath, stripClientServiceFromCompose);
    modifications.push("server-only: removed client service from docker-compose.yml");
  }

  // Same surgery on the dev compose if present.
  const devComposePath = join(outputDir, "docker-compose.dev.yml");
  if (existsSync(devComposePath)) {
    rewriteFile(devComposePath, stripClientServiceFromCompose);
  }

  // Drop docs-site from the pnpm workspace so `pnpm install` doesn't
  // try to link a directory we just deleted.
  const workspacePath = join(outputDir, "pnpm-workspace.yaml");
  if (existsSync(workspacePath)) {
    const content = readFileSync(workspacePath, "utf-8");
    const next = content.replace(/^\s*-\s*"docs-site"\s*\n/m, "");
    if (next !== content) writeFileSync(workspacePath, next, "utf-8");
  }

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
  ]);
  // Reset the orchestrator scripts to the server-only equivalents. The
  // monorepo build still goes through `@starter/shared` first because
  // the server imports types from it.
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

/** Strip the top-level `client:` service block from a Compose document.
 *  Looks for a `client:` line at the typical 2-space indent under
 *  `services:` and removes through the next sibling key (any line that
 *  starts with the same indent and a non-space first char). Falls back
 *  to a no-op if the structure doesn't match. */
function stripClientServiceFromCompose(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Match exactly two-space indent + `client:` — that's the only
    // service-key indent the starter uses.
    if (/^ {2}client:\s*$/.test(line)) {
      // Skip through every line indented further than 2 spaces (the
      // service body). Stop when we hit a line that's either empty or
      // back at the 2-space sibling indent.
      i += 1;
      while (i < lines.length) {
        const body = lines[i];
        if (body === "") {
          // Drop trailing blank line that belonged to the block, but
          // only if the next non-empty line is a sibling key — otherwise
          // we'd swallow the separator before `volumes:`.
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

/** Tiny export so callers (tests, future surface kinds) can ask "does
 *  this surface keep a server?" without duplicating the string check. */
export function surfaceHasServer(surface: Surface): boolean {
  return surface !== "client-only";
}

/** Same for the client half. */
export function surfaceHasClient(surface: Surface): boolean {
  return surface !== "server-only";
}
