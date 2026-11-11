/*
 * `hatchkit auth providers` — from "buttons hidden" to "buttons live".
 *
 * `hatchkit update --auth-options …` writes the Google, Apple, GitHub and
 * Discord buttons; each stays hidden until its credentials reach the
 * server. This command gets them there with as few manual steps as each
 * provider allows:
 *
 *  - GitHub: the GitHub App manifest flow. One confirmation on github.com,
 *    then the client ID and secret come back over the API.
 *  - Google, Apple, Discord: no API exists. The command prints each
 *    dashboard URL and the values to paste there, then reads every value
 *    from the clipboard on Enter, never echoing it, and empties the
 *    clipboard. Apple's `.p8` is read from Downloads and moved to the Trash
 *    once stored.
 *
 * Client IDs go into `.env.production` as plain values and secrets
 * encrypted, through `dotenvxSet`. After the shape checks it offers
 * `hatchkit sync --deploy`, then asks the deployed server for a sign-in
 * URL per provider and checks its `client_id` and `redirect_uri`.
 *
 * `plan.ts` holds the steps, checks and manifest; `github-manifest.ts` the
 * GitHub exchange; `io.ts` the clipboard, Trash and browser.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import chalk from "chalk";
import { parseDotenv, resolveEnvFile } from "../deploy/env-resolve.js";
import { readManifest } from "../scaffold/manifest.js";
import { dotenvxSet } from "../utils/dotenvx-safe.js";
import { locateEnvFile, resolveEnvFileTarget } from "../utils/env-files.js";
import { runGithubManifestFlow } from "./github-manifest.js";
import { type ProvidersIo, systemIo } from "./io.js";
import {
  CLIENT_ID_FIELD,
  FIELDS,
  type FieldKey,
  type FieldSpec,
  type GuideContext,
  type GuideStep,
  type OAuthProviderId,
  PROVIDER_FIELDS,
  PROVIDER_LABEL,
  PROVIDER_OPTION,
  type RedirectCheck,
  appleKeyEnvValue,
  appleKeyFileName,
  callbackUrl,
  checkSignInUrl,
  chosenProviders,
  defaultGithubAppName,
  githubAppManifest,
  githubAppSettingsUrl,
  githubManifestFormAction,
  parseProviderList,
  providerSteps,
  signInRequest,
} from "./plan.js";
import { AUTH_USAGE } from "./usage.js";

// ── Ports ─────────────────────────────────────────────────────────────

export interface ProvidersPrompts {
  /** Wait for Enter. Returns what was typed, trimmed ("s" = skip). */
  enter(message: string): Promise<string>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  /** A line of text, trimmed. */
  text(message: string): Promise<string>;
  /** A hidden paste, for a machine with no clipboard tool. */
  secret(message: string): Promise<string>;
  log(line: string): void;
}

const terminalPrompts: ProvidersPrompts = {
  async enter(message) {
    const { input } = await import("@inquirer/prompts");
    return (await input({ message })).trim();
  },
  async confirm(message, defaultValue) {
    const { confirm } = await import("@inquirer/prompts");
    return confirm({ message, default: defaultValue });
  },
  async text(message) {
    const { input } = await import("@inquirer/prompts");
    return (await input({ message })).trim();
  },
  async secret(message) {
    const { password } = await import("@inquirer/prompts");
    return (await password({ message, mask: "*" })).trim();
  },
  log: (line) => console.log(line),
};

export interface AuthProvidersDeps {
  io: ProvidersIo;
  prompts: ProvidersPrompts;
  interactive: boolean;
  fetch: typeof fetch;
  github?: { webBase?: string; apiBase?: string; timeoutMs?: number };
  /** Run `hatchkit sync --deploy` in the project; resolves with its exit code. */
  runSync(projectDir: string): Promise<number>;
}

