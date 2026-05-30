/*
 * `hatchkit email ses-mail-from` — direct (non-orchestrator) entry into
 * the SES Custom MAIL FROM Domain workflow for the current project.
 *
 * Three subcommands:
 *   · `setup`  — idempotent provision/reconcile. Sets the SES attribute
 *                and publishes the MX + SPF TXT records into Cloudflare.
 *                Adopts a user-set MAIL FROM domain instead of
 *                overwriting it. Records the result into `.hatchkit.json`.
 *   · `status` — read-only snapshot of the SES side + the live DNS rows.
 *                Useful after the first `setup` to confirm the SES status
 *                has flipped from PENDING to SUCCESS.
 *   · `remove` — clear the SES attribute AND delete the MX + TXT records
 *                Hatchkit added. Matching is by *content*, not just
 *                name, so user-edited rows at the same name are left
 *                untouched.
 *
 * The orchestrator path in `listmonk-ses.ts` runs the same SES + DNS
 * work as `setup`; this command exists so a user can re-run JUST the
 * MAIL FROM reconciliation without re-touching DKIM, Listmonk lists,
 * templates, or SMTP settings.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { ensureDns, ensureSes, getDnsConfig, getSesConfig } from "../config.js";
import { publishDnsRecordsToCloudflare } from "../provision/cloudflare-dns-publish.js";
import { sesSendingSubdomain } from "../provision/listmonk-ses.js";
import {
  SES_MAIL_FROM_SPF,
  type SesAuth,
  type SesMailFromBehaviorOnMxFailure,
  type SesMailFromState,
  clearSesMailFromDomain,
  decideMailFromPlan,
  getSesMailFromDomain,
  sesMailFromMxTarget,
  sesMailFromSubdomain,
  setSesMailFromDomain,
} from "../provision/ses.js";
import { MANIFEST_FILENAME, type ProjectManifest, readManifest } from "../scaffold/manifest.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";

export interface SesMailFromCommandFlags {
  /** Override the sending subdomain (default `mail.<projectDomain>`). */
  domain?: string;
  /** Override the MAIL FROM subdomain label (default `bounce`). */
  label?: string;
  /** Override the BehaviorOnMXFailure value (default `UseDefaultValue`). */
  behavior?: SesMailFromBehaviorOnMxFailure;
  /** Skip the SES status poll. Status returns whatever SES reports at
   *  the moment of the set (usually PENDING). */
  noWait?: boolean;
}

interface ResolvedContext {
  projectDir: string;
  manifest: ProjectManifest;
  sendingDomain: string;
  region: string;
  sesAuth: SesAuth;
  cf?: CloudflareApi;
  cfToken?: string;
  cfAccountId?: string;
}

/** Resolve the project context the SES MAIL FROM commands need. Shared
 *  by every subcommand so the credential/manifest checks happen exactly
 *  once. */
async function resolveContext(
  flags: SesMailFromCommandFlags,
  cwd: string,
): Promise<ResolvedContext> {
  const manifestPath = join(cwd, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `No ${MANIFEST_FILENAME} found in ${cwd}. Run from the project directory, or use \`hatchkit adopt\` first.`,
    );
  }
  const manifest = readManifest(cwd);
  if (!manifest) {
    throw new Error(`${MANIFEST_FILENAME} in ${cwd} is unreadable.`);
  }
  if (!manifest.domain) {
    throw new Error(`Manifest in ${cwd} has no \`domain\` — required to derive the SES identity.`);
  }
  const sendingDomain = flags.domain?.trim() || sesSendingSubdomain(manifest.domain);

  const sesCfg = (await getSesConfig()) ?? (await ensureSes());
  const sesAuth: SesAuth = {
    region: sesCfg.region,
    accessKeyId: sesCfg.accessKeyId,
    secretAccessKey: sesCfg.secretAccessKey,
  };

  let cf: CloudflareApi | undefined;
  let cfToken: string | undefined;
  let cfAccountId: string | undefined;
  const dnsCfg = (await getDnsConfig()) ?? null;
  if (dnsCfg?.apiToken) {
    cfToken = dnsCfg.apiToken;
    cfAccountId = dnsCfg.accountId;
    cf = new CloudflareApi({ token: cfToken, accountId: cfAccountId });
  }

  return {
    projectDir: cwd,
    manifest,
    sendingDomain,
    region: sesCfg.region,
    sesAuth,
    cf,
    cfToken,
    cfAccountId,
  };
}

