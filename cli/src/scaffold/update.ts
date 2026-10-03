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
 * Currently supported additions: `desktop`, `mobile`, `i18n`.
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
import { installBackupScripts } from "../backups/scripts.js";
import { addUsedPorts, getUsedPorts } from "../config.js";
import { repoSlugFromRemote } from "../deploy/gh-actions-secrets.js";
import { pushNativeOriginsForProject } from "../deploy/trusted-origins.js";
import type { AuthSecurityOption } from "../features/auth-account-security/types.js";
import { FeatureLedger, type FeaturePlanContext, getFeature } from "../features/contract.js";
import { BUILD_COMMIT_ENV_VAR, BUILD_INFO_PATH } from "../features/deploy-recovery/index.js";
import { upgradeNextConfig } from "../features/deploy-recovery/serving.js";
import { extensionPrerequisiteProblem } from "../features/extension/index.js";
import type { RunI18nSetupOptions } from "../features/i18n/index.js";
import type { I18nConfig } from "../features/i18n/types.js";
import {
  applyOperationalLayer,
  operationalProjectFromManifest,
  renderOperationalLayer,
} from "../features/operational.js";
import {
  SERVER_FEATURE_IDS,
  applyServerFeatures,
  isServerFeature,
  printServerFeatureResults,
} from "../features/server-platform/index.js";
import type { Feature } from "../prompts.js";
import { retrofitDevEnvSecrets } from "../provision/write-env.js";
import { exec } from "../utils/exec.js";
import { KNOWN_FEATURES } from "../utils/flags.js";
import { ensureSecretFilesIgnored } from "../utils/gitignore.js";
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
import { DEV_LAUNCHER_LIB_FILES, applyDevLauncher } from "./dev-launcher.js";
import { type ProjectIdentifiers, legacyIdentifiers } from "./identifiers.js";
import { LINT_GATE_FILES, applyLintGate } from "./lint-gate.js";
import { NEWSLETTER_LISTMONK_REL_PATH, retrofitListmonkTxFrom } from "./listmonk-tx-from.js";
import { EMAIL_SERVICE_REL_PATH, retrofitListmonkTxMode } from "./listmonk-tx-mode.js";
import {
  MANIFEST_FILENAME,
  type ProjectManifest,
  findManifestDirUpward,
  readManifestWithMigrationInfo,
  writeManifest,
} from "./manifest.js";
import { hasNativeClient } from "./native-origins.js";
import {
  NEWSLETTER_ROUTES_REL_PATH,
  retrofitNewsletterConfirmOrigin,
} from "./newsletter-confirm-origin.js";
import { inferGhOwner, substituteComposeImageRefs } from "./owner.js";
import { setPackageJsonScript } from "./pkg-json.js";
import {
  STATIC_EXPORT_MARKER,
  applyPorts,
  flipNextConfigToStaticExport,
  rewriteFile,
} from "./starter-files.js";

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
export const SUPPORTED_ADDITIONS: readonly Feature[] = [
  "workspaces",
  // Purely additive: new files plus anchored merges into the auth wiring,
  // each of which recognises its own output.
  "token-client-auth",
  "desktop",
  "mobile",
  "release",
  // Purely additive: it writes new files, patches the auth wiring
  // idempotently, and never removes anything. That is what makes it safe
  // to layer onto a project that has been running for months.
  "auth-account-security",
  "client-core",
  "extension",
  // Additive by construction — they ship as templates rather than as
  // starter files a scaffold strips, so `update` applies the exact same
  // writer `create` does.
  ...SERVER_FEATURE_IDS,
  "i18n",
  "raycast",
  "mcp",
];

/**
 * The starter paths each retrofit copies, declared once so `--dry-run`
 * reports exactly what the add-path writes and cannot drift from it.
 * (`scripts/icons-desktop.mjs` is in the desktop list because
 * `icons:desktop` runs it and the scaffolder deletes it from a project
 * that had no desktop wrapper — installing the script without its
 * module is how that bug looked.)
 */