function runHatchkitSync(projectDir: string): Promise<number> {
  return new Promise((resolveCode) => {
    const entry = process.argv[1];
    if (!entry) {
      resolveCode(1);
      return;
    }
    const child = spawn(process.execPath, [...process.execArgv, entry, "sync", "--deploy"], {
      cwd: projectDir,
      stdio: "inherit",
    });
    child.on("error", () => resolveCode(1));
    child.on("exit", (code) => resolveCode(code ?? 1));
  });
}

export function defaultDeps(): AuthProvidersDeps {
  return {
    io: systemIo(),
    prompts: terminalPrompts,
    interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
    fetch: (input, init) => fetch(input, init),
    runSync: runHatchkitSync,
  };
}

// ── Arguments ─────────────────────────────────────────────────────────

export interface AuthProvidersArgs {
  dir?: string;
  providers?: OAuthProviderId[];
  dryRun: boolean;
  verify: boolean;
  replace: boolean;
  githubOAuthApp: boolean;
  githubOrg?: string;
  githubAppName?: string;
  sync: boolean;
  json: boolean;
}

const VALUE_FLAGS = ["--provider", "--github-org", "--github-app-name"] as const;
const BOOL_FLAGS = [
  "--dry-run",
  "--verify",
  "--replace",
  "--github-oauth-app",
  "--no-sync",
  "--json",
] as const;

/** Parse the words after `auth providers`. */
export function parseAuthProvidersArgs(
  argv: readonly string[],
): AuthProvidersArgs | { error: string } {
  const out: AuthProvidersArgs = {
    dryRun: false,
    verify: false,
    replace: false,
    githubOAuthApp: false,
    sync: true,
    json: false,
  };
  const providerValues: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    if ((VALUE_FLAGS as readonly string[]).includes(flag)) {
      const value = eq > 0 ? raw.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) {
        return { error: `${flag} needs a value` };
      }
      if (flag === "--provider") providerValues.push(value);
      else if (flag === "--github-org") out.githubOrg = value;
      else out.githubAppName = value;
      continue;
    }
    if ((BOOL_FLAGS as readonly string[]).includes(raw)) {
      if (raw === "--dry-run") out.dryRun = true;
      else if (raw === "--verify") out.verify = true;
      else if (raw === "--replace") out.replace = true;
      else if (raw === "--github-oauth-app") out.githubOAuthApp = true;
      else if (raw === "--no-sync") out.sync = false;
      else out.json = true;
      continue;
    }
    if (raw.startsWith("-")) return { error: `Unknown option ${raw}` };
    if (out.dir !== undefined) return { error: `Unexpected argument ${raw}` };
    out.dir = raw;
  }
  if (providerValues.length > 0) {
    const parsed = parseProviderList(providerValues);
    if ("error" in parsed) return parsed;
    out.providers = parsed.providers;
  }
  if (out.dryRun && out.verify) return { error: "--dry-run and --verify do not go together" };
  if (out.githubAppName !== undefined && out.githubAppName.length > 34) {
    return { error: "--github-app-name: GitHub allows at most 34 characters" };
  }
  return out;
}

// ── Project ───────────────────────────────────────────────────────────

interface ProjectFacts {
  projectDir: string;
  project: string;
  domain: string;
  chosen: OAuthProviderId[];
  targets: OAuthProviderId[];
  /** The env file values go into; undefined when the project has none. */
  envPath?: string;
  /** Variables with a real value already (not empty, not a placeholder). */
  present: Set<string>;
}

const PLACEHOLDER = /^(CHANGE_ME|REPLACE_ME|TODO)/;

function presentKeys(envPath: string | undefined): Set<string> {
  if (!envPath || !existsSync(envPath)) return new Set();
  const parsed = parseDotenv(readFileSync(envPath, "utf-8"));
  return new Set(
    Object.entries(parsed)
      .filter(([, value]) => value.trim() !== "" && !PLACEHOLDER.test(value.trim()))
      .map(([key]) => key),
  );
}

