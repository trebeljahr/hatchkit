/**
 * `hatchkit ses domain [<project-directory>] [--dry-run]`
 *
 * The SES sending domain for a project that sends with direct SES and
 * has no Listmonk: the identity `mail.<domain>`, its DKIM CNAMEs and the
 * custom MAIL FROM rows in Cloudflare. The same steps `hatchkit add
 * <project> listmonk-ses` runs first, without the lists, templates, API
 * user and SMTP relay. `hatchkit ses isolate --activate` then needs the
 * identity to be verified.
 *
 * Every created identity and DNS row goes into the project's run
 * ledger, so `hatchkit destroy <project>` removes them. Bounce and
 * complaint routing is not set up here: that path ends in Listmonk's
 * blocklist. SES's account-level suppression list still stops sends to
 * addresses that bounced or complained.
 */
import { resolve } from "node:path";
import chalk from "chalk";
import { getDnsConfig, getSesConfig } from "../config.js";
import { findManifestDirUpward, patchManifest, readManifest } from "../scaffold/manifest.js";
import { appendLedgerStep } from "../utils/run-ledger.js";
import { provisionSesSendingDomain, sesSendingSubdomain } from "./listmonk-ses.js";
import {
  SES_MAIL_FROM_SPF,
  getSesDomain,
  sesMailFromMxTarget,
  sesMailFromSubdomain,
} from "./ses.js";

export function parseSesDomainFlags(argv: string[]): { dryRun: boolean; projectDir: string } {
  const flags = { dryRun: false, projectDir: "" };
  for (const a of argv) {
    if (a === "--dry-run") flags.dryRun = true;
    else if (a.startsWith("-") || flags.projectDir) throw new Error(`Unknown/extra argument ${a}`);
    else flags.projectDir = resolve(a);
  }
  return flags;
}

/** What a run would create, for `--dry-run` and the run header. */
export function sesDomainPlan(domain: string, region: string): string[] {
  const identity = sesSendingSubdomain(domain);
  const mailFrom = sesMailFromSubdomain(identity, "bounce");
  return [
    `SES identity ${identity} in ${region} with Easy DKIM`,
    `3 DKIM CNAMEs <token>._domainkey.${identity} in Cloudflare`,
    `custom MAIL FROM ${mailFrom}: MX 10 ${sesMailFromMxTarget(region)} and TXT "${SES_MAIL_FROM_SPF}"`,
    "no Listmonk lists, templates, API user or SMTP relay",
  ];
}

export async function runSesDomainCli(argv: string[]): Promise<void> {
  const f = parseSesDomainFlags(argv);
  const dir = f.projectDir || findManifestDirUpward(process.cwd());
  if (!dir) throw new Error("Pass a project directory or run inside a Hatchkit project.");
  const manifest = readManifest(dir);
  if (!manifest?.name || !manifest.domain)
    throw new Error("Project manifest needs name and domain.");
  const ses = await getSesConfig();
  if (!ses) throw new Error("SES is not configured. Run `hatchkit config add ses` first.");
  const sesAuth = {
    region: ses.region,
    accessKeyId: ses.accessKeyId,
    secretAccessKey: ses.secretAccessKey,
  };
  const identityName = sesSendingSubdomain(manifest.domain);

  console.log(chalk.bold(`\n  SES sending domain for ${manifest.name}\n`));
  for (const line of sesDomainPlan(manifest.domain, ses.region)) console.log(`  · ${line}`);

  if (f.dryRun) {
    let state = "absent: a run creates it";
    try {
      const existing = await getSesDomain(identityName, sesAuth);
      state = existing.verifiedForSendingStatus
        ? "exists and is verified"
        : "exists, not verified yet";
    } catch (err) {
      if ((err as { name?: string }).name !== "NotFoundException") throw err;
    }
    console.log(chalk.dim(`\n  Identity ${identityName}: ${state}.`));
    console.log(chalk.dim("  Dry run: no AWS, DNS, ledger or manifest writes."));
    return;
  }

  const dns = await getDnsConfig();
  if (!dns?.apiToken)
    throw new Error(
      "No Cloudflare DNS token. Run `hatchkit config add dns`; the DKIM rows must be published for SES to verify the identity.",
    );
  const { CloudflareApi } = await import("../utils/cloudflare-api.js");
  const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });

  const result = await provisionSesSendingDomain(
    { projectDomain: manifest.domain, publishDns: true, cf, sesAuth },
    {
      onSesDomain: (e) => appendLedgerStep(manifest.name, { kind: "sesDomain", domain: e.domain }),
      onSesDns: (e) => {
        if (!e.createdRecords.length && !e.mergedSpf.length) return;
        appendLedgerStep(manifest.name, {
          kind: "sesDns",
          domainName: e.domainName,
          zoneId: e.zoneId,
          zoneName: e.zoneName,
          records: e.createdRecords,
          mergedSpf: e.mergedSpf,
        });
      },
      onSesMailFromConfigured: (e) => {
        for (const r of e.createdRecords)
          appendLedgerStep(manifest.name, {
            kind: "cloudflareDnsRecord",
            zoneId: e.zoneId,
            recordId: r.id,
            name: r.name,
            type: r.type,
          });
      },
    },
  );

  if (result.mailFrom) {
    const latest = readManifest(dir);
    patchManifest(dir, {
      ses: {
        ...(latest?.ses ?? {}),
        identity: result.mailFrom.identity,
        mailFromDomain: result.mailFrom.mailFromDomain,
        mailFromLabel: result.mailFrom.mailFromDomain.split(".")[0],
        mailFromBehaviorOnMxFailure: result.mailFrom.behaviorOnMxFailure,
        mailFromManagedDnsRecords: [
          {
            type: "MX",
            name: result.mailFrom.mailFromDomain,
            value: sesMailFromMxTarget(result.mailFrom.region),
            priority: 10,
          },
          { type: "TXT", name: result.mailFrom.mailFromDomain, value: SES_MAIL_FROM_SPF },
        ],
      },
    });
  } else {
    patchManifest(dir, { ses: { ...(readManifest(dir)?.ses ?? {}), identity: identityName } });
  }

  const created = result.dnsPublish?.createdRecords.length ?? 0;
  console.log(
    chalk.green(
      `\n  ✓ ${identityName}: ${result.ses.verifiedForSendingStatus ? "verified" : "pending verification"}; ${created} DKIM row(s) created.`,
    ),
  );
  if (result.mailFrom)
    console.log(
      chalk.green(
        `  ✓ MAIL FROM ${result.mailFrom.mailFromDomain} (status ${result.mailFrom.status ?? "unknown"})`,
      ),
    );
  if (!result.ses.verifiedForSendingStatus)
    console.log(
      chalk.yellow(
        "  SES verifies the identity once DNS propagates, usually within 30 minutes. Check with `hatchkit ses list domains` or this command's --dry-run.",
      ),
    );
  console.log(
    chalk.dim(
      `  Next: \`hatchkit ses isolate ${dir} --activate\` once verified. \`hatchkit destroy ${manifest.name}\` removes what this run created.`,
    ),
  );
}
