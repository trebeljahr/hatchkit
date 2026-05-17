/**
 * SES SMTP credential derivation — golden test.
 *
 * AWS deprecated the original (Sig V2) "HMAC over the literal string
 * SendRawEmail" derivation in 2018. Modern SES SMTP credentials use a
 * region-bound Sig V4 chain ending in a one-byte version prefix
 * (0x04). The output is a 49-byte string, base64-encoded.
 *
 * If this test ever drifts, every project provisioned with `listmonk-ses`
 * silently breaks at first-send time — Listmonk reports "AUTH failed"
 * against `email-smtp.<region>.amazonaws.com` and the user has no
 * visibility into why. Goldens for three regions to lock in the
 * algorithm + the region binding.
 *
 * Source secret: the AWS docs' canonical EXAMPLE_KEY string, which is a
 * well-known fake — it's not a credential.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  SES_SMTP_REGIONS,
  deriveSesSmtpPassword,
  sesSmtpCredentials,
} from "./src/provision/ses.js";

const EXAMPLE_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

const GOLDENS: Array<{ region: string; expected: string }> = [
  { region: "us-east-1", expected: "BLBM/9hSUELfq8Gw+rU1YcBjkOxGbhT2XG763xVLGWL9" },
  { region: "eu-west-1", expected: "BMW5RDrXmmVs0lV7GpI4oLkHXpZ4stDsk6q91z1g38Pk" },
  { region: "us-west-2", expected: "BF2PynzbSCAjX08zhZZnP/kW+T9P5zs/1Er0pi5vTEmd" },
];

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

console.log("deriveSesSmtpPassword (Sig V4 derivation):");

for (const { region, expected } of GOLDENS) {
  expect(`${region} matches golden`, () => {
    const got = deriveSesSmtpPassword(EXAMPLE_SECRET, region);
    assert.equal(got, expected);
  });
}

expect("output is 49-byte base64 (1 version byte + 32 HMAC bytes)", () => {
  const got = deriveSesSmtpPassword(EXAMPLE_SECRET, "us-east-1");
  // base64 of 33 raw bytes = 44 chars (no padding since 33 % 3 == 0).
  assert.equal(got.length, 44);
  const decoded = Buffer.from(got, "base64");
  assert.equal(decoded.length, 33);
  assert.equal(decoded[0], 0x04);
});

expect("region binding: same secret → different output per region", () => {
  const a = deriveSesSmtpPassword(EXAMPLE_SECRET, "us-east-1");
  const b = deriveSesSmtpPassword(EXAMPLE_SECRET, "eu-west-1");
  assert.notEqual(a, b);
});

expect("throws on a region with no SES SMTP endpoint", () => {
  assert.throws(
    () => deriveSesSmtpPassword(EXAMPLE_SECRET, "moon-base-1"),
    /no SMTP endpoint/,
  );
});

console.log("\nsesSmtpCredentials:");

expect("renders host as email-smtp.<region>.amazonaws.com, port 587", () => {
  const creds = sesSmtpCredentials({
    region: "eu-west-1",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: EXAMPLE_SECRET,
  });
  assert.equal(creds.host, "email-smtp.eu-west-1.amazonaws.com");
  assert.equal(creds.port, 587);
  assert.equal(creds.username, "AKIAEXAMPLE");
  assert.equal(creds.password, "BMW5RDrXmmVs0lV7GpI4oLkHXpZ4stDsk6q91z1g38Pk");
});

console.log("\nSES_SMTP_REGIONS:");

expect("includes eu-west-1 (default suggested for EU compliance)", () => {
  assert.ok((SES_SMTP_REGIONS as readonly string[]).includes("eu-west-1"));
});

expect("includes us-east-1", () => {
  assert.ok((SES_SMTP_REGIONS as readonly string[]).includes("us-east-1"));
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll SES SMTP credential tests passed.");