/**
 * What `--dry-run` says a feature would write.
 *
 * Two sources, in order:
 *
 *  1. The REGISTRY. A registered feature that implements
 *     `plannedFiles` declares its own plan, read off whatever table its
 *     `apply` reads — so the two cannot describe different file sets.
 *     This is the general seam: any feature can opt in without this
 *     function learning its name.
 *
 *     Note what it deliberately does NOT do: run the feature's `apply`
 *     against a dry `FeatureLedger`. That looks like the obvious answer
 *     and it is not safe here — `client-core` writes through `node:fs`
 *     in its strip and rename helpers, and the server-platform kit
 *     carries a dry-run flag of its own instead of deferring to the
 *     ledger. Executing every apply would make `--dry-run` write files,
 *     which is the one thing it promises not to do.
 *
 *  2. `DESKTOP_FILES`, for the one hand-written add-path left that
 *     copies straight out of the starter. Read rather than re-listed, so
 *     it cannot name a different set from the one copied.
 *
 * A feature in neither bucket returns nothing, and the dry run prints it
 * without a file list rather than with an empty one that reads as
 * authoritative.
 */
function plannedFilesFor(feature: Feature, ctx: FeaturePlanContext): readonly string[] {
  const declared = getFeature(feature)?.plannedFiles?.(ctx);
  if (declared !== undefined) return declared;
  // `build/` is copied alongside DESKTOP_FILES — it holds the icon source
  // the packager and `icons:desktop` read — so the plan has to name it.
  return feature === "desktop" ? [...DESKTOP_FILES, "build"] : [];
}

export interface UpdateResult {
  added: Feature[];
  skipped: Feature[];
  removed: Feature[];
  /** True when the run was a `--dry-run`: `added` then lists what WOULD
   *  be added and nothing on disk was touched. */
  dryRun?: boolean;
  /** Populated when this `update` run opted the project into the
   *  Tailscale-served local-dev integration. Distinct from a project
   *  that was already opted in — the latter shows up as `undefined`
   *  here. */
  localDevEnabled?: { slug: string; domain?: string };
}

export interface UpdateOptions {
  /**
   * Report what would be added and change nothing.
   *
   * Every sibling retrofit command has one (`hatchkit server add
   * --dry-run`, `hatchkit sync --dry-run`) and CLAUDE.md tells agents to
   * prefer it, but `update` — which copies starter trees, rewrites
   * package.json, edits the client layout and claims a port — had no way
   * to look first.
   *
   * Checked before any write, including the unconditional retrofits at
   * the top of `runUpdate`, so a dry run cannot touch the tree at all.
   *
   * A feature that applies itself through `FeatureLedger`
   * (`cli/src/features/contract.ts`) gets this for free — the ledger is
   * the choke point. This option covers the add-paths that predate it.
   */
  dryRun?: boolean;
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
    /** Answers for the `i18n` addition (source/target locales, which
     *  surfaces to generate). Passed straight through, so a headless
     *  caller drives the whole feature without a prompt; omitted, the
     *  feature asks. */
    i18n?: RunI18nSetupOptions["presets"];
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

  const dryRun = options.dryRun === true;
  const backupScripts = installBackupScripts(projectDir, manifest.name, dryRun);
  if (backupScripts.added.length)
    console.log(`  Backup scripts: ${backupScripts.added.join(", ")}${dryRun ? " (planned)" : ""}`);
  if (backupScripts.conflicts.length)
    console.log(`  Preserved custom backup scripts: ${backupScripts.conflicts.join(", ")}`);
  if (dryRun) {
    console.log(chalk.yellow("  --dry-run — reporting the plan, changing nothing.\n"));
  }

  // Every retrofit below writes to the tree, so a dry run skips the
  // lot rather than re-deriving each transform twice just to describe
  // it. `update` without --dry-run applies them as before.
  if (!dryRun) {
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

    // Retrofit secret hygiene. Until 2026-09-29 `hatchkit add` wrote dev
    // credentials into the committed .env.development, and the starter's
    // .gitignore named one keystore path, not the pattern. Ignore every
    // secret file hatchkit can generate, make the server load
    // .env.development.local, and move provisioned credentials there.
    // No flag: the failure is a credential in git, and nothing warns.
    const ignored = ensureSecretFilesIgnored(projectDir);
    if (ignored.added.length > 0) {
      console.log(chalk.green(`  ✓ .gitignore: now ignores ${ignored.added.join(", ")}`));
    }
    retrofitDevEnvSecrets(projectDir);
  }

