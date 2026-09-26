// Refusing to be somebody's HTTP proxy into their own network.
//
// A webhook URL is attacker-controlled by construction: anybody who can create
// a subscription can point this server at an address only this server can
// reach — a cloud metadata endpoint, an internal admin panel, a database's
// HTTP interface. That is SSRF, and a URL check alone does not stop it,
// because the name is resolved separately from the check.
import { TRPCError } from "@trpc/server";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { env } from "../../config/env.js";

/** Parse a dotted-quad into its four octets, or null. */
function ipv4Octets(ip: string): [number, number, number, number] | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return null;
  return [parts[0] as number, parts[1] as number, parts[2] as number, parts[3] as number];
}

/**
 * Parse one `:`-separated run of an IPv6 literal into bytes, or null.
 *
 * A trailing dotted-quad (`::ffff:127.0.0.1`) stands for the final two groups
 * and is legal only in last position — anywhere else it is a malformed address
 * and must not be quietly accepted.
 */
function ipv6Chunk(parts: string[]): number[] | null {
  const bytes: number[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    if (part.includes(".")) {
      if (i !== parts.length - 1) return null;
      const quad = ipv4Octets(part);
      if (!quad) return null;
      bytes.push(...quad);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    const group = Number.parseInt(part, 16);
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

/**
 * Turn an IPv6 literal into its 16 bytes, or null if it cannot be parsed.
 *
 * Everything below is decided on these bytes and never on the text, because
 * the text is NOT what the caller passes in. WHATWG URL re-serializes an
 * address into its shortest hex form:
 *
 *   new URL("https://[::ffff:127.0.0.1]/x").hostname === "[::ffff:7f00:1]"
 *
 * So a guard that pattern-matches the dotted-quad spelling of an IPv4-mapped
 * address never fires in production — this function only ever sees
 * `::ffff:7f00:1`, and the metadata service at `::ffff:a9fe:a9fe` walks
 * straight through. Parsing to bytes makes every spelling of one address the
 * same address, which is the only form of this check that can be right.
 */
function ipv6Bytes(ip: string): Uint8Array | null {
  // A zone id (`fe80::1%en0`) selects a local interface, so it is never part
  // of a routable destination — and `isIP` accepts it, so strip it rather than
  // failing to parse an address that is otherwise well-formed.
  const text = (ip.split("%")[0] ?? "").toLowerCase();
  if (isIP(text) !== 6) return null;

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const split = (part: string): string[] => (part === "" ? [] : part.split(":"));

  const head = ipv6Chunk(split(halves[0] ?? ""));
  if (!head) return null;

  if (halves.length === 1) {
    // No "::" — every one of the eight groups must be spelled out.
    if (head.length !== 16) return null;
    return Uint8Array.from(head);
  }

  const tail = ipv6Chunk(split(halves[1] ?? ""));
  if (!tail) return null;
  // "::" stands for at least one group of zeroes; a run that already fills the
  // address is malformed, and would otherwise let `set` overlap silently.
  if (head.length + tail.length >= 16) return null;

  const bytes = new Uint8Array(16);
  bytes.set(head, 0);
  bytes.set(tail, 16 - tail.length);
  return bytes;
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, i) => bytes[i] === byte);
}

/**
 * One IPv4 quad carried inside an IPv6 address.
 *
 * `complement` marks the fields RFC 4380 stores bitwise-inverted (see Teredo
 * below) — it is not a typo to be "fixed" by dropping the XOR.
 */
type EmbeddedQuad = { readonly at: number; readonly complement: boolean };
type V4Embedding = { readonly prefix: readonly number[]; readonly quads: readonly EmbeddedQuad[] };

// IPv6 prefixes that carry an IPv4 destination inside them. Every one reaches
// a v4 address on a host whose stack implements the transition mechanism, so
// the embedded quad is unwrapped and run through the IPv4 table rather than
// waved through as ordinary global unicast.
//
//   ::ffff:0:0/96  IPv4-mapped — what a dual-stack socket dials for a v4 host
//   ::/96          IPv4-compatible (deprecated, still routed by some stacks)
//   64:ff9b::/96   the NAT64 well-known prefix — a translator turns this back
//                  into a plain v4 packet, so it reaches the v4 address too
//   2002::/16      6to4: the v4 tunnel endpoint is bytes 2..5, so
//                  `2002:a9fe:a9fe::` is the cloud metadata service
//   2001:0::/32    Teredo: TWO v4 addresses — the relay at bytes 4..7 in the
//                  clear and the client at bytes 12..15 stored as its bitwise
//                  complement. Both are checked.
//
// Missing any of them leaves loopback and the metadata address one spelling
// away from being reachable.
const V4_EMBEDDING_PREFIXES: readonly V4Embedding[] = [
  { prefix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], quads: [{ at: 12, complement: false }] },
  { prefix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], quads: [{ at: 12, complement: false }] },
  {
    prefix: [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0],
    quads: [{ at: 12, complement: false }],
  },
  { prefix: [0x20, 0x02], quads: [{ at: 2, complement: false }] },
  {
    prefix: [0x20, 0x01, 0x00, 0x00],
    quads: [
      { at: 4, complement: false },
      { at: 12, complement: true },
    ],
  },
];

