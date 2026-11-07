/**
 * Stripe webhook endpoints land in, and are removed from, the project's
 * own Stripe account. Several in-memory Stripe accounts sit behind one
 * fetch: a project key reaches its own account, an organization key the
 * account named by `Stripe-Context`, the master key the master's account.
 * Any other request fails the test; nothing reaches the network.
 *
 * Pinned here:
 *
 *   1. The starter webhook (`hatchkit add <project> stripe`, create,
 *      adopt) is created with the project's own key, never the master
 *      key, and goes on the run ledger as a `stripeWebhook` entry.
 *   2. With an organization key and the manifest's account it is created
 *      there, with `Stripe-Context`, and the ledger entry names the
 *      account. A cached endpoint is reused without a Stripe call.
 *   3. rename-domain moves the endpoint in the account that holds it,
 *      including one an older hatchkit made with the master key.
 *   4. `hatchkit stripe sync` records the paid-unlock webhook once, and
 *      `hatchkit destroy` deletes it in the project's account with
 *      `Stripe-Context` and forgets its keychain entries. Products stay.
 *   5. `hatchkit migrate-domain` plans and moves the paid-unlock webhook
 *      beside the starter's, each in the account that holds it, keeping
 *      ids and secrets, so a later `stripe sync` finds the endpoint
 *      instead of creating a second one. A test endpoint `--webhook-url`
 *      put on another host stays there. Projects without paid unlock get
 *      no paid-unlock row.
 *   6. An older ledger's `keychain` webhook-id entry deletes its endpoint
 *      (through the master key, where it was made).
 *   7. With no key stored, destroy keeps the entry for a later run, and an
 *      unreadable ledger is never overwritten.
 *
 * Run: `node scripts/test.mjs test-stripe-webhook-account.ts`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.HATCHKIT_TEST_KEYCHAIN_DIR) throw new Error("Use scripts/test.mjs");

const { getStore } = await import("./src/config.js");
const { SECRET_KEYS, deleteSecret, getSecret, setSecret } = await import("./src/utils/secrets.js");
const { RunLedger, appendLedgerStep, getLedgerPath } = await import("./src/utils/run-ledger.js");
type LedgerStep = import("./src/utils/run-ledger.js").LedgerStep;
const { applyPaidUnlock } = await import("./src/features/paid-unlock/index.js");
const { _setStripeFetchForTests, runStripeCli } = await import(
  "./src/provision/stripe-sync-cli.js"
);
const { provisionStripeProject, updateStripeProjectWebhookUrl } = await import(
  "./src/provision/stripe.js"
);
const { wireStripeForProject } = await import("./src/provision/stripe-wiring.js");
const { printRecipe, runRollback } = await import("./src/deploy/rollback.js");
const { detectStripeFacts } = await import("./src/migrate/index.js");
const { planDomainMigration, selectActions } = await import("./src/migrate/plan.js");
const { executorFor } = await import("./src/migrate/steps.js");
const { readManifest } = await import("./src/scaffold/manifest.js");
const { fakeStripe } = await import("./test-support/fake-stripe.js");
type FakeStripe = import("./test-support/fake-stripe.js").FakeStripe;

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

/** Silence console + the rollback's progress writes. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const log = console.log;
  const warn = console.warn;
  const write = process.stdout.write;
  let out = "";
  console.log = (...args: unknown[]) => {
    out += `${args.join(" ")}\n`;
  };
  console.warn = console.log;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: await fn(), out };
  } finally {
    console.log = log;
    console.warn = warn;
    process.stdout.write = write;
  }
}

// ── Stripe accounts behind one fetch ─────────────────────────────────

const KEYS = {
  masterTest: "sk_test_master_fixture",
  masterLive: "rk_live_master_fixture",
  orgTest: "sk_test_org_fixture",
  orgLive: "sk_live_org_fixture",
};
const accounts = new Map<string, FakeStripe>();
const keyAccount = new Map<string, string>([
  [KEYS.masterTest, "acct_master"],
  [KEYS.masterLive, "acct_master"],
]);
const orgKeys = new Set([KEYS.orgTest, KEYS.orgLive]);
const calls: Array<{
  account: string;
  method: string;
  path: string;
  key: string;
  context?: string;
}> = [];

function account(id: string): FakeStripe {
  let fake = accounts.get(id);
  if (!fake) {
    fake = fakeStripe();
    accounts.set(id, fake);
  }
  return fake;
}

const router = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  const headers = new Headers(init.headers);
  const key = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const context = headers.get("stripe-context") ?? undefined;
  let target: string | undefined;
  if (orgKeys.has(key)) {
    if (!context)
      return new Response('{"error":{"message":"org key needs Stripe-Context"}}', { status: 400 });
    target = context;
  } else {
    target = keyAccount.get(key);
  }
  if (!target) return new Response('{"error":{"message":"invalid key"}}', { status: 401 });
  calls.push({
    account: target,
    method: (init.method ?? "GET").toUpperCase(),
    path: url.pathname,
    key,
    context,
  });
  return account(target).fetch(input, init);
}) as typeof fetch;
_setStripeFetchForTests(router);
// No terminal prompts, even when the suite runs from one.
const { _setStripeSetupPromptsForTests } = await import("./src/provision/stripe-setup.js");
_setStripeSetupPromptsForTests(null);

/** A project's own key per mode, cached the way collectPerProjectKeys
 *  leaves it, each in its own account. */
