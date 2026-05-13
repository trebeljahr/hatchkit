import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "dns-preflight-conf-"));
process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-${process.pid}`;

const {
  MissingCloudflareZoneError,
  apexDomain,
  formatMissingCloudflareZoneMessage,
  requireCloudflareZoneForTerraform,
} = await import("./src/deploy/terraform.js");

assert.equal(apexDomain("realmhatch.com"), "realmhatch.com");
assert.equal(apexDomain("api.realmhatch.com"), "realmhatch.com");

const message = formatMissingCloudflareZoneMessage("realmhatch.com");
assert.match(message, /No Cloudflare zone found for realmhatch\.com/);
assert.match(message, /Add realmhatch\.com as a site in Cloudflare/);
assert.match(message, /hatchkit config add dns/);

await assert.rejects(
  () =>
    requireCloudflareZoneForTerraform(
      "api.realmhatch.com",
      { status: "configured", provider: "cloudflare", apiToken: "test-token" },
      { lookupZone: async () => null },
    ),
  (err) => {
    assert.equal(err instanceof MissingCloudflareZoneError, true);
    assert.equal((err as { domain?: string }).domain, "realmhatch.com");
    assert.match((err as Error).message, /No Cloudflare zone found for realmhatch\.com/);
    return true;
  },
);

const found = await requireCloudflareZoneForTerraform(
  "realmhatch.com",
  { status: "configured", provider: "cloudflare", apiToken: "test-token" },
  {
    lookupZone: async (name) => ({
      id: "zone_123",
      name,
      name_servers: ["alice.ns.cloudflare.com", "bob.ns.cloudflare.com"],
      status: "pending",
    }),
  },
);
assert.equal(found.name, "realmhatch.com");

console.log("dns preflight checks ok");
