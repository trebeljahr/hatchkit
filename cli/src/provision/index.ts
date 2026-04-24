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
import { select } from "@inquirer/prompts";
import chalk from "chalk";
import { getConfigPath } from "../config.js";
import { validateProjectName } from "../utils/validate.js";
import { type GlitchtipClient, provisionGlitchtipClient } from "./glitchtip.js";
import { type OpenpanelClient, provisionOpenpanelClient } from "./openpanel.js";
import { type ResendClient, listResendDomains, provisionResendClient } from "./resend.js";

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
    const domains = await listResendDomains();
    const verified = domains.filter((d) => d.status === "verified");
    if (verified.length === 0) {
      console.log(
        chalk.yellow(
          "  No verified Resend domains found — API keys will be created without a domain restriction (account-wide).",
        ),
      );
    } else {
      const picked = await select({
        message: "Resend sending domain (both keys will be scoped to it):",
        choices: [
          ...verified.map((d) => ({ name: d.name, value: d.id })),
          { name: "— no domain restriction (account-wide) —", value: "" },
        ],
      });
      if (picked) resendDomainId = picked;
    }
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
