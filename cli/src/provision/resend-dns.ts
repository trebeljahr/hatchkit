/*
 * Resend's DKIM-publish flow, on top of the shared
 * `publishDnsRecordsToCloudflare` helper.
 *
 * Resend-specific bits this module still owns:
 *   1. Fetching the domain (with its `records` array) from Resend.
 *   2. Mapping Resend's record shape (`name` is already FQDN; `record`
 *      is a hint like "DKIM"/"SPF") into the generic `PublishDnsRecord`.
 *   3. Optionally triggering Resend's verify endpoint after the upsert
 *      pass so the domain status flips to `verified` without a
 *      dashboard click.
 *
 * Everything else — zone resolution, per-record upsert, SPF merge,
 * created/merged tracking — lives in cloudflare-dns-publish.ts so the
 * SES flow can reuse the same plumbing.
 */

import { getDnsConfig } from "../config.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";
import {
  type CreatedDnsRecord,
  type PublishDnsRecord,
  publishDnsRecordsToCloudflare,
} from "./cloudflare-dns-publish.js";
import { type ResendDomain, getResendDomain, verifyResendDomain } from "./resend.js";

// Re-export `CreatedDnsRecord` so existing imports through this module
// (the run-ledger code path, callers in provision/index.ts) keep
// working without touching every call site.
export type { CreatedDnsRecord };

export interface PublishResendDnsResult {
  domain: ResendDomain;
  zoneId: string;
  zoneName: string;
  created: number;
  updated: number;
  unchanged: number;
  skippedExtra: string[];
  createdRecords: CreatedDnsRecord[];
  mergedSpf: Array<{ name: string }>;
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

  const records: PublishDnsRecord[] = domain.records.map((r) => ({
    type: r.type,
    name: r.name,
    value: r.value,
    priority: r.priority,
    status: r.status,
    label: r.record,
    ttl: r.ttl,
  }));

  const result = await publishDnsRecordsToCloudflare(records, {
    cf,
    domain: domain.name,
  });

  let verifyTriggered = false;
  let finalStatus = domain.status;
  if (opts.triggerVerify) {
    // Trigger verify unconditionally when requested — cheap, and may
    // transition a stale `pending` status to `verified` even when the
    // current run had no writes (e.g. DNS finally propagated since
    // the last attempt).
    const verify = await verifyResendDomain(domainId);
    verifyTriggered = true;
    finalStatus = verify.status;
  }

  return {
    domain,
    zoneId: result.zoneId,
    zoneName: result.zoneName,
    created: result.created,
    updated: result.updated,
    unchanged: result.unchanged,
    skippedExtra: result.skippedExtra,
    createdRecords: result.createdRecords,
    mergedSpf: result.mergedSpf,
    verifyTriggered,
    finalStatus,
  };
}
