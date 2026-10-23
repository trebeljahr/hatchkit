/** Removal must never infer ownership from a project name, manifest or cache.
 * Run through scripts/test.mjs: all credentials use the fixture keychain and
 * every provider request is handled below (unexpected requests fail closed). */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

if (!process.env.HATCHKIT_TEST_KEYCHAIN_DIR) throw new Error("Use scripts/test.mjs");
const { getStore, getConfigPath } = await import("./src/config.js");
const { SECRET_KEYS, setSecret, getSecret } = await import("./src/utils/secrets.js");
const { RunLedger } = await import("./src/utils/run-ledger.js");
type LedgerStep = import("./src/utils/run-ledger.js").LedgerStep;
const { runUnprovision } = await import("./src/provision/index.js");
const { renamePlausibleSite } = await import("./src/provision/plausible.js");
const { readManifest, MANIFEST_VERSION } = await import("./src/scaffold/manifest.js");

const GT = "https://glitchtip.test";
const PLAUSIBLE = "https://plausible.test";
const LISTMONK = "https://listmonk.test";
const CF = "https://api.cloudflare.com/client/v4";
const allServices = [
  "glitchtip",
  "plausible",
  "listmonk-ses",
  "s3",
  "email",
  "search-console",
] as const;
const root = dirname(getConfigPath());
const failures: string[] = [];
const calls: Array<{ method: string; url: string }> = [];
type Route = (method: string, url: string) => Response | undefined;
let route: Route = () => undefined;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  calls.push({ method, url });
  const response = route(method, url);
  if (!response) throw new Error(`Unexpected provider call: ${method} ${url}`);
  return response;
}) as typeof fetch;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ledger(name: string, steps: LedgerStep[]) {
  const result = RunLedger.start(name);
  for (const step of steps) result.record(step);
  result.complete();
  return result;
}

