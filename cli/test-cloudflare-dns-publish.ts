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
import { mergeSpf } from "./src/provision/cloudflare-dns-publish.js";
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

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll cloudflare-dns-publish tests passed.");