/** Read the IPv4 quad an embedding stores at `at`, undoing any complement. */
function embeddedQuad(bytes: Uint8Array, quad: EmbeddedQuad): string {
  const octet = (i: number): number => {
    const byte = bytes[i] ?? 0;
    return quad.complement ? byte ^ 0xff : byte;
  };
  return [octet(quad.at), octet(quad.at + 1), octet(quad.at + 2), octet(quad.at + 3)].join(".");
}

/**
 * Is this address one no customer endpoint could legitimately live at?
 *
 * Pure and DNS-free on purpose: the interesting half of an SSRF guard is
 * "which ranges", and that is a table worth unit-testing exhaustively without
 * a network. `assertDeliverableUrl` is the part that does I/O.
 *
 * There is deliberately no "unrecognised, therefore allowed" path. Anything
 * this function cannot take apart is blocked, because a guard that does not
 * understand an address must never conclude it is safe.
 */
export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 0) return true; // Not an address at all — fail closed.

  if (version === 6) {
    const bytes = ipv6Bytes(ip);
    if (!bytes) return true;

    // :: (unspecified) and ::1 (loopback).
    if (bytes.every((byte) => byte === 0)) return true;
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;

    // An embedded IPv4 destination is an IPv4 destination. Re-checked against
    // the v4 table rather than against the v6 masks, which would classify
    // `::ffff:a9fe:a9fe` (169.254.169.254) as ordinary global unicast and hand
    // out the cloud metadata service. A transition prefix carrying a PUBLIC v4
    // address is a public destination, so a non-match falls through.
    for (const embedding of V4_EMBEDDING_PREFIXES) {
      if (!hasPrefix(bytes, embedding.prefix)) continue;
      for (const quad of embedding.quads) {
        if (isBlockedAddress(embeddedQuad(bytes, quad))) return true;
      }
    }

    const first = bytes[0] ?? 0;
    const second = bytes[1] ?? 0;
    if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique local
    if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link local
    // fec0::/10 site-local. Deprecated is not the same as unreachable: an
    // on-prem network still numbered in it is reachable by exactly the class
    // of address the fc00::/7 rule exists to keep a webhook away from.
    if (first === 0xfe && (second & 0xc0) === 0xc0) return true;
    if (first === 0xff) return true; // ff00::/8 multicast
    if (hasPrefix(bytes, [0x01, 0, 0, 0, 0, 0, 0, 0])) return true; // 100::/64 discard

    return false; // Parsed, in no reserved range: ordinary global unicast.
  }

  const octets = ipv4Octets(ip);
  if (!octets) return true;
  const [a, b] = octets;

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 — cloud metadata lives here
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0/24
  if (a === 192 && b === 0 && octets[2] === 2) return true; // 192.0.2/24
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + broadcast
  return false;
}

const badUrl = (message: string): TRPCError =>
  new TRPCError({ code: "BAD_REQUEST", message });

/**
 * Resolve a webhook URL and refuse it if any address behind it is internal.
 *
 * Three things a naive check does not do:
 *
 *  - Reject every scheme but http(s). `file:` and friends turn a delivery into
 *    a local read.
 *  - Check EVERY address the name resolves to (`{ all: true }`), not only the
 *    first. A host with one public A record and one private one passes a
 *    first-address check and is then dialled at whichever the OS picks.
 *  - Run again immediately BEFORE EACH ATTEMPT, not only at subscribe time.
 *    DNS rebinding — a name that answers publicly once and privately
 *    afterwards — makes a create-time-only check decorative, so `delivery.ts`
 *    calls this per attempt and never caches the result.
 *
 * What remains is the window between this resolution and the one `fetch` does
 * for itself, which a 0-TTL record can still slip through. Closing that means
 * dialling the validated literal with `node:https` and carrying the name in
 * `Host` and SNI — worth doing the day this server is allowed to reach
 * anything interesting on its own network.
 *
 * `WEBHOOK_ALLOW_PRIVATE_TARGETS` exists for a local listener during
 * development. It also relaxes the https requirement, because there is no
 * certificate for `localhost` worth insisting on. It belongs nowhere else.
 */
export async function assertDeliverableUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badUrl("That is not a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badUrl("A webhook URL must be http or https");
  }

  const allowPrivate = env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  if (!allowPrivate && url.protocol !== "https:") {
    throw badUrl("A webhook URL must use https");
  }

  // A literal address skips DNS entirely; there is nothing to resolve and
  // nothing to rebind.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) !== 0) {
    if (!allowPrivate && isBlockedAddress(hostname)) {
      throw badUrl("That address is not reachable from this server");
    }
    return url;
  }

  if (allowPrivate) return url;

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw badUrl("That host could not be resolved");
  }
  if (addresses.length === 0) throw badUrl("That host could not be resolved");

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw badUrl("That address is not reachable from this server");
    }
  }

  return url;
}
