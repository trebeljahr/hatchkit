/*
 * Publish Resend's required DKIM + SPF DNS records into Cloudflare.
 *
 *   1. Fetch the domain (with its `records` array) from Resend.
 *   2. Resolve the closest Cloudflare zone for the domain name.
 *   3. Upsert every record (CNAME / TXT / MX). For TXT rows that look
 *      like SPF (`v=spf1` …) we merge with any existing SPF at the same
 *      name — the RFC 7208 rule is one SPF record per host, multiple
 *      records cause PermError.
 *   4. Optionally trigger Resend's verify endpoint so the domain status
 *      flips to `verified` without the user clicking around the dashboard.
 *
 * Skips records whose `status` already reports `verified`, since they
 * match in DNS by definition.
 */

import chalk from "chalk";
import { getDnsConfig } from "../config.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";
import { buildSpfRecord, parseSpfIncludes } from "../email/spf.js";
import {
  type ResendDnsRecord,
  type ResendDomain,
  getResendDomain,
  verifyResendDomain,
} from "./resend.js";

export interface PublishResendDnsResult {
  domain: ResendDomain;
  zoneName: string;
  created: number;
  updated: number;
  unchanged: number;
  skippedExtra: string[];
  /** Whether `verifyResendDomain` was called after the upsert pass. */
  verifyTriggered: boolean;
  /** Resend's reported domain status after the verify call (or the
   *  pre-existing status when verifyTriggered is false). */
  finalStatus: string;
}

export async function publishResendDnsToCloudflare(
  domainId: string,
  opts: { triggerVerify?: boolean } = {},
): Promise<PublishResendDnsResult> {
  const dns = await getDnsConfig();
  if (!dns?.apiToken) {
    throw new Error(
      "DNS config missing. Run `hatchkit config add dns` first (Cloudflare-only) so we can publish the Resend records automatically.",
    );
  }
  const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });

  const domain = await getResendDomain(domainId);
  const zone = await cf.resolveZoneForName(domain.name);
  if (!zone) {
    throw new Error(
      `No Cloudflare zone covers ${domain.name}. Add the parent zone to Cloudflare (and update registrar NS) before re-running.`,
    );
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const skippedExtra: string[] = [];

  for (const record of domain.records) {
    const fqdn = record.name; // Resend already returns the FQDN

    if (record.type === "CNAME") {
      const res = await cf.upsertRecord(zone.id, {
        type: "CNAME",
        name: fqdn,
        content: record.value,
        proxied: false,
      });
      tally(res);
      log(record, fqdn, res);
      continue;
    }

    if (record.type === "MX") {
      if (record.priority === undefined) {
        skippedExtra.push(`${fqdn} MX (no priority returned by Resend)`);
        continue;
      }
      const res = await cf.upsertRecord(zone.id, {
        type: "MX",
        name: fqdn,
        content: record.value,
        priority: record.priority,
      });
      tally(res);
      log(record, fqdn, res);
      continue;
    }

    if (record.type === "TXT") {
      const isSpf = /v=spf1/i.test(record.value);
      if (isSpf) {
        const merged = await mergeSpf(cf, zone.id, fqdn, record.value);
        const res = await cf.upsertRecord(zone.id, {
          type: "TXT",
          name: fqdn,
          content: merged,
        });
        tally(res);
        log(record, fqdn, res);
      } else {
        const res = await cf.upsertRecord(zone.id, {
          type: "TXT",
          name: fqdn,
          content: record.value,
        });
        tally(res);
        log(record, fqdn, res);
      }
      continue;
    }

    skippedExtra.push(`${fqdn} ${record.type} (unsupported record type)`);
  }

  let verifyTriggered = false;
  let finalStatus = domain.status;
  if (opts.triggerVerify && created + updated > 0) {
    const verify = await verifyResendDomain(domainId);
    verifyTriggered = true;
    finalStatus = verify.status;
  } else if (opts.triggerVerify) {
    // Already up to date — kick verify anyway, cheap and may transition
    // a stale `pending` status to `verified` if DNS now matches.
    const verify = await verifyResendDomain(domainId);
    verifyTriggered = true;
    finalStatus = verify.status;
  }

  return {
    domain,
    zoneName: zone.name,
    created,
    updated,
    unchanged,
    skippedExtra,
    verifyTriggered,
    finalStatus,
  };

  function tally(res: { created: boolean; updated: boolean }): void {
    if (res.created) created += 1;
    else if (res.updated) updated += 1;
    else unchanged += 1;
  }

  function log(
    record: ResendDnsRecord,
    fqdn: string,
    res: { created: boolean; updated: boolean },
  ): void {
    const verb = res.created ? chalk.green("+ created") : res.updated ? chalk.yellow("~ updated") : chalk.dim("· unchanged");
    const tag = record.record ? chalk.dim(`[${record.record}] `) : "";
    console.log(`  ${verb} ${tag}${record.type.padEnd(5)} ${fqdn}`);
  }
}

/** Merge Resend's SPF include into any pre-existing SPF TXT at the same
 *  name. Returns the SPF string to write (whether or not a record already
 *  exists). */
async function mergeSpf(
  cf: CloudflareApi,
  zoneId: string,
  fqdn: string,
  resendSpf: string,
): Promise<string> {
  // Pull existing SPF (if any) — there should be at most one per host.
  const existing = await cf.findRecordsByName(zoneId, fqdn, "TXT");
  const existingSpf = existing.find((r) => /^"?v=spf1/i.test(r.content));
  const resendIncludes = parseSpfIncludes(resendSpf);
  if (!existingSpf) {
    // First SPF on this host — write Resend's verbatim.
    return resendSpf;
  }
  const existingIncludes = parseSpfIncludes(existingSpf.content);
  const merged = Array.from(new Set([...existingIncludes, ...resendIncludes]));
  // Preserve the qualifier from the existing record when it's stricter
  // (-all) than the default; otherwise fall back to the SPF helper's
  // default (~all).
  const existingHasHardfail = /\s-all\b/i.test(existingSpf.content);
  return buildSpfRecord({
    includes: merged,
    qualifier: existingHasHardfail ? "-all" : "~all",
  });
}
