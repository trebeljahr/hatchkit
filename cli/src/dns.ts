// `hatchkit dns` — standalone DNS helpers.
//
// `hatchkit dns link-to-cloudflare [domain...]`
//   Migration helper. For each domain (or all zones if none given),
//   look up the Cloudflare nameservers and push them to INWX as the
//   registrar-level delegation. Useful after importing zones into
//   Cloudflare when you don't want to click through INWX per-domain.
//   A freshly added zone is "pending" until exactly this push lands, so
//   pending zones are the main case; pending zones then get an
//   activation check queued so Cloudflare looks before its own backoff.
//
//   hatchkit dns link-to-cloudflare                   # all matching zones
//   hatchkit dns link-to-cloudflare fractal.garden    # just one
//   hatchkit dns link-to-cloudflare --dry-run ...     # print only
//   INWX_SANDBOX=1 hatchkit dns link-to-cloudflare ... # against OTE sandbox
//
// `hatchkit dns publish [--dry-run]`
//   Project-level reconciler. Reads .hatchkit.json (primary `domain` +
//   `aliases[]`), resolves the Coolify server's public IPv4/IPv6, and
//   upserts an A (and AAAA when available) record per hostname into
//   the covering Cloudflare zone — each hostname resolves its own zone,
//   so aliases on a different apex (e.g. a legacy domain) just work.
//   Complements `hatchkit sync`: sync teaches Coolify/Traefik about the
//   hostnames, publish makes the hostnames reach the box at all.

import chalk from "chalk";
import { getCoolifyConfig, getDnsConfig } from "./config.js";
import {
  type PublishDnsRecord,
  publishDnsRecordsToCloudflare,
} from "./provision/cloudflare-dns-publish.js";
import { manifestHostnames, readManifest } from "./scaffold/manifest.js";
import { CloudflareApi, type CloudflareZone } from "./utils/cloudflare-api.js";
import { CoolifyApi } from "./utils/coolify-api.js";
import { discoverPublicIps } from "./utils/coolify-server-ips.js";
import { InwxApi } from "./utils/inwx-api.js";

export interface DnsLinkOptions {
  /** Empty = all zones. */
  domains: string[];
  dryRun: boolean;
  /** Queue a Cloudflare activation check for each pending zone once the
   *  registrar lists its nameservers. Defaults to true. */
  activationCheck?: boolean;
}

/**
 * Why a zone's nameservers must NOT be pushed to the registrar, or null
 * when delegating is right. "pending" is the normal case, not an error:
 * Cloudflare keeps a new full-setup zone pending exactly until the
 * registrar delegates to its nameservers, which is what this command
 * does. Statuses per https://developers.cloudflare.com/dns/zone-setups/reference/domain-status/
 */
export function zoneSkipReason(zone: CloudflareZone): string | null {
  if (zone.type && zone.type !== "full") {
    return `zone type is "${zone.type}"; only full-setup zones are delegated by nameserver`;
  }
  switch (zone.status) {
    case "pending":
    case "active":
      break;
    case "initializing":
      return "setup is unfinished in Cloudflare (no plan picked), so it answers no DNS yet. Finish setup in the dashboard, then re-run";
    case "moved":
      return "the registry no longer lists Cloudflare's nameservers, and Cloudflare deletes the zone after 7 days. The move may be deliberate, so hatchkit does not undo it";
    case "deleted":
    case "purged":
      return `zone is ${zone.status}. Re-add the domain in Cloudflare (it gets a new nameserver pair), then re-run`;
    default:
      return `unknown zone status "${zone.status}"; not touching the registrar`;
  }
  if (zone.name_servers.length < 2) {
    return "Cloudflare has not assigned nameservers to this zone yet";
  }
  return null;
}

function normalizeNs(ns: string[]): string[] {
  return [...new Set(ns.map((n) => n.trim().toLowerCase().replace(/\.$/, "")))].sort();
}

/** Same nameserver set, ignoring case, order and a trailing dot. */
export function sameNameservers(a: string[], b: string[]): boolean {
  const x = normalizeNs(a);
  const y = normalizeNs(b);
  return x.length === y.length && x.every((n, i) => n === y[i]);
}

export type ZoneLinkOutcome = "delegated" | "would-delegate" | "unchanged" | "skipped" | "failed";

