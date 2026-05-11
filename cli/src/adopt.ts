/*
 * `hatchkit adopt` — onboard an existing project into hatchkit.
 *
 * Inverse of `hatchkit create`: instead of generating a project from
 * the starter, point hatchkit at a repo that already exists and bring
 * it under management. The flow:
 *
 *   1. Detect — read package.json, sniff repo layout (packages/server,
 *      apps/server, root), check for dotenvx-encrypted .env.production
 *      and an existing .env.keys, look up a Coolify app by project
 *      name, infer features from package deps + env vars present.
 *   2. Review — stepper UI mirroring `hatchkit setup` so the user can
 *      step back through each detected value before we touch anything.
 *      Same Separator-grouped layout, same ✓/· marks.
 *   3. Execute —
 *      a. If .env.production isn't already dotenvx-encrypted, encrypt
 *         it (this generates packages/server/.env.keys with the
 *         private key).
 *      b. Read DOTENV_PRIVATE_KEY_PRODUCTION out of .env.keys and
 *         mirror it into the OS keychain (so `hatchkit keys push`
 *         works going forward).
 *      c. Write .hatchkit.json so the project is recognized by
 *         `update`, `add`, `keys`, etc.
 *      d. Optionally run the same observability/email provisioning
 *         that `hatchkit add` does (GlitchTip, OpenPanel, Resend),
 *         scoped to whichever surfaces (server/client/both) the user
 *         picked. DSN/clientId/keys land encrypted into the existing
 *         .env.production.
 *      e. Optionally push the dotenvx private key to Coolify so the
 *         deployed app can decrypt env at runtime.
 *
 * Adopt is intentionally idempotent on the parts that can be made so:
 * a second run on the same dir notices the existing manifest and
 * exits early with a "use `hatchkit update` instead" hint.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Separator, confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { ensureGitHub, getCoolifyConfig, getGhcrConfig } from "./config.js";
import {
  ghSecretExists,
  ownerFromRemote,
  repoSlugFromRemote,
  setCoolifyDeploySecrets,
} from "./deploy/gh-actions-secrets.js";
import { pushInitialBranch } from "./deploy/github.js";
import { pushProjectKeyToCoolify, pushProjectKeyToGh } from "./deploy/keys.js";
import { handleAdoptFailure } from "./deploy/rollback.js";
import type { Feature, S3Provider } from "./prompts.js";
import { type ProvisionService, runProvision } from "./provision/index.js";
import { readEnvKeys } from "./provision/write-env.js";
import { detectBuildPipeline, scaffoldBuildPipeline } from "./scaffold/build-pipeline.js";
import {
  MANIFEST_FILENAME,
  type ProjectManifest,
  readManifest,
  writeManifest,
} from "./scaffold/manifest.js";
import {
  installCancelHandler,
  isCancelInProgress,
  uninstallCancelHandler,
} from "./utils/cancel-handler.js";
import { CoolifyApi } from "./utils/coolify-api.js";
import { ensureDockerignoreAllowsEnvProduction } from "./utils/dockerignore.js";
import { exec, execOk } from "./utils/exec.js";
import { ensureGitignoreEntries, looksLikeDotenvxPrivateKey } from "./utils/gitignore.js";
import { multiselect } from "./utils/multiselect.js";
import { RunLedger } from "./utils/run-ledger.js";
import { SECRET_KEYS, getSecret, setSecret } from "./utils/secrets.js";
import {
  validateCoolifyDescription,
  validateDomain,
  validateProjectName,
} from "./utils/validate.js";
import { getCliVersion } from "./utils/version.js";

export interface DetectedState {
  /** Absolute path to the project root. */
  projectDir: string;
  /** package.json `name` if any. */
  packageName?: string;
  /** package.json `description` if any. Used as the default for the
   *  Coolify project / app description prompt so a project that
   *  already has a one-liner doesn't have to type it again. */
  packageDescription?: string;
  /** Whether `<root>/.hatchkit.json` already exists — adopt refuses
   *  to overwrite; the user should run `hatchkit update` instead. */
  hasManifest: boolean;
  /** Where the server's env files live, if detectable. */
  serverDir?: string;
  /** Where the client's env files live, if detectable. */
  clientDir?: string;
  /** True when the project root looks like a workspace / monorepo (a
   *  `pnpm-workspace.yaml`, a root `package.json#workspaces` field, or
   *  one of the popular orchestrator manifests — turbo.json, lerna.json,
   *  rush.json) BUT none of the conventional server/client dirs matched.
   *
   *  This is the layout that breaks the scaffolded build pipeline: the
   *  Dockerfile templates assume a single-package project rooted at /,
   *  so for an unrecognised workspace they'd `pnpm install` an empty
   *  surface and `pnpm build` whatever the root script does — almost
   *  never the user's intent. When this is true, adopt defaults the
   *  pipeline scaffold OFF and parks the cursor on the row so the user
   *  has to opt-in explicitly. */
  unknownWorkspaceLayout: boolean;
  /** When `unknownWorkspaceLayout` is true, plausible standalone build
   *  directories found inside the project — first-level subdirs that
   *  carry their own `package.json` + lockfile, optionally with
   *  `.npmrc:ignore-workspace=true` (the docs/marketing-site pattern).
   *  Surfaced as a hint in the detection summary so the user knows
   *  where to point a hand-authored Dockerfile. */
  standaloneBuildCandidates: Array<{ dir: string; hasIgnoreWorkspace: boolean }>;
  /** Detected feature flags (best-guess from package deps + .env keys). */
  features: Feature[];
  /** True if `<serverDir>/.env.production` opens with a DOTENV_PUBLIC_KEY
   *  header — the marker dotenvx writes when encrypting. */
  prodEnvIsEncrypted: boolean;
  /** True if a `.env.keys` file is present at <serverDir>. */
  hasEnvKeys: boolean;
  /** Coolify app name match, if any. */
  coolifyAppMatch?: { uuid: string; name: string };
  /** Whether Coolify is configured. When false, all `coolify*` checks
   *  below were skipped — the absence of a value doesn't mean "missing",
   *  it means "we didn't ask". */
  coolifyConfigured: boolean;
  /** Count of Coolify GitHub App sources. Required for private-repo
   *  app creation; zero means wireCoolify will fail with a clear
   *  hint when `setupGitHub === true`. Undefined when Coolify isn't
   *  configured at all. */
  coolifyGithubSourceCount?: number;
  /** Whether `<projectDir>/.git` exists. */
  isGitRepo: boolean;
  /** Origin URL from `git remote get-url origin`, if set. */
  gitRemoteUrl?: string;
  /** Visibility of the GitHub repo at `gitRemoteUrl`, when we can
   *  resolve it via `gh repo view`. Undefined when no remote is set,
   *  gh isn't authed, or the repo isn't on GitHub. Drives the default
   *  for the AdoptPlan.isPrivate stepper choice. */
  gitRemoteIsPrivate?: boolean;
  /** Parsed `.hatchkit.json` if a previous adopt/scaffold landed
   *  one. Used by `--resume` to pre-fill the stepper with the values
   *  the user already chose, instead of starting from blank. */
  existingManifest?: ProjectManifest;
}

type AdoptSurface = "server-only" | "client-only" | "both";

type AdoptDeploymentMode = "coolify" | "gh-pages" | "scaffold-only";

interface AdoptPlan {
  name: string;
  domain: string;
  /** One-liner that ends up on the Coolify project + application
   *  pages (instead of the generic "Adopted by hatchkit" blurb).
   *  Empty string means "no override" — wireProjectIntoCoolify will
   *  use the default on first create and leave any existing
   *  description untouched on reconcile. */
  description: string;
  features: Feature[];
  /** What kind of project this is — drives where env files go, which
   *  Coolify build-pack we ask for, and which surfaces `hatchkit add`
   *  provisions clients into. */
  surfaces: AdoptSurface;
  /** Where this project will run. Coolify is the default for full-
   *  stack and server-only adopts; gh-pages is only offered when
   *  surfaces is client-only (Pages can't host a backend). Switches
   *  the second half of executePlan from Coolify wiring to
   *  `runPagesSetupProgrammatic`. */
  deploymentMode: AdoptDeploymentMode;
  /** Required when `surfaces !== "client-only"`. */
  serverDir?: string;
  /** Required when `surfaces !== "server-only"`. */
  clientDir?: string;
  /** Always-on side effect — initialize dotenvx encryption if the
   *  server dir doesn't already have an encrypted .env.production. */
  bootstrapDotenvx: boolean;
  /** Initialize git + create a GitHub remote (private repo). Skipped
   *  silently when a remote already exists. */
  setupGitHub: boolean;
  /** Wire the repo into the user's existing Coolify + DNS via direct
   *  API calls (no Terraform / no submodule). Defaults ON when there's
   *  no Coolify app match yet. */
  wireCoolify: boolean;
  /** Whether to treat the GitHub repo as private when wiring Coolify.
   *  Private → Coolify clones via the configured GitHub App's SSH
   *  deploy key. Public → Coolify clones via HTTPS, no auth needed.
   *  Defaulted from `gh repo view --json visibility` when the remote
   *  exists; defaults to true when adopt is creating a fresh
   *  `--private` repo. Picking the wrong value is the #1 cause of
   *  "Permission denied (publickey)" deploy failures, hence its own
   *  stepper row instead of being silently inferred from setupGitHub. */
  isPrivate: boolean;
  /** Container port the app exposes — defaults to "3000". */
  appPort: string;
  /** Scaffold the build pipeline (Dockerfile + docker-compose.yml +
   *  .github/workflows/deploy.yml) when those files don't exist yet.
   *  Always coupled with wireCoolify since the compose file is what
   *  Coolify reads. The detection step ensures this is a no-op when
   *  the user already has their own. */
  scaffoldBuildPipeline: boolean;
  /** Provisioning to run after manifest write. */
  services: ProvisionService[];
  /** Push dotenvx key to Coolify after everything's written. */
  pushKey: boolean;
}

