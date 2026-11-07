/**
 * Stripe needs no global key. Setup stores only optional organization
 * keys; the old master key is never asked for, and a stored one is read
 * only to find webhooks it created. A project's own key wires it alone.
 *
 * Pinned here:
 *
 *   1. With no `providers.stripe` and no master key, a project's own keys
 *      still create its webhooks, in its own account.
 *   2. `storeStripeOrgKey` refuses a key of the other mode, stores the key
 *      and marks the provider configured; status describes it.
 *   3. `getStripeConfig` returns organization and legacy master keys and
 *      never null.
 *   4. Without a TTY, a project with no stored keys is skipped, once, with
 *      no prompt.
 *
 * Run: `node scripts/test.mjs test-stripe-config.ts`.
 */
import assert from "node:assert/strict";

if (!process.env.HATCHKIT_TEST_KEYCHAIN_DIR) throw new Error("Use scripts/test.mjs");

const { describeStripeMeta, getStore, getStripeConfig, storeStripeOrgKey } = await import(
  "./src/config.js"
);
const { SECRET_KEYS, getSecret, setSecret } = await import("./src/utils/secrets.js");
const { _setStripeFetchForTests } = await import("./src/provision/stripe-sync-cli.js");
const { collectPerProjectKeys, provisionStripeProject } = await import("./src/provision/stripe.js");
const { fakeStripe } = await import("./test-support/fake-stripe.js");
type LedgerStep = import("./src/utils/run-ledger.js").LedgerStep;

// Nothing in this file may reach the network.
globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`unexpected network call: ${String(input)}`);
}) as typeof fetch;

const results: Record<string, boolean> = {};
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results[name] = true;
  } catch (err) {
    results[name] = false;
    console.log(`\n  x ${name}\n    ${(err as Error).stack}\n`);
  }
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

await test("a project's own keys wire Stripe with no global key at all", async () => {
  assert.equal(getStore().get("providers.stripe"), undefined);
  assert.equal(await getSecret(SECRET_KEYS.stripeMasterTestSecretKey), null);
  const accounts = { test: fakeStripe(), live: fakeStripe() };
  const keys = { test: "sk_test_solo_fixture", live: "rk_live_solo_fixture" };
  _setStripeFetchForTests((async (input: string | URL | Request, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get("authorization");
    const mode =
      auth === `Bearer ${keys.test}` ? "test" : auth === `Bearer ${keys.live}` ? "live" : null;
    if (!mode) return new Response('{"error":{"message":"wrong key"}}', { status: 401 });
    return accounts[mode].fetch(input, init);
  }) as typeof fetch);
  try {
    for (const mode of ["test", "live"] as const) {
      await setSecret(SECRET_KEYS.stripeProjectSecretKey("solo", mode), keys[mode]);
      await setSecret(
        SECRET_KEYS.stripeProjectPublishableKey("solo", mode),
        `pk_${mode}_solo_fixture`,
      );
    }
    const steps: LedgerStep[] = [];
    const result = await quiet(() =>
      provisionStripeProject({
        projectName: "solo",
        domain: "solo.example.com",
        onLedgerStep: (step) => steps.push(step),
      }),
    );
    assert.equal(result.test?.kind, "configured");
    assert.equal(result.live?.kind, "configured");
    for (const mode of ["test", "live"] as const) {
      const hooks = [...accounts[mode].webhooks.values()];
      assert.equal(hooks.length, 1, mode);
      assert.equal(hooks[0].url, "https://solo.example.com/api/stripe/webhook");
    }
    assert.equal(steps.length, 2);
    assert.equal(getStore().get("providers.stripe"), undefined, "nothing global was written");
  } finally {
    _setStripeFetchForTests(undefined);
  }
});

await test("an organization key is stored per mode and shown in status", async () => {
  await assert.rejects(storeStripeOrgKey("test", "sk_live_org_fixture"), /live key, not test/);
  await assert.rejects(storeStripeOrgKey("live", "pk_live_org_fixture"), /not a Stripe secret key/);
  assert.equal(await getSecret(SECRET_KEYS.stripeOrgSecretKey("test")), null);

  await storeStripeOrgKey("test", "sk_test_org_fixture");
  assert.equal(await getSecret(SECRET_KEYS.stripeOrgSecretKey("test")), "sk_test_org_fixture");
  const meta = getStore().get("providers.stripe");
  assert.equal(meta?.status, "configured");
  assert.equal(meta?.hasTestOrgKey, true);
  assert.equal(describeStripeMeta(meta), "organization key: test");

  // A legacy master key, kept from before 2026-11-08, shows as such.
  getStore().set("providers.stripe", { ...meta, hasLiveMaster: true });
  assert.equal(
    describeStripeMeta(getStore().get("providers.stripe")),
    "organization key: test · legacy master key: live",
  );
  assert.equal(describeStripeMeta({ status: "configured" }), "per-project keys");
  assert.equal(describeStripeMeta({ status: "unconfigured" }), undefined);
});

await test("getStripeConfig returns organization and legacy master keys, never null", async () => {
  await setSecret(SECRET_KEYS.stripeMasterLiveSecretKey, "rk_live_master_fixture");
  const cfg = await getStripeConfig();
  assert.equal(cfg.testOrgKey, "sk_test_org_fixture");
  assert.equal(cfg.liveOrgKey, undefined);
  assert.equal(cfg.testSecretKey, undefined);
  assert.equal(cfg.liveSecretKey, "rk_live_master_fixture");

  getStore().delete("providers.stripe");
  const empty = await getStripeConfig();
  assert.equal(empty.status, "unconfigured");
});

await test("without a TTY, a project with no stored keys is skipped once, with no prompt", async () => {
  assert.ok(!process.stdin.isTTY, "the test runner has no TTY");
  const first = await quiet(() =>
    collectPerProjectKeys({ projectName: "nokeys", mode: "test", reprompt: false }),
  );
  assert.deepEqual(first, { kind: "skipped" });
  const result = await quiet(() =>
    provisionStripeProject({ projectName: "nokeys", domain: "nokeys.example.com" }),
  );
  assert.deepEqual(result, {
    test: { kind: "skipped", mode: "test" },
    live: { kind: "skipped", mode: "live" },
    accounts: {},
  });
});

const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  `\nstripe-config: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`,
);
if (failed.length) process.exit(1);