export interface ZoneLinkResult {
  zone: string;
  /** Cloudflare zone status at the time of the run. */
  status: string;
  outcome: ZoneLinkOutcome;
  /** Skip reason or error message. */
  detail?: string;
  /** Set when an activation check was attempted for a pending zone. */
  activationCheck?: "queued" | "failed";
}

export interface ZoneLinkDeps {
  /** Logged-in registrar client. Never called in dry-run. */
  registrar: Pick<InwxApi, "getDomainInfo" | "setDomainNameservers">;
  cf: Pick<CloudflareApi, "triggerActivationCheck">;
  dryRun: boolean;
  activationCheck: boolean;
  log?: (line: string) => void;
}

/** Point each zone's registrar delegation at its Cloudflare nameservers.
 *  Per-zone failures are reported in the result, never thrown. */
export async function linkZonesAtRegistrar(
  zones: CloudflareZone[],
  deps: ZoneLinkDeps,
): Promise<ZoneLinkResult[]> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const results: ZoneLinkResult[] = [];

  for (const zone of zones) {
    const ns = zone.name_servers;
    log(chalk.bold(`  ${zone.name}`));
    log(chalk.dim(`    zone_id:  ${zone.id}`));
    log(chalk.dim(`    status:   ${zone.status}`));
    log(chalk.dim(`    ns:       ${ns.join(", ")}`));

    const skip = zoneSkipReason(zone);
    if (skip) {
      log(chalk.yellow(`    ! skipped: ${skip}`));
      results.push({ zone: zone.name, status: zone.status, outcome: "skipped", detail: skip });
      continue;
    }

    if (deps.dryRun) {
      log(chalk.dim("    would set the INWX nameservers to the ones above if they differ"));
      results.push({ zone: zone.name, status: zone.status, outcome: "would-delegate" });
      continue;
    }

    const result: ZoneLinkResult = { zone: zone.name, status: zone.status, outcome: "unchanged" };
    try {
      // Compare first: an already-delegated domain needs no write, and
      // "updated" would be a misleading log line.
      const current = await deps.registrar.getDomainInfo(zone.name);
      if (sameNameservers(current.ns, ns)) {
        log(chalk.dim("    INWX already lists these nameservers, unchanged"));
      } else {
        await deps.registrar.setDomainNameservers(zone.name, ns);
        log(chalk.green(`    ✓ delegated at INWX (was: ${current.ns.join(", ") || "none"})`));
        result.outcome = "delegated";
      }
    } catch (error) {
      log(chalk.red(`    ✗ failed: ${(error as Error).message}`));
      results.push({
        zone: zone.name,
        status: zone.status,
        outcome: "failed",
        detail: (error as Error).message,
      });
      continue;
    }

    // The registrar now delegates to Cloudflare, but a pending zone only
    // flips once Cloudflare's own check sees that, on a backoff schedule.
    if (zone.status === "pending" && deps.activationCheck) {
      try {
        await deps.cf.triggerActivationCheck(zone.id);
        log(chalk.dim("    queued a Cloudflare activation check"));
        result.activationCheck = "queued";
      } catch (error) {
        log(chalk.dim(`    activation check not queued: ${(error as Error).message}`));
        log(chalk.dim("    Cloudflare re-checks on its own; the dashboard can force one."));
        result.activationCheck = "failed";
      }
    }
    results.push(result);
  }
  return results;
}

