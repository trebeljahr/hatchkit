// hatchkit audit cloudflare: diff rules, expected state, run windows, the
// command surface. Cloudflare is a fetch stub; the keychain is the test
// runner's fixture store. Every command run sets HATCHKIT_KEYCHAIN_ACCESS=deny
// and reads the audit token from env, the way the scheduled Action does.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every Cloudflare, R2 and SES call here goes through an injected fetch.
// Anything that reaches the global one is a bug: fail loudly, never send.
const POISONED_FETCH = (async (input: unknown) => {
  throw new Error(`Unexpected network access: ${String(input)}`);
}) as typeof fetch;
globalThis.fetch = POISONED_FETCH;

const config = await import("./src/config.js");
const { getStore, setCloudflareDeployTokenRecord } = config;
const { SECRET_KEYS, setSecret, deleteSecret, getSecret, getCloudflareToken } = await import(
  "./src/utils/secrets.js"
);
const { RunLedger } = await import("./src/utils/run-ledger.js");
const audit = await import("./src/audit/cloudflare.js");
const { diffCloudflareAccount, inRunWindow, parseExpected, auditFailed, DEFAULT_OAUTH_APPS } =
  audit;
const expectedMod = await import("./src/audit/expected.js");
const { buildLocalExpected, parseAcceptArg, updateAccepted } = expectedMod;
const uses = await import("./src/audit/operator-uses.js");
const command = await import("./src/audit/command.js");
const { runAuditCommand } = command;
const signed = await import("./src/audit/signed-state.js");
const ses = await import("./src/audit/ses-send.js");
const worker = await import("./src/audit/worker.js");
const deploy = await import("./src/audit/deploy.js");

type Snapshot = import("./src/audit/cloudflare.js").CloudflareSnapshot;
type Expected = import("./src/audit/cloudflare.js").CloudflareExpected;

const ACCOUNT = "a".repeat(32);
const OPERATOR = "0".repeat(31) + "1";
const AUDIT_SELF = "0".repeat(31) + "2";
const CI_TOKEN = "c".repeat(32);
const R2_TOKEN = "d".repeat(32);
const ROGUE = "e".repeat(32);
const NOW = new Date("2026-10-19T12:00:00Z");
const SINCE = new Date(NOW.getTime() - 25 * 3600_000);
const store = getStore();

