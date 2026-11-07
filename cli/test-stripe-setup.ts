/**
 * Stripe setup: the subflow `create`, `adopt` and `add <project> stripe`
 * run before collecting keys, the machine flow behind `hatchkit setup` →
 * Stripe, and doctor's Stripe rows. Prompts are scripted through the
 * module's port; Stripe is an in-memory fake per account behind one
 * fetch. Nothing reaches the network.
 *
 * Pinned here:
 *
 *   1. A mode with the organization key and the project's account, or
 *      with the project's own key, is ready without a question. Without
 *      a terminal, a mode that is not ready is skipped.
 *   2. With nothing set up, the subflow shows the dashboard steps,
 *      waits for the organization key and the account id, checks the
 *      pair against Stripe, and re-asks on a bad account. "Not now"
 *      returns to the choice; skip is per mode. Answers hold for the
 *      rest of the run.
 *   3. No master key is needed any more: `provisionStripeProject`
 *      creates the webhook with the project's key, and with the
 *      organization key in the account the subflow collected.
 *   4. Doctor flags recorded webhook endpoints no stored key reaches,
 *      with the fix.
 *   5. `hatchkit stripe sync` runs the same subflow for its one mode: a
 *      static paid-unlock site (no `add <project> stripe`) can paste
 *      its own key there; a wrong key is refused and pasted again. An
 *      account entered there is saved to `stripe.accounts`.
 *   6. migrate-domain defers its webhook step, instead of reporting
 *      "nothing to move", when no stored key reaches a recorded endpoint.
 *
 * Run: `node scripts/test.mjs test-stripe-setup.ts`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.HATCHKIT_TEST_KEYCHAIN_DIR) throw new Error("Use scripts/test.mjs");

const { getStore } = await import("./src/config.js");
const { SECRET_KEYS, deleteSecret, getSecret, setSecret } = await import("./src/utils/secrets.js");
const { RunLedger } = await import("./src/utils/run-ledger.js");
const { _setStripeFetchForTests, _setConfirmForTests, runStripeCli } = await import(
  "./src/provision/stripe-sync-cli.js"
);
const { applyPaidUnlock } = await import("./src/features/paid-unlock/index.js");
const { executorFor } = await import("./src/migrate/steps.js");
const { provisionStripeProject } = await import("./src/provision/stripe.js");
const setup = await import("./src/provision/stripe-setup.js");
type StripeSetupPrompts = import("./src/provision/stripe-setup.js").StripeSetupPrompts;
const { fakeStripe } = await import("./test-support/fake-stripe.js");
type FakeStripe = import("./test-support/fake-stripe.js").FakeStripe;

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
  } finally {
    setup._setStripeSetupPromptsForTests(null);
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

// ── Stripe accounts behind one fetch ─────────────────────────────────

const ORG = { test: "sk_test_org_fixture", live: "sk_live_org_fixture" } as const;
/** Accounts the organization holds; any other Stripe-Context is refused. */
const orgAccounts = new Set(["acct_1ShopTest", "acct_1ShopLive", "acct_1KioskTest"]);
const keyAccount = new Map<string, string>();
const accounts = new Map<string, FakeStripe>();
const calls: Array<{ account: string; method: string; path: string; context?: string }> = [];

function account(id: string): FakeStripe {
  let fake = accounts.get(id);
  if (!fake) {
    fake = fakeStripe();
    accounts.set(id, fake);
  }
  return fake;
}

_setStripeFetchForTests((async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  const headers = new Headers(init.headers);
  const key = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const context = headers.get("stripe-context") ?? undefined;
  let target: string | undefined;
  if (key === ORG.test || key === ORG.live) {
    if (!context || !orgAccounts.has(context))
      return new Response('{"error":{"message":"No such account"}}', { status: 403 });
    target = context;
  } else target = keyAccount.get(key);
  if (!target) return new Response('{"error":{"message":"invalid key"}}', { status: 401 });
  calls.push({ account: target, method: init.method ?? "GET", path: url.pathname, context });
  return account(target).fetch(input, init);
}) as typeof fetch);
setup._setStripeSetupPromptsForTests(null);

async function projectKeys(project: string, modes: Array<"test" | "live"> = ["test", "live"]) {
  for (const mode of modes) {
    const key = `${mode === "test" ? "sk_test" : "rk_live"}_${project}_fixture`;
    keyAccount.set(key, `acct_${project}_${mode}`);
    await setSecret(SECRET_KEYS.stripeProjectSecretKey(project, mode), key);
    await setSecret(
      SECRET_KEYS.stripeProjectPublishableKey(project, mode),
      `pk_${mode}_${project}`,
    );
  }
}