async function projectKeys(project: string, modes: Array<"test" | "live"> = ["test", "live"]) {
  for (const mode of modes) {
    const key = `${mode === "test" ? "sk_test" : "rk_live"}_${project}_fixture`;
    keyAccount.set(key, `acct_${project}_${mode}`);
    await setSecret(SECRET_KEYS.stripeProjectSecretKey(project, mode), key);
    await setSecret(
      SECRET_KEYS.stripeProjectPublishableKey(project, mode),
      `pk_${mode}_${project}_fixture`,
    );
  }
}

// Stripe is configured with a master key per mode (the old wiring key).
getStore().set("providers.stripe", {
  status: "configured",
  hasTestMaster: true,
  hasLiveMaster: true,
  lastVerified: "2026-11-07T00:00:00.000Z",
});
await setSecret(SECRET_KEYS.stripeMasterTestSecretKey, KEYS.masterTest);
await setSecret(SECRET_KEYS.stripeMasterLiveSecretKey, KEYS.masterLive);

const root = mkdtempSync(join(tmpdir(), "stripe-webhook-account-"));
/** What wiring "shop" handed back for its run ledger (test 1). */
let shopSteps: LedgerStep[] = [];

// ── 1–2. create / add ────────────────────────────────────────────────

await test("the starter webhook lands in the project's own account, never the master's", async () => {
  await projectKeys("shop");
  const serverEnvDir = join(root, "shop", "packages", "server");
  mkdirSync(serverEnvDir, { recursive: true });
  const forwarded: LedgerStep[] = [];
  const { value: result } = await quiet(() =>
    wireStripeForProject({
      projectName: "shop",
      domain: "shop.example.com",
      serverEnvDir,
      envLabelPrefix: "packages/server",
      onLedgerStep: (step) => forwarded.push(step),
    }),
  );
  assert.equal(result.configured, true);
  assert.equal(result.deferred, undefined);
  assert.deepEqual(
    forwarded,
    result.ledgerSteps,
    "each step reaches the caller's ledger as it happens",
  );
  shopSteps = result.ledgerSteps;
  for (const mode of ["test", "live"] as const) {
    const hooks = [...account(`acct_shop_${mode}`).webhooks.values()];
    assert.equal(hooks.length, 1, `${mode}: one endpoint in the project's account`);
    assert.equal(hooks[0].url, "https://shop.example.com/api/stripe/webhook");
    assert.equal(await getSecret(SECRET_KEYS.stripeProjectWebhookId("shop", mode)), hooks[0].id);
  }
  assert.equal(account("acct_master").webhooks.size, 0, "the master's account is untouched");
  assert.ok(!calls.some((c) => c.key === KEYS.masterTest || c.key === KEYS.masterLive));
  assert.ok(!calls.some((c) => c.context), "no Stripe-Context without an organization key");
  assert.deepEqual(
    result.ledgerSteps.map((s: LedgerStep) =>
      s.kind === "stripeWebhook" ? [s.mode, s.endpoint, s.account] : s.kind,
    ),
    [
      ["test", "starter", undefined],
      ["live", "starter", undefined],
    ],
  );
  assert.match(
    readFileSync(join(serverEnvDir, ".env.development.local"), "utf-8"),
    /^STRIPE_WEBHOOK_SECRET=whsec_/m,
  );
});

