/**
 * cloudflare-dns-publish.ts: SPF-merge unit tests.
 *
 * The shared helper backs SES's DKIM-publish flow. SPF-merge is the
 * one piece with non-trivial logic — multiple SPF records at the same
 * host cause receivers to PermError (RFC 7208 §3.2), so when a
 * provider's record says "v=spf1 …" and a CNAME at the same name
 * already exists, we MUST combine includes into one record, not write
 * two. Goldens lock in:
 *
 *   1. No existing SPF → write the provider's record verbatim, and the
 *      caller learns we created (not merged into) a record so rollback
 *      can delete it cleanly.
 *
 *   2. Existing SPF with softfail (`~all`) → union includes, preserve
 *      softfail.
 *
 *   3. Existing SPF with hardfail (`-all`) → union includes, preserve
 *      hardfail (we must NOT downgrade an existing strict policy
 *      silently).
 *
 *   4. Duplicates in includes are deduped.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { mergeSpf, publishDnsRecordsToCloudflare } from "./src/provision/cloudflare-dns-publish.js";
import type { CloudflareApi } from "./src/utils/cloudflare-api.js";

interface FakeTxt {
  id: string;
  content: string;
}

function makeFakeCf(existing: FakeTxt[]): CloudflareApi {
  return {
    async findRecordsByName(_zoneId: string, _name: string, _type: string) {
      return existing;
    },
  } as unknown as CloudflareApi;
}

const failures: string[] = [];

async function expect(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

console.log("mergeSpf:");

await expect(
  "no existing SPF → write provider record as-is, flag sourceWasExisting=false",
  async () => {
    const cf = makeFakeCf([]);
    const out = await mergeSpf(cf, "zone-1", "example.com", "v=spf1 include:amazonses.com ~all");
    assert.equal(out.sourceWasExisting, false);
    assert.equal(out.merged, "v=spf1 include:amazonses.com ~all");
  },
);

await expect(
  "existing SPF (softfail) + provider include → union, preserve ~all, flag merged",
  async () => {
    const cf = makeFakeCf([{ id: "r1", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" }]);
    const out = await mergeSpf(cf, "zone-1", "example.com", "v=spf1 include:amazonses.com ~all");
    assert.equal(out.sourceWasExisting, true);
    assert.match(out.merged, /^v=spf1 /);
    assert.match(out.merged, /include:_spf\.mx\.cloudflare\.net/);
    assert.match(out.merged, /include:amazonses\.com/);
    assert.match(out.merged, /~all$/);
    assert.doesNotMatch(out.merged, /-all/);
  },
);

await expect(
  "existing SPF (hardfail) → preserved, NOT silently downgraded to softfail",
  async () => {
    const cf = makeFakeCf([{ id: "r1", content: "v=spf1 include:_spf.mx.cloudflare.net -all" }]);
    const out = await mergeSpf(cf, "zone-1", "example.com", "v=spf1 include:amazonses.com ~all");
    assert.equal(out.sourceWasExisting, true);
    assert.match(out.merged, /-all$/);
    assert.doesNotMatch(out.merged, /~all/);
  },
);

await expect("duplicates in provider + existing includes are deduplicated", async () => {
  const cf = makeFakeCf([
    { id: "r1", content: "v=spf1 include:amazonses.com include:_spf.mx.cloudflare.net ~all" },
  ]);
  const out = await mergeSpf(cf, "zone-1", "example.com", "v=spf1 include:amazonses.com ~all");
  const occurrences = (out.merged.match(/include:amazonses\.com/g) ?? []).length;
  assert.equal(occurrences, 1);
});

// ---------------------------------------------------------------------------
// publishDnsRecordsToCloudflare — A/AAAA address records + dry-run plumbing
// (`hatchkit dns publish` is built on these paths).
// ---------------------------------------------------------------------------

interface UpsertCall {
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  dryRun?: boolean;
}

function makePublishFakeCf(calls: UpsertCall[]): CloudflareApi {
  return {
    async resolveZoneForName(_name: string) {
      return { id: "zone-1", name: "example.com" };
    },
    async upsertRecord(_zoneId: string, params: UpsertCall) {
      calls.push(params);
      return { id: "rec-1", created: true, updated: false };
    },
  } as unknown as CloudflareApi;
}

console.log("\npublishDnsRecordsToCloudflare (A/AAAA):");

await expect("A record defaults to proxied=true and is tracked as created", async () => {
  const calls: UpsertCall[] = [];
  const cf = makePublishFakeCf(calls);
  const res = await publishDnsRecordsToCloudflare(
    [{ type: "A", name: "play.example.com", value: "203.0.113.7" }],
    { cf, domain: "play.example.com" },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.type, "A");
  assert.equal(calls[0]?.content, "203.0.113.7");
  assert.equal(calls[0]?.proxied, true);
  assert.equal(res.created, 1);
  assert.deepEqual(res.createdRecords, [{ id: "rec-1", name: "play.example.com", type: "A" }]);
});

await expect("explicit proxied=false on an A record is respected", async () => {
  const calls: UpsertCall[] = [];
  const cf = makePublishFakeCf(calls);
  await publishDnsRecordsToCloudflare(
    [{ type: "A", name: "play.example.com", value: "203.0.113.7", proxied: false }],
    { cf, domain: "play.example.com" },
  );
  assert.equal(calls[0]?.proxied, false);
});

await expect("dryRun option reaches every upsert (A + AAAA + CNAME)", async () => {
  const calls: UpsertCall[] = [];
  const cf = makePublishFakeCf(calls);
  await publishDnsRecordsToCloudflare(
    [
      { type: "A", name: "a.example.com", value: "203.0.113.7" },
      { type: "AAAA", name: "a.example.com", value: "2001:db8::1" },
      { type: "CNAME", name: "alias.example.com", value: "a.example.com" },
    ],
    { cf, domain: "a.example.com", dryRun: true },
  );
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.dryRun, true);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll cloudflare-dns-publish tests passed.");