async function clearKeys(): Promise<void> {
  for (const mode of ["test", "live"] as const) {
    await deleteSecret(SECRET_KEYS.stripeOrgSecretKey(mode));
    await deleteSecret(
      mode === "test"
        ? SECRET_KEYS.stripeMasterTestSecretKey
        : SECRET_KEYS.stripeMasterLiveSecretKey,
    );
  }
  getStore().delete("providers.stripe");
}

/** Prompts that answer from a script, in order, and record what was
 *  asked. A select answer must be one of the offered values. */
function scripted(answers: string[]) {
  const asked: string[] = [];
  const logs: string[] = [];
  const next = (message: string) => {
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`no scripted answer for: ${message}`);
    asked.push(message);
    return answer;
  };
  const prompts: StripeSetupPrompts = {
    async select(message, choices) {
      const answer = next(message);
      assert.ok(
        choices.some((c) => c.value === answer),
        `"${answer}" is not offered for "${message}" (${choices.map((c) => c.value).join(", ")})`,
      );
      return answer as never;
    },
    async secret(message) {
      return next(message);
    },
    async text(message, validate) {
      const answer = next(message);
      assert.equal(validate(answer), true, `"${answer}" rejected for "${message}"`);
      return answer;
    },
    log(line) {
      logs.push(line);
    },
  };
  return { prompts, asked, logs, answers };
}

const root = mkdtempSync(join(tmpdir(), "stripe-setup-"));

// ── 1. ready modes ───────────────────────────────────────────────────

await test("ready modes need no question; without a terminal the rest are skipped", async () => {
  await clearKeys();
  await projectKeys("ready", ["test"]);
  await setSecret(SECRET_KEYS.stripeOrgSecretKey("live"), ORG.live);
  const plan = await setup.ensureStripeForProject({
    project: "ready",
    accounts: { live: "acct_1ShopLive" },
  });
  assert.deepEqual(plan.modes, { test: "project", live: "org" });

  const bare = await setup.ensureStripeForProject({ project: "bare" });
  assert.deepEqual(bare.modes, { test: "skip", live: "skip" });
});

// ── 2. the subflow ───────────────────────────────────────────────────

await test("nothing set up: it waits for the org key and account, checks them, and allows a skip", async () => {
  await clearKeys();
  const s = scripted([
    // test: set up the organization key …
    "org",
    "paste",
    ORG.test,
    // … a wrong account first, then the right one
    "acct_1Unknown",
    "acct_1ShopTest",
    // live: skip for now
    "skip",
  ]);
  setup._setStripeSetupPromptsForTests(s.prompts);
  const plan = await setup.ensureStripeForProject({ project: "shop" });
  assert.deepEqual(plan.modes, { test: "org", live: "skip" });
  assert.deepEqual(plan.accounts, { test: "acct_1ShopTest" });
  assert.equal(await getSecret(SECRET_KEYS.stripeOrgSecretKey("test")), ORG.test);
  assert.deepEqual(s.answers, [], "every scripted answer was used");
  const log = s.logs.join("\n");
  assert.match(log, /Products write, Prices write, Webhook Endpoints write/);
  assert.match(log, /dashboard\.stripe\.com\/sandboxes/);
  assert.match(log, /cannot read acct_1Unknown/);
  assert.match(log, /reaches acct_1ShopTest/);
  assert.match(log, /hatchkit add shop stripe/);
  // The check went to the account, with the organization key.
  assert.ok(calls.some((c) => c.account === "acct_1ShopTest" && c.context === "acct_1ShopTest"));
  assert.equal(getStore().get("providers.stripe.hasTestOrgKey"), true);

  // The rest of the run reuses the answers: no more prompts.
  const again = await setup.ensureStripeForProject({ project: "shop" });
  assert.deepEqual(again, plan);
});

await test('"not now" at the key goes back to the choice; an empty account goes back too', async () => {
  await clearKeys();
  await projectKeys("kiosk", ["live"]);
  const s = scripted([
    // test: org key, then "not now" → back → org key pasted → empty
    // account → back → own key
    "org",
    "skip",
    "org",
    "paste",
    ORG.test,
    "",
    "project",
  ]);
  setup._setStripeSetupPromptsForTests(s.prompts);
  const plan = await setup.ensureStripeForProject({ project: "kiosk" });
  // live has the project's own key: ready, never asked.
  assert.deepEqual(plan.modes, { test: "project", live: "project" });
  assert.deepEqual(plan.accounts, {});
  assert.deepEqual(s.answers, []);
  assert.ok(
    s.asked.every((m) => !m.startsWith("LIVE")),
    "live was not asked",
  );
});

