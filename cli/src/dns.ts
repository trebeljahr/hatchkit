// `hatchkit dns link-to-cloudflare [domain...]`
//
// Standalone migration helper. For each domain (or all zones if none
// given), look up the Cloudflare nameservers and push them to INWX as
// the registrar-level delegation. Useful after importing zones into
// Cloudflare when you don't want to click through INWX per-domain.
//
// Usage:
//   hatchkit dns link-to-cloudflare                   # all matching zones
//   hatchkit dns link-to-cloudflare fractal.garden    # just one
//   hatchkit dns link-to-cloudflare --dry-run ...     # print only
//   INWX_SANDBOX=1 hatchkit dns link-to-cloudflare ... # against OTE sandbox

import chalk from "chalk";
import { getDnsConfig } from "./config.js";
import { CloudflareApi, type CloudflareZone } from "./utils/cloudflare-api.js";
import { InwxApi } from "./utils/inwx-api.js";

export interface DnsLinkOptions {
  /** Empty = all zones. */
  domains: string[];
  dryRun: boolean;
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
  });

  if (options.dryRun) {
    console.log(chalk.yellow("  [dry-run: no changes will be made]\n"));
  } else {
    await inwx.login();
  }

  let successes = 0;
  let failures = 0;
  let skipped = 0;

  try {
    for (const zone of zones) {
      const ns = zone.name_servers;
      console.log(chalk.bold(`  ${zone.name}`));
      console.log(chalk.dim(`    zone_id:  ${zone.id}`));
      console.log(chalk.dim(`    ns:       ${ns.join(", ")}`));

      if (zone.status !== "active") {
        console.log(
          chalk.yellow(`    ! Zone status is "${zone.status}", skipping (activate it in CF first)`),
        );
        skipped += 1;
        continue;
      }

      if (options.dryRun) {
        console.log(chalk.dim("    would call domain.update { ns: [...] }"));
        continue;
      }

      try {
        // Skip if INWX already has the right NS — saves a write and
        // avoids logging a misleading "updated" message.
        const current = await inwx.getDomainInfo(zone.name);
        const wantNs = ns.map((n) => n.toLowerCase());
        const haveNs = current.ns.map((n) => n.toLowerCase());
        const same = haveNs.length === wantNs.length && haveNs.every((n) => wantNs.includes(n));
        if (same) {
          console.log(chalk.dim("    already matches — no change"));
          skipped += 1;
          continue;
        }

        await inwx.setDomainNameservers(zone.name, ns);
        console.log(chalk.green("    ✓ updated at INWX"));
        successes += 1;
      } catch (error) {
        console.log(chalk.red(`    ✗ failed: ${(error as Error).message}`));
        failures += 1;
      }
    }
  } finally {
    if (!options.dryRun) {
      await inwx.logout().catch(() => {});
    }
  }

  console.log(chalk.bold("\n  ── Summary ──────────────────────────────────────────────\n"));
  console.log(`  Updated: ${chalk.green(successes)}`);
  console.log(`  Skipped: ${chalk.dim(skipped)}`);
  console.log(`  Failed:  ${failures > 0 ? chalk.red(failures) : chalk.dim(failures)}`);
  if (!options.dryRun && successes > 0) {
    console.log(chalk.dim("\n  TLD propagation can take 5 min to a few hours."));
  }
  if (failures > 0) {
    process.exit(1);
  }
}
