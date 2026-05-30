/**
 * Tests for `migrateLegacyDnsProvider` — the legacy-provider auto-migration
 * branch of `ensureDns`.
 *
 * Regression context: prior to this fix, the migration wiped
 * `SECRET_KEYS.dnsCloudflareToken` unconditionally on first run after
 * upgrading from a pre-v2 INWX-DNS / manual-DNS config. Cloudflare never
 * re-exposes token values, so users had to roll + re-paste a still-valid
 * token. The fix: read the token first, wipe only the INWX-specific
 * secret, optionally verify, and skip the prompt entirely if the token
 * is still good.
 *
 * Run: `pnpm test` (wired into cli/package.json).
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "dns-migration-conf-"));
process.env.HATCHKIT_KEYTAR_SERVICE = `hatchkit-test-${process.pid}`;

const { _internals, getStore } = await import("./src/config.js");
const { SECRET_KEYS, deleteSecret, getSecret, setSecret } = await import("./src/utils/secrets.js");

const store = getStore();
const { migrateLegacyDnsProvider } = _internals;

async function reset(): Promise<void> {
  store.delete("providers.dns");
  await deleteSecret(SECRET_KEYS.dnsCloudflareToken);
  await deleteSecret(SECRET_KEYS.dnsInwxPassword);
  await deleteSecret(SECRET_KEYS.dnsInwxRegistrarPassword);
}

const failures: string[] = [];

async function test(label: string, fn: () => Promise<void>): Promise<void> {
  await reset();
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

console.log("migrateLegacyDnsProvider:");

await test("preserved-and-verified: legacy provider + valid CF token survives", async () => {
  store.set("providers.dns", { status: "configured", provider: "inwx" });
  await setSecret(SECRET_KEYS.dnsCloudflareToken, "tkn-preserved");
  await setSecret(SECRET_KEYS.dnsInwxPassword, "inwx-pw");

  const verifyCalls: string[] = [];
  const verify = async (token: string) => {
    verifyCalls.push(token);
    return true;
  };

  const result = await migrateLegacyDnsProvider("inwx", verify);
  assert.ok(result, "expected a preserved DnsConfig");
  assert.equal(result.apiToken, "tkn-preserved");
  assert.equal(result.provider, "cloudflare");
  assert.equal(result.status, "configured");
  assert.deepEqual(verifyCalls, ["tkn-preserved"]);

  const meta = store.get("providers.dns") as { status: string; provider: string };
  assert.deepEqual(meta, { status: "configured", provider: "cloudflare" });
  assert.equal(await getSecret(SECRET_KEYS.dnsCloudflareToken), "tkn-preserved");
  assert.equal(await getSecret(SECRET_KEYS.dnsInwxPassword), null);
});

await test("preserved-and-verified: registrar password (if present) flows through", async () => {
  store.set("providers.dns", {
    status: "configured",
    provider: "inwx",
    registrarUsername: "rico",
  });
  await setSecret(SECRET_KEYS.dnsCloudflareToken, "tkn-preserved");
  await setSecret(SECRET_KEYS.dnsInwxRegistrarPassword, "registrar-pw");

  const result = await migrateLegacyDnsProvider("inwx", async () => true);
  assert.ok(result);
  assert.equal(result.registrarPassword, "registrar-pw");
  assert.equal(
    await getSecret(SECRET_KEYS.dnsInwxRegistrarPassword),
    "registrar-pw",
    "registrar password is for the registrar role, not DNS — must not be wiped",
  );
});

await test("preserved-but-invalid: verify rejects → token dropped, null returned", async () => {
  store.set("providers.dns", { status: "configured", provider: "inwx" });
  await setSecret(SECRET_KEYS.dnsCloudflareToken, "tkn-dead");
  await setSecret(SECRET_KEYS.dnsInwxPassword, "inwx-pw");

  const verify = async (_token: string) => false;
  const result = await migrateLegacyDnsProvider("inwx", verify);
  assert.equal(result, null, "should fall through to prompt path when verify fails");

  assert.equal(
    await getSecret(SECRET_KEYS.dnsCloudflareToken),
    null,
    "dead CF token should be dropped",
  );
  assert.equal(await getSecret(SECRET_KEYS.dnsInwxPassword), null);
  assert.equal(store.get("providers.dns"), undefined);
});

await test("no-stored-token: verify is NOT called, null returned, inwx secret wiped", async () => {
  store.set("providers.dns", { status: "configured", provider: "inwx" });
  await setSecret(SECRET_KEYS.dnsInwxPassword, "inwx-pw");

  let verifyCalled = false;
  const verify = async (_token: string) => {
    verifyCalled = true;
    return true;
  };

  const result = await migrateLegacyDnsProvider("inwx", verify);
  assert.equal(result, null);
  assert.equal(verifyCalled, false, "verify should NOT be invoked when no token was stored");
  assert.equal(await getSecret(SECRET_KEYS.dnsInwxPassword), null);
  assert.equal(await getSecret(SECRET_KEYS.dnsCloudflareToken), null);
  assert.equal(store.get("providers.dns"), undefined);
});

await test("manual-provider migration: same preserve behavior as inwx", async () => {
  store.set("providers.dns", { status: "configured", provider: "manual" });
  await setSecret(SECRET_KEYS.dnsCloudflareToken, "tkn-manual-preserved");

  const result = await migrateLegacyDnsProvider("manual", async () => true);
  assert.ok(result);
  assert.equal(result.apiToken, "tkn-manual-preserved");
  assert.equal(result.provider, "cloudflare");
  assert.equal(await getSecret(SECRET_KEYS.dnsCloudflareToken), "tkn-manual-preserved");
});

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log("dns legacy-migration checks ok");