  // Retrofit the account-email recipient mode. Until 2026-09-29 the
  // starter posted verification, reset and invitation mail to Listmonk's
  // /api/tx without `subscriber_mode`, and Listmonk answers 400 for any
  // address that is not already a subscriber — which none of those are.
  // The error is only logged, and with auth-account-security on it locks
  // every new account out. No flag, same rationale as the retrofits above.
  // Through a ledger rather than the dry-run gate, so a dry run names it.
  const txMode = retrofitListmonkTxMode(new FeatureLedger(projectDir, dryRun));
  if (txMode.action === "written" || txMode.action === "would-write") {
    console.log(
      chalk.green(
        `  ${dryRun ? "~ would patch" : "✓"} ${EMAIL_SERVICE_REL_PATH}: Listmonk account mail reaches non-subscribers (subscriber_mode "external")`,
      ),
    );
  } else if (txMode.outcome === "no-anchor") {
    console.log(
      chalk.yellow(
        `  ⚠ ${EMAIL_SERVICE_REL_PATH} posts to /api/tx, but hatchkit found no subscriber_email line to patch.\n` +
          '    Add `subscriber_mode: "external"` to that request body, or Listmonk rejects every\n' +
          "    signup, reset and invitation email with a 400.",
      ),
    );
  }

  // Retrofit the newsletter's transactional sender. Until 2026-09-29 the
  // starter's sendTransactional posted to /api/tx without `from_email`, so
  // Listmonk used its global app.from_email — on a shared instance another
  // project's sender — for every double-opt-in confirmation. Delivery
  // still succeeds, so nothing flags it. No flag, same rationale as above.
  // Never adds `subscriber_mode`: the newsletter creates its subscriber
  // first, so the default mode is right there.
  const txFrom = retrofitListmonkTxFrom(new FeatureLedger(projectDir, dryRun));
  if (txFrom.action === "written" || txFrom.action === "would-write") {
    console.log(
      chalk.green(
        `  ${dryRun ? "~ would patch" : "✓"} ${NEWSLETTER_LISTMONK_REL_PATH}: newsletter confirmation mail sent from LISTMONK_FROM`,
      ),
    );
  } else if (txFrom.outcome === "no-anchor") {
    console.log(
      chalk.yellow(
        `  ⚠ ${NEWSLETTER_LISTMONK_REL_PATH} posts to /api/tx without from_email, and hatchkit found no\n` +
          "    subscriber_email line to patch. Add\n" +
          "      from_email: process.env.LISTMONK_FROM || process.env.LISTMONK_FROM_EMAIL,\n" +
          "    to that request body, or Listmonk sends the confirmation email from its global\n" +
          "    app.from_email — another project's sender on a shared instance.",
      ),
    );
  }

  // Retrofit the newsletter's confirm link origin. Until 2026-09-29 the
  // starter built the emailed link on the site URL (NEWSLETTER_SITE_URL ??
  // FRONTEND_URL). Under the split topology that host serves no /api routes,
  // so the link 308s to a trailing slash and then 404s, and nobody can
  // confirm. Subscribing still succeeds, so nothing flags it. The link now
  // uses BETTER_AUTH_URL; the /sub/* redirects stay on the site URL.
  const confirmOrigin = retrofitNewsletterConfirmOrigin(new FeatureLedger(projectDir, dryRun));
  if (confirmOrigin.action === "written" || confirmOrigin.action === "would-write") {
    console.log(
      chalk.green(
        `  ${dryRun ? "~ would patch" : "✓"} ${NEWSLETTER_ROUTES_REL_PATH}: newsletter confirm link points at the API (BETTER_AUTH_URL)`,
      ),
    );
  } else if (confirmOrigin.outcome === "no-anchor") {
    console.log(
      chalk.yellow(
        `  ⚠ ${NEWSLETTER_ROUTES_REL_PATH} builds the newsletter confirm link on the site URL, and hatchkit\n` +
          "    could not patch it. Build that link on process.env.BETTER_AUTH_URL instead, and keep\n" +
          "    the /sub/* redirects on the site URL. When the client and the API are on different\n" +
          "    hosts, the client host has no /api/newsletter/confirm route and the link 404s.",
      ),
    );
  }