export async function runAdopt(
  cwd: string,
  opts: { resume?: boolean; regeneratePipeline?: boolean } = {},
): Promise<void> {
  const state = await detectProject(cwd);

  if (state.hasManifest && !opts.resume) {
    console.log(
      chalk.yellow(`\n  ${MANIFEST_FILENAME} already exists in ${relativeTo(state.projectDir)}.`),
    );
    console.log(
      chalk.dim(
        "  This project is already adopted. Options:\n" +
          "    · `hatchkit update`              — add features to the scaffold\n" +
          "    · `hatchkit add <project>`       — (re-)provision per-project clients\n" +
          "    · `hatchkit adopt --resume`      — re-run adopt over the existing manifest\n" +
          "                                       (handy when an earlier run failed mid-way)\n",
      ),
    );
    return;
  }

  console.log(chalk.bold(opts.resume ? "\n  hatchkit adopt --resume" : "\n  hatchkit adopt"));
  if (opts.resume) {
    console.log(
      chalk.dim(
        "  Resuming a previous adopt — already-finished steps (encrypted .env,\n" +
          "  existing GitHub origin, existing Coolify app) will skip; the rest will run.",
      ),
    );
  }
  printDetected(state);

  // Initial plan — pre-filled from (in order of preference) the
  // existing manifest (so `--resume` recovers prior choices), then
  // detection on disk, then sensible defaults.
  //   bootstrapDotenvx: default ON when there's no encrypted prod env —
  //     adopt's whole point is "make this manageable", and that needs a
  //     dotenvx keypair so everything else (key push, encrypted writes
  //     by `add`) has something to work with.
  //   setupGitHub: default ON when there's no origin remote yet.
  const m = state.existingManifest;
  // Surfaces resolution order:
  //   1. Whatever was persisted in the manifest (`--resume` recovery —
  //      detection wouldn't see a client/ dir for an in-place static
  //      site so re-inferring would always be wrong).
  //   2. Detection: both dirs → "both"; single dir → matching surface.
  //   3. Fallback "client-only" — non-monorepo modern projects (Vite
  //      SPAs, plain static sites, Next.js) are vastly more often
  //      client-only than headless backends. The stepper marks this
  //      step as `set: false` (see buildAdoptGroups) when we land
  //      here without a strong signal, so the cursor parks on it and
  //      the user is nudged to confirm before hitting Adopt.
  const inferredSurfaces: AdoptSurface =
    m?.surfaces ??
    (state.serverDir && state.clientDir
      ? "both"
      : state.serverDir
        ? "server-only"
        : state.clientDir
          ? "client-only"
          : "client-only");
  // Auto-suggest gh-pages when (a) the manifest already recorded it,
  // or (b) the manifest is silent AND the project looks client-only
  // AND there's no Coolify app already wired up. Otherwise default
  // to coolify (the existing behaviour).
  const inferredDeploymentMode: AdoptDeploymentMode =
    m?.deploymentMode === "gh-pages"
      ? "gh-pages"
      : m?.deploymentMode === "scaffold-only"
        ? "scaffold-only"
        : "coolify";

  let plan: AdoptPlan = {
    name: m?.name ?? state.packageName ?? "",
    domain: m?.domain ?? "",
    deploymentMode: inferredDeploymentMode,
    // Description resolution order:
    //   1. Persisted manifest value (`--resume` recovery — a previous
    //      run already settled this).
    //   2. package.json `description` — the obvious source of a
    //      one-liner the user already wrote for npm.
    //   3. "" (empty) — wireProjectIntoCoolify falls back to its
    //      generic blurb on create and leaves Coolify alone on reconcile.
    description: m?.description ?? state.packageDescription ?? "",
    // Manifest features are the source of truth when present — the user
    // already curated them on the previous run. Detection is only a
    // best-guess fallback for the first-ever adopt.
    features: m?.features ?? state.features,
    surfaces: inferredSurfaces,
    serverDir:
      inferredSurfaces === "client-only" ? undefined : (state.serverDir ?? state.projectDir),
    clientDir:
      inferredSurfaces === "server-only" ? undefined : (state.clientDir ?? state.projectDir),
    bootstrapDotenvx: !state.prodEnvIsEncrypted,
    setupGitHub: !state.gitRemoteUrl,
    wireCoolify: !state.coolifyAppMatch,
    // isPrivate resolution order:
    //   1. Detected remote visibility (`gh repo view`) — authoritative
    //      when an origin is set on a GitHub repo.
    //   2. Fallback: true. Reasoning: if adopt is creating a fresh
    //      repo we're using `--private`; if an existing repo's
    //      visibility couldn't be probed (gh not authed / not on
    //      GitHub), assuming private is safer because Coolify's
    //      private path with a configured GitHub App also clones
    //      public repos fine, but the public path can't pull a
    //      private one and produces "permission denied" on deploy.
    isPrivate: state.gitRemoteIsPrivate ?? true,
    appPort: "3000",
    // Pipeline scaffold defaults OFF when the layout is unrecognised.
    // The Dockerfile templates assume a single-package project rooted
    // at /; for a workspace with no standard server/client dirs the
    // generated files build the wrong thing (or nothing). User can
    // still flip this on in the review loop — buildAdoptGroups parks
    // the cursor on the row in this case so the choice is explicit.
    scaffoldBuildPipeline: !state.unknownWorkspaceLayout,
    // Provisioning is opt-in. Each service mints real resources on a
    // third-party (GlitchTip project, OpenPanel project, Resend API
    // key) and cleaning those up after the fact is a chore — better
    // to require an explicit tick than to surprise the user with three
    // new clients they didn't ask for. The user opens the "Provision
    // clients" row and ticks whichever they want.
    services: [],
    // Default the push only when there's already a Coolify app to push to.
    // When wireCoolify creates a fresh app, it sets the baseline env
    // itself (including the dotenvx key), so a separate push is
    // redundant in that branch.
    pushKey: !!state.coolifyAppMatch,
  };

  // When the plan starts in gh-pages mode (from a `--resume` of an
  // earlier adopt, or a manifest the user committed by hand), run
  // the heuristics once up front. Block before even entering the
  // review loop on findings that would make Pages refuse to build —
  // the user needs to either fix the project or switch back to
  // coolify. The edit-step handler runs the same check when the
  // user *switches into* gh-pages from inside the loop, so this
  // covers the gap where they never edit the deploymentMode row.
  if (plan.deploymentMode === "gh-pages") {
    const { detectPagesIncompatibilities, hasBlockingFinding } = await import(
      "./scaffold/pages-heuristics.js"
    );
    const findings = detectPagesIncompatibilities(state.projectDir);
    if (findings.length > 0) {
      console.log(chalk.bold("\n  Pages compatibility findings:\n"));
      for (const f of findings) {
        const tag =
          f.level === "block"
            ? chalk.red("✗ block")
            : f.level === "warn"
              ? chalk.yellow("! warn")
              : chalk.dim("· info");
        console.log(`  ${tag}  ${chalk.bold(f.title)}`);
        console.log(chalk.dim(`         ${f.detail}`));
        for (const ev of f.evidence) {
          console.log(chalk.dim(`         → ${ev}`));
        }
      }
      console.log();
      if (hasBlockingFinding(findings)) {
        console.log(
          chalk.red(
            "  Blocking findings — Pages can't host this project as-is. Fix the issues above\n" +
              "  or pick a different deployment mode in the review screen.",
          ),
        );
      }
    }
  }

  plan = await reviewLoop(state, plan);

  // Re-check after the review loop in case the user kept (or switched
  // back to) gh-pages despite blockers being present. The edit handler
  // refuses the switch into gh-pages over blockers, but it can't catch
  // the case where blockers exist on entry AND the user stays put.
  if (plan.deploymentMode === "gh-pages") {
    const { detectPagesIncompatibilities, hasBlockingFinding } = await import(
      "./scaffold/pages-heuristics.js"
    );
    const findings = detectPagesIncompatibilities(state.projectDir);
    if (hasBlockingFinding(findings)) {
      throw new Error(
        "Pages compatibility blockers still present — refusing to adopt with gh-pages mode. Fix the issues listed above or re-run adopt and pick coolify/scaffold-only.",
      );
    }
  }

  await executePlan(state, plan, {
    resume: !!opts.resume,
    regeneratePipeline: !!opts.regeneratePipeline,
  });
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export async function detectProject(projectDir: string): Promise<DetectedState> {
  const hasManifest = existsSync(join(projectDir, MANIFEST_FILENAME));
  const existingManifest = hasManifest ? (readManifest(projectDir) ?? undefined) : undefined;

  let packageName: string | undefined;
  let packageDescription: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8")) as {
      name?: string;
      description?: string;
    };
    packageName = pkg.name?.replace(/^@[^/]+\//, ""); // strip scope
    const descCandidate = pkg.description?.trim();
    // Skip the description if it would fail Coolify's validator —
    // better to surface an empty default than to ask the user to
    // strip a `:` out of their package.json on every adopt run.
    if (descCandidate && validateCoolifyDescription(descCandidate) === true) {
      packageDescription = descCandidate;
    }
  } catch {
    // No package.json at root — that's fine for a non-Node project.
  }

  // Workspace markers — pnpm, yarn/npm, turbo, lerna, rush. When a
  // marker is present but the standard server/client dir scan below
  // turns up nothing, we're looking at a layout the scaffolder's
  // surface-based Dockerfile templates can't handle. Flagged below as
  // `unknownWorkspaceLayout`.
  const workspaceMarkers = [
    "pnpm-workspace.yaml",
    "pnpm-workspace.yml",
    "turbo.json",
    "lerna.json",
    "rush.json",
  ];
  let hasWorkspaceMarker = workspaceMarkers.some((f) => existsSync(join(projectDir, f)));
  if (!hasWorkspaceMarker) {
    // npm/yarn workspaces live as a `workspaces` field inside the root
    // package.json (string array or { packages: [...] } object).
    try {
      const rootPkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8")) as {
        workspaces?: unknown;
      };
      if (rootPkg.workspaces) hasWorkspaceMarker = true;
    } catch {
      // No / unreadable root package.json — leave hasWorkspaceMarker false.
    }
  }

  // Walk a generous set of common monorepo layouts.
  const serverDir = firstExisting(projectDir, [
    "packages/server",
    "apps/server",
    "apps/api",
    "apps/backend",
    "server",
    "backend",
    "api",
    "src/server",
    "services/server",
  ]);
  const clientDir = firstExisting(projectDir, [
    "packages/client",
    "packages/web",
    "packages/frontend",
    "apps/web",
    "apps/client",
    "apps/frontend",
    "client",
    "frontend",
    "web",
    "src/client",
  ]);

  // Feature detection: cheap heuristics from package.json deps + env files.
  const features = detectFeatures(projectDir, serverDir);

  // dotenvx state. The encrypted file starts with a generated header
  // + a DOTENV_PUBLIC_KEY_PRODUCTION line; .env.keys has the private
  // key. Either being present means we're already in dotenvx land.
  const prodEnvPath = serverDir
    ? join(serverDir, ".env.production")
    : join(projectDir, ".env.production");
  const envKeysPath = serverDir ? join(serverDir, ".env.keys") : join(projectDir, ".env.keys");
  let prodEnvIsEncrypted = false;
  if (existsSync(prodEnvPath)) {
    const head = readFileSync(prodEnvPath, "utf-8").slice(0, 2000);
    prodEnvIsEncrypted = /DOTENV_PUBLIC_KEY_PRODUCTION/.test(head);
  }
  const hasEnvKeys = existsSync(envKeysPath);

  // Coolify probes — best-effort, requires Coolify configured. If
  // it isn't, leave fields undefined; the user can still adopt without it.
  // The two probes (apps + GitHub sources) are independent, so run
  // them in parallel to keep detection latency in line with one call.
  let coolifyAppMatch: { uuid: string; name: string } | undefined;
  let coolifyConfigured = false;
  let coolifyGithubSourceCount: number | undefined;
  try {
    const cfg = await getCoolifyConfig();
    if (cfg) {
      coolifyConfigured = true;
      const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
      const [apps, sources] = await Promise.all([
        api.listApplications(),
        api.listGithubSources().catch(() => []),
      ]);
      coolifyGithubSourceCount = sources.length;
      if (packageName) {
        const wanted = [
          packageName,
          `${packageName}-server`,
          `${packageName}-client`,
          `${packageName}-web`,
        ];
        const match = apps.find((a) => wanted.includes(a.name));
        if (match) coolifyAppMatch = { uuid: match.uuid, name: match.name };
      }
    }
  } catch {
    // Best-effort only.
  }

  // Git state — is this a repo? Does it already have an origin remote?
  // We only auto-init + create a remote when the user opts in via the
  // stepper; here we just gather state for the summary.
  const isGitRepo = existsSync(join(projectDir, ".git"));
  let gitRemoteUrl: string | undefined;
  if (isGitRepo) {
    try {
      const res = await exec("git", ["remote", "get-url", "origin"], {
        cwd: projectDir,
        // No spinner — this is a sub-second silent check.
      });
      const url = res.stdout.trim();
      if (res.exitCode === 0 && url) gitRemoteUrl = url;
    } catch {
      // Either no `origin` set yet (exit 128) or git failed — fine.
    }
  }

  // Repo visibility on GitHub. Drives whether Coolify clones via
  // HTTPS (public) or via a GitHub App's SSH deploy key (private).
  // Picking the wrong path is the most common cause of "Permission
  // denied (publickey)" deploy failures — Coolify tries SSH against
  // a repo whose GitHub App isn't installed. We probe via `gh` here
  // (cheap, authenticated), default the stepper from it, and let the
  // user override.
  let gitRemoteIsPrivate: boolean | undefined;
  if (gitRemoteUrl) {
    try {
      const res = await exec("gh", ["repo", "view", "--json", "visibility", "-q", ".visibility"], {
        cwd: projectDir,
        silent: true,
      });
      if (res.exitCode === 0) {
        const v = res.stdout.trim().toLowerCase();
        // GitHub returns "PUBLIC" / "PRIVATE" / "INTERNAL". Internal
        // repos (GitHub Enterprise) require auth like private ones,
        // so treat as private for the Coolify-clone-path decision.
        if (v === "public") gitRemoteIsPrivate = false;
        else if (v) gitRemoteIsPrivate = true;
      }
    } catch {
      // gh not installed / not authed / repo not on GitHub — leave
      // undefined and let the stepper fall back to a sensible default.
    }
  }

  const unknownWorkspaceLayout = hasWorkspaceMarker && !serverDir && !clientDir;
  const standaloneBuildCandidates = unknownWorkspaceLayout
    ? findStandaloneBuildCandidates(projectDir)
    : [];

  return {
    projectDir,
    packageName,
    packageDescription,
    hasManifest,
    serverDir,
    clientDir,
    unknownWorkspaceLayout,
    standaloneBuildCandidates,
    features,
    prodEnvIsEncrypted,
    hasEnvKeys,
    coolifyAppMatch,
    coolifyConfigured,
    coolifyGithubSourceCount,
    isGitRepo,
    gitRemoteUrl,
    gitRemoteIsPrivate,
    existingManifest,
  };
}

/** Scan first-level subdirs for a standalone-buildable project — own
 *  `package.json` AND its own lockfile (the marker that pnpm/npm/yarn
 *  would install it independently of the parent workspace). `.npmrc`
 *  with `ignore-workspace=true` is a stronger signal: that's the
 *  explicit "treat me as standalone" toggle Docusaurus / marketing
 *  sites use when they live next to a CLI workspace.
 *
 *  Returns first-level matches only; we don't recurse because the
 *  intent is "show the user a starting point", not enumerate every
 *  buildable subtree. */
function findStandaloneBuildCandidates(
  projectDir: string,
): Array<{ dir: string; hasIgnoreWorkspace: boolean }> {
  const out: Array<{ dir: string; hasIgnoreWorkspace: boolean }> = [];
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const dir = join(projectDir, name);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (!existsSync(join(dir, "package.json"))) continue;
    const hasOwnLockfile =
      existsSync(join(dir, "pnpm-lock.yaml")) ||
      existsSync(join(dir, "package-lock.json")) ||
      existsSync(join(dir, "yarn.lock"));
    if (!hasOwnLockfile) continue;
    let hasIgnoreWorkspace = false;
    try {
      const npmrc = readFileSync(join(dir, ".npmrc"), "utf-8");
      hasIgnoreWorkspace = /^\s*ignore-workspace\s*=\s*true\s*$/m.test(npmrc);
    } catch {
      // No .npmrc — still a candidate (own lockfile is the main signal).
    }
    out.push({ dir, hasIgnoreWorkspace });
  }
  return out;
}

function firstExisting(root: string, candidates: string[]): string | undefined {
  for (const c of candidates) {
    const full = join(root, c);
    if (existsSync(full)) return full;
  }
  return undefined;
}

function detectFeatures(projectDir: string, serverDir: string | undefined): Feature[] {
  const found = new Set<Feature>();

  // Cast a wider net than just <root> + <serverDir>: also walk the
  // first level of the common monorepo package roots so a project
  // organized as e.g. `apps/web` + `apps/server` doesn't end up with
  // "no features detected" when serverDir resolves to a sibling.
  const pkgJsonPaths = new Set<string>();
  pkgJsonPaths.add(join(projectDir, "package.json"));
  if (serverDir) pkgJsonPaths.add(join(serverDir, "package.json"));
  for (const root of ["packages", "apps", "services"]) {
    const dir = join(projectDir, root);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) pkgJsonPaths.add(join(dir, e, "package.json"));
  }

  for (const p of pkgJsonPaths) {
    if (!existsSync(p)) continue;
    let json: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    try {
      json = JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      continue;
    }
    const deps = {
      ...(json.dependencies ?? {}),
      ...(json.devDependencies ?? {}),
      ...(json.peerDependencies ?? {}),
      ...(json.optionalDependencies ?? {}),
    };
    if ("stripe" in deps || "@stripe/stripe-js" in deps || "@stripe/react-stripe-js" in deps) {
      found.add("stripe");
    }
    if ("socket.io" in deps || "socket.io-client" in deps || "ws" in deps) {
      found.add("websocket");
    }
    if (
      "@sentry/node" in deps ||
      "@sentry/browser" in deps ||
      "@sentry/react" in deps ||
      "@sentry/nextjs" in deps ||
      "@openpanel/web" in deps ||
      "@openpanel/sdk" in deps ||
      "@openpanel/nextjs" in deps
    ) {
      found.add("analytics");
    }
    if ("@aws-sdk/client-s3" in deps || "minio" in deps) found.add("s3");
    if ("electron" in deps || "electron-builder" in deps) found.add("desktop");
    if ("@capacitor/core" in deps || "@capacitor/cli" in deps) found.add("mobile");
  }

  // .env.production / .env.example as a hint when package.json is sparse.
  const envHints = [
    serverDir ? join(serverDir, ".env.production") : undefined,
    serverDir ? join(serverDir, ".env.example") : undefined,
    join(projectDir, ".env.example"),
  ].filter((p): p is string => !!p);
  for (const p of envHints) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf-8");
    if (/STRIPE_SECRET_KEY/.test(text)) found.add("stripe");
    if (/REDIS_URL/.test(text)) found.add("websocket");
    if (/GLITCHTIP_DSN|SENTRY_DSN|OPENPANEL_/.test(text)) found.add("analytics");
    if (/S3_BUCKET|S3_ENDPOINT/.test(text)) found.add("s3");
  }

  return [...found];
}

function printDetected(state: DetectedState): void {
  const lines: string[] = [];
  const row = (label: string, value: string) => `  ${chalk.dim(label.padEnd(18))} ${value}`;

  lines.push(chalk.bold("\n  Detected:\n"));
  lines.push(row("project dir", chalk.cyan(relativeTo(state.projectDir))));
  if (state.packageName) lines.push(row("package.json", chalk.cyan(state.packageName)));
  if (state.packageDescription) {
    lines.push(row("description", chalk.dim(`"${truncate(state.packageDescription, 60)}"`)));
  }
  if (state.serverDir) {
    lines.push(row("server dir", chalk.cyan(relativeTo(state.serverDir))));
  } else {
    lines.push(row("server dir", chalk.dim("(not detected — falls back to project root)")));
  }
  if (state.clientDir) {
    lines.push(row("client dir", chalk.cyan(relativeTo(state.clientDir))));
  }
  lines.push(
    row(
      ".env.production",
      state.prodEnvIsEncrypted
        ? chalk.green("dotenvx-encrypted ✓")
        : state.serverDir && existsSync(join(state.serverDir, ".env.production"))
          ? chalk.yellow("present, plain text — will encrypt")
          : chalk.dim("not present"),
    ),
  );
  lines.push(row(".env.keys", state.hasEnvKeys ? chalk.green("present ✓") : chalk.dim("missing")));
  lines.push(
    row(
      "Coolify app",
      state.coolifyAppMatch
        ? chalk.green(`${state.coolifyAppMatch.name} ✓`)
        : chalk.dim("(no match)"),
    ),
  );
  // Only show the GitHub-App row when Coolify is configured AND the
  // count is zero — having sources is the boring expected state and
  // doesn't need a row of its own. Zero is the case worth surfacing
  // because it'll bite at execute time for private repos.
  if (state.coolifyConfigured && state.coolifyGithubSourceCount === 0) {
    lines.push(
      row("Coolify sources", chalk.yellow("no GitHub Apps installed — required for private repos")),
    );
  }
  lines.push(
    row(
      "git remote",
      state.gitRemoteUrl
        ? chalk.green(state.gitRemoteUrl)
        : state.isGitRepo
          ? chalk.yellow("repo present, no `origin` set")
          : chalk.dim("not a git repo yet"),
    ),
  );
  lines.push(
    row(
      "features (guess)",
      state.features.length > 0 ? state.features.join(", ") : chalk.dim("none detected"),
    ),
  );
  if (state.unknownWorkspaceLayout) {
    lines.push("");
    lines.push(
      chalk.yellow(
        "  ! Workspace marker detected (pnpm-workspace.yaml / workspaces / turbo / lerna)",
      ),
    );
    lines.push(
      chalk.yellow("    but no standard server/client dir matched. Adopt will skip the Docker"),
    );
    lines.push(
      chalk.yellow("    + GH Actions pipeline scaffold — the templates assume a single-package"),
    );
    lines.push(chalk.yellow("    project and would build the wrong thing here."));
    if (state.standaloneBuildCandidates.length > 0) {
      lines.push("");
      lines.push(chalk.dim("    Standalone-buildable subdirs (own lockfile):"));
      for (const c of state.standaloneBuildCandidates) {
        const tag = c.hasIgnoreWorkspace ? chalk.green("  ignore-workspace=true") : "";
        lines.push(chalk.dim(`      · ${relativeTo(c.dir)}${tag}`));
      }
      lines.push(
        chalk.dim("    Point a hand-authored Dockerfile at one of those and re-run adopt."),
      );
    }
  }
  for (const l of lines) console.log(l);
  console.log();
}

// ---------------------------------------------------------------------------
// Review stepper — same shape as runOnboarding's setup stepper
// ---------------------------------------------------------------------------

interface AdoptStep {
  key: string;
  label: string;
  set: boolean;
  summary: string;
}
interface AdoptStepGroup {
  title: string;
  steps: AdoptStep[];
}

