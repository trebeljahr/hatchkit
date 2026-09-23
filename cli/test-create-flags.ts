/**
 * `hatchkit create` flag surface.
 *
 * Covers the three things that make the command driveable from argv
 * instead of the inquirer stepper:
 *
 *   1. Parsing    — every prompt has a flag, and it lands in `presets`.
 *   2. Precedence — a flag wins over `--config`, and supplying a value
 *                   SKIPS its prompt (partial flag sets still prompt for
 *                   the rest).
 *   3. Validation — bad enum / list values fail early listing the valid
 *                   ones, and `--yes` hard-fails naming the missing flag
 *                   instead of prompting.
 *
 * The precedence check drives the real stepper: `runSteps` logs a
 * `[n/N] <step name>` line immediately before running a step, so a
 * console.log hook that throws on that line tells us exactly which
 * prompt would have been the first to open. No TTY required.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate from the real user config — `getDefaultRootDomain()` is read
// while resolving the domain default. ESM hoists static imports above
// this assignment, so everything below is imported dynamically.
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "create-flags-conf-"));
process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-${process.pid}`;
const DEV_CONFIG_DIR = mkdtempSync(join(tmpdir(), "create-flags-dev-"));
process.env.HATCHKIT_DEV_CONFIG_DIR = DEV_CONFIG_DIR;

const { KNOWN_SURFACES, parseCreateFlags } = await import("./src/utils/flags.js");
const { collectProjectConfig } = await import("./src/prompts.js");
type ProjectConfig = Awaited<ReturnType<typeof collectProjectConfig>>;

const results: Record<string, boolean> = {};
let configFileCount = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      results[name] = true;
    } catch (err) {
      results[name] = false;
      console.log(`\n  x ${name}\n    ${(err as Error).message}\n`);
    }
  })();
}

/** Assert `fn` throws, and that the message mentions every `needle`. */
function throwsWith(fn: () => unknown, ...needles: string[]): void {
  let message: string | undefined;
  try {
    fn();
  } catch (err) {
    message = (err as Error).message;
  }
  assert.ok(message !== undefined, "expected a throw, got none");
  for (const needle of needles) {
    assert.ok(
      message.includes(needle),
      `expected error to mention ${JSON.stringify(needle)}, got: ${message}`,
    );
  }
}

async function rejectsWith(fn: () => Promise<unknown>, ...needles: string[]): Promise<void> {
  let message: string | undefined;
  try {
    await fn();
  } catch (err) {
    message = (err as Error).message;
  }
  assert.ok(message !== undefined, "expected a rejection, got none");
  for (const needle of needles) {
    assert.ok(
      message.includes(needle),
      `expected error to mention ${JSON.stringify(needle)}, got: ${message}`,
    );
  }
}