const failures: string[] = [];
async function test(label: string, fn: () => Promise<void> | void) {
  store.delete("cloudflareAudit" as never);
  store.delete("cloudflareDeployTokens" as never);
  store.delete("providers.cloudflare" as never);
  store.delete("defaults" as never);
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).stack ?? err}`);
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

const ok = <T>(items: T) => ({ ok: true as const, items });

function expected(over: Partial<Expected> = {}): Expected {
  return {
    version: 1,
    accountId: ACCOUNT,
    generatedAt: NOW.toISOString(),
    operatorTokenId: OPERATOR,
    tokens: [
      { id: CI_TOKEN, kind: "worker", note: "CI token of Worker site" },
      { id: R2_TOKEN, kind: "r2" },
    ],
    workers: ["site"],
    buckets: ["site-assets"],
    zones: ["example.com"],
    emailDestinations: ["rico@example.org"],
    members: ["rico@example.org"],
    oauthClients: [],
    oauthApps: [...DEFAULT_OAUTH_APPS],
    runs: [{ start: "2026-10-19T09:00:00Z", end: "2026-10-19T09:20:00Z" }],
    ...over,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    auditTokenId: AUDIT_SELF,
    accountTokens: ok([
      { id: OPERATOR, name: "hatchkit-cloudflare", status: "active" },
      { id: CI_TOKEN, name: "hatchkit-site-worker", status: "active" },
      { id: R2_TOKEN, name: "hatchkit-site", status: "active" },
    ]),
    userTokens: ok([{ id: AUDIT_SELF, name: "hatchkit-audit", status: "active" }]),
    auditLog: ok([]),
    workers: ok(["site"]),
    buckets: ok(["site-assets"]),
    zones: ok([{ id: "z1", name: "example.com" }]),
    emailDestinations: ok(["Rico@example.org"]),
    emailRules: ok([
      {
        zone: "example.com",
        rules: [
          {
            name: "hi",
            enabled: true,
            actions: [{ type: "forward", value: ["rico@example.org"] }],
          },
        ],
        errors: [],
      },
    ]),
    members: ok(["rico@example.org"]),
    oauthClients: ok([]),
    ...over,
  };
}

const diff = (snap: Snapshot, exp: Expected = expected()) =>
  diffCloudflareAccount({ snapshot: snap, expected: exp, now: NOW, since: SINCE });
const alerts = (r: ReturnType<typeof diff>) => r.findings.filter((f) => f.severity === "alert");

console.log("1. tokens:");
await test("a clean account has no findings and passes", () => {
  const r = diff(snapshot());
  assert.deepEqual(r.findings, []);
  assert.equal(auditFailed(r), false);
  assert.ok(r.checks.every((c) => c.status === "ok"));
});
await test("an unknown active token is an alert, with its grants and creator", () => {
  const snap = snapshot();
  if (snap.accountTokens.ok)
    snap.accountTokens.items.push({
      id: ROGUE,
      name: "caddy",
      status: "active",
      creator_email_at_creation: "x@evil.test",
      policies: [{ permission_groups: [{ name: "DNS Write" }] }],
    });
  const r = diff(snap);
  assert.equal(alerts(r).length, 1);
  assert.match(alerts(r)[0].detail, /DNS Write/);
  assert.match(alerts(r)[0].detail, /x@evil\.test/);
  assert.match(alerts(r)[0].hint ?? "", new RegExp(`accept 'token:${ROGUE}=<why>'`));
  assert.equal(auditFailed(r), true);
});
await test("a name never vouches for a token: a second hatchkit-site-worker is an alert", () => {
  const snap = snapshot();
  if (snap.accountTokens.ok)
    snap.accountTokens.items.push({ id: ROGUE, name: "hatchkit-site-worker", status: "active" });
  assert.equal(alerts(diff(snap)).length, 1);
});
await test("unknown user tokens are checked too; a disabled one is still an alert", () => {
  const snap = snapshot({
    userTokens: ok([
      { id: AUDIT_SELF, name: "hatchkit-audit", status: "active" },
      { id: ROGUE, name: "hatchkit-dns", status: "active" },
      { id: "f".repeat(32), name: "old", status: "disabled" },
    ]),
  });
  const r = diff(snap);
  assert.deepEqual(
    r.findings.map((f) => [f.severity, f.subject.split(" ")[0]]),
    [
      ["alert", "hatchkit-dns"],
      ["alert", "old"],
    ],
  );
});
await test("hatchkit-terraform-* is info under 1 h and an alert after", () => {
  const young = {
    id: "1".repeat(32),
    name: "hatchkit-terraform-site-20261019T113000Z",
    status: "active",
    issued_on: "2026-10-19T11:30:00Z",
  };
  const old = {
    id: "2".repeat(32),
    name: "hatchkit-terraform-site-20261019T090000Z",
    status: "active",
    issued_on: "2026-10-19T09:00:00Z",
  };
  const snap = snapshot();
  if (snap.accountTokens.ok) snap.accountTokens.items.push(young, old);
  const r = diff(snap);
  assert.equal(r.findings.find((f) => f.subject.startsWith(young.name))?.severity, "info");
  assert.equal(r.findings.find((f) => f.subject.startsWith(old.name))?.severity, "alert");
});
await test("without a recorded operator id, hatchkit-cloudflare is an alert that names the accept command", () => {
  const r = diff(snapshot(), expected({ operatorTokenId: undefined }));
  assert.equal(alerts(r).length, 1);
  assert.match(alerts(r)[0].hint ?? "", new RegExp(`accept operator:${OPERATOR}`));
});

console.log("2. audit log:");
const entry = (actor: Record<string, string>, time = "2026-10-19T09:10:00Z") => ({
  action: { type: "update", time },
  actor: { type: "user", ...actor },
  resource: { product: "dns_records" },
  zone: { name: "example.com" },
});
await test("the operator inside a run window is info, outside is an alert with IPs", () => {
  const r = diff(
    snapshot({
      auditLog: ok([
        entry({
          context: "api_token",
          token_id: OPERATOR,
          token_name: "hatchkit-cloudflare",
          ip_address: "192.0.2.1",
        }),
        entry(
          {
            context: "api_token",
            token_id: OPERATOR,
            token_name: "hatchkit-cloudflare",
            ip_address: "198.51.100.7",
          },
          "2026-10-19T03:00:00Z",
        ),
      ]),
    }),
  );
  const a = alerts(r);
  assert.equal(a.length, 1);
  assert.match(a[0].detail, /outside every recorded hatchkit run/);
  assert.match(a[0].detail, /198\.51\.100\.7/);
  assert.ok(r.findings.some((f) => f.severity === "info" && /inside a recorded/.test(f.detail)));
});
await test("dashboard is info; Global API Key, unknown token and unknown OAuth app are alerts", () => {
  const r = diff(
    snapshot({
      auditLog: ok([
        entry({ context: "dash", email: "rico@example.org" }),
        entry({ context: "api_key", email: "rico@example.org" }),
        entry({ context: "api_token", token_id: ROGUE, token_name: "caddy" }),
        entry({ context: "oauth", token_name: "Wrangler" }),
        entry({ context: "oauth", token_name: "Totally Legit App" }),
        entry({ context: "api_token", token_id: CI_TOKEN, token_name: "hatchkit-site-worker" }),
        { ...entry({}), actor: { type: "system" } },
      ]),
    }),
  );
  assert.deepEqual(
    alerts(r)
      .map((f) => f.subject)
      .sort(),
    [
      "Global API Key of rico@example.org",
      "OAuth app Totally Legit App",
      `unknown token caddy (${ROGUE})`,
    ],
  );
  assert.equal(r.findings.filter((f) => f.severity === "info").length, 4);
});
await test("entries of one actor are grouped into one finding", () => {
  const many = Array.from({ length: 5 }, (_, i) =>
    entry({ context: "api_token", token_id: ROGUE, token_name: "x" }, `2026-10-19T0${i}:00:00Z`),
  );
  const r = diff(snapshot({ auditLog: ok(many) }));
  assert.equal(alerts(r).length, 1);
  assert.match(alerts(r)[0].detail, /^a token hatchkit does not know made changes\. 5 change/);
});
await test("run windows: slack, open windows and bad timestamps", () => {
  const runs = [
    { start: "2026-10-19T09:00:00Z", end: "2026-10-19T09:20:00Z" },
    { start: "2026-10-19T11:00:00Z" },
  ];
  assert.equal(inRunWindow("2026-10-19T08:56:00Z", runs), true);
  assert.equal(inRunWindow("2026-10-19T09:24:59Z", runs), true);
  assert.equal(inRunWindow("2026-10-19T09:26:00Z", runs), false);
  assert.equal(inRunWindow("2026-10-19T12:59:00Z", runs), true, "open window counts 2 h");
  assert.equal(inRunWindow("2026-10-19T13:10:00Z", runs), false);
  const long = [{ start: "2026-10-15T00:00:00Z", end: "2026-10-19T12:00:00Z" }];
  assert.equal(inRunWindow("2026-10-15T01:00:00Z", long), true);
  assert.equal(
    inRunWindow("2026-10-18T00:00:00Z", long),
    false,
    "a days-long process vouches for 2 h only",
  );
  assert.equal(inRunWindow(undefined, runs), false);
});

console.log("3. inventory:");
await test("unknown Worker, bucket, zone, destination, member, OAuth client are alerts", () => {
  const r = diff(
    snapshot({
      workers: ok(["site", "miner"]),
      buckets: ok(["site-assets", "exfil"]),
      zones: ok([
        { id: "z1", name: "example.com" },
        { id: "z2", name: "evil.test" },
      ]),
      emailDestinations: ok(["rico@example.org", "spy@evil.test"]),
      members: ok(["rico@example.org", "mallory@evil.test"]),
      oauthClients: ok([{ id: "client-1", name: "sneaky" }]),
    }),
  );
  assert.deepEqual(
    alerts(r)
      .map((f) => `${f.check}:${f.subject}`)
      .sort(),
    [
      "buckets:exfil",
      "email-destinations:spy@evil.test",
      "members:mallory@evil.test",
      "oauth-clients:sneaky (client-1)",
      "workers:miner",
      "zones:evil.test",
    ],
  );
});
await test("an Email Routing rule forwarding to an unknown address or Worker is an alert", () => {
  const r = diff(
    snapshot({
      emailRules: ok([
        {
          zone: "example.com",
          rules: [
            {
              name: "copy",
              enabled: true,
              matchers: [{ value: "hi@example.com" }],
              actions: [{ type: "forward", value: ["spy@evil.test"] }],
            },
            { name: "catch-all", enabled: true, actions: [{ type: "worker", value: ["miner"] }] },
            {
              name: "off",
              enabled: false,
              actions: [{ type: "forward", value: ["spy@evil.test"] }],
            },
            { name: "drop", enabled: true, actions: [{ type: "drop" }] },
          ],
          errors: [],
        },
      ]),
    }),
  );
  assert.deepEqual(
    alerts(r).map((f) => f.subject),
    ["example.com: copy (hi@example.com)", "example.com: catch-all"],
  );
});

await test("an OAuth client named after an accepted id still alerts; matching is by id", () => {
  const r = diff(
    snapshot({ oauthClients: ok([{ id: "new-client", name: "client-1" }]) }),
    expected({ oauthClients: ["client-1"] }),
  );
  assert.equal(alerts(r).length, 1);
});
await test("a per-zone rules read error other than 404 fails the run", () => {
  const r = diff(
    snapshot({
      emailRules: ok([
        {
          zone: "example.com",
          rules: [],
          errors: ["GET /zones/z1/email/routing/rules: HTTP 500 boom"],
        },
        {
          zone: "other.com",
          rules: [],
          errors: ["GET /zones/z2/email/routing/rules: HTTP 404 not enabled"],
        },
      ]),
    }),
  );
  assert.deepEqual(
    r.findings.map((f) => `${f.severity}:${f.subject}`),
    ["alert:example.com", "info:other.com"],
  );
  assert.equal(auditFailed(r), true);
});
await test("hints shell-quote attacker-chosen values", () => {
  const r = diff(
    snapshot({ emailDestinations: ok(["rico@example.org", "x&touch${IFS}pwned|cat&@e.co"]) }),
  );
  assert.match(alerts(r)[0].hint ?? "", /accept 'email:x&touch\$\{IFS\}pwned\|cat&@e\.co'$/);
  assert.equal(audit.shellQuote("it's"), `'it'\\''s'`);
  assert.equal(audit.shellQuote("worker:site-1"), "worker:site-1");
});