  // Base-infrastructure retrofit: the dev launcher's helper modules and the
  // lint gate. No flag and no prompt, for the same reason as the retrofits
  // around it — each one fixes a failure that is silent.
  //
  // The launcher's helpers are the sharpest of them. Without the process
  // group and its reaper, a dev run killed with SIGKILL, crashed, or stopped
  // by an agent harness leaves `tsx watch` and `next dev` running for days;
  // each holds thousands of file watches, and once a fresh `next dev` cannot
  // open any it never scans the app directory, so EVERY route answers 404
  // while static files still load. Nothing about that points at the cause.
  //
  // `scripts/dev.mjs` itself is NOT overwritten: a project may have edited
  // it, and this list is what the shipped launcher needs beside it.
  //
  // Outside the dry-run gate above so a dry run can name what it would
  // copy and write — every write below is conditional on `dryRun`.
  const retrofittedTooling: string[] = [];
  for (const rel of [...DEV_LAUNCHER_LIB_FILES, ...LINT_GATE_FILES]) {
    if (existsSync(join(projectDir, rel))) continue;
    if (dryRun) {
      if (existsSync(join(STARTER_ROOT, rel))) retrofittedTooling.push(rel);
      continue;
    }
    copyFromStarter(STARTER_ROOT, projectDir, rel);
    if (existsSync(join(projectDir, rel))) retrofittedTooling.push(rel);
  }
  const lintGate = applyLintGate(projectDir, { dryRun });
  if (retrofittedTooling.length > 0) {
    console.log(
      chalk.green(
        `  ${dryRun ? "~ would copy" : "✓"} shared tooling: ${retrofittedTooling.join(", ")}`,
      ),
    );
  }
  if (lintGate.changed) {
    console.log(
      chalk.green(`  ${dryRun ? "~ would add" : "✓"} lint gate: root ${lintGate.wrote.join(", ")}`),
    );
    console.log(
      chalk.dim(
        "    `pnpm run lint` is the one command; .githooks/pre-push and the lint\n" +
          "    CI job both call it. Run `pnpm install` once to activate the hook.",
      ),
    );
  }

