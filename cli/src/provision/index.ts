/*
 * Provision orchestrator — given a base name like "raptor-runner",
 * creates `-dev` and `-prod` clients in each selected service
 * (GlitchTip / OpenPanel / Resend) and prints an env block ready to
 * paste into an existing project.
 *
 * Also persists the resulting env files under
 *   ~/<conf-dir>/provisioned/<name>.{dev,prod}.env
 * so the output can be retrieved later without re-hitting the APIs.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { ensureGlitchtip, ensureOpenpanel, ensureResend, getConfigPath } from "../config.js";
import { validateProjectName } from "../utils/validate.js";
import {
  parseEnvLines,
  resolveEnvTarget,
  writeDevEnv,
  writeProdEnv,
} from "./write-env.js";
import {
  type GlitchtipClient,
  deleteGlitchtipClient,
  provisionGlitchtipClient,
} from "./glitchtip.js";
import {
  type OpenpanelClient,
  deleteOpenpanelClient,
  provisionOpenpanelClient,
} from "./openpanel.js";
import {
  type ResendClient,
  createResendDomain,
  deleteResendClient,
  listResendDomains,
  normalizeDomainInput,
  provisionResendClient,
} from "./resend.js";

export type ProvisionService = "glitchtip" | "openpanel" | "resend";

export interface ProvisionOptions {
  baseName: string;
  services: ProvisionService[];
  /** Optional pre-selected Resend domain id, skipping the picker. */
  resendDomainId?: string;
  /** Project directory to write `.env.{development,production}` into.
   *  If omitted, the user is prompted (default `./<baseName>`). Pass
   *  `false` to force the legacy copy-paste behaviour. */
  projectDir?: string | false;
}

interface EnvSection {
  env: "dev" | "prod";
  lines: string[];
}

export async function runProvision(opts: ProvisionOptions): Promise<void> {
  const nameCheck = validateProjectName(opts.baseName);
  if (nameCheck !== true) throw new Error(`Invalid base name: ${nameCheck}`);

  // Ensure every selected provider is configured *before* any spinner
  // starts. Otherwise a lazy `ensure*` prompt fires underneath the ora
  // spinner and inquirer waits forever for invisible input.
  if (opts.services.includes("glitchtip")) await ensureGlitchtip();
  if (opts.services.includes("openpanel")) await ensureOpenpanel();
  if (opts.services.includes("resend")) await ensureResend();

  // Resend domain: pick once, reused across dev + prod.
  let resendDomainId = opts.resendDomainId;
  if (opts.services.includes("resend") && !resendDomainId) {
    resendDomainId = await pickResendDomain();
  }

  const sections: EnvSection[] = [];
  for (const env of ["dev", "prod"] as const) {
    const clientName = `${opts.baseName}-${env}`;
    console.log(chalk.bold(`\n  ── ${clientName} ──────────────────────────────────────────\n`));
    const lines: string[] = [];

    if (opts.services.includes("glitchtip")) {
      const res = await withSpinner(`GlitchTip: creating project ${clientName}`, () =>
        provisionGlitchtipClient(clientName),
      );
      lines.push(...renderGlitchtipEnv(res));
    }
    if (opts.services.includes("openpanel")) {
      const res = await withSpinner(`OpenPanel: creating client ${clientName}`, () =>
        provisionOpenpanelClient(clientName),
      );
      lines.push(...renderOpenpanelEnv(res));
    }
    if (opts.services.includes("resend")) {
      const res = await withSpinner(`Resend: creating restricted API key ${clientName}`, () =>
        provisionResendClient(clientName, resendDomainId),
      );
      lines.push(...renderResendEnv(res));
    }

    sections.push({ env, lines });
  }

  // Always persist a 0600 cache copy under ~/<conf-dir>/provisioned/
  // so the values are recoverable without re-hitting the APIs. This
  // file is *never* printed to stdout — the secret values would end
  // up in the terminal's scrollback + shell history.
  const outDir = join(dirname(getConfigPath()), "provisioned");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const savedPaths: Record<"dev" | "prod", string> = {
    dev: join(outDir, `${opts.baseName}.dev.env`),
    prod: join(outDir, `${opts.baseName}.prod.env`),
  };
  for (const section of sections) {
    const banner = `# --- ${opts.baseName} / ${section.env} ---`;
    writeFileSync(
      savedPaths[section.env],
      `${banner}\n${section.lines.join("\n")}\n`,
      { mode: 0o600 },
    );
  }

  // Resolve where to write values. Opting out of the write lands the
  // user back at the copy-paste cache file with a warning that secrets
  // are not meant to be echoed.
  const writeTarget = await resolveWriteTarget(opts);

  if (writeTarget === null) {
    console.log(chalk.bold("\n  ── Provisioned ────────────────────────────────────────────\n"));
    for (const section of sections) {
      const keys = parseEnvLines(section.lines).map((p) => p.key);
      console.log(
        `  ${chalk.bold(section.env)}: ${chalk.green(`${keys.length} vars`)} — ${chalk.dim(keys.join(", "))}`,
      );
      console.log(chalk.dim(`    cached (0600): ${savedPaths[section.env]}`));
    }
    console.log(
      chalk.yellow(
        `\n  Secret values are in the cache files above — read them with \`cat\` from a\n` +
          `  private terminal, or re-run \`hatchkit add ${opts.baseName}\` with a project\n` +
          `  directory to write them directly (recommended).\n`,
      ),
    );
    return;
  }

  // Write dev as plaintext + prod as dotenvx-encrypted directly into
  // the project. No secret ever hits stdout.
  const { baseDir, layout } = resolveEnvTarget(writeTarget);
  const devPath = join(baseDir, ".env.development");
  const prodPath = join(baseDir, ".env.production");

  console.log(chalk.bold("\n  ── Writing env into the project ──────────────────────────\n"));
  console.log(chalk.dim(`  Project: ${writeTarget}  (${layout} layout)`));
  console.log(chalk.dim(`  Dev:     ${devPath}`));
  console.log(chalk.dim(`  Prod:    ${prodPath}  (dotenvx-encrypted)\n`));

  for (const section of sections) {
    const pairs = parseEnvLines(section.lines);
    if (pairs.length === 0) continue;
    if (section.env === "dev") {
      const keys = writeDevEnv(devPath, pairs);
      console.log(`  ${chalk.green("✓")} .env.development: ${keys.join(", ")}`);
    } else {
      const keys = writeProdEnv(prodPath, pairs);
      console.log(
        `  ${chalk.green("✓")} .env.production: ${keys.join(", ")} ${chalk.dim("(encrypted)")}`,
      );
    }
  }

  console.log(chalk.dim(`\n  Cached copies (0600): ${outDir}/${opts.baseName}.{dev,prod}.env\n`));
}