await test("with an organization key and the manifest's account it is created there", async () => {
  await projectKeys("atlas");
  await setSecret(SECRET_KEYS.stripeOrgSecretKey("test"), KEYS.orgTest);
  const steps: LedgerStep[] = [];
  const before = calls.length;
  try {
    await quiet(() =>
      provisionStripeProject({
        projectName: "atlas",
        domain: "atlas.example.com",
        accounts: { test: "acct_1AtlasTest" },
        onLedgerStep: (step) => steps.push(step),
      }),
    );
  } finally {
    await deleteSecret(SECRET_KEYS.stripeOrgSecretKey("test"));
  }
  const create = calls
    .slice(before)
    .filter((c) => c.method === "POST" && c.path === "/v1/webhook_endpoints");
  assert.deepEqual(
    create.map((c) => [c.account, c.key, c.context]),
    [
      ["acct_1AtlasTest", KEYS.orgTest, "acct_1AtlasTest"],
      // Live has no organization key: the project's own key.
      ["acct_atlas_live", "rk_live_atlas_fixture", undefined],
    ],
  );
  assert.equal(
    [...account("acct_1AtlasTest").webhooks.values()][0].url,
    "https://atlas.example.com/api/stripe/webhook",
  );
  assert.equal(account("acct_atlas_test").webhooks.size, 0);
  assert.deepEqual(
    steps.map((s) => (s.kind === "stripeWebhook" ? [s.mode, s.account] : s.kind)),
    [
      ["test", "acct_1AtlasTest"],
      ["live", undefined],
    ],
  );
});

await test("a cached endpoint is reused: no Stripe call, nothing new for the ledger", async () => {
  const steps: LedgerStep[] = [];
  const before = calls.length;
  await quiet(() =>
    provisionStripeProject({
      projectName: "shop",
      domain: "shop.example.com",
      onLedgerStep: (step) => steps.push(step),
    }),
  );
  assert.equal(calls.length, before);
  assert.deepEqual(steps, []);
});

// ── 3. rename-domain ─────────────────────────────────────────────────

await test("rename-domain moves the endpoint in the account that holds it", async () => {
  const url = "https://shop.example.org/api/stripe/webhook";
  const res = await updateStripeProjectWebhookUrl("shop", "test", url);
  assert.equal(res.result, "updated");
  assert.equal([...account("acct_shop_test").webhooks.values()][0].url, url);
  assert.equal((await updateStripeProjectWebhookUrl("shop", "test", url)).result, "unchanged");

  // An endpoint an older hatchkit made with the master key, in the
  // master's account: the project's account 404s, the master finds it.
  await projectKeys("legacy", ["test"]);
  account("acct_master").webhooks.set("we_legacy_shop", {
    id: "we_legacy_shop",
    object: "webhook_endpoint",
    url: "https://legacy.example.com/api/stripe/webhook",
    enabled_events: ["checkout.session.completed"],
    status: "enabled",
    secret: "whsec_legacy_fixture",
  });
  await setSecret(SECRET_KEYS.stripeProjectWebhookId("legacy", "test"), "we_legacy_shop");
  const moved = await updateStripeProjectWebhookUrl(
    "legacy",
    "test",
    "https://legacy.example.org/api/stripe/webhook",
  );
  assert.equal(moved.result, "updated");
  assert.equal(
    account("acct_master").webhooks.get("we_legacy_shop")?.url,
    "https://legacy.example.org/api/stripe/webhook",
  );
});

