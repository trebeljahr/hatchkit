/*
 * `hatchkit email` command surface.
 *
 * Two entry points:
 *   · `hatchkit email setup` — full setup or re-run on a given domain.
 *     Flag-driven; missing flags get prompted (multi-select for the
 *     forwarding addresses, single-input for the destination).
 *   · `hatchkit email status` — print the current state of Email Routing
 *     for the project's domain. No mutations. Useful inside a project
 *     dir or after a setup to confirm verification went through.
 *
 * The same `runEmailSetupForDomain` is reused by the provision
 * orchestrator's `email` service entry, so the setup logic exists in
 * exactly one place — flags and prompts are the only difference.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { confirm, input } from "@inquirer/prompts";
import chalk from "chalk";
import {
  detectPersonalEmailLocalPart,
  ensureDefaultForwardingEmail,
  ensureDns,
  getDefaultForwardingEmail,
  getDnsConfig,
  getPersonalEmailLocalPart,
} from "../config.js";
import { readManifest, writeManifest } from "../scaffold/manifest.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";
import { multiselect } from "../utils/multiselect.js";
import { DEFAULT_CATCH_ALL, buildForwardPresets } from "./presets.js";
import { assertEmailRoutingAccess, probeEmailRouting } from "./routing-access.js";
import {
  type EmailSetupOptions,
  type EmailSetupResult,
  printEmailSetupSummary,
  runEmailSetup,
} from "./setup.js";

export interface EmailCommandFlags {
  domain?: string;
  /** Forwarding destination override. Falls back to the saved default. */
  to?: string;
  /** Comma-separated local parts (e.g. "hello,alice,admin"). Skips the
   *  multi-select prompt when present. */
  addresses?: string;
  /** Programmatic equivalent of `--addresses` for callers that already
   *  hold a resolved list (e.g. `hatchkit create` after the planning
   *  step). Accepts an empty array as an explicit "no per-local-part
   *  rules" — the comma-string form can't express that because empty
   *  string is falsy. When set, both the addresses prompt and the
   *  catch-all prompt are skipped; pair with {@link catchAllResolved}. */
  addressesResolved?: string[];
  /** Programmatic catch-all answer. Used alongside `addressesResolved`
   *  to bypass `resolveAddresses` entirely. */
  catchAllResolved?: boolean;
  /** Skip the prompt; use every default preset. */
  allDefaults?: boolean;
  /** Force no catch-all (overrides the default-true). */
  noCatchAll?: boolean;
  /** DMARC policy override. Default "quarantine". */
  dmarcPolicy?: "none" | "quarantine" | "reject";
  /** Skip the resend SPF include auto-merge. */
  noResendSpf?: boolean;
}

/** Resolve a domain to set up email for. Precedence:
 *    1. --domain flag
 *    2. .hatchkit.json in cwd
 *    3. interactive prompt
 *  Used by both `hatchkit email setup` and the provision-service hook. */
async function resolveDomain(flagDomain: string | undefined, cwd: string): Promise<string> {
  if (flagDomain) return flagDomain.trim();
  const manifestPath = join(cwd, ".hatchkit.json");
  if (existsSync(manifestPath)) {
    const manifest = readManifest(cwd);
    if (manifest?.domain) {
      console.log(chalk.dim(`  Using domain from .hatchkit.json: ${manifest.domain}`));
      return manifest.domain;
    }
  }
  return input({
    message: "Domain to set up email for (e.g. example.com):",
    validate: (v) =>
      /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(v.trim()) ? true : "Looks malformed.",
  });
}

/** Prompt the user for which local parts to forward — or take them
 *  straight from the `--addresses` flag. */
