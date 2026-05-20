/*
 * Generic DNS-record-publish helper for Cloudflare.
 *
 * Used by both the Resend DKIM-publish flow and the SES DKIM-publish
 * flow (and any future provider that hands hatchkit a list of records
 * to add). Owns:
 *
 *   1. Per-record upsert (CNAME / TXT / MX) against the resolved zone.
 *   2. SPF merge for TXT records whose value starts with `v=spf1` —
 *      RFC 7208 forbids multiple SPF records at one host, so combining
 *      includes is the only safe write.
 *   3. Tracking the per-record handles for everything THIS run
 *      *created* (skipping updates + unchanged + merged-into rows), so
 *      a later auto-rollback can DELETE only what we introduced.
 *   4. Tracking SPF rows we merged into pre-existing records, so the
 *      rollback path can flag them for the operator instead of yanking
 *      unrelated includes the user owns.
 *
 * Caller-agnostic: the records are typed as a thin DTO and the caller
 * supplies its own log prefix tag so a Resend run still reads
 * "[DKIM]"/"[SPF]" the way it always did.
 */

import chalk from "chalk";
import { buildSpfRecord, parseSpfIncludes } from "../email/spf.js";
import type { CloudflareApi } from "../utils/cloudflare-api.js";

export interface PublishDnsRecord {
  type: "TXT" | "MX" | "CNAME";
  /** Fully-qualified record name — callers must resolve to FQDN
   *  themselves (Resend's API already does; SES needs the caller to
   *  build `<token>._domainkey.<domain>`). */
  name: string;
  value: string;
  /** Required when type === "MX". Records missing one are recorded in
   *  `skippedExtra` rather than written. */
  priority?: number;
  /** Provider-reported status, e.g. "verified" / "pending". Currently
   *  informational — we don't skip on it, since Cloudflare's view of
   *  the record is what actually matters at the moment of write. */
  status?: string;
  /** Short tag for the per-record log line, e.g. "DKIM" / "SPF". */
  label?: string;
  ttl?: string | number;
}

export interface CreatedDnsRecord {
  /** Cloudflare record id — what DELETE /zones/:zone/dns_records/:id needs. */
  id: string;
  name: string;
  type: "TXT" | "MX" | "CNAME";
}

export interface PublishDnsRecordsResult {
  zoneId: string;
  zoneName: string;
  created: number;
  updated: number;
  unchanged: number;
  /** Records the helper refused to write (e.g. MX missing priority,
   *  unsupported types). Surfaced for human follow-up. */
  skippedExtra: string[];
  /** Per-record handles for everything THIS run CREATED. Excludes
   *  updates and unchanged rows so a later rollback only removes
   *  records hatchkit introduced. */
  createdRecords: CreatedDnsRecord[];
  /** TXT rows where we merged into a pre-existing record. Auto-rollback
   *  can't safely un-merge (we don't snapshot the original includes), so
   *  the rollback surface flags these for the operator. */
  mergedSpf: Array<{ name: string }>;
}

export interface PublishDnsRecordsOptions {
  cf: CloudflareApi;
  /** The base domain — used to resolve the closest CF zone. SES + Resend
   *  both want the project's sending domain here (e.g. `mail.example.com`
   *  resolves to the `example.com` zone if that's the apex). */
  domain: string;
  /** Optional log prefix shown next to each `+ created` / `~ updated` /
   *  `· unchanged` line. Defaults to nothing. */
  logTag?: string;
}

/**
 * Upsert `records` into the appropriate Cloudflare zone for
 * `opts.domain`. Throws if no zone covers the domain. Returns counts +
 * the per-record handles needed for a clean rollback later.
 */
