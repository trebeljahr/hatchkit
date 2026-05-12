/*
 * scaffoldApp orchestrator.
 *
 * Responsibilities in order:
 *   1. Validate preconditions (starter submodule present, target empty).
 *   2. Copy the starter template to `outputDir` (fs cpSync with filter).
 *   3. Customize the copy: project name, env files, feature flag strip,
 *      bundle IDs, port assignment + propagation, ML playground prune,
 *      next.config for static export when native is selected.
 *   4. Roll back (rm output dir + unregister reserved ports) if any
 *      step after the copy throws.
 *
 * The actual file-rewriting logic lives in starter-files.ts and
 * pkg-json.ts; this file is the control flow.
 */

import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { addUsedPorts, getUsedPorts, removeUsedPorts } from "../config.js";
import type { MlService, ProjectConfig } from "../prompts.js";
import { explainFsError } from "../utils/errors.js";
import { type ProjectPorts, pickProjectPorts } from "../utils/ports.js";
import { getCliVersion } from "../utils/version.js";
import { type DotenvxSeedResult, seedDotenvxProduction } from "./dotenvx.js";
import { MANIFEST_FILENAME, toManifest, writeManifest } from "./manifest.js";
import {
  setPackageJsonDescription,
  stripPackageJsonBuildBlock,
  stripPackageJsonDeps,
  stripPackageJsonScripts,
  unchainTypecheckScript,
} from "./pkg-json.js";
import {
  applyPorts,
  applyProjectName,
  flipNextConfigToStaticExport,
  removeIfExists,
  replaceInFile,
  stripMobileBridgeFromLayout,
  updateEnvExample,
} from "./starter-files.js";
import { pruneToSurface } from "./surfaces.js";

// Monorepo root → starter submodule
const MONOREPO_ROOT = resolve(join(import.meta.dirname, "..", "..", ".."));
const STARTER_ROOT = join(MONOREPO_ROOT, "starter");

export interface ScaffoldResult {
  modifications: string[];
  ports: ProjectPorts;
  /** Populated by seedDotenvxProduction on real (non-dry-run) scaffolds.
   *  The private key is also mirrored into the OS keychain. */
  dotenvx?: DotenvxSeedResult;
  /** Populated when the project opted into Tailscale-served local-dev
   *  (config.localDev was set). The caller uses `slug` to record the
   *  ledger step so `hatchkit destroy` cleans up the Caddy fragment. */
  localDev?: { slug: string };
}

