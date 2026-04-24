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

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { getConfigPath } from "../config.js";
import { validateProjectName } from "../utils/validate.js";
import { type GlitchtipClient, provisionGlitchtipClient } from "./glitchtip.js";
import { type OpenpanelClient, provisionOpenpanelClient } from "./openpanel.js";
import {
  createResendDomain,
  listResendDomains,
  normalizeDomainInput,
  provisionResendClient,
  type ResendClient,
} from "./resend.js";

export type ProvisionService = "glitchtip" | "openpanel" | "resend";

export interface ProvisionOptions {
  baseName: string;
  services: ProvisionService[];
  /** Optional pre-selected Resend domain id, skipping the picker. */
  resendDomainId?: string;
}

interface EnvSection {
  env: "dev" | "prod";
  lines: string[];
}

export async function runProvision(opts: ProvisionOptions): Promise<void> {
  const nameCheck = validateProjectName(opts.baseName);
  if (nameCheck !== true) throw new Error(`Invalid base name: ${nameCheck}`);

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

  const outDir = join(dirname(getConfigPath()), "provisioned");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  console.log(chalk.bold("\n  ── Env blocks (copy-paste into the corresponding project) ─\n"));
  for (const section of sections) {
    const banner = `# --- ${opts.baseName} / ${section.env} ---`;
    console.log(chalk.cyan(banner));
    for (const line of section.lines) console.log(line);
    console.log();

    const path = join(outDir, `${opts.baseName}.${section.env}.env`);
    writeFileSync(path, `${banner}\n${section.lines.join("\n")}\n`, "utf-8");
    console.log(chalk.dim(`  saved: ${path}`));
  }
  console.log();
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