/** Resolve the project directory to write into, or `null` to keep the
 *  legacy cache-only behaviour. Accepts an explicit opt-out (`false`)
 *  for automation that wants to stay headless. */
async function resolveWriteTarget(opts: ProvisionOptions): Promise<string | null> {
  if (opts.projectDir === false) return null;
  if (typeof opts.projectDir === "string") return resolve(opts.projectDir);

  const guess = resolve(opts.baseName);
  const guessExists = existsSync(guess);
  const wantWrite = await confirm({
    message: guessExists
      ? `Write values into ${chalk.cyan(guess)} (dev → .env.development, prod → dotenvx-encrypted .env.production)?`
      : `Write values into a project directory? (keeps secrets off stdout)`,
    default: true,
  });
  if (!wantWrite) return null;

  const picked = (
    await input({
      message: "Project directory:",
      default: guessExists ? guess : `./${opts.baseName}`,
      validate: (v) => {
        const abs = resolve(v.trim());
        return existsSync(abs) ? true : `No such directory: ${abs}`;
      },
    })
  ).trim();
  return resolve(picked);
}

// ---------------------------------------------------------------------------
// Unprovision — inverse of runProvision. Deletes the -dev and -prod
// clients from each selected service, plus the local .env cache.
// ---------------------------------------------------------------------------

export interface UnprovisionOptions {
  baseName: string;
  services: ProvisionService[];
  /** Don't hit any API or remove any file — just print what would happen. */
  dryRun?: boolean;
}