  // Derived from KNOWN_FEATURES rather than re-listed, so a feature
  // added to the create flags cannot go missing from the update picker.
  const allOptions: readonly Feature[] = KNOWN_FEATURES;

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
  if (!manifest.localDev && !dryRun) {
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
  let added: Feature[] = [...next].filter((f) => !current.has(f));
  const removed: Feature[] = [...current].filter((f) => !next.has(f));
  /** Asked for, and refused because the project cannot carry it. */
  let prerequisiteSkipped: Feature[] = [];

  // Close the selection over prerequisites, and apply in the registry's
  // order so a feature that requires another one runs after it. A
  // prerequisite pulled in this way is named: the user did not ask for
  // it, and finding a new package in the diff with no explanation is
  // how people stop trusting `update`.
  if (added.length > 0) {
    const { expandFeatureSelection } = await import("../features/all.js");
    const expansion = expandFeatureSelection([...current, ...added]);
    for (const error of expansion.errors) console.log(chalk.yellow(`  ${error}`));
    const pulled = expansion.implied.filter((id) => !current.has(id) && !added.includes(id));
    if (pulled.length > 0) {
      console.log(
        chalk.dim(`\n  Also adding ${pulled.join(", ")}: required by what you selected.`),
      );
      added = [...added, ...pulled];
    }
    const rank = (feature: Feature): number => {
      const at = expansion.ordered.indexOf(feature);
      // A feature the registry does not know about keeps its place at
      // the end rather than jumping ahead of one that has an order.
      return at === -1 ? Number.MAX_SAFE_INTEGER : at;
    };
    added = [...added].sort((a, b) => rank(a) - rank(b));
  }

  // The extension needs the shared client core and a server runtime. A
  // project with neither is told why rather than handed a package that
  // cannot talk to anything.
  if (added.includes("extension")) {
    const problem = extensionPrerequisiteProblem(manifest.surfaces ?? "fullstack");
    if (problem !== null) {
      prerequisiteSkipped = ["extension"];
      added = added.filter((f) => f !== "extension");
      console.log(chalk.yellow(`\n  ${problem}`));
    }
  }

  if (removed.length > 0) {
    console.log(
      chalk.yellow(
        `\n  Refusing to remove features: ${removed.join(", ")}. Removing features risks deleting user code. Remove manually + update the manifest.`,
      ),
    );
  }

  if (dryRun) {
    console.log(
      added.length > 0
        ? chalk.bold(`\n  Would add: ${added.join(", ")}`)
        : chalk.dim("\n  Would add: (nothing — the feature set is already what you asked for)"),
    );
    // Importing the registry is what populates it, and a feature whose
    // module was never loaded would report no plan rather than its own.
    await import("../features/all.js");
    const planCtx: FeaturePlanContext = {
      projectDir,
      manifestDir,
      manifest,
      identifiers: identifiersFor(manifest),
    };
    for (const feature of added) {
      for (const rel of plannedFilesFor(feature, planCtx)) {
        console.log(chalk.dim(`    + ${rel}`));
      }
    }
    if (added.some((f) => hasNativeClient([f]))) {
      console.log(
        chalk.dim('    ~ packages/client/next.config.ts (flip to `output: "export"`, if unedited)'),
      );
    }
    console.log(chalk.dim(`    ~ ${MANIFEST_FILENAME} (features, cliVersion, ports)`));
    console.log(chalk.yellow("\n  --dry-run — nothing was written."));
    return { added, skipped: [], removed, dryRun: true };
  }

  // The feature-add work runs only if there's something to add AND the
  // user confirms. The local-dev opt-in is independent — we apply it
  // even when the rest of the update is a no-op (this is the canonical
  // retrofit path for pre-existing projects). `skippedAdditions` carries
  // the declined-add list so the result still reports it.
  let actuallyAdded: Feature[] = [];
  let skippedAdditions: Feature[] = [];
  let authSecurityOptions: string[] | undefined;
  /** The i18n answers, when this run added the feature. Persisted so the
   *  feature's own `apply` can re-apply without prompting and without
   *  re-deriving — see `features/i18n/definition.ts`. */
  let i18nConfig: I18nConfig | undefined;
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
      // Additions that ran but refused to apply. They must not reach
      // the manifest OR the "added" report — a feature recorded on a
      // project that has none of its files is worse than an absent one,
      // because the next `update` run treats it as already there.
      const refused: Feature[] = [];
      for (const feature of added) {
        if (feature === "workspaces") {
          await addWorkspaces(projectDir, manifestDir, manifest);
          updatedFeatures.add("workspaces");
        } else if (feature === "desktop") {
          await addDesktop(projectDir, resolvedStarter, manifest, options.force === true);
          updatedFeatures.add("desktop");
        } else if (feature === "mobile") {
          console.log(chalk.dim("\n  Adding mobile (Capacitor)..."));
          await addRegisteredFeature("mobile", projectDir, manifestDir, manifest);
          updatedFeatures.add("mobile");
        } else if (feature === "token-client-auth") {
          console.log(chalk.dim("\n  Adding session identity, lifetime and devices..."));
          await addRegisteredFeature("token-client-auth", projectDir, manifestDir, manifest);
          updatedFeatures.add("token-client-auth");
        } else if (feature === "extension") {
          await addExtension(projectDir, manifestDir, manifest);
          updatedFeatures.add("extension");
        } else if (feature === "release") {
          await addRelease(
            projectDir,
            manifestDir,
            manifest,
            [...updatedFeatures, ...added],
            dryRun,
          );
          updatedFeatures.add("release");
        } else if (feature === "auth-account-security") {
          authSecurityOptions = await addAuthAccountSecurity(projectDir, manifest, {
            presetOptions: options.presets?.authSecurityOptions,
          });
          updatedFeatures.add("auth-account-security");
        } else if (feature === "client-core") {
          await addRegisteredFeature("client-core", projectDir, manifestDir, manifest);
          updatedFeatures.add("client-core");
        } else if (feature === "raycast" || feature === "mcp") {
          // Both go through the registry, so `applyFeatures` orders them after
          // the prerequisites they declare and each one's own `apply` runs the
          // shared device-grant unit it needs. A surface that cannot host them
          // is refused rather than half-applied — the manifest would otherwise
          // claim a package the project has no files for, and the next
          // `update` would treat it as already present.
          // A manifest written before `surfaces` existed has none. Treat that
          // as the full-stack default the scaffolder used at the time rather
          // than refusing: the project plainly has both halves or it would not
          // have got this far.
          const surfaces = manifest.surfaces ?? "fullstack";
          const problem =
            feature === "raycast"
              ? (await import("../features/raycast/index.js")).raycastPrerequisiteProblem(surfaces)
              : (await import("../features/mcp/index.js")).mcpPrerequisiteProblem(surfaces);
          if (problem !== null) {
            console.log(chalk.yellow(`\n  Skipping ${feature}. ${problem}`));
            refused.push(feature);
          } else {
            await addRegisteredFeature(feature, projectDir, manifestDir, manifest);
            updatedFeatures.add(feature);
          }
        } else if (feature === "i18n") {
          // i18n is the one addition that copies nothing out of the
          // starter: the starter is single-language, so there is no
          // feature directory to lift. The generator writes its own
          // files and makes a handful of idempotent edits to files the
          // project already has — see features/i18n/rewriter.ts.
          const { runI18nSetup } = await import("../features/i18n/index.js");
          const audit = await runI18nSetup({
            projectDir,
            mode: "update",
            presets: options.presets?.i18n,
            identifiers: identifiersFor(manifest),
          });
          // A refusal (no packages/client) must not record the feature:
          // the manifest would then claim a language the project has no
          // files for, and the next `update` would treat it as present.
          if (audit.ok) {
            updatedFeatures.add("i18n");
            // The settled config, not the requested one: a project with
            // no server half has `serverCatalogs` switched back off, and
            // recording the request instead would have the next
            // `--dry-run` itemise catalogs that were never written.
            i18nConfig = audit.config;
          } else refused.push("i18n");
        }
      }

      // Server platform features run as one batch after the native
      // shells, in registry order rather than selection order — see
      // applyServerFeatures. A feature that can't find a server package
      // reports `skipped` and is NOT recorded in the manifest, so a
      // later run against a project that grew one picks it up.
      const serverFeatures = added.filter(isServerFeature);
      const serverSkipped = new Set<Feature>();
      if (serverFeatures.length > 0) {
        const results = applyServerFeatures(serverFeatures, {
          projectDir,
          projectName: manifest.name,
        });
        printServerFeatureResults(results);
        for (const result of results) {
          if (result.skipped) serverSkipped.add(result.id);
          else updatedFeatures.add(result.id);
        }
      }
      // A feature that reported `skipped` wrote nothing and is not in
      // the manifest — reporting it as added would tell the user to
      // look for files that aren't there.
      actuallyAdded = added.filter((f) => !serverSkipped.has(f) && !refused.includes(f));
      skippedAdditions = added.filter((f) => serverSkipped.has(f) || refused.includes(f));

      // Every shell loads a static export; without this the retrofit
      // produced a project whose `build:desktop` / `build:mobile` never
      // wrote the directory the shell points at.
      if (added.some((f) => hasNativeClient([f]))) {
        ensureStaticExportForNativeShell(projectDir, resolvedStarter);
      }

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

      // A shell added here loads the client from its own document origin, and
      // the DEV server has to trust it too — better-auth validates Origin on
      // any request carrying Sec-Fetch-* headers, which every real WebView
      // fetch does, so without this sign-in answers 403 INVALID_ORIGIN
      // locally before the password is ever checked. The Coolify side of the
      // same list is merged further down.
      applyDevLauncher(projectDir, updatedPorts, [...updatedFeatures]);
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
    await addRelease(projectDir, manifestDir, manifest, [...updatedFeatures], dryRun);
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
  // still gains the files they were missing. That is the ledger's
  // guarantee now, not this call site's: the work is in
  // `features/mobile/index.ts`, and re-running it writes nothing.
  if (updatedFeatures.has("mobile") && !actuallyAdded.includes("mobile")) {
    const refreshed = await addRegisteredFeature("mobile", projectDir, manifestDir, manifest);
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
      i18n: i18nConfig ?? manifest.i18n,
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

  // The operational layer, retrofitted. Same no-flag rationale as the
  // retrofits above: every one of these closes a failure that is silent
  // by nature — a deploy that cannot undo itself, a store client that
  // cannot sign in, a tab that white-screens after a deploy, an API
  // origin two places disagree about. A project that predates them has
  // all four and no way to know.
  //
  // LAST, after the feature additions above. Several modules read the
  // project's feature set and the files those additions write — the
  // native origins a store client signs in from, the platform list a
  // crash report carries, the static-export flip a shell needs. Run
  // before them, this wrote the layer for the feature set the project
  // had on the way in, and the NEXT `update` rewrote all of it for the
  // set it has now: a second run that changed five files while
  // reporting nothing added.
  //
  // Unlike the retrofits above, this one runs in a dry run too: every
  // write goes through a FeatureLedger, which is where `--dry-run` is
  // decided, so the modules describe the whole change without touching
  // the tree instead of being skipped wholesale.
  //
  // Nothing a user has tuned is overwritten: the layer owns the files
  // it regenerates and uses managed blocks or fixed-point edits for the
  // ones it shares. `force` is the caller's decision, and `update`
  // never makes it.
  //
  // The repository slug has to be resolved here, exactly as `create`
  // resolves it. Several generated artefacts name a registry image
  // built from it, and a run that cannot answer "which repository?"
  // writes a placeholder owner over a correct one — the self-host
  // compose would go from the project's real image to `ghcr.io/OWNER/…`
  // on every update, which pulls nothing and says nothing about why.
  const operationalRepoSlug = await detectRepoSlug(projectDir);
  const operational = applyOperationalLayer({
    projectDir,
    // `updatedFeatures`, not `manifest.features`: the additions above
    // have already run, and several modules read the feature set to
    // decide what exists — which native origins a store client signs in
    // from, which platforms a crash report can name. Handed the set the
    // project had on the way IN, this writes for a project that no
    // longer exists and the next `update` rewrites all of it.
    project: {
      ...operationalProjectFromManifest(manifest, operationalRepoSlug),
      features: [...updatedFeatures],
    },
    mode: "update",
    dryRun,
  });
  const operationalLines = renderOperationalLayer(operational);
  if (operationalLines.length > 0) {
    console.log(chalk.bold("\n  Operational layer"));
    for (const line of operationalLines) {
      console.log(line.endsWith(":") ? chalk.cyan(`  ${line}`) : chalk.dim(`  ${line}`));
    }
  }
  const operationalSteps = operational.manualSteps;
  if (operationalSteps.length > 0) {
    console.log(chalk.dim("\n  Left for you:"));
    for (const step of operationalSteps) console.log(`  ${chalk.yellow("·")} ${step}`);
  }

  return {
    added: actuallyAdded,
    skipped: [...skippedAdditions, ...prerequisiteSkipped],
    removed,
    localDevEnabled,
  };
}

/** Apply the `extension` feature through the feature contract.
 *
 *  The same `apply` `hatchkit create` runs — one definition of what the
 *  feature is. Every write goes through the ledger, so a re-run on an
 *  unchanged project reports nothing written, and the extension's own
 *  source (which the project owns from the moment it lands) is kept
 *  rather than overwritten. */
async function addExtension(
  projectDir: string,
  manifestDir: string,
  manifest: ProjectManifest,
): Promise<void> {
  console.log(chalk.dim("\n  Adding the browser extension (MV3)..."));
  const { FeatureLedger } = await import("../features/contract.js");
  const { extensionFeature, extensionResidue } = await import("../features/extension/index.js");

  const ledger = new FeatureLedger(projectDir, false);
  ledger.scopeTo("extension");
  await extensionFeature.apply({
    projectDir,
    manifestDir,
    manifest,
    identifiers: identifiersFor(manifest),
    mode: "update",
    ledger,
    log: (message: string) => console.log(chalk.dim(message)),
  });

  const summary = ledger.summary();
  for (const file of summary.written) console.log(chalk.green(`    \u2713 ${file}`));
  for (const conflict of ledger.conflicts()) {
    console.log(chalk.yellow(`    \u21bb ${conflict.file}: ${conflict.detail ?? "conflict"}`));
  }
  for (const note of extensionResidue()) console.log(chalk.dim(`    \u2022 ${note}`));
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
  dryRun: boolean,
): Promise<void> {
  console.log(chalk.dim("\n  Adding release coordination..."));
  const { FeatureLedger } = await import("../features/contract.js");
  const { releaseFeature, configFor, releaseAudit } = await import("../features/release/index.js");

  const ledger = new FeatureLedger(projectDir, dryRun);
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

/**
 * A native shell loads the client from a static export —
 * `capacitor.config.ts` points `webDir` at `packages/client/out`, and
 * Electron's main process does `loadFile(.../out/index.html)`.
 * `scaffoldApp` flips `next.config.ts` to `output: "export"` whenever a
 * shell is selected, but `hatchkit update` never did, so a fullstack
 * project that gained `desktop` or `mobile` later kept building
 * `standalone`, never produced `out/`, and the shell had nothing to
 * load. (The starter config only exports under `NEXT_FILE_EXPORT=1`,
 * which nothing in the generated project sets.)
 *
 * The flip REPLACES the file, so this refuses to run over a config the
 * user has edited: already-flipped is a silent no-op, an untouched
 * starter config is rewritten, and anything else is reported with the
 * one line the user has to add themselves.
 */
function ensureStaticExportForNativeShell(projectDir: string, resolvedStarter: string): void {
  const rel = "packages/client/next.config.ts";
  const path = join(projectDir, rel);
  if (!existsSync(path)) return;
  const current = readFileSync(path, "utf-8");
  if (current.includes(STATIC_EXPORT_MARKER)) return;

  // "Untouched" means the USER has not edited it — not that nothing has.
  // The operational layer retrofits this same file (the build-info route
  // has to go out uncached), so a byte comparison against the pristine
  // starter reports every scaffolded project as hand-edited and refuses
  // the flip on all of them. Comparing against the starter WITH
  // hatchkit's own transform applied asks the question that was meant:
  // the transform is idempotent and is the only other thing that writes
  // here, so anything else in the file came from a person.
  const pristine = join(resolvedStarter, rel);
  const pristineBody = existsSync(pristine) ? readFileSync(pristine, "utf-8") : undefined;
  const untouched =
    pristineBody !== undefined &&
    (pristineBody === current || nextConfigAsHatchkitWritesIt(pristineBody) === current);
  if (!untouched) {
    console.log(
      chalk.yellow(
        `\n  ! ${rel} has local edits, so it was left alone — but a native shell\n` +
          "    loads packages/client/out, which only exists when the client builds\n" +
          '    as a static export. Add `output: "export"` to your config, or the\n' +
          "    shell will start with nothing to load.",
      ),
    );
    return;
  }
  flipNextConfigToStaticExport(projectDir);
  console.log(chalk.green(`  ✓ ${rel}: flipped to \`output: "export"\` for the native shell`));
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

/** Feature id → the module whose import REGISTERS it. A feature that is
 *  never imported is not in the registry, and `applyFeatures` would skip
 *  it silently — so the mapping is explicit rather than a bare import of
 *  whichever feature was converted first. */
const FEATURE_MODULES: Partial<Record<Feature, () => Promise<unknown>>> = {
  "client-core": () => import("../features/client-core/index.js"),
  mobile: () => import("../features/mobile/index.js"),
  "token-client-auth": () => import("../features/token-client-auth/index.js"),
};

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
): Promise<string[]> {
  const { FeatureLedger, applyFeatures } = await import("../features/contract.js");
  // Importing the module is what registers it.
  const load = FEATURE_MODULES[feature];
  if (!load) throw new Error(`Feature "${feature}" has no module in FEATURE_MODULES.`);
  await load();
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
  // Conflicts are reported by the feature itself, which can say what the
  // value MEANT — `addRegisteredFeature` only knows a path and a string.
  return summary.written;
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

/** The project's `owner/repo` on GitHub, read from its git remote.
 *
 *  `undefined` when there is no remote, no repository, or a remote this
 *  cannot parse — every consumer treats that as "unknown" and leaves
 *  whatever is already written alone rather than substituting a
 *  placeholder. */
async function detectRepoSlug(projectDir: string): Promise<string | undefined> {
  const res = await exec("git", ["-C", projectDir, "remote", "get-url", "origin"], {
    silent: true,
  });
  if (res.exitCode !== 0) return undefined;
  return repoSlugFromRemote(res.stdout.trim());
}

/** The starter's next.config.ts as the operational layer leaves it.
 *
 *  Used only to tell hatchkit's own edit apart from a person's — see
 *  {@link ensureStaticExportForNativeShell}. Mirrors the arguments
 *  `deploy-recovery` applies, so the two cannot answer differently. */
function nextConfigAsHatchkitWritesIt(pristine: string): string {
  return upgradeNextConfig(pristine, {
    buildInfoPath: BUILD_INFO_PATH,
    commitEnvVar: BUILD_COMMIT_ENV_VAR,
  }).content;
}
