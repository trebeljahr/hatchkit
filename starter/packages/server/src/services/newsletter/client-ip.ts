import { isIP } from "node:net";
import type { Request } from "express";

function normalizeIp(value: string): string | undefined {
  if (value.includes("%")) return undefined;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return undefined;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  // Collapse IPv4-mapped IPv6 and IPv4 into the same budget and trust entry.
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const high = parseInt(mapped[1]!, 16);
  const low = parseInt(mapped[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** Exact proxy IPs only; no implicit hop count, private-network or loopback trust. */
export function createNewsletterClientIp(
  configured = process.env.NEWSLETTER_TRUSTED_PROXY_IPS ?? "",
): (req: Request) => string {
  const entries = configured.trim() ? configured.split(",") : [];
  if (entries.length > 64) throw new Error("Too many NEWSLETTER_TRUSTED_PROXY_IPS entries");
  const trusted = new Set(entries.map((entry) => {
    const ip = normalizeIp(entry.trim());
    if (!ip) throw new Error("NEWSLETTER_TRUSTED_PROXY_IPS must contain only literal IP addresses");
    return ip;
  }));

  return (req) => {
    const peer = normalizeIp(req.socket.remoteAddress ?? "") ?? "unknown";
    if (!trusted.has(peer)) return peer;
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded !== "string" || forwarded.length > 4096) return peer;
    const hops = forwarded.split(",");
    if (hops.length > 32) return peer;
    let client = peer;
    // Walk from the socket toward the client; stop at the first untrusted hop.
    for (let index = hops.length - 1; index >= 0 && trusted.has(client); index -= 1) {
      const hop = normalizeIp(hops[index]!.trim());
      if (!hop) return peer;
      client = hop;
    }
    return client;
  };
}
