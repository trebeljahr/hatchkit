/*
 * Email setup orchestrator.
 *
 * Configures Cloudflare Email Routing end-to-end for one zone:
 *   1. Enable Email Routing on the zone (idempotent).
 *   2. Verify (or add) the destination address — the verification email
 *      lands in the user's inbox; they click the link before routing
 *      starts working. Skipping verify isn't an option — Cloudflare
 *      rejects forwards to unverified destinations.
 *   3. Upsert the receiving MX records (3 Cloudflare hosts).
 *   4. Upsert a single SPF TXT, merging Cloudflare's include with any
 *      pre-existing senders (e.g. Resend). One SPF record per zone is
 *      the RFC 7208 rule — multiple records cause PermError.
 *   5. Upsert a DMARC TXT at `_dmarc.<zone>`. Default `p=quarantine`
 *      with `sp=none` to avoid breaking subdomain senders.
 *   6. Create the forwarding rules — one per `<localPart>@<zone>` →
 *      destination. Idempotent: existing rules with matching matchers
 *      get their forward updated; otherwise we POST a new rule.
 *   7. Optionally set the catch-all (a single rule per zone, separate
 *      endpoint from the rule list).
 *
 * Caller surfaces results via the {@link EmailSetupResult} so the
 * create/adopt run-ledger can record each newly created resource for
 * later rollback.
 */

import chalk from "chalk";
import {
  type CfDnsRecord,
  type CfEmailDestination,
  CloudflareApi,
} from "../utils/cloudflare-api.js";
import { buildDmarcRecord, buildSpfRecord, parseSpfIncludes } from "./spf.js";

/** Cloudflare-published MX hosts for Email Routing. Verified against
 *  what `GET /zones/{id}/email/routing/dns` returns — kept hardcoded
 *  so a hatchkit run can describe the records up-front without an
 *  extra API call, and because the values have been stable since the
 *  Email Routing product launched. The API stays the source of truth
 *  in practice: the email module calls `getEmailRoutingDnsRecords()`
 *  and uses *those* values, falling back to this list only if CF is
 *  unreachable. */
export const CLOUDFLARE_EMAIL_ROUTING_MX = [
  { host: "route1.mx.cloudflare.net", priority: 1 },
  { host: "route2.mx.cloudflare.net", priority: 2 },
  { host: "route3.mx.cloudflare.net", priority: 3 },
];

export interface EmailSetupOptions {
  /** Bearer token with Zone:DNS:Edit + Zone:Email Routing Rules:Edit +
   *  Account:Email Routing Addresses:Edit. */
  token: string;
  /** Optional Cloudflare account id. Discovered from the zone when
   *  absent (since the destinations API is account-scoped, we always
   *  need one before the call). */
  accountId?: string;
  /** Mail domain. Can be a Cloudflare zone apex or a hostname below one. */
  domain: string;
  /** Email address that will receive forwarded mail. CF sends a
   *  verification email here on first add. */
  destination: string;
  /** Local parts to create forwarding rules for. Each becomes a
   *  `<localPart>@<domain>` literal-match rule forwarding to
   *  `destination`. Pass an empty list to skip individual rules
   *  (still useful with `catchAll: true`). */
  addresses: string[];
  /** Whether to set a catch-all rule (`*@domain` → destination). */
  catchAll: boolean;
  /** SPF includes to merge with Cloudflare's. Use this when the zone
   *  already sends via Resend / SES / etc. Pre-existing on-zone
   *  records are also auto-merged. */
  extraSpfIncludes?: string[];
  /** DMARC policy. Defaults to "quarantine". */
  dmarcPolicy?: "none" | "quarantine" | "reject";
  /** Aggregate-report destination for DMARC. Defaults to
   *  `dmarc@<domain>` (will be caught by the catch-all if enabled).
   *  Override when you want CF Email Routing's reports forwarded to
   *  a known inbox without relying on catch-all. */
  dmarcRua?: string;
}

/** Per-resource report returned by {@link runEmailSetup}. The caller
 *  feeds the ledger entries into `RunLedger.record()` for rollback. */
export interface EmailSetupResult {
  domain: string;
  zoneId: string;
  accountId: string;
  /** True when this run was the one that enabled routing on the zone. */
  routingEnabledThisRun: boolean;
  destination: {
    record: CfEmailDestination;
    /** True when this run created the destination (verification email
     *  was just sent). False when it already existed. */
    createdThisRun: boolean;
    /** "active" / "pending" — the user must click the verify link
     *  before forwards land. */
    verified: string | null;
  };
  /** DNS records the run created/updated. Each entry's `created` is
   *  true when this run added it (use for the rollback ledger). */
  dnsRecords: Array<{
    id: string;
    name: string;
    type: "MX" | "TXT";
    content: string;
    created: boolean;
    updated: boolean;
  }>;
  /** Per-address forwarding rules. */
  rules: Array<{
    address: string;
    id: string;
    created: boolean;
    updated: boolean;
  }>;
  /** Catch-all is a zone-level singleton — toggled, not "created" in
   *  the usual sense. `changed` is true when this run flipped its
   *  enabled state or forward destination. */
  catchAll?: { enabled: boolean; changed: boolean };
}

