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

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Separator, checkbox, confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { getCoolifyConfig } from "./config.js";
import { pushProjectKeyToCoolify } from "./deploy/keys.js";
import { type ProvisionService, runProvision } from "./provision/index.js";
import { MANIFEST_FILENAME, type ProjectManifest, writeManifest } from "./scaffold/manifest.js";
import type { Feature, S3Provider } from "./prompts.js";
import { CoolifyApi } from "./utils/coolify-api.js";
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
}

interface AdoptPlan {
  name: string;
  domain: string;
  features: Feature[];
  serverDir: string;
  clientDir?: string;
  /** Provisioning to run after manifest write. */
  services: ProvisionService[];
  /** Push dotenvx key to Coolify after everything's written. */
  pushKey: boolean;
}

export async function runAdopt(cwd: string): Promise<void> {
  const state = await detectProject(cwd);

  if (state.hasManifest) {
    console.log(
      chalk.yellow(
        `\n  ${MANIFEST_FILENAME} already exists in ${relativeTo(state.projectDir)}.`,
      ),
    );
    console.log(
      chalk.dim(
        "  This project is already adopted. Use `hatchkit update` to add features, or\n" +
          "  `hatchkit add <project>` to (re-)provision per-project clients.\n",
      ),
    );
    return;
  }

  console.log(chalk.bold("\n  hatchkit adopt"));
  printDetected(state);

  // Initial plan — pre-filled from detection.
  let plan: AdoptPlan = {
    name: state.packageName ?? "",
    domain: "",
    features: state.features,
    serverDir: state.serverDir ?? state.projectDir,
    clientDir: state.clientDir,
    services: ["glitchtip", "openpanel", "resend"],
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

  let packageName: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8")) as {
      name?: string;
    };
    packageName = pkg.name?.replace(/^@[^/]+\//, ""); // strip scope
  } catch {
    // No package.json at root — that's fine for a non-Node project.
  }

  // Walk a small set of common monorepo layouts.
  const serverDir = firstExisting(projectDir, [
    "packages/server",
    "apps/server",
    "apps/api",
    "server",
  ]);
  const clientDir = firstExisting(projectDir, [
    "packages/client",
    "packages/web",
    "apps/web",
    "apps/client",
    "client",
    "web",
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

  // Look at root + server package.json deps.
  const pkgJsonPaths = [
    join(projectDir, "package.json"),
    serverDir ? join(serverDir, "package.json") : undefined,
  ].filter((p): p is string => !!p);
  for (const p of pkgJsonPaths) {
    if (!existsSync(p)) continue;
    let json: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      json = JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      continue;
    }
    const deps = { ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) };
    if ("stripe" in deps || "@stripe/stripe-js" in deps) found.add("stripe");
    if ("socket.io" in deps || "ws" in deps) found.add("websocket");
    if ("@sentry/node" in deps || "@sentry/browser" in deps || "@openpanel/web" in deps) {
      found.add("analytics");
    }
    if ("@aws-sdk/client-s3" in deps) found.add("s3");
    if ("electron" in deps || "electron-builder" in deps) found.add("desktop");
    if ("@capacitor/core" in deps) found.add("mobile");
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
        : chalk.dim("(no match — keys push will be skipped by default)"),
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
          key: "serverDir",
          label: "Server env dir",
          set: !!plan.serverDir,
          summary: plan.serverDir ? relativeTo(plan.serverDir) : "(unset)",
        },
        {
          key: "clientDir",
          label: "Client env dir",
          set: true, // optional — empty is fine
          summary: plan.clientDir ? relativeTo(plan.clientDir) : chalk.dim("(none — server only)"),
        },
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
    const useClient = await confirm({
      message: "Does this project have a separate browser bundle?",
      default: !!plan.clientDir,
    });
    if (!useClient) return { ...plan, clientDir: undefined };
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
  return plan;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function executePlan(state: DetectedState, plan: AdoptPlan): Promise<void> {
  console.log(chalk.bold("\n  ── Adopting ──────────────────────────────────────────────\n"));

  // Step 1: dotenvx encryption + key import.
  await encryptIfNeeded(state, plan);
  await importKeyToKeychain(state, plan);

  // Step 2: write the manifest. Done after key import so a partial
  // failure doesn't leave a manifest pointing at no key. The
  // manifest lives at the project ROOT (not under packages/server).
  writeAdoptManifest(state.projectDir, plan);
  console.log(
    chalk.green(`  ✓ Wrote ${MANIFEST_FILENAME} at ${relativeTo(state.projectDir)}`),
  );

  // Step 3: provision clients via the existing `add` machinery so the
  // surfaces stepper, idempotency, and env writes behave identically
  // to a normal `hatchkit add`.
  if (plan.services.length > 0) {
    console.log();
    await runProvision({
      baseName: plan.name,
      services: plan.services,
      surfaces: {
        mode: plan.clientDir ? "shared" : "server-only",
        serverEnvDir: plan.serverDir,
        clientEnvDir: plan.clientDir,
      },
    });
  }

  // Step 4: push key to Coolify.
  if (plan.pushKey) {
    try {
      await pushProjectKeyToCoolify(plan.name);
      console.log(chalk.green(`\n  ✓ Pushed dotenvx key to Coolify`));
    } catch (err) {
      console.log(
        chalk.yellow(`\n  Couldn't push dotenvx key to Coolify: ${(err as Error).message}`),
      );
      console.log(
        chalk.dim(
          `  Once the app exists, run: \`hatchkit keys push ${plan.name}\``,
        ),
      );
    }
  }

  console.log(chalk.bold("\n  ── Adopted ───────────────────────────────────────────────\n"));
  console.log(`  Project:   ${chalk.cyan(plan.name)}`);
  console.log(`  Domain:    ${chalk.cyan(plan.domain)}`);
  console.log(`  Server:    ${chalk.cyan(relativeTo(plan.serverDir))}`);
  if (plan.clientDir) console.log(`  Client:    ${chalk.cyan(relativeTo(plan.clientDir))}`);
  console.log(`  Manifest:  ${chalk.dim(join(state.projectDir, MANIFEST_FILENAME))}`);
  console.log(
    chalk.dim(
      "\n  Next: `hatchkit doctor` to verify providers, `hatchkit keys push` if you skipped that step.\n",
    ),
  );
}

async function encryptIfNeeded(state: DetectedState, plan: AdoptPlan): Promise<void> {
  if (state.prodEnvIsEncrypted) {
    console.log(chalk.dim("  · .env.production already encrypted — skipping encrypt step."));
    return;
  }
  const prodPath = join(plan.serverDir, ".env.production");
  if (!existsSync(prodPath)) {
    console.log(
      chalk.dim(
        `  · No .env.production at ${relativeTo(prodPath)} yet — provisioning will create + encrypt it.`,
      ),
    );
    return;
  }
  const ora = (await import("ora")).default;
  const spinner = ora("Encrypting .env.production with dotenvx...").start();
  try {
    // Calling `dotenvx set` with a no-op key forces encryption of the
    // existing file: it reads, encrypts, generates the keypair, and
    // writes .env.keys. We use a sentinel that's a real string so it
    // stays in the file (no harm, easy to grep + remove later).
    const { set: dotenvxSet } = await import("@dotenvx/dotenvx");
    dotenvxSet("HATCHKIT_ADOPTED", new Date().toISOString(), {
      path: prodPath,
      encrypt: true,
    });
    spinner.succeed("Encrypted .env.production");
  } catch (err) {
    spinner.fail("Failed to encrypt .env.production");
    throw err;
  }
}

async function importKeyToKeychain(state: DetectedState, plan: AdoptPlan): Promise<void> {
  const envKeysPath = join(plan.serverDir, ".env.keys");
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