console.log("4. check health:");
await test("a required list that fails is an error and fails the run", () => {
  const r = diff(
    snapshot({ accountTokens: { ok: false, error: "GET /tokens: HTTP 403", status: 403 } }),
  );
  assert.equal(r.checks.find((c) => c.check === "tokens")?.status, "error");
  assert.equal(r.summary.errors, 1);
  assert.equal(auditFailed(r), true);
});
await test("an empty Workers list while hatchkit knows Workers is an error, not all clear", () => {
  const r = diff(snapshot({ workers: ok([]) }));
  assert.equal(r.checks.find((c) => c.check === "workers")?.status, "error");
  assert.equal(auditFailed(r), true);
});
await test("the optional OAuth-clients list is skipped, not failed", () => {
  const r = diff(snapshot({ oauthClients: { ok: false, error: "HTTP 403", status: 403 } }));
  assert.equal(r.checks.find((c) => c.check === "oauth-clients")?.status, "skipped");
  assert.equal(auditFailed(r), false);
});

await test("a list longer than the page cap fails instead of reading as complete", async () => {
  const reader = new audit.CloudflareReader(
    "t",
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: [{ id: "x" }],
          result_info: { cursor: `c${Math.random()}` },
        }),
        {
          status: 200,
        },
      ),
  );
  await assert.rejects(reader.cursor("/accounts/a/logs/audit", {}), /more than 50 pages/);
  const pager = new audit.CloudflareReader(
    "t",
    async () =>
      new Response(
        JSON.stringify({ success: true, result: [{ id: "x" }], result_info: { total_pages: 999 } }),
        { status: 200 },
      ),
  );
  await assert.rejects(pager.pages("/accounts/a/tokens", {}, 1), /more than 50 pages/);
});

console.log("5. expected state:");
await test("parseExpected rejects foreign JSON and defaults the OAuth apps", () => {
  assert.throws(() => parseExpected("{}", "x"), /not hatchkit expected-state/);
  assert.throws(() => parseExpected("nope", "x"), /not valid JSON/);
  const e = parseExpected(JSON.stringify({ version: 1, accountId: ACCOUNT }), "x");
  assert.deepEqual(e.oauthApps, [...DEFAULT_OAUTH_APPS]);
  assert.deepEqual(e.tokens, []);
});
await test("accept takes tokens by id only and keeps notes; forget removes", () => {
  assert.throws(() => parseAcceptArg("token:caddy"), /32-hex id/);
  assert.throws(() => parseAcceptArg("thing:x"), /kind one of/);
  updateAccepted([`token:${ROGUE}=caddy local ACME`, "worker:docs", `operator:${OPERATOR}`]);
  let a = expectedMod.getAuditConfig().accepted;
  assert.equal(a?.tokens?.[ROGUE], "caddy local ACME");
  assert.deepEqual(a?.workers, ["docs"]);
  assert.equal(a?.operator, OPERATOR);
  updateAccepted(["worker:docs", `token:${ROGUE}`], true);
  a = expectedMod.getAuditConfig().accepted;
  assert.deepEqual(a?.workers, []);
  assert.deepEqual(a?.tokens, {});
});
await test("buildLocalExpected reads records, ledgers, manifests, defaults and accepted entries", () => {
  const roots = mkdtempSync(join(tmpdir(), "hk-audit-roots-"));
  const proj = join(roots, "site");
  mkdirSync(proj);
  writeFileSync(
    join(proj, ".hatchkit.json"),
    JSON.stringify({
      version: 1,
      name: "site",
      domain: "app.example.com",
      clientWorker: "site-client",
      s3Buckets: { assets: { name: "site-assets", publicUrl: "https://x", tokenId: R2_TOKEN } },
      integrations: {
        email: { domain: "example.com", configuredAt: "x", destinationEmail: "Rico@Example.org" },
      },
    }),
  );
  store.set("providers.cloudflare", { status: "configured", accountId: ACCOUNT });
  store.set("defaults", { forwardingEmail: "me@example.net", rootDomain: "example.net" });
  setCloudflareDeployTokenRecord({
    worker: "docs",
    workerId: "9".repeat(32),
    accountId: ACCOUNT,
    tokenId: CI_TOKEN,
    tokenName: "hatchkit-docs-worker",
    scope: "worker",
    repo: "o/docs",
    mintedAt: "x",
  });
  const ledger = RunLedger.start("site");
  ledger.record({ kind: "r2Bucket", bucketName: "site-state", accountId: ACCOUNT });
  ledger.record({
    kind: "r2Token",
    tokenId: "7".repeat(32),
    accountId: ACCOUNT,
    audience: "account",
  });
  updateAccepted([`token:${ROGUE}=caddy`, "zone:other.org", `operator:${OPERATOR}`]);
  const usesFile = join(roots, "uses.jsonl");
  writeFileSync(
    usesFile,
    `${JSON.stringify({ pid: 1, start: "2026-10-19T09:00:00Z" })}\n${JSON.stringify({ pid: 1, end: "2026-10-19T09:20:00Z" })}\n`,
  );
  try {
    const e = buildLocalExpected({ now: NOW, projectRoots: [roots], operatorUsesPath: usesFile });
    assert.equal(e.accountId, ACCOUNT);
    assert.equal(e.operatorTokenId, OPERATOR);
    assert.deepEqual(e.tokens.map((t) => `${t.kind}:${t.id[0]}`).sort(), [
      "accepted:e",
      "r2:7",
      "r2:d",
      "worker:c",
    ]);
    assert.deepEqual(e.workers, ["docs", "site-client"]);
    assert.deepEqual(e.buckets, ["site-assets", "site-state"]);
    for (const zone of ["app.example.com", "example.com", "example.net", "other.org"])
      assert.ok(e.zones.includes(zone), zone);
    assert.ok(!e.zones.includes("com"));
    assert.deepEqual(e.emailDestinations, ["me@example.net", "rico@example.org"]);
    assert.deepEqual(e.runs, [{ start: "2026-10-19T09:00:00Z", end: "2026-10-19T09:20:00Z" }]);
    assert.doesNotThrow(() => parseExpected(JSON.stringify(e), "built"));
  } finally {
    ledger.delete();
  }
});