async function resolveAddresses(
  flags: EmailCommandFlags,
  domain: string,
): Promise<{ addresses: string[]; catchAll: boolean }> {
  // Caller-provided structured answers win first — used by `hatchkit
  // create` after the planning-phase Email forwarding step so the
  // execution path never reprompts. Distinct from `flags.addresses`
  // because the empty-array case has to round-trip.
  if (flags.addressesResolved !== undefined) {
    return {
      addresses: flags.addressesResolved.map((a) => a.trim().toLowerCase()).filter(Boolean),
      catchAll: flags.catchAllResolved ?? !flags.noCatchAll,
    };
  }
  // Personal-alias preset: saved value from `hatchkit setup` wins, then
  // a best-effort guess from `git config user.email`. The picker still
  // lets the user untick it.
  const personalAlias = getPersonalEmailLocalPart() ?? (await detectPersonalEmailLocalPart());
  const presets = buildForwardPresets(personalAlias);
  if (flags.addresses) {
    const list = flags.addresses
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return { addresses: list, catchAll: !flags.noCatchAll };
  }
  if (flags.allDefaults) {
    return {
      addresses: presets.filter((p) => p.defaultChecked).map((p) => p.localPart),
      catchAll: !flags.noCatchAll,
    };
  }
  const picked = await multiselect<string>({
    message: `Which addresses on ${domain} should forward to your inbox?`,
    choices: presets.map((p) => ({
      name: `${p.localPart}@${domain} — ${p.description}`,
      value: p.localPart,
      checked: p.defaultChecked,
    })),
    required: false,
  });
  const catchAll = flags.noCatchAll
    ? false
    : await confirm({
        message: `Also enable catch-all (*@${domain} → your inbox)?`,
        default: DEFAULT_CATCH_ALL,
      });
  return { addresses: picked, catchAll };
}

/** Probe the zone for an existing Resend DKIM record so we can auto-add
 *  `_spf.resend.com` to the merged SPF when present. Returns the include
 *  list to merge (empty when no Resend in evidence). Cheap one-call probe;
 *  if it fails (token lacks read perm, zone not in account), returns []. */
export async function detectExtraSpfIncludes(
  token: string,
  zoneId: string,
  domain: string,
): Promise<string[]> {
  try {
    const cf = new CloudflareApi({ token });
    const includes: string[] = [];
    // Resend domains add a CNAME at `resend._domainkey.<zone>` — its
    // presence is the cleanest signal that the zone sends via Resend.
    // One name+type lookup is much cheaper than listing the zone.
    const dkim = await cf.findRecordsByName(zoneId, `resend._domainkey.${domain}`, "CNAME");
    if (dkim.length > 0) {
      includes.push("_spf.resend.com");
    }
    return includes;
  } catch {
    return [];
  }
}

/** Shared setup runner used by both `hatchkit email setup` and the
 *  provision-orchestrator "email" service. Resolves DNS config, runs
 *  prompts that haven't been answered by flags, executes the setup,
 *  and prints the summary. */
export async function runEmailSetupForDomain(
  flags: EmailCommandFlags,
  cwd: string = process.cwd(),
): Promise<EmailSetupResult> {
  // DNS config is needed for the CF Bearer token + accountId. Lazy-prompt
  // when missing — same contract as every other provider in the CLI.
  let dns = await getDnsConfig();
  if (!dns || !dns.apiToken) dns = await ensureDns();
  if (!dns?.apiToken) {
    throw new Error("Cloudflare API token not configured. Run `hatchkit config add dns`.");
  }

  const domain = await resolveDomain(flags.domain, cwd);
  const destination =
    flags.to?.trim() || getDefaultForwardingEmail() || (await ensureDefaultForwardingEmail());

  const { addresses, catchAll } = await resolveAddresses(flags, domain);

  // We need the zone id to detect resend SPF before the main setup runs.
  // The setup orchestrator will resolve the zone again. Keeping the two
  // lookups separate keeps the orchestrator dependency-free of
  // flag-parsing concerns.
  let extraSpf: string[] = [];
  if (!flags.noResendSpf) {
    const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });
    const zone = await cf.resolveZoneForName(domain);
    if (zone) {
      extraSpf = await detectExtraSpfIncludes(dns.apiToken, zone.id, domain);
    }
  }

  const opts: EmailSetupOptions = {
    token: dns.apiToken,
    accountId: dns.accountId,
    domain,
    destination,
    addresses,
    catchAll,
    extraSpfIncludes: extraSpf,
    dmarcPolicy: flags.dmarcPolicy ?? "quarantine",
  };

  console.log(chalk.bold(`\n  hatchkit email setup`));
  console.log(chalk.dim(`  Domain:       ${domain}`));
  console.log(chalk.dim(`  Destination:  ${destination}`));
  console.log(
    chalk.dim(
      `  Addresses:    ${addresses.length > 0 ? addresses.map((a) => `${a}@`).join(", ") : "(none — catch-all only)"}`,
    ),
  );
  console.log(chalk.dim(`  Catch-all:    ${catchAll ? "yes" : "no"}`));
  console.log(chalk.dim(`  DMARC:        p=${opts.dmarcPolicy}`));
  if (extraSpf.length > 0) {
    console.log(chalk.dim(`  SPF merge:    ${extraSpf.join(", ")}`));
  }

  const result = await runEmailSetup(opts);
  printEmailSetupSummary(result);
  return result;
}