async function reviewLoop(state: DetectedState, initial: AdoptPlan): Promise<AdoptPlan> {
  let plan = initial;
  console.log(
    chalk.dim("  Step through each row to confirm or change. Choose 'Adopt' when ready.\n"),
  );
  for (;;) {
    const groups = buildAdoptGroups(state, plan);
    const allSteps = groups.flatMap((g) => g.steps);

    const firstUnset = allSteps.find((s) => !s.set);
    const defaultKey = firstUnset?.key ?? "__adopt__";

    const choices: Array<Separator | { name: string; value: string }> = [];
    for (const group of groups) {
      choices.push(new Separator(chalk.bold(`── ${group.title} ──`)));
      for (const step of group.steps) {
        const mark = step.set ? chalk.green("✓") : chalk.dim("·");
        choices.push({
          name: `${mark}  ${step.label.padEnd(18)}${chalk.dim(` — ${step.summary}`)}`,
          value: step.key,
        });
      }
    }
    choices.push(new Separator(" "));
    choices.push({
      name: chalk.bold(chalk.green("✓  Adopt — apply changes")),
      value: "__adopt__",
    });
    choices.push({ name: chalk.dim("✗  Cancel"), value: "__cancel__" });

    const picked = await select<string>({
      message: "Next step:",
      default: defaultKey,
      pageSize: Math.min(30, choices.length),
      choices,
    });

    if (picked === "__adopt__") return plan;
    if (picked === "__cancel__") {
      console.log(chalk.dim("\n  Cancelled. Nothing was changed.\n"));
      throw new Error("Adopt cancelled by user");
    }
    plan = await editAdoptStep(state, plan, picked);
  }
}

function buildAdoptGroups(state: DetectedState, plan: AdoptPlan): AdoptStepGroup[] {
  return [
    {
      title: "Project",
      steps: [
        { key: "name", label: "Project name", set: !!plan.name, summary: plan.name || "(unset)" },
        {
          key: "domain",
          label: "Domain",
          set: !!plan.domain,
          summary: plan.domain
            ? `${plan.domain}  ${chalk.dim("→")}  https://${plan.domain}`
            : "(unset)",
        },
        ((): AdoptStep => {
          // Description is optional — empty is a valid choice that
          // falls back to the generic "Adopted by hatchkit" blurb.
          // We always render it as `set: true` so the cursor doesn't
          // park on it; the user opens it explicitly when they care.
          const summary = plan.description
            ? truncate(plan.description, 60)
            : state.packageDescription
              ? chalk.dim(
                  `(empty — defaults from package.json: "${truncate(state.packageDescription, 40)}")`,
                )
              : chalk.dim('(empty — defaults to "Adopted by hatchkit")');
          return { key: "description", label: "Description", set: true, summary };
        })(),
      ],
    },
    {
      title: "Layout",
      steps: [
        // The Surfaces choice has three confidence levels:
        //   · manifest persisted   → user already confirmed it once
        //   · disk layout obvious  → detection found server/ or
        //                            client/ dirs (or both)
        //   · ambiguous            → neither — we GUESS client-only
        //                            but want the user to confirm
        // `set: false` in the ambiguous case parks the cursor on this
        // step on first render so the user sees + confirms the guess
        // before hitting Adopt. See the inference comment in runAdopt
        // for the matching default.
        ((): AdoptStep => {
          const hasManifestSurfaces = !!state.existingManifest?.surfaces;
          const detectionWasDefinitive = !!(state.serverDir || state.clientDir);
          const inferred = !hasManifestSurfaces && !detectionWasDefinitive;
          const baseSummary =
            plan.surfaces === "server-only"
              ? "server only (backend / API)"
              : plan.surfaces === "client-only"
                ? "client only (static / SPA — no backend)"
                : "server + client";
          return {
            key: "surfaces",
            label: "Surfaces",
            set: !inferred,
            summary: inferred ? `${baseSummary}  ${chalk.dim("(guess — confirm)")}` : baseSummary,
          };
        })(),
        // Only show the env-dir rows that are actually relevant for
        // the chosen surface. Hiding instead of greying-out keeps the
        // stepper consistent with the surfaces choice and avoids the
        // "checkmark on a thing I can't unset" UX trap.
        ...(plan.surfaces !== "client-only"
          ? [
              {
                key: "serverDir",
                label: "Server env dir",
                set: !!plan.serverDir,
                summary: plan.serverDir ? relativeTo(plan.serverDir) : "(unset)",
              },
            ]
          : []),
        ...(plan.surfaces !== "server-only"
          ? [
              {
                key: "clientDir",
                label: "Client env dir",
                set: !!plan.clientDir,
                summary: plan.clientDir ? relativeTo(plan.clientDir) : "(unset)",
              },
            ]
          : []),
      ],
    },
    {
      title: "Stack",
      steps: [
        {
          key: "features",
          label: "Features",
          set: true,
          summary: plan.features.length > 0 ? plan.features.join(", ") : chalk.dim("none"),
        },
      ],
    },
    {
      title: "Bootstrap",
      steps: [
        {
          key: "bootstrapDotenvx",
          label: "Initialize dotenvx",
          set: true,
          summary: plan.bootstrapDotenvx
            ? state.prodEnvIsEncrypted
              ? chalk.dim("already encrypted — will skip")
              : "yes — generate keypair + encrypt .env.production"
            : chalk.dim("no"),
        },
        {
          key: "setupGitHub",
          label: "GitHub remote",
          set: true,
          summary: plan.setupGitHub
            ? state.gitRemoteUrl
              ? chalk.dim("already set — will skip")
              : "yes — `gh repo create` + push"
            : state.gitRemoteUrl
              ? chalk.dim(state.gitRemoteUrl)
              : chalk.dim("no"),
        },
      ],
    },
    // The Docker + GH Actions pipeline is Coolify-targeted (it
    // configures the redeploy webhook + builds an image). gh-pages
    // ships its own workflow that uploads to Pages instead, so we
    // hide this group when the user picks Pages.
    ...(plan.deploymentMode === "coolify"
      ? [
          {
            title: "Build pipeline",
            steps: [
              {
                key: "scaffoldBuildPipeline",
                label: "Docker + GH Actions",
                // Park cursor here when the layout is unrecognised — the
                // user should make an explicit yes/no rather than walk
                // past a defaulted-off row without seeing it.
                set: !state.unknownWorkspaceLayout,
                summary: renderBuildPipelineSummary(state, plan),
              },
            ],
          },
        ]
      : []),
    {
      title: "Deploy",
      steps: [
        // Top-line choice: where this project deploys. Hides the
        // Coolify-specific rows when set to gh-pages.
        {
          key: "deploymentMode",
          label: "Deployment mode",
          set: true,
          summary: renderAdoptDeploymentModeSummary(plan.deploymentMode, plan.surfaces),
        },
        // Coolify-specific rows — only shown when actually deploying
        // to Coolify. gh-pages skips this branch entirely.
        ...(plan.deploymentMode === "coolify"
          ? ([
              ((): AdoptStep => {
                // Visibility row. Picking the wrong path here is the #1
                // cause of "Permission denied (publickey)" deploy failures
                // (Coolify tries SSH against a repo whose GitHub App isn't
                // installed). Mark `set: false` when we couldn't auto-detect
                // visibility from `gh repo view`, so the cursor parks on it.
                const detected = state.gitRemoteIsPrivate;
                const summaryBase = plan.isPrivate
                  ? "private — Coolify clones via GitHub App SSH key"
                  : "public — Coolify clones via HTTPS";
                const detectedHint =
                  detected === undefined && state.gitRemoteUrl
                    ? chalk.dim(" (couldn't auto-detect — confirm)")
                    : detected !== undefined && detected !== plan.isPrivate
                      ? chalk.yellow(` (gh says ${detected ? "private" : "public"} — overridden)`)
                      : "";
                return {
                  key: "isPrivate",
                  label: "Repo visibility",
                  set: !(detected === undefined && !!state.gitRemoteUrl),
                  summary: `${summaryBase}${detectedHint}`,
                };
              })(),
              ((): AdoptStep => {
                const missingSource =
                  plan.wireCoolify &&
                  plan.isPrivate &&
                  state.coolifyConfigured &&
                  state.coolifyGithubSourceCount === 0;
                const baseSummary = plan.wireCoolify
                  ? state.coolifyAppMatch
                    ? chalk.dim(
                        `existing app "${state.coolifyAppMatch.name}" — will reconcile build pack`,
                      )
                    : `yes — create app + upsert DNS (port ${plan.appPort})`
                  : state.coolifyAppMatch
                    ? chalk.dim(`already exists: ${state.coolifyAppMatch.name}`)
                    : chalk.dim("no");
                return {
                  key: "wireCoolify",
                  label: "Coolify + DNS",
                  set: !missingSource,
                  summary: missingSource
                    ? `${baseSummary}  ${chalk.yellow("(needs Coolify GitHub App — install one or set visibility to public)")}`
                    : baseSummary,
                };
              })(),
            ] satisfies AdoptStep[])
          : []),
      ],
    },
    {
      title: "Provisioning",
      steps: [
        {
          key: "services",
          label: "Provision clients",
          set: true,
          summary:
            plan.services.length > 0 ? plan.services.join(", ") : chalk.dim("skip provisioning"),
        },
        // `pushKey` only matters when a Coolify app is the deploy
        // target — Pages reads no secrets from a Coolify env, so the
        // row would just be noise on the gh-pages path.
        ...(plan.deploymentMode === "coolify"
          ? [
              {
                key: "pushKey",
                label: "Push key to Coolify",
                set: true,
                summary: plan.pushKey
                  ? state.coolifyAppMatch
                    ? `yes (${state.coolifyAppMatch.name})`
                    : "yes — Coolify app must exist by name"
                  : chalk.dim("no"),
              },
            ]
          : []),
      ],
    },
  ];
}

function renderAdoptDeploymentModeSummary(
  mode: AdoptDeploymentMode,
  surfaces: AdoptSurface,
): string {
  switch (mode) {
    case "coolify":
      return "Coolify (full-stack on Hetzner)";
    case "gh-pages":
      return surfaces === "client-only"
        ? "GitHub Pages (static)"
        : chalk.yellow("GitHub Pages — needs surfaces=client-only");
    case "scaffold-only":
      return "scaffold only (no deploy)";
  }
}