console.log("6. operator run windows:");
await test("reading the operator slot records one window per process; legacy slots record none", async () => {
  const path = uses.operatorUsesPath();
  writeFileSync(path, `${JSON.stringify({ pid: 9, start: "2026-08-01T00:00:00Z" })}\n`);
  uses.resetOperatorUseForTests();
  await setSecret(SECRET_KEYS.dnsCloudflareToken, "legacy");
  await getCloudflareToken("dns");
  assert.equal(
    readFileSync(path, "utf-8").trim().split("\n").length,
    1,
    "legacy slot records nothing",
  );
  await setSecret(SECRET_KEYS.cloudflareOperatorToken, "operator-value");
  await getCloudflareToken("dns");
  await getCloudflareToken("r2");
  const lines = readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 1, "the 2026-08 line is pruned and one start is added");
  assert.equal(lines[0].pid, process.pid);
  assert.ok(!readFileSync(path, "utf-8").includes("operator-value"), "never the token value");
  await deleteSecret(SECRET_KEYS.cloudflareOperatorToken);
  await deleteSecret(SECRET_KEYS.dnsCloudflareToken);
});
await test("readOperatorRuns pairs start/end by pid and keeps open windows", () => {
  const file = join(mkdtempSync(join(tmpdir(), "hk-uses-")), "u.jsonl");
  writeFileSync(
    file,
    [
      { pid: 1, start: "2026-10-19T09:00:00Z" },
      { pid: 2, start: "2026-10-19T09:05:00Z" },
      { pid: 1, end: "2026-10-19T09:10:00Z" },
      { pid: 3, start: "2026-10-10T00:00:00Z" },
      { pid: 3, end: "2026-10-10T00:10:00Z" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n{torn",
  );
  assert.deepEqual(uses.readOperatorRuns(new Date("2026-10-18T00:00:00Z"), file), [
    { start: "2026-10-19T09:00:00Z", end: "2026-10-19T09:10:00Z" },
    { start: "2026-10-19T09:05:00Z" },
  ]);
});

console.log("7. command:");
type Call = { url: URL; method: string; auth: string };
function fakeCloudflare(over: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const env = (result: unknown, info?: unknown) =>
    new Response(
      JSON.stringify({ success: true, errors: [], messages: [], result, result_info: info }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  const fail = (status: number) =>
    new Response(
      JSON.stringify({
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
      }),
      { status },
    );
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      auth: String((init?.headers as Record<string, string>)?.Authorization),
    });
    const path = url.pathname.replace("/client/v4", "");
    if (path in over) {
      const v = over[path];
      return typeof v === "number" ? fail(v) : env(v);
    }
    const a = `/accounts/${ACCOUNT}`;
    switch (path) {
      case "/user/tokens/verify":
        return env({ id: AUDIT_SELF, status: "active" });
      case `${a}/tokens`:
        // Two pages: per_page 50 with total_pages 2.
        return url.searchParams.get("page") === "1"
          ? env([{ id: OPERATOR, name: "hatchkit-cloudflare", status: "active" }], {
              page: 1,
              total_pages: 2,
            })
          : env([{ id: ROGUE, name: "sneaky", status: "active" }], { page: 2, total_pages: 2 });
      case "/user/tokens":
        return env([{ id: AUDIT_SELF, name: "hatchkit-audit", status: "active" }], {
          total_pages: 1,
        });
      case `${a}/logs/audit`:
        return url.searchParams.get("cursor")
          ? env([], {})
          : env(
              [
                entry(
                  { context: "api_token", token_id: OPERATOR, token_name: "hatchkit-cloudflare" },
                  "2026-10-19T03:00:00Z",
                ),
              ],
              { cursor: "next" },
            );
      case `${a}/workers/scripts`:
        return env([{ id: "site" }]);
      case `${a}/r2/buckets`:
        return env({ buckets: [{ name: "site-assets" }] });
      case "/zones":
        return env([{ id: "z1", name: "example.com" }], { total_pages: 1 });
      case `${a}/email/routing/addresses`:
        return env([{ email: "rico@example.org" }], { total_pages: 1 });
      case "/zones/z1/email/routing/rules":
        return env([], { total_pages: 1 });
      case "/zones/z1/email/routing/rules/catch_all":
        return env({ name: "", enabled: true, actions: [{ type: "drop" }] });
      case `${a}/members`:
        return env([{ user: { email: "rico@example.org" } }], { total_pages: 1 });
      case `${a}/oauth_clients`:
        return fail(403);
      default:
        return fail(404);
    }
  };
  return { fetch, calls };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const original = console.log;
  let out = "";
  console.log = (...args: unknown[]) => {
    out += `${args.join(" ")}\n`;
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return out;
}

const envWith = (exp: Expected) => ({
  HATCHKIT_CLOUDFLARE_AUDIT_TOKEN: "audit-token-value",
  HATCHKIT_CLOUDFLARE_EXPECTED: JSON.stringify(exp),
});

async function withDeny<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env.HATCHKIT_KEYCHAIN_ACCESS;
  process.env.HATCHKIT_KEYCHAIN_ACCESS = "deny";
  try {
    return await fn();
  } finally {
    process.env.HATCHKIT_KEYCHAIN_ACCESS = before;
  }
}

await test("--json, only GETs, only the audit token, paginated, exit 1 on alerts", async () => {
  await setSecret(SECRET_KEYS.cloudflareOperatorToken, "operator-value");
  const cf = fakeCloudflare();
  process.exitCode = 0;
  const out = await withDeny(() =>
    captureStdout(() =>
      runAuditCommand(["cloudflare", "--json"], {
        fetch: cf.fetch,
        now: () => NOW,
        env: envWith(expected({ runs: [] })),
      }),
    ),
  );
  const report = JSON.parse(out);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
  assert.ok(
    cf.calls.every((c) => c.method === "GET"),
    "read-only",
  );
  assert.ok(
    cf.calls.every((c) => c.auth === "Bearer audit-token-value"),
    "never the operator token",
  );
  assert.ok(
    cf.calls.some((c) => c.url.searchParams.get("page") === "2"),
    "token list page 2 read",
  );
  assert.ok(
    cf.calls.some((c) => c.url.searchParams.get("cursor") === "next"),
    "audit log cursor followed",
  );
  assert.ok(
    cf.calls.some((c) => c.url.searchParams.get("action_type.not") === "view"),
    "views filtered on the server",
  );
  assert.equal(report.auditTokenId, AUDIT_SELF);
  assert.deepEqual(
    report.findings
      .filter((f: { severity: string }) => f.severity === "alert")
      .map((f: { check: string }) => f.check)
      .sort(),
    ["audit-log", "tokens"],
  );
  assert.equal(
    report.checks.find((c: { check: string }) => c.check === "oauth-clients").status,
    "skipped",
  );
  await deleteSecret(SECRET_KEYS.cloudflareOperatorToken);
});
await test("no audit token under keychain deny: a clear error and no request", async () => {
  const cf = fakeCloudflare();
  store.set("providers.cloudflare", { status: "configured", accountId: ACCOUNT });
  await assert.rejects(
    withDeny(() =>
      runAuditCommand(["cloudflare"], {
        fetch: cf.fetch,
        env: { HATCHKIT_PROJECTS_ROOTS: "/nonexistent" },
      }),
    ),
    /Could not read the audit token/,
  );
  assert.equal(cf.calls.length, 0);
});
await test("the operator token is never a fallback for a missing audit token", async () => {
  await setSecret(SECRET_KEYS.cloudflareOperatorToken, "operator-value");
  store.set("providers.cloudflare", { status: "configured", accountId: ACCOUNT });
  const cf = fakeCloudflare();
  // Keychain allowed here on purpose: the audit slot is empty, the operator slot is not.
  await assert.rejects(
    runAuditCommand(["cloudflare"], {
      fetch: cf.fetch,
      env: { HATCHKIT_PROJECTS_ROOTS: "/nonexistent" },
    }),
    /No Cloudflare audit token/,
  );
  assert.equal(cf.calls.length, 0);
  await deleteSecret(SECRET_KEYS.cloudflareOperatorToken);
});
await test("bad flags are rejected before any request", async () => {
  const cf = fakeCloudflare();
  for (const argv of [
    ["cloudflare", "--hours", "-1"],
    ["cloudflare", "--nope"],
    ["cloudflare", "--markdown"],
    ["cloudflare", "accept"],
    ["cloudflare", "publish", "--repo", "x"],
    ["cloudflare", "deploy", "--from"],
    ["cloudflare", "workflow"],
  ]) {
    await assert.rejects(
      withDeny(() => runAuditCommand(argv, { fetch: cf.fetch, env: envWith(expected()) })),
      undefined,
      argv.join(" "),
    );
  }
  await assert.rejects(runAuditCommand(["gcp"]), /Usage:/);
  assert.equal(cf.calls.length, 0);
});

console.log("8. output, signing, SES:");
await test("text output strips control, newline and bidi characters", () => {
  const snap = snapshot();
  if (snap.accountTokens.ok)
    snap.accountTokens.items.push({
      id: ROGUE,
      name: "x\n  ✓ tokens — nothing unexpected",
      status: "active",
    });
  const out = audit.renderAuditText(diff(snap));
  assert.ok(!out.includes("x\n  ✓ tokens — nothing"), "no forged line");
  assert.equal(audit.printable("ok\u001b[31mred\u0007"), "ok?[31mred?");
  assert.equal(audit.printable("a\n  ✓ tokens‮"), "a?  ✓ tokens?");
});
await test("signed envelopes verify, and reject tampering, a wrong kind or a wrong key", async () => {
  const key = signed.newHmacKey();
  const env = await signed.signEnvelope(key, "run", { start: "2026-10-19T09:00:00Z" });
  assert.deepEqual(await signed.openEnvelope(key, "run", env), { start: "2026-10-19T09:00:00Z" });
  const forged = env.replace("09:00:00", "03:00:00");
  await assert.rejects(signed.openEnvelope(key, "run", forged), /bad signature/);
  await assert.rejects(signed.openEnvelope(key, "expected", env), /not a signed expected/);
  await assert.rejects(signed.openEnvelope(signed.newHmacKey(), "run", env), /bad signature/);
  await assert.rejects(signed.openEnvelope(key, "run", "{}"), /not a signed run/);
  await assert.rejects(signed.signEnvelope("abcd", "run", {}), /at least 32 bytes/);
});
await test("SigV4 matches AWS's published get-vanilla test vector", async () => {
  const auth = await ses.sigV4Authorization({
    method: "GET",
    host: "example.amazonaws.com",
    path: "/",
    headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
    body: "",
    service: "service",
    region: "us-east-1",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    amzDate: "20150830T123600Z",
  });
  assert.equal(
    auth,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});
await test("SES SendEmail: one signed POST to the region's v2 endpoint with a text body", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const r = await ses.sendSesTextMail({
    credentials: {
      accessKeyId: "AKIAEXAMPLEEXAMPLE",
      secretAccessKey: "s",
      region: "eu-central-1",
    },
    from: "audit@example.com",
    to: "rico@example.org",
    subject: "hi",
    text: "body",
    now: NOW,
    fetch: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ MessageId: "m-1" }), { status: 200 });
    },
  });
  assert.equal(r.messageId, "m-1");
  assert.equal(seen[0].url, "https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails");
  const headers = seen[0].init?.headers as Record<string, string>;
  assert.match(
    headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEEXAMPLE\/20261019\/eu-central-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
  );
  const body = JSON.parse(String(seen[0].init?.body));
  assert.deepEqual(body.Destination, { ToAddresses: ["rico@example.org"] });
  assert.equal(body.Content.Simple.Body.Text.Data, "body");
  await assert.rejects(
    ses.sendSesTextMail({
      credentials: { accessKeyId: "a", secretAccessKey: "s", region: "eu-central-1" },
      from: "a@b.c",
      to: "d@e.f",
      subject: "s",
      text: "t",
      fetch: async () =>
        new Response(JSON.stringify({ message: "Email address is not verified." }), {
          status: 400,
        }),
    }),
    /HTTP 400 Email address is not verified/,
  );
});

