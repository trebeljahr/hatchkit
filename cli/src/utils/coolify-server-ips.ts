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
 * rejected by the API. So we ask /servers/{uuid}/domains, which
 * surfaces the configured public_ipv4 / public_ipv6 (the values the
 * operator entered when registering the "localhost" server). On
 * non-Docker installs /servers itself already returns a real IPv4,
 * so we fall back to that.
 *
 * Coolify is the source of truth — no DNS cross-check, no second
 * opinion. If /servers/{uuid}/domains is wrong, the user fixes it
 * in the dashboard.
 */

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
}

/** Resolve the box's public IPv4 + IPv6 from Coolify. Prefers
 *  /servers/{uuid}/domains (which surfaces public_ipv4 / public_ipv6
 *  for localhost-Coolify installs that report `host.docker.internal`
 *  on /servers), and falls back to the /servers ip field for
 *  non-Docker installs. */
export async function discoverPublicIps(
  api: CoolifyApi,
  serverUuid: string,
  fallbackServerIp: string,
): Promise<PublicIps> {
  let v4: string | undefined;
  let v6: string | undefined;
  try {
    const domains = await api.getServerDomains(serverUuid);
    for (const d of domains) {
      const ip = (d.ip ?? "").trim();
      if (!v4 && isPublicIpv4(ip)) v4 = ip;
      if (!v6 && isPublicIpv6(ip)) v6 = ip;
    }
  } catch {
    // /servers/{uuid}/domains can 404 / 501 on older Coolify builds.
    // Fall through to the /servers ip field below.
  }
  if (!v4 && isPublicIpv4(fallbackServerIp)) v4 = fallbackServerIp;
  if (!v6 && isPublicIpv6(fallbackServerIp)) v6 = fallbackServerIp;
  return { v4, v6 };
}