async function editAdoptStep(
  state: DetectedState,
  plan: AdoptPlan,
  step: string,
): Promise<AdoptPlan> {
  if (step === "name") {
    const name = (
      await input({
        message: "Project name (used for the Coolify app, manifest, keychain):",
        default: plan.name || state.packageName,
        validate: validateProjectName,
      })
    ).trim();
    return { ...plan, name };
  }
  if (step === "domain") {
    const domain = (
      await input({
        message: "Domain (e.g. ai.trebeljahr.com):",
        default: plan.domain,
        validate: validateDomain,
      })
    ).trim();
    return { ...plan, domain };
  }
  if (step === "description") {
    // Default order matches the plan-init resolution: existing value
    // wins, else fall back to the package.json one-liner. Empty input
    // is a valid choice — it tells wireProjectIntoCoolify to use its
    // built-in "Adopted by hatchkit" default on create and leave any
    // existing Coolify description alone on reconcile.
    const description = (
      await input({
        message: 'Description shown on Coolify (leave empty for "Adopted by hatchkit"):',
        default: plan.description || state.packageDescription || "",
        validate: validateCoolifyDescription,
      })
    ).trim();
    return { ...plan, description };
  }
  if (step === "surfaces") {
    const next = await select<AdoptSurface>({
      message: "What kind of project is this?",
      choices: [
        { name: "Server only (backend / API)", value: "server-only" },
        { name: "Client only (static site / SPA — no backend)", value: "client-only" },
        { name: "Server + client (both)", value: "both" },
      ],
      default: plan.surfaces,
    });
    // Adjust the dir fields when the surface changes — dropping
    // server/client dirs that are no longer relevant, and setting
    // sane defaults for newly-relevant ones.
    // Also: switching away from client-only invalidates gh-pages
    // (Pages can't host a backend). Snap deploymentMode back to
    // coolify in that case so the user doesn't keep an invalid combo.
    const nextDeploymentMode: AdoptDeploymentMode =
      plan.deploymentMode === "gh-pages" && next !== "client-only"
        ? "coolify"
        : plan.deploymentMode;
    if (plan.deploymentMode === "gh-pages" && next !== "client-only") {
      console.log(
        chalk.yellow(
          "  ⚠ gh-pages requires client-only surfaces — switched deployment mode back to coolify.",
        ),
      );
    }
    return {
      ...plan,
      surfaces: next,
      deploymentMode: nextDeploymentMode,
      serverDir:
        next === "client-only"
          ? undefined
          : (plan.serverDir ?? state.serverDir ?? state.projectDir),
      clientDir:
        next === "server-only"
          ? undefined
          : (plan.clientDir ?? state.clientDir ?? state.projectDir),
    };
  }
  if (step === "deploymentMode") {
    const choices: Array<{ name: string; value: AdoptDeploymentMode }> = [
      { name: "Coolify (full-stack on Hetzner)", value: "coolify" },
    ];
    if (plan.surfaces === "client-only") {
      choices.push({ name: "GitHub Pages (static)", value: "gh-pages" });
    }
    choices.push({ name: "Scaffold only — don't deploy", value: "scaffold-only" });

    const next = await select<AdoptDeploymentMode>({
      message: "Where do you want to deploy?",
      choices,
      default: plan.deploymentMode,
    });

    // When switching INTO gh-pages, run the static-site sanity checks
    // and surface any blockers before letting the user proceed. They
    // can still pick gh-pages over a "warn" finding, but "block"
    // (e.g. Next without `output: "export"`) requires they either fix
    // the project first or step back to coolify.
    if (next === "gh-pages" && plan.deploymentMode !== "gh-pages") {
      const { detectPagesIncompatibilities, hasBlockingFinding } = await import(
        "./scaffold/pages-heuristics.js"
      );
      const findings = detectPagesIncompatibilities(state.projectDir);
      if (findings.length > 0) {
        console.log(chalk.bold("\n  Pages compatibility findings:\n"));
        for (const f of findings) {
          const tag =
            f.level === "block"
              ? chalk.red("✗ block")
              : f.level === "warn"
                ? chalk.yellow("! warn")
                : chalk.dim("· info");
          console.log(`  ${tag}  ${chalk.bold(f.title)}`);
          console.log(chalk.dim(`         ${f.detail}`));
          for (const ev of f.evidence) {
            console.log(chalk.dim(`         → ${ev}`));
          }
        }
        console.log();
        if (hasBlockingFinding(findings)) {
          console.log(
            chalk.red(
              "  Blocking findings present — Pages won't be able to host this project as-is.",
            ),
          );
          console.log(chalk.dim("  Fix the issues above (or stay on coolify) and re-pick."));
          // Don't switch — leave plan.deploymentMode unchanged.
          return plan;
        }
        const proceed = await confirm({
          message: "Proceed with gh-pages despite the warnings?",
          default: false,
        });
        if (!proceed) return plan;
      }
    }
    return { ...plan, deploymentMode: next };
  }
  if (step === "serverDir") {
    const picked = (
      await input({
        message: "Server env directory (relative to project root):",
        default: plan.serverDir ? relative(state.projectDir, plan.serverDir) || "." : ".",
        validate: (v) => {
          const abs = join(state.projectDir, v.trim());
          return existsSync(abs) ? true : `No such directory: ${abs}`;
        },
      })
    ).trim();
    return { ...plan, serverDir: join(state.projectDir, picked) };
  }
  if (step === "clientDir") {
    // For client-only / both surfaces this row IS the env dir prompt.
    // No extra "do you have a client?" yes/no — the surfaces step is
    // where that decision lives now.
    const picked = (
      await input({
        message: "Client env directory (relative to project root):",
        default: plan.clientDir
          ? relative(state.projectDir, plan.clientDir) || "."
          : "packages/client",
        validate: (v) => {
          const abs = join(state.projectDir, v.trim());
          return existsSync(abs) ? true : `No such directory: ${abs}`;
        },
      })
    ).trim();
    return { ...plan, clientDir: join(state.projectDir, picked) };
  }
  if (step === "features") {
    const features = await multiselect<Feature>({
      message: "Features active in this project:",
      choices: [
        { name: "websocket", value: "websocket", checked: plan.features.includes("websocket") },
        { name: "stripe", value: "stripe", checked: plan.features.includes("stripe") },
        { name: "analytics", value: "analytics", checked: plan.features.includes("analytics") },
        { name: "s3", value: "s3", checked: plan.features.includes("s3") },
        { name: "desktop", value: "desktop", checked: plan.features.includes("desktop") },
        { name: "mobile", value: "mobile", checked: plan.features.includes("mobile") },
      ],
    });
    return { ...plan, features };
  }
  if (step === "services") {
    const services = await multiselect<ProvisionService>({
      message: "Provision per-project clients now?",
      choices: [
        {
          name: "GlitchTip (error tracking)",
          value: "glitchtip",
          checked: plan.services.includes("glitchtip"),
        },
        {
          name: "OpenPanel (analytics)",
          value: "openpanel",
          checked: plan.services.includes("openpanel"),
        },
        {
          name: "Resend (transactional email)",
          value: "resend",
          checked: plan.services.includes("resend"),
        },
        {
          name: "Email forwarding (Cloudflare Email Routing → your inbox)",
          value: "email",
          checked: plan.services.includes("email"),
        },
      ],
    });
    return { ...plan, services };
  }
  if (step === "pushKey") {
    const pushKey = await confirm({
      message: state.coolifyAppMatch
        ? `Push dotenvx private key to Coolify (${state.coolifyAppMatch.name})?`
        : "Push dotenvx private key to Coolify (app must exist by project name)?",
      default: plan.pushKey,
    });
    return { ...plan, pushKey };
  }
  if (step === "bootstrapDotenvx") {
    const bootstrapDotenvx = await confirm({
      message: state.prodEnvIsEncrypted
        ? ".env.production is already encrypted — re-encrypt anyway?"
        : "Initialize dotenvx (creates an encrypted .env.production + .env.keys)?",
      default: plan.bootstrapDotenvx,
    });
    return { ...plan, bootstrapDotenvx };
  }
  if (step === "setupGitHub") {
    if (state.gitRemoteUrl) {
      console.log(
        chalk.dim(`\n  origin already set to ${state.gitRemoteUrl} — adopt won't replace it.\n`),
      );
      return { ...plan, setupGitHub: false };
    }
    const setupGitHub = await confirm({
      message: state.isGitRepo
        ? "Create a GitHub repo and push this project to it?"
        : "Initialize git, create a GitHub repo, and push?",
      default: plan.setupGitHub,
    });
    return { ...plan, setupGitHub };
  }
  if (step === "scaffoldBuildPipeline") {
    const scaffoldBuildPipeline = await confirm({
      message:
        "Scaffold the build pipeline (Dockerfile / docker-compose.yml / GitHub Actions deploy.yml as needed)?",
      default: plan.scaffoldBuildPipeline,
    });
    return { ...plan, scaffoldBuildPipeline };
  }
  if (step === "wireCoolify") {
    const wireCoolify = await confirm({
      message: state.coolifyAppMatch
        ? `App "${state.coolifyAppMatch.name}" already exists — re-wire (reconciles build pack)?`
        : "Create a Coolify app + upsert DNS now?",
      default: plan.wireCoolify,
    });
    if (!wireCoolify) return { ...plan, wireCoolify };
    const appPort = (
      await input({
        message: "Container port the server listens on:",
        default: plan.appPort,
        validate: (v) => /^\d+$/.test(v.trim()) || "Must be an integer port number.",
      })
    ).trim();
    return { ...plan, wireCoolify, appPort };
  }
  if (step === "isPrivate") {
    const detected = state.gitRemoteIsPrivate;
    const detectedSuffix =
      detected === undefined ? "" : ` (gh detected: ${detected ? "private" : "public"})`;
    const isPrivate = await select<boolean>({
      message: `Coolify clone path for this repo${detectedSuffix}:`,
      choices: [
        {
          name: "Private — Coolify uses a configured GitHub App's SSH deploy key",
          value: true,
        },
        {
          name: "Public — Coolify clones over HTTPS (no auth)",
          value: false,
        },
      ],
      default: plan.isPrivate,
    });
    return { ...plan, isPrivate };
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** A step that didn't complete during executePlan. Surfaced at the
 *  end so the user sees one consolidated "what's missing + how to
 *  fix" block instead of having to scroll back through the run log. */
interface AdoptCaveat {
  title: string;
  /** One-line cause — usually the message from a caught error. */
  reason: string;
  /** Recovery recipe. Each entry becomes its own indented line. */
  recovery: string[];
}

/** Canonical env key per service — used by `filterServicesForResume`
 *  to decide whether a service's credentials are already wired into
 *  the project's env files. If the key is present, re-minting on a
 *  resume would orphan whatever's there (Resend mints a fresh API
 *  key each call; OpenPanel mints a fresh project; Stripe re-creates
 *  the webhook endpoint). `email` is intentionally absent — Email
 *  Routing is zone-state with no env footprint, and its provisioner
 *  is already 409-idempotent. */
const RESUME_SERVICE_ENV_KEY: Record<ProvisionService, { server?: string; client?: string }> = {
  glitchtip: { server: "GLITCHTIP_DSN", client: "PUBLIC_GLITCHTIP_DSN" },
  openpanel: { server: "OPENPANEL_CLIENT_ID", client: "PUBLIC_OPENPANEL_CLIENT_ID" },
  resend: { server: "RESEND_API_KEY" },
  s3: { server: "R2_ENDPOINT" },
  email: {},
};

/** Filter the services list for `runProvision` on `--resume`: drop
 *  every service whose canonical env keys are already in the target
 *  env files. A non-resume run returns the list unchanged. */
function filterServicesForResume(args: {
  services: ProvisionService[];
  resume: boolean;
  serverEnvPath: string | null;
  clientEnvPath: string | null;
}): ProvisionService[] {
  if (!args.resume) return args.services;
  const serverKeys = args.serverEnvPath ? readEnvKeys(args.serverEnvPath) : new Set<string>();
  const clientKeys = args.clientEnvPath ? readEnvKeys(args.clientEnvPath) : new Set<string>();
  const kept: ProvisionService[] = [];
  for (const svc of args.services) {
    const want = RESUME_SERVICE_ENV_KEY[svc];
    if (!want || (!want.server && !want.client)) {
      kept.push(svc);
      continue;
    }
    const serverOk = !want.server || serverKeys.has(want.server);
    const clientOk = !want.client || clientKeys.has(want.client);
    if (serverOk && clientOk) {
      const which = [want.server, want.client].filter(Boolean).join(" + ");
      console.log(
        chalk.dim(`  · Skipping ${svc} on --resume — ${which} already in .env.production.`),
      );
      continue;
    }
    kept.push(svc);
  }
  return kept;
}

async function executePlan(
  state: DetectedState,
  plan: AdoptPlan,
  opts: { resume: boolean; regeneratePipeline?: boolean } = { resume: false },
): Promise<void> {
  console.log(chalk.bold("\n  ── Adopting ──────────────────────────────────────────────\n"));
  const caveats: AdoptCaveat[] = [];

  // Run ledger — append-only record of mutations so a mid-flight
  // throw or a later `hatchkit destroy` can reverse just the things
  // adopt actually created. Each `record(...)` call is gated by a
  // "did this run create it (vs reuse)?" check captured BEFORE the
  // mutation, so the user's pre-existing repo / files / Coolify
  // resources never end up in the ledger. See cli/src/utils/run-ledger.ts.
  //
  // On --resume we preserve the previous attempt's ledger so undo
  // covers BOTH runs' mutations — otherwise a Coolify app the first
  // run created (and the second run finds-by-name and reuses) would
  // be invisible to a later destroy.
  const ledger = opts.resume ? RunLedger.resumeOrStart(plan.name) : RunLedger.start(plan.name);

  // Intercept Ctrl+C so partial adopt state gets the same recipe +
  // rollback prompt as a thrown error. Paired with the finally below.
  installCancelHandler(ledger, "adopt");

  let remoteUrl: string | undefined = state.gitRemoteUrl;
  let coolifyResult:
    | Awaited<ReturnType<typeof import("./deploy/coolify-app.js").wireProjectIntoCoolify>>
    | undefined;
  try {
    // Step 1: bootstrap / encrypt dotenvx so a key actually exists.
    if (plan.bootstrapDotenvx) {
      const dotenvxResult = await bootstrapDotenvxNow(state, plan);
      if (dotenvxResult.createdKeysFile) {
        // Only record the keys file when *this run* generated it.
        // A pre-existing .env.keys belongs to the user — never delete it.
        ledger.record({ kind: "dotenvxKeysFile", path: dotenvxResult.keysPath });
      }
    } else {
      console.log(chalk.dim("  · Skipping dotenvx bootstrap (per stepper choice)."));
    }

    // Step 1b: make sure .env.production is actually committed to git.
    // This runs regardless of whether bootstrap fired — projects
    // adopted on an earlier hatchkit release may have an encrypted
    // file that's been silently shadowed by a global gitignore the
    // whole time. See ensureEnvProductionCommitted for the gory
    // details on why a global `~/.config/git/ignore` for .env.production
    // is the most common culprit.
    await ensureEnvProductionCommitted(state, plan);
    const importResult = await importKeyToKeychain(state, plan);
    if (importResult.imported && importResult.created) {
      // Same gate: only record a keychain entry adopt itself just put
      // there. A pre-existing entry is owned by an earlier run.
      ledger.record({ kind: "keychain", account: importResult.account });
    }

    // Step 2: write the manifest. Done after key import so a partial
    // failure doesn't leave a manifest pointing at no key. The
    // manifest lives at the project ROOT (not under packages/server).
    const manifestPath = join(state.projectDir, MANIFEST_FILENAME);
    writeAdoptManifest(state.projectDir, plan);
    console.log(chalk.green(`  ✓ Wrote ${MANIFEST_FILENAME} at ${relativeTo(state.projectDir)}`));
    if (!state.hasManifest) {
      // Only on first-time adopt — `--resume` reuses the manifest the
      // earlier run created, so that earlier run's ledger (if any) is
      // the one responsible for cleanup.
      ledger.record({ kind: "manifest", path: manifestPath });
    }

    // Step 3: GitHub remote (init + create + push). Skipped if origin is
    // already set or the user opted out.
    if (plan.setupGitHub && !state.gitRemoteUrl) {
      const ghResult = await setupGitHubRemote(state, plan);
      remoteUrl = ghResult.url;
      // gitInit BEFORE github so that, on undo, the GitHub repo gets
      // deleted first — the local .git would still exist long enough
      // for the user to read the recipe / abort if they want.
      if (ghResult.gitInitialized) {
        ledger.record({ kind: "gitInit", path: join(state.projectDir, ".git") });
      }
      if (ghResult.repoSlug) {
        ledger.record({ kind: "github", repo: ghResult.repoSlug });
      }
    } else if (state.gitRemoteUrl) {
      console.log(chalk.dim(`  · git origin already set → ${state.gitRemoteUrl}`));
    }

    // Step 3a: Scaffold the build pipeline (Dockerfile + compose +
    // GitHub Actions workflow). Detection inside the scaffolder skips
    // anything that already exists, so this is idempotent across re-runs.
    // Must run BEFORE Coolify wiring so the docker-compose.yml exists
    // by the time Coolify clones the repo for the first deploy.
    //
    // Gated on coolify mode — the Coolify-targeted Dockerfile + deploy
    // webhook workflow aren't useful for gh-pages, which uses its own
    // `gh-pages.yml` workflow written later in step 3c-pages.
    let scaffoldedAbsPaths: string[] = [];
    let overwrittenAbsPaths: string[] = [];
    if (plan.scaffoldBuildPipeline && plan.deploymentMode === "coolify") {
      const pipeResult = await scaffoldBuildPipelineNow(state, plan, remoteUrl, {
        force: !!opts.regeneratePipeline,
      });
      scaffoldedAbsPaths = pipeResult.createdAbsPaths;
      overwrittenAbsPaths = pipeResult.overwrittenAbsPaths;
      // Record only files we *created*. The `overwritten` list is
      // deliberately not recorded — those files existed before this
      // run (the user's), and a later `hatchkit destroy` must never
      // delete pre-existing content even after we rewrote it for
      // them. Worst case post-destroy: the user is left with a
      // hatchkit-flavoured Dockerfile they can simply delete.
      for (const abs of pipeResult.createdAbsPaths) {
        ledger.record({ kind: "scaffoldedFile", path: abs });
      }
    }

    // Step 3b: Wire the repo into Coolify + DNS via direct API calls.
    // No infra/ submodule, no Terraform — just hits the Coolify and
    // DNS-provider REST endpoints with credentials we already have in
    // keychain. Idempotent on the DNS side (upsert); not yet on the
    // app-create side (Coolify accepts duplicate app names).
    //
    // Skipped for gh-pages — Pages handles its own DNS in step 3c-pages.
    if (plan.wireCoolify && plan.deploymentMode === "coolify" && remoteUrl) {
      try {
        const { wireProjectIntoCoolify } = await import("./deploy/coolify-app.js");
        coolifyResult = await wireProjectIntoCoolify({
          projectName: plan.name,
          domain: plan.domain,
          // Empty string → wireProjectIntoCoolify uses its built-in
          // default on create and leaves an existing description alone
          // on reconcile. Non-empty → patched onto both the Coolify
          // project and application records.
          description: plan.description || undefined,
          gitRepository: remoteUrl,
          // hatchkit's canonical pipeline = GitHub Actions builds image →
          // pushes to GHCR → Coolify pulls via docker-compose.yml. The
          // build-pipeline scaffold step (run earlier in this flow)
          // either kept the user's existing compose or wrote one
          // pointing at ghcr.io/<owner>/<name>:latest. Either way the
          // Coolify app reads docker-compose.yml from the repo root.
          buildPack: "dockercompose",
          // ports_exposes is still required by the Coolify API even for
          // dockercompose; it's purely metadata once the compose file
          // takes over.
          portsExposes: plan.surfaces === "client-only" ? "80" : plan.appPort,
          dockerComposeServiceName: detectDockerComposeDomainServiceName(
            state.projectDir,
            plan.surfaces,
          ),
          // Explicit choice from the stepper. Defaulted from `gh repo
          // view --json visibility` for existing remotes, `true` for
          // newly-created `gh repo create --private` repos. See the
          // comment on AdoptPlan.isPrivate.
          isPrivate: plan.isPrivate,
          // Lets wireProjectIntoCoolify read the project's compose file
          // to pick the right service name for `docker_compose_domains`
          // (Coolify rejects flat `domains` for dockercompose apps).
          projectDir: state.projectDir,
        });
        // Record only the bits we actually created. wireProjectIntoCoolify
        // returns explicit `*Created` flags exactly so adopt can guard
        // each ledger entry against the "found by name, reused" branch.
        //
        // Order matters: rollback iterates the ledger in REVERSE, so
        // entries must be recorded in chronological (parent-before-child)
        // order. The project is created first inside Coolify, so it must
        // be recorded first here — otherwise reverse iteration tries to
        // delete the project before the app, and Coolify rejects with
        // `400 — Project has resources, so it cannot be deleted.`
        if (coolifyResult.projectCreated) {
          ledger.record({ kind: "coolifyProject", uuid: coolifyResult.projectUuid });
        }
        if (coolifyResult.appCreated) {
          ledger.record({ kind: "coolifyApp", uuid: coolifyResult.appUuid });
        }
        if (
          coolifyResult.dnsRecordCreatedV4 &&
          coolifyResult.dnsZoneId &&
          coolifyResult.dnsRecordId
        ) {
          ledger.record({
            kind: "cloudflareDnsRecord",
            zoneId: coolifyResult.dnsZoneId,
            recordId: coolifyResult.dnsRecordId,
            name: plan.domain,
            type: "A",
          });
        }
        if (
          coolifyResult.dnsRecordCreatedV6 &&
          coolifyResult.dnsZoneId &&
          coolifyResult.dnsRecordIdV6
        ) {
          ledger.record({
            kind: "cloudflareDnsRecord",
            zoneId: coolifyResult.dnsZoneId,
            recordId: coolifyResult.dnsRecordIdV6,
            name: plan.domain,
            type: "AAAA",
          });
        }
      } catch (err) {
        // Brief inline note — the full recovery recipe lands in the
        // caveats block at the end, so users see one consolidated
        // "what's missing + how to fix" instead of competing hints
        // scattered through the run.
        console.log(chalk.yellow(`\n  ✗ Coolify wiring failed: ${(err as Error).message}`));
        caveats.push({
          title: "Coolify app not wired",
          reason: (err as Error).message,
          recovery: [
            `After fixing the cause above, re-run: hatchkit adopt --resume`,
            `Or create the app manually pointing at ${remoteUrl}`,
            `(domain ${plan.domain}, port ${plan.appPort}), then: hatchkit keys push ${plan.name}`,
          ],
        });
      }
    } else if (plan.wireCoolify && !remoteUrl) {
      console.log(chalk.yellow("\n  ✗ Coolify wiring skipped — no git remote available."));
      caveats.push({
        title: "Coolify app not wired",
        reason: "No `origin` remote set and the GitHub step was disabled.",
        recovery: [
          `Set a remote yourself, then re-run: hatchkit adopt --resume`,
          `Or re-run and toggle "GitHub remote = yes" in the stepper.`,
        ],
      });
    }

    // Step 3c: push the deploy-webhook secrets to the GitHub repo so
    // the scaffolded deploy.yml workflow can hit Coolify. Run whether
    // wireCoolify ran or not — covers both the "fresh app we just
    // created" and "app already existed before adopt" branches. Need
    // an app uuid in either case. Run BEFORE the initial git push
    // (below) so the workflow's first run has the secrets in place.
    //
    // Skipped for gh-pages — there's no Coolify webhook to hit.
    const appUuidForSecrets = coolifyResult?.appUuid ?? state.coolifyAppMatch?.uuid;
    if (plan.scaffoldBuildPipeline && plan.deploymentMode === "coolify" && appUuidForSecrets) {
      const slug = repoSlugFromRemote(remoteUrl);
      if (slug) {
        // --resume gate: if every secret this step would push is
        // already present on the repo, skip the push. The values
        // themselves aren't readable through `gh secret list` (write-
        // only), so we trust name-presence as the signal — same
        // contract `ghSecretExists` uses for the ledger-record gate
        // below. The user's recourse for a rotated Coolify token is
        // re-running adopt *without* --resume.
        const coolifySecretNames = [
          "COOLIFY_BASE_URL",
          "COOLIFY_API_TOKEN",
          "COOLIFY_TOKEN",
          "COOLIFY_WEBHOOK_URL",
          "COOLIFY_RESOURCE_UUID",
        ];
        let skipCoolifySecrets = false;
        if (opts.resume) {
          const checks = await Promise.all(
            coolifySecretNames.map((n) => ghSecretExists(state.projectDir, slug, n)),
          );
          if (checks.every(Boolean)) {
            skipCoolifySecrets = true;
            console.log(
              chalk.dim(
                `  · Skipping Coolify GH Actions secrets on --resume — all ${coolifySecretNames.length} already on ${slug}.`,
              ),
            );
          }
        }
        if (!skipCoolifySecrets) {
          await setCoolifyDeploySecrets({
            projectDir: state.projectDir,
            repoSlug: slug,
            apps: [{ uuid: appUuidForSecrets }],
          });
        }
      } else {
        console.log(
          chalk.dim(
            "  · Couldn't resolve owner/repo from git remote — set the deploy secrets manually.",
          ),
        );
      }
    }

    // Step 3c-bis: push DOTENV_PRIVATE_KEY_PRODUCTION as a GH Actions
    // secret. The scaffolded deploy.yml passes it as a BuildKit secret
    // to `docker/build-push-action`, which is what the Dockerfile's
    // `dotenvx run -- pnpm build` reads to decrypt .env.production at
    // build time. Without it the workflow exits 1 at build-step 6 with
    // "ERROR: dotenvx_private_key build secret not supplied".
    //
    // Independent of Coolify wiring (it's a GH-Actions concern, not
    // a Coolify one) — gates only on having the build pipeline + a
    // resolvable repo slug. Best-effort: failure surfaces as a caveat
    // with a copy-pasteable manual recipe so adopt finishes cleanly.
    //
    // gh-pages doesn't need this secret — the Pages workflow builds
    // the client without consuming server-side env.
    if (plan.scaffoldBuildPipeline && plan.deploymentMode === "coolify") {
      const slug = repoSlugFromRemote(remoteUrl);
      if (slug) {
        const secretName = "DOTENV_PRIVATE_KEY_PRODUCTION";
        // Probe BEFORE pushing so we can tell whether this run is the
        // one creating the secret. Recording in the ledger only when
        // we're the creator preserves the "destroy never deletes
        // pre-existing user data" invariant — see LedgerStep doc.
        const preExisted = await ghSecretExists(state.projectDir, slug, secretName);
        if (opts.resume && preExisted) {
          console.log(
            chalk.dim(`  · Skipping ${secretName} push on --resume — secret already on ${slug}.`),
          );
        } else {
          try {
            await pushProjectKeyToGh(plan.name, slug);
            if (!preExisted) {
              ledger.record({ kind: "ghActionsSecret", repo: slug, name: secretName });
            }
          } catch (err) {
            caveats.push({
              title: `${secretName} not set on GitHub Actions`,
              reason: (err as Error).message,
              recovery: [
                `hatchkit keys push ${plan.name} --target gh --repo ${slug}`,
                `(or copy from \`hatchkit keys show ${plan.name}\` and run \`gh secret set ${secretName} --repo ${slug} --body <key>\`)`,
              ],
            });
          }
        }
      } else if (remoteUrl) {
        console.log(
          chalk.dim(
            "  · Couldn't resolve owner/repo from git remote — push DOTENV_PRIVATE_KEY_PRODUCTION to Actions manually.",
          ),
        );
      }
    }

    // Step 3c-pages: GitHub Pages setup (gh-pages mode only).
    // Writes .github/workflows/gh-pages.yml + CNAME locally and
    // configures the remote side (enable Pages, register cname,
    // wire DNS, poll for the Let's Encrypt cert, flip
    // https_enforced). Must happen BEFORE the push step below so
    // the new files land in the same push and the workflow runs.
    //
    // Auto-detect heuristic: for a client-only project we deploy
    // the client dir (typically `packages/client/`). The detected
    // shape mirrors what gh-pages's own pickSite would have chosen
    // — node-build, pnpm, root-level build script.
    if (plan.deploymentMode === "gh-pages" && remoteUrl) {
      try {
        const { runPagesSetupProgrammatic } = await import("./deploy/pages.js");
        const { exec: bashExec } = await import("./utils/exec.js");
        const slug = repoSlugFromRemote(remoteUrl) ?? plan.name;
        // For adopt we don't know the exact build layout of the
        // user's project. Best-guess for a client-only Next.js
        // app: `packages/client/out` (post-`output: export` build).
        // If the user has a different layout they can re-run
        // `hatchkit gh-pages` from the project dir to override.
        const clientDir = plan.clientDir
          ? relative(state.projectDir, plan.clientDir)
          : "packages/client";
        const detected = {
          kind: "node-build" as const,
          publishDir: clientDir ? `${clientDir}/out` : "out",
          packageManager: "pnpm" as const,
          buildScript: "build",
          workDir: "",
        };
        const { pageUrl } = await runPagesSetupProgrammatic(state.projectDir, {
          detected,
          domain: plan.domain || null,
        });
        ledger.record({
          kind: "ghPages",
          repo: slug,
          projectDir: state.projectDir,
          cname: plan.domain || undefined,
        });
        // Stage and commit so the next push picks up the workflow
        // + CNAME file. If nothing changed (idempotent re-run), the
        // status check skips the commit entirely.
        await bashExec("git", ["add", "-A"], { cwd: state.projectDir, silent: true });
        const status = await bashExec("git", ["status", "--porcelain"], {
          cwd: state.projectDir,
          silent: true,
        });
        if (status.stdout.trim()) {
          await bashExec("git", ["commit", "-m", "ci: GitHub Pages setup"], {
            cwd: state.projectDir,
            silent: true,
          });
        }
        console.log(chalk.green(`  ✓ GitHub Pages will publish at ${pageUrl}`));
      } catch (err) {
        caveats.push({
          title: "GitHub Pages not wired",
          reason: (err as Error).message,
          recovery: [
            `Re-run from the project dir: hatchkit gh-pages`,
            `(it'll pick up where this left off and is idempotent).`,
          ],
        });
      }
    }

    // Step 3d: push to origin so GitHub Actions builds + pushes the
    // GHCR image. Done AFTER Coolify wiring + secrets so the workflow's
    // first run can hit the redeploy webhook on its own.
    //
    // Two paths:
    //   · Brand-new remote (this run just ran `gh repo create`) →
    //     pushInitialBranch pushes the whole tree.
    //   · Pre-existing remote → commitAndPushScaffold makes a
    //     pathspec-scoped commit of just the files hatchkit wrote
    //     (manifest + build-pipeline scaffold) and pushes it. Without
    //     this push the workflow file lives only in the working tree,
    //     Actions never fires, and the GHCR-wait below times out.
    //
    // `pushedThisRun` gates the GHCR step below — we only wait for a
    // new image when a push actually went out.
    let pushedThisRun = false;
    if (remoteUrl) {
      if (plan.setupGitHub && !state.gitRemoteUrl) {
        pushedThisRun = await pushInitialBranch(state.projectDir);
      } else if (state.gitRemoteUrl) {
        const result = await commitAndPushScaffold(state, {
          scaffoldedAbsPaths,
          overwrittenAbsPaths,
          manifestPath,
        });
        pushedThisRun = result.pushed;
        if (result.caveat) caveats.push(result.caveat);
      }
    }

    // Step 3e: GHCR setup. Two paths, gated on the user's earlier
    // public/private choice:
    //   · isPrivate=false → wait for the first Actions push to land
    //     in GHCR, then PATCH the package to visibility=public so
    //     Coolify can pull anonymously. (Without this, the package
    //     defaults to private even when the source repo is public —
    //     GHCR doesn't auto-inherit visibility from the repo, and
    //     Coolify's anonymous pull fails with `unauthorized`.)
    //   · isPrivate=true  → register a GHCR pull-PAT (from keychain)
    //     with Coolify's private-registries store so it can pull the
    //     private image. The PAT is shared across all hatchkit-managed
    //     apps on this Coolify install.
    //
    // Either path failing is a soft caveat — adopt finishes, the user
    // gets a copy-pasteable manual recipe, and the next `--resume`
    // can retry without redoing the rest of the work.
    if (
      plan.wireCoolify &&
      plan.scaffoldBuildPipeline &&
      remoteUrl &&
      coolifyResult !== undefined
    ) {
      const slug = repoSlugFromRemote(remoteUrl);
      if (slug && !pushedThisRun && !plan.isPrivate) {
        // No push went out (either nothing changed on disk this run,
        // or the auto-commit-push failed). Without a push the
        // build-and-deploy workflow doesn't run, so polling GHCR for
        // a brand-new image would just time out. Defer the visibility
        // PATCH to the next `--resume` once the user has pushed.
        caveats.push({
          title: "GHCR visibility not set — no push triggered",
          reason:
            "Adopt didn't push to origin this run, so the build-and-deploy workflow hasn't been triggered to publish the GHCR image.",
          recovery: [
            "Commit + push so the workflow runs:",
            `  cd ${state.projectDir}`,
            `  git add . && git commit -m "chore: adopt hatchkit"`,
            `  git push`,
            "Then re-run: hatchkit adopt --resume",
          ],
        });
      } else if (slug) {
        const { makeGhcrPackagePublic, registerGhcrCredsWithCoolify } = await import(
          "./deploy/ghcr.js"
        );
        if (plan.isPrivate) {
          // Read the full GHCR config (token + the PAT owner's GitHub
          // login). When either is missing the helper surfaces a
          // `hatchkit config add ghcr` caveat instead of failing the
          // run, so the user can drop creds in and re-run --resume.
          const ghcrConfig = await getGhcrConfig();
          const cfg = await getCoolifyConfig();
          if (cfg) {
            const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
            const r = await registerGhcrCredsWithCoolify({
              api,
              repoSlug: slug,
              pullToken: ghcrConfig?.pullToken,
              username: ghcrConfig?.username,
            });
            if (r.kind === "private-registered") {
              ledger.record({
                kind: "coolifyPrivateRegistry",
                uuid: r.registryUuid,
              });
            } else if (r.kind !== "public-set") {
              caveats.push({
                title: "GHCR pull credentials not configured",
                reason: r.reason,
                recovery: r.recovery,
              });
            }
          }
        } else {
          const r = await makeGhcrPackagePublic({ repoSlug: slug });
          if (r.kind !== "public-set" && r.kind !== "private-registered") {
            caveats.push({
              title: "GHCR package not made public",
              reason: r.reason,
              recovery: r.recovery,
            });
          }
        }
      }
    }

    // Step 4: provision clients via the existing `add` machinery so the
    // surfaces stepper, idempotency, and env writes behave identically
    // to a normal `hatchkit add`. Forward the surface choice — runProvision
    // uses the same vocabulary, so a client-only adopt produces a
    // client-only `add`.
    //
    // --resume contract: filter out services whose canonical env keys
    // are already present in the target env files. Re-minting Resend
    // keys / OpenPanel projects / Stripe webhooks on every resume
    // orphans live credentials and rotates secrets the user didn't
    // ask to rotate. The keychain caches some of these per-service,
    // but those caches don't survive a fresh machine — the env file
    // is the durable signal, so we trust it. A service is re-included
    // if it's newly in `plan.services` (added since the last attempt)
    // or its canonical env key is missing.
    const resumeServices = filterServicesForResume({
      services: plan.services,
      resume: opts.resume === true,
      serverEnvPath: plan.serverDir ? join(plan.serverDir, ".env.production") : null,
      clientEnvPath: plan.clientDir ? join(plan.clientDir, ".env.production") : null,
    });
    if (resumeServices.length > 0) {
      console.log();
      const provisionMode =
        plan.surfaces === "both"
          ? "shared"
          : plan.surfaces === "server-only"
            ? "server-only"
            : "client-only";
      await runProvision({
        baseName: plan.name,
        services: resumeServices,
        surfaces: {
          mode: provisionMode,
          serverEnvDir: plan.serverDir,
          clientEnvDir: plan.clientDir,
        },
        // Record per-resource as runProvision creates them. Done via
        // callback so a mid-loop failure (e.g. Resend after GlitchTip
        // already succeeded) still leaves a complete trail of what
        // to undo.
        onProvisioned: (event) => {
          if (event.service === "glitchtip") {
            ledger.record({ kind: "glitchtip", project: event.project });
          } else if (event.service === "openpanel") {
            ledger.record({ kind: "openpanel", project: event.project });
          } else if (event.service === "resend") {
            ledger.record({ kind: "resend", client: event.client });
          } else if (event.service === "email") {
            // Email setup creates three kinds of mutable state on
            // Cloudflare: the destination address (account-scoped), the
            // forwarding rules (zone-scoped), and the apex MX/SPF/DMARC
            // records (also zone-scoped). We only record what THIS run
            // created — `destinationCreatedThisRun` and `r.created` /
            // `dnsRecords` (which the provision orchestrator already
            // pre-filtered to `created: true` entries). MX/SPF/DMARC
            // upserts on a zone that already had them stay out of the
            // ledger so destroy never yanks pre-existing records.
            if (event.destinationCreatedThisRun) {
              ledger.record({
                kind: "cloudflareEmailDestination",
                accountId: event.accountId,
                destinationId: event.destinationId,
                email: event.destinationEmail,
              });
            }
            for (const dns of event.dnsRecords) {
              ledger.record({
                kind: "cloudflareDnsRecord",
                zoneId: event.zoneId,
                recordId: dns.id,
                name: dns.name,
                type: dns.type,
              });
            }
            for (const rule of event.rules) {
              if (!rule.created) continue;
              ledger.record({
                kind: "cloudflareEmailRoutingRule",
                zoneId: event.zoneId,
                ruleId: rule.id,
                address: rule.address,
              });
            }
          }
        },
      });
    }

    // Step 4b: S3 / R2 bucket provisioning — only when the project
    // declared the `s3` feature and uses provider="r2" (the only one
    // we can auto-create today). Re-runs are safe; bucket creation
    // is idempotent (409→reuse) and `dotenvxSet` overwrites in place.
    // Soft-fail to a caveat so a missing R2 token permission doesn't
    // sink the rest of the adopt flow — the user can fix the token
    // (globally via `hatchkit config add s3 r2`, which re-pastes +
    // verifies it) and re-run `hatchkit provision s3` to finish.
    if (plan.features.includes("s3")) {
      // --resume gate: when the manifest already records the assets
      // bucket AND .env.production has a working access/secret pair,
      // there's nothing to provision. Skip the whole step rather than
      // re-attaching custom domains / re-reconciling CORS / re-probing
      // tokens, all of which are network round-trips with no payoff
      // when nothing has changed since the last attempt.
      const s3ManifestSnapshot = readManifest(state.projectDir);
      const s3EnvPath = join(state.projectDir, ".env.production");
      const s3EnvKeys = readEnvKeys(s3EnvPath);
      const s3HasEnvCreds =
        (s3EnvKeys.has("R2_ACCESS_KEY_ID") && s3EnvKeys.has("R2_SECRET_ACCESS_KEY")) ||
        (s3EnvKeys.has("S3_ACCESS_KEY_ID") && s3EnvKeys.has("S3_SECRET_ACCESS_KEY")) ||
        (s3EnvKeys.has("AWS_ACCESS_KEY_ID") && s3EnvKeys.has("AWS_SECRET_ACCESS_KEY"));
      const s3ManifestComplete = !!s3ManifestSnapshot?.s3Buckets?.assets?.name;
      const s3AlreadyWired = opts.resume && s3HasEnvCreds && s3ManifestComplete;
      if (s3AlreadyWired) {
        console.log(
          chalk.dim(
            `  · Skipping S3 on --resume — manifest records ${s3ManifestSnapshot?.s3Buckets?.assets?.name} and .env.production has access/secret keys.`,
          ),
        );
      } else {
        try {
          const { provisionS3ForProject, defaultBucketHostname, existingCustomHostname } =
            await import("./provision/s3-buckets.js");
          // Resolve the public assets-bucket custom domain. If a previous
          // run already attached one, the manifest records it — reuse
          // that without re-prompting. Only ask on first adopt (or when
          // the manifest has no hostname yet, e.g. a previous run picked
          // the managed r2.dev URL or never got that far). Blank answer →
          // managed r2.dev.
          let publicHostname: string | null | undefined;
          const existingManifest = readManifest(state.projectDir);
          const recordedHostname = existingManifest
            ? existingCustomHostname(existingManifest)
            : null;
          if (recordedHostname) {
            publicHostname = recordedHostname;
          } else if (process.stdin.isTTY) {
            const answer = (
              await input({
                message:
                  "Custom domain for the public assets bucket (leave empty to use the managed r2.dev URL):",
                default: defaultBucketHostname(plan.domain),
              })
            ).trim();
            publicHostname = answer === "" ? null : answer;
          }
          // Only create the public assets bucket here. The private "state"
          // bucket is an explicit opt-in even when the project has a
          // server — most don't need it, and adding one silently means
          // an extra R2 bucket + env var the user has to clean up later.
          // Users who want one re-run `hatchkit provision s3 --with-state-bucket`.
          const r = await provisionS3ForProject({
            projectDir: state.projectDir,
            publicHostname,
          });
          // Ledger: record any *fresh* bucket creations + a fresh token
          // mint so destroy can revoke them. Reused buckets/tokens (from
          // a prior adopt run) stay out — those are already in the
          // earlier run's ledger or pre-existed before hatchkit ran.
          if (r.assets.created) {
            ledger.record({
              kind: "r2Bucket",
              bucketName: r.assets.name,
              accountId: r.accountId,
            });
          }
          if (r.state?.created) {
            ledger.record({
              kind: "r2Bucket",
              bucketName: r.state.name,
              accountId: r.accountId,
            });
          }
          if (r.tokenCreated) {
            ledger.record({
              kind: "r2Token",
              tokenId: r.tokenCreated.tokenId,
              accountId: r.accountId,
              audience: r.tokenCreated.audience,
            });
          }
          console.log(chalk.green(`  ✓ S3 assets bucket ready — ${r.assets.publicUrl}`));
          console.log(
            chalk.dim(
              `    Wrote ${r.envWritten.length} encrypted entries. ` +
                "(Need a private server-side bucket too? Run `hatchkit provision s3 --with-state-bucket`.)",
            ),
          );
          // The fresh bucket is empty. Existing projects almost always
          // have assets sitting in some other store — surface the one
          // command that copies them in. Cheap line to print, easy to
          // miss without it.
          console.log(
            chalk.dim(
              `    Have existing assets to bring over? hatchkit assets migrate \\\n` +
                `      --from-endpoint=<old-s3-endpoint> --from-bucket=<name> \\\n` +
                `      --from-key=<access-key> --from-secret=<secret>`,
            ),
          );
        } catch (err) {
          console.log(
            chalk.yellow(
              `\n  ✗ S3 bucket provisioning failed: ${(err as Error).message.split("\n")[0]}`,
            ),
          );
          // Two kinds of recovery — pick based on whether the underlying
          // error looks like an admin-token problem (global) vs. a
          // bucket-side problem (per-project). Admin-token failures point
          // the user at the global config command (which validates the
          // token); everything else points at the per-project re-runner.
          const msg = (err as Error).message;
          const isAdminTokenIssue =
            /admin token|invalid api token|9109|10000|10001|HTTP 401|HTTP 403/i.test(msg);
          caveats.push({
            title: "S3 buckets not provisioned",
            reason: msg,
            recovery: isAdminTokenIssue
              ? [
                  "Looks like an R2 admin-token problem.",
                  "Fix globally with: hatchkit config add s3 r2  (re-paste + verify perms)",
                  `Then re-run from the project dir: cd ${plan.name} && hatchkit provision s3`,
                ]
              : [
                  "Once fixed, finish with: hatchkit provision s3",
                  "(safe to re-run — bucket creation and env writes are idempotent)",
                ],
          });
        }
      }
    }

    // Step 4c: Stripe — strictly separate from `create`'s Stripe block
    // but uses the same provisionStripeProject so behavior matches. The
    // adopt path lets the user steer the per-project keys onto an
    // existing project's keychain entries (re-runs reuse cached values
    // by default; see `--reprompt-stripe`-shaped opts inside
    // provisionStripeProject when we surface a flag for it).
    if (plan.features.includes("stripe")) {
      try {
        const { provisionStripeProject, renderStripeEnv, renderStripeSkipComment } = await import(
          "./provision/stripe.js"
        );
        const { appendCommentBlock, parseEnvLines, writeDevEnv, writeProdEnv } = await import(
          "./provision/write-env.js"
        );
        // Adopt's surface model: serverDir is the canonical env home for
        // a server-bearing project. If serverDir is missing (client-only
        // adopt) we have no place to write Stripe creds — surface a
        // caveat instead of silently skipping.
        if (!plan.serverDir) {
          caveats.push({
            title: "Stripe wiring skipped",
            reason: "No server directory detected — Stripe needs server-side env files.",
            recovery: [
              "If this project actually has a server, re-run `hatchkit adopt --resume` and set the server dir.",
            ],
          });
        } else {
          // --resume gate: if Stripe keys are already encrypted in
          // .env.production AND set in .env.development, the env is
          // wired — skip the provisioner entirely. Re-running it on
          // a cache miss (e.g. fresh machine) would reprompt for the
          // sk/pk and re-create the webhook endpoint, leaving the
          // old endpoint orphaned in the user's Stripe dashboard.
          const devEnvPath = join(plan.serverDir, ".env.development");
          const prodEnvPath = join(plan.serverDir, ".env.production");
          const stripeAlreadyWired =
            opts.resume &&
            readEnvKeys(prodEnvPath).has("STRIPE_SECRET_KEY") &&
            readEnvKeys(devEnvPath).has("STRIPE_SECRET_KEY");
          if (stripeAlreadyWired) {
            console.log(
              chalk.dim(
                `  · Skipping Stripe on --resume — STRIPE_SECRET_KEY present in both .env.production and .env.development.`,
              ),
            );
          } else {
            const result = await provisionStripeProject({
              projectName: plan.name,
              domain: plan.domain,
            });
            const devLabel = relative(state.projectDir, devEnvPath);
            const prodLabel = relative(state.projectDir, prodEnvPath);

            if (result.test) {
              if (result.test.kind === "skipped") {
                appendCommentBlock(devEnvPath, renderStripeSkipComment("test", devLabel));
              }
              const pairs = parseEnvLines(renderStripeEnv(result.test));
              writeDevEnv(devEnvPath, pairs);
              if (result.test.kind === "configured") {
                ledger.record({
                  kind: "keychain",
                  account: SECRET_KEYS.stripeProjectWebhookId(plan.name, "test"),
                });
              }
              console.log(
                chalk.green(
                  result.test.kind === "skipped"
                    ? `  ✓ Stripe sandbox placeholders → ${devLabel} (fill in later)`
                    : `  ✓ Stripe sandbox creds → ${devLabel} (${pairs.length} keys)`,
                ),
              );
            }
            if (result.live) {
              if (result.live.kind === "skipped") {
                appendCommentBlock(prodEnvPath, renderStripeSkipComment("live", prodLabel));
              }
              const pairs = parseEnvLines(renderStripeEnv(result.live));
              writeProdEnv(prodEnvPath, pairs);
              if (result.live.kind === "configured") {
                ledger.record({
                  kind: "keychain",
                  account: SECRET_KEYS.stripeProjectWebhookId(plan.name, "live"),
                });
              }
              console.log(
                chalk.green(
                  result.live.kind === "skipped"
                    ? `  ✓ Stripe live placeholders → ${prodLabel} (encrypted CHANGE_ME values, fill in later)`
                    : `  ✓ Stripe live creds → ${prodLabel} (encrypted, ${pairs.length} keys)`,
                ),
              );
            }
            if (!result.test && !result.live) {
              caveats.push({
                title: "Stripe wiring skipped",
                reason:
                  "No Stripe master key configured — neither test nor live mode could be wired.",
                recovery: [
                  "Run `hatchkit config add stripe` to add at least one master key,",
                  `then re-run \`hatchkit adopt --resume\` from ${state.projectDir}.`,
                ],
              });
            }
          }
        }
      } catch (err) {
        const msg = (err as Error).message;
        console.log(chalk.yellow(`\n  ✗ Stripe provisioning failed: ${msg.split("\n")[0]}`));
        caveats.push({
          title: "Stripe not provisioned",
          reason: msg,
          recovery: [
            "Once the issue is fixed, re-run from the project dir:",
            `  cd ${plan.name} && hatchkit adopt --resume`,
            "(safe to re-run — webhook creation reuses the cached endpoint id)",
          ],
        });
      }
    }

    // Step 5: push key to Coolify — but only when wireCoolify didn't
    // already do it. wireCoolify's success path includes a setAppEnv
    // pass that pushes DOTENV_PRIVATE_KEY_PRODUCTION; if it failed,
    // there's no app to push to and pushing again would just produce
    // a confusing second error message.
    const wiredEnvAlready = plan.wireCoolify && coolifyResult !== undefined;
    if (plan.pushKey && !wiredEnvAlready) {
      if (plan.wireCoolify && !coolifyResult) {
        console.log(
          chalk.dim(`  · Skipping standalone key push — Coolify wiring failed, no app to push to.`),
        );
      } else {
        try {
          // Use the matched app name when we have one — adopt creates
          // apps with the bare project name (no `-web` suffix that the
          // create-flow scaffold uses).
          await pushProjectKeyToCoolify(plan.name, {
            appName: state.coolifyAppMatch?.name ?? plan.name,
          });
          console.log(chalk.green(`\n  ✓ Pushed dotenvx key to Coolify`));
        } catch (err) {
          console.log(
            chalk.yellow(`\n  ✗ Couldn't push dotenvx key to Coolify: ${(err as Error).message}`),
          );
          caveats.push({
            title: "dotenvx key not pushed to Coolify",
            reason: (err as Error).message,
            recovery: [`Once the app exists, run: hatchkit keys push ${plan.name}`],
          });
        }
      }
    }
    ledger.complete();
  } catch (err) {
    // Ctrl+C path: the SIGINT handler is already running the
    // recipe/rollback flow and will call process.exit when it
    // resolves. Stand down so the user only sees one prompt.
    if (isCancelInProgress()) return;
    // Mid-flight throw — surface the partial state via the same
    // recipe/rollback/leave UX `hatchkit create` uses, then exit.
    // The ledger holds only resources adopt itself created (see the
    // gating on each `ledger.record(...)` call above), so a "yes,
    // roll back" choice is safe to take.
    await handleAdoptFailure(ledger, err);
    process.exit(1);
  } finally {
    uninstallCancelHandler();
  }

  // Banner reflects partial state — when caveats exist, callers see
  // "Adopted (incomplete)" so the success line doesn't drown out the
  // unfinished work that still needs them. The body is the same; the
  // caveats block lands underneath.
  const banner =
    caveats.length > 0
      ? "── Adopted (incomplete) ─────────────"
      : "── Adopted ─────────────────────────";
  console.log(chalk.bold(`\n  ${banner}─────────────────────\n`));
  console.log(`  Project:   ${chalk.cyan(plan.name)}`);
  console.log(`  Domain:    ${chalk.cyan(plan.domain)}`);
  if (plan.serverDir) console.log(`  Server:    ${chalk.cyan(relativeTo(plan.serverDir))}`);
  if (plan.clientDir) console.log(`  Client:    ${chalk.cyan(relativeTo(plan.clientDir))}`);
  console.log(`  Surfaces:  ${chalk.cyan(plan.surfaces)}`);
  console.log(`  Manifest:  ${chalk.dim(join(state.projectDir, MANIFEST_FILENAME))}`);
  if (remoteUrl) console.log(`  Git:       ${chalk.cyan(remoteUrl)}`);
  if (coolifyResult) {
    const ipDisplay = [coolifyResult.serverIpv4, coolifyResult.serverIpv6]
      .filter(Boolean)
      .join(" / ");
    console.log(
      `  Coolify:   ${chalk.cyan(coolifyResult.appUuid)}  ${chalk.dim(`@ ${ipDisplay || "?"}`)}`,
    );
    const records: string[] = [];
    if (coolifyResult.dnsRecordId) records.push(`A ${plan.domain} → ${coolifyResult.serverIpv4}`);
    if (coolifyResult.dnsRecordIdV6)
      records.push(`AAAA ${plan.domain} → ${coolifyResult.serverIpv6}`);
    if (coolifyResult.dnsManaged && records.length > 0) {
      console.log(`  DNS:       ${chalk.green("✓")}  ${chalk.dim(records.join("  ·  "))}`);
    } else if (plan.domain && (coolifyResult.serverIpv4 || coolifyResult.serverIpv6)) {
      const manual = [
        coolifyResult.serverIpv4 && `A ${plan.domain} → ${coolifyResult.serverIpv4}`,
        coolifyResult.serverIpv6 && `AAAA ${plan.domain} → ${coolifyResult.serverIpv6}`,
      ]
        .filter(Boolean)
        .join("  ·  ");
      console.log(`  DNS:       ${chalk.yellow("✗")}  ${chalk.dim(`add ${manual} manually`)}`);
    }
  }
  if (caveats.length > 0) {
    console.log(chalk.bold(chalk.yellow(`\n  Caveats (${caveats.length}):\n`)));
    for (const c of caveats) {
      console.log(`  ${chalk.yellow("✗")} ${chalk.bold(c.title)}`);
      console.log(`    ${chalk.dim(c.reason)}`);
      for (const r of c.recovery) console.log(`    ${chalk.dim("→")} ${chalk.dim(r)}`);
      console.log();
    }
  } else {
    console.log();
  }
}

/** Where dotenvx writes the encrypted env. Server-only / both layouts
 *  use the server dir (canonical for runtime decryption); client-only
 *  layouts use the client dir. Both fall back to the project root if
 *  detection / the user picked nothing more specific. */
function dotenvxRootFor(plan: AdoptPlan, projectDir: string): string {
  if (plan.surfaces === "client-only") return plan.clientDir ?? projectDir;
  return plan.serverDir ?? projectDir;
}

interface BootstrapDotenvxResult {
  /** Path to .env.keys (always set after a successful bootstrap). */
  keysPath: string;
  /** True iff this run created `.env.keys` from scratch (it didn't
   *  exist on disk before this call). Adopt's ledger keys off this
   *  so `hatchkit destroy` only deletes a keys file that adopt itself
   *  generated — never one the user had before. */
  createdKeysFile: boolean;
}

async function bootstrapDotenvxNow(
  state: DetectedState,
  plan: AdoptPlan,
): Promise<BootstrapDotenvxResult> {
  const root = dotenvxRootFor(plan, state.projectDir);
  const prodPath = join(root, ".env.production");
  const keysPath = join(root, ".env.keys");
  // Snapshot existence BEFORE the dotenvx call so we know whether
  // we're about to create the keys file or just reuse the existing one.
  const keysExistedBefore = existsSync(keysPath);

  // Belt-and-braces: ensure `.env.keys` is gitignored at the repo root
  // BEFORE we ask dotenvx to write it. The user's pre-existing
  // `.gitignore` may not cover dotenvx-specific files (the starter does,
  // but adopt runs against arbitrary repos). If we let `dotenvx set`
  // run first and `.env.keys` lands in a non-ignored path, the next
  // `git add -A` (in setupGitHubRemote) sweeps the private key into the
  // index and a public push leaks it forever. The gitignore write is
  // additive — never touches existing entries — so it's safe to run
  // even when `.env.keys` is already covered.
  const ignoreResult = ensureGitignoreEntries(state.projectDir, [".env.keys"]);
  if (ignoreResult.added.length > 0) {
    console.log(
      chalk.dim(
        ignoreResult.fileCreated
          ? `  · Created .gitignore at ${relativeTo(ignoreResult.path)} with .env.keys`
          : `  · Appended .env.keys to ${relativeTo(ignoreResult.path)}`,
      ),
    );
  }

  const ora = (await import("ora")).default;
  const label = state.prodEnvIsEncrypted
    ? "Re-encrypting .env.production with dotenvx..."
    : existsSync(prodPath)
      ? "Encrypting .env.production with dotenvx..."
      : "Generating .env.production + .env.keys with dotenvx...";
  const spinner = ora(label).start();
  try {
    // First call to `dotenvx set` with encrypt: true creates the file
    // (if missing), generates the keypair, and writes .env.keys.
    // Subsequent calls reuse the existing keypair. Using HATCHKIT_ADOPTED
    // as the sentinel keeps the file non-empty so the keypair survives.
    const { set: dotenvxSet } = await import("@dotenvx/dotenvx");
    dotenvxSet("HATCHKIT_ADOPTED", new Date().toISOString(), {
      path: prodPath,
      encrypt: true,
    });
    spinner.succeed(
      existsSync(prodPath)
        ? "dotenvx initialized — .env.production is now encrypted"
        : "dotenvx initialized",
    );
  } catch (err) {
    spinner.fail("Failed to initialize dotenvx");
    throw err;
  }

  // Belt-and-braces #2: many existing repos have a defensive
  // `.dockerignore` that wildcards out `.env*` (perfectly reasonable
  // when secrets are plaintext, but wrong now that .env.production is
  // dotenvx-encrypted and SHOULD ride along into the image). If we
  // leave it excluded, dotenvx finds no file inside the container,
  // exports zero env vars, and the build silently bakes broken
  // NEXT_PUBLIC_* values. Append `!.env.production` to allow it
  // through. Idempotent / no-op if there's no .dockerignore at all.
  const dockerIgnoreResult = ensureDockerignoreAllowsEnvProduction(state.projectDir);
  if (dockerIgnoreResult.modified) {
    console.log(
      chalk.dim(
        `  · Appended !.env.production to ${relativeTo(dockerIgnoreResult.path)} so dotenvx can decrypt inside the build`,
      ),
    );
  }

  return { keysPath, createdKeysFile: !keysExistedBefore };
}

/** Make sure the dotenvx-encrypted `.env.production` is actually
 *  committed to git.
 *
 *  hatchkit assumes the encrypted file ships with the repo — GH Actions
 *  checks out exactly what's pushed, and the Dockerfile expects it in
 *  the build context for `dotenvx run -- pnpm build` to find. The
 *  trap: many users have a global `~/.config/git/ignore` from a
 *  pre-dotenvx era that lists `.env.production` (sensible default
 *  before encrypted env files were a thing). The project's own
 *  `.gitignore` doesn't override the global one, so the file silently
 *  stays untracked even though the project intends to commit it.
 *
 *  This helper:
 *    1. Diagnoses whether the file is ignored vs. just untracked, and
 *       tells the user why if the global ignore is in play.
 *    2. Force-adds + commits ONLY this path (pathspec on commit so the
 *       user's WIP doesn't get rolled into the same commit).
 *    3. If the commit fails (e.g. a husky hook rejects it), leaves the
 *       file staged + tells the user the manual fallback. We don't
 *       use --no-verify — bypassing the user's hooks behind their back
 *       is worse than asking them to commit manually.
 *
 *  Idempotent: skips if the file is already tracked and clean.
 *  No-op when `.env.production` doesn't exist or the project isn't a
 *  git repo.
 */
async function ensureEnvProductionCommitted(state: DetectedState, plan: AdoptPlan): Promise<void> {
  if (!state.isGitRepo) return;
  const root = dotenvxRootFor(plan, state.projectDir);
  const prodPath = join(root, ".env.production");
  if (!existsSync(prodPath)) return;

  const tracked = await execOk("git", ["ls-files", "--error-unmatch", "--", prodPath], {
    cwd: state.projectDir,
  });
  if (tracked) {
    // Already tracked; nothing to do unless content drifted from HEAD.
    // `git diff --quiet HEAD -- <path>` exits 0 when working tree
    // matches HEAD for that path (covers both "no unstaged change"
    // and "no staged change" in one shot).
    const clean = await execOk("git", ["diff", "--quiet", "HEAD", "--", prodPath], {
      cwd: state.projectDir,
    });
    if (clean) return;
  } else {
    // Not tracked. Diagnose ignored-vs-untracked so the user knows
    // *why* their previous commits silently dropped the file.
    const ignored = await execOk("git", ["check-ignore", "--quiet", "--", prodPath], {
      cwd: state.projectDir,
    });
    if (ignored) {
      const reason = await exec("git", ["check-ignore", "-v", "--", prodPath], {
        cwd: state.projectDir,
        silent: true,
      });
      console.log(
        chalk.yellow(
          `  ⚠ .env.production is git-ignored — ${reason.stdout.trim() || "global ignore rule"}`,
        ),
      );
      console.log(
        chalk.dim(
          `    The encrypted file is safe to commit (encryption is the whole point); force-adding so GH Actions has it in the build context.`,
        ),
      );
    }
  }

  await exec("git", ["add", "-f", "--", prodPath], {
    cwd: state.projectDir,
    silent: true,
  });
  // Pathspec on commit limits the commit to ONLY .env.production —
  // anything else the user has staged stays out of this commit.
  const commit = await exec(
    "git",
    ["commit", "-m", "chore(dotenvx): commit encrypted .env.production", "--", prodPath],
    { cwd: state.projectDir, silent: true },
  );
  if (commit.exitCode === 0) {
    console.log(chalk.green(`  ✓ Committed ${relativeTo(prodPath)}`));
  } else {
    const firstLine =
      (commit.stderr || commit.stdout)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? "unknown error";
    console.log(chalk.yellow(`  ⚠ Couldn't commit .env.production automatically: ${firstLine}`));
    console.log(
      chalk.dim(
        `    File is staged. Commit manually so it ships to GH Actions:\n` +
          `      git -C ${relativeTo(state.projectDir)} commit -m "chore(dotenvx): commit encrypted .env.production" -- ${relativeTo(prodPath, state.projectDir)}`,
      ),
    );
  }
}

type UserWipState =
  | { kind: "ok" }
  | { kind: "in-progress"; op: string }
  | { kind: "user-changes"; files: { status: string; path: string }[] }
  | { kind: "error"; reason: string };

/**
 * Sniff the working tree for state that would make auto-commit + push
 * surprising or destructive. We refuse to touch git when:
 *
 *   · A merge / rebase / cherry-pick / revert / bisect is in progress
 *     — adopt isn't allowed to add commits on top of half-resolved
 *     conflicts.
 *   · Any tracked file *outside* hatchkit's path list has unstaged or
 *     staged changes. Even though the commit itself is pathspec-scoped
 *     (so the user's modifications wouldn't be swept in), the push
 *     would still land hatchkit's commit on top of the user's WIP on
 *     the same branch — entangling their unpushed work with the
 *     hatchkit commit on origin. Make them park or commit it first.
 *
 * Untracked files (status `??`) are deliberately ignored — they're
 * common debris (editor swaps, build artifacts not in gitignore, etc.)
 * and never end up in our pathspec commit anyway.
 */
async function detectUserWip(
  projectDir: string,
  hatchkitAbsPaths: string[],
): Promise<UserWipState> {
  // In-progress operations: probe the .git dir for marker files. We
  // resolve --git-dir via git itself so this works in worktrees (where
  // .git is a file, not a directory) and submodules.
  const gitDirRes = await exec("git", ["rev-parse", "--git-dir"], {
    cwd: projectDir,
    silent: true,
  });
  if (gitDirRes.exitCode === 0) {
    const raw = gitDirRes.stdout.trim();
    const gitDir = raw.startsWith("/") ? raw : join(projectDir, raw);
    const markers: Array<[string, string]> = [
      ["MERGE_HEAD", "merge"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
      ["rebase-merge", "rebase"],
      ["rebase-apply", "rebase"],
      ["BISECT_LOG", "bisect"],
    ];
    for (const [marker, op] of markers) {
      if (existsSync(join(gitDir, marker))) return { kind: "in-progress", op };
    }
  }

  // Repo-root-relative path matching. `git status --porcelain` emits
  // paths relative to the repo root, not necessarily our cwd, so we
  // normalize hatchkit's absolute paths the same way before comparing.
  const rootRes = await exec("git", ["rev-parse", "--show-toplevel"], {
    cwd: projectDir,
    silent: true,
  });
  if (rootRes.exitCode !== 0) {
    return { kind: "error", reason: "git rev-parse --show-toplevel failed" };
  }
  const repoRoot = rootRes.stdout.trim();
  const hatchkitRelToRoot = new Set(hatchkitAbsPaths.map((p) => relative(repoRoot, p)));

  const status = await exec("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: projectDir,
    silent: true,
  });
  if (status.exitCode !== 0) {
    return { kind: "error", reason: "git status failed" };
  }

  const userFiles: { status: string; path: string }[] = [];
  for (const line of status.stdout.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let rest = line.slice(3);
    // Renames/copies show up as "OLD -> NEW". We want the new path.
    if (rest.includes(" -> ")) rest = rest.split(" -> ").pop() ?? rest;
    // Git quotes paths with special chars in C-style. If a path is
    // quoted we conservatively treat it as user WIP rather than try
    // to unquote and risk a false negative.
    const path = rest.startsWith('"') && rest.endsWith('"') ? rest.slice(1, -1) : rest;
    if (!hatchkitRelToRoot.has(path)) {
      userFiles.push({ status: code, path });
    }
  }

  if (userFiles.length > 0) return { kind: "user-changes", files: userFiles };
  return { kind: "ok" };
}

/**
 * Commit + push the files hatchkit wrote this run (manifest +
 * scaffolded build pipeline) to a pre-existing remote so the
 * build-and-deploy workflow fires.
 *
 * Pathspec-scoped on purpose: a plain `git add -A` would sweep up
 * whatever WIP the user happened to have in the working tree —
 * surprising behavior for an adopt. By listing only the paths
 * hatchkit just wrote, the resulting commit is exactly "the adopt
 * step", and anything else stays staged in the user's hands.
 *
 * Hard-stops with a caveat when `detectUserWip` finds unrelated user
 * changes or an in-progress git operation. The push would otherwise
 * land hatchkit's commit on top of WIP that isn't part of adopt — a
 * surprise we explicitly refuse to do.
 *
 * Returns `{ pushed: false }` (no caveat) for the idempotent case —
 * everything hatchkit wrote was already byte-identical to HEAD, so
 * there was nothing to push. Failures during commit/push surface as
 * a caveat with a copy-pasteable manual recipe.
 */
async function commitAndPushScaffold(
  state: DetectedState,
  paths: {
    scaffoldedAbsPaths: string[];
    overwrittenAbsPaths: string[];
    manifestPath: string;
  },
): Promise<{ pushed: boolean; caveat?: AdoptCaveat }> {
  const all = [
    ...paths.scaffoldedAbsPaths,
    ...paths.overwrittenAbsPaths,
    paths.manifestPath,
  ].filter((p, i, arr) => arr.indexOf(p) === i && existsSync(p));
  if (all.length === 0) return { pushed: false };

  // Hard stop: refuse to auto-commit on top of in-progress git ops
  // or unrelated user changes. See detectUserWip docstring for the
  // exact policy.
  const wip = await detectUserWip(state.projectDir, all);
  if (wip.kind === "in-progress") {
    return {
      pushed: false,
      caveat: {
        title: `Refusing to auto-commit — git ${wip.op} in progress`,
        reason: `A ${wip.op} is in progress in ${state.projectDir}. Adopt won't stack commits on top of half-resolved git state.`,
        recovery: [
          `Finish or abort the ${wip.op}, then re-run adopt:`,
          wip.op === "rebase"
            ? `  git rebase --continue   # or: git rebase --abort`
            : `  git ${wip.op} --abort   # or finish it manually and commit`,
          "Then: hatchkit adopt --resume",
        ],
      },
    };
  }
  if (wip.kind === "user-changes") {
    const preview = wip.files.slice(0, 8).map((f) => `    ${f.status} ${f.path}`);
    const extra = wip.files.length > 8 ? [`    ... and ${wip.files.length - 8} more`] : [];
    return {
      pushed: false,
      caveat: {
        title: "Refusing to auto-commit — working tree has unrelated changes",
        reason: `Found ${wip.files.length} modified file(s) outside the hatchkit scaffold. Auto-committing + pushing now would land the adopt commit on top of WIP that isn't part of the adopt step.`,
        recovery: [
          "Hatchkit wanted to commit + push these files:",
          ...all.map((p) => `    + ${relativeTo(p, state.projectDir)}`),
          "",
          "Your working tree also has changes to:",
          ...preview,
          ...extra,
          "",
          "Park, commit, or discard your WIP first — whichever fits:",
          `  git stash push -u -m "pre-hatchkit-adopt"   # park on the side`,
          `  # or: git add . && git commit -m "..."        # keep in history`,
          `  # or: git checkout -- <file>                 # discard a file`,
          "Then re-run: hatchkit adopt --resume",
        ],
      },
    };
  }
  if (wip.kind === "error") {
    return {
      pushed: false,
      caveat: {
        title: "Refusing to auto-commit — couldn't verify a clean working tree",
        reason: `Working-tree detection failed: ${wip.reason}. Adopt won't auto-commit without knowing what else is in the tree.`,
        recovery: [
          "Commit + push the scaffold manually:",
          `  cd ${state.projectDir}`,
          `  git add ${all.map((p) => relativeTo(p, state.projectDir)).join(" ")}`,
          `  git commit -m "chore(hatchkit): adopt scaffold + manifest"`,
          `  git push`,
          "Then re-run: hatchkit adopt --resume",
        ],
      },
    };
  }

  // Definitive pre-commit notice. The user opted into adopt, but an
  // auto-commit-and-push on a pre-existing remote is a meaningful
  // side effect — they should see exactly what's happening before it
  // lands on origin.
  console.log();
  console.log(chalk.bold.yellow("  ⚠ hatchkit is about to commit + push to origin:"));
  for (const p of all) {
    console.log(chalk.yellow(`      + ${relativeTo(p, state.projectDir)}`));
  }
  console.log(
    chalk.dim("    (working tree verified clean of unrelated changes — auto-commit is safe)"),
  );
  console.log();

  // Pathspec stage: only the hatchkit-owned files. `--` separates
  // pathspecs from refs so a file named "main" doesn't get confused
  // for a branch.
  const stage = await exec("git", ["add", "--", ...all], {
    cwd: state.projectDir,
    silent: true,
  });
  if (stage.exitCode !== 0) {
    return {
      pushed: false,
      caveat: {
        title: "Couldn't stage hatchkit scaffold for commit",
        reason: (stage.stderr || stage.stdout).split(/\r?\n/)[0] || "git add failed",
        recovery: [
          "Stage + commit + push manually so the workflow runs:",
          `  cd ${state.projectDir}`,
          `  git add ${all.map((p) => relativeTo(p, state.projectDir)).join(" ")}`,
          `  git commit -m "chore(hatchkit): adopt scaffold + manifest"`,
          `  git push`,
          "Then re-run: hatchkit adopt --resume",
        ],
      },
    };
  }

  // Nothing in the staged index means every file was byte-identical
  // to HEAD — this is the idempotent re-run case. No push needed.
  const cleanStaged = await execOk("git", ["diff", "--cached", "--quiet"], {
    cwd: state.projectDir,
  });
  if (cleanStaged) return { pushed: false };

  // Pathspec on the commit too — anything else the user happened to
  // stage themselves before running adopt stays out of this commit.
  const commit = await exec(
    "git",
    ["commit", "-m", "chore(hatchkit): adopt scaffold + manifest", "--", ...all],
    { cwd: state.projectDir, silent: true },
  );
  if (commit.exitCode !== 0) {
    return {
      pushed: false,
      caveat: {
        title: "Couldn't commit hatchkit scaffold automatically",
        reason: (commit.stderr || commit.stdout).split(/\r?\n/)[0] || "git commit failed",
        recovery: [
          "Commit + push the scaffold manually:",
          `  cd ${state.projectDir}`,
          `  git commit -m "chore(hatchkit): adopt scaffold + manifest" -- ${all.map((p) => relativeTo(p, state.projectDir)).join(" ")}`,
          `  git push`,
          "Then re-run: hatchkit adopt --resume",
        ],
      },
    };
  }
  console.log(chalk.green(`  ✓ Committed hatchkit scaffold (${all.length} files)`));

  const headRes = await exec("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd: state.projectDir,
    silent: true,
  });
  const branch = headRes.exitCode === 0 ? headRes.stdout.trim() : "main";
  const push = await exec("git", ["push", "origin", branch], {
    cwd: state.projectDir,
    spinner: `Pushing ${branch} to origin...`,
  });
  if (push.exitCode !== 0) {
    return {
      pushed: false,
      caveat: {
        title: `Couldn't push ${branch} to origin`,
        reason:
          (push.stderr || push.stdout).split(/\r?\n/)[0] || `git push exited ${push.exitCode}`,
        recovery: [
          "Push the new commit so Actions can build the image:",
          `  cd ${state.projectDir}`,
          `  git push origin ${branch}`,
          "Then re-run: hatchkit adopt --resume",
        ],
      },
    };
  }
  return { pushed: true };
}

interface SetupGitHubResult {
  /** Final origin URL (the new repo's HTTPS URL on success). */
  url?: string;
  /** True iff this run executed `git init` because there was no `.git/`
   *  before. Adopt records `gitInit` in the ledger only when this is
   *  true — destroy/rollback then knows it's safe to `rm -rf .git`. */
  gitInitialized: boolean;
  /** Owner/repo slug for `gh repo delete <slug>` during rollback.
   *  Only populated when this run actually created the repo. */
  repoSlug?: string;
}

async function setupGitHubRemote(
  state: DetectedState,
  plan: AdoptPlan,
): Promise<SetupGitHubResult> {
  // Pre-flight gh CLI auth. ensureGitHub prompts the user to log in
  // when needed; if they cancel, surface a clear "you can do this
  // later" rather than crashing the whole adopt run.
  try {
    await ensureGitHub();
  } catch (err) {
    console.log(
      chalk.yellow(
        `\n  Couldn't reach GitHub (${(err as Error).message}). Skipping remote creation.`,
      ),
    );
    return { gitInitialized: false };
  }

  console.log(chalk.bold("\n  ── GitHub ────────────────────────────────────────────────\n"));

  let gitInitialized = false;
  if (!state.isGitRepo) {
    await exec("git", ["init"], {
      cwd: state.projectDir,
      spinner: "Initializing git repo...",
    });
    gitInitialized = true;
  }
  // Stage everything + commit when there's anything staged.
  //   `git diff --cached --quiet` exits 0 → no diff (nothing staged)
  //                                 1 → diff present (commit needed)
  // execOk returns true on exit 0, so the inverse is "something to commit".
  await exec("git", ["add", "-A"], { cwd: state.projectDir });

  // Defensive last-mile check: refuse to commit anything that smells
  // like a dotenvx private key, regardless of whether `.gitignore` is
  // up to date. Catches the bug we shipped once where `.env.keys` was
  // generated into a repo whose pre-existing `.gitignore` didn't cover
  // it; bootstrapDotenvxNow now appends `.env.keys` to `.gitignore`
  // BEFORE writing the file, but this guard is the cheap second line
  // of defence — it would have caught that bug too. See looksLikeDotenvxPrivateKey.
  const stagedFiles = await listStagedFiles(state.projectDir);
  const leaks = stagedFiles.filter((rel) =>
    looksLikeDotenvxPrivateKey(join(state.projectDir, rel)),
  );
  if (leaks.length > 0) {
    throw new Error(
      `Refusing to commit — staged files look like dotenvx private keys:\n` +
        leaks.map((p) => `      ${p}`).join("\n") +
        `\n\n  Add them to .gitignore and unstage:\n` +
        leaks.map((p) => `      git rm --cached ${p}`).join("\n") +
        `\n\n  Then re-run \`hatchkit adopt --resume\`.`,
    );
  }

  const cleanIndex = await execOk("git", ["diff", "--cached", "--quiet"], {
    cwd: state.projectDir,
  });
  if (!cleanIndex) {
    await exec("git", ["commit", "-m", "Adopt under hatchkit management"], {
      cwd: state.projectDir,
      spinner: "Creating commit...",
    });
  }

  // Create the GitHub repo + register `origin`, but DO NOT push yet.
  // The first push triggers the scaffolded GH Actions workflow, and
  // we want the Coolify deploy secrets in place before that fires —
  // otherwise the workflow's first run hits the "secret not set"
  // branch and skips the redeploy. Push happens at the end of
  // executePlan, once setCoolifyDeploySecrets has run.
  const create = await exec("gh", ["repo", "create", plan.name, "--private", "--source=."], {
    cwd: state.projectDir,
    spinner: `Creating GitHub repo: ${plan.name}...`,
  });
  if (create.exitCode !== 0) {
    console.log(chalk.yellow("  Could not create GitHub repo. Push manually once it exists:"));
    console.log(chalk.dim(`    cd ${state.projectDir}`));
    console.log(chalk.dim(`    gh repo create ${plan.name} --private --source=. --push`));
    return { gitInitialized };
  }
  const urlRes = await exec("gh", ["repo", "view", "--json", "url", "-q", ".url"], {
    cwd: state.projectDir,
  });
  const url = urlRes.stdout.trim();
  console.log(chalk.green(`  ✓ GitHub repo: ${url}`));
  const repoSlug = url ? url.replace(/^https?:\/\/github\.com\//, "") : undefined;
  return { url: url || undefined, gitInitialized, repoSlug };
}

// (pushInitialBranch lives in deploy/github.ts so create + adopt share it.)

interface ImportKeyResult {
  /** Keychain account name we wrote to. Same string adopt would later
   *  pass to `deleteSecret` during rollback. */
  account: string;
  /** True when the keychain entry didn't exist before this run. Adopt
   *  only records a `keychain` ledger step on `created === true` — a
   *  pre-existing entry is "owned" by an earlier run, so undoing this
   *  run shouldn't yank it. */
  created: boolean;
  /** True when there was actually anything to import (i.e. `.env.keys`
   *  was present and well-formed). Used by adopt to skip recording when
   *  this call was a silent no-op. */
  imported: boolean;
}

async function importKeyToKeychain(
  state: DetectedState,
  plan: AdoptPlan,
): Promise<ImportKeyResult> {
  const account = SECRET_KEYS.dotenvxPrivateKey(plan.name);
  const envKeysPath = join(dotenvxRootFor(plan, state.projectDir), ".env.keys");
  if (!existsSync(envKeysPath)) {
    console.log(
      chalk.yellow(
        `  · No .env.keys at ${relativeTo(envKeysPath)} — nothing to import to keychain.`,
      ),
    );
    return { account, created: false, imported: false };
  }
  const text = readFileSync(envKeysPath, "utf-8");
  const m = text.match(/^DOTENV_PRIVATE_KEY_PRODUCTION="?([0-9a-fA-F]+)"?/m);
  if (!m) {
    console.log(
      chalk.yellow(
        `  · ${relativeTo(envKeysPath)} doesn't contain DOTENV_PRIVATE_KEY_PRODUCTION — skipping import.`,
      ),
    );
    return { account, created: false, imported: false };
  }
  // Snapshot existence BEFORE writing so we can tell adopt's caller
  // whether the keychain entry is brand-new (record for rollback) or
  // a re-import of one that already existed (don't record — the
  // earlier run owns the rollback).
  const existing = await getSecret(account);
  await setSecret(account, m[1]);
  console.log(
    chalk.green(`  ✓ Imported dotenvx private key into the OS keychain (service: hatchkit)`),
  );
  return { account, created: !existing, imported: true };
}

function writeAdoptManifest(projectDir: string, plan: AdoptPlan): void {
  // Unknown bits (ports, deployTarget specifics) get conservative
  // defaults — adopt's role is to take inventory, not to make
  // infra decisions. The user can edit the manifest later.
  const manifest: ProjectManifest = {
    version: 1,
    cliVersion: getCliVersion(),
    scaffoldedAt: new Date().toISOString(),
    name: plan.name,
    domain: plan.domain,
    // Only persist non-empty descriptions — keeping the field absent
    // when unset is friendlier to manifest readers that haven't been
    // taught the new field yet (and to humans diffing the file).
    ...(plan.description ? { description: plan.description } : {}),
    features: plan.features,
    mlServices: [],
    s3Provider: ((): S3Provider => (plan.features.includes("s3") ? "existing" : "none"))(),
    deployTarget: "existing",
    // Persist deployment mode so `--resume` recovers the gh-pages
    // path without re-asking the user. Same back-compat invariant
    // as `surfaces` — readers without this field fall back to coolify.
    deploymentMode: plan.deploymentMode,
    ports: { server: 3000, client: 3001 },
    // Persist the surface choice so `--resume` doesn't re-infer
    // "server-only" just because there's no client/ directory in the
    // current layout.
    surfaces: plan.surfaces,
  };
  writeManifest(projectDir, manifest);
}

function relativeTo(p: string, from = process.cwd()): string {
  const rel = relative(from, p);
  return rel === "" ? "." : rel.startsWith("..") ? p : `./${rel}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Return the relative paths of files currently staged in the index.
 *  Used by setupGitHubRemote's defensive private-key guard. Quiet
 *  exit-1 (no diff) returns an empty list rather than throwing. */
async function listStagedFiles(cwd: string): Promise<string[]> {
  const res = await exec("git", ["diff", "--cached", "--name-only", "-z"], { cwd, silent: true });
  if (res.exitCode !== 0) return [];
  return res.stdout.split("\0").filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Build pipeline (Dockerfile + compose + GH Actions)
// ---------------------------------------------------------------------------

/** Compose the stepper summary for the build-pipeline row. Shows
 *  what'll happen if the user hits Adopt right now — separately
 *  noting which files already exist (will be left alone) vs which
 *  will be scaffolded. */
function renderBuildPipelineSummary(state: DetectedState, plan: AdoptPlan): string {
  if (!plan.scaffoldBuildPipeline) {
    return state.unknownWorkspaceLayout
      ? chalk.dim("no — unrecognised workspace layout, hand-author your own")
      : chalk.dim("no — leave files as-is");
  }
  const pipe = detectBuildPipeline(state.projectDir);
  const willWrite: string[] = [];
  const kept: string[] = [];
  if (pipe.hasDockerfile) kept.push("Dockerfile");
  else willWrite.push("Dockerfile");
  if (pipe.hasCompose) kept.push(pipe.composePath?.split("/").pop() ?? "compose");
  else willWrite.push("docker-compose.yml");
  if (pipe.hasDeployWorkflow) kept.push(".github/workflows/deploy.yml");
  else willWrite.push(".github/workflows/deploy.yml");
  if (willWrite.length === 0) return chalk.dim("all files already present — nothing to write");
  const writePart = `write ${willWrite.join(", ")}`;
  const keepPart = kept.length > 0 ? chalk.dim(` · keep ${kept.join(", ")}`) : "";
  // Strong warning when the user has overridden the unknown-layout
  // default. We still write the files (their call), but flag that the
  // templates' single-package assumption probably doesn't fit this repo.
  const layoutWarn = state.unknownWorkspaceLayout
    ? `  ${chalk.yellow("(unrecognised workspace — templates may build the wrong thing)")}`
    : "";
  return `${writePart}${keepPart}${layoutWarn}`;
}

function detectDockerComposeDomainServiceName(projectDir: string, surfaces: AdoptSurface): string {
  const pipe = detectBuildPipeline(projectDir);
  if (!pipe.composePath) return "app";
  const services = readComposeServiceNames(pipe.composePath);
  if (services.length === 0) return "app";

  const preferred =
    surfaces === "client-only"
      ? ["app", "web", "client", "frontend", "site"]
      : ["app", "server", "api", "backend", "web", "client", "frontend"];
  for (const name of preferred) {
    if (services.includes(name)) return name;
  }

  const infraServices = new Set([
    "db",
    "database",
    "postgres",
    "postgresql",
    "mysql",
    "mariadb",
    "mongo",
    "mongodb",
    "redis",
    "cache",
    "minio",
    "mailhog",
    "nginx",
    "traefik",
  ]);
  return services.find((name) => !infraServices.has(name)) ?? services[0] ?? "app";
}

function readComposeServiceNames(composePath: string): string[] {
  let content: string;
  try {
    content = readFileSync(composePath, "utf-8");
  } catch {
    return [];
  }

  const names: string[] = [];
  let inServices = false;
  let servicesIndent = 0;
  let serviceIndent: number | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = rawLine.trim();

    if (!inServices) {
      if (/^services\s*:/.test(trimmed)) {
        inServices = true;
        servicesIndent = indent;
      }
      continue;
    }

    if (indent <= servicesIndent && /^[\w.-]+\s*:/.test(trimmed)) break;
    if (indent <= servicesIndent) continue;
    if (serviceIndent === undefined) serviceIndent = indent;
    if (indent !== serviceIndent) continue;

    const match = trimmed.match(/^["']?([\w.-]+)["']?\s*:/);
    const name = match?.[1];
    if (name && !name.startsWith("x-")) names.push(name);
  }

  return names;
}

async function scaffoldBuildPipelineNow(
  state: DetectedState,
  plan: AdoptPlan,
  remoteUrl: string | undefined,
  opts: { force?: boolean } = {},
): Promise<{ createdAbsPaths: string[]; overwrittenAbsPaths: string[] }> {
  // Owner inference for the GHCR image. Falls back to "OWNER" if we
  // can't tell — the scaffolded compose still works once the user
  // edits it, and they get a clear hint in the summary.
  const owner = ownerFromRemote(remoteUrl) ?? "OWNER";
  const defaultBranch = await detectDefaultBranch(state.projectDir);
  const result = scaffoldBuildPipeline({
    projectDir: state.projectDir,
    projectName: plan.name,
    ghOwner: owner,
    entrypoint: plan.surfaces === "client-only" ? "" : "dist/index.js",
    port: Number(plan.appPort) || 3000,
    surfaces: plan.surfaces,
    defaultBranch,
    force: !!opts.force,
  });
  if (result.created.length > 0) {
    console.log(chalk.green(`  ✓ Scaffolded: ${result.created.join(", ")}`));
  }
  if (result.overwritten.length > 0) {
    console.log(chalk.yellow(`  ↻ Regenerated: ${result.overwritten.join(", ")}`));
  }
  if (result.skipped.length > 0) {
    console.log(chalk.dim(`  · Kept existing: ${result.skipped.join(", ")}`));
  }
  if (result.dockerignorePatched) {
    console.log(
      chalk.dim(
        `  · Patched ${result.dockerignorePatched}: appended !.env.production so dotenvx can decrypt inside the build`,
      ),
    );
  }
  if (owner === "OWNER") {
    console.log(
      chalk.yellow(
        "  ⚠ Couldn't infer GitHub owner from origin — edit `image: ghcr.io/OWNER/...`\n" +
          "    in docker-compose.yml before pushing.",
      ),
    );
  }
  // Promote project-relative paths to absolute so the caller doesn't
  // need to know the project root for ledger entries / dedup.
  return {
    createdAbsPaths: result.created.map((rel) => join(state.projectDir, rel)),
    overwrittenAbsPaths: result.overwritten.map((rel) => join(state.projectDir, rel)),
  };
}

/** Best-effort default branch detection. `git symbolic-ref` only
 *  works after `git remote set-head origin -a` has cached the
 *  upstream HEAD locally — `gh repo create --push` doesn't always do
 *  that. Run it ourselves first (silently), then read the symbolic
 *  ref. Falls through to `main` (GitHub's default) when the remote
 *  doesn't have one yet (e.g. brand-new empty repo). All exec calls
 *  are silenced so the inevitable "not a symbolic ref" stderr noise
 *  doesn't leak into adopt's clean output. */
async function detectDefaultBranch(projectDir: string): Promise<string> {
  try {
    // First, ask the remote what its HEAD is and cache it locally.
    // No-ops + exits non-zero on offline / no-permissions / empty-repo
    // cases; we don't care about the exit code.
    await exec("git", ["remote", "set-head", "origin", "-a"], {
      cwd: projectDir,
      silent: true,
    });
    const res = await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: projectDir,
      silent: true,
    });
    if (res.exitCode === 0) {
      const branch = res.stdout.trim().replace(/^origin\//, "");
      if (branch) return branch;
    }
  } catch {
    /* ignore */
  }
  return "main";
}

// (GitHub Actions secret push moved to deploy/gh-actions-secrets.ts so
//  `hatchkit create` can call the same helper.)