export async function runEmailSetup(opts: EmailSetupOptions): Promise<EmailSetupResult> {
  const cf = new CloudflareApi({ token: opts.token, accountId: opts.accountId });
  const zone = await cf.resolveZoneForName(opts.domain);
  if (!zone) {
    throw new Error(
      `No Cloudflare zone for "${opts.domain}" or its parent domains. Add the zone to your CF account and re-run.`,
    );
  }
  const accountId = opts.accountId ?? zone.account?.id;
  if (!accountId) {
    throw new Error(
      `Cloudflare account id could not be resolved for zone ${opts.domain}. Set it via \`hatchkit config add dns\` (advanced — leave blank only when the token spans one account).`,
    );
  }

  // Step 1 — enable routing on the zone. Idempotent; CF returns the
  // current settings on re-enable. We still record whether *this* call
  // flipped enabled=false → true so the rollback ledger doesn't yank
  // a routing setup the user enabled by hand earlier.
  const beforeRouting = await cf.getEmailRouting(zone.id);
  if (!beforeRouting?.enabled) {
    await cf.enableEmailRouting(zone.id);
  }
  const routingEnabledThisRun = !beforeRouting?.enabled;

  // Step 2 — destination address. CF sends a verification email if it
  // didn't already exist.
  const dest = await cf.addEmailDestination(accountId, opts.destination);

  // Step 3 — MX records. Fetch CF's recommended list first (in case the
  // hosts change), fall back to the constant if the call fails.
  let mxRecords = CLOUDFLARE_EMAIL_ROUTING_MX.map((m) => ({
    name: opts.domain,
    content: m.host,
    priority: m.priority,
  }));
  try {
    const recommended = await cf.getEmailRoutingDnsRecords(zone.id);
    const mx = recommended.filter((r) => r.type === "MX");
    if (mx.length > 0) {
      mxRecords = mx.map((r) => ({
        name: opts.domain,
        content: r.content,
        priority: r.priority ?? 10,
      }));
    }
  } catch {
    // Fall back to constants — see the comment on
    // CLOUDFLARE_EMAIL_ROUTING_MX. CF's list is authoritative; the
    // fallback keeps setup working if that one endpoint flakes.
  }

  const dnsRecords: EmailSetupResult["dnsRecords"] = [];
  for (const mx of mxRecords) {
    const res = await cf.upsertRecord(zone.id, {
      type: "MX",
      name: mx.name,
      content: mx.content,
      priority: mx.priority,
    });
    dnsRecords.push({
      id: res.id,
      name: mx.name,
      type: "MX",
      content: mx.content,
      created: res.created,
      updated: res.updated,
    });
  }

  // Step 4 — SPF. Merge Cloudflare's include with whatever's already on
  // the zone (Resend, SES, etc.) and any caller-supplied includes.
  const existingSpf = await findApexSpf(cf, zone.id, opts.domain);
  const mergedIncludes = new Set<string>(["_spf.mx.cloudflare.net"]);
  for (const inc of opts.extraSpfIncludes ?? []) mergedIncludes.add(inc);
  if (existingSpf) {
    for (const inc of parseSpfIncludes(existingSpf.content)) mergedIncludes.add(inc);
  }
  const spfContent = buildSpfRecord({ includes: [...mergedIncludes] });
  // Delete any *other* SPF TXT records first — exactly one SPF record
  // per zone per RFC 7208. The upsert below patches `existingSpf` in
  // place; stale duplicates (zone moved between providers, etc.) get
  // removed here.
  await deleteStaleSpfRecords(cf, zone.id, opts.domain, existingSpf?.id);
  const spfRes = await cf.upsertRecord(zone.id, {
    type: "TXT",
    name: opts.domain,
    content: spfContent,
  });
  dnsRecords.push({
    id: spfRes.id,
    name: opts.domain,
    type: "TXT",
    content: spfContent,
    created: spfRes.created,
    updated: spfRes.updated,
  });

  // Step 5 — DMARC.
  const dmarcName = `_dmarc.${opts.domain}`;
  const dmarcContent = buildDmarcRecord({
    rua: opts.dmarcRua ?? `dmarc@${opts.domain}`,
    policy: opts.dmarcPolicy ?? "quarantine",
  });
  const dmarcRes = await cf.upsertRecord(zone.id, {
    type: "TXT",
    name: dmarcName,
    content: dmarcContent,
  });
  dnsRecords.push({
    id: dmarcRes.id,
    name: dmarcName,
    type: "TXT",
    content: dmarcContent,
    created: dmarcRes.created,
    updated: dmarcRes.updated,
  });

  // Step 6 — per-address forwarding rules.
  const rules: EmailSetupResult["rules"] = [];
  for (const localPart of opts.addresses) {
    const address = `${localPart}@${opts.domain}`;
    const res = await cf.upsertEmailRoutingRule(zone.id, {
      address,
      forwardTo: [opts.destination],
      name: `Forward ${address}`,
    });
    rules.push({ address, id: res.id, created: res.created, updated: res.updated });
  }

  // Step 7 — catch-all (zone-level singleton). `changed` reflects the
  // catch-all rule itself — its `enabled` flag and forward destination —
  // not the zone-level Email Routing toggle (that's `routingEnabledThisRun`).
  let catchAll: EmailSetupResult["catchAll"];
  if (opts.catchAll) {
    const beforeRule = await cf.getEmailCatchAll(zone.id);
    const beforeEnabled = beforeRule?.enabled ?? false;
    const beforeForward = (beforeRule?.actions?.[0]?.value ?? []).join(",");
    const wantForward = [opts.destination].join(",");
    await cf.setEmailCatchAll(zone.id, {
      forwardTo: [opts.destination],
      enabled: true,
      name: "Catch-all",
    });
    catchAll = { enabled: true, changed: !beforeEnabled || beforeForward !== wantForward };
  }

  return {
    domain: opts.domain,
    zoneId: zone.id,
    accountId,
    routingEnabledThisRun,
    destination: {
      record: dest,
      createdThisRun: !dest.existed,
      verified: dest.verified ?? null,
    },
    dnsRecords,
    rules,
    catchAll,
  };
}

