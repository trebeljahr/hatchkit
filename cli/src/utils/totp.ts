// RFC 6238 TOTP (HMAC-SHA1, 30-second step, 6 digits) — the standard
// Google-Authenticator algorithm INWX uses for account 2FA. No dependency:
// Node's crypto has HMAC. We only need to GENERATE a current code from a
// base32 shared secret to feed INWX's `account.unlock`, so there is no
// verification/skew logic here.

import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decode an RFC 4648 base32 string — the "manual entry" / setup key that
 * authenticator apps and INWX show when enabling 2FA — into bytes.
 * Case-insensitive; whitespace and `=` padding are ignored. Throws on any
 * character outside the base32 alphabet so a mistyped secret fails loudly
 * instead of silently producing wrong codes.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  const out: number[] = [];
  let value = 0;
  let bits = 0;
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`invalid base32 character ${JSON.stringify(ch)} in TOTP secret`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
      value &= (1 << bits) - 1; // keep `value` within 32-bit range
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  /** Time step in seconds (RFC 6238 default 30). */
  step?: number;
  /** Number of digits in the code (default 6). */
  digits?: number;
  /** Unix time in milliseconds to compute the code for (default now). */
  timestampMs?: number;
}

/**
 * Generate the current TOTP code for a base32 shared secret.
 * Deterministic for a given `timestampMs`, which the tests pin to the
 * RFC 6238 reference vectors.
 */
export function generateTotp(secret: string, options: TotpOptions = {}): string {
  const step = options.step ?? 30;
  const digits = options.digits ?? 6;
  const timestampMs = options.timestampMs ?? Date.now();

  const key = base32Decode(secret);
  if (key.length === 0) {
    throw new Error("TOTP secret is empty after base32 decode");
  }

  const counter = Math.floor(timestampMs / 1000 / step);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBytes.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac("sha1", key).update(counterBytes).digest();
  // Dynamic truncation (RFC 4226 §5.3): low nibble of the last byte picks
  // a 4-byte window, mask off the high bit, reduce to `digits` decimals.
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}