function loadProject(args: AuthProvidersArgs): ProjectFacts | { error: string } {
  const projectDir = resolve(args.dir ?? ".");
  const manifest = readManifest(projectDir);
  if (!manifest) return { error: `No .hatchkit.json in ${projectDir}.` };
  if (!manifest.domain)
    return { error: ".hatchkit.json has no domain: the redirect URIs need one." };
  const chosen = chosenProviders(manifest.authSecurity?.options);
  const unchosen = (args.providers ?? []).filter((p) => !chosen.includes(p));
  if (unchosen.length > 0) {
    const options = unchosen.map((p) => PROVIDER_OPTION[p]).join(",");
    return {
      error:
        `No button for ${unchosen.join(", ")} in this project yet. Add it first:\n` +
        `  hatchkit update --features auth-account-security --auth-options ${options}`,
    };
  }
  if (chosen.length === 0) {
    return {
      error:
        "This project chose no OAuth sign-in provider. Add one first, e.g.:\n" +
        "  hatchkit update --features auth-account-security --auth-options google-oauth,github-oauth",
    };
  }
  const envPath = locateEnvFile(projectDir, ".env.production");
  return {
    projectDir,
    project: manifest.name,
    domain: manifest.domain,
    chosen,
    targets: args.providers ?? chosen,
    ...(envPath ? { envPath } : {}),
    present: presentKeys(envPath),
  };
}

function providerState(
  facts: ProjectFacts,
  provider: OAuthProviderId,
): "set" | "partial" | "missing" {
  const keys = PROVIDER_FIELDS[provider];
  const set = keys.filter((k) => facts.present.has(k)).length;
  return set === keys.length ? "set" : set === 0 ? "missing" : "partial";
}

// ── Dry run ───────────────────────────────────────────────────────────

interface ProviderPlan {
  provider: OAuthProviderId;
  state: "set" | "partial" | "missing";
  callbackUrl: string;
  method: "github-app-manifest" | "guided";
  steps: GuideStep[];
  writes: Array<{ key: FieldKey; encrypted: boolean }>;
  githubManifest?: { formAction: string; manifest: ReturnType<typeof githubAppManifest> };
}

function planFor(
  facts: ProjectFacts,
  args: AuthProvidersArgs,
  provider: OAuthProviderId,
): ProviderPlan {
  const ctx: GuideContext = {
    domain: facts.domain,
    project: facts.project,
    ...(args.githubOrg ? { githubOrg: args.githubOrg } : {}),
  };
  const manifestFlow = provider === "github" && !args.githubOAuthApp;
  return {
    provider,
    state: providerState(facts, provider),
    callbackUrl: callbackUrl(provider, facts.domain),
    method: manifestFlow ? "github-app-manifest" : "guided",
    steps: manifestFlow ? [] : providerSteps(provider, ctx),
    writes: PROVIDER_FIELDS[provider].map((key) => ({ key, encrypted: FIELDS[key].secret })),
    ...(manifestFlow
      ? {
          githubManifest: {
            formAction: githubManifestFormAction({
              webBase: "https://github.com",
              ...(args.githubOrg ? { org: args.githubOrg } : {}),
              state: "<random>",
            }),
            manifest: githubAppManifest({
              name: args.githubAppName ?? defaultGithubAppName(facts.project),
              domain: facts.domain,
              redirectUrl: "http://127.0.0.1:<port>/created",
            }),
          },
        }
      : {}),
  };
}

function printSteps(log: (line: string) => void, steps: GuideStep[]): void {
  steps.forEach((step, i) => {
    log(chalk.bold(`  ${i + 1}. ${step.title}`));
    for (const line of step.lines) log(`     ${line}`);
    if (step.read.length > 0) log(chalk.dim(`     → reads ${step.read.join(", ")}`));
  });
}

// ── Reading values ────────────────────────────────────────────────────

const SKIP = Symbol("skip");
type Read = string | typeof SKIP;