/** `hatchkit email ses-mail-from setup` — idempotent provision +
 *  reconcile. */
export async function runSesMailFromSetup(
  flags: SesMailFromCommandFlags,
  cwd: string,
): Promise<void> {
  const ctx = await resolveContext(flags, cwd);
  if (!ctx.cf) {
    // DNS auto-publish is required for setup — without it we'd set the
    // SES attribute, log PENDING, and leave the user without the MX
    // record that gets it to SUCCESS. Fail-fast with a clear hint.
    await ensureDns();
    throw new Error("Cloudflare DNS not configured. Re-run after `hatchkit config add dns`.");
  }

  const desiredLabel = (flags.label ?? ctx.manifest.ses?.mailFromLabel ?? "bounce").trim();
  const desiredBehavior: SesMailFromBehaviorOnMxFailure =
    flags.behavior ?? ctx.manifest.ses?.mailFromBehaviorOnMxFailure ?? "UseDefaultValue";

  console.log(chalk.bold(`\n  hatchkit email ses-mail-from setup`));
  console.log(chalk.dim(`  Project:        ${ctx.manifest.name}`));
  console.log(chalk.dim(`  SES identity:   ${ctx.sendingDomain}`));
  console.log(chalk.dim(`  SES region:     ${ctx.region}`));

  // Adopt check — never silently overwrite a user-set MAIL FROM.
  const currentState = await getSesMailFromDomain(ctx.sendingDomain, ctx.sesAuth);
  const computedMailFrom = sesMailFromSubdomain(ctx.sendingDomain, desiredLabel);
  const plan = decideMailFromPlan(currentState, computedMailFrom, desiredBehavior);
  const { mailFromDomain, adoptedExisting, behaviorOnMxFailure: behaviorToApply, needsSet } = plan;

  console.log(
    chalk.dim(
      `  MAIL FROM:      ${mailFromDomain}${adoptedExisting ? chalk.yellow(" (adopted — existing user value)") : ""}`,
    ),
  );
  console.log(chalk.dim(`  Behavior:       ${behaviorToApply}`));

  let stateAfter: SesMailFromState = currentState;
  if (needsSet) {
    try {
      stateAfter = await setSesMailFromDomain(
        ctx.sendingDomain,
        mailFromDomain,
        behaviorToApply,
        ctx.sesAuth,
      );
    } catch (err) {
      const msg = (err as Error).message;
      console.log(chalk.red(`  ✗ SES PutEmailIdentityMailFromAttributes failed: ${msg}`));
      console.log(
        chalk.dim(
          "    Most likely cause: missing IAM action ses:PutEmailIdentityMailFromAttributes\n" +
            "    on the SES IAM user's policy. Widen the policy and re-run.",
        ),
      );
      throw err;
    }
  } else {
    console.log(chalk.dim("  · SES attribute already matches; left as-is."));
  }

  const publishRes = await publishDnsRecordsToCloudflare(
    [
      {
        type: "MX",
        name: mailFromDomain,
        value: sesMailFromMxTarget(ctx.region),
        priority: 10,
        label: "MAIL-FROM",
      },
      {
        type: "TXT",
        name: mailFromDomain,
        value: SES_MAIL_FROM_SPF,
        label: "MAIL-FROM-SPF",
      },
    ],
    { cf: ctx.cf, domain: ctx.sendingDomain, logTag: "MAIL-FROM" },
  );

  // Optional status poll.
  if (!flags.noWait && stateAfter.status !== "SUCCESS") {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15_000));
      try {
        stateAfter = await getSesMailFromDomain(ctx.sendingDomain, ctx.sesAuth);
        if (stateAfter.status === "SUCCESS" || stateAfter.status === "FAILED") break;
      } catch {
        // Transient — keep polling.
      }
    }
  }

  writeMailFromIntoManifest(ctx.projectDir, ctx.manifest, {
    identity: ctx.sendingDomain,
    mailFromDomain,
    label: desiredLabel,
    behavior: behaviorToApply,
    region: ctx.region,
  });

  console.log();
  if (stateAfter.status === "SUCCESS") {
    console.log(chalk.green(`  ✓ MAIL FROM configured — SES status: SUCCESS`));
  } else if (stateAfter.status === "PENDING") {
    console.log(
      chalk.yellow(
        `  · MAIL FROM set — SES status: PENDING (DNS propagating; flips to SUCCESS automatically once SES re-checks the MX).`,
      ),
    );
  } else if (stateAfter.status === "FAILED") {
    console.log(
      chalk.red(
        `  ✗ MAIL FROM failed verification — SES status: FAILED.\n    Inspect the MX + SPF rows in Cloudflare for typos.`,
      ),
    );
  } else {
    console.log(
      chalk.yellow(`  · MAIL FROM applied — SES status: ${stateAfter.status ?? "unknown"}.`),
    );
  }

  if (publishRes.created > 0 || publishRes.updated > 0) {
    console.log(
      chalk.dim(
        `    DNS: ${publishRes.created} created, ${publishRes.updated} updated, ${publishRes.unchanged} unchanged in zone ${publishRes.zoneName}.`,
      ),
    );
  }
  console.log(
    chalk.dim(
      `\n  This is a retrofit-safe change: existing sends keep working.\n  Only NEW sends — after DNS propagates — see the custom MAIL FROM.\n`,
    ),
  );
}