async function check(label: string, fn: () => Promise<void>) {
  calls.length = 0;
  route = () => undefined;
  process.exitCode = 0;
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).stack}`);
  } finally {
    process.env.HATCHKIT_KEYCHAIN_ACCESS = "allow"; // fixture backend only
    process.exitCode = 0;
  }
}

getStore().set("providers.glitchtip", {
  status: "configured",
  url: GT,
  organizationSlug: "org",
  teamSlug: "team",
});
getStore().set("providers.plausible", { status: "configured", url: PLAUSIBLE });
getStore().set("providers.listmonk", { status: "configured", url: LISTMONK, apiUser: "hatchkit" });
getStore().set("providers.dns", {
  status: "configured",
  provider: "cloudflare",
  accountId: "account",
});
await setSecret(SECRET_KEYS.glitchtipToken, "fixture-gt");
await setSecret(SECRET_KEYS.plausibleApiKey, "fixture-plausible");
await setSecret(SECRET_KEYS.listmonkApiToken, "fixture-listmonk");
await setSecret(SECRET_KEYS.listmonkAdminApiToken, "fixture-listmonk-admin");
await setSecret(SECRET_KEYS.cloudflareOperatorToken, "fixture-cloudflare");

await check(
  "missing and malformed ledgers preserve everything without credentials or network",
  async () => {
    const cache = join(root, "provisioned", "untracked.server.prod.env");
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, "KEEP=fixture\n");
    const broken = ledger("broken", []);
    writeFileSync(broken.path, JSON.stringify({ name: "broken", steps: {} }));
    process.env.HATCHKIT_KEYCHAIN_ACCESS = "deny";
    for (const baseName of ["untracked", "broken"]) {
      await runUnprovision({ baseName, services: [...allServices] });
    }
    assert.deepEqual(calls, []);
    assert.equal(process.exitCode, 0);
    assert.equal(readFileSync(cache, "utf8"), "KEEP=fixture\n");
    assert.equal(readFileSync(broken.path, "utf8"), JSON.stringify({ name: "broken", steps: {} }));
  },
);

await check("dry-run needs no keychain and preserves the complete ledger", async () => {
  const saved = ledger("preview", [
    { kind: "glitchtip", project: "actual-slug", baseUrl: GT, organizationSlug: "org" },
    { kind: "plausible", project: "preview", domain: "owned.test", baseUrl: PLAUSIBLE },
    { kind: "listmonkList", listmonkUrl: LISTMONK, listName: "preview", listId: 31 },
    { kind: "r2Token", accountId: "account", tokenId: "owned-token", audience: "account" },
    {
      kind: "cloudflareEmailRoutingRule",
      zoneId: "zone",
      ruleId: "owned-rule",
      address: "a@owned.test",
    },
  ]);
  const before = readFileSync(saved.path, "utf8");
  process.env.HATCHKIT_KEYCHAIN_ACCESS = "deny";
  await runUnprovision({ baseName: "preview", services: [...allServices], dryRun: true });
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(saved.path, "utf8"), before);
  assert.equal(process.exitCode, 0);
});

await check(
  "mixed ownership deletes only recorded identities and retains infrastructure",
  async () => {
    const kept: LedgerStep[] = [
      { kind: "sesDomain", domain: "mail.owned.test" },
      { kind: "r2Bucket", accountId: "account", bucketName: "owned-assets" },
      {
        kind: "cloudflareDnsRecord",
        zoneId: "zone",
        recordId: "dns",
        name: "owned.test",
        type: "TXT",
      },
      {
        kind: "cloudflareEmailDestination",
        accountId: "account",
        destinationId: "dest",
        email: "inbox@test.test",
      },
      { kind: "keychain", account: "unrelated-local-credential" },
    ];
    const saved = ledger("mixed", [
      ...kept,
      { kind: "glitchtip", project: "actual-provider-slug", baseUrl: GT, organizationSlug: "org" },
      { kind: "plausible", project: "mixed", domain: "owned.test", baseUrl: PLAUSIBLE },
      { kind: "listmonkList", listmonkUrl: `${LISTMONK}/`, listName: "mixed", listId: 31 },
      { kind: "listmonkList", listmonkUrl: LISTMONK, listName: "additional-list", listId: 32 },
      { kind: "r2Token", accountId: "account", tokenId: "owned-token", audience: "account" },
      { kind: "r2Token", accountId: "account", tokenId: "legacy-token", audience: "user" },
      {
        kind: "cloudflareEmailRoutingRule",
        zoneId: "zone",
        ruleId: "owned-rule",
        address: "a@owned.test",
      },
    ]);
    const startedAt = saved.startedAt;
    const finishedAt = saved.finishedAt;
    await setSecret(SECRET_KEYS.plausibleSiteDomain("mixed"), "adopted.test");
    const projectDir = join(root, "mixed-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, ".hatchkit.json"),
      JSON.stringify({
        version: MANIFEST_VERSION,
        name: "mixed",
        domain: "adopted.test",
        s3Buckets: {
          accountId: "account",
          tokenId: "owned-token",
          assets: {
            name: "assets",
            publicUrl: "https://assets.test",
            tokenId: "owned-token",
            cors: { skipped: true },
          },
          foreign: { name: "foreign", publicUrl: null, tokenId: "adopted-token" },
        },
      }),
    );
    const expected = [
      `${GT}/api/0/projects/org/actual-provider-slug/`,
      `${PLAUSIBLE}/api/v1/sites/owned.test`,
      `${LISTMONK}/api/lists/31`,
      `${LISTMONK}/api/lists/32`,
      `${CF}/accounts/account/tokens/owned-token`,
      `${CF}/user/tokens/legacy-token`,
      `${CF}/zones/zone/email/routing/rules/owned-rule`,
    ];
    route = (method, url) =>
      method === "DELETE" && expected.includes(url)
        ? json({ success: true, result: {} })
        : undefined;
    await runUnprovision({ baseName: "mixed", services: [...allServices], projectDir });
    assert.equal(process.exitCode, 0);
    assert.deepEqual(calls.map((c) => c.url).sort(), expected.sort());
    const after = RunLedger.load("mixed")!;
    assert.deepEqual(after.steps, kept);
    assert.equal(after.startedAt, startedAt);
    assert.equal(after.finishedAt, finishedAt);
    assert.equal(await getSecret(SECRET_KEYS.plausibleSiteDomain("mixed")), "adopted.test");
    const buckets = readManifest(projectDir)!.s3Buckets!;
    assert.equal(buckets.tokenId, undefined);
    assert.equal(buckets.assets!.tokenId, undefined);
    assert.deepEqual(buckets.assets!.cors, { skipped: true });
    assert.equal((buckets.foreign as { tokenId: string }).tokenId, "adopted-token");
  },
);

await check(
  "ambiguous legacy GlitchTip and Plausible rows remain without credential access",
  async () => {
    const saved = ledger("legacy", [
      { kind: "glitchtip", project: "legacy" },
      { kind: "plausible", project: "legacy" },
    ]);
    const before = readFileSync(saved.path, "utf8");
    process.env.HATCHKIT_KEYCHAIN_ACCESS = "deny";
    await runUnprovision({ baseName: "legacy", services: ["glitchtip", "plausible"] });
    assert.deepEqual(calls, []);
    assert.equal(readFileSync(saved.path, "utf8"), before);
  },
);

await check("provider changes cannot retarget recorded identities", async () => {
  const saved = ledger("moved-provider", [
    {
      kind: "glitchtip",
      project: "same-name",
      baseUrl: "https://original.test",
      organizationSlug: "org",
    },
    {
      kind: "plausible",
      project: "moved-provider",
      domain: "same.test",
      baseUrl: "https://original.test",
    },
    {
      kind: "listmonkList",
      listmonkUrl: "https://original.test",
      listName: "same-name",
      listId: 31,
    },
    {
      kind: "listmonkApiUser",
      listmonkUrl: "https://original.test",
      username: "same-name",
      userId: 10,
    },
  ]);
  const before = readFileSync(saved.path, "utf8");
  await runUnprovision({
    baseName: "moved-provider",
    services: ["glitchtip", "plausible", "listmonk-ses"],
  });
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(saved.path, "utf8"), before);
});

await check(
  "failures retain ownership while confirmed absence retires only its own step",
  async () => {
    const failed: LedgerStep = {
      kind: "glitchtip",
      project: "fails",
      baseUrl: GT,
      organizationSlug: "org",
    };
    const unrelated: LedgerStep = { kind: "github", repo: "owner/project" };
    ledger("partial", [
      failed,
      unrelated,
      { kind: "glitchtip", project: "missing", baseUrl: GT, organizationSlug: "org" },
    ]);
    route = (method, url) =>
      method === "DELETE" && url.startsWith(GT)
        ? json({}, url.endsWith("/missing/") ? 404 : 500)
        : undefined;
    await runUnprovision({ baseName: "partial", services: ["glitchtip"] });
    assert.equal(process.exitCode, 1);
    assert.deepEqual(RunLedger.load("partial")!.steps, [failed, unrelated]);
  },
);

await check("Listmonk user is removed before roles and a held role is retained", async () => {
  const held: LedgerStep = {
    kind: "listmonkRole",
    listmonkUrl: LISTMONK,
    name: "project",
    roleType: "list",
    roleId: 22,
  };
  ledger("listmonk-order", [
    { kind: "listmonkApiUser", listmonkUrl: LISTMONK, username: "project", userId: 10 },
    held,
    { kind: "listmonkRole", listmonkUrl: LISTMONK, name: "project", roleType: "user", roleId: 21 },
  ]);
  let ownUserPresent = true;
  route = (method, url) => {
    if (method === "GET" && url === `${LISTMONK}/api/users`)
      return json({
        data: [
          ...(ownUserPresent
            ? [
                {
                  id: 10,
                  username: "project",
                  type: "api",
                  user_role_id: 21,
                  list_role: { id: 22 },
                },
              ]
            : []),
          { id: 11, username: "adopted", type: "api", user_role_id: 1, list_role: { id: 22 } },
        ],
      });
    if (method === "GET" && url === `${LISTMONK}/api/roles/users`)
      return json({ data: [{ id: 21, name: "project" }] });
    if (method === "GET" && url === `${LISTMONK}/api/roles/lists`)
      return json({ data: [{ id: 22, name: "project" }] });
    if (method === "DELETE" && url === `${LISTMONK}/api/users/10`) {
      ownUserPresent = false;
      return json({ data: true });
    }
    if (method === "DELETE" && url === `${LISTMONK}/api/roles/21`) return json({ data: true });
    return undefined;
  };
  await runUnprovision({ baseName: "listmonk-order", services: ["listmonk-ses"] });
  assert.deepEqual(
    calls.filter((c) => c.method === "DELETE").map((c) => c.url),
    [`${LISTMONK}/api/users/10`, `${LISTMONK}/api/roles/21`],
  );
  assert.deepEqual(RunLedger.load("listmonk-order")!.steps, [held]);
});

await check("Plausible missing API does not retire ownership or erase the cache", async () => {
  const step: LedgerStep = {
    kind: "plausible",
    project: "plausible-ce",
    domain: "kept.test",
    baseUrl: PLAUSIBLE,
  };
  ledger("plausible-ce", [step]);
  await setSecret(SECRET_KEYS.plausibleSiteDomain("plausible-ce"), "kept.test");
  route = (method, url) => {
    if (method === "DELETE" && url === `${PLAUSIBLE}/api/v1/sites/kept.test`) return json({}, 404);
    if (method === "GET" && url.startsWith(`${PLAUSIBLE}/api/v1/stats/aggregate?`))
      return json({ results: {} });
    return undefined;
  };
  await runUnprovision({ baseName: "plausible-ce", services: ["plausible"] });
  assert.deepEqual(RunLedger.load("plausible-ce")!.steps, [step]);
  assert.equal(await getSecret(SECRET_KEYS.plausibleSiteDomain("plausible-ce")), "kept.test");
});

await check(
  "Plausible rename updates only recorded matching provider/domain identities",
  async () => {
    ledger("rename-owner", [
      { kind: "plausible", project: "rename-owner", domain: "old.test", baseUrl: PLAUSIBLE },
    ]);
    const foreign: LedgerStep = {
      kind: "plausible",
      project: "rename-other",
      domain: "old.test",
      baseUrl: "https://elsewhere.test",
    };
    ledger("rename-other", [foreign]);
    route = (method, url) =>
      method === "PUT" && url === `${PLAUSIBLE}/api/v1/sites/old.test` ? json({}) : undefined;
    await renamePlausibleSite("old.test", "new.test");
    assert.equal(
      (RunLedger.load("rename-owner")!.steps[0] as { domain: string }).domain,
      "new.test",
    );
    assert.deepEqual(RunLedger.load("rename-other")!.steps, [foreign]);
  },
);

globalThis.fetch = realFetch;
if (failures.length) console.error(failures.join("\n"));
process.exitCode = failures.length ? 1 : 0;