/** `hatchkit email status` — read-only state report for the current
 *  project's (or `--domain`-overridden) zone. */
export async function runEmailStatus(
  flags: EmailCommandFlags,
  cwd: string = process.cwd(),
): Promise<void> {
  const dns = await getDnsConfig();
  if (!dns?.apiToken) {
    console.log(chalk.yellow("  DNS not configured. Run `hatchkit config add dns`."));
    return;
  }
  const domain = await resolveDomain(flags.domain, cwd);
  const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });
  const zone = await cf.resolveZoneForName(domain);
  if (!zone) {
    console.log(chalk.yellow(`  No zone for ${domain} in this Cloudflare account.`));
    return;
  }
  const accountId = dns.accountId ?? zone.account?.id;
  const probe = await probeEmailRouting(cf, domain, { accountId });
  if (probe.access === "unauthorized") {
    console.log(chalk.red(`\n  ✗ ${probe.error.message}`));
    for (const line of probe.error.hint) console.log(chalk.dim(`    ${line}`));
    process.exitCode = 1;
    return;
  }
  const routing = await cf.getEmailRouting(zone.id);
  const rules = routing?.enabled ? await cf.listEmailRoutingRules(zone.id) : [];
  const destinations = accountId ? await cf.listEmailDestinations(accountId) : [];
  const mx = await cf.findRecordsByName(zone.id, domain, "MX");
  const spfAndDmarc = await cf.findRecordsByName(zone.id, domain, "TXT");
  const dmarc = await cf.findRecordsByName(zone.id, `_dmarc.${domain}`, "TXT");

  console.log(chalk.bold(`\n  ── Email status: ${domain} ───────────────────────────\n`));
  console.log(
    `  Routing:      ${routing?.enabled ? chalk.green("enabled") : chalk.red("disabled")}${routing?.status ? chalk.dim(` (${routing.status})`) : ""}`,
  );
  console.log(
    `  MX records:   ${mx.length > 0 ? chalk.green(`${mx.length} (${mx.map((r) => r.content).join(", ")})`) : chalk.red("none")}`,
  );
  const spf = spfAndDmarc.find((r) => /v=spf1/i.test(r.content));
  console.log(`  SPF:          ${spf ? chalk.green(spf.content) : chalk.red("missing")}`);
  console.log(`  DMARC:        ${dmarc[0] ? chalk.green(dmarc[0].content) : chalk.red("missing")}`);
  console.log(`  Destinations: ${destinations.length} on account`);
  for (const d of destinations) {
    const tag = d.verified === "active" ? chalk.green("✓ verified") : chalk.yellow("· pending");
    console.log(`    ${tag} ${d.email}`);
  }
  console.log(`  Rules:        ${rules.length}`);
  for (const r of rules) {
    const to = r.matchers?.find((m) => m.field === "to")?.value;
    const fwd = r.actions?.[0]?.value?.join(", ");
    console.log(`    ${to ?? "?"} → ${fwd ?? "?"}`);
  }
}

