/**
 * totp.ts: RFC 6238 TOTP generator unit tests.
 *
 * Backs INWX 2FA (account.unlock). Correctness is non-negotiable — a wrong
 * code silently fails the unlock — so the goldens are the published RFC 6238
 * reference vectors (Appendix B, SHA-1, secret ASCII "12345678901234567890"
 * = base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"), reduced to the 6-digit code
 * INWX expects. Plus base32 decode edge cases (lowercase, spaces, padding,
 * invalid chars).
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { base32Decode, generateTotp } from "./src/utils/totp.js";

// base32 of ASCII "12345678901234567890" (the RFC 6238 SHA-1 seed).
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const failures: string[] = [];

function expect(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

console.log("base32Decode:");

expect("decodes the RFC seed back to ASCII 12345678901234567890", () => {
  assert.equal(base32Decode(RFC_SECRET).toString("ascii"), "12345678901234567890");
});

expect("is case-insensitive and ignores spaces + padding", () => {
  const spaced = "gezd gnbv gy3t qojq gezd gnbv gy3t qojq";
  assert.deepEqual(base32Decode(spaced), base32Decode(RFC_SECRET));
  // A short secret with padding decodes to the same bytes as unpadded.
  assert.deepEqual(base32Decode("MFRGG==="), base32Decode("MFRGG"));
});

expect("throws on an out-of-alphabet character", () => {
  assert.throws(() => base32Decode("MFRG1!"), /invalid base32 character/);
});

console.log("\ngenerateTotp (RFC 6238 Appendix B, SHA-1, 6-digit):");

// [unix seconds, expected 6-digit code] from the RFC's 8-digit vectors,
// truncated to the low 6 digits (94287082 → 287082, etc.).
const vectors: Array<[number, string]> = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

for (const [seconds, code] of vectors) {
  expect(`T=${seconds}s → ${code}`, () => {
    assert.equal(generateTotp(RFC_SECRET, { timestampMs: seconds * 1000 }), code);
  });
}

expect("codes are stable within a 30s step and roll at the boundary", () => {
  const a = generateTotp(RFC_SECRET, { timestampMs: 0 });
  const stillA = generateTotp(RFC_SECRET, { timestampMs: 29_999 });
  const next = generateTotp(RFC_SECRET, { timestampMs: 30_000 });
  assert.equal(a, stillA, "same step must give the same code");
  assert.notEqual(a, next, "next step must roll the code");
});

expect("an empty secret throws rather than emitting a code", () => {
  assert.throws(() => generateTotp(""), /empty/);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll totp tests passed.");
