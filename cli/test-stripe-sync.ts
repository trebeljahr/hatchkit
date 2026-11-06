/**
 * `hatchkit add <project> paid-unlock` (files, unlocks.json edits) and
 * `hatchkit stripe sync` (Stripe products, prices, webhook). Stripe is an
 * in-memory fake; the keychain is the test runner's fixture store.
 *
 * Pinned here:
 *
 *   1. add writes the runtime once, refreshes hatchkit's files, never
 *      overwrites an edited one, and patches the starter's app.ts and
 *      Dockerfile once.
 *   2. Product edits use the runtime's own rules: price parsing, pay what
 *      you want, no pay-what-you-want subscription, a download needs files,
 *      --dry-run writes nothing.
 *   3. sync is idempotent: a second run writes nothing. A price change is
 *      a new Price that takes over the lookup key; the old one is archived.
 *      Nothing is deleted; removed products are reported, archived only on
 *      request.
 *   4. The webhook is created once and its secret kept; a lost secret is
 *      reported, recreated only on request.
 *   5. With an organization key every call carries Stripe-Context; a dry
 *      run sends no writes; a live run asks first and a "no" writes nothing.
 *   6. The webhook secret lands in .dev.vars (Worker, test) and never in
 *      --json output.
 *
 * Run: `pnpm --filter hatchkit run test:stripe-sync`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPaidUnlock, parseMajorAmount } from "./src/features/paid-unlock/index.ts";
import { type UnlockConfig, stripeLookupKey } from "./src/paid-unlock/core.ts";
import {
  _setConfirmForTests,
  _setStripeFetchForTests,
  runStripeCli,
} from "./src/provision/stripe-sync-cli.ts";
import { type StripeSyncInput, syncStripe, zoneOf } from "./src/provision/stripe-sync.ts";
import { SECRET_KEYS, getSecret, setSecret } from "./src/utils/secrets.ts";
import { fakeStripe } from "./test-support/fake-stripe.ts";

const results: Record<string, boolean> = {};
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results[name] = true;
  } catch (err) {
    results[name] = false;
    console.log(`\n  x ${name}\n    ${(err as Error).stack}\n`);
  }
}

const root = mkdtempSync(join(tmpdir(), "stripe-sync-"));
let n = 0;

function project(surfaces: "static" | "fullstack", extra: Record<string, unknown> = {}): string {
  const dir = join(root, `p${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".hatchkit.json"),
    `${JSON.stringify(
      {
        version: 5,
        cliVersion: "0.0.0",
        scaffoldedAt: "2026-11-07T00:00:00.000Z",
        name: "example",
        domain: "shop.example.com",
        features: [],
        mlServices: [],
        deployTarget: "existing",
        ports: { server: 5000, client: 3000 },
        surfaces,
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}

const quiet = <T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> => {
  const original = console.log;
  let out = "";
  console.log = (...args: unknown[]) => {
    out += `${args.join(" ")}\n`;
  };
  return fn()
    .then((value) => ({ value, out }))
    .finally(() => {
      console.log = original;
    });
};

// ── 1. add: runtime files ───────────────────────────────────────────────

await test("add writes the Worker once and never overwrites an edited file", () => {
  const dir = project("static");
  const first = applyPaidUnlock({ projectDir: dir });
  assert.ok(first.ok, first.errors.join("\n"));
  assert.equal(first.runtime, "worker");
  for (const file of [
    "src/core.ts",
    "src/index.ts",
    "src/unlocks.json",
    "wrangler.jsonc",
    "README.md",
    ".gitignore",
    "private/paid/README.txt",
  ])
    assert.ok(existsSync(join(dir, "workers", "unlock", file)), file);
  const wrangler = readFileSync(join(dir, "workers", "unlock", "wrangler.jsonc"), "utf-8");
  assert.doesNotMatch(wrangler, /__[A-Z]+__/);
  assert.match(
    wrangler,
    /"pattern": "shop\.example\.com\/api\/unlock\/\*", "zone_name": "example\.com"/,
  );
  assert.equal(
    JSON.parse(readFileSync(join(dir, "workers", "unlock", "src", "unlocks.json"), "utf-8"))
      .project,
    "example",
  );

  const again = applyPaidUnlock({ projectDir: dir });
  assert.deepEqual(again.written, []);
  assert.deepEqual(again.conflicted, []);

  const core = join(dir, "workers", "unlock", "src", "core.ts");
  writeFileSync(core, `${readFileSync(core, "utf-8")}\n// local change\n`);
  const edited = applyPaidUnlock({ projectDir: dir });
  assert.deepEqual(edited.conflicted, ["workers/unlock/src/core.ts"]);
  assert.match(readFileSync(core, "utf-8"), /local change/);

  const switched = applyPaidUnlock({ projectDir: dir, runtime: "server" });
  assert.equal(switched.ok, false);
});

await test("add mounts the server runtime in app.ts and the Dockerfile, once", () => {
  const dir = project("fullstack");
  const server = join(dir, "packages", "server");
  mkdirSync(join(server, "src"), { recursive: true });
  writeFileSync(join(server, "src", "index.ts"), "export {};\n");
  writeFileSync(join(server, "package.json"), "{}\n");
  writeFileSync(join(server, ".env.example"), "PORT=5000\n");
  writeFileSync(join(dir, "CLAUDE.md"), "# Example\n");
  writeFileSync(
    join(server, "src", "app.ts"),
    [
      'import helmet from "helmet";',
      'import { env, getTrustedOrigins } from "./config/env.js";',
      "export function createApp() {",
      "  app.use(helmet());",
      '  app.use(express.json({ limit: "100kb" }));',
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(server, "Dockerfile"),
    "COPY --from=build /prod/node_modules ./node_modules\nCMD x\n",
  );
  const first = applyPaidUnlock({ projectDir: dir });
  assert.ok(first.ok, first.errors.join("\n"));
  assert.equal(first.runtime, "server");
  const app = readFileSync(join(server, "src", "app.ts"), "utf-8");
  assert.ok(
    app.indexOf("app.use(createUnlockHandler());") < app.indexOf("app.use(express.json("),
    "before express.json()",
  );
  assert.match(app, /import \{ createUnlockHandler \} from "\.\/services\/unlock\/index\.js";/);
  assert.match(
    readFileSync(join(server, "Dockerfile"), "utf-8"),
    /COPY --from=build \/app\/packages\/server\/unlock-private \.\/unlock-private/,
  );
  assert.match(readFileSync(join(server, ".env.example"), "utf-8"), /UNLOCK_TOKEN_SECRET=/);
  assert.match(readFileSync(join(dir, "CLAUDE.md"), "utf-8"), /## Paid unlock/);
  const second = applyPaidUnlock({ projectDir: dir });
  assert.deepEqual(second.written, []);
  assert.equal(readFileSync(join(server, "src", "app.ts"), "utf-8"), app);
});

// ── 2. add: product edits ───────────────────────────────────────────────

await test("product flags follow the runtime's rules", () => {
  assert.equal(parseMajorAmount("9"), 900);
  assert.equal(parseMajorAmount("4.5"), 450);
  assert.equal(parseMajorAmount("4.505"), null);
  const dir = project("static");
  const added = applyPaidUnlock({
    projectDir: dir,
    key: "guide",
    name: "Field guide",
    kind: "download",
    price: "9",
    files: "guide.pdf:Field guide.pdf,extras.zip",
  });
  assert.ok(added.ok, added.errors.join("\n"));
  assert.equal(added.action, "added");
  assert.deepEqual(added.products.guide, {
    name: "Field guide",
    kind: "download",
    price: 900,
    files: [{ object: "guide.pdf", filename: "Field guide.pdf" }, { object: "extras.zip" }],
  });
  assert.ok(
    added.warnings.some((w) => w.includes("FILES")),
    "warns about the missing R2 binding",
  );
  assert.ok(added.warnings.some((w) => w.includes("refundPolicy")));

  const pwyw = applyPaidUnlock({
    projectDir: dir,
    key: "making-of",
    name: "Making of",
    kind: "page",
    min: "3",
    suggested: "8",
  });
  assert.deepEqual(pwyw.products["making-of"].price, { min: 300, preset: 800 });
  assert.ok(pwyw.warnings.some((w) => w.includes("private/paid/making-of/index.html")));

  const sub = applyPaidUnlock({ projectDir: dir, key: "making-of", interval: "month" });
  assert.equal(sub.ok, false);
  assert.match(sub.errors.join("\n"), /no pay-what-you-want for subscriptions/);

  const noFiles = applyPaidUnlock({
    projectDir: dir,
    key: "kit",
    name: "Kit",
    kind: "download",
    price: "5",
  });
  assert.equal(noFiles.ok, false);

  const before = readFileSync(join(dir, "workers", "unlock", "src", "unlocks.json"), "utf-8");
  const dry = applyPaidUnlock({ projectDir: dir, key: "guide", price: "12", dryRun: true });
  assert.equal(dry.action, "updated");
  assert.equal(
    readFileSync(join(dir, "workers", "unlock", "src", "unlocks.json"), "utf-8"),
    before,
  );

  const inactive = applyPaidUnlock({ projectDir: dir, key: "guide", active: false });
  assert.equal(inactive.products.guide.active, false);
  const removed = applyPaidUnlock({ projectDir: dir, key: "guide", remove: true });
  assert.equal(removed.action, "removed");
  assert.equal(removed.products.guide, undefined);
});

// ── 3–5. sync ───────────────────────────────────────────────────────────

const CONFIG: UnlockConfig = {
  project: "example",
  currency: "eur",
  products: {
    guide: { name: "Field guide", kind: "download", price: 900, files: [{ object: "guide.pdf" }] },
    "making-of": {
      name: "Making of",
      kind: "page",
      price: { min: 300, preset: 800 },
      description: "How it was made",
    },
    supporter: { name: "Supporter", kind: "page", price: 500, interval: "month" },
  },
};

function memorySecrets() {
  let value: { id: string; secret: string } | null = null;
  return {
    get: async () => value,
    set: async (v: { id: string; secret: string }) => {
      value = v;
    },
    peek: () => value,
  };
}

function input(
  stripe: ReturnType<typeof fakeStripe>,
  extra: Partial<StripeSyncInput> = {},
): StripeSyncInput {
  return {
    client: { secretKey: "sk_test_x", fetch: stripe.fetch },
    config: CONFIG,
    mode: "test",
    webhookUrl: null,
    secrets: memorySecrets(),
    ...extra,
  };
}

const writes = (stripe: ReturnType<typeof fakeStripe>) =>
  stripe.calls.filter((c) => c.method !== "GET");

await test("sync creates products and prices once; a second run writes nothing", async () => {
  const stripe = fakeStripe();
  const first = await syncStripe(input(stripe));
  assert.equal(first.writes, 6);
  assert.equal(stripe.products.get("hk_example_guide")?.name, "Field guide");
  assert.deepEqual(stripe.products.get("hk_example_guide")?.metadata, {
    hatchkit_project: "example",
    hatchkit_unlock: "guide",
  });
  const prices = [...stripe.prices.values()];
  const pwyw = prices.find((p) => p.lookup_key === stripeLookupKey("example", "making-of"));
  assert.deepEqual(pwyw?.custom_unit_amount, { minimum: 300, preset: 800, maximum: null });
  const sub = prices.find((p) => p.lookup_key === stripeLookupKey("example", "supporter"));
  assert.deepEqual(sub?.recurring, { interval: "month" });
  assert.ok(prices.every((p) => p.tax_behavior === "inclusive"));

  const callsBefore = writes(stripe).length;
  const second = await syncStripe(input(stripe));
  assert.equal(second.writes, 0);
  assert.equal(writes(stripe).length, callsBefore);
  assert.ok(second.steps.every((s) => s.action === "keep"));
});

await test("a price change moves the lookup key to a new Price and archives the old one", async () => {
  const stripe = fakeStripe();
  await syncStripe(input(stripe));
  const old = [...stripe.prices.values()].find(
    (p) => p.lookup_key === stripeLookupKey("example", "guide"),
  );
  const changed = {
    ...CONFIG,
    products: { ...CONFIG.products, guide: { ...CONFIG.products.guide, price: 1200 } },
  };
  const result = await syncStripe(input(stripe, { config: changed }));
  assert.equal(result.writes, 2);
  const now = [...stripe.prices.values()].find(
    (p) => p.lookup_key === stripeLookupKey("example", "guide"),
  );
  assert.equal(now?.unit_amount, 1200);
  assert.notEqual(now?.id, old?.id);
  assert.equal(stripe.prices.get(String(old?.id))?.active, false);
  assert.equal((await syncStripe(input(stripe, { config: changed }))).writes, 0);
});

await test("removed products are reported, archived only on request, never deleted", async () => {
  const stripe = fakeStripe();
  await syncStripe(input(stripe));
  const { guide: _removed, ...rest } = CONFIG.products;
  const smaller = { ...CONFIG, products: rest };
  const report = await syncStripe(input(stripe, { config: smaller }));
  const step = report.steps.find((s) => s.key === "guide");
  assert.equal(step?.action, "report");
  assert.equal(stripe.products.get("hk_example_guide")?.active, true);
  await syncStripe(input(stripe, { config: smaller, archiveRemoved: true }));
  assert.equal(stripe.products.get("hk_example_guide")?.active, false);
  assert.ok(!stripe.calls.some((c) => c.method === "DELETE"));
});

await test("the webhook is created once with its secret kept; a lost secret is only reported", async () => {
  const stripe = fakeStripe();
  const secrets = memorySecrets();
  const url = "https://shop.example.com/api/unlock/webhook";
  const first = await syncStripe(input(stripe, { mode: "live", webhookUrl: url, secrets }));
  assert.ok(first.webhook.createdSecret?.startsWith("whsec_"));
  assert.equal(secrets.peek()?.secret, first.webhook.createdSecret);
  const endpoint = [...stripe.webhooks.values()][0];
  assert.deepEqual(endpoint.enabled_events, [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
  ]);
  assert.equal(endpoint.api_version, "2025-03-31.basil");

  const second = await syncStripe(input(stripe, { mode: "live", webhookUrl: url, secrets }));
  assert.equal(second.writes, 0);
  assert.equal(second.webhook.createdSecret, undefined);
  assert.equal(stripe.webhooks.size, 1);

  const lost = await syncStripe(
    input(stripe, { mode: "live", webhookUrl: url, secrets: memorySecrets() }),
  );
  assert.equal(lost.writes, 0);
  assert.ok(lost.steps.some((s) => s.target === "webhook" && s.action === "report"));
  assert.equal(stripe.webhooks.size, 1);

  const fresh = memorySecrets();
  const recreated = await syncStripe(
    input(stripe, { mode: "live", webhookUrl: url, secrets: fresh, recreateWebhook: true }),
  );
  assert.ok(recreated.webhook.createdSecret);
  assert.equal(stripe.webhooks.size, 1);
  assert.notEqual([...stripe.webhooks.keys()][0], endpoint.id);

  (stripe.webhooks.values().next().value as Record<string, unknown>).enabled_events = [
    "checkout.session.completed",
  ];
  const repaired = await syncStripe(
    input(stripe, { mode: "live", webhookUrl: url, secrets: fresh }),
  );
  assert.ok(repaired.steps.some((s) => s.target === "webhook" && s.action === "update"));
});

await test("a dry run sends no writes; an org key sends Stripe-Context on every call", async () => {
  const stripe = fakeStripe();
  const dry = await syncStripe(
    input(stripe, { dryRun: true, webhookUrl: "https://shop.example.com/api/unlock/webhook" }),
  );
  assert.ok(dry.writes > 0);
  assert.deepEqual(writes(stripe), []);
  const org = fakeStripe();
  await syncStripe(
    input(org, { client: { secretKey: "sk_test_org", context: "acct_123", fetch: org.fetch } }),
  );
  assert.ok(org.calls.length > 0);
  assert.ok(org.calls.every((c) => c.headers["stripe-context"] === "acct_123"));
  assert.ok(org.calls.every((c) => c.headers["stripe-version"] === "2025-03-31.basil"));
});

// ── 5–6. the command ────────────────────────────────────────────────────

await test("stripe sync: project key, .dev.vars, --json without secrets", async () => {
  const dir = project("static");
  applyPaidUnlock({
    projectDir: dir,
    key: "guide",
    name: "Field guide",
    kind: "download",
    price: "9",
    files: "guide.pdf",
  });
  const stripe = fakeStripe();
  _setStripeFetchForTests(stripe.fetch);
  try {
    await assert.rejects(
      runStripeCli(["sync", dir, "--mode", "test"]),
      /No Stripe key for example/,
    );
    await setSecret(SECRET_KEYS.stripeProjectSecretKey("example", "test"), "rk_live_wrong");
    await assert.rejects(runStripeCli(["sync", dir, "--mode", "test"]), /live key, not test/);
    await setSecret(SECRET_KEYS.stripeProjectSecretKey("example", "test"), "sk_test_project");
    const { out } = await quiet(() =>
      runStripeCli([
        "sync",
        dir,
        "--mode",
        "test",
        "--webhook-url",
        "https://preview.example.com/api/unlock/webhook",
        "--json",
      ]),
    );
    const report = JSON.parse(out);
    assert.equal(report.writes, 3);
    assert.equal(report.secretWrittenTo, "workers/unlock/.dev.vars");
    assert.doesNotMatch(out, /whsec_/);
    const devVars = readFileSync(join(dir, "workers", "unlock", ".dev.vars"), "utf-8");
    assert.match(devVars, /^UNLOCK_WEBHOOK_SECRET=whsec_/m);
    assert.equal(
      await getSecret(SECRET_KEYS.stripeProjectUnlockWebhookSecret("example", "test")),
      devVars.trim().split("=")[1],
    );
    assert.ok(stripe.calls.every((c) => c.headers.authorization === "Bearer sk_test_project"));
  } finally {
    _setStripeFetchForTests(undefined);
  }
});

await test("stripe sync --mode live asks first; an org key needs and saves the account", async () => {
  const dir = project("static");
  applyPaidUnlock({
    projectDir: dir,
    key: "guide",
    name: "Field guide",
    kind: "download",
    price: "9",
    files: "guide.pdf",
  });
  const stripe = fakeStripe();
  _setStripeFetchForTests(stripe.fetch);
  const asked: string[] = [];
  _setConfirmForTests(async (message) => {
    asked.push(message);
    return false;
  });
  try {
    await setSecret(SECRET_KEYS.stripeOrgSecretKey("live"), "sk_live_org");
    await assert.rejects(
      runStripeCli(["sync", dir, "--mode", "live"]),
      /needs the project's Stripe account/,
    );
    const before = process.exitCode;
    await quiet(() => runStripeCli(["sync", dir, "--mode", "live", "--account", "acct_1Example"]));
    assert.equal(asked.length, 1);
    assert.match(asked[0], /Stripe LIVE \(organization key → acct_1Example\)/);
    assert.deepEqual(writes(stripe), [], "a no writes nothing");
    assert.equal(process.exitCode, 1);
    process.exitCode = before;
    assert.equal(JSON.parse(readFileSync(join(dir, ".hatchkit.json"), "utf-8")).stripe, undefined);

    _setConfirmForTests(async () => true);
    const { out } = await quiet(() =>
      runStripeCli(["sync", dir, "--mode", "live", "--account", "acct_1Example"]),
    );
    assert.ok(writes(stripe).length > 0);
    assert.ok(stripe.calls.every((c) => c.headers["stripe-context"] === "acct_1Example"));
    assert.equal(
      JSON.parse(readFileSync(join(dir, ".hatchkit.json"), "utf-8")).stripe.accounts.live,
      "acct_1Example",
    );
    assert.match(out, /wrangler secret put UNLOCK_WEBHOOK_SECRET/);
    assert.doesNotMatch(out, /whsec_/);
    assert.ok(
      !existsSync(join(dir, "workers", "unlock", ".dev.vars")),
      "live never goes to .dev.vars",
    );
    assert.equal(
      [...stripe.webhooks.values()][0].url,
      "https://shop.example.com/api/unlock/webhook",
    );

    const { out: again } = await quiet(() => runStripeCli(["sync", dir, "--mode", "live"]));
    assert.match(again, /Already in sync/);
  } finally {
    _setStripeFetchForTests(undefined);
    _setConfirmForTests(undefined);
  }
});

await test("Worker routes use the registrable domain as zone", () => {
  assert.equal(zoneOf("example.com"), "example.com");
  assert.equal(zoneOf("shop.example.com"), "example.com");
  assert.equal(zoneOf("example.co.uk"), "example.co.uk");
  assert.equal(zoneOf("shop.example.co.uk"), "example.co.uk");
});

await test("--json live needs --yes; an unused --account is not saved", async () => {
  const dir = project("static");
  applyPaidUnlock({
    projectDir: dir,
    key: "guide",
    name: "Field guide",
    kind: "download",
    price: "9",
    files: "guide.pdf",
  });
  const stripe = fakeStripe();
  _setStripeFetchForTests(stripe.fetch);
  try {
    await assert.rejects(runStripeCli(["sync", dir, "--mode", "live", "--json"]), /needs --yes/);
    await setSecret(SECRET_KEYS.stripeProjectSecretKey("example", "test"), "sk_test_project");
    await quiet(() => runStripeCli(["sync", dir, "--mode", "test", "--account", "acct_1Unused"]));
    assert.ok(writes(stripe).length > 0);
    assert.ok(stripe.calls.every((c) => c.headers["stripe-context"] === undefined));
    assert.equal(JSON.parse(readFileSync(join(dir, ".hatchkit.json"), "utf-8")).stripe, undefined);
  } finally {
    _setStripeFetchForTests(undefined);
  }
});

const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  `\nstripe-sync: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`,
);
if (failed.length) process.exit(1);
