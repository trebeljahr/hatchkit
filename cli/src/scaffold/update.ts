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
import { pushNativeOriginsForProject } from "../deploy/trusted-origins.js";
import type { AuthSecurityOption } from "../features/auth-account-security/types.js";
import type { Feature } from "../prompts.js";
import { multiselect } from "../utils/multiselect.js";
import { PORT_RANGES, pickPort } from "../utils/ports.js";
import { getCliVersion } from "../utils/version.js";
import {
  CLIENT_DOCKERFILE_REL_PATH,
  CLIENT_WORKFLOW_REL_PATH,
  stripComposeClientRuntimeNextPublic,
  upgradeClientDockerfile,
  upgradeWorkflowClientBuildArgs,
} from "./client-build-args.js";
import {
  DEPLOY_WORKFLOW_REL_PATH,
  deployVerificationRetrofits,
  upgradeWorkflowNativeOriginCheck,
} from "./deploy-verification.js";
import {
  type ProjectIdentifiers,
  legacyIdentifiers,
  substituteIdentifierTokens,
} from "./identifiers.js";
import {
  MANIFEST_FILENAME,
  type ProjectManifest,
  findManifestDirUpward,
  readManifestWithMigrationInfo,
  writeManifest,
} from "./manifest.js";
import { hasNativeClient } from "./native-origins.js";
import { inferGhOwner, substituteComposeImageRefs } from "./owner.js";
import { setPackageJsonScript } from "./pkg-json.js";
import { applyPorts, rewriteFile } from "./starter-files.js";

// Same derivation as scaffold/app.ts — STARTER_ROOT lives next to the
// monorepo root, two hops up from this file's compiled location.
const MONOREPO_ROOT = resolve(join(import.meta.dirname, "..", "..", ".."));
const STARTER_ROOT = join(MONOREPO_ROOT, "starter");

/** The project's frozen identifier set.
 *
 *  `update` never derives one: the values it writes into a newly-added
 *  wrapper must be the SAME values the original scaffold wrote, or the
 *  project ends up with an Electron bundle id and a Capacitor bundle id
 *  that differ — which builds fine and is rejected at store upload.
 *
 *  A manifest read through `readManifestWithMigrationInfo` always has
 *  the block (the v4 → v5 migration seeds it). The fallback covers a
 *  manifest object constructed in a test or by a caller that bypassed
 *  the reader. */
function identifiersFor(manifest: ProjectManifest): ProjectIdentifiers {
  return manifest.identifiers ?? legacyIdentifiers(manifest.name);
}

/** Features that `update` knows how to layer onto an existing project. */
const SUPPORTED_ADDITIONS: readonly Feature[] = [
  "workspaces",
  "desktop",
  "mobile",
  "release",
  // Purely additive: it writes new files, patches the auth wiring
  // idempotently, and never removes anything. That is what makes it safe
  // to layer onto a project that has been running for months.
  "auth-account-security",
];

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
    /** Account-security sub-options for a headless run. Undefined means
     *  the interactive multiselect runs (or, in a preset run, the
     *  documented defaults apply). */
    authSecurityOptions?: string[];
    /** Check TRUSTED_ORIGINS on Coolify after a native feature is added.
     *  Preset runs skip it unless this is true, so a headless test can
     *  never reach a real Coolify through the user's keychain. */
    pushNativeOrigins?: boolean;
  };
}

