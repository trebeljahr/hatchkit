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
import { Separator, checkbox, confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { ensureGitHub, getCoolifyConfig } from "./config.js";
import { pushProjectKeyToCoolify } from "./deploy/keys.js";
import { type ProvisionService, runProvision } from "./provision/index.js";
import {
  MANIFEST_FILENAME,
  type ProjectManifest,
  readManifest,
  writeManifest,
} from "./scaffold/manifest.js";
import type { Feature, S3Provider } from "./prompts.js";
import { CoolifyApi } from "./utils/coolify-api.js";
import { exec, execOk } from "./utils/exec.js";
import { SECRET_KEYS, setSecret } from "./utils/secrets.js";
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
  /** Whether `<projectDir>/.git` exists. */
  isGitRepo: boolean;
  /** Origin URL from `git remote get-url origin`, if set. */
  gitRemoteUrl?: string;
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
  /** Container port the app exposes — defaults to "3000". */
  appPort: string;
  /** Provisioning to run after manifest write. */
  services: ProvisionService[];
  /** Push dotenvx key to Coolify after everything's written. */
  pushKey: boolean;
}

export async function runAdopt(cwd: string, opts: { resume?: boolean } = {}): Promise<void> {
  const state = await detectProject(cwd);

  if (state.hasManifest && !opts.resume) {
    console.log(
      chalk.yellow(
        `\n  ${MANIFEST_FILENAME} already exists in ${relativeTo(state.projectDir)}.`,
      ),
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
  // Surfaces inference: trust both detected dirs. When only one is
  // detected, default to the matching surface; when both, "both"; when
  // neither, fall back to "server-only" at the project root for
  // backward compat with the original adopt behaviour.
  const inferredSurfaces: AdoptSurface =
    state.serverDir && state.clientDir
      ? "both"
      : state.serverDir
        ? "server-only"
        : state.clientDir
          ? "client-only"
          : "server-only";
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
    appPort: "3000",
    services: ["glitchtip", "openpanel", "resend"],
    // Default the push only when there's already a Coolify app to push to.
    // When wireCoolify creates a fresh app, it sets the baseline env
    // itself (including the dotenvx key), so a separate push is
    // redundant in that branch.
    pushKey: !!state.coolifyAppMatch,
  };

  plan = await reviewLoop(state, plan);

  await executePlan(state, plan);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

async function detectProject(projectDir: string): Promise<DetectedState> {
  const hasManifest = existsSync(join(projectDir, MANIFEST_FILENAME));
  const existingManifest = hasManifest ? readManifest(projectDir) ?? undefined : undefined;

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
  const envKeysPath = serverDir
    ? join(serverDir, ".env.keys")
    : join(projectDir, ".env.keys");
  let prodEnvIsEncrypted = false;
  if (existsSync(prodEnvPath)) {
    const head = readFileSync(prodEnvPath, "utf-8").slice(0, 2000);
    prodEnvIsEncrypted = /DOTENV_PUBLIC_KEY_PRODUCTION/.test(head);
  }
  const hasEnvKeys = existsSync(envKeysPath);

  // Coolify app match — best-effort, requires Coolify configured. If
  // it isn't, leave it undefined; the user can still adopt without it.
  let coolifyAppMatch: { uuid: string; name: string } | undefined;
  try {
    const cfg = await getCoolifyConfig();
    if (cfg && packageName) {
      const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
      const apps = await api.listApplications();
      const wanted = [packageName, `${packageName}-web`, `${packageName}-server`];
      const match = apps.find((a) => wanted.includes(a.name));
      if (match) coolifyAppMatch = { uuid: match.uuid, name: match.name };
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
    isGitRepo,
    gitRemoteUrl,
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
  const row = (label: string, value: string) =>
    `  ${chalk.dim(label.padEnd(18))} ${value}`;

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
  lines.push(
    row(".env.keys", state.hasEnvKeys ? chalk.green("present ✓") : chalk.dim("missing")),
  );
  lines.push(
    row(
      "Coolify app",
      state.coolifyAppMatch
        ? chalk.green(`${state.coolifyAppMatch.name} ✓`)
        : chalk.dim("(no match)"),
    ),
  );
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
        {
          key: "surfaces",
          label: "Surfaces",
          set: true,
          summary:
            plan.surfaces === "server-only"
              ? "server only (backend / API)"
              : plan.surfaces === "client-only"
                ? "client only (static / SPA — no backend)"
                : "server + client",
        },
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
      title: "Deploy",
      steps: [
        {
          key: "wireCoolify",
          label: "Coolify + DNS",
          set: true,
          summary: plan.wireCoolify
            ? state.coolifyAppMatch
              ? chalk.dim(`existing app "${state.coolifyAppMatch.name}" — will skip create`)
              : `yes — create app + upsert DNS (port ${plan.appPort})`
            : state.coolifyAppMatch
              ? chalk.dim(`already exists: ${state.coolifyAppMatch.name}`)
              : chalk.dim("no"),
        },
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
    const features = await checkbox<Feature>({
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
    const services = await checkbox<ProvisionService>({
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
        chalk.dim(
          `\n  origin already set to ${state.gitRemoteUrl} — adopt won't replace it.\n`,
        ),
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
  if (step === "wireCoolify") {
    const wireCoolify = await confirm({
      message: state.coolifyAppMatch
        ? `App "${state.coolifyAppMatch.name}" already exists — re-wire (will create a duplicate)?`
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
  return plan;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function executePlan(state: DetectedState, plan: AdoptPlan): Promise<void> {
  console.log(chalk.bold("\n  ── Adopting ──────────────────────────────────────────────\n"));

  // Step 1: bootstrap / encrypt dotenvx so a key actually exists.
  if (plan.bootstrapDotenvx) {
    await bootstrapDotenvxNow(state, plan);
  } else {
    console.log(chalk.dim("  · Skipping dotenvx bootstrap (per stepper choice)."));
  }
  await importKeyToKeychain(state, plan);

  // Step 2: write the manifest. Done after key import so a partial
  // failure doesn't leave a manifest pointing at no key. The
  // manifest lives at the project ROOT (not under packages/server).
  writeAdoptManifest(state.projectDir, plan);
  console.log(
    chalk.green(`  ✓ Wrote ${MANIFEST_FILENAME} at ${relativeTo(state.projectDir)}`),
  );

  // Step 3: GitHub remote (init + create + push). Skipped if origin is
  // already set or the user opted out.
  let remoteUrl: string | undefined = state.gitRemoteUrl;
  if (plan.setupGitHub && !state.gitRemoteUrl) {
    remoteUrl = await setupGitHubRemote(state, plan);
  } else if (state.gitRemoteUrl) {
    console.log(chalk.dim(`  · git origin already set → ${state.gitRemoteUrl}`));
  }

  // Step 3b: Wire the repo into Coolify + DNS via direct API calls.
  // No infra/ submodule, no Terraform — just hits the Coolify and
  // DNS-provider REST endpoints with credentials we already have in
  // keychain. Idempotent on the DNS side (upsert); not yet on the
  // app-create side (Coolify accepts duplicate app names).
  let coolifyResult: Awaited<ReturnType<typeof import("./deploy/coolify-app.js").wireProjectIntoCoolify>>
    | undefined;
  if (plan.wireCoolify && remoteUrl) {
    try {
      const { wireProjectIntoCoolify } = await import("./deploy/coolify-app.js");
      coolifyResult = await wireProjectIntoCoolify({
        projectName: plan.name,
        domain: plan.domain,
        gitRepository: remoteUrl,
        // For client-only projects (static sites / SPAs) Coolify wants
        // its `static` build pack and doesn't need a runtime port —
        // bind to 80 so the API still has the field it requires.
        // Server / both surfaces fall back to nixpacks on the chosen
        // port.
        buildPack: plan.surfaces === "client-only" ? "static" : "nixpacks",
        portsExposes: plan.surfaces === "client-only" ? "80" : plan.appPort,
        // Default assumption: anything we just `gh repo create --private`d
        // is private. If origin was already set we don't know for sure;
        // try public first (cheaper auth) and let the orchestrator handle
        // the fallback.
        isPrivate: plan.setupGitHub,
      });
    } catch (err) {
      console.log(
        chalk.yellow(`\n  Couldn't wire Coolify: ${(err as Error).message}`),
      );
      console.log(
        chalk.dim(
          `  Create the app manually in the Coolify dashboard pointing at\n` +
            `    ${remoteUrl}\n` +
            `  with domain ${plan.domain} and port ${plan.appPort}, then run\n` +
            `    hatchkit keys push ${plan.name}`,
        ),
      );
    }
  } else if (plan.wireCoolify && !remoteUrl) {
    console.log(
      chalk.yellow(
        "  Coolify wiring needs a git remote URL — skipping (no `origin` set and the GitHub step\n" +
          "  was off). Set the remote yourself or re-run with `setup GitHub remote = yes`.",
      ),
    );
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
        chalk.dim(
          `  · Skipping standalone key push — Coolify wiring failed, no app to push to.`,
        ),
      );
    } else {
      try {
        await pushProjectKeyToCoolify(plan.name);
        console.log(chalk.green(`\n  ✓ Pushed dotenvx key to Coolify`));
      } catch (err) {
        console.log(
          chalk.yellow(`\n  Couldn't push dotenvx key to Coolify: ${(err as Error).message}`),
        );
        console.log(
          chalk.dim(`  Once the app exists, run: \`hatchkit keys push ${plan.name}\``),
        );
      }
    }
  }

  console.log(chalk.bold("\n  ── Adopted ───────────────────────────────────────────────\n"));
  console.log(`  Project:   ${chalk.cyan(plan.name)}`);
  console.log(`  Domain:    ${chalk.cyan(plan.domain)}`);
  if (plan.serverDir) console.log(`  Server:    ${chalk.cyan(relativeTo(plan.serverDir))}`);
  if (plan.clientDir) console.log(`  Client:    ${chalk.cyan(relativeTo(plan.clientDir))}`);
  console.log(`  Surfaces:  ${chalk.cyan(plan.surfaces)}`);
  console.log(`  Manifest:  ${chalk.dim(join(state.projectDir, MANIFEST_FILENAME))}`);
  if (remoteUrl) console.log(`  Git:       ${chalk.cyan(remoteUrl)}`);
  if (coolifyResult) {
    console.log(`  Coolify:   ${chalk.cyan(coolifyResult.appUuid)}  ${chalk.dim(`@ ${coolifyResult.serverIp}`)}`);
    if (coolifyResult.dnsManaged) {
      console.log(`  DNS:       ${chalk.green("✓")}  ${chalk.dim(`A ${plan.domain} → ${coolifyResult.serverIp}`)}`);
    } else if (plan.domain && coolifyResult.serverIp) {
      console.log(
        `  DNS:       ${chalk.yellow("✗")}  ${chalk.dim(
          `add A ${plan.domain} → ${coolifyResult.serverIp} manually`,
        )}`,
      );
    }
  }
  console.log();
}

/** Where dotenvx writes the encrypted env. Server-only / both layouts
 *  use the server dir (canonical for runtime decryption); client-only
 *  layouts use the client dir. Both fall back to the project root if
 *  detection / the user picked nothing more specific. */
function dotenvxRootFor(plan: AdoptPlan, projectDir: string): string {
  if (plan.surfaces === "client-only") return plan.clientDir ?? projectDir;
  return plan.serverDir ?? projectDir;
}

async function bootstrapDotenvxNow(state: DetectedState, plan: AdoptPlan): Promise<void> {
  const prodPath = join(dotenvxRootFor(plan, state.projectDir), ".env.production");
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
}

async function setupGitHubRemote(
  state: DetectedState,
  plan: AdoptPlan,
): Promise<string | undefined> {
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
    return undefined;
  }

  console.log(chalk.bold("\n  ── GitHub ────────────────────────────────────────────────\n"));

  if (!state.isGitRepo) {
    await exec("git", ["init"], {
      cwd: state.projectDir,
      spinner: "Initializing git repo...",
    });
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

  // `gh repo create` with --source=. + --push handles remote creation
  // and the initial push in one shot. --private matches the default
  // behaviour of `hatchkit create`.
  const create = await exec(
    "gh",
    ["repo", "create", plan.name, "--private", "--source=.", "--push"],
    { cwd: state.projectDir, spinner: `Creating GitHub repo: ${plan.name}...` },
  );
  if (create.exitCode !== 0) {
    console.log(chalk.yellow("  Could not create GitHub repo. Push manually once it exists:"));
    console.log(chalk.dim(`    cd ${state.projectDir}`));
    console.log(chalk.dim(`    gh repo create ${plan.name} --private --source=. --push`));
    return undefined;
  }
  const urlRes = await exec("gh", ["repo", "view", "--json", "url", "-q", ".url"], {
    cwd: state.projectDir,
  });
  const url = urlRes.stdout.trim();
  console.log(chalk.green(`  ✓ GitHub repo: ${url}`));
  return url || undefined;
}

async function importKeyToKeychain(state: DetectedState, plan: AdoptPlan): Promise<void> {
  const envKeysPath = join(dotenvxRootFor(plan, state.projectDir), ".env.keys");
  if (!existsSync(envKeysPath)) {
    console.log(
      chalk.yellow(
        `  · No .env.keys at ${relativeTo(envKeysPath)} — nothing to import to keychain.`,
      ),
    );
    return;
  }
  const text = readFileSync(envKeysPath, "utf-8");
  const m = text.match(/^DOTENV_PRIVATE_KEY_PRODUCTION="?([0-9a-fA-F]+)"?/m);
  if (!m) {
    console.log(
      chalk.yellow(
        `  · ${relativeTo(envKeysPath)} doesn't contain DOTENV_PRIVATE_KEY_PRODUCTION — skipping import.`,
      ),
    );
    return;
  }
  await setSecret(SECRET_KEYS.dotenvxPrivateKey(plan.name), m[1]);
  console.log(
    chalk.green(`  ✓ Imported dotenvx private key into the OS keychain (service: hatchkit)`),
  );
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
  };
  writeManifest(projectDir, manifest);
}

function relativeTo(p: string, from = process.cwd()): string {
  const rel = relative(from, p);
  return rel === "" ? "." : rel.startsWith("..") ? p : `./${rel}`;
}
