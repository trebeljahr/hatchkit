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
 * Every write here is ADDITIVE. A file the project already has is never
 * overwritten, and neither is a root-package.json script or a dependency pin
 * it has changed away from the starter's shape. What was declined is
 * reported; `--force` replaces the package.json pieces (never files) with the
 * starter's current versions.
 *
 * Currently supported additions: `desktop`, `mobile`.
 * `websocket` / `stripe` / `analytics` / `s3` additions are flagged
 * as "manual" — the scaffold-time strip for those is coarse-grained
 * and re-adding them cleanly would need per-feature merge logic that
 * doesn't exist yet. Users can cherry-pick files from the starter.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  DESKTOP_DEV_DEPS,
  DESKTOP_FILES,
  DESKTOP_SCRIPTS,
  substituteDesktopFiles,
} from "./desktop.js";
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
import {
  MOBILE_DEPS,
  MOBILE_PATHS,
  MOBILE_SCRIPTS,
  NATIVE_GENERATED_TRACKED,
  NATIVE_GENERATED_UNTRACKED,
} from "./mobile-feature.js";
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
  "client-core",
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
  /** Overwrite root-package.json scripts and dependency pins that the
   *  project has changed away from the starter's, instead of keeping them.
   *  Off by default: those are the commands a shipping app owns. Files are
   *  never overwritten, with or without this. */
  force?: boolean;
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
    "client-core",
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
  /** What the mobile refresh below actually wrote, if anything. Feeds the
   *  "did this run change the project?" decision at the end, so a pure
   *  refresh still persists the manifest's cliVersion. */
  let mobileRefreshed: string[] = [];
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
          await addWorkspaces(projectDir, manifestDir, manifest);
          updatedFeatures.add("workspaces");
        } else if (feature === "desktop") {
          await addDesktop(projectDir, resolvedStarter, manifest, options.force === true);
          updatedFeatures.add("desktop");
        } else if (feature === "mobile") {
          console.log(chalk.dim("\n  Adding mobile (Capacitor)..."));
          await ensureMobile(projectDir, resolvedStarter, manifest);
          updatedFeatures.add("mobile");
        } else if (feature === "release") {
          await addRelease(projectDir, manifestDir, manifest, [...updatedFeatures, ...added]);
          updatedFeatures.add("release");
        } else if (feature === "auth-account-security") {
          authSecurityOptions = await addAuthAccountSecurity(projectDir, manifest, {
            presetOptions: options.presets?.authSecurityOptions,
          });
          updatedFeatures.add("auth-account-security");
        } else if (feature === "client-core") {
          await addRegisteredFeature("client-core", projectDir, manifestDir, manifest);
          updatedFeatures.add("client-core");
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
        const keptByPorts = applyPorts(projectDir, updatedPorts, {
          wantsDesktop: updatedFeatures.has("desktop"),
          wantsMobile: updatedFeatures.has("mobile"),
          force: options.force === true,
        });
        console.log(chalk.dim(`  Assigned native HMR port: ${nativeHmr}`));
        for (const note of keptByPorts) reportKept(note);
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

  // Refresh a mobile feature the project ALREADY has.
  //
  // This is the only path that reaches an existing Capacitor project. The
  // block above adds FEATURES, and `mobile` is already in the manifest, so
  // nothing there fires — yet a project scaffolded before
  // scripts/build-mobile.mjs, the storage tiers or the native stylesheets
  // existed is missing all of them, permanently. Unconditional, like the
  // docker-compose image-ref and deploy-workflow retrofits above, and for
  // the same reason: the gap shipped, and there is no opt-in that fixes it.
  //
  // Additive and idempotent — a file that exists is never overwritten, so
  // a project whose owner has edited the bridge keeps their version and
  // still gains the files they were missing.
  if (updatedFeatures.has("mobile") && !actuallyAdded.includes("mobile")) {
    const resolvedStarter = realpathSync(STARTER_ROOT);
    const refreshed = await ensureMobile(projectDir, resolvedStarter, manifest);
    if (refreshed.length > 0) {
      mobileRefreshed = refreshed;
      console.log(chalk.green("\n  ✓ mobile (Capacitor) brought up to date:"));
      for (const change of refreshed) console.log(chalk.dim(`      · ${change}`));
    }
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
  if (
    actuallyAdded.length > 0 ||
    mobileRefreshed.length > 0 ||
    localDevEnabled ||
    manifestRead?.migrated
  ) {
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
  force = false,
): Promise<void> {
  console.log(chalk.dim("\n  Adding desktop (Electron)..."));
  // One list, shared with the scaffold's strip branch (scaffold/desktop.ts),
  // so a file added to the starter reaches `hatchkit update` too. It used to
  // reach only a fresh `hatchkit create`, and the gap showed up as a build
  // that failed on somebody else's machine.
  for (const rel of DESKTOP_FILES) copyFromStarter(resolvedStarter, projectDir, rel);
  copyFromStarter(resolvedStarter, projectDir, "build");

  // The manifest's frozen identifiers, never a fresh derivation: the profile
  // directory, the env-var prefix and the bundle id are contracts the moment
  // anything is stored or published, so an older project keeps the names it
  // already has (scaffold/identifiers.ts).
  const identifiers = identifiersFor(manifest);
  substituteDesktopFiles(projectDir, identifiers);

  // Merge package.json: pick up the desktop scripts and dev dependencies.
  const starterPkg = readJson(join(resolvedStarter, "package.json"));
  const projectPkgPath = join(projectDir, "package.json");
  const projectPkg = readJson(projectPkgPath);

  // Additive, like the file copy above: a script or a pin the project already
  // defines is left alone. `update` runs against repos that have shipped, and
  // a desktop app that grew its own build step, watcher or Electron major is
  // the normal case rather than the exception — the starter's command line
  // replacing it breaks the next `pnpm build:desktop` with nothing left to
  // diff. What is missing still lands, which is the point of the merge.
  // `--force` takes the starter's versions.
  mergeStarterScripts(projectPkg, starterPkg, DESKTOP_SCRIPTS, { force, label: "desktop" });
  mergeStarterDeps(projectPkg, starterPkg, DESKTOP_DEV_DEPS, { force });

  writeFileSync(projectPkgPath, JSON.stringify(projectPkg, null, 2) + "\n", "utf-8");

  // The electron-builder configuration is `electron-builder.config.mjs`, and
  // `scripts/build-desktop.mjs` passes it with an explicit `--config`. A
  // project scaffolded before that file existed also carries a `build` block in
  // its package.json, which the build no longer reads. Left unmentioned it is
  // the worst kind of stale config: someone edits the icon or the targets
  // there and the packaged app does not change. It is not removed here — it
  // may have been hand-edited, and that is the owner's to move.
  if (projectPkg.build) {
    console.log(chalk.yellow("\n  This project still has a `build` block in package.json."));
    console.log(
      chalk.dim(
        "    electron-builder now reads electron-builder.config.mjs, which the build\n" +
          "    passes with --config, so that block is ignored. Move anything you changed\n" +
          "    in it into the new file, then delete it.",
      ),
    );
  }

  console.log(
    chalk.dim(
      `    Profile directory "${identifiers.slug}", origin ` +
        `${identifiers.desktopOrigin.scheme}://${identifiers.desktopOrigin.host} and the ` +
        `${identifiers.envPrefix}_* environment\n` +
        "    variables are part of this app's contract from the first release: they key\n" +
        "    local storage, the single-instance lock and the server's TRUSTED_ORIGINS.",
    ),
  );

  // Chain electron typecheck into the root `typecheck` if present and not
  // already chained. Gated on the electron script existing too: a project
  // that keeps its own electron typecheck out of package.json must not end up
  // with a root `typecheck` that calls a script nothing defines.
  const rootTypecheck = projectPkg.scripts?.typecheck;
  if (
    rootTypecheck &&
    projectPkg.scripts?.["typecheck:electron"] &&
    !rootTypecheck.includes("typecheck:electron")
  ) {
    setPackageJsonScript(projectDir, "typecheck", `${rootTypecheck} && pnpm typecheck:electron`);
  }
}

/**
 * Add a feature that is registered in `features/contract.ts`.
 *
 * The registry is where every new feature goes (docs/feature-authoring.md), and
 * this is the seam that lets one live beside the three hand-written `add*`
 * helpers below rather than waiting for all of them to be converted. The ledger
 * is what makes it worth doing: the feature never asks whether this is a dry
 * run, and re-applying it on a project that already has it writes nothing —
 * `update` re-applies every selected feature on every run, so a feature that is
 * not idempotent corrupts the project a little more each time.
 */
async function addRegisteredFeature(
  feature: Feature,
  projectDir: string,
  manifestDir: string,
  manifest: ProjectManifest,
): Promise<void> {
  const { FeatureLedger, applyFeatures } = await import("../features/contract.js");
  // Importing the module is what registers it.
  await import("../features/client-core/index.js");
  const ledger = new FeatureLedger(projectDir, false);
  await applyFeatures([feature], {
    projectDir,
    manifestDir,
    manifest,
    identifiers: identifiersFor(manifest),
    mode: "update",
    ledger,
    log: (message) => console.log(chalk.dim(message)),
  });
  const summary = ledger.summary();
  if (summary.written.length > 0) {
    console.log(chalk.green(`  ✓ wrote ${summary.written.length} file(s)`));
  }
}

/** Bring the mobile (Capacitor) feature up to date in a project, and wire
 *  the three things that live in files the feature does not own: the
 *  bridge loader and the pre-paint root marker in the client layout, and
 *  the two stylesheet imports in globals.css.
 *
 *  Called on the way IN, when `mobile` is newly added, and again on every
 *  later `hatchkit update` of a project that already has it. The second
 *  call is the one that matters in practice: a project scaffolded before
 *  scripts/build-mobile.mjs existed has `packages/client/src/mobile` and
 *  no `scripts/lib/`, and there is no other path that would ever complete
 *  it — `update` adds FEATURES, and mobile is already in the manifest. A
 *  half-upgraded project is worse than either end: globals.css imports a
 *  stylesheet that is not there, and the layout imports a module that is
 *  not there.
 *
 *  So every step is idempotent and additive: a file that already exists is
 *  never overwritten, and each wiring edit is a no-op when already
 *  present. Returns what actually changed, so a run that changed nothing
 *  can stay silent. */
async function ensureMobile(
  projectDir: string,
  resolvedStarter: string,
  manifest: ProjectManifest,
): Promise<string[]> {
  const changes: string[] = [];

  // MOBILE_PATHS is the single manifest of what the feature consists of —
  // the same list scaffold/app.ts strips. The two must never disagree, or
  // a file reaches new scaffolds and no updated project, or the reverse.
  // `ios` / `android` are skipped: they are generated per machine by
  // `pnpm cap:add:*` and then committed, so the starter has no copy to
  // hand over.
  for (const rel of MOBILE_PATHS) {
    if (rel === "ios" || rel === "android") continue;
    if (copyFromStarter(resolvedStarter, projectDir, rel) > 0) changes.push(rel);
  }

  // Substitute project identifiers into capacitor.config.ts.
  //
  // Only here, and only on the way in. Once `cap add` has run, the native
  // trees hold their own copies of the identifier and `cap sync` never
  // revisits them — so a LATER rename has to go through
  // `hatchkit rename-project`, which rewrites the native trees too, and
  // scripts/build-mobile.mjs fails the build when the two disagree.
  const capPath = join(projectDir, "capacitor.config.ts");
  rewriteFile(capPath, (c) => {
    const out = substituteIdentifierTokens(c, identifiersFor(manifest));
    if (out !== c) changes.push("capacitor.config.ts identifiers");
    return out;
  });

  // Merge package.json scripts + deps from the starter, so the versions
  // and command lines can only ever come from one place.
  const starterPkg = readJson(join(resolvedStarter, "package.json"));
  const projectPkgPath = join(projectDir, "package.json");
  const projectPkg = readJson(projectPkgPath);
  const pkgBefore = JSON.stringify(projectPkg);

  projectPkg.scripts = projectPkg.scripts ?? {};
  for (const name of MOBILE_SCRIPTS) {
    if (starterPkg.scripts?.[name]) projectPkg.scripts[name] = starterPkg.scripts[name];
  }
  // A project scaffolded before build-mobile.mjs existed has
  // `"cap:sync": "cap sync"`. The starter no longer defines it, so the
  // merge above cannot overwrite it — and a bare `cap sync` skips the API
  // URL check, the chunk assertion, the identifier drift check and the
  // dev-server guard, while still producing an app that installs. Remove
  // it outright.
  if (!starterPkg.scripts?.["cap:sync"]) delete projectPkg.scripts["cap:sync"];

  projectPkg.dependencies = projectPkg.dependencies ?? {};
  projectPkg.devDependencies = projectPkg.devDependencies ?? {};
  for (const name of MOBILE_DEPS) {
    if (starterPkg.dependencies?.[name]) {
      projectPkg.dependencies[name] = starterPkg.dependencies[name];
    } else if (starterPkg.devDependencies?.[name]) {
      projectPkg.devDependencies[name] = starterPkg.devDependencies[name];
    }
  }

  if (JSON.stringify(projectPkg) !== pkgBefore) {
    writeFileSync(projectPkgPath, JSON.stringify(projectPkg, null, 2) + "\n", "utf-8");
    changes.push("package.json scripts + dependencies");
  }

  if (wireMobileIntoLayout(projectDir)) changes.push("client layout (bridge loader, root marker)");
  if (wireNativeStylesIntoGlobals(projectDir)) changes.push("globals.css stylesheet imports");
  if (ignoreNativeGeneratedPaths(projectDir)) changes.push(".gitignore native-tree holes");
  return changes;
}

/** Add the bridge loader and the pre-paint root marker to the client
 *  layout. Both are inserted only when absent, so a hand-edited layout
 *  that already mounts them is left alone. */
function wireMobileIntoLayout(projectDir: string): boolean {
  const layoutPath = join(projectDir, "packages/client/src/app/layout.tsx");
  if (!existsSync(layoutPath)) return false;
  let content = readFileSync(layoutPath, "utf-8");
  const before = content;

  if (!content.includes("MobileBridgeLoader")) {
    content = content.replace(
      /(import[^\n]+"@\/styles\/globals\.css";\n)/,
      `$1import { MobileBridgeLoader } from "@/mobile/MobileBridgeLoader";\n`,
    );
    content = content.replace(/(<body[^>]*>)\s*/, `$1\n        <MobileBridgeLoader />\n        `);
  }

  // The pre-paint marker. It sets `html.cap` before the first paint, which
  // is what matters on a WebView reload — there is no splash screen to
  // hide the unpadded frame. It goes on <html>, never <body>: a pre-paint
  // script that mutates <body> makes the served HTML and the hydrated DOM
  // disagree about body's attributes, and the only way to silence that is
  // `suppressHydrationWarning` on <body>, which then silences every other
  // body-level mismatch for the web app forever.
  if (!content.includes("ROOT_MARKER_SCRIPT")) {
    content = content.replace(
      /(import[^\n]+"@\/styles\/globals\.css";\n)/,
      `import { ROOT_MARKER_SCRIPT } from "@/mobile/platform";\n$1`,
    );
    if (/<head>/.test(content)) {
      content = content.replace(
        /(<head>)\s*\n/,
        `$1\n        <script dangerouslySetInnerHTML={{ __html: ROOT_MARKER_SCRIPT }} />\n`,
      );
    } else {
      // No <head> to hang it on. Say so rather than silently shipping a
      // layout whose native padding lands one frame late on every reload.
      console.log(
        chalk.yellow(
          "  ! layout.tsx has no <head> — add the ROOT_MARKER_SCRIPT <script> tag by hand\n" +
            "    (see starter/packages/client/src/app/layout.tsx). Without it the app paints\n" +
            "    one unpadded frame on every WebView reload.",
        ),
      );
    }
  }

  if (content === before) return false;
  writeFileSync(layoutPath, content, "utf-8");
  return true;
}

/**
 * Layer the `workspaces` feature (tenants, members, roles, invitations)
 * onto an existing project.
 *
 * Unlike the native wrappers above, this one copies nothing out of
 * `starter/`: the feature is purely additive, so its source lives under
 * cli/src/templates/workspaces/ and is applied through the feature
 * contract's ledger — the same path `hatchkit create` takes. One code
 * path means create and update cannot produce different projects, and
 * the ledger is what makes the apply idempotent on a re-run.
 */
async function addWorkspaces(
  projectDir: string,
  manifestDir: string,
  manifest: ProjectManifest,
): Promise<void> {
  const { FeatureLedger, applyFeatures } = await import("../features/contract.js");
  // Importing the feature module is what registers it.
  await import("../features/workspaces/index.js");

  const ledger = new FeatureLedger(projectDir, false);
  await applyFeatures(["workspaces"], {
    projectDir,
    manifestDir,
    manifest,
    identifiers: identifiersFor(manifest),
    mode: "update",
    ledger,
    log: (message) => console.log(chalk.dim(message)),
  });

  const summary = ledger.summary();
  console.log(
    chalk.dim(
      `  workspaces: ${summary.written.length} file(s) written, ${summary.unchanged.length} unchanged`,
    ),
  );
  for (const entry of ledger.conflicts()) {
    console.log(chalk.yellow(`  workspaces: ${entry.file} — ${entry.detail ?? "left alone"}`));
  }
}

/** Import native.css + standalone.css from globals.css.
 *
 *  CSS requires `@import` to precede every other rule, so these go
 *  directly after the last existing import rather than at the end. Both
 *  are unlayered while Tailwind's utilities sit in `@layer utilities`, so
 *  they still win the cascade — source order is not what decides it. */
function wireNativeStylesIntoGlobals(projectDir: string): boolean {
  const path = join(projectDir, "packages/client/src/styles/globals.css");
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf-8");
  if (content.includes('@import "./native.css"')) return false;

  const imports = [...content.matchAll(/^@import\s+[^\n]*;\n/gm)];
  const block =
    "\n/*\n" +
    " * Native and installed-web-app chrome.\n" +
    " *\n" +
    " *   native.css      every selector under `html.cap`, so it is inert on web\n" +
    " *                   BY CONSTRUCTION. A rule that would also be right on web\n" +
    " *                   belongs in this file, not there.\n" +
    " *   standalone.css  `@media (display-mode: standalone)` copies of the\n" +
    " *                   safe-area rules, scoped `html:not(.cap)`. NOT inert by\n" +
    " *                   construction — `viewport-fit=cover` ships to every host,\n" +
    " *                   and an installed web app gets the real insets with none\n" +
    " *                   of native.css applying to it.\n" +
    " */\n" +
    '@import "./native.css";\n' +
    '@import "./standalone.css";\n';

  let out: string;
  if (imports.length > 0) {
    const last = imports[imports.length - 1];
    const at = (last.index ?? 0) + last[0].length;
    out = content.slice(0, at) + block + content.slice(at);
  } else {
    out = block.replace(/^\n/, "") + content;
  }
  writeFileSync(path, out, "utf-8");
  return true;
}

/** Un-ignore the native trees and punch the generated holes into
 *  .gitignore.
 *
 *  A project scaffolded before this feature has a flat `ios/` and
 *  `android/` in .gitignore, which means the hand edits that live only in
 *  those trees — the ATS exception, the orientation set, the debug-only
 *  cleartext config, the version wiring and the signing config — are on
 *  exactly one machine, and the release workflow (which never runs
 *  `cap add`) has nothing to build. */
function ignoreNativeGeneratedPaths(projectDir: string): boolean {
  const path = join(projectDir, ".gitignore");
  if (!existsSync(path)) return false;
  let content = readFileSync(path, "utf-8");
  const before = content;

  // Drop the blanket ignores. Anchored to a whole line so a path like
  // `vendor/ios/` is untouched.
  content = content.replace(/^(ios|android)\/\s*$\n?/gm, "");

  if (!content.includes("ios/App/App/public/")) {
    content = `${content.trimEnd()}\n
# Capacitor native projects: COMMITTED, with holes.
#
# The ATS exception, the orientation set, the Android debug-only cleartext
# config, the version wiring and the optional signing config are hand edits
# that live only in these trees, and a fresh checkout must build the real app
# without a generator run. scripts/cap-add.mjs applies them; you commit them.
#
# Rewritten by every \`pnpm build:mobile\` but still TRACKED (a diff after a
# build is normal — commit it when the plugin set changed):
${NATIVE_GENERATED_TRACKED.map((p) => `#   ${p}`).join("\n")}
#
# Generated and NOT tracked — the holes below. A checkout that has never run
# \`pnpm build:mobile\` has none of them and cannot be opened in Xcode or
# Gradle at all. Build first.
${NATIVE_GENERATED_UNTRACKED.map((p) => p).join("\n")}
ios/App/build/
ios/App/DerivedData/
ios/App/.swiftpm/
ios/App/CapApp-SPM/.build/
ios/App/App.xcodeproj/xcuserdata/
ios/App/App.xcodeproj/project.xcworkspace/xcuserdata/
android/.gradle/
android/build/
android/app/build/
android/local.properties
# A credential. Signing is environment-driven and optional, so a checkout
# without this file still builds — unsigned.
android/app/release.keystore

# The mobile export has its own directory. A shared one means a Playwright
# run can silently be installed as the app.
packages/client/out-mobile/
`;
  }

  if (content === before) return false;
  writeFileSync(path, content, "utf-8");
  console.log(chalk.green("  ✓ .gitignore: native trees are tracked; generated paths ignored"));
  return true;
}

/** Copy one starter path into the project, MERGING directories.
 *
 *  A file that already exists is never overwritten — `update` layers a
 *  feature on, it does not reset the project, and the destination may
 *  carry edits nobody wants back. But a DIRECTORY that already exists is
 *  descended into rather than skipped: a project scaffolded before
 *  `scripts/lib/` or `packages/client/src/mobile/network.ts` existed has
 *  the parent directory and not the new files, and a whole-directory skip
 *  would leave it half-upgraded — with a globals.css importing a
 *  stylesheet that is not there and a layout importing a module that is
 *  not there. Half is worse than either end.
 *
 *  Returns the number of files written, so the caller can stay silent
 *  when a run changed nothing. */
/** Report an additive write this run declined to make. One shape for every
 *  skip, so the summary reads the same wherever it comes from. */
function reportKept(what: string, hint?: string): void {
  console.log(chalk.dim(`    · kept the project's ${what}`));
  if (hint) console.log(chalk.dim(`      ${hint}`));
}

type PkgJson = ReturnType<typeof readJson>;

/** Merge a feature's scripts from the starter into the project's
 *  package.json. A name the project already defines is kept and reported;
 *  `force` takes the starter's version instead. */
function mergeStarterScripts(
  projectPkg: PkgJson,
  starterPkg: PkgJson,
  names: readonly string[],
  opts: { force: boolean; label: string },
): void {
  projectPkg.scripts = projectPkg.scripts ?? {};
  const diverged: string[] = [];
  for (const name of names) {
    const wanted = starterPkg.scripts?.[name];
    if (!wanted) continue;
    const have = projectPkg.scripts[name];
    if (have === undefined || have === wanted || opts.force) {
      projectPkg.scripts[name] = wanted;
      continue;
    }
    diverged.push(name);
  }
  if (diverged.length > 0) {
    reportKept(
      `${opts.label} scripts: ${diverged.join(", ")}`,
      "--force replaces them with the starter's versions",
    );
  }
}

/** Merge a feature's dependency entries from the starter. A name the project
 *  already pins is kept: the pin is a decision (an Electron major the app was
 *  tested against, a version its native modules build for), and moving it is
 *  how a working desktop build starts failing for someone who only ran
 *  `hatchkit update`. */
function mergeStarterDeps(
  projectPkg: PkgJson,
  starterPkg: PkgJson,
  names: readonly string[],
  opts: { force: boolean },
): void {
  projectPkg.dependencies = projectPkg.dependencies ?? {};
  projectPkg.devDependencies = projectPkg.devDependencies ?? {};
  const kept: string[] = [];
  for (const name of names) {
    const wantedDep = starterPkg.dependencies?.[name];
    const wantedDevDep = starterPkg.devDependencies?.[name];
    const wanted = wantedDep ?? wantedDevDep;
    if (wanted === undefined) continue;
    const have = projectPkg.dependencies[name] ?? projectPkg.devDependencies[name];
    if (have !== undefined && have !== wanted && !opts.force) {
      kept.push(`${name}@${have}`);
      continue;
    }
    if (wantedDep !== undefined) projectPkg.dependencies[name] = wantedDep;
    else projectPkg.devDependencies[name] = wantedDevDep as string;
  }
  if (kept.length > 0) {
    reportKept(
      `dependency pins: ${kept.join(", ")}`,
      "--force replaces them with the starter's versions",
    );
  }
}

function copyFromStarter(starter: string, outputDir: string, rel: string): number {
  const src = join(starter, rel);
  const dst = join(outputDir, rel);
  if (!existsSync(src)) return 0;

  if (!statSync(src).isDirectory()) {
    // Already present — leave it, to avoid clobbering user edits.
    if (existsSync(dst)) return 0;
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
    return 1;
  }

  if (!existsSync(dst)) {
    cpSync(src, dst, { recursive: true });
    return countFiles(src);
  }
  let written = 0;
  for (const entry of readdirSync(src)) {
    written += copyFromStarter(starter, outputDir, join(rel, entry));
  }
  return written;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return n;
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
