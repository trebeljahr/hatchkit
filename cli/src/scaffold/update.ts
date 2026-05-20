/*
 * `hatchkit update` — add feature scaffolding to an already-scaffolded
 * project.
 *
 * Scope of this MVP:
 *   • Read the .hatchkit.json manifest in cwd.
 *   • Prompt for a new feature set (defaulting to the current one).
 *   • REFUSE to remove features — that risks deleting user code built
 *     on top of them. Removal stays a manual operation.
 *   • For each newly-added feature, copy the starter's feature files
 *     into the project and merge package.json edits.
 *   • Refresh the manifest.
 *
 * Currently supported additions: `desktop`, `mobile`.
 * `websocket` / `stripe` / `analytics` / `s3` additions are flagged
 * as "manual" — the scaffold-time strip for those is coarse-grained
 * and re-adding them cleanly would need per-feature merge logic that
 * doesn't exist yet. Users can cherry-pick files from the starter.
 */

import { cpSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { addUsedPorts, getUsedPorts } from "../config.js";
import type { Feature } from "../prompts.js";
import { multiselect } from "../utils/multiselect.js";
import { PORT_RANGES, pickPort } from "../utils/ports.js";
import { getCliVersion } from "../utils/version.js";
import {
  MANIFEST_FILENAME,
  type ProjectManifest,
  readManifest,
  writeManifest,
} from "./manifest.js";
import { setPackageJsonScript } from "./pkg-json.js";
import { applyPorts, rewriteFile } from "./starter-files.js";

// Same derivation as scaffold/app.ts — STARTER_ROOT lives next to the
// monorepo root, two hops up from this file's compiled location.
const MONOREPO_ROOT = resolve(join(import.meta.dirname, "..", "..", ".."));
const STARTER_ROOT = join(MONOREPO_ROOT, "starter");

/** Features that `update` knows how to layer onto an existing project. */
const SUPPORTED_ADDITIONS: readonly Feature[] = ["desktop", "mobile"];

export interface UpdateResult {
  added: Feature[];
  skipped: Feature[];
  removed: Feature[];
  /** Populated when this `update` run opted the project into the
   *  Tailscale-served local-dev integration. Distinct from a project
   *  that was already opted in — the latter shows up as `undefined`
   *  here. */
  localDevEnabled?: { slug: string; domain?: string };
}

export interface UpdateOptions {
  /** Skip every prompt and use the supplied answers. Used by the test
   *  suite to exercise the headless path without monkey-patching ESM
   *  read-only exports of @inquirer/prompts. Real CLI calls pass
   *  undefined; the interactive prompts then run. */
  presets?: {
    desiredFeatures?: Feature[];
    confirmAddFeatures?: boolean;
    enableLocalDev?: boolean;
    localDevSlug?: string;
  };
}

export async function runUpdate(
  projectDir: string,
  options: UpdateOptions = {},
): Promise<UpdateResult> {
  const manifest = readManifest(projectDir);
  if (!manifest) {
    throw new Error(
      `No ${MANIFEST_FILENAME} found in ${projectDir}. This directory wasn't scaffolded by hatchkit, or the manifest was deleted.`,
    );
  }

  if (!existsSync(STARTER_ROOT)) {
    throw new Error(
      `Starter template not found at ${STARTER_ROOT}. Your hatchkit checkout looks incomplete — re-clone or pull the latest main.`,
    );
  }

  console.log(chalk.bold(`\n  ── Update: ${manifest.name} ─────────────────────────────\n`));
  console.log(chalk.dim(`  Current features: ${manifest.features.join(", ") || "(none)"}`));
  console.log(chalk.dim(`  Supported additions: ${SUPPORTED_ADDITIONS.join(", ")}`));

  const allOptions: Feature[] = ["websocket", "stripe", "analytics", "s3", "desktop", "mobile"];
  const desired =
    options.presets?.desiredFeatures ??
    (await multiselect<Feature>({
      message: "Desired feature set (current pre-selected):",
      choices: allOptions.map((f) => ({
        name:
          SUPPORTED_ADDITIONS.includes(f) || manifest.features.includes(f)
            ? f
            : `${f} (manual add only — use the starter repo directly)`,
        value: f,
        checked: manifest.features.includes(f),
        disabled: !manifest.features.includes(f) && !SUPPORTED_ADDITIONS.includes(f),
      })),
    }));

  // Local-dev opt-in offer. Projects scaffolded before this integration
  // landed have no `manifest.localDev`; surface the choice here so
  // `hatchkit update` becomes the canonical retrofit path. Anyone who's
  // already opted in (or who'd rather wire it by hand via
  // `hatchkit dev-setup enable`) just declines once and never sees the
  // prompt again — the next update run skips it because manifest.localDev
  // is now set.
  let localDevEnabled: { slug: string; domain?: string } | undefined;
  if (!manifest.localDev) {
    const { localDevDomainFromProjectDomain, localDevUrl, sanitiseSlug } = await import(
      "@hatchkit/dev-shared"
    );
    const localDevDomain = localDevDomainFromProjectDomain(manifest.domain) ?? undefined;
    const offerLocalDev =
      options.presets?.enableLocalDev ??
      (await confirm({
        message: `Enable Tailscale dev URL for this project (${localDevUrl("<slug>", localDevDomain)})?`,
        default: true,
      }));
    if (offerLocalDev) {
      const defaultSlug = sanitiseSlug(manifest.name);
      let slugInput: string;
      if (options.presets?.localDevSlug !== undefined) {
        slugInput = options.presets.localDevSlug || defaultSlug;
      } else {
        const { input } = await import("@inquirer/prompts");
        slugInput = await input({
          message: "Slug (subdomain):",
          default: defaultSlug,
          validate: (v) => {
            const s = sanitiseSlug(v);
            if (s.length === 0) return "Slug must contain at least one [a-z0-9-] character.";
            if (s !== v) return `Use only [a-z0-9-]. Did you mean "${s}"?`;
            return true;
          },
        });
      }
      localDevEnabled = { slug: sanitiseSlug(slugInput), domain: localDevDomain };
    }
  }

  const current = new Set(manifest.features);
  const next = new Set(desired);
  const added: Feature[] = [...next].filter((f) => !current.has(f));
  const removed: Feature[] = [...current].filter((f) => !next.has(f));

  if (removed.length > 0) {
    console.log(
      chalk.yellow(
        `\n  Refusing to remove features: ${removed.join(", ")}. Removing features risks deleting user code. Remove manually + update the manifest.`,
      ),
    );
  }

  // The feature-add work runs only if there's something to add AND the
  // user confirms. The local-dev opt-in is independent — we apply it
  // even when the rest of the update is a no-op (this is the canonical
  // retrofit path for pre-existing projects). `skippedAdditions` carries
  // the declined-add list so the result still reports it.
  let actuallyAdded: Feature[] = [];
  let skippedAdditions: Feature[] = [];
  const updatedFeatures = new Set(manifest.features);
  let updatedPorts = manifest.ports;

  if (added.length > 0) {
    const ok =
      options.presets?.confirmAddFeatures ??
      (await confirm({
        message: `Add ${added.join(", ")} to ${manifest.name}?`,
        default: true,
      }));
    if (ok) {
      const resolvedStarter = realpathSync(STARTER_ROOT);
      for (const feature of added) {
        if (feature === "desktop") {
          await addDesktop(projectDir, resolvedStarter, manifest);
          updatedFeatures.add("desktop");
        } else if (feature === "mobile") {
          await addMobile(projectDir, resolvedStarter, manifest);
          updatedFeatures.add("mobile");
        }
      }
      actuallyAdded = added;

      // Pick a nativeHmr port if the project didn't have one and now needs one.
      const needsNative = updatedFeatures.has("desktop") || updatedFeatures.has("mobile");
      if (needsNative && updatedPorts.nativeHmr === undefined) {
        const used = new Set(getUsedPorts());
        const nativeHmr = await pickPort(PORT_RANGES.nativeHmr[0], PORT_RANGES.nativeHmr[1], used);
        addUsedPorts([nativeHmr]);
        updatedPorts = { ...updatedPorts, nativeHmr };
        applyPorts(projectDir, updatedPorts, {
          wantsDesktop: updatedFeatures.has("desktop"),
          wantsMobile: updatedFeatures.has("mobile"),
        });
        console.log(chalk.dim(`  Assigned native HMR port: ${nativeHmr}`));
      }
    } else {
      skippedAdditions = added;
    }
  } else {
    console.log(chalk.dim("\n  No new features to add."));
  }

  // Apply local-dev opt-in (if user said yes earlier). Calls the same
  // surface scaffold uses, so the on-disk shape (Caddy fragment, docs,
  // next.config wrap, package.json dep) is identical regardless of
  // whether the project picked it up at scaffold or via this retrofit.
  if (localDevEnabled) {
    const devPort = manifest.surfaces === "backend" ? manifest.ports.server : manifest.ports.client;
    const { enableProjectLocalDev } = await import("../dev-setup.js");
    const { localDevUrl } = await import("@hatchkit/dev-shared");
    await enableProjectLocalDev({
      projectDir,
      slug: localDevEnabled.slug,
      localDevDomain: localDevEnabled.domain,
      devPort,
    });
    console.log(
      chalk.green(
        `\n  ✓ Tailscale dev URL enabled: ${localDevUrl(localDevEnabled.slug, localDevEnabled.domain)}`,
      ),
    );
  }

  // Skip the manifest write only if NOTHING changed (no features added,
  // no local-dev opt-in) — keeps the file mtime stable for the no-op
  // case so update-then-doctor doesn't re-read a touched-but-identical
  // manifest.
  if (actuallyAdded.length > 0 || localDevEnabled) {
    const updatedManifest: ProjectManifest = {
      ...manifest,
      version: manifest.version,
      cliVersion: getCliVersion(),
      scaffoldedAt: manifest.scaffoldedAt,
      features: [...updatedFeatures] as Feature[],
      ports: updatedPorts,
      localDev: localDevEnabled ?? manifest.localDev,
    };
    writeManifest(projectDir, updatedManifest);
  }

  return { added: actuallyAdded, skipped: skippedAdditions, removed, localDevEnabled };
}

/** Copy desktop scaffolding from the starter + apply project-name
 *  substitutions. Assumes the feature isn't already present. */
async function addDesktop(
  projectDir: string,
  resolvedStarter: string,
  manifest: ProjectManifest,
): Promise<void> {
  console.log(chalk.dim("\n  Adding desktop (Electron)..."));
  copyFromStarter(resolvedStarter, projectDir, "electron");
  copyFromStarter(resolvedStarter, projectDir, "build");
  copyFromStarter(resolvedStarter, projectDir, "packages/client/src/types/electron.d.ts");
  copyFromStarter(resolvedStarter, projectDir, ".github/workflows/desktop-release.yml");

  // Merge package.json: pick up desktop scripts + build block + deps.
  const starterPkg = readJson(join(resolvedStarter, "package.json"));
  const projectPkgPath = join(projectDir, "package.json");
  const projectPkg = readJson(projectPkgPath);
  const bundleId = manifest.name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const DESKTOP_SCRIPTS = [
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
  ];
  const DESKTOP_DEPS = ["electron", "electron-builder", "icon-gen", "wait-on"];

  projectPkg.scripts = projectPkg.scripts ?? {};
  for (const name of DESKTOP_SCRIPTS) {
    if (starterPkg.scripts?.[name]) projectPkg.scripts[name] = starterPkg.scripts[name];
  }

  projectPkg.devDependencies = projectPkg.devDependencies ?? {};
  for (const name of DESKTOP_DEPS) {
    if (starterPkg.devDependencies?.[name]) {
      projectPkg.devDependencies[name] = starterPkg.devDependencies[name];
    }
  }

  // electron-builder `build` block — only adopt it if the project
  // doesn't already have one the user may have edited.
  if (!projectPkg.build && starterPkg.build) {
    projectPkg.build = JSON.parse(
      JSON.stringify(starterPkg.build)
        .replaceAll("{{bundleId}}", bundleId)
        .replaceAll("{{projectName}}", manifest.name),
    );
  }

  writeFileSync(projectPkgPath, JSON.stringify(projectPkg, null, 2) + "\n", "utf-8");

  // Chain electron typecheck into the root `typecheck` if present
  // and not already chained.
  if (
    projectPkg.scripts.typecheck &&
    !projectPkg.scripts.typecheck.includes("typecheck:electron")
  ) {
    setPackageJsonScript(
      projectDir,
      "typecheck",
      `${projectPkg.scripts.typecheck} && pnpm typecheck:electron`,
    );
  }
}

/** Copy mobile (Capacitor) scaffolding + wire MobileBridgeLoader
 *  into the client layout. Assumes the feature isn't already present. */
async function addMobile(
  projectDir: string,
  resolvedStarter: string,
  manifest: ProjectManifest,
): Promise<void> {
  console.log(chalk.dim("\n  Adding mobile (Capacitor)..."));
  copyFromStarter(resolvedStarter, projectDir, "capacitor.config.ts");
  copyFromStarter(resolvedStarter, projectDir, "packages/client/src/mobile");
  copyFromStarter(resolvedStarter, projectDir, "resources");
  copyFromStarter(resolvedStarter, projectDir, "scripts/android-dev.sh");
  copyFromStarter(resolvedStarter, projectDir, "scripts/android-env.sh");
  copyFromStarter(resolvedStarter, projectDir, "scripts/ios-dev.sh");
  copyFromStarter(resolvedStarter, projectDir, ".github/workflows/mobile-release.yml");

  // Substitute project identifiers into capacitor.config.ts.
  const capPath = join(projectDir, "capacitor.config.ts");
  const bundleId = manifest.name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  rewriteFile(capPath, (c) =>
    c.replaceAll("{{projectName}}", manifest.name).replaceAll("{{bundleId}}", bundleId),
  );

  // Merge package.json scripts + deps.
  const starterPkg = readJson(join(resolvedStarter, "package.json"));
  const projectPkgPath = join(projectDir, "package.json");
  const projectPkg = readJson(projectPkgPath);
  const MOBILE_SCRIPTS = [
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
  const MOBILE_DEPS = [
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
  ];

  projectPkg.scripts = projectPkg.scripts ?? {};
  for (const name of MOBILE_SCRIPTS) {
    if (starterPkg.scripts?.[name]) projectPkg.scripts[name] = starterPkg.scripts[name];
  }

  projectPkg.dependencies = projectPkg.dependencies ?? {};
  projectPkg.devDependencies = projectPkg.devDependencies ?? {};
  for (const name of MOBILE_DEPS) {
    if (starterPkg.dependencies?.[name]) {
      projectPkg.dependencies[name] = starterPkg.dependencies[name];
    } else if (starterPkg.devDependencies?.[name]) {
      projectPkg.devDependencies[name] = starterPkg.devDependencies[name];
    }
  }

  writeFileSync(projectPkgPath, JSON.stringify(projectPkg, null, 2) + "\n", "utf-8");

  // Wire MobileBridgeLoader into the client layout if not already there.
  const layoutPath = join(projectDir, "packages/client/src/app/layout.tsx");
  if (existsSync(layoutPath)) {
    let content = readFileSync(layoutPath, "utf-8");
    if (!content.includes("MobileBridgeLoader")) {
      // Insert the import + mount in well-known positions.
      content = content.replace(
        /(import[^\n]+"@\/styles\/globals\.css";\n)/,
        `$1import { MobileBridgeLoader } from "@/mobile/MobileBridgeLoader";\n`,
      );
      content = content.replace(/(<body[^>]*>)\s*/, `$1\n        <MobileBridgeLoader />\n        `);
      writeFileSync(layoutPath, content, "utf-8");
    }
  }
}

function copyFromStarter(starter: string, outputDir: string, rel: string): void {
  const src = join(starter, rel);
  const dst = join(outputDir, rel);
  if (!existsSync(src)) return;
  if (existsSync(dst)) {
    // Already present — skip to avoid clobbering user edits.
    return;
  }
  cpSync(src, dst, { recursive: true });
}

function readJson(path: string): Record<string, unknown> & {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  build?: unknown;
} {
  return JSON.parse(readFileSync(path, "utf-8"));
}