/** Find the apex SPF TXT record (one starting with `v=spf1`). Returns
 *  null when no SPF record exists yet. There MAY be other TXT records
 *  at the apex (verification tokens, etc.) — they're left alone. */
async function findApexSpf(
  cf: CloudflareApi,
  zoneId: string,
  domain: string,
): Promise<CfDnsRecord | null> {
  const all = await cf.findRecordsByName(zoneId, domain, "TXT");
  return all.find((r) => /^"?v=spf1\b/i.test(r.content)) ?? null;
}

/** Delete every *other* SPF TXT at the apex except the one we're about
 *  to upsert. Multiple SPF records cause receivers to PermError per
 *  RFC 7208, so a clean zone has exactly one. Skips the record we're
 *  keeping (identified by id). */
async function deleteStaleSpfRecords(
  cf: CloudflareApi,
  zoneId: string,
  domain: string,
  keepId: string | undefined,
): Promise<void> {
  const all = await cf.findRecordsByName(zoneId, domain, "TXT");
  for (const rec of all) {
    if (!/^"?v=spf1\b/i.test(rec.content)) continue;
    if (rec.id === keepId) continue;
    await cf.deleteRecord(zoneId, rec.id);
  }
}

/** Pretty-print the result for the CLI. Centralised here so both the
 *  standalone command and the create/adopt-flow hook print the same
 *  status block. */
export function printEmailSetupSummary(result: EmailSetupResult): void {
  console.log(chalk.bold(`\n  ── Email setup: ${result.domain} ──────────────────────────\n`));
  if (result.routingEnabledThisRun) {
    console.log(chalk.green("  ✓ Enabled Cloudflare Email Routing on zone"));
  } else {
    console.log(chalk.dim("  · Email Routing already enabled"));
  }

  const verifySuffix =
    result.destination.verified === "active"
      ? chalk.green(" (verified)")
      : chalk.yellow(" (pending — check inbox + click verify link)");
  if (result.destination.createdThisRun) {
    console.log(
      chalk.green(`  ✓ Added destination ${result.destination.record.email}`) + verifySuffix,
    );
  } else {
    console.log(
      chalk.dim(`  · Destination ${result.destination.record.email} already on account`) +
        verifySuffix,
    );
  }

  for (const rec of result.dnsRecords) {
    const tag = rec.created
      ? chalk.green("✓ created")
      : rec.updated
        ? chalk.yellow("· updated")
        : chalk.dim("· unchanged");
    console.log(`  ${tag} ${rec.type.padEnd(4)} ${rec.name}  →  ${truncate(rec.content, 60)}`);
  }

  for (const r of result.rules) {
    const tag = r.created
      ? chalk.green("✓ created")
      : r.updated
        ? chalk.yellow("· updated")
        : chalk.dim("· unchanged");
    console.log(`  ${tag} rule ${r.address}`);
  }

  if (result.catchAll) {
    const tag = result.catchAll.changed ? chalk.green("✓ enabled") : chalk.dim("· already enabled");
    console.log(`  ${tag} catch-all *@${result.domain}`);
  }

  if (result.destination.verified !== "active") {
    console.log(
      chalk.yellow(
        `\n  ! Forwards won't deliver until ${result.destination.record.email} clicks the Cloudflare verification email.`,
      ),
    );
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
