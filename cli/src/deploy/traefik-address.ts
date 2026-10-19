/*
 * Where `migrate-runtime` sends its Host-header requests to Traefik.
 *
 * Since 2026-10-18 dedicated-vps drops 80/443 on its public interface
 * unless the peer is Cloudflare (host iptables chain HATCHKIT-CF). A
 * request from the operator's machine to the public IPv4 times out, so
 * every private verification failed and the run refused the cutover.
 * Traefik answers the same Host header over the tailnet.
 *
 * Order:
 *   1. HATCHKIT_TRAEFIK_ADDRESS, when set. An explicit choice wins.
 *   2. The tailnet IPv4 of the backup host whose Coolify server UUID is
 *      this app's server. A backup host on another server is never used.
 *   3. The server's public IPv4, as before the lockdown.
 *
 * Only the TCP peer changes. The private verification hostname still
 * embeds the public IPv4 (sslip.io): it is a Host header Traefik routes
 * by, never resolved here.
 */

import { isIP } from "node:net";
import { execa } from "execa";
import { type BackupHost, backupHosts } from "../backups/provider.js";

export const TRAEFIK_ADDRESS_ENV = "HATCHKIT_TRAEFIK_ADDRESS";

export type TraefikAddress =
  | { ok: true; address: string; source: "override" | "tailnet" | "public"; detail: string }
  | { ok: false; reason: string };

export interface TraefikAddressInput {
  serverUuid: string;
  publicV4?: string;
  override?: string;
  backupHosts?: Pick<BackupHost, "transport" | "target" | "serverUuid">[];
  tailnetIpv4?: (peer: string) => Promise<string>;
}

/** True for 100.64.0.0/10, the range Tailscale assigns. */
export function isTailnetIpv4(s: string): boolean {
  if (isIP(s) !== 4) return false;
  const [a, b] = s.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

const HOSTNAME =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

export async function resolveTraefikAddress(input: TraefikAddressInput): Promise<TraefikAddress> {
  const override = input.override?.trim();
  if (override) {
    if (!isIP(override) && !HOSTNAME.test(override))
      return {
        ok: false,
        reason: `${TRAEFIK_ADDRESS_ENV}="${override}" is not an IP address or hostname.`,
      };
    return { ok: true, address: override, source: "override", detail: TRAEFIK_ADDRESS_ENV };
  }
  let tailnetMiss = "";
  const host = input.backupHosts?.find((h) => h.serverUuid === input.serverUuid);
  if (host?.transport === "tailscale") {
    const peer = host.target.replace(/^[^@]*@/, "");
    try {
      const ip = await (input.tailnetIpv4 ?? tailnetIpv4)(peer);
      if (isTailnetIpv4(ip))
        return { ok: true, address: ip, source: "tailnet", detail: `tailnet address of ${peer}` };
      tailnetMiss = `${peer} has no tailnet IPv4 (got "${ip}")`;
    } catch (err) {
      tailnetMiss = `tailscale ip -4 ${peer} failed: ${(err as Error).message}`;
    }
  }
  if (input.publicV4)
    return {
      ok: true,
      address: input.publicV4,
      source: "public",
      detail: tailnetMiss ? `public IPv4; ${tailnetMiss}` : "public IPv4",
    };
  return { ok: false, reason: tailnetMiss || "No address to reach Traefik on." };
}

async function tailnetIpv4(peer: string): Promise<string> {
  const res = await execa("tailscale", ["ip", "-4", peer], { reject: false, timeout: 10_000 });
  if (res.exitCode !== 0) throw new Error(String(res.stderr || res.message || "").trim());
  return String(res.stdout).trim().split("\n")[0] ?? "";
}

/** {@link resolveTraefikAddress} from the environment and hatchkit's config. */
export function traefikAddressFor(serverUuid: string, publicV4?: string): Promise<TraefikAddress> {
  let hosts: BackupHost[] = [];
  try {
    hosts = backupHosts();
  } catch {
    // Backups not configured: no tailnet address is known.
  }
  return resolveTraefikAddress({
    serverUuid,
    publicV4,
    override: process.env[TRAEFIK_ADDRESS_ENV],
    backupHosts: hosts,
  });
}