/** Add one literal forwarding rule without changing DNS, catch-all, or other rules. */
export async function runEmailForward(rest: string[], cwd: string = process.cwd()): Promise<void> {
  const addressArg = rest[0];
  const flags = parseEmailFlags(rest.slice(1));
  const domain = await resolveDomain(flags.domain, cwd);
  const localPart = addressArg?.includes("@")
    ? addressArg.slice(0, addressArg.indexOf("@"))
    : addressArg;
  if (!localPart || !/^[a-z0-9][a-z0-9.!#$%&'*+/=?^_`{|}~-]*$/i.test(localPart)) {
    throw new Error("Give one valid local part or full address: hatchkit email forward support --domain example.com");
  }
  if (addressArg?.includes("@") && addressArg.slice(addressArg.indexOf("@") + 1).toLowerCase() !== domain.toLowerCase()) {
    throw new Error(`Address must belong to ${domain}.`);
  }
  const address = `${localPart.toLowerCase()}@${domain.toLowerCase()}`;
  const dns = await getDnsConfig();
  if (!dns?.apiToken) throw new Error("Cloudflare API token not configured. Run `hatchkit config add dns`.");
  const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });
  const zone = await cf.resolveZoneForName(domain);
  if (!zone) throw new Error(`No Cloudflare zone for ${domain}.`);
  const accountId = dns.accountId ?? zone.account?.id;
  if (!accountId) throw new Error("Cloudflare account id could not be resolved.");
  await assertForwardingReady(cf, zone.id, domain, accountId);
  const rules = await cf.listEmailRoutingRules(zone.id);
  const existing = rules.find((r) => r.matchers?.some((m) =>
    m.field === "to" && m.type === "literal" && m.value?.toLowerCase() === address));
  const destination = flags.to?.trim() || getDefaultForwardingEmail();
  if (!destination || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination)) {
    throw new Error("Set a forwarding destination with --to <email> or in hatchkit setup defaults.");
  }
  if (existing) {
    const targets = existing.actions?.filter((a) => a.type === "forward").flatMap((a) => a.value ?? []) ?? [];
    if (existing.enabled !== false && targets.length === 1 && targets[0].toLowerCase() === destination.toLowerCase()) {
      recordForwarding(cwd, domain, localPart.toLowerCase(), destination);
      console.log(chalk.dim(`  · ${address} already forwards to ${destination}`));
      return;
    }
    throw new Error(`${address} already has a different routing rule. Inspect it with hatchkit email status --domain ${domain}; no changes made.`);
  }
  const saved = await cf.addEmailDestination(accountId, destination);
  if (saved.verified !== "active") {
    console.log(chalk.yellow(`  ${destination} is pending verification. Click the Cloudflare email, then re-run this command. No rule created.`));
    return;
  }
  await cf.upsertEmailRoutingRule(zone.id, { address, forwardTo: [destination], name: `Forward ${address}` });
  recordForwarding(cwd, domain, localPart.toLowerCase(), destination);
  console.log(chalk.green(`  ✓ ${address} → ${destination}`));
}

export function recordForwarding(cwd: string, domain: string, localPart: string, destination: string): void {
  const manifest = readManifest(cwd);
  if (manifest?.domain?.toLowerCase() === domain.toLowerCase()) {
    const old = manifest.integrations?.email;
    const defaultDestination = old?.destinationEmail ?? destination;
    const addressDestinations = { ...old?.addressDestinations };
    if (defaultDestination.toLowerCase() === destination.toLowerCase()) {
      delete addressDestinations[localPart];
    } else {
      addressDestinations[localPart] = destination;
    }
    writeManifest(cwd, {
      ...manifest,
      integrations: {
        ...manifest.integrations,
        email: {
          ...old,
          domain,
          configuredAt: new Date().toISOString(),
          destinationEmail: defaultDestination,
          addresses: [...new Set([...(old?.addresses ?? []), localPart])],
          addressDestinations,
        },
      },
    });
  }
}

