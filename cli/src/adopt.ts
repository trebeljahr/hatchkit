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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { Separator, confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { ensureGitHub, getCoolifyConfig } from "./config.js";
import {
  ownerFromRemote,
  repoSlugFromRemote,
  setCoolifyDeploySecrets,
} from "./deploy/gh-actions-secrets.js";
import { pushInitialBranch } from "./deploy/github.js";
import { pushProjectKeyToCoolify } from "./deploy/keys.js";
import { handleAdoptFailure } from "./deploy/rollback.js";
import type { Feature, S3Provider } from "./prompts.js";
import { type ProvisionService, runProvision } from "./provision/index.js";
import { detectBuildPipeline, scaffoldBuildPipeline } from "./scaffold/build-pipeline.js";
import {
  MANIFEST_FILENAME,
  type ProjectManifest,
  readManifest,
  writeManifest,
} from "./scaffold/manifest.js";
import { CoolifyApi } from "./utils/coolify-api.js";
import { exec, execOk } from "./utils/exec.js";
import { multiselect } from "./utils/multiselect.js";
import { RunLedger } from "./utils/run-ledger.js";
import { SECRET_KEYS, getSecret, setSecret } from "./utils/secrets.js";
import { validateDomain, validateProjectName } from "./utils/validate.js";
import { getCliVersion } from "./utils/version.js";

interface DetectedState {
  /** Absolute path to the project root. */
  projectDir: string;
  /** package.json `name` if any. */
  packageName?: string;
  /** Whether `<root>/.hatchkit.json` already exists — adopt refuses
   *  to overwrite; the user should run `hatchkit update` instead. */
  hasManifest: boolean;
  /** Where the server's env files live, if detectable. */
  serverDir?: string;
  /** Where the client's env files live, if detectable. */
  clientDir?: string;
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

interface AdoptPlan {
  name: string;
  domain: string;
  features: Feature[];
  /** What kind of project this is — drives where env files go, which
   *  Coolify build-pack we ask for, and which surfaces `hatchkit add`
   *  provisions clients into. */
  surfaces: AdoptSurface;
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
  let plan: AdoptPlan = {
    name: m?.name ?? state.packageName ?? "",
    domain: m?.domain ?? "",
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
    scaffoldBuildPipeline: true,
    services: ["glitchtip", "openpanel", "resend"],
    // Default the push only when there's already a Coolify app to push to.
    // When wireCoolify creates a fresh app, it sets the baseline env
    // itself (including the dotenvx key), so a separate push is
    // redundant in that branch.
    pushKey: !!state.coolifyAppMatch,
  };

  plan = await reviewLoop(state, plan);

  await executePlan(state, plan, {
    resume: !!opts.resume,
    regeneratePipeline: !!opts.regeneratePipeline,
  });
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

async function detectProject(projectDir: string): Promise<DetectedState> {
  const hasManifest = existsSync(join(projectDir, MANIFEST_FILENAME));
  const existingManifest = hasManifest ? (readManifest(projectDir) ?? undefined) : undefined;

  let packageName: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8")) as {
      name?: string;
    };
    packageName = pkg.name?.replace(/^@[^/]+\//, ""); // strip scope
  } catch {
    // No package.json at root — that's fine for a non-Node project.
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
        const wanted = [packageName, `${packageName}-web`, `${packageName}-server`];
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
      const res = await exec(
        "gh",
        ["repo", "view", "--json", "visibility", "-q", ".visibility"],
        { cwd: projectDir, silent: true },
      );
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

  return {
    projectDir,
    packageName,
    hasManifest,
    serverDir,
    clientDir,
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
            ? `${plan.domain}  ${chalk.dim("→")}  https://${plan.domain}/api`
            : "(unset)",
        },
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
    {
      title: "Build pipeline",
      steps: [
        {
          key: "scaffoldBuildPipeline",
          label: "Docker + GH Actions",
          set: true,
          summary: renderBuildPipelineSummary(state, plan),
        },
      ],
    },
    {
      title: "Deploy",
      steps: [
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
                ? chalk.yellow(
                    ` (gh says ${detected ? "private" : "public"} — overridden)`,
                  )
                : "";
          return {
            key: "isPrivate",
            label: "Repo visibility",
            // `set: false` when we have a remote but couldn't detect
            // (forces the user to confirm before Adopt). Otherwise true.
            set: !(detected === undefined && !!state.gitRemoteUrl),
            summary: `${summaryBase}${detectedHint}`,
          };
        })(),
        ((): AdoptStep => {
          // Preflight: when adopt will be wiring a private repo into
          // Coolify and Coolify has zero GitHub App sources, the wire
          // step will throw at execute time with "no Coolify GitHub
          // source configured". Surface that here so the cursor parks
          // on this row and the user fixes it before hitting Adopt.
          const missingSource =
            plan.wireCoolify &&
            plan.isPrivate &&
            state.coolifyConfigured &&
            state.coolifyGithubSourceCount === 0;
          const baseSummary = plan.wireCoolify
            ? state.coolifyAppMatch
              ? chalk.dim(`existing app "${state.coolifyAppMatch.name}" — will reconcile build pack`)
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
      ],
    },
  ];
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
    return {
      ...plan,
      surfaces: next,
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
          checked: plan.services.includes("glitchtip") && plan.features.includes("analytics"),
        },
        {
          name: "OpenPanel (analytics)",
          value: "openpanel",
          checked: plan.services.includes("openpanel") && plan.features.includes("analytics"),
        },
        {
          name: "Resend (email)",
          value: "resend",
          checked: plan.services.includes("resend"),
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
      detected === undefined
        ? ""
        : ` (gh detected: ${detected ? "private" : "public"})`;
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
    if (plan.scaffoldBuildPipeline) {
      const pipeResult = await scaffoldBuildPipelineNow(state, plan, remoteUrl, {
        force: !!opts.regeneratePipeline,
      });
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
    if (plan.wireCoolify && remoteUrl) {
      try {
        const { wireProjectIntoCoolify } = await import("./deploy/coolify-app.js");
        coolifyResult = await wireProjectIntoCoolify({
          projectName: plan.name,
          domain: plan.domain,
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
          // Explicit choice from the stepper. Defaulted from `gh repo
          // view --json visibility` for existing remotes, `true` for
          // newly-created `gh repo create --private` repos. See the
          // comment on AdoptPlan.isPrivate.
          isPrivate: plan.isPrivate,
        });
        // Record only the bits we actually created. wireProjectIntoCoolify
        // returns explicit `*Created` flags exactly so adopt can guard
        // each ledger entry against the "found by name, reused" branch.
        if (coolifyResult.appCreated) {
          ledger.record({ kind: "coolifyApp", uuid: coolifyResult.appUuid });
        }
        if (coolifyResult.projectCreated) {
          ledger.record({ kind: "coolifyProject", uuid: coolifyResult.projectUuid });
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
    const appUuidForSecrets = coolifyResult?.appUuid ?? state.coolifyAppMatch?.uuid;
    if (plan.scaffoldBuildPipeline && appUuidForSecrets) {
      const slug = repoSlugFromRemote(remoteUrl);
      if (slug) {
        await setCoolifyDeploySecrets({
          projectDir: state.projectDir,
          repoSlug: slug,
          apps: [{ uuid: appUuidForSecrets }],
        });
      } else {
        console.log(
          chalk.dim(
            "  · Couldn't resolve owner/repo from git remote — set the deploy secrets manually.",
          ),
        );
      }
    }

    // Step 3d: push the working branch to origin. Done AFTER secrets
    // are set so the workflow's first run can hit the Coolify webhook
    // without falling through to the "secret not set" branch. Skipped
    // when there's no remote yet (e.g. user opted out of GitHub) or
    // when origin already had history before adopt.
    if (plan.setupGitHub && remoteUrl && !state.gitRemoteUrl) {
      await pushInitialBranch(state.projectDir);
    }

    // Step 4: provision clients via the existing `add` machinery so the
    // surfaces stepper, idempotency, and env writes behave identically
    // to a normal `hatchkit add`. Forward the surface choice — runProvision
    // uses the same vocabulary, so a client-only adopt produces a
    // client-only `add`.
    if (plan.services.length > 0) {
      console.log();
      const provisionMode =
        plan.surfaces === "both"
          ? "shared"
          : plan.surfaces === "server-only"
            ? "server-only"
            : "client-only";
      await runProvision({
        baseName: plan.name,
        services: plan.services,
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
          }
        },
      });
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
    // Mid-flight throw — surface the partial state via the same
    // recipe/rollback/leave UX `hatchkit create` uses, then exit.
    // The ledger holds only resources adopt itself created (see the
    // gating on each `ledger.record(...)` call above), so a "yes,
    // roll back" choice is safe to take.
    await handleAdoptFailure(ledger, err);
    process.exit(1);
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
    if (coolifyResult.ipMismatchWarning) {
      console.log(`  ${chalk.yellow("⚠")}  ${chalk.dim(coolifyResult.ipMismatchWarning)}`);
    }
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
  return { keysPath, createdKeysFile: !keysExistedBefore };
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
    features: plan.features,
    mlServices: [],
    s3Provider: ((): S3Provider => (plan.features.includes("s3") ? "existing" : "none"))(),
    deployTarget: "existing",
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

// ---------------------------------------------------------------------------
// Build pipeline (Dockerfile + compose + GH Actions)
// ---------------------------------------------------------------------------

/** Compose the stepper summary for the build-pipeline row. Shows
 *  what'll happen if the user hits Adopt right now — separately
 *  noting which files already exist (will be left alone) vs which
 *  will be scaffolded. */
function renderBuildPipelineSummary(state: DetectedState, plan: AdoptPlan): string {
  if (!plan.scaffoldBuildPipeline) return chalk.dim("no — leave files as-is");
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
  return `${writePart}${keepPart}`;
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
