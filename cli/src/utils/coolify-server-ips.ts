/*
 * Discover the public IPv4 / IPv6 of a Coolify server.
 *
 * Used by both `hatchkit adopt` (direct REST DNS upserts) and
 * `hatchkit create` (Terraform tfvars) — the discovery rules are
 * identical across the two flows, so the logic lives here. Splitting
 * it out also makes the unit-of-truth obvious: any future tweak to
 * what counts as "the server's public IP" only has one site to edit.
 *
 * Background — why this is non-trivial:
 * Coolify's GET /servers returns `ip: "host.docker.internal"` on the
 * common Docker-on-the-same-box install. That string IS NOT a
 * routable IPv4 — it's the container-internal alias for the Docker
 * host. Pointing DNS A records at it (Cloudflare or otherwise) gets
 * rejected by the API. We have to look elsewhere for the real public
 * IP. Two sources are tried, in order, with a cross-check:
 *
 *   1. GET /servers/{uuid}/domains. For Docker-based Coolify this
 *      endpoint surfaces the configured public_ipv4 / public_ipv6
 *      (the values the operator entered when registering the
 *      "localhost" server). It's the box's self-reported truth.
 *   2. DNS resolution of the Coolify dashboard hostname. The user is
 *      reaching Coolify over the public internet, so the dashboard's
 *      A / AAAA records ARE necessarily the box's public IP. This
 *      catches setups where /servers/{uuid}/domains 404s (older
 *      Coolify) or the operator left public_ipv4 unset.
 *
 * When both sources give us an IPv4 and they disagree, we surface a
 * yellow warning (stale public_ipv4, misconfigured floating IP, proxy
 * in front of the wrong box, …) and proceed with Coolify's value.
 */

import { resolve4, resolve6 } from "node:dns/promises";
import chalk from "chalk";
import ora from "ora";
import type { CoolifyApi } from "./coolify-api.js";

/** True for valid public-routable IPv4 strings. Filters out the
 *  values Coolify hands back on Docker installs (`host.docker.internal`,
 *  `localhost`, `127.0.0.1`) plus IPv6, which we don't auto-manage. */
export function isPublicIpv4(s: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return false;
  const parts = s.split(".").map((n) => Number(n));
  if (parts.some((n) => n < 0 || n > 255)) return false;
  if (parts[0] === 127) return false; // loopback
  if (parts[0] === 0) return false;
  return true;
}

/** True for valid public-routable IPv6 strings. Filters loopback
 *  (::1) and link-local. Coarse — node:net.isIPv6 would be stricter
 *  but the obvious filters cover the practical cases. */
export function isPublicIpv6(s: string): boolean {
  if (!/^[0-9a-fA-F:]+$/.test(s) || !s.includes(":")) return false;
  if (s === "::" || s === "::1") return false;
  if (s.toLowerCase().startsWith("fe80:")) return false; // link-local
  return true;
}

export interface PublicIps {
  v4?: string;
  v6?: string;
  /** Set when Coolify's IPv4 and DNS-resolved IPv4 disagree — the user
   *  might have a stale public_ipv4 field, a misconfigured proxy, or
   *  a floating IP that's pointed elsewhere. We still proceed using
   *  Coolify's value (its self-reported truth), but flag it. */
  mismatchWarning?: string;
}

/** Resolve the box's public IPv4 + IPv6, preferring Coolify's
 *  configured values (via /servers/{uuid}/domains, which surfaces the
 *  instance's `public_ipv4` / `public_ipv6` for localhost-Coolify
 *  installs that report `host.docker.internal` on /servers), falling
 *  back to DNS resolution of the dashboard hostname. Cross-checks
 *  the two IPv4 sources and surfaces a warning when they disagree. */
export async function discoverPublicIps(
  api: CoolifyApi,
  serverUuid: string,
  fallbackServerIp: string,
  dashboardUrl: string,
): Promise<PublicIps> {
  // Step 1: Coolify-reported IPs. /servers/{uuid}/domains returns
  // entries with `ip` set per running domain; for localhost-Coolify
  // this falls back to the configured public_ipv4 / public_ipv6.
  let coolifyV4: string | undefined;
  let coolifyV6: string | undefined;
  try {
    const domains = await api.getServerDomains(serverUuid);
    for (const d of domains) {
      const ip = (d.ip ?? "").trim();
      if (!coolifyV4 && isPublicIpv4(ip)) coolifyV4 = ip;
      if (!coolifyV6 && isPublicIpv6(ip)) coolifyV6 = ip;
    }
  } catch {
    // /servers/{uuid}/domains can 404 / 501 on older Coolify builds.
    // Treat as "Coolify doesn't know" and fall back to DNS only.
  }
  // /servers itself may return a real IPv4 on non-Docker installs —
  // use it as a last-resort source.
  if (!coolifyV4 && isPublicIpv4(fallbackServerIp)) coolifyV4 = fallbackServerIp;
  if (!coolifyV6 && isPublicIpv6(fallbackServerIp)) coolifyV6 = fallbackServerIp;

  // Step 2: independent DNS resolution of the dashboard hostname.
  let host: string | undefined;
  try {
    host = new URL(dashboardUrl).hostname;
  } catch {
    /* ignore — dashboard URL might be malformed */
  }
  let dnsV4: string | undefined;
  let dnsV6: string | undefined;
  if (host && !isPublicIpv4(host)) {
    const spinner = ora(`Resolving ${host} for cross-check`).start();
    try {
      const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
      if (v4.status === "fulfilled" && v4.value[0] && isPublicIpv4(v4.value[0])) {
        dnsV4 = v4.value[0];
      }
      if (v6.status === "fulfilled" && v6.value[0] && isPublicIpv6(v6.value[0])) {
        dnsV6 = v6.value[0];
      }
      const parts = [dnsV4 && `A ${dnsV4}`, dnsV6 && `AAAA ${dnsV6}`].filter(Boolean);
      spinner.succeed(`DNS for ${host}: ${parts.length > 0 ? parts.join(", ") : "no records"}`);
    } catch {
      spinner.fail(`Couldn't resolve ${host}`);
    }
  } else if (host && isPublicIpv4(host)) {
    dnsV4 = host;
  }

  // Step 3: cross-check + decide. Prefer Coolify's value when we have
  // it (it's the box's self-reported truth); fall back to DNS.
  const v4 = coolifyV4 ?? dnsV4;
  const v6 = coolifyV6 ?? dnsV6;
  let mismatchWarning: string | undefined;
  if (coolifyV4 && dnsV4 && coolifyV4 !== dnsV4) {
    mismatchWarning = `Coolify reports public IPv4 ${coolifyV4} but ${host} resolves to ${dnsV4}. Using Coolify's value; double-check the DNS records and any floating-IP / proxy setup.`;
    console.log(chalk.yellow(`  ⚠ ${mismatchWarning}`));
  }
  return { v4, v6, mismatchWarning };
}