/** `hatchkit email ses-mail-from status` — read-only state snapshot. */
export async function runSesMailFromStatus(
  flags: SesMailFromCommandFlags,
  cwd: string,
): Promise<void> {
  const ctx = await resolveContext(flags, cwd);
  const state = await getSesMailFromDomain(ctx.sendingDomain, ctx.sesAuth);

  console.log(chalk.bold(`\n  hatchkit email ses-mail-from status`));
  console.log(chalk.dim(`  Project:        ${ctx.manifest.name}`));
  console.log(chalk.dim(`  SES identity:   ${ctx.sendingDomain}`));
  console.log(chalk.dim(`  SES region:     ${ctx.region}`));
  if (!state.mailFromDomain) {
    console.log(
      chalk.yellow(
        `  MAIL FROM:      ${chalk.bold("not configured")} (using default amazonses.com)`,
      ),
    );
    console.log(chalk.dim(`\n  Configure: hatchkit email ses-mail-from setup\n`));
    return;
  }

  console.log(`  MAIL FROM:      ${chalk.cyan(state.mailFromDomain)}`);
  console.log(`  Behavior:       ${state.behaviorOnMxFailure ?? "unknown"}`);
  console.log(`  SES status:     ${formatStatus(state.status)}`);

  if (ctx.cf) {
    const zone = await ctx.cf.resolveZoneForName(state.mailFromDomain);
    if (zone) {
      const mxRows = await ctx.cf.findRecordsByName(zone.id, state.mailFromDomain, "MX");
      const txtRows = await ctx.cf.findRecordsByName(zone.id, state.mailFromDomain, "TXT");
      const expectedMxTarget = sesMailFromMxTarget(ctx.region);
      const mxOk = mxRows.some((r) => r.content === expectedMxTarget);
      const spfOk = txtRows.some((r) => /v=spf1.*include:amazonses\.com/i.test(r.content));
      console.log(
        `  MX record:      ${mxOk ? chalk.green(`✓ ${expectedMxTarget}`) : chalk.red(`✗ expected ${expectedMxTarget}`)}`,
      );
      console.log(
        `  SPF TXT:        ${spfOk ? chalk.green("✓ include:amazonses.com") : chalk.red("✗ missing include:amazonses.com")}`,
      );
    } else {
      console.log(
        chalk.dim(
          `  DNS:            no Cloudflare zone covers ${state.mailFromDomain} — can't verify records.`,
        ),
      );
    }
  } else {
    console.log(chalk.dim(`  DNS:            Cloudflare not configured — can't verify records.`));
  }
  console.log();
}