await test("a mistyped key of the other mode is refused, then pasted again", async () => {
  await clearKeys();
  const s = scripted(["paste", ORG.live, "paste", ORG.test]);
  setup._setStripeSetupPromptsForTests(s.prompts);
  assert.equal(await setup.promptStripeOrgKey("test", s.prompts), true);
  assert.match(s.logs.join("\n"), /a live key, not test/);
  assert.equal(await getSecret(SECRET_KEYS.stripeOrgSecretKey("test")), ORG.test);
});

// ── 3. provisioning without a master key ─────────────────────────────

await test("provisionStripeProject needs no master key: project key here, org key + account there", async () => {
  // The way `create` runs it: the pre-flight subflow decides and the
  // app keys get cached; the wiring step later reuses the decision.
  await clearKeys();
  await projectKeys("cafe", ["test"]);
  await setSecret(SECRET_KEYS.stripeOrgSecretKey("live"), ORG.live);
  orgAccounts.add("acct_1CafeLive");
  const s = scripted(["org", "acct_1CafeLive"]);
  setup._setStripeSetupPromptsForTests(s.prompts);
  const plan = await setup.ensureStripeForProject({ project: "cafe" });
  assert.deepEqual(plan.modes, { test: "project", live: "org" });
  await projectKeys("cafe", ["live"]);

  const done = await quiet(() =>
    provisionStripeProject({ projectName: "cafe", domain: "cafe.example.com" }),
  );
  assert.deepEqual(s.answers, []);
  assert.equal(done.test?.kind, "configured");
  assert.equal(done.live?.kind, "configured");
  assert.deepEqual(done.accounts, { live: "acct_1CafeLive" });
  assert.deepEqual(
    [...account("acct_cafe_test").webhooks.values()].map((h) => h.url),
    ["https://cafe.example.com/api/stripe/webhook"],
  );
  assert.equal(account("acct_1CafeLive").webhooks.size, 1, "live: in the project's account");
  assert.equal(account("acct_cafe_live").webhooks.size, 0);
  assert.equal(getStore().get("providers.stripe.hasTestMaster"), undefined, "no master anywhere");

  // `add <project> stripe` saves the account into the manifest.
  const dir = join(root, "cafe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".hatchkit.json"),
    `${JSON.stringify({
      version: 5,
      cliVersion: "0.0.0",
      scaffoldedAt: "2026-11-08T00:00:00.000Z",
      name: "cafe",
      domain: "cafe.example.com",
      features: ["stripe"],
      mlServices: [],
      deployTarget: "existing",
      ports: { server: 5000, client: 3000 },
      stripe: { accounts: { test: "acct_1CafeTestOld" } },
    })}\n`,
  );
  setup.saveStripeAccounts(dir, done.accounts);
  const manifest = JSON.parse(readFileSync(join(dir, ".hatchkit.json"), "utf-8"));
  assert.deepEqual(manifest.stripe.accounts, {
    test: "acct_1CafeTestOld",
    live: "acct_1CafeLive",
  });
});

// ── 4. doctor ────────────────────────────────────────────────────────

await test("doctor: no webhook rows without recorded endpoints", async () => {
  await clearKeys();
  assert.deepEqual(await setup.stripeWebhookRows(), []);
});

await test("doctor flags recorded endpoints no stored key reaches, with the fix", async () => {
  await clearKeys();
  await projectKeys("bakery", ["test"]);
  const ledger = RunLedger.start("bakery");
  // Reachable: the project's own test key is stored.
  ledger.record({
    kind: "stripeWebhook",
    mode: "test",
    endpoint: "starter",
    endpointId: "we_bakery_test",
    url: "https://bakery.example.com/api/stripe/webhook",
  });
  // Not reachable: made with the organization key, which is not stored.
  ledger.record({
    kind: "stripeWebhook",
    mode: "live",
    endpoint: "unlock",
    endpointId: "we_bakery_live",
    url: "https://bakery.example.com/api/unlock/webhook",
    account: "acct_1BakeryLive",
  });
  ledger.complete();

  const rows = await setup.stripeWebhookRows();
  const byName = new Map(rows.map((r) => [r.name, r]));
  assert.match(byName.get("Stripe webhooks")?.detail ?? "", /1 recorded endpoint\(s\) in 1/);
  const gap = byName.get("Stripe webhooks of bakery (live)");
  assert.equal(gap?.status, "warn");
  assert.match(gap?.detail ?? "", /migrate-domain and destroy cannot move or delete/);
  const hint = (gap?.hint ?? []).join("\n");
  assert.match(hint, /acct_1BakeryLive/);
  assert.match(hint, /Webhook Endpoints write/);
  assert.match(hint, /hatchkit stripe org-key --mode live/);

  // Storing the organization key closes it.
  await setSecret(SECRET_KEYS.stripeOrgSecretKey("live"), ORG.live);
  const after = await setup.stripeWebhookRows();
  assert.ok(
    after.every((r) => r.status !== "warn"),
    JSON.stringify(after, null, 2),
  );
});