export async function publishDnsRecordsToCloudflare(
  records: PublishDnsRecord[],
  opts: PublishDnsRecordsOptions,
): Promise<PublishDnsRecordsResult> {
  const zone = await opts.cf.resolveZoneForName(opts.domain);
  if (!zone) {
    throw new Error(
      `No Cloudflare zone covers ${opts.domain}. Add the parent zone to Cloudflare (and update registrar NS) before re-running.`,
    );
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const skippedExtra: string[] = [];
  const createdRecords: CreatedDnsRecord[] = [];
  const mergedSpf: Array<{ name: string }> = [];

  for (const record of records) {
    const fqdn = record.name;

    if (record.type === "CNAME") {
      const res = await opts.cf.upsertRecord(zone.id, {
        type: "CNAME",
        name: fqdn,
        content: record.value,
        proxied: false,
      });
      tally(res);
      if (res.created) createdRecords.push({ id: res.id, name: fqdn, type: "CNAME" });
      log(record, fqdn, res);
      continue;
    }

    if (record.type === "MX") {
      if (record.priority === undefined) {
        skippedExtra.push(`${fqdn} MX (no priority)`);
        continue;
      }
      const res = await opts.cf.upsertRecord(zone.id, {
        type: "MX",
        name: fqdn,
        content: record.value,
        priority: record.priority,
      });
      tally(res);
      if (res.created) createdRecords.push({ id: res.id, name: fqdn, type: "MX" });
      log(record, fqdn, res);
      continue;
    }

    if (record.type === "TXT") {
      const isSpf = /v=spf1/i.test(record.value);
      if (isSpf) {
        const { merged, sourceWasExisting } = await mergeSpf(opts.cf, zone.id, fqdn, record.value);
        const res = await opts.cf.upsertRecord(zone.id, {
          type: "TXT",
          name: fqdn,
          content: merged,
        });
        tally(res);
        if (res.created) {
          createdRecords.push({ id: res.id, name: fqdn, type: "TXT" });
        } else if (sourceWasExisting && res.updated) {
          // We touched a pre-existing SPF record — auto-rollback must
          // NOT delete it (would yank the user's other includes).
          mergedSpf.push({ name: fqdn });
        }
        log(record, fqdn, res);
      } else {
        const res = await opts.cf.upsertRecord(zone.id, {
          type: "TXT",
          name: fqdn,
          content: record.value,
        });
        tally(res);
        if (res.created) createdRecords.push({ id: res.id, name: fqdn, type: "TXT" });
        log(record, fqdn, res);
      }
      continue;
    }

    skippedExtra.push(`${fqdn} ${record.type} (unsupported)`);
  }

  return {
    zoneId: zone.id,
    zoneName: zone.name,
    created,
    updated,
    unchanged,
    skippedExtra,
    createdRecords,
    mergedSpf,
  };

  function tally(res: { created: boolean; updated: boolean }): void {
    if (res.created) created += 1;
    else if (res.updated) updated += 1;
    else unchanged += 1;
  }

  function log(
    record: PublishDnsRecord,
    fqdn: string,
    res: { created: boolean; updated: boolean },
  ): void {
    const verb = res.created
      ? chalk.green("+ created")
      : res.updated
        ? chalk.yellow("~ updated")
        : chalk.dim("· unchanged");
    const tag = record.label ?? opts.logTag;
    const tagStr = tag ? chalk.dim(`[${tag}] `) : "";
    console.log(`  ${verb} ${tagStr}${record.type.padEnd(5)} ${fqdn}`);
  }
}

/** Merge a provider's SPF include into any pre-existing SPF TXT at the
 *  same name. Returns the SPF string to write plus a flag indicating
 *  whether we touched a pre-existing record (so the caller can decide
 *  rollback policy — auto-delete is safe only for records hatchkit
 *  introduced).
 *
 *  Exported for callers that want to pre-flight an SPF merge without
 *  actually writing — kept on the shared module so the SPF logic has
 *  exactly one home. */
export async function mergeSpf(
  cf: CloudflareApi,
  zoneId: string,
  fqdn: string,
  providerSpf: string,
): Promise<{ merged: string; sourceWasExisting: boolean }> {
  const existing = await cf.findRecordsByName(zoneId, fqdn, "TXT");
  const existingSpf = existing.find((r) => /^"?v=spf1/i.test(r.content));
  const providerIncludes = parseSpfIncludes(providerSpf);
  if (!existingSpf) {
    return { merged: providerSpf, sourceWasExisting: false };
  }
  const existingIncludes = parseSpfIncludes(existingSpf.content);
  const merged = Array.from(new Set([...existingIncludes, ...providerIncludes]));
  const existingHasHardfail = /\s-all\b/i.test(existingSpf.content);
  return {
    merged: buildSpfRecord({
      includes: merged,
      qualifier: existingHasHardfail ? "-all" : "~all",
    }),
    sourceWasExisting: true,
  };
}