/** `hatchkit email ses-mail-from remove` — clear the SES attribute +
 *  delete only the DNS rows Hatchkit added. */
export async function runSesMailFromRemove(
  flags: SesMailFromCommandFlags,
  cwd: string,
): Promise<void> {
  const ctx = await resolveContext(flags, cwd);

  console.log(chalk.bold(`\n  hatchkit email ses-mail-from remove`));
  console.log(chalk.dim(`  Project:        ${ctx.manifest.name}`));
  console.log(chalk.dim(`  SES identity:   ${ctx.sendingDomain}`));

  const state = await getSesMailFromDomain(ctx.sendingDomain, ctx.sesAuth);
  if (!state.mailFromDomain) {
    console.log(chalk.dim("  · MAIL FROM already not configured on the SES identity."));
  } else {
    await clearSesMailFromDomain(ctx.sendingDomain, ctx.sesAuth);
    console.log(chalk.green(`  ✓ Cleared SES MAIL FROM (was ${state.mailFromDomain}).`));
  }

  // Match-by-content delete: Hatchkit only removes rows whose content
  // matches what we ever publish (the regional MX target + the canonical
  // SPF string). A user-edited TXT at the same name (e.g. one with
  // additional SPF includes) is left alone.
  if (ctx.cf) {
    const mailFromDomain = state.mailFromDomain ?? ctx.manifest.ses?.mailFromDomain;
    if (mailFromDomain) {
      const zone = await ctx.cf.resolveZoneForName(mailFromDomain);
      if (zone) {
        const mxRows = await ctx.cf.findRecordsByName(zone.id, mailFromDomain, "MX");
        const txtRows = await ctx.cf.findRecordsByName(zone.id, mailFromDomain, "TXT");
        const expectedMxTarget = sesMailFromMxTarget(ctx.region);
        let mxDeleted = 0;
        let txtDeleted = 0;
        for (const row of mxRows) {
          if (row.content === expectedMxTarget) {
            await ctx.cf.deleteRecord(zone.id, row.id);
            mxDeleted += 1;
          }
        }
        for (const row of txtRows) {
          if (row.content === SES_MAIL_FROM_SPF || row.content === `"${SES_MAIL_FROM_SPF}"`) {
            await ctx.cf.deleteRecord(zone.id, row.id);
            txtDeleted += 1;
          }
        }
        console.log(
          chalk.dim(
            `  · DNS cleanup: removed ${mxDeleted} MX, ${txtDeleted} TXT row(s) Hatchkit added; left user-edited rows alone.`,
          ),
        );
      }
    }
  }

  clearMailFromFromManifest(ctx.projectDir, ctx.manifest);
  console.log(chalk.dim(`  · Manifest updated.\n`));
}

function formatStatus(status: SesMailFromState["status"]): string {
  if (status === "SUCCESS") return chalk.green("SUCCESS");
  if (status === "PENDING") return chalk.yellow("PENDING");
  if (status === "FAILED") return chalk.red("FAILED");
  if (status === "TEMPORARY_FAILURE") return chalk.yellow("TEMPORARY_FAILURE");
  return chalk.dim("unknown");
}