console.log("9. audit Worker:");
class FakeBucket {
  objects = new Map<string, { text: string; uploaded: Date }>();
  async get(key: string) {
    const o = this.objects.get(key);
    return o ? { text: async () => o.text } : null;
  }
  async put(key: string, value: string) {
    this.objects.set(key, { text: value, uploaded: NOW });
  }
  async list(opts: { prefix?: string }) {
    return {
      objects: [...this.objects.entries()]
        .filter(([k]) => k.startsWith(opts.prefix ?? ""))
        .map(([key, o]) => ({ key, uploaded: o.uploaded })),
      truncated: false,
    };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
}
const HMAC = "ab".repeat(32);
async function workerEnv(
  exp: Expected | null,
  runs: Array<{ key: string; run: unknown; uploaded?: Date; key2?: string }> = [],
) {
  const bucket = new FakeBucket();
  if (exp)
    await bucket.put(
      "expected.json",
      await signed.signEnvelope(HMAC, "expected", { ...exp, runs: [] }),
    );
  for (const r of runs) {
    await bucket.put(r.key, await signed.signEnvelope(r.key2 ?? HMAC, "run", r.run));
    if (r.uploaded) bucket.objects.get(r.key)!.uploaded = r.uploaded;
  }
  const env = {
    AUDIT_BUCKET: bucket,
    ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_AUDIT_TOKEN: "audit-token-value",
    EXPECTED_HMAC_KEY: HMAC,
    SES_ACCESS_KEY_ID: "AKIAEXAMPLEEXAMPLE",
    SES_SECRET_ACCESS_KEY: "secret",
    SES_REGION: "eu-central-1",
    MAIL_FROM: "audit@example.com",
    MAIL_TO: "rico@example.org",
  };
  return { env, bucket };
}
function workerFetch(over: Record<string, unknown> = {}) {
  const cf = fakeCloudflare(over);
  const mails: Array<{ subject: string; text: string }> = [];
  const fetch = async (input: string, init?: RequestInit) => {
    if (input.startsWith("https://email.")) {
      const body = JSON.parse(String(init?.body));
      mails.push({
        subject: body.Content.Simple.Subject.Data,
        text: body.Content.Simple.Body.Text.Data,
      });
      return new Response(JSON.stringify({ MessageId: `m-${mails.length}` }), { status: 200 });
    }
    return cf.fetch(input, init);
  };
  return { fetch, mails, calls: cf.calls };
}
// The default fake account: the operator at 03:00 (outside any window) and an unknown token.
const cleanAccount = {
  [`/accounts/${ACCOUNT}/tokens`]: [
    { id: OPERATOR, name: "hatchkit-cloudflare", status: "active" },
  ],
  [`/accounts/${ACCOUNT}/logs/audit`]: [],
  [`/accounts/${ACCOUNT}/oauth_clients`]: [],
};

await test("a clean run sends no mail and writes a signed last run", async () => {
  const { env, bucket } = await workerEnv(expected());
  const f = workerFetch(cleanAccount);
  const r = await worker.runScheduledAudit(env, NOW, { fetch: f.fetch });
  assert.equal(r.error, undefined);
  assert.equal(r.mailed, false);
  assert.equal(f.mails.length, 0);
  assert.ok(f.calls.every((c) => c.method === "GET" && c.auth === "Bearer audit-token-value"));
  const last = await signed.openEnvelope<{ at: string; alerts: number }>(
    HMAC,
    "last-run",
    (await bucket.get("state/last-run.json"))!.text
      ? await (await bucket.get("state/last-run.json"))!.text()
      : "",
  );
  assert.equal(last.at, NOW.toISOString());
  assert.equal(last.alerts, 0);
  const since = f.calls
    .find((c) => c.url.pathname.endsWith("/logs/audit"))
    ?.url.searchParams.get("since");
  assert.equal(since, "2026-10-19T05:00:00Z", "6 h interval + 1 h margin");
});
await test("an alert mails once; the same alert 6 h later does not; 24 h later it reminds", async () => {
  const { env } = await workerEnv(expected({ runs: [] }));
  const f = workerFetch({ [`/accounts/${ACCOUNT}/oauth_clients`]: [] });
  const first = await worker.runScheduledAudit(env, NOW, { fetch: f.fetch });
  assert.equal(first.mailed, true);
  assert.equal(f.mails.length, 1);
  assert.match(f.mails[0].subject, /^hatchkit audit: \d+ alert\(s\) on Cloudflare$/);
  assert.match(f.mails[0].text, /sneaky/);
  assert.match(f.mails[0].text, /Runbook: revoke hatchkit-cloudflare first/);
  const later = await worker.runScheduledAudit(env, new Date(NOW.getTime() + 6 * 3600_000), {
    fetch: f.fetch,
  });
  assert.equal(later.mailed, false);
  const dayLater = await worker.runScheduledAudit(env, new Date(NOW.getTime() + 24 * 3600_000), {
    fetch: f.fetch,
  });
  assert.equal(dayLater.mailed, true);
  assert.match(f.mails[1].subject, /still open/);
});
await test("a new change by the same actor mails again; the overlap re-read does not", async () => {
  const { env } = await workerEnv(expected());
  const log: unknown[] = [
    entry({ context: "api_token", token_id: ROGUE, token_name: "x" }, "2026-10-19T06:00:00Z"),
  ];
  const f = workerFetch({ ...cleanAccount, [`/accounts/${ACCOUNT}/logs/audit`]: log });
  assert.equal((await worker.runScheduledAudit(env, NOW, { fetch: f.fetch })).mailed, true);
  const t2 = new Date(NOW.getTime() + 6 * 3600_000);
  // Same entry seen again in the 1 h overlap: no mail.
  assert.equal((await worker.runScheduledAudit(env, t2, { fetch: f.fetch })).mailed, false);
  log.push(
    entry({ context: "api_token", token_id: ROGUE, token_name: "x" }, "2026-10-19T17:00:00Z"),
  );
  assert.equal((await worker.runScheduledAudit(env, t2, { fetch: f.fetch })).mailed, true);
});
await test("a signed run window covers the operator's change; a forged one is an integrity alert", async () => {
  const ok = await workerEnv(expected(), [
    { key: "runs/a.json", run: { start: "2026-10-19T02:50:00Z", end: "2026-10-19T03:10:00Z" } },
  ]);
  const f = workerFetch({
    [`/accounts/${ACCOUNT}/tokens`]: [
      { id: OPERATOR, name: "hatchkit-cloudflare", status: "active" },
    ],
    [`/accounts/${ACCOUNT}/oauth_clients`]: [],
    [`/accounts/${ACCOUNT}/logs/audit`]: [
      entry(
        { context: "api_token", token_id: OPERATOR, token_name: "hatchkit-cloudflare" },
        "2026-10-19T08:00:00Z",
      ),
    ],
  });
  // 08:00 is outside the 02:50–03:10 window.
  let r = await worker.runScheduledAudit(ok.env, NOW, { fetch: f.fetch });
  assert.equal(r.mailed, true);
  const covered = await workerEnv(expected(), [
    { key: "runs/b.json", run: { start: "2026-10-19T07:55:00Z", end: "2026-10-19T08:10:00Z" } },
  ]);
  r = await worker.runScheduledAudit(covered.env, NOW, { fetch: f.fetch });
  assert.equal(r.mailed, false, "inside a signed window");
  const forged = await workerEnv(expected(), [
    { key: "runs/c.json", run: { start: "2026-10-19T07:55:00Z" }, key2: "cd".repeat(32) },
  ]);
  r = await worker.runScheduledAudit(forged.env, NOW, { fetch: f.fetch });
  assert.equal(r.mailed, true);
  assert.ok(r.report?.findings.some((x) => x.check === "integrity" && x.subject === "runs/c.json"));
  assert.ok(
    r.report?.findings.some((x) => x.check === "audit-log" && x.severity === "alert"),
    "the forged window does not cover",
  );
});
await test("a missing or forged expected state mails 'could not run' and records the error", async () => {
  const missing = await workerEnv(null);
  const f = workerFetch(cleanAccount);
  let r = await worker.runScheduledAudit(missing.env, NOW, { fetch: f.fetch });
  assert.match(r.error ?? "", /expected.json is missing/);
  assert.equal(r.mailed, true);
  assert.match(f.mails[0].subject, /could not run/);
  const forged = await workerEnv(null);
  await forged.bucket.put(
    "expected.json",
    await signed.signEnvelope("cd".repeat(32), "expected", expected()),
  );
  r = await worker.runScheduledAudit(forged.env, NOW, { fetch: f.fetch });
  assert.match(r.error ?? "", /does not verify/);
  const last = await signed.openEnvelope<{ error?: string }>(
    HMAC,
    "last-run",
    await (await forged.bucket.get("state/last-run.json"))!.text(),
  );
  assert.match(last.error ?? "", /does not verify/);
});
await test("a forged alert state cannot silence a mail", async () => {
  const { env, bucket } = await workerEnv(expected({ runs: [] }));
  const f = workerFetch({ [`/accounts/${ACCOUNT}/oauth_clients`]: [] });
  await bucket.put(
    "state/alert.json",
    JSON.stringify({
      v: 1,
      kind: "alert-state",
      payload: JSON.stringify({
        fingerprints: ["tokens|sneaky (" + ROGUE + ")"],
        mailedAt: NOW.toISOString(),
      }),
      sig: "00".repeat(32),
    }),
  );
  const r = await worker.runScheduledAudit(env, NOW, { fetch: f.fetch });
  assert.equal(r.mailed, true);
  assert.ok(
    r.report?.findings.some((x) => x.check === "integrity" && x.subject === "state/alert.json"),
  );
});
await test("run windows older than 7 days are deleted, 3–7 days ignored", async () => {
  const { env, bucket } = await workerEnv(expected(), [
    {
      key: "runs/old.json",
      run: { start: "2026-10-01T00:00:00Z" },
      uploaded: new Date("2026-10-01T00:00:00Z"),
    },
    {
      key: "runs/mid.json",
      run: { start: "2026-10-15T00:00:00Z" },
      uploaded: new Date("2026-10-15T00:00:00Z"),
    },
  ]);
  await worker.runScheduledAudit(env, NOW, { fetch: workerFetch(cleanAccount).fetch });
  assert.ok(!bucket.objects.has("runs/old.json"));
  assert.ok(bucket.objects.has("runs/mid.json"));
});
await test("the scheduled handler hands the run to waitUntil", async () => {
  let waited: Promise<unknown> | undefined;
  const { env } = await workerEnv(null);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  try {
    await worker.default.scheduled({ scheduledTime: NOW.getTime() }, env, {
      waitUntil: (p) => {
        waited = p;
      },
    });
    const r = (await waited) as { error?: string };
    assert.match(r.error ?? "", /missing/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal((await worker.default.fetch()).status, 404);
});

console.log("10. deploy, publish, run windows, watchdog:");
const MODULE_SRC = (name: string) => `// ${name}\nexport {};\n`;
function deployFetch() {
  const calls: Array<{ method: string; path: string; auth: string; body?: unknown }> = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname.replace("/client/v4", "");
    calls.push({
      method: init?.method ?? "GET",
      path,
      auth: String((init?.headers as Record<string, string>)?.Authorization),
      body: init?.body,
    });
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
        status: 200,
      });
    if (path.endsWith("/deployments")) return ok({ deployments: [{ id: "dep-1" }] });
    if (path === `/accounts/${ACCOUNT}/r2/buckets` && init?.method === "POST")
      return ok({ name: "hatchkit-audit" });
    return ok({});
  };
  return { fetch, calls };
}
await test("deploy --dry-run lists the steps and touches nothing; missing secrets are named", async () => {
  const d = deployFetch();
  await assert.rejects(
    deploy.deployAuditWorker(
      { from: "audit@example.com", to: "rico@example.org", region: "eu-central-1", dryRun: true },
      { fetch: d.fetch, readModule: MODULE_SRC },
    ),
    /Missing before deploy: CLOUDFLARE_AUDIT_TOKEN .*SES_ACCESS_KEY_ID/,
  );
  await setSecret(SECRET_KEYS.cloudflareAuditToken, "audit-token-value");
  await setSecret(SECRET_KEYS.cloudflareAuditSesAccessKeyId, "AKIAEXAMPLEEXAMPLE");
  await setSecret(SECRET_KEYS.cloudflareAuditSesSecretAccessKey, "ses-secret");
  const plan = await deploy.deployAuditWorker(
    { from: "audit@example.com", to: "rico@example.org", region: "eu-central-1", dryRun: true },
    { fetch: d.fetch, readModule: MODULE_SRC },
  );
  assert.equal(plan.cron, "17 */6 * * *");
  assert.equal(plan.hours, 7);
  assert.deepEqual(plan.modules, ["worker.js", "cloudflare.js", "ses-send.js", "signed-state.js"]);
  assert.equal(d.calls.length, 0);
  assert.equal(await getSecret(SECRET_KEYS.cloudflareAuditHmacKey), null, "dry run makes no key");
  await assert.rejects(
    deploy.deployAuditWorker(
      { from: "nope", to: "rico@example.org", region: "eu-central-1", dryRun: true },
      { readModule: MODULE_SRC },
    ),
    /email addresses/,
  );
});
await test("deploy: bucket, Worker with R2 binding and kept secrets, four secrets, cron, signed expected state, deployment id", async () => {
  store.set("providers.cloudflare", { status: "configured", accountId: ACCOUNT });
  const d = deployFetch();
  await deploy.deployAuditWorker(
    { from: "audit@example.com", to: "rico@example.org", region: "eu-central-1", dryRun: false },
    {
      fetch: d.fetch,
      readModule: MODULE_SRC,
      operator: async () => ({ token: "operator-value", accountId: ACCOUNT }),
      now: () => NOW,
    },
  );
  assert.ok(
    d.calls.every((c) => c.auth === "Bearer operator-value"),
    "deploy writes with the operator token",
  );
  const script = `/accounts/${ACCOUNT}/workers/scripts/hatchkit-audit`;
  const upload = d.calls.find((c) => c.method === "PUT" && c.path === script);
  assert.ok(upload?.body instanceof FormData);
  const meta = JSON.parse(await ((upload.body as FormData).get("metadata") as Blob).text());
  assert.equal(meta.main_module, "worker.js");
  assert.deepEqual(meta.keep_bindings, ["secret_text"]);
  assert.ok(
    meta.bindings.some(
      (b: { type: string; bucket_name?: string }) =>
        b.type === "r2_bucket" && b.bucket_name === "hatchkit-audit",
    ),
  );
  assert.ok(
    meta.bindings.some(
      (b: { name: string; text?: string }) => b.name === "MAIL_TO" && b.text === "rico@example.org",
    ),
  );
  assert.ok(!JSON.stringify(meta).includes("audit-token-value"), "no secret in plain bindings");
  const secrets = d.calls
    .filter((c) => c.path === `${script}/secrets`)
    .map((c) => JSON.parse(String(c.body)).name);
  assert.deepEqual(secrets, [
    "CLOUDFLARE_AUDIT_TOKEN",
    "EXPECTED_HMAC_KEY",
    "SES_ACCESS_KEY_ID",
    "SES_SECRET_ACCESS_KEY",
  ]);
  const sched = d.calls.find((c) => c.path === `${script}/schedules`);
  assert.deepEqual(JSON.parse(String(sched?.body)), [{ cron: "17 */6 * * *" }]);
  const exp = d.calls.find(
    (c) => c.path === `/accounts/${ACCOUNT}/r2/buckets/hatchkit-audit/objects/expected.json`,
  );
  const hmac = await getSecret(SECRET_KEYS.cloudflareAuditHmacKey);
  assert.ok(hmac && hmac.length === 64, "HMAC key generated and kept in the keychain");
  const published = await signed.openEnvelope<Expected>(
    hmac as string,
    "expected",
    String(exp?.body),
  );
  assert.ok(
    published.workers.includes("hatchkit-audit") && published.buckets.includes("hatchkit-audit"),
  );
  assert.equal(expectedMod.getAuditWorker()?.deploymentId, "dep-1");
});
await test("run windows go to the bucket signed: start at once, end + expected state before exit", async () => {
  const uploads: Array<{ key: string; run: unknown }> = [];
  let published = 0;
  uses.resetOperatorUseForTests();
  const before = process.listeners("beforeExit").length;
  uses.recordOperatorUse("operator-value", {
    now: () => NOW,
    remote: {
      upload: async (key, run) => {
        uploads.push({ key, run });
      },
      publish: async () => {
        published++;
      },
    },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].run, { start: NOW.toISOString() });
  assert.match(uploads[0].key, /^runs\/2026-10-19T120000000Z-\d+\.json$/);
  const listener = process.listeners("beforeExit").slice(before)[0] as (code: number) => void;
  listener(0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads[1].run, { start: NOW.toISOString(), end: NOW.toISOString() });
  assert.equal(published, 1);
  uses.resetOperatorUseForTests();
});
await test("the default run-window hook never fires under the test runner", async () => {
  // HATCHKIT_TEST_KEYCHAIN_DIR is set by scripts/test.mjs; a deployed Worker must not change that.
  expectedMod.setAuditWorker({
    name: "hatchkit-audit",
    bucket: "hatchkit-audit",
    mailFrom: "a@b.c",
    mailTo: "d@e.f",
    sesRegion: "eu-central-1",
  });
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = (async () => {
    called++;
    return new Response("{}");
  }) as typeof fetch;
  try {
    uses.resetOperatorUseForTests();
    uses.recordOperatorUse("operator-value");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = originalFetch;
    uses.resetOperatorUseForTests();
  }
});
await test("watchdog: a changed deployment, a missing cron, missing secrets and a stale last run all alert", async () => {
  expectedMod.setAuditWorker({
    name: "hatchkit-audit",
    bucket: "hatchkit-audit",
    mailFrom: "a@b.c",
    mailTo: "d@e.f",
    sesRegion: "eu-central-1",
    deploymentId: "dep-1",
  });
  const script = `/accounts/${ACCOUNT}/workers/scripts/hatchkit-audit`;
  const lastRun = (at: string) => signed.signEnvelope(HMAC, "last-run", { at });
  const fresh = await lastRun("2026-10-19T08:17:00Z");
  const make = (over: { deployment?: string; cron?: string; secrets?: string[]; last?: string }) =>
    new audit.CloudflareReader("audit-token-value", async (input: string) => {
      const path = new URL(input).pathname.replace("/client/v4", "");
      const ok = (result: unknown) =>
        new Response(JSON.stringify({ success: true, result }), { status: 200 });
      if (path === `${script}/deployments`)
        return ok({ deployments: [{ id: over.deployment ?? "dep-1" }] });
      if (path === `${script}/schedules`)
        return ok({ schedules: [{ cron: over.cron ?? "17 */6 * * *" }] });
      if (path === `${script}/secrets`)
        return ok((over.secrets ?? deploy.WORKER_SECRETS).map((name) => ({ name })));
      if (path.endsWith("/objects/state/last-run.json"))
        return new Response(over.last ?? fresh, { status: 200 });
      return new Response("{}", { status: 404 });
    });
  assert.deepEqual(await deploy.auditWorkerWatchdog(make({}), ACCOUNT, NOW, HMAC), []);
  const bad = await deploy.auditWorkerWatchdog(
    make({
      deployment: "dep-evil",
      cron: "0 0 1 1 *",
      secrets: ["CLOUDFLARE_AUDIT_TOKEN"],
      last: await lastRun("2026-10-18T20:00:00Z"),
    }),
    ACCOUNT,
    NOW,
    HMAC,
  );
  assert.equal(bad.length, 4);
  assert.ok(bad.every((f) => f.severity === "alert" && f.check === "watchdog"));
  const forgedLast = await deploy.auditWorkerWatchdog(
    make({
      last: await signed.signEnvelope("cd".repeat(32), "last-run", { at: NOW.toISOString() }),
    }),
    ACCOUNT,
    NOW,
    HMAC,
  );
  assert.match(forgedLast[0]?.detail ?? "", /bad signature/);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log("\nAll cloudflare audit tests passed.");