export async function runUpdate(
  invokedDir: string,
  options: UpdateOptions = {},
): Promise<UpdateResult> {
  // Walk up so users running `hatchkit update` from inside a
  // sub-folder of a subdir-deployed project find the repo-root
  // manifest. Single-package-at-root projects resolve to the same
  // dir for both manifest and the deployable — the historical case.
  // For subdir-deployed projects manifestDir is the repo root and
  // projectDir is `<manifestDir>/<manifest.projectSubdir>`, so
  // feature additions land inside the deployable while the manifest
  // itself is read + rewritten at the repo root.
  //
  // Read with migration info so a stale on-disk schema (e.g. a v3
  // manifest that predates `topology`) can be persisted below even when
  // no feature was added. Otherwise `hatchkit doctor`'s "run hatchkit
  // update" hint would be a no-op on an otherwise up-to-date project.
  const manifestDir = findManifestDirUpward(invokedDir) ?? invokedDir;
  const manifestRead = readManifestWithMigrationInfo(manifestDir);
  if (manifestRead?.migrated) {
    for (const note of manifestRead.migrationNotes) console.log(`  ${note}`);
  }
  const manifest = manifestRead?.manifest ?? null;
  if (!manifest) {
    throw new Error(
      `No ${MANIFEST_FILENAME} found in ${invokedDir} (or any parent). This directory wasn't scaffolded by hatchkit, or the manifest was deleted.`,
    );
  }
  const projectDir = manifest.projectSubdir
    ? join(manifestDir, manifest.projectSubdir)
    : manifestDir;

  if (!existsSync(STARTER_ROOT)) {
    throw new Error(
      `Starter template not found at ${STARTER_ROOT}. Your hatchkit checkout looks incomplete — re-clone or pull the latest main.`,
    );
  }

  console.log(chalk.bold(`\n  ── Update: ${manifest.name} ─────────────────────────────\n`));
  console.log(chalk.dim(`  Current features: ${manifest.features.join(", ") || "(none)"}`));
  console.log(chalk.dim(`  Supported additions: ${SUPPORTED_ADDITIONS.join(", ")}`));

  // Retrofit docker-compose.yml image refs for projects scaffolded
  // before the OWNER/REPO substitution landed in scaffoldApp. Idempotent
  // — only touches the file when the literal `OWNER/REPO` placeholder is
  // still present, so projects that already have a real owner/repo (or
  // any hand-edited image ref) are left alone. No flag, no opt-in: the
  // bug shipped as a broken Coolify default, and the only path to a
  // working first deploy is fixing the placeholder.
  const ghOwner = await inferGhOwner({ projectDir });
  const composeSub = substituteComposeImageRefs(projectDir, ghOwner, manifest.name);
  if (composeSub.written) {
    console.log(
      ghOwner
        ? chalk.green(
            `  ✓ docker-compose.yml: image refs → ghcr.io/${ghOwner}/${manifest.name}-{server,client}:main`,
          )
        : chalk.yellow(
            `  ↻ docker-compose.yml: substituted REPO=${manifest.name} (owner unresolved; left literal OWNER)`,
          ),
    );
    if (!ghOwner) {
      console.log(
        chalk.yellow(
          "  ⚠ Couldn't infer GitHub owner — edit `image: ghcr.io/OWNER/...`\n" +
            "    in docker-compose.yml before pushing.",
        ),
      );
    }
  }

  // Retrofit the client image's NEXT_PUBLIC_* build-arg wiring for
  // projects scaffolded before it landed. Next.js inlines NEXT_PUBLIC_*
  // at BUILD time; older scaffolds supplied them only as runtime env on
  // the deployed container, which baked the localhost fallback into the
  // shipped browser bundle (production auth silently pointed every
  // visitor at their own machine). Same no-flag rationale as the
  // OWNER/REPO retrofit above. Idempotent — all three transforms no-op
  // once the files carry the current shape.
  const buildArgRetrofits: Array<[rel: string, fn: (c: string) => string]> = [
    [CLIENT_DOCKERFILE_REL_PATH, upgradeClientDockerfile],
    [
      CLIENT_WORKFLOW_REL_PATH,
      (c) => upgradeWorkflowClientBuildArgs(c, manifest.domain, manifest.topology),
    ],
    ["docker-compose.yml", stripComposeClientRuntimeNextPublic],
  ];
  let buildArgsRetrofitted = false;
  for (const [rel, fn] of buildArgRetrofits) {
    const path = join(projectDir, rel);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, "utf-8");
    const after = fn(before);
    if (after !== before) {
      writeFileSync(path, after, "utf-8");
      buildArgsRetrofitted = true;
      console.log(chalk.green(`  ✓ ${rel}: client NEXT_PUBLIC_* build-arg wiring updated`));
    }
  }
  if (buildArgsRetrofitted) {
    console.log(
      chalk.yellow(
        "  ⚠ Commit + push so CI rebuilds the client image — NEXT_PUBLIC_* values\n" +
          "    are baked into the browser bundle at image build time.",
      ),
    );
  }

  // Retrofit the post-deploy verification gate for projects scaffolded
  // before it landed. Until it existed the pipeline's final assertion
  // was an HTTP 200 from a deploy POST, so a stale container, an image
  // built with an empty API URL, and a crash-looping server all reported
  // success. Same no-flag rationale as the two retrofits above: the
  // failure is silent, and every one of those shipped green.
  let verificationRetrofitted = false;
  for (const [label, rel, fn] of deployVerificationRetrofits(
    manifest.domain,
    manifest.topology,
    manifest.surfaces,
    manifest.features,
  )) {
    const path = join(projectDir, rel);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, "utf-8");
    const after = fn(before);
    if (after !== before) {
      writeFileSync(path, after, "utf-8");
      verificationRetrofitted = true;
      console.log(chalk.green(`  ✓ ${label}: deploy verification wired`));
    }
  }
  if (verificationRetrofitted) {
    console.log(
      chalk.dim(
        "    The deploy job now polls /api/health and /version.json for the pushed\n" +
          "    commit and fails the run when they disagree.",
      ),
    );
  }

  const allOptions: Feature[] = [
    "websocket",
    "stripe",
    "analytics",
    "s3",
    "workspaces",
    "desktop",
    "mobile",
    "release",
    "auth-account-security",
  ];
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
  let authSecurityOptions: string[] | undefined;
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
        if (feature === "workspaces") {
          await addWorkspaces(projectDir, manifest);
          updatedFeatures.add("workspaces");
        } else if (feature === "desktop") {
          await addDesktop(projectDir, resolvedStarter, manifest);
          updatedFeatures.add("desktop");
        } else if (feature === "mobile") {
          await addMobile(projectDir, resolvedStarter, manifest);
          updatedFeatures.add("mobile");
        } else if (feature === "release") {
          await addRelease(projectDir, manifestDir, manifest, [...updatedFeatures, ...added]);
          updatedFeatures.add("release");
        } else if (feature === "auth-account-security") {
          authSecurityOptions = await addAuthAccountSecurity(projectDir, manifest, {
            presetOptions: options.presets?.authSecurityOptions,
          });
          updatedFeatures.add("auth-account-security");
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

  // A project that already had `release` and gained a surface in this
  // run needs its channels re-derived — the whole point of the feature
  // is that it knows which surfaces the project has. Re-running is safe
  // (see features/release/writer.ts), so this needs no confirmation.
  if (
    updatedFeatures.has("release") &&
    !actuallyAdded.includes("release") &&
    actuallyAdded.length > 0
  ) {
    await addRelease(projectDir, manifestDir, manifest, [...updatedFeatures]);
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
  if (actuallyAdded.length > 0 || localDevEnabled || manifestRead?.migrated) {
    const updatedManifest: ProjectManifest = {
      ...manifest,
      version: manifest.version,
      cliVersion: getCliVersion(),
      scaffoldedAt: manifest.scaffoldedAt,
      features: [...updatedFeatures] as Feature[],
      ports: updatedPorts,
      localDev: localDevEnabled ?? manifest.localDev,
      authSecurity: authSecurityOptions ? { options: authSecurityOptions } : manifest.authSecurity,
    };
    writeManifest(manifestDir, updatedManifest);
  }

  // A native shell added here loads the client from its own origin, and
  // the deployed server answers its sign-in with 403 INVALID_ORIGIN until
  // TRUSTED_ORIGINS on the server's Coolify app names it. The files above
  // don't carry that anywhere production reads, so offer the same merge
  // `hatchkit sync` does: diff, confirm, write, read back, and a redeploy
  // notice. Skipped (with the command to run later) when the project
  // isn't on Coolify yet.
  const addedNative = actuallyAdded.filter((f) => hasNativeClient([f]));
  if (addedNative.length > 0) {
    const features = [...updatedFeatures];
    setWorkflowNativeOriginsIn(projectDir, features);
    if (options.presets === undefined || options.presets.pushNativeOrigins === true) {
      try {
        await pushNativeOriginsForProject({
          projectDir,
          manifest: { ...manifest, features },
        });
      } catch (err) {
        console.log(
          chalk.yellow(`\n  Couldn't check TRUSTED_ORIGINS on Coolify: ${(err as Error).message}`),
        );
        console.log(
          chalk.dim(
            "  Run `hatchkit sync --dry-run` to see the diff, then `hatchkit sync --deploy`.",
          ),
        );
      }
    }
  }

  // SES Custom MAIL FROM retrofit. Pre-existing projects (provisioned
  // before this feature shipped) reach here with `manifest.email`
  // already pointing at `listmonk-ses` for at least one need but with
  // no `manifest.ses.mailFromDomain` recorded. Running setup here is
  // idempotent + adopt-safe, so the no-op case is cheap.
  if (projectUsesListmonkSes(manifest) && !manifest.ses?.mailFromDomain) {
    try {
      const { runSesMailFromSetup } = await import("../email/ses-mail-from.js");
      console.log(
        chalk.bold(
          "\n  Retrofit: SES Custom MAIL FROM Domain — improves Gmail mailed-by header + DMARC SPF alignment.",
        ),
      );
      console.log(
        chalk.dim(
          "  Existing sends keep working. Only NEW sends — after DNS propagates — see the custom MAIL FROM.",
        ),
      );
      await runSesMailFromSetup({ noWait: false }, projectDir);
    } catch (err) {
      console.log(chalk.yellow(`\n  Could not configure SES MAIL FROM: ${(err as Error).message}`));
      console.log(
        chalk.dim(
          "  Re-run `hatchkit email ses-mail-from setup` after fixing the underlying issue.",
        ),
      );
    }
  }

  return {
    added: actuallyAdded,
    skipped: skippedAdditions,
    removed,
    localDevEnabled,
  };
}

/** Apply the `release` feature through the feature contract.
 *
 *  Safe to call on a project that already has it: every write goes
 *  through {@link FeatureLedger}, which compares before it writes, so a
 *  re-run on an unchanged project reports nothing as written. That is
 *  what lets this also run when some OTHER feature was added — the
 *  release config has to be re-derived then, because the whole point of
 *  the feature is that it knows which surfaces the project has.
 *
 *  `features` is passed in rather than read from the manifest because
 *  the manifest is not written until later in the run, and re-deriving
 *  channels from a stale feature list would miss the surface that was
 *  just added. */
async function addRelease(
  projectDir: string,
  manifestDir: string,
  manifest: ProjectManifest,
  features: readonly Feature[],
): Promise<void> {
  console.log(chalk.dim("\n  Adding release coordination..."));
  const { FeatureLedger } = await import("../features/contract.js");
  const { releaseFeature, configFor, releaseAudit } = await import("../features/release/index.js");

  const ledger = new FeatureLedger(projectDir, false);
  ledger.scopeTo("release");
  const ctx = {
    projectDir,
    manifestDir,
    manifest: { ...manifest, features: [...features] as Feature[] },
    identifiers: identifiersFor(manifest),
    mode: "update" as const,
    ledger,
    log: (message: string) => console.log(chalk.dim(message)),
  };

  await releaseFeature.apply(ctx);

  const audit = releaseAudit(ctx, configFor(ctx));
  for (const file of audit.written) console.log(chalk.green(`    \u2713 ${file}`));
  for (const conflict of audit.conflicts) {
    console.log(chalk.yellow(`    \u21bb ${conflict}`));
  }
  for (const note of audit.manualResidue) console.log(chalk.dim(`    \u2022 ${note}`));
}

/** True when the project's recorded email intent points at the
 *  Listmonk + SES stack — the only path Hatchkit knows that needs the
 *  custom MAIL FROM. Used by `runUpdate` to gate the retrofit step. */
function projectUsesListmonkSes(manifest: ProjectManifest): boolean {
  const e = manifest.email;
  if (!e) return false;
  return e.transactional === "listmonk-ses" || e.mailingList === "listmonk-ses";
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
  const identifiers = identifiersFor(manifest);
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
      substituteIdentifierTokens(JSON.stringify(starterPkg.build), identifiers),
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
  rewriteFile(capPath, (c) => substituteIdentifierTokens(c, identifiersFor(manifest)));

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

/**
 * Layer the `workspaces` feature (tenants, members, roles, invitations)
 * onto an existing project.
 *
 * Unlike the native wrappers above, this one copies nothing out of
 * `starter/`: the feature is purely additive, so its source lives under
 * cli/src/templates/workspaces/ and is rendered straight into the
 * project by the same `applyWorkspacesFeature` the create path calls.
 * One code path means `create --features workspaces` and `update` cannot
 * produce different projects.
 */
async function addWorkspaces(projectDir: string, manifest: ProjectManifest): Promise<void> {
  const { applyWorkspacesFeature, detectTargets } = await import("../features/workspaces/index.js");
  const targets = detectTargets(projectDir, manifest.features);
  const result = applyWorkspacesFeature({
    projectDir,
    projectName: manifest.name,
    targets,
  });

  console.log(chalk.dim(`  workspaces: ${result.written.length} file(s) written`));
  for (const file of result.patched) {
    console.log(chalk.dim(`  workspaces: wired ${file}`));
  }
  for (const note of result.notes) {
    console.log(chalk.dim(`  workspaces: ${note}`));
  }
  for (const step of result.nextSteps) {
    console.log(chalk.yellow(`  workspaces: ${step}`));
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

/** Point the deploy workflow's native-origin sign-in check at the
 *  project's current feature set, inserting the step when a native
 *  feature was just added to a workflow that predates it. */
function setWorkflowNativeOriginsIn(projectDir: string, features: readonly string[]): void {
  const path = join(projectDir, DEPLOY_WORKFLOW_REL_PATH);
  rewriteFile(path, (c) => {
    const after = upgradeWorkflowNativeOriginCheck(c, features);
    if (after !== c) {
      console.log(
        chalk.green("  ✓ deploy workflow: native-client sign-in check targets the new origins"),
      );
    }
    return after;
  });
}

/**
 * Layer the account-security feature onto an existing project.
 *
 * Unlike the native-wrapper additions above, this one does not copy a
 * directory from the starter — the starter's better-auth instance
 * registers no plugins, so there is nothing there to copy. The feature
 * owns its own templates and patches the auth wiring in place, which is
 * why it is safe to run against a project that has been live for months:
 * files that already exist are skipped rather than overwritten, and every
 * patch detects its own previous output.
 *
 * Returns the sub-options that ended up switched on, so `runUpdate` can
 * record them in the manifest.
 */
async function addAuthAccountSecurity(
  projectDir: string,
  manifest: ProjectManifest,
  opts: { presetOptions?: string[] } = {},
): Promise<string[]> {
  console.log(chalk.dim("\n  Adding account security..."));

  const {
    AUTH_SECURITY_OPTIONS,
    AUTH_SECURITY_DEFAULT_OPTIONS,
    AUTH_SECURITY_SPECS,
    applyAuthAccountSecurity,
  } = await import("../features/auth-account-security/index.js");

  // Anything already recorded stays on: this path adds, it never removes.
  const already = new Set(manifest.authSecurity?.options ?? []);

  let chosen: string[];
  if (opts.presetOptions !== undefined) {
    chosen = opts.presetOptions;
  } else {
    chosen = await multiselect<string>({
      message: "Account security — which parts?",
      choices: AUTH_SECURITY_OPTIONS.map((option) => {
        const spec = AUTH_SECURITY_SPECS[option];
        // Say up front which methods a native shell cannot finish. The
        // symptom otherwise is a form on the device that accepts input
        // and then fails with nothing useful in any log.
        const shell =
          spec.tokenShell === "no"
            ? " [web only]"
            : spec.tokenShell === "partial"
              ? " [needs extra shell work]"
              : "";
        const mail = spec.needsEmail ? " [needs a mail transport]" : "";
        return {
          name: `${spec.label}${shell}${mail}`,
          value: option as string,
          checked:
            already.has(option) ||
            (already.size === 0 &&
              (AUTH_SECURITY_DEFAULT_OPTIONS as readonly string[]).includes(option)),
        };
      }),
    });
  }

  const selected = [...new Set([...already, ...chosen])] as AuthSecurityOption[];

  const audit = await applyAuthAccountSecurity({
    projectDir,
    // The frozen identifier set rather than the raw project name: this
    // becomes the TOTP issuer, which is the label an authenticator app
    // shows forever after somebody enrols.
    projectName: identifiersFor(manifest).productName,
    options: selected,
    hasNativeClient: hasNativeClient(manifest.features),
    hasEmailTransport:
      manifest.email?.transactional === "listmonk-ses" ||
      manifest.email?.mailingList === "listmonk-ses",
    domain: manifest.domain,
  });

  for (const warning of audit.warnings) console.log(chalk.yellow(`  ⚠ ${warning}`));
  if (audit.written.length > 0) {
    console.log(chalk.green(`  ✓ wrote ${audit.written.length} file(s)`));
  }
  if (audit.skipped.length > 0) {
    console.log(chalk.dim(`    ${audit.skipped.length} file(s) already present — left alone`));
  }
  if (audit.rewritten.length > 0) {
    console.log(chalk.green(`  ✓ patched ${audit.rewritten.length} existing file(s)`));
  }
  for (const step of audit.manualResidue) console.log(chalk.yellow(`  → ${step}`));
  console.log(chalk.dim("    See docs/account-security.md in the project."));

  return audit.options;
}