function writeMailFromIntoManifest(
  projectDir: string,
  manifest: ProjectManifest,
  info: {
    identity: string;
    mailFromDomain: string;
    label: string;
    behavior: SesMailFromBehaviorOnMxFailure;
    region: string;
  },
): void {
  const next: ProjectManifest = {
    ...manifest,
    ses: {
      ...(manifest.ses ?? {}),
      identity: info.identity,
      mailFromDomain: info.mailFromDomain,
      mailFromLabel: info.label,
      mailFromBehaviorOnMxFailure: info.behavior,
      mailFromManagedDnsRecords: [
        {
          type: "MX",
          name: info.mailFromDomain,
          value: sesMailFromMxTarget(info.region),
          priority: 10,
        },
        { type: "TXT", name: info.mailFromDomain, value: SES_MAIL_FROM_SPF },
      ],
    },
  };
  writeFileSync(join(projectDir, MANIFEST_FILENAME), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

function clearMailFromFromManifest(projectDir: string, manifest: ProjectManifest): void {
  if (!manifest.ses) return;
  const ses = { ...manifest.ses };
  delete ses.mailFromDomain;
  delete ses.mailFromLabel;
  delete ses.mailFromBehaviorOnMxFailure;
  delete ses.mailFromManagedDnsRecords;
  const hasAnyRemaining = Object.keys(ses).some((k) => k !== "identity");
  const next: ProjectManifest = {
    ...manifest,
    ses: hasAnyRemaining ? ses : undefined,
  };
  writeFileSync(join(projectDir, MANIFEST_FILENAME), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

/** Parse the `ses-mail-from` flag slice (everything after the
 *  subcommand). Same flag-parser idiom as the surrounding `email`
 *  dispatcher. */
export function parseSesMailFromFlags(rest: string[]): SesMailFromCommandFlags {
  const flags: SesMailFromCommandFlags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--domain" && rest[i + 1]) flags.domain = rest[++i];
    else if (a.startsWith("--domain=")) flags.domain = a.slice("--domain=".length);
    else if (a === "--label" && rest[i + 1]) flags.label = rest[++i];
    else if (a.startsWith("--label=")) flags.label = a.slice("--label=".length);
    else if (a === "--behavior" && rest[i + 1])
      flags.behavior = rest[++i] as SesMailFromBehaviorOnMxFailure;
    else if (a.startsWith("--behavior="))
      flags.behavior = a.slice("--behavior=".length) as SesMailFromBehaviorOnMxFailure;
    else if (a === "--no-wait") flags.noWait = true;
  }
  return flags;
}

/** Dispatch the `hatchkit email ses-mail-from <sub>` subtree. */
export async function handleSesMailFromCommand(rest: string[], cwd: string): Promise<void> {
  const sub = rest[0];
  const flags = parseSesMailFromFlags(rest.slice(1));
  switch (sub) {
    case "setup":
      await runSesMailFromSetup(flags, cwd);
      return;
    case "status":
      await runSesMailFromStatus(flags, cwd);
      return;
    case "remove":
      await runSesMailFromRemove(flags, cwd);
      return;
    default:
      console.log("Usage: hatchkit email ses-mail-from <setup|status|remove> [flags]");
      console.log("");
      console.log("  setup   Configure SES Custom MAIL FROM + publish MX/SPF DNS records");
      console.log("  status  Print the current SES MAIL FROM state + live DNS");
      console.log("  remove  Clear the SES attribute + delete Hatchkit-owned DNS rows");
      console.log("");
      console.log("Flags:");
      console.log("  --domain <fqdn>     Override SES identity (default mail.<projectDomain>)");
      console.log("  --label <name>      MAIL FROM subdomain label (default bounce)");
      console.log("  --behavior <mode>   UseDefaultValue (default) | RejectMessage");
      console.log("  --no-wait           Skip the SES status poll (status returns PENDING)");
      process.exit(1);
  }
}