async function assertForwardingReady(cf: CloudflareApi, zoneId: string, domain: string, accountId: string): Promise<void> {
  await assertEmailRoutingAccess(cf, domain, { accountId });
  const routing = await cf.getEmailRouting(zoneId);
  const mx = await cf.findRecordsByName(zoneId, domain, "MX");
  if (!routing?.enabled || !mx.some((r) => /(^|\.)mx\.cloudflare\.net\.?$/i.test(r.content))) {
    throw new Error(`Email Routing is not receiving for ${domain}. Run hatchkit email setup --domain ${domain} first.`);
  }
  if (mx.some((r) => !/(^|\.)mx\.cloudflare\.net\.?$/i.test(r.content))) {
    throw new Error(`${domain} has non-Cloudflare MX records. Resolve mail delivery before adding a rule.`);
  }
}

/** Parse `hatchkit email …` flags from the raw argv slice. Centralised
 *  here so the index.ts dispatcher only deals with subcommand routing. */
export function parseEmailFlags(rest: string[]): EmailCommandFlags {
  const flags: EmailCommandFlags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--domain" && rest[i + 1]) flags.domain = rest[++i];
    else if (a.startsWith("--domain=")) flags.domain = a.slice("--domain=".length);
    else if (a === "--to" && rest[i + 1]) flags.to = rest[++i];
    else if (a.startsWith("--to=")) flags.to = a.slice("--to=".length);
    else if (a === "--addresses" && rest[i + 1]) flags.addresses = rest[++i];
    else if (a.startsWith("--addresses=")) flags.addresses = a.slice("--addresses=".length);
    else if (a === "--all-defaults") flags.allDefaults = true;
    else if (a === "--no-catch-all") flags.noCatchAll = true;
    else if (a === "--dmarc" && rest[i + 1])
      flags.dmarcPolicy = rest[++i] as EmailCommandFlags["dmarcPolicy"];
    else if (a.startsWith("--dmarc="))
      flags.dmarcPolicy = a.slice("--dmarc=".length) as EmailCommandFlags["dmarcPolicy"];
    else if (a === "--no-resend-spf") flags.noResendSpf = true;
  }
  return flags;
}

/** Top-level `hatchkit email <sub>` dispatcher. */
export async function handleEmailCommand(rest: string[]): Promise<void> {
  const sub = rest[0];
  if (sub === "ses-mail-from") {
    const { handleSesMailFromCommand } = await import("./ses-mail-from.js");
    await handleSesMailFromCommand(rest.slice(1), resolve("."));
    return;
  }
  const flags = parseEmailFlags(rest.slice(1));
  switch (sub) {
    case "forward":
      await runEmailForward(rest.slice(1), resolve("."));
      return;
    case "setup":
      await runEmailSetupForDomain(flags, resolve("."));
      return;
    case "status":
      await runEmailStatus(flags, resolve("."));
      return;
    default:
      console.log("Usage: hatchkit email <setup|forward|status|ses-mail-from> [flags]");
      console.log("");
      console.log("  setup           Configure Cloudflare Email Routing + DNS for a domain");
      console.log("  forward <address>  Add one address on an existing receiving domain");
      console.log("  status          Print the current Email Routing state");
      console.log("  ses-mail-from   Manage the SES Custom MAIL FROM Domain for this project");
      console.log("");
      console.log("Flags (setup):");
      console.log("  --domain <fqdn>           Override the project domain");
      console.log("  --to <email>              Forwarding destination");
      console.log("  --addresses <list>        Comma-separated local parts (skips prompt)");
      console.log("  --all-defaults            Use every default preset; skip prompts");
      console.log("  --no-catch-all            Don't set the *@domain catch-all rule");
      console.log("  --dmarc <none|quarantine|reject>  DMARC policy (default: quarantine)");
      console.log("  --no-resend-spf           Skip auto-merging _spf.resend.com");
      console.log("");
      console.log("Run `hatchkit email ses-mail-from` for the SES MAIL FROM subcommands.");
      process.exit(1);
  }
}