/** Scaffold a new app by copying the starter template and customizing it. */
export async function scaffoldApp(
  config: ProjectConfig,
  outputDir: string,
): Promise<ScaffoldResult> {
  if (config.dryRun) {
    return {
      modifications: scaffoldDryRun(config, outputDir),
      // Dry-run still picks ports so the summary is accurate, but
      // doesn't persist them.
      ports: await pickProjectPorts(getUsedPorts(), {
        nativeHmr: config.features.includes("desktop") || config.features.includes("mobile"),
      }),
    };
  }

  if (!existsSync(STARTER_ROOT)) {
    throw new Error(
      `Starter template not found at ${STARTER_ROOT}. Your hatchkit checkout looks incomplete — re-clone or pull the latest main.`,
    );
  }

  // Bail if the target already exists — without this, cpSync silently
  // merges new files into whatever is there, mixing old and new state.
  if (existsSync(outputDir)) {
    const entries = readdirSync(outputDir);
    if (entries.length > 0) {
      // If the target looks like a previously-scaffolded project,
      // nudge the user toward `update` instead of a hard fail.
      const hasManifest = entries.includes(MANIFEST_FILENAME);
      const hint = hasManifest
        ? ` This looks like a previously-scaffolded project (${MANIFEST_FILENAME} is present). Try \`hatchkit update\` from inside it to add features.`
        : "";
      throw new Error(
        `Output directory ${outputDir} already exists and is not empty. Move or remove it first.${hint}`,
      );
    }
  }

  // Resolve symlinks — if the submodule path is itself a symlink (tests,
  // local dev linking to a sibling checkout), cpSync would otherwise try
  // to recreate the symlink at outputDir and fail with EEXIST.
  const resolvedStarter = realpathSync(STARTER_ROOT);

  // Track claimed resources so a mid-scaffold failure can be rolled
  // back: filesystem + port registrations.
  const reservedPorts: number[] = [];
  const rollback = (): void => {
    if (existsSync(outputDir)) {
      try {
        rmSync(outputDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    if (reservedPorts.length > 0) {
      try {
        removeUsedPorts(reservedPorts);
      } catch {
        /* ignore */
      }
    }
  };

  const copyStart = Date.now();
  const copySpinner = ora(`Copying starter from ${resolvedStarter}`).start();
  try {
    cpSync(resolvedStarter, outputDir, {
      recursive: true,
      filter: (src) => {
        const rel = src.replace(resolvedStarter, "");
        if (rel === "/.git" || rel.startsWith("/.git/")) return false;
        if (rel.includes("/node_modules")) return false;
        if (rel.includes("/.next")) return false;
        if (rel.includes("/dist/")) return false;
        return true;
      },
    });
    copySpinner.succeed(`Starter copied (${elapsed(copyStart)})`);
  } catch (err) {
    copySpinner.fail("Starter copy failed");
    rollback();
    throw new Error(explainFsError(err, "Failed to copy starter template"));
  }

  const customizeStart = Date.now();
  const customizeSpinner = ora("Customizing for your project").start();
  try {
    const result = await runScaffoldSteps(config, outputDir, reservedPorts);
    customizeSpinner.succeed(
      `Scaffolded ${result.modifications.length} modifications (${elapsed(customizeStart)})`,
    );
    return result;
  } catch (err) {
    customizeSpinner.fail("Customization failed");
    rollback();
    throw err;
  }
}

/** Format ms-since-start as a compact "123ms" or "1.4s". */
function elapsed(startMs: number): string {
  const ms = Date.now() - startMs;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Customize the starter copy. Mutates `reservedPorts` in place so the
 *  outer orchestrator can unregister them on failure. */
async function runScaffoldSteps(
  config: ProjectConfig,
  outputDir: string,
  reservedPorts: number[],
): Promise<ScaffoldResult> {
  const modifications: string[] = [];

  // Rename the project in package.json
  replaceInFile(join(outputDir, "package.json"), "node-realtime-starter", config.name);
  modifications.push("package.json (renamed project)");

  // Stamp the user-supplied description onto package.json. Empty/unset
  // input deletes the field (the starter's package.json doesn't have
  // one to begin with) so we don't ship an empty string through to
  // any future `npm publish`.
  if (config.description !== undefined) {
    setPackageJsonDescription(outputDir, config.description);
    if (config.description.trim()) {
      modifications.push("package.json (set description)");
    }
  }

  // Project-name substitution for local-infra identifiers — gives each
  // scaffolded project its own dev Mongo DB / MinIO bucket / E2E
  // isolation. Without this, two projects on one machine collide on
  // the same `starter-dev` bucket and `starter-dev` Mongo database.
  applyProjectName(outputDir, config.name);
  modifications.push("renamed local-infra identifiers (Mongo DB / MinIO bucket / E2E names)");

  // .env.example files: production URLs for this project's domain.
  // .env.development is left alone (local dev defaults should stay pointing at localhost).
  updateEnvExample(outputDir, "packages/server/.env.example", config);
  updateEnvExample(outputDir, "packages/client/.env.example", config);
  modifications.push("updated .env.example files with production URLs");

  // Feature-flag removal
  if (!config.features.includes("websocket")) {
    removeIfExists(join(outputDir, "packages/server/src/ws"));
    modifications.push("removed: ws/ (WebSocket not selected)");
  }
  if (!config.features.includes("stripe")) {
    removeIfExists(join(outputDir, "packages/server/src/services/stripe.ts"));
    modifications.push("removed: stripe service (Stripe not selected)");
  }

  const wantsDesktop = config.features.includes("desktop");
  const wantsMobile = config.features.includes("mobile");
  const bundleId = config.name.replace(/[^a-z0-9]/gi, "").toLowerCase();

  // Port assignment — tested-free via isPortFree + persisted into the
  // CLI registry so subsequent scaffolds can't collide.
  const ports = await pickProjectPorts(getUsedPorts(), {
    nativeHmr: wantsDesktop || wantsMobile,
  });
  const claimed = [ports.server, ports.client, ports.nativeHmr].filter(
    (p): p is number => p !== undefined,
  );
  addUsedPorts(claimed);
  reservedPorts.push(...claimed);
  applyPorts(outputDir, ports, { wantsDesktop, wantsMobile });
  modifications.push(
    `assigned ports: server=${ports.server} client=${ports.client}` +
      (ports.nativeHmr ? ` native=${ports.nativeHmr}` : ""),
  );

  // Desktop (Electron) strip / substitute
  if (!wantsDesktop) {
    removeIfExists(join(outputDir, "electron"));
    removeIfExists(join(outputDir, ".github/workflows/desktop-release.yml"));
    removeIfExists(join(outputDir, "build"));
    removeIfExists(join(outputDir, "packages/client/src/types/electron.d.ts"));
    stripPackageJsonScripts(outputDir, [
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
    ]);
    unchainTypecheckScript(outputDir);
    stripPackageJsonBuildBlock(outputDir);
    stripPackageJsonDeps(outputDir, ["electron", "electron-builder", "icon-gen", "wait-on"]);
    modifications.push("removed: desktop (Electron) scaffolding");
  } else {
    replaceInFile(join(outputDir, "package.json"), "{{projectName}}", config.name);
    replaceInFile(join(outputDir, "package.json"), "{{bundleId}}", bundleId);
  }

  // Mobile (Capacitor) strip / substitute
  if (!wantsMobile) {
    removeIfExists(join(outputDir, "ios"));
    removeIfExists(join(outputDir, "android"));
    removeIfExists(join(outputDir, "capacitor.config.ts"));
    removeIfExists(join(outputDir, "packages/client/src/mobile"));
    removeIfExists(join(outputDir, "scripts/android-dev.sh"));
    removeIfExists(join(outputDir, "scripts/android-env.sh"));
    removeIfExists(join(outputDir, "scripts/ios-dev.sh"));
    removeIfExists(join(outputDir, ".github/workflows/mobile-release.yml"));
    removeIfExists(join(outputDir, "resources"));
    stripMobileBridgeFromLayout(outputDir);
    stripPackageJsonScripts(outputDir, [
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
    stripPackageJsonDeps(outputDir, [
      "@capacitor/core",
      "@capacitor/cli",
      "@capacitor/ios",
      "@capacitor/android",
      "@capacitor/splash-screen",
      "@capacitor/status-bar",
      "@capacitor/screen-orientation",
      "@capacitor/preferences",
      "@capacitor/app",
      "@capacitor/assets",
    ]);
    modifications.push("removed: mobile (Capacitor) scaffolding");
  } else {
    replaceInFile(join(outputDir, "capacitor.config.ts"), "{{projectName}}", config.name);
    replaceInFile(join(outputDir, "capacitor.config.ts"), "{{bundleId}}", bundleId);
  }

  if (wantsDesktop || wantsMobile) {
    flipNextConfigToStaticExport(outputDir);
    modifications.push("next.config.ts: output 'standalone' → 'export'");
  }

  // ML playground prune — remove unselected service pages.
  const allMlServices: MlService[] = [
    "background-removal",
    "subtitles",
    "image-recognition",
    "3d-extraction",
    "3d-sam-objects",
    "3d-sam-body",
    "3d-hunyuan",
    "3d-trellis",
  ];
  for (const service of allMlServices) {
    if (!config.mlServices.includes(service)) {
      removeIfExists(join(outputDir, `packages/client/src/app/(protected)/playground/${service}`));
      modifications.push(`removed: playground/${service} (not selected)`);
    }
  }

  // No ML services at all → remove the entire playground + infrastructure.
  if (config.mlServices.length === 0) {
    removeIfExists(join(outputDir, "packages/client/src/app/(protected)/playground"));
    removeIfExists(join(outputDir, "packages/client/src/components/ml"));
    removeIfExists(join(outputDir, "packages/server/src/trpc/routers/ml.ts"));
    removeIfExists(join(outputDir, "packages/server/src/services/ml.ts"));
    removeIfExists(join(outputDir, "packages/shared/src/ml-types.ts"));

    // Strip ml router from the tRPC router registration.
    const routerPath = join(outputDir, "packages/server/src/trpc/router.ts");
    if (existsSync(routerPath)) {
      let content = readFileSync(routerPath, "utf-8");
      content = content.replace('import { mlRouter } from "./routers/ml.js";\n', "");
      content = content.replace("  ml: mlRouter,\n", "");
      writeFileSync(routerPath, content, "utf-8");
    }

    // Strip ml-types export from shared barrel.
    const sharedIndexPath = join(outputDir, "packages/shared/src/index.ts");
    if (existsSync(sharedIndexPath)) {
      let content = readFileSync(sharedIndexPath, "utf-8");
      content = content.replace('export * from "./ml-types.js";\n', "");
      writeFileSync(sharedIndexPath, content, "utf-8");
    }

    // Strip Playground from protected navbar.
    const layoutPath = join(outputDir, "packages/client/src/app/(protected)/layout.tsx");
    if (existsSync(layoutPath)) {
      let content = readFileSync(layoutPath, "utf-8");
      content = content.replace(/\s*<Link\s+href="\/playground"[^>]*>[^<]*<\/Link>/, "");
      writeFileSync(layoutPath, content, "utf-8");
    }

    modifications.push("removed: ML playground, ML router, ML types, ML navbar link");
  }

  // Surface-aware prune. Runs LAST among the file-mutation steps so the
  // feature-flag work above (which uses `removeIfExists`) doesn't fight
  // it — anything the prune wipes was either already gone or was a
  // safe no-op write. See scaffold/surfaces.ts for the per-surface
  // semantics.
  pruneToSurface(config, outputDir, modifications);

  // Write the sanitized manifest so `hatchkit update` can diff
  // against this scaffold's choices later. See manifest.ts for the
  // strict list of fields that are safe to persist.
  writeManifest(outputDir, toManifest(config, ports, getCliVersion()));
  modifications.push(".hatchkit.json (project manifest)");

  // Seed .env.production via dotenvx: encrypt supplied values, mint a
  // keypair, mirror the private key into the OS keychain. Unsupplied
  // keys land as plaintext CHANGE_ME_<KEY> placeholders.
  //
  // Client-only scaffolds skip this entirely — dotenvx targets
  // packages/server/.env.production, which doesn't exist post-prune.
  // Client env vars are NEXT_PUBLIC_* (baked at build time + public by
  // design) so there's nothing to encrypt anyway.
  let dotenvx: DotenvxSeedResult | undefined;
  if (config.surfaces !== "client-only") {
    dotenvx = await seedDotenvxProduction(outputDir, config, config.envValues ?? {});
    modifications.push(
      `dotenvx: ${dotenvx.encryptedKeys.length} encrypted, ${dotenvx.placeholderKeys.length} placeholders`,
    );
  } else {
    modifications.push("client-only: skipped dotenvx seeding (no server-side secrets)");
  }

  // Tailscale-served local-dev opt-in. The host plumbing is the user's
  // own one-time setup (`hatchkit dev-setup init`); here we just write
  // the per-project pieces: the Caddy fragment at the client dev port
  // (or server port for server-only surfaces), docs/dev-setup.md, the
  // next.config wrapper, and the @hatchkit/dev-plugin-next dep. None of
  // this is required for the project to function — the dev plugin
  // gracefully no-ops when the host bridge isn't active.
  let localDev: { slug: string } | undefined;
  if (config.localDev) {
    const devPort = config.surfaces === "server-only" ? ports.server : ports.client;
    const { enableProjectLocalDev } = await import("../dev-setup.js");
    const result = await enableProjectLocalDev({
      projectDir: outputDir,
      slug: config.localDev.slug,
      devPort,
    });
    localDev = { slug: config.localDev.slug };
    modifications.push(
      `local-dev: fragment ${result.wroteFragment}, docs ${result.wroteDocs ? "wrote" : "unchanged"}, next.config ${result.patchedNextConfig}, package.json ${result.patchedPackageJson}`,
    );
  }

  return { modifications, ports, dotenvx, localDev };
}

/** Dry run — list what would happen without touching disk. */
function scaffoldDryRun(config: ProjectConfig, outputDir: string): string[] {
  console.log(chalk.bold("\n  [dry-run] Would scaffold from starter template:\n"));
  console.log(chalk.dim(`    Source: ${STARTER_ROOT}`));
  console.log(chalk.dim(`    Target: ${outputDir}`));
  console.log();

  const actions: string[] = [];
  actions.push("Copy starter template");
  actions.push(`Rename project to "${config.name}"`);
  if (config.description?.trim()) {
    actions.push(`Set package.json description to "${config.description.trim()}"`);
  }
  actions.push(`Set domain to "${config.domain}"`);
  if (config.surfaces === "server-only") {
    actions.push(
      "Prune to server-only (remove packages/client, native scaffolds, client compose service)",
    );
  } else if (config.surfaces === "client-only") {
    actions.push(
      "Prune to client-only (remove packages/server, auth/tRPC routes, server/mongo/redis compose services)",
    );
  }

  if (!config.features.includes("websocket")) actions.push("Remove WebSocket support");
  if (!config.features.includes("stripe")) actions.push("Remove Stripe integration");
  if (!config.features.includes("desktop")) actions.push("Remove desktop (Electron) scaffolding");
  if (!config.features.includes("mobile")) actions.push("Remove mobile (Capacitor) scaffolding");
  if (config.features.includes("desktop") || config.features.includes("mobile")) {
    actions.push("Flip next.config.ts to output: 'export' (static)");
  }
  if (config.mlServices.length === 0) {
    actions.push("Remove ML playground, router, types");
  } else {
    const removed = [
      "background-removal",
      "subtitles",
      "image-recognition",
      "3d-extraction",
      "3d-sam-objects",
      "3d-sam-body",
      "3d-hunyuan",
      "3d-trellis",
    ].filter((s) => !config.mlServices.includes(s as MlService));
    if (removed.length > 0) {
      actions.push(`Remove unused ML pages: ${removed.join(", ")}`);
    }
  }

  for (const action of actions) {
    console.log(chalk.dim(`    - ${action}`));
  }

  return actions;
}