export async function runUnprovision(opts: UnprovisionOptions): Promise<void> {
  const nameCheck = validateProjectName(opts.baseName);
  if (nameCheck !== true) throw new Error(`Invalid base name: ${nameCheck}`);

  // Configure providers before any spinner — same reasoning as runProvision.
  if (opts.services.includes("glitchtip")) await ensureGlitchtip();
  if (opts.services.includes("openpanel")) await ensureOpenpanel();
  if (opts.services.includes("resend")) await ensureResend();

  if (opts.dryRun) {
    console.log(chalk.yellow("\n  [dry-run] No clients will be deleted.\n"));
  }

  for (const env of ["dev", "prod"] as const) {
    const clientName = `${opts.baseName}-${env}`;
    console.log(chalk.bold(`\n  ── ${clientName} ──────────────────────────────────────────\n`));

    if (opts.services.includes("glitchtip")) {
      await runDelete(`GlitchTip: deleting project ${clientName}`, opts.dryRun, () =>
        deleteGlitchtipClient(clientName),
      );
    }
    if (opts.services.includes("openpanel")) {
      await runDelete(`OpenPanel: deleting project ${clientName}`, opts.dryRun, () =>
        deleteOpenpanelClient(clientName),
      );
    }
    if (opts.services.includes("resend")) {
      await runDelete(`Resend: deleting API key ${clientName}`, opts.dryRun, () =>
        deleteResendClient(clientName),
      );
    }
  }

  // Clean up the local .env cache. Mirror runProvision's write locations.
  const outDir = join(dirname(getConfigPath()), "provisioned");
  for (const env of ["dev", "prod"] as const) {
    const path = join(outDir, `${opts.baseName}.${env}.env`);
    if (!existsSync(path)) continue;
    if (opts.dryRun) {
      console.log(chalk.dim(`  would remove ${path}`));
      continue;
    }
    rmSync(path);
    console.log(chalk.dim(`  ✓ removed ${path}`));
  }
  console.log();
}

/** Run a delete via spinner, mapping "not-found" to a dim "already gone"
 *  so re-runs stay quiet. */
async function runDelete(
  label: string,
  dryRun: boolean | undefined,
  fn: () => Promise<"deleted" | "not-found">,
): Promise<void> {
  if (dryRun) {
    console.log(chalk.dim(`  would ${label.toLowerCase()}`));
    return;
  }
  const ora = (await import("ora")).default;
  const spinner = ora(label).start();
  try {
    const result = await fn();
    if (result === "deleted") {
      spinner.succeed(label);
    } else {
      spinner.info(`${label} — already gone`);
    }
  } catch (err) {
    spinner.fail(label);
    // Don't throw on one failure — a single service being flaky shouldn't
    // block the rest of the teardown.
    console.log(chalk.red(`    ${(err as Error).message}`));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const ora = (await import("ora")).default;
  const spinner = ora(label).start();
  try {
    const res = await fn();
    spinner.succeed(label);
    return res;
  } catch (err) {
    spinner.fail(label);
    throw err;
  }
}

async function pickResendDomain(): Promise<string | undefined> {
  const domains = await listResendDomains();
  const sorted = [...domains].sort((a, b) => {
    const av = a.status === "verified" ? 0 : 1;
    const bv = b.status === "verified" ? 0 : 1;
    return av - bv || a.name.localeCompare(b.name);
  });

  const ADD_NEW = "__add_new__";
  const NONE = "";

  const choices = [
    ...sorted.map((d) => ({
      name: d.status === "verified" ? d.name : `${d.name}  ${chalk.dim(`(${d.status})`)}`,
      value: d.id,
    })),
    { name: chalk.cyan("＋ Add a new sending domain…"), value: ADD_NEW },
    { name: "— no domain restriction (account-wide) —", value: NONE },
  ];

  const picked = await select({
    message: "Resend sending domain (both keys will be scoped to it):",
    choices,
  });

  if (picked === NONE) return undefined;
  if (picked !== ADD_NEW) return picked;

  // Add-new flow.
  const raw = await input({
    message: "New sending domain (bare domain — e.g. playtiao.com or mail.playtiao.com):",
    validate: (v) => {
      const n = normalizeDomainInput(v);
      if (!n) return "Enter a domain.";
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(n)) {
        return "That doesn't look like a valid domain.";
      }
      return true;
    },
  });
  const name = normalizeDomainInput(raw);
  const created = await withSpinner(`Resend: creating domain ${name}`, () =>
    createResendDomain(name),
  );
  console.log(
    chalk.yellow(
      `  ${created.name} created (status: ${created.status}). Add the DNS records in the Resend dashboard before sending — https://resend.com/domains/${created.id}`,
    ),
  );
  return created.id;
}

function renderGlitchtipEnv(c: GlitchtipClient): string[] {
  return [`GLITCHTIP_DSN=${c.dsn}`];
}

function renderOpenpanelEnv(c: OpenpanelClient): string[] {
  return [
    `OPENPANEL_API_URL=${c.apiUrl}`,
    `OPENPANEL_CLIENT_ID=${c.clientId}`,
    `OPENPANEL_CLIENT_SECRET=${c.clientSecret}`,
  ];
}

function renderResendEnv(c: ResendClient): string[] {
  return [`RESEND_API_KEY=${c.apiKey}`];
}