class ValueReader {
  /** Values read in this run, so a clipboard nobody updated is caught. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly deps: AuthProvidersDeps,
    private readonly provider: OAuthProviderId,
  ) {}

  private log(line: string): void {
    this.deps.prompts.log(line);
  }

  async clipboard(field: FieldSpec): Promise<Read> {
    const { io, prompts } = this.deps;
    for (;;) {
      const answer = await prompts.enter(
        `Copy ${field.what} (${field.key}), then press Enter. s + Enter skips ${PROVIDER_LABEL[this.provider]}.`,
      );
      if (answer.toLowerCase() === "s") return SKIP;
      let value = await io.readClipboard();
      let fromClipboard = true;
      if (value === null) {
        fromClipboard = false;
        value = await prompts.secret(`No clipboard tool here. Paste ${field.key} (hidden)`);
      }
      value = value.trim();
      if (fromClipboard) await io.clearClipboard();
      if (!value) {
        this.log(
          chalk.yellow("    The clipboard is empty. Use the copy button, then press Enter."),
        );
        continue;
      }
      if (this.seen.has(value)) {
        this.log(
          chalk.yellow(
            `    The clipboard still holds a value read earlier. Copy ${field.what} first.`,
          ),
        );
        continue;
      }
      const problem = field.check(value);
      if (problem) {
        this.log(
          chalk.yellow(
            `    ${field.key} does not look right (${value.length} characters): ${problem}.`,
          ),
        );
        if (!(await prompts.confirm(`Store this ${field.key} anyway?`, false))) continue;
      }
      this.seen.add(value);
      this.log(
        chalk.green(
          `    ✓ ${field.key}: ${value.length} characters${problem ? "" : ", shape ok"}${fromClipboard ? ", clipboard emptied" : ""}`,
        ),
      );
      return value;
    }
  }

  /** Apple's `.p8`: `AuthKey_<KEY_ID>.p8` in Downloads, else the only
   *  AuthKey file there, else a path the operator types. */
  async appleKey(
    keyId: string | undefined,
  ): Promise<{ value: string; file: string } | typeof SKIP> {
    const { io, prompts } = this.deps;
    const answer = await prompts.enter(
      `Download the .p8 into ${io.downloadsDir}, then press Enter. s + Enter skips Sign in with Apple.`,
    );
    if (answer.toLowerCase() === "s") return SKIP;
    let file = findAppleKeyFile(io.downloadsDir, keyId);
    for (;;) {
      if (!file) {
        const typed = await prompts.text(
          `No ${keyId ? appleKeyFileName(keyId) : "AuthKey_*.p8"} in ${io.downloadsDir}. Path to the .p8 (s skips):`,
        );
        if (typed.toLowerCase() === "s") return SKIP;
        const path = resolve(typed.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
        if (!existsSync(path)) {
          this.log(chalk.yellow(`    ${path} does not exist.`));
          continue;
        }
        file = path;
      }
      const name = file.split("/").pop() ?? file;
      if (keyId && name !== appleKeyFileName(keyId)) {
        this.log(
          chalk.yellow(`    ${name} is not named after APPLE_KEY_ID (${appleKeyFileName(keyId)}).`),
        );
        if (!(await prompts.confirm(`Use ${name} anyway?`, false))) {
          file = undefined;
          continue;
        }
      }
      const value = appleKeyEnvValue(readFileSync(file, "utf-8"));
      const problem = FIELDS.APPLE_PRIVATE_KEY.check(value);
      if (problem) {
        this.log(chalk.yellow(`    ${name}: ${problem}.`));
        file = undefined;
        continue;
      }
      this.log(chalk.green(`    ✓ APPLE_PRIVATE_KEY: read ${name}, an ES256 key`));
      return { value, file };
    }
  }
}

export function findAppleKeyFile(
  downloadsDir: string,
  keyId: string | undefined,
): string | undefined {
  if (keyId) {
    const exact = join(downloadsDir, appleKeyFileName(keyId));
    if (existsSync(exact)) return exact;
  }
  let names: string[] = [];
  try {
    names = readdirSync(downloadsDir).filter((n) => /^AuthKey_[A-Z0-9]{10}\.p8$/.test(n));
  } catch {
    return undefined;
  }
  return names.length === 1 ? join(downloadsDir, names[0]) : undefined;
}

// ── Storing ───────────────────────────────────────────────────────────

/** Write one provider's values: client IDs plain, secrets encrypted. */
export function storeValues(
  envPath: string,
  values: ReadonlyArray<{ key: FieldKey; value: string }>,
): void {
  for (const { key, value } of values) {
    const out = dotenvxSet(key, value, { path: envPath, encrypt: FIELDS[key].secret });
    const failed = out.processedEnvs.find((e) => e.error);
    if (failed?.error) throw new Error(`dotenvx could not set ${key}: ${failed.error.message}`);
  }
}

// ── Deployed redirect ─────────────────────────────────────────────────

export async function probeSignIn(args: {
  provider: OAuthProviderId;
  domain: string;
  expectedClientId?: string;
  fetch: typeof fetch;
}): Promise<RedirectCheck> {
  const { url, init } = signInRequest(args.provider, args.domain);
  let res: Response;
  try {
    res = await args.fetch(url, init);
  } catch (err) {
    return {
      provider: args.provider,
      ok: false,
      notLive: false,
      problems: [`could not reach ${url}: ${(err as Error).message}`],
    };
  }
  const body = (await res.json().catch(() => null)) as {
    url?: unknown;
    code?: unknown;
    message?: unknown;
  } | null;
  if (res.status === 404 && body?.code === "PROVIDER_NOT_FOUND") {
    return {
      provider: args.provider,
      ok: false,
      notLive: true,
      problems: ["the deployed server has no credentials for it yet (sync, then redeploy)"],
    };
  }
  if (!res.ok || typeof body?.url !== "string") {
    const detail = typeof body?.message === "string" ? `: ${body.message}` : "";
    return {
      provider: args.provider,
      ok: false,
      notLive: false,
      problems: [`POST ${url} answered HTTP ${res.status}${detail}`],
    };
  }
  return checkSignInUrl({
    provider: args.provider,
    url: body.url,
    domain: args.domain,
    ...(args.expectedClientId ? { expectedClientId: args.expectedClientId } : {}),
  });
}

async function verifyAll(
  facts: ProjectFacts,
  providers: readonly OAuthProviderId[],
  deps: AuthProvidersDeps,
): Promise<RedirectCheck[]> {
  const values = facts.envPath
    ? (await resolveEnvFile(facts.envPath, facts.projectDir)).values
    : {};
  const out: RedirectCheck[] = [];
  for (const provider of providers) {
    out.push(
      await probeSignIn({
        provider,
        domain: facts.domain,
        ...(values[CLIENT_ID_FIELD[provider]]
          ? { expectedClientId: values[CLIENT_ID_FIELD[provider]] }
          : {}),
        fetch: deps.fetch,
      }),
    );
  }
  return out;
}

function printChecks(log: (line: string) => void, checks: readonly RedirectCheck[]): void {
  for (const check of checks) {
    const label = PROVIDER_LABEL[check.provider];
    if (check.ok) {
      log(chalk.green(`  ✓ ${label}: live — client_id matches, redirect_uri ${check.redirectUri}`));
    } else {
      log(chalk.yellow(`  ✗ ${label}: ${check.problems.join("; ")}`));
    }
  }
}

// ── The command ───────────────────────────────────────────────────────

export interface AuthProvidersResult {
  exitCode: number;
  stored: FieldKey[];
  skipped: OAuthProviderId[];
  checks: RedirectCheck[];
}

/** `hatchkit auth <sub> …`. `argv` starts after `auth`. */
export async function runAuthCommand(
  argv: readonly string[],
  deps: AuthProvidersDeps = defaultDeps(),
): Promise<AuthProvidersResult> {
  const log = (line: string) => deps.prompts.log(line);
  const fail = (message: string): AuthProvidersResult => {
    console.error(chalk.red(message));
    return { exitCode: 1, stored: [], skipped: [], checks: [] };
  };
  if (argv[0] !== "providers") {
    log(AUTH_USAGE);
    return { exitCode: argv[0] === undefined ? 0 : 1, stored: [], skipped: [], checks: [] };
  }
  const args = parseAuthProvidersArgs(argv.slice(1));
  if ("error" in args) return fail(args.error);
  const facts = loadProject(args);
  if ("error" in facts) return fail(facts.error);

  if (args.verify) {
    const checks = await verifyAll(facts, facts.targets, deps);
    if (args.json) log(JSON.stringify({ domain: facts.domain, checks }, null, 2));
    else printChecks(log, checks);
    return { exitCode: checks.every((c) => c.ok) ? 0 : 1, stored: [], skipped: [], checks };
  }

  const envTarget = facts.envPath ?? resolveEnvFileTarget(facts.projectDir, ".env.production");
  const envRel = relative(facts.projectDir, envTarget) || ".env.production";

  if (args.dryRun) {
    const plans = facts.targets.map((p) => planFor(facts, args, p));
    if (args.json) {
      log(
        JSON.stringify(
          {
            domain: facts.domain,
            envFile: envRel,
            envFileExists: !!facts.envPath,
            providers: plans,
          },
          null,
          2,
        ),
      );
      return { exitCode: 0, stored: [], skipped: [], checks: [] };
    }
    log(chalk.bold(`\n  hatchkit auth providers — dry run for ${facts.domain}`));
    log(
      chalk.dim(
        `  Values would go into ${envRel}${facts.envPath ? "" : " (missing: the real run stops)"}.`,
      ),
    );
    for (const plan of plans) {
      log("");
      log(
        chalk.bold(
          `  ${PROVIDER_LABEL[plan.provider]} — ${plan.state === "set" ? "already set (skipped without --replace)" : plan.state}`,
        ),
      );
      log(`  Callback: ${plan.callbackUrl}`);
      if (plan.githubManifest) {
        log("  GitHub App via the manifest flow: a local page posts this to");
        log(`  ${plan.githubManifest.formAction}`);
        for (const line of JSON.stringify(plan.githubManifest.manifest, null, 2).split("\n"))
          log(`    ${line}`);
        log(
          "  Then POST https://api.github.com/app-manifests/<code>/conversions → client ID + secret.",
        );
      } else {
        printSteps(log, plan.steps);
      }
      log(
        chalk.dim(
          `  Writes: ${plan.writes.map((w) => `${w.key} (${w.encrypted ? "encrypted" : "plain"})`).join(", ")}`,
        ),
      );
    }
    log(chalk.dim("\n  Then: hatchkit sync --deploy, and a sign-in check per provider."));
    return { exitCode: 0, stored: [], skipped: [], checks: [] };
  }

  if (!deps.interactive) {
    return fail(
      "hatchkit auth providers needs a terminal: it waits for dashboard steps and reads the clipboard.\n" +
        "  --dry-run prints the steps; --verify checks the deployed sign-in.",
    );
  }
  if (!facts.envPath) {
    return fail(
      `No .env.production in ${facts.projectDir}. hatchkit writes the values there and \`hatchkit sync\` pushes it;\n` +
        "  a project that keeps its env only in Coolify has to set the variables there by hand.",
    );
  }
  const envPath = facts.envPath;

  log(chalk.bold(`\n  Sign-in providers for ${facts.domain}`));
  log(chalk.dim(`  Values go into ${envRel}: client IDs plain, secrets encrypted.`));

  const stored: FieldKey[] = [];
  const skipped: OAuthProviderId[] = [];
  const done: OAuthProviderId[] = [];
  for (const provider of facts.targets) {
    log("");
    log(chalk.bold(`  ── ${PROVIDER_LABEL[provider]}`));
    log(`  Callback: ${callbackUrl(provider, facts.domain)}`);
    const state = providerState(facts, provider);
    if (state === "set" && !args.replace) {
      log(chalk.dim("  Already set. --replace enters new values."));
      done.push(provider);
      continue;
    }
    const values = await collectProvider(provider, facts, args, deps);
    if (values === SKIP) {
      log(chalk.dim(`  Skipped. Nothing written for ${PROVIDER_LABEL[provider]}.`));
      skipped.push(provider);
      continue;
    }
    storeValues(envPath, values.entries);
    stored.push(...values.entries.map((e) => e.key));
    for (const e of values.entries) facts.present.add(e.key);
    log(chalk.green(`  ✓ Stored ${values.entries.map((e) => e.key).join(", ")} in ${envRel}`));
    if (values.appleKeyFile) {
      const where = await deps.io.trash(values.appleKeyFile);
      log(
        where
          ? chalk.green(
              `  ✓ Moved ${values.appleKeyFile.split("/").pop()} to ${where}. Empty it to delete the key file.`,
            )
          : chalk.yellow(
              `  Delete ${values.appleKeyFile} yourself: the key is stored, and the file is a copy of the secret.`,
            ),
      );
    }
    done.push(provider);
  }

  const checks: RedirectCheck[] = [];
  if (stored.length > 0 && args.sync) {
    log("");
    const go = await deps.prompts.confirm(
      "Push the new values to Coolify and redeploy now (hatchkit sync --deploy)?",
      true,
    );
    if (go) {
      const code = await deps.runSync(facts.projectDir);
      if (code !== 0) log(chalk.yellow(`  hatchkit sync exited with ${code}.`));
      checks.push(...(await verifyAll(facts, done, deps)));
      log("");
      printChecks(log, checks);
      if (checks.some((c) => c.notLive)) {
        log(chalk.dim("  A redeploy can take a few minutes. Check again with:"));
        log(
          chalk.dim(
            `    ${["hatchkit auth providers", args.dir, "--verify"].filter(Boolean).join(" ")}`,
          ),
        );
      }
    } else {
      log(chalk.dim("  Next: hatchkit sync --deploy, then hatchkit auth providers --verify"));
    }
  } else if (stored.length > 0) {
    log(chalk.dim("\n  Next: hatchkit sync --deploy, then hatchkit auth providers --verify"));
  }
  return {
    exitCode: checks.some((c) => !c.ok && !c.notLive) ? 1 : 0,
    stored,
    skipped,
    checks,
  };
}

interface Collected {
  entries: Array<{ key: FieldKey; value: string }>;
  appleKeyFile?: string;
}

async function collectProvider(
  provider: OAuthProviderId,
  facts: ProjectFacts,
  args: AuthProvidersArgs,
  deps: AuthProvidersDeps,
): Promise<Collected | typeof SKIP> {
  const log = (line: string) => deps.prompts.log(line);
  if (provider === "github" && !args.githubOAuthApp) {
    const viaApp = await githubViaManifest(facts, args, deps);
    if (viaApp !== "fallback") return viaApp;
    log(chalk.dim("  Falling back to a classic GitHub OAuth app."));
  }
  const ctx: GuideContext = {
    domain: facts.domain,
    project: facts.project,
    ...(args.githubOrg ? { githubOrg: args.githubOrg } : {}),
  };
  const reader = new ValueReader(deps, provider);
  const entries: Collected["entries"] = [];
  let appleKeyFile: string | undefined;
  const steps = providerSteps(provider, ctx);
  for (const [i, step] of steps.entries()) {
    log("");
    log(chalk.bold(`  ${i + 1}/${steps.length} ${step.title}`));
    for (const line of step.lines) log(`     ${line}`);
    for (const key of step.read) {
      const field = FIELDS[key];
      if (field.source === "p8-file") {
        const keyId = entries.find((e) => e.key === "APPLE_KEY_ID")?.value;
        const read = await reader.appleKey(keyId);
        if (read === SKIP) return SKIP;
        entries.push({ key, value: read.value });
        appleKeyFile = read.file;
        continue;
      }
      const read = await reader.clipboard(field);
      if (read === SKIP) return SKIP;
      entries.push({ key, value: read });
    }
    if (step.read.length === 0) {
      const answer = await deps.prompts.enter(
        "Press Enter when done (s + Enter skips this provider).",
      );
      if (answer.toLowerCase() === "s") return SKIP;
    }
  }
  return { entries, ...(appleKeyFile ? { appleKeyFile } : {}) };
}

async function githubViaManifest(
  facts: ProjectFacts,
  args: AuthProvidersArgs,
  deps: AuthProvidersDeps,
): Promise<Collected | typeof SKIP | "fallback"> {
  const log = (line: string) => deps.prompts.log(line);
  const name = args.githubAppName ?? defaultGithubAppName(facts.project);
  log(
    `  hatchkit registers a GitHub App "${name}"${args.githubOrg ? ` under ${args.githubOrg}` : ""}:`,
  );
  log("     sign-in only — one callback, read access to email addresses, no repository");
  log(
    "     access, no webhook. Public, so anyone can sign in (a private App admits only its owner).",
  );
  log("     GitHub opens with the App filled in; check the name and select Create GitHub App.");
  if (!(await deps.prompts.confirm("Open GitHub to create it?", true))) {
    return (await deps.prompts.confirm("Walk through a classic GitHub OAuth app instead?", true))
      ? "fallback"
      : SKIP;
  }
  try {
    const creds = await runGithubManifestFlow({
      domain: facts.domain,
      name,
      ...(args.githubOrg ? { org: args.githubOrg } : {}),
      async open(startUrl) {
        log(chalk.dim(`  Opening ${startUrl} (open it yourself if no browser appears).`));
        await deps.io.openBrowser(startUrl);
      },
      log: (line) => log(chalk.dim(`  ${line}`)),
      fetch: deps.fetch,
      ...(deps.github?.webBase ? { webBase: deps.github.webBase } : {}),
      ...(deps.github?.apiBase ? { apiBase: deps.github.apiBase } : {}),
      ...(deps.github?.timeoutMs ? { timeoutMs: deps.github.timeoutMs } : {}),
    });
    const problems = (["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] as const)
      .map(
        (key) =>
          [
            key,
            FIELDS[key].check(key === "GITHUB_CLIENT_ID" ? creds.clientId : creds.clientSecret),
          ] as const,
      )
      .filter(([, problem]) => problem);
    for (const [key, problem] of problems) log(chalk.yellow(`  ${key} from GitHub: ${problem}.`));
    const settings = githubAppSettingsUrl(creds, args.githubOrg);
    log(chalk.green(`  ✓ GitHub App created${creds.owner ? ` for ${creds.owner}` : ""}.`));
    if (settings) log(chalk.dim(`    Manage it at ${settings}`));
    log(
      chalk.dim(
        "    hatchkit kept only the client ID and secret; it dropped the App's private key and webhook secret.",
      ),
    );
    return {
      entries: [
        { key: "GITHUB_CLIENT_ID", value: creds.clientId },
        { key: "GITHUB_CLIENT_SECRET", value: creds.clientSecret },
      ],
    };
  } catch (err) {
    log(chalk.yellow(`  The GitHub App flow did not finish: ${(err as Error).message}`));
    return (await deps.prompts.confirm("Walk through a classic GitHub OAuth app instead?", true))
      ? "fallback"
      : SKIP;
  }
}