function writeConfigFile(value: unknown): string {
  const path = join(process.env.HATCHKIT_CONF_DIR!, `preset-${configFileCount++}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

// ---------------------------------------------------------------------------
// 1. Parsing
// ---------------------------------------------------------------------------

await test("no flags leaves everything to the prompts", () => {
  const flags = parseCreateFlags([]);
  assert.equal(flags.yes, false);
  assert.equal(flags.dryRun, false);
  assert.deepEqual(flags.presets, {});
  assert.equal(flags.forceNoGithub, false);
  assert.equal(flags.forceNoDeploy, false);
  assert.equal(flags.forceNoInstall, false);
  assert.equal(flags.forceNoLocalDev, false);
});

await test("identity + layout flags land in presets", () => {
  const { presets } = parseCreateFlags([
    "--name",
    "blog",
    "--domain",
    "blog.example.com",
    "--description",
    "A weblog",
    "--surfaces",
    "split",
  ]);
  assert.equal(presets.name, "blog");
  assert.equal(presets.domain, "blog.example.com");
  assert.equal(presets.description, "A weblog");
  assert.equal(presets.surfaces, "split");
});

await test("--flag=value and --flag value forms are equivalent", () => {
  const a = parseCreateFlags(["--name=blog", "--surfaces=backend"]).presets;
  const b = parseCreateFlags(["--name", "blog", "--surfaces", "backend"]).presets;
  assert.deepEqual(a, b);
});

await test("--description= records an explicit empty description", () => {
  // Distinct from omitting the flag: an empty value is an answer
  // ("no description"), so the prompt must not re-ask.
  assert.equal(parseCreateFlags(["--description="]).presets.description, "");
  assert.equal(parseCreateFlags([]).presets.description, undefined);
});

await test("deployment flags land in presets", () => {
  const { presets } = parseCreateFlags([
    "--deployment-mode",
    "scaffold-only",
    "--deploy-target",
    "existing",
    "--server-id",
    "42",
    "--server-ip",
    "192.0.2.10",
  ]);
  assert.equal(presets.deploymentMode, "scaffold-only");
  assert.equal(presets.deployTarget, "existing");
  assert.equal(presets.serverId, 42);
  assert.equal(presets.serverIp, "192.0.2.10");
  assert.equal(presets.serverIpv4, "192.0.2.10");
});

await test("server size + location flags land in presets", () => {
  const { presets } = parseCreateFlags(["--server-size", "cpx41", "--server-location", "hel1"]);
  assert.equal(presets.serverSize, "cpx41");
  assert.equal(presets.serverLocation, "hel1");
});

await test("list flags split, dedupe, and accept an explicit empty list", () => {
  assert.deepEqual(parseCreateFlags(["--features", "s3, analytics ,s3"]).presets.features, [
    "s3",
    "analytics",
  ]);
  // `--features=` and a bare `--features` both mean "none of them" — an
  // answer, not a missing value, so the prompt is skipped.
  assert.deepEqual(parseCreateFlags(["--features="]).presets.features, []);
  assert.deepEqual(parseCreateFlags(["--features"]).presets.features, []);
  assert.equal(parseCreateFlags([]).presets.features, undefined);
});

await test("stack list flags land in presets", () => {
  const { presets } = parseCreateFlags([
    "--analytics-providers",
    "glitchtip,plausible",
    "--services",
    "search-console",
    "--ml-services",
    "subtitles",
    "--gpu-platforms",
    "runpod,modal",
  ]);
  assert.deepEqual(presets.analyticsProviders, ["glitchtip", "plausible"]);
  assert.deepEqual(presets.provisionServices, ["search-console"]);
  assert.deepEqual(presets.mlServices, ["subtitles"]);
  assert.deepEqual(presets.gpuPlatforms, ["runpod", "modal"]);
});

await test("--db-provider keeps the deprecated mongodbProvider alias in sync", () => {
  const { presets } = parseCreateFlags(["--db-engine", "postgres", "--db-provider", "external"]);
  assert.equal(presets.dbEngine, "postgres");
  assert.equal(presets.dbProvider, "external");
  assert.equal(presets.mongodbProvider, "external");
});

await test("S3 flags land in presets", () => {
  const { presets } = parseCreateFlags([
    "--s3-provider",
    "existing",
    "--s3-endpoint",
    "https://s3.example.com",
    "--s3-bucket",
    "assets",
    "--s3-access-key",
    "AK",
    "--s3-secret-key",
    "SK",
    "--s3-region",
    "eu-central-1",
  ]);
  assert.equal(presets.s3Provider, "existing");
  assert.equal(presets.s3ExistingEndpoint, "https://s3.example.com");
  assert.equal(presets.s3ExistingBucket, "assets");
  assert.equal(presets.s3ExistingAccessKey, "AK");
  assert.equal(presets.s3ExistingSecretKey, "SK");
  assert.equal(presets.s3ExistingRegion, "eu-central-1");
});

await test("--email fans one answer out to the per-need providers", () => {
  assert.deepEqual(parseCreateFlags(["--email", "none"]).presets.email, {
    transactional: "none",
    mailingList: "none",
  });
  assert.deepEqual(parseCreateFlags(["--email", "transactional"]).presets.email, {
    transactional: "listmonk-ses",
    mailingList: "none",
  });
  assert.deepEqual(parseCreateFlags(["--email", "mailing-list"]).presets.email, {
    transactional: "none",
    mailingList: "listmonk-ses",
  });
  assert.deepEqual(parseCreateFlags(["--email", "both"]).presets.email, {
    transactional: "listmonk-ses",
    mailingList: "listmonk-ses",
  });
});

await test("--email-forwarding parses addresses, off, and the catch-all toggles", () => {
  assert.deepEqual(
    parseCreateFlags(["--email-forwarding", "hello,support"]).presets.emailForwarding,
    { enabled: true, addresses: ["hello", "support"], catchAll: true },
  );
  assert.deepEqual(
    parseCreateFlags(["--email-forwarding", "hello", "--no-email-catch-all"]).presets
      .emailForwarding,
    { enabled: true, addresses: ["hello"], catchAll: false },
  );
  assert.deepEqual(parseCreateFlags(["--email-forwarding=off"]).presets.emailForwarding, {
    enabled: false,
    addresses: [],
    catchAll: false,
  });
  // Catch-all with no enumerated addresses is a valid routing setup.
  assert.deepEqual(
    parseCreateFlags(["--email-forwarding=off", "--email-catch-all"]).presets.emailForwarding,
    { enabled: true, addresses: [], catchAll: true },
  );
});

await test("repo flags land in presets", () => {
  assert.equal(parseCreateFlags(["--public"]).presets.githubRepoVisibility, "public");
  assert.equal(parseCreateFlags(["--private"]).presets.githubRepoVisibility, "private");
  assert.equal(
    parseCreateFlags(["--github-visibility", "private"]).presets.githubRepoVisibility,
    "private",
  );
  assert.equal(parseCreateFlags(["--no-scaffold"]).presets.scaffoldRepo, false);
  assert.equal(parseCreateFlags(["--scaffold"]).presets.scaffoldRepo, true);
  assert.equal(parseCreateFlags(["--no-github"]).presets.createGithubRepo, false);
  assert.equal(parseCreateFlags(["--github"]).presets.createGithubRepo, true);
  assert.equal(parseCreateFlags(["--no-install"]).presets.installDeps, false);
  assert.equal(parseCreateFlags(["--install"]).presets.installDeps, true);
  assert.equal(parseCreateFlags(["--no-deploy"]).presets.runDeployment, false);
  assert.equal(parseCreateFlags(["--deploy"]).presets.runDeployment, true);
});

await test("--local-dev derives a slug when given none; --no-local-dev wins", () => {
  assert.deepEqual(parseCreateFlags(["--local-dev"]).presets.localDev, { slug: "" });
  assert.deepEqual(parseCreateFlags(["--local-dev=blog"]).presets.localDev, { slug: "blog" });
  const both = parseCreateFlags(["--local-dev=blog", "--no-local-dev"]);
  assert.equal(both.forceNoLocalDev, true);
  assert.equal(both.presets.localDev, undefined);
});

await test("--yes has -y and --non-interactive as aliases", () => {
  assert.equal(parseCreateFlags(["--yes"]).yes, true);
  assert.equal(parseCreateFlags(["-y"]).yes, true);
  assert.equal(parseCreateFlags(["--non-interactive"]).yes, true);
  assert.equal(parseCreateFlags(["--dry-run"]).dryRun, true);
});

// ---------------------------------------------------------------------------
// 2. Precedence
// ---------------------------------------------------------------------------

await test("individual flags win over --config, which fills the rest", () => {
  const path = writeConfigFile({ name: "from-config", surfaces: "static", installDeps: false });
  const { presets } = parseCreateFlags(["--config", path, "--name", "from-flag"]);
  assert.equal(presets.name, "from-flag");
  assert.equal(presets.surfaces, "static");
  assert.equal(presets.installDeps, false);
});

const STEP_LINE = /\[\d+\/\d+\]\s+(.+?)(?:\s\s|$)/;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Run the interactive stepper until it would open its first prompt.
 *  Returns that step's name, or null when every step was skipped (in
 *  which case `beforeReview` was reached with the resolved config). */
async function firstPromptedStep(
  presets: Partial<ProjectConfig>,
  onResolved?: (config: ProjectConfig) => void,
): Promise<string | null> {
  const sentinel = new Error("__first_prompt__");
  const realLog = console.log;
  let stepName: string | null = null;
  console.log = (...parts: unknown[]) => {
    const match = STEP_LINE.exec(parts.map(String).join(" ").replace(ANSI, ""));
    if (!match) return;
    stepName = match[1].trim();
    throw sentinel;
  };
  try {
    await collectProjectConfig({
      presets,
      nonInteractive: false,
      beforeReview: async (resolved) => {
        onResolved?.(resolved);
        throw sentinel;
      },
    });
    return stepName;
  } catch (err) {
    if (err !== sentinel) throw err;
    return stepName;
  } finally {
    console.log = realLog;
  }
}

/** Every question answered by a flag - nothing left to prompt for. */
const FULL_PRESETS: Partial<ProjectConfig> = {
  name: "blog",
  domain: "blog.example.com",
  description: "A weblog",
  surfaces: "fullstack",
  deploymentMode: "coolify",
  topology: "single-origin",
  deployTarget: "new",
  serverSize: "cpx21",
  serverLocation: "nbg1",
  features: ["analytics"],
  analyticsProviders: ["glitchtip"],
  provisionServices: ["glitchtip"],
  email: { transactional: "listmonk-ses", mailingList: "none" },
  emailForwarding: { enabled: true, addresses: ["hello"], catchAll: true },
  s3Provider: "none",
  mlServices: [],
  dbEngine: "postgres",
  dbProvider: "coolify",
  scaffoldRepo: true,
  createGithubRepo: true,
  githubRepoVisibility: "public",
  installDeps: true,
  runDeployment: true,
  localDev: { slug: "blog" },
};

await test("bare `hatchkit create` still starts at the first prompt", async () => {
  // The no-flags path must be untouched: the stepper opens at step 1.
  assert.equal(await firstPromptedStep({}), "Project name");
});

await test("a private repo on Coolify keeps the scaffold step alive", async () => {
  // Every question in that step is preset, but the Coolify GitHub-App
  // source has no flag — so the step must still run to pre-pick it.
  const step = await firstPromptedStep({
    ...FULL_PRESETS,
    githubRepoVisibility: "private",
    deploymentMode: "coolify",
  });
  assert.equal(step, "Scaffold / GitHub / install");
});

await test("a full flag set skips every prompt", async () => {
  let resolved: ProjectConfig | undefined;
  const step = await firstPromptedStep(FULL_PRESETS, (c) => {
    resolved = c;
  });
  assert.equal(step, null, `expected no prompt, but "${step}" would have opened`);
  assert.ok(resolved, "beforeReview should have been reached");
  assert.equal(resolved.name, "blog");
  assert.equal(resolved.surfaces, "fullstack");
  assert.equal(resolved.dbEngine, "postgres");
});

await test("a partial flag set still prompts for what is missing", async () => {
  // Drop exactly one answer at a time; the stepper should stop at that
  // step and no earlier - proving the supplied flags were honoured.
  const cases: Array<[keyof ProjectConfig, string]> = [
    ["name", "Project name"],
    ["description", "Description"],
    ["domain", "Domain"],
    ["surfaces", "Project type"],
    ["deploymentMode", "Deployment mode"],
    ["topology", "Deployment topology"],
    ["deployTarget", "Deploy target"],
    ["serverSize", "Server size"],
    ["serverLocation", "Server location"],
    ["features", "Features"],
    ["analyticsProviders", "Analytics providers"],
    ["email", "Email"],
    ["emailForwarding", "Email forwarding"],
    ["provisionServices", "Extra services"],
    ["mlServices", "ML services"],
    ["localDev", "Local dev URL"],
    ["runDeployment", "Deploy now"],
    ["dbEngine", "Database engine"],
    ["dbProvider", "Database provider"],
  ];
  for (const [omitted, expectedStep] of cases) {
    const presets = { ...FULL_PRESETS };
    delete presets[omitted];
    const step = await firstPromptedStep(presets);
    assert.equal(
      step,
      expectedStep,
      `omitting ${String(omitted)} should stop at "${expectedStep}", got "${step}"`,
    );
  }
});

await test("a bare --local-dev derives its slug from the project name", async () => {
  const { presets } = parseCreateFlags(["--local-dev"]);
  let resolved: ProjectConfig | undefined;
  const step = await firstPromptedStep({ ...FULL_PRESETS, localDev: presets.localDev }, (c) => {
    resolved = c;
  });
  assert.equal(step, null);
  assert.deepEqual(resolved?.localDev?.slug, "blog");

  const viaYes = await collectProjectConfig({
    presets: { name: "blog", domain: "blog.example.com", localDev: { slug: "" } },
    nonInteractive: true,
  });
  assert.equal(viaYes.localDev?.slug, "blog");
});

await test("--no-scaffold skips the scaffold/GitHub/install questions", async () => {
  const presets = { ...FULL_PRESETS, scaffoldRepo: false };
  presets.createGithubRepo = undefined;
  presets.installDeps = undefined;
  presets.githubRepoVisibility = undefined;
  assert.equal(await firstPromptedStep(presets), null);
});

// ---------------------------------------------------------------------------
// 3. Validation
// ---------------------------------------------------------------------------

await test("bad enum values fail early listing the valid ones", () => {
  throwsWith(
    () => parseCreateFlags(["--surfaces", "monolith"]),
    "--surfaces invalid",
    "monolith",
    KNOWN_SURFACES.join(", "),
  );
  throwsWith(
    () => parseCreateFlags(["--deployment-mode", "vercel"]),
    "coolify, gh-pages, scaffold-only",
  );
  throwsWith(() => parseCreateFlags(["--deploy-target", "somewhere"]), "existing, new");
  throwsWith(() => parseCreateFlags(["--server-size", "cpx99"]), "cpx21, cpx31, cpx41");
  throwsWith(() => parseCreateFlags(["--server-location", "ash"]), "nbg1, fsn1, hel1");
  throwsWith(() => parseCreateFlags(["--s3-provider", "minio"]), "hetzner, r2, aws");
  throwsWith(() => parseCreateFlags(["--db-engine", "sqlite"]), "mongodb, postgres");
  throwsWith(() => parseCreateFlags(["--db-provider", "rds"]), "coolify, external");
  throwsWith(() => parseCreateFlags(["--github-visibility", "internal"]), "private, public");
  throwsWith(() => parseCreateFlags(["--email", "resend"]), "none, transactional, mailing-list");
});

await test("bad list values name the offenders and the valid set", () => {
  throwsWith(
    () => parseCreateFlags(["--features", "websocket,telepathy"]),
    "Unknown --features values: telepathy",
    "websocket, stripe, analytics",
  );
  throwsWith(() => parseCreateFlags(["--ml-services", "3d-nope"]), "Unknown --ml-services values");
  throwsWith(() => parseCreateFlags(["--services", "sentry"]), "Unknown --services values");
  throwsWith(
    () => parseCreateFlags(["--analytics-providers", "posthog"]),
    "Unknown --analytics-providers values",
  );
  throwsWith(() => parseCreateFlags(["--gpu-platforms", "lambda"]), "Unknown --gpu-platforms");
  throwsWith(() => parseCreateFlags(["--gpu-platforms="]), "needs at least one value");
});

await test("malformed scalar flags fail early", () => {
  throwsWith(() => parseCreateFlags(["--server-id", "abc"]), "positive integer");
  throwsWith(() => parseCreateFlags(["--surfaces"]), "--surfaces needs a value");
  throwsWith(
    () => parseCreateFlags(["--email-forwarding", "Hello There"]),
    "invalid address local-part",
  );
  throwsWith(
    () => parseCreateFlags(["--email-forwarding=hi", "--email-catch-all", "--no-email-catch-all"]),
    "mutually exclusive",
  );
  throwsWith(() => parseCreateFlags(["--email-catch-all"]), "require --email-forwarding");
  throwsWith(() => parseCreateFlags(["--config", "/nope/missing.json"]), "--config file not found");
});

// ---------------------------------------------------------------------------
// 4. `--yes` hard-fails naming the missing flag
// ---------------------------------------------------------------------------

const nonInteractive = (presets: Partial<ProjectConfig>) =>
  collectProjectConfig({ presets, nonInteractive: true });

await test("--yes fails on a missing required value, naming its flag", async () => {
  await rejectsWith(() => nonInteractive({}), "--name is required");
  // No `--domain` and no configured root domain to derive one from.
  await rejectsWith(() => nonInteractive({ name: "blog" }), "--domain is required");
  await rejectsWith(
    () => nonInteractive({ name: "blog", domain: "blog.example.com", deployTarget: "existing" }),
    "--server-id",
    "--server-ip",
  );
  await rejectsWith(
    () =>
      nonInteractive({
        name: "blog",
        domain: "blog.example.com",
        features: ["s3"],
        s3Provider: "existing",
      }),
    "--s3-endpoint",
    "--s3-bucket",
    "--s3-access-key",
    "--s3-secret-key",
  );
  await rejectsWith(
    () => nonInteractive({ name: "blog", domain: "blog.example.com", mlServices: ["custom-hf"] }),
    "--custom-hf-model",
  );
  await rejectsWith(
    () =>
      nonInteractive({
        name: "blog",
        domain: "blog.example.com",
        surfaces: "fullstack",
        deploymentMode: "gh-pages",
      }),
    "requires --surfaces static",
  );
  await rejectsWith(
    () =>
      nonInteractive({
        name: "blog",
        domain: "blog.example.com",
        features: ["desktop", "desktop-tauri"],
      }),
    "--features invalid",
  );
});

await test("--yes resolves defaults for everything left unspecified", async () => {
  const config = await nonInteractive({ name: "blog", domain: "blog.example.com" });
  assert.equal(config.surfaces, "fullstack");
  assert.equal(config.deploymentMode, "coolify");
  assert.equal(config.deployTarget, "new");
  assert.equal(config.serverSize, "cpx21");
  assert.equal(config.serverLocation, "nbg1");
  assert.equal(config.dbEngine, "mongodb");
  assert.equal(config.dbProvider, "coolify");
  assert.equal(config.scaffoldRepo, true);
  assert.equal(config.createGithubRepo, true);
  assert.equal(config.githubRepoVisibility, "public");
  assert.equal(config.installDeps, true);
  assert.equal(config.runDeployment, true);
  assert.deepEqual(config.features, []);
  assert.equal(config.s3Provider, "none");
});

await test("--yes carries flag-supplied values through to the resolved plan", async () => {
  const { presets } = parseCreateFlags([
    "--name",
    "blog",
    "--domain",
    "blog.example.com",
    "--surfaces",
    "split",
    "--features",
    "analytics",
    "--analytics-providers",
    "glitchtip,openpanel",
    "--email",
    "both",
    "--email-forwarding",
    "hello",
    "--db-engine",
    "postgres",
    "--db-provider",
    "external",
    "--no-install",
    "--private",
  ]);
  const config = await collectProjectConfig({ presets, nonInteractive: true });
  assert.equal(config.surfaces, "split");
  assert.deepEqual(config.features, ["analytics"]);
  assert.equal(config.dbEngine, "postgres");
  assert.equal(config.dbProvider, "external");
  assert.equal(config.installDeps, false);
  assert.equal(config.githubRepoVisibility, "private");
  // The Email / Analytics / Email-forwarding steps are what normally
  // queue these - with the prompts skipped, the flags have to.
  assert.deepEqual(config.email, { transactional: "listmonk-ses", mailingList: "listmonk-ses" });
  assert.ok(config.provisionServices.includes("listmonk-ses"));
  assert.ok(config.provisionServices.includes("glitchtip"));
  assert.ok(config.provisionServices.includes("openpanel"));
  assert.ok(config.provisionServices.includes("email"));
});

await test("a static gh-pages plan drops the server-only email providers", async () => {
  const config = await collectProjectConfig({
    presets: {
      name: "blog",
      domain: "blog.example.com",
      surfaces: "static",
      deploymentMode: "gh-pages",
      provisionServices: ["listmonk-ses", "search-console"],
    },
    nonInteractive: true,
  });
  assert.deepEqual(config.email, { transactional: "none", mailingList: "none" });
  assert.ok(!config.provisionServices.includes("listmonk-ses"));
  assert.ok(config.provisionServices.includes("search-console"));
});

await test("--dry-run resolves a full plan without a deploy", async () => {
  const { presets, dryRun } = parseCreateFlags([
    "--dry-run",
    "--name",
    "blog",
    "--domain",
    "blog.example.com",
    "--surfaces",
    "backend",
  ]);
  assert.equal(dryRun, true);
  const config = await collectProjectConfig({ presets, nonInteractive: true, dryRun });
  assert.equal(config.dryRun, true);
  assert.equal(config.runDeployment, false);
  assert.equal(config.surfaces, "backend");
  assert.equal(config.domain, "blog.example.com");
});

// ---------------------------------------------------------------------------

{
  const { clearAllSecrets } = await import("./src/utils/secrets.js");
  await clearAllSecrets();
}
rmSync(process.env.HATCHKIT_CONF_DIR!, { recursive: true, force: true });
rmSync(DEV_CONFIG_DIR, { recursive: true, force: true });

console.log("\n=== SUMMARY (create flags) ===");
let allOk = true;
for (const [name, ok] of Object.entries(results)) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) allOk = false;
}
console.log();
process.exit(allOk ? 0 : 1);