// ── 5. stripe sync ───────────────────────────────────────────────────

await test("stripe sync asks for a key when none is set up, then writes with it", async () => {
  await clearKeys();
  const dir = join(root, "zine");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".hatchkit.json"),
    `${JSON.stringify({
      version: 5,
      cliVersion: "0.0.0",
      scaffoldedAt: "2026-11-08T00:00:00.000Z",
      name: "zine",
      domain: "zine.example.com",
      features: [],
      mlServices: [],
      deployTarget: "existing",
      ports: { server: 5000, client: 3000 },
      surfaces: "static",
    })}\n`,
  );
  const added = applyPaidUnlock({
    projectDir: dir,
    key: "issue",
    name: "Issue one",
    kind: "download",
    price: "5",
    files: "issue.pdf",
  });
  assert.ok(added.ok, added.errors.join("\n"));
  keyAccount.set("sk_test_zine_fixture", "acct_zine_test");
  const s = scripted(["project", "pk_test_not_a_secret", "again", "sk_test_zine_fixture"]);
  setup._setStripeSetupPromptsForTests(s.prompts);
  _setConfirmForTests(async () => true);
  try {
    await quiet(() => runStripeCli(["sync", dir, "--mode", "test"]));
  } finally {
    _setConfirmForTests(undefined);
  }
  assert.deepEqual(s.answers, []);
  assert.match(s.logs.join("\n"), /Expected a key starting with sk_test_ or rk_test_/);
  assert.equal(
    await getSecret(SECRET_KEYS.stripeProjectSecretKey("zine", "test")),
    "sk_test_zine_fixture",
  );
  assert.equal(account("acct_zine_test").products.size, 1, "the product is in zine's account");
});

await test("an account entered at the sync prompt is saved to stripe.accounts", async () => {
  await clearKeys();
  await setSecret(SECRET_KEYS.stripeOrgSecretKey("test"), ORG.test);
  const dir = join(root, "zine");
  await deleteSecret(SECRET_KEYS.stripeProjectSecretKey("zine", "test"));
  orgAccounts.add("acct_1ZineTest");
  const s = scripted(["org", "acct_1ZineTest"]);
  setup._setStripeSetupPromptsForTests(s.prompts);
  await quiet(() => runStripeCli(["sync", dir, "--mode", "test"]));
  assert.deepEqual(s.answers, []);
  const manifest = JSON.parse(readFileSync(join(dir, ".hatchkit.json"), "utf-8"));
  assert.deepEqual(manifest.stripe?.accounts, { test: "acct_1ZineTest" });
  assert.equal(account("acct_1ZineTest").products.size, 1);
});

await test("without a terminal, stripe sync with no key ends in the usual error", async () => {
  await clearKeys();
  const dir = join(root, "zine");
  await deleteSecret(SECRET_KEYS.stripeProjectSecretKey("zine", "test"));
  await assert.rejects(
    () => quiet(() => runStripeCli(["sync", dir, "--mode", "test"])),
    /No Stripe key for zine/,
  );
});

// ── 6. migrate-domain ────────────────────────────────────────────────

await test("migrate-domain defers the webhook step when no stored key reaches an endpoint", async () => {
  await clearKeys();
  const dir = join(root, "atelier");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".hatchkit.json"),
    `${JSON.stringify({
      version: 5,
      cliVersion: "0.0.0",
      scaffoldedAt: "2026-11-08T00:00:00.000Z",
      name: "atelier",
      domain: "atelier.example.com",
      features: ["stripe"],
      mlServices: [],
      deployTarget: "existing",
      ports: { server: 5000, client: 3000 },
    })}\n`,
  );
  // Recorded on another machine: the id is here, no key that reaches it.
  await setSecret(SECRET_KEYS.stripeProjectWebhookId("atelier", "live"), "we_atelier_live");
  const outcome = await executorFor("stripe:webhook")({
    projectDir: dir,
    monorepoRoot: dir,
    oldDomain: "atelier.example.com",
    newDomain: "atelier.example.org",
  });
  assert.equal(outcome.status, "gated");
  assert.match(outcome.message, /in live need a key stored here/);
  assert.match((outcome.detail ?? []).join("\n"), /hatchkit stripe org-key --mode live/);
  assert.match((outcome.detail ?? []).join("\n"), /test: no hatchkit-registered endpoint/);
});

_setStripeFetchForTests(undefined);
rmSync(root, { recursive: true, force: true });
const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  `\nstripe-setup: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`,
);
if (failed.length) process.exit(1);
