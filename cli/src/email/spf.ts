/*
 * SPF + DMARC TXT-record helpers.
 *
 * SPF rules-of-the-road that make this small but important:
 *
 *   1. **One SPF TXT per domain.** RFC 7208 §3.2 — multiple records
 *      cause receivers to PermError. So if Resend's records already
 *      include `v=spf1 …` and Cloudflare Email Routing wants its own
 *      `v=spf1 …`, they MUST be merged into ONE record, not added as
 *      siblings.
 *
 *   2. **Maximum 10 DNS lookups inside the SPF chain.** Each `include:`
 *      counts as one lookup. Cloudflare Email Routing's
 *      `_spf.mx.cloudflare.net` and (e.g.) Resend's
 *      `_spf.resend.com` each cost one — well under the cap, but worth
 *      knowing if a user later piles on more senders.
 *
 *   3. **Order of `include:` mechanisms does NOT matter for the verdict,
 *      but a stable order makes hatchkit's idempotent upserts a no-op
 *      on re-run.** We sort the includes alphabetically before joining.
 *
 *   4. **Qualifier (`~all` vs `-all`):** we default to `~all` (softfail)
 *      — recipients see a soft signal that mail from unauthorised IPs
 *      is suspicious but they still accept it. This pairs well with
 *      DMARC at `p=quarantine`, which makes the final disposition call
 *      via alignment rather than SPF-fail-alone. Upgrade to `-all`
 *      (hardfail) once you're confident no legitimate sender is missing
 *      from the include list.
 */

const CLOUDFLARE_EMAIL_ROUTING_SPF_INCLUDE = "_spf.mx.cloudflare.net";

/** Common SPF includes for popular senders. The Resend value is the
 *  one their dashboard tells you to add; AWS SES users would substitute
 *  `amazonses.com` etc. Hatchkit auto-includes Cloudflare's host; other
 *  senders come from configuration. */
export const SPF_INCLUDES = {
  cloudflareEmailRouting: CLOUDFLARE_EMAIL_ROUTING_SPF_INCLUDE,
  resend: "_spf.resend.com",
  amazonSes: "amazonses.com",
  google: "_spf.google.com",
} as const;

export type SpfQualifier = "~all" | "-all" | "?all" | "+all";

/** Build a single SPF TXT record content string. Sorts includes for
 *  deterministic output (matters for idempotent upserts: same input =
 *  same record content = no PATCH on re-run). */
export function buildSpfRecord(opts: {
  /** Hostnames to wrap as `include:<host>`. Order-insensitive. */
  includes: string[];
  /** Optional `ip4:` / `ip6:` mechanisms. */
  ip4?: string[];
  ip6?: string[];
  /** Default `~all` — see file header. */
  qualifier?: SpfQualifier;
}): string {
  const includes = [...new Set(opts.includes)].sort();
  const ip4 = opts.ip4 ? [...new Set(opts.ip4)].sort() : [];
  const ip6 = opts.ip6 ? [...new Set(opts.ip6)].sort() : [];
  const parts = ["v=spf1"];
  for (const i of ip4) parts.push(`ip4:${i}`);
  for (const i of ip6) parts.push(`ip6:${i}`);
  for (const inc of includes) parts.push(`include:${inc}`);
  parts.push(opts.qualifier ?? "~all");
  return parts.join(" ");
}

/** Parse the includes out of an existing SPF record so we can union
 *  them with new ones (e.g. when adding Cloudflare to a zone that
 *  already has Resend). Lenient: returns an empty list for malformed
 *  input rather than throwing — the caller can decide whether to
 *  overwrite or surface the parse failure. */
export function parseSpfIncludes(record: string): string[] {
  const trimmed = record.trim().replace(/^"|"$/g, "").trim();
  if (!/^v=spf1\b/i.test(trimmed)) return [];
  const includes: string[] = [];
  for (const part of trimmed.split(/\s+/)) {
    const m = part.match(/^include:(.+)$/i);
    if (m) includes.push(m[1].toLowerCase());
  }
  return includes;
}

/** Build a DMARC TXT record content string.
 *
 *  Default policy is `p=quarantine` — failed-DMARC mail lands in spam
 *  rather than the inbox. `sp=none` deliberately exempts subdomains
 *  (e.g. `staging.<domain>`) because they often send via third-party
 *  services not aligned with the apex. `rua` is the aggregate-report
 *  destination — same address as the forwarding inbox by default, so
 *  the operator gets weekly delivery summaries.
 *
 *  Tweaks (call sites can override):
 *   · `policy: "none"` — observe-only, no enforcement. Use during
 *     a soft rollout when you're not sure every legit sender is
 *     aligned yet.
 *   · `subdomainPolicy: "quarantine"` — extend enforcement to
 *     subdomains. Only safe once those subdomains' senders are known. */
export function buildDmarcRecord(opts: {
  rua: string;
  policy?: "none" | "quarantine" | "reject";
  subdomainPolicy?: "none" | "quarantine" | "reject";
  /** Percentage of mail subject to policy (0-100). Default 100. Drop
   *  to e.g. 20 during a soft rollout. */
  percent?: number;
  /** SPF/DKIM alignment mode — strict ("s") or relaxed ("r"). */
  alignmentSpf?: "s" | "r";
  alignmentDkim?: "s" | "r";
}): string {
  const parts: string[] = [
    "v=DMARC1",
    `p=${opts.policy ?? "quarantine"}`,
    `sp=${opts.subdomainPolicy ?? "none"}`,
    `rua=mailto:${opts.rua}`,
    `pct=${opts.percent ?? 100}`,
    `adkim=${opts.alignmentDkim ?? "r"}`,
    `aspf=${opts.alignmentSpf ?? "r"}`,
  ];
  return parts.join("; ");
}