export async function runDnsLinkToCloudflare(options: DnsLinkOptions): Promise<void> {
  const dns = await getDnsConfig();

  if (!dns) {
    throw new Error("No DNS config found. Run `hatchkit config add dns` first (Cloudflare-only).");
  }
  if (!dns.apiToken) {
    throw new Error("Cloudflare API token is missing from the keychain.");
  }
  if (!dns.registrarUsername || !dns.registrarPassword) {
    throw new Error(
      "INWX registrar credentials are not configured. Re-run `hatchkit config add dns` and answer yes when asked about INWX as registrar.",
    );
  }

  const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });

  console.log(chalk.bold("\n  ── Verifying Cloudflare token ─────────────────────────\n"));
  const status = await cf.verifyToken();
  if (status !== "active") {
    throw new Error(`Cloudflare token status is "${status}", expected "active".`);
  }
  console.log(chalk.green("  ✓ Token active"));

  console.log(chalk.bold("\n  ── Listing Cloudflare zones ───────────────────────────\n"));
  const allZones = await cf.listZones();
  console.log(chalk.dim(`  Found ${allZones.length} zone(s) in Cloudflare`));

  // Filter to the requested domains, or all zones if none were given.
  let zones: CloudflareZone[];
  if (options.domains.length > 0) {
    const wanted = new Set(options.domains);
    zones = allZones.filter((z) => wanted.has(z.name));
    const missing = [...wanted].filter((d) => !zones.find((z) => z.name === d));
    if (missing.length > 0) {
      console.log(chalk.yellow(`  ! Not found in Cloudflare: ${missing.join(", ")}`));
    }
  } else {
    zones = allZones;
  }

  if (zones.length === 0) {
    console.log(chalk.yellow("\n  Nothing to do."));
    return;
  }

  console.log(chalk.bold(`\n  ── Updating INWX delegation for ${zones.length} domain(s) ────\n`));

  const inwx = new InwxApi({
    username: dns.registrarUsername,
    password: dns.registrarPassword,
    sandbox: process.env.INWX_SANDBOX === "1",
    totpSecret: dns.registrarTotpSecret,
  });

  if (options.dryRun) {
    console.log(chalk.yellow("  [dry-run: INWX is not contacted, no changes will be made]\n"));
  } else {
    await inwx.login();
  }

  let results: ZoneLinkResult[];
  try {
    results = await linkZonesAtRegistrar(zones, {
      registrar: inwx,
      cf,
      dryRun: options.dryRun,
      activationCheck: options.activationCheck ?? true,
    });
  } finally {
    if (!options.dryRun) {
      await inwx.logout().catch(() => {});
    }
  }

  const count = (outcome: ZoneLinkOutcome) => results.filter((r) => r.outcome === outcome).length;
  const updated = count(options.dryRun ? "would-delegate" : "delegated");
  const unchanged = count("unchanged");
  const skipped = count("skipped");
  const failures = count("failed");
  const awaitingActivation = results.filter(
    (r) => r.status === "pending" && (r.outcome === "delegated" || r.outcome === "unchanged"),
  ).length;

  console.log(chalk.bold("\n  ── Summary ──────────────────────────────────────────────\n"));
  const label = (s: string) => `  ${`${s}:`.padEnd(14)}`;
  console.log(`${label(options.dryRun ? "Would update" : "Updated")}${chalk.green(updated)}`);
  console.log(`${label("Unchanged")}${chalk.dim(unchanged)}`);
  console.log(`${label("Skipped")}${skipped > 0 ? chalk.yellow(skipped) : chalk.dim(skipped)}`);
  console.log(`${label("Failed")}${failures > 0 ? chalk.red(failures) : chalk.dim(failures)}`);
  if (!options.dryRun && (updated > 0 || awaitingActivation > 0)) {
    console.log(
      chalk.dim(
        "\n  The registry can take a few minutes to a few hours to serve the new nameservers." +
          "\n  Cloudflare turns a pending zone active once it sees them.",
      ),
    );
  }
  if (failures > 0) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// `hatchkit dns publish` — point every manifest hostname at the Coolify box
// ---------------------------------------------------------------------------

export interface DnsPublishOptions {
  /** Project root containing `.hatchkit.json`. */
  projectDir: string;
  /** Classify against Cloudflare (read-only) but never write. */
  dryRun: boolean;
  /** Coolify server name or uuid to take the public IP from. Only
   *  needed when more than one server is registered. */
  server?: string;
}