// ── 4. stripe sync → destroy ─────────────────────────────────────────

function unlockProject(name: string, extra: Record<string, unknown> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".hatchkit.json"),
    `${JSON.stringify(
      {
        version: 5,
        cliVersion: "0.0.0",
        scaffoldedAt: "2026-11-07T00:00:00.000Z",
        name,
        domain: `${name}.example.com`,
        features: [],
        mlServices: [],
        deployTarget: "existing",
        ports: { server: 5000, client: 3000 },
        surfaces: "static",
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
  const added = applyPaidUnlock({
    projectDir: dir,
    key: "guide",
    name: "Field guide",
    kind: "download",
    price: "9",
    files: "guide.pdf",
  });
  assert.ok(added.ok, added.errors.join("\n"));
  return dir;
}

await test("destroy deletes the paid-unlock webhook stripe sync made, in the project's account", async () => {
  const dir = unlockProject("gallery");
  await setSecret(SECRET_KEYS.stripeOrgSecretKey("live"), KEYS.orgLive);
  try {
    const sync = ["sync", dir, "--mode", "live", "--account", "acct_1GalleryLive", "--yes"];
    await quiet(() => runStripeCli(sync));
    const shop = account("acct_1GalleryLive");
    const [hook] = [...shop.webhooks.values()];
    assert.equal(hook.url, "https://gallery.example.com/api/unlock/webhook");
    assert.equal(
      await getSecret(SECRET_KEYS.stripeProjectUnlockWebhookId("gallery", "live")),
      hook.id,
    );
    const expected: LedgerStep = {
      kind: "stripeWebhook",
      mode: "live",
      endpoint: "unlock",
      endpointId: String(hook.id),
      url: "https://gallery.example.com/api/unlock/webhook",
      account: "acct_1GalleryLive",
    };
    assert.deepEqual(RunLedger.load("gallery")?.steps, [expected]);

    // A second sync keeps the endpoint and records nothing twice.
    await quiet(() => runStripeCli(["sync", dir, "--mode", "live", "--yes"]));
    assert.deepEqual(RunLedger.load("gallery")?.steps, [expected]);

    const ledger = RunLedger.load("gallery");
    assert.ok(ledger);
    const { out: recipe } = await quiet(async () => printRecipe(ledger));
    assert.match(recipe, new RegExp(`delete Stripe live webhook ${hook.id}`));
    assert.match(recipe, /stripe:project:gallery:live:unlock-webhook-secret/);

    const before = calls.length;
    await quiet(() => runRollback(ledger, { yes: true }));
    const deletes = calls.slice(before).filter((c) => c.method === "DELETE");
    assert.deepEqual(
      deletes.map((c) => [c.path, c.key, c.context]),
      [[`/v1/webhook_endpoints/${hook.id}`, KEYS.orgLive, "acct_1GalleryLive"]],
    );
    assert.equal(shop.webhooks.size, 0);
    assert.ok(shop.products.size > 0, "products stay");
    assert.equal(
      await getSecret(SECRET_KEYS.stripeProjectUnlockWebhookId("gallery", "live")),
      null,
    );
    assert.equal(
      await getSecret(SECRET_KEYS.stripeProjectUnlockWebhookSecret("gallery", "live")),
      null,
    );
    assert.equal(RunLedger.load("gallery"), null, "ledger removed once everything is undone");
  } finally {
    await deleteSecret(SECRET_KEYS.stripeOrgSecretKey("live"));
  }
});

await test("destroy deletes the starter webhook create recorded, with the project's key", async () => {
  assert.equal(shopSteps.length, 2);
  const ledger = RunLedger.start("shop");
  for (const step of shopSteps) ledger.record(step);
  ledger.complete();
  await quiet(() => runRollback(ledger, { yes: true }));
  assert.equal(account("acct_shop_test").webhooks.size, 0);
  assert.equal(account("acct_shop_live").webhooks.size, 0);
  assert.equal(await getSecret(SECRET_KEYS.stripeProjectWebhookId("shop", "test")), null);
  assert.equal(await getSecret(SECRET_KEYS.stripeProjectWebhookSecret("shop", "live")), null);
  assert.ok(await getSecret(SECRET_KEYS.stripeProjectSecretKey("shop", "test")), "app key stays");
});

// ── 5. migrate-domain ────────────────────────────────────────────────

/** Every endpoint URL in one fake account, sorted. */
const urlsIn = (id: string) => [...account(id).webhooks.values()].map((h) => String(h.url)).sort();

await test("migrate-domain moves the starter and the paid-unlock webhook, each in its account", async () => {
  const dir = unlockProject("studio", {
    features: ["stripe"],
    stripe: { accounts: { live: "acct_1StudioLive" } },
  });
  await projectKeys("studio");
  await setSecret(SECRET_KEYS.stripeOrgSecretKey("live"), KEYS.orgLive);
  try {
    // Starter: test with the project's own key, live with the
    // organization key in the manifest's account.
    await quiet(() =>
      provisionStripeProject({
        projectName: "studio",
        domain: "studio.example.com",
        accounts: { live: "acct_1StudioLive" },
      }),
    );
    // Paid unlock: live by default, test only with --webhook-url.
    await quiet(() => runStripeCli(["sync", dir, "--mode", "live", "--yes"]));
    await quiet(() =>
      runStripeCli([
        "sync",
        dir,
        "--mode",
        "test",
        "--webhook-url",
        "https://studio.example.com/api/unlock/webhook",
      ]),
    );
    const old = [
      "https://studio.example.com/api/stripe/webhook",
      "https://studio.example.com/api/unlock/webhook",
    ];
    assert.deepEqual(urlsIn("acct_studio_test"), old);
    assert.deepEqual(urlsIn("acct_1StudioLive"), old);
    assert.equal(account("acct_studio_live").webhooks.size, 0);
    const hooksBefore = new Map(
      ["acct_studio_test", "acct_1StudioLive"].flatMap((a) =>
        [...account(a).webhooks.values()].map((h) => [h.id, h.secret] as const),
      ),
    );

    const manifest = readManifest(dir);
    assert.ok(manifest);
    const stripe = await detectStripeFacts(dir, manifest);
    assert.deepEqual(stripe, { keyStored: true, paidUnlock: true });
    const plan = planDomainMigration({
      manifest,
      newDomain: "studio.example.org",
      oldDomain: "studio.example.com",
      oldDomainSource: "manifest.domain",
      // No master-key config: the project and organization keys decide.
      configured: { stripe: false },
      stripe,
    });
    const cutover = selectActions(plan, { phase: "cutover", only: "stripe" }).map((a) => a.id);
    assert.deepEqual(cutover, ["stripe:webhook", "stripe:unlock-webhook"]);

    const ctx = {
      projectDir: dir,
      monorepoRoot: dir,
      oldDomain: "studio.example.com",
      newDomain: "studio.example.org",
    };
    const before = calls.length;
    for (const id of cutover) {
      const outcome = await executorFor(id)(ctx);
      assert.equal(outcome.status, "done", `${id}: ${outcome.message}`);
    }
    const moved = [
      "https://studio.example.org/api/stripe/webhook",
      "https://studio.example.org/api/unlock/webhook",
    ];
    assert.deepEqual(urlsIn("acct_studio_test"), moved);
    assert.deepEqual(urlsIn("acct_1StudioLive"), moved);
    assert.equal(account("acct_studio_live").webhooks.size, 0);
    assert.equal(account("acct_master").webhooks.size, 1, "only the legacy endpoint from test 3");
    // Each update went to the account that holds the endpoint, with the
    // key that reaches it, and no endpoint was created or deleted.
    const writes = calls.slice(before).filter((c) => c.method !== "GET");
    assert.deepEqual(writes.map((c) => [c.account, c.key, c.context ?? null]).sort(), [
      ["acct_1StudioLive", KEYS.orgLive, "acct_1StudioLive"],
      ["acct_1StudioLive", KEYS.orgLive, "acct_1StudioLive"],
      ["acct_studio_test", "sk_test_studio_fixture", null],
      ["acct_studio_test", "sk_test_studio_fixture", null],
    ]);
    assert.ok(writes.every((c) => c.method === "POST" && c.path !== "/v1/webhook_endpoints"));
    // Same endpoints, same signing secrets: no env or wrangler change.
    for (const a of ["acct_studio_test", "acct_1StudioLive"]) {
      for (const h of account(a).webhooks.values()) assert.equal(hooksBefore.get(h.id), h.secret);
    }

    // A second cutover changes nothing.
    for (const id of cutover) {
      const again = await executorFor(id)(ctx);
      assert.equal(again.status, "skipped");
      assert.match((again.detail ?? []).join("\n"), /live: already https:\/\/studio\.example\.org/);
    }

    // A later sync on the new domain finds the moved endpoint and keeps it.
    writeFileSync(
      join(dir, ".hatchkit.json"),
      `${JSON.stringify({ ...manifest, domain: "studio.example.org" }, null, 2)}\n`,
    );
    const beforeSync = calls.length;
    await quiet(() => runStripeCli(["sync", dir, "--mode", "live", "--yes"]));
    assert.ok(
      !calls
        .slice(beforeSync)
        .some((c) => c.path === "/v1/webhook_endpoints" && c.method === "POST"),
      "no second endpoint",
    );
    assert.deepEqual(urlsIn("acct_1StudioLive"), moved);
  } finally {
    await deleteSecret(SECRET_KEYS.stripeOrgSecretKey("live"));
  }
});

await test("migrate-domain leaves a paid-unlock test endpoint on another host alone", async () => {
  const dir = unlockProject("kiosk");
  await projectKeys("kiosk", ["test"]);
  const tunnel = "https://tunnel.example.net/api/unlock/webhook";
  await quiet(() => runStripeCli(["sync", dir, "--mode", "test", "--webhook-url", tunnel]));
  const ctx = {
    projectDir: dir,
    monorepoRoot: dir,
    oldDomain: "kiosk.example.com",
    newDomain: "kiosk.example.org",
  };
  const outcome = await executorFor("stripe:unlock-webhook")(ctx);
  assert.equal(outcome.status, "skipped");
  assert.match(
    (outcome.detail ?? []).join("\n"),
    /test: we_\w+ points at https:\/\/tunnel\.example\.net\/api\/unlock\/webhook — left alone/,
  );
  assert.deepEqual(urlsIn("acct_kiosk_test"), [tunnel]);
});

await test("a project without paid unlock gets no paid-unlock row", async () => {
  // "shop" has the starter webhook and no unlocks.json or unlock id.
  const dir = join(root, "shop");
  const manifest = {
    name: "shop",
    domain: "shop.example.com",
    features: ["stripe"],
  } as unknown as import("./src/scaffold/manifest.js").ProjectManifest;
  // Only the project's own keys: no master, no organization key.
  await deleteSecret(SECRET_KEYS.stripeMasterTestSecretKey);
  await deleteSecret(SECRET_KEYS.stripeMasterLiveSecretKey);
  let stripe: Awaited<ReturnType<typeof detectStripeFacts>>;
  try {
    stripe = await detectStripeFacts(dir, manifest);
  } finally {
    await setSecret(SECRET_KEYS.stripeMasterTestSecretKey, KEYS.masterTest);
    await setSecret(SECRET_KEYS.stripeMasterLiveSecretKey, KEYS.masterLive);
  }
  assert.deepEqual(stripe, { keyStored: true, paidUnlock: false });
  const plan = planDomainMigration({
    manifest,
    newDomain: "shop.example.org",
    oldDomain: "shop.example.com",
    oldDomainSource: "manifest.domain",
    configured: { stripe: false },
    stripe,
  });
  const rows = plan.actions.filter((a) => a.provider === "stripe");
  assert.deepEqual(
    rows.map((a) => [a.id, a.kind]),
    [["stripe:webhook", "update"]],
    "the project's own key is enough; no master key needed",
  );
});

await test("with no key that reaches the project, the starter row is manual and says what to store", async () => {
  const manifest = {
    name: "nokeys",
    domain: "nokeys.example.com",
    features: ["stripe"],
  } as unknown as import("./src/scaffold/manifest.js").ProjectManifest;
  const plan = planDomainMigration({
    manifest,
    newDomain: "nokeys.example.org",
    oldDomain: "nokeys.example.com",
    oldDomainSource: "manifest.domain",
    configured: { stripe: true },
    stripe: { keyStored: false, paidUnlock: false },
  });
  const [row] = plan.actions.filter((a) => a.id === "stripe:webhook");
  assert.equal(row.kind, "manual");
  assert.match((row.detail ?? []).join("\n"), /hatchkit stripe org-key/);
});

// ── 6. older ledgers ─────────────────────────────────────────────────

await test("an older ledger's keychain webhook-id entry deletes its endpoint via the master", async () => {
  account("acct_master").webhooks.set("we_older_create", {
    id: "we_older_create",
    object: "webhook_endpoint",
    url: "https://older.example.com/api/stripe/webhook",
    enabled_events: ["checkout.session.completed"],
    status: "enabled",
    secret: "whsec_older_fixture",
  });
  await setSecret(SECRET_KEYS.stripeProjectWebhookId("older", "live"), "we_older_create");
  await setSecret(SECRET_KEYS.stripeProjectWebhookSecret("older", "live"), "whsec_older_fixture");
  const ledger = RunLedger.start("older");
  ledger.record({ kind: "keychain", account: SECRET_KEYS.stripeProjectWebhookId("older", "live") });
  ledger.complete();
  const { out } = await quiet(async () => printRecipe(ledger));
  assert.match(out, /delete the Stripe live webhook endpoint/);
  await quiet(() => runRollback(ledger, { yes: true }));
  assert.equal(account("acct_master").webhooks.has("we_older_create"), false);
  assert.equal(await getSecret(SECRET_KEYS.stripeProjectWebhookId("older", "live")), null);
  assert.equal(await getSecret(SECRET_KEYS.stripeProjectWebhookSecret("older", "live")), null);
  assert.equal(RunLedger.load("older"), null);
});

// ── 7. no key, unreadable ledger ─────────────────────────────────────

await test("with no Stripe key stored, destroy keeps the entry for a later run", async () => {
  await deleteSecret(SECRET_KEYS.stripeMasterLiveSecretKey);
  const ledger = RunLedger.start("nokey");
  const step: LedgerStep = {
    kind: "stripeWebhook",
    mode: "live",
    endpoint: "unlock",
    endpointId: "we_nokey",
    url: "https://nokey.example.com/api/unlock/webhook",
    account: "acct_1NoKey",
  };
  ledger.record(step);
  ledger.complete();
  const { out } = await quiet(() => runRollback(ledger, { yes: true }));
  assert.match(out, /needs manual cleanup/);
  assert.match(out, /No live Stripe key stored for nokey/);
  assert.deepEqual(RunLedger.load("nokey")?.steps, [step]);
});

await test("an unreadable ledger is never overwritten by a later command", async () => {
  const path = getLedgerPath("broken");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{ not json");
  assert.throws(
    () =>
      appendLedgerStep("broken", {
        kind: "stripeWebhook",
        mode: "test",
        endpoint: "unlock",
        endpointId: "we_x",
        url: "https://broken.example.com/api/unlock/webhook",
      }),
    /unreadable/,
  );
  assert.equal(readFileSync(path, "utf-8"), "{ not json");
  assert.ok(existsSync(path));
});

_setStripeFetchForTests(undefined);
rmSync(root, { recursive: true, force: true });
const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  `\nstripe-webhook-account: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`,
);
if (failed.length) process.exit(1);