export async function runDnsPublish(options: DnsPublishOptions): Promise<void> {
  const manifest = readManifest(options.projectDir);
  if (!manifest) {
    throw new Error(
      `No .hatchkit.json found in ${options.projectDir}. ` +
        "Run from a hatchkit project root (or `hatchkit adopt` first).",
    );
  }
  const hostnames = manifestHostnames(manifest);

  const dns = await getDnsConfig();
  if (!dns) {
    throw new Error("No DNS config found. Run `hatchkit config add dns` first (Cloudflare-only).");
  }
  if (!dns.apiToken) {
    throw new Error("Cloudflare API token is missing from the keychain.");
  }
  const cf = new CloudflareApi({ token: dns.apiToken, accountId: dns.accountId });

  const coolify = await getCoolifyConfig();
  if (!coolify) {
    throw new Error("Coolify is not configured. Run `hatchkit config add coolify` first.");
  }
  const api = new CoolifyApi({ url: coolify.url, token: coolify.token });

  // ── Resolve the box whose IP the records should point at. ──────────
  const servers = await api.listServers();
  if (servers.length === 0) {
    throw new Error("Coolify reports no servers — register one before publishing DNS.");
  }
  let server = servers[0] as (typeof servers)[number];
  if (options.server) {
    const match = servers.find((s) => s.uuid === options.server || s.name === options.server);
    if (!match) {
      throw new Error(
        `No Coolify server named "${options.server}". Known: ${servers.map((s) => s.name).join(", ")}.`,
      );
    }
    server = match;
  } else if (servers.length > 1) {
    if (!process.stdin.isTTY) {
      throw new Error(
        `Multiple Coolify servers — pass --server <name|uuid>. Known: ${servers.map((s) => s.name).join(", ")}.`,
      );
    }
    const { select } = await import("@inquirer/prompts");
    server = await select({
      message: "Which server should the DNS records point at?",
      choices: servers.map((s) => ({ name: `${s.name} (${s.ip})`, value: s })),
    });
  }

  // A missing uuid (older Coolify builds) just skips the
  // /servers/{uuid}/domains lookup inside discoverPublicIps (the 404 is
  // caught) and falls back to the /servers ip field.
  const ips = await discoverPublicIps(api, server.uuid ?? "", server.ip);
  if (!ips.v4 && !ips.v6) {
    throw new Error(
      `Coolify reports no public IPv4/IPv6 for server "${server.name}". ` +
        "Fix the server's IP in the Coolify dashboard, then re-run.",
    );
  }

  console.log(chalk.bold(`\n  ── DNS records for ${manifest.name} ───────────────────────\n`));
  console.log(
    chalk.dim(`  server: ${server.name}  ipv4: ${ips.v4 ?? "—"}  ipv6: ${ips.v6 ?? "—"}`),
  );
  if (options.dryRun) {
    console.log(chalk.yellow("  [dry-run: no changes will be made]"));
  }
  console.log("");

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const failed: string[] = [];

  // One publish call per hostname: each resolves its own covering zone,
  // so aliases living under a different apex (legacy domains) work
  // without any single-zone assumption.
  for (const host of hostnames) {
    const records: PublishDnsRecord[] = [];
    if (ips.v4) records.push({ type: "A", name: host, value: ips.v4, proxied: true });
    if (ips.v6) records.push({ type: "AAAA", name: host, value: ips.v6, proxied: true });
    try {
      const res = await publishDnsRecordsToCloudflare(records, {
        cf,
        domain: host,
        dryRun: options.dryRun,
      });
      created += res.created;
      updated += res.updated;
      unchanged += res.unchanged;
    } catch (err) {
      failed.push(`${host}: ${(err as Error).message}`);
      console.log(chalk.red(`  ✗ ${host} — ${(err as Error).message}`));
    }
  }

  console.log(chalk.bold("\n  ── Summary ──────────────────────────────────────────────\n"));
  const verb = options.dryRun ? "Would create" : "Created";
  const verbU = options.dryRun ? "Would update" : "Updated";
  console.log(`  ${verb}:   ${created > 0 ? chalk.green(created) : chalk.dim(created)}`);
  console.log(`  ${verbU}:   ${updated > 0 ? chalk.yellow(updated) : chalk.dim(updated)}`);
  console.log(`  Unchanged: ${chalk.dim(unchanged)}`);
  if (failed.length > 0) {
    console.log(`  Failed:    ${chalk.red(failed.length)}`);
  }
  if (!options.dryRun && (created > 0 || updated > 0)) {
    console.log(
      chalk.dim(
        "\n  Run `hatchkit sync` so Coolify/Traefik routes the hostnames too;\n" +
          "  verify propagation with: dig +short <hostname>",
      ),
    );
  }
  if (failed.length > 0) {
    process.exit(1);
  }
}
