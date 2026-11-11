/**
 * provision/r2-cache-rule.ts: the edge Cache Rule `provision s3` keeps
 * for an R2 custom domain.
 *
 *   1. A zone with no Cache Rules ruleset gets one with hatchkit's rule.
 *   2. A ruleset with other rules gets hatchkit's rule APPENDED; the
 *      other rules are never part of a write.
 *   3. An up-to-date rule is left alone (no write); an outdated one is
 *      patched in place by id.
 *   4. A bypass rule that may match the host stops the write and is
 *      named; a bypass scoped to another single host does not.
 *   5. A zone that refuses status-code TTLs gets the rule without them.
 *   6. A token without the grant fails naming Zone → Cache Rules → Edit
 *      (through the real CloudflareApi, fake fetch).
 *   7. --dry-run writes nothing and never purges.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  CacheRuleConflictError,
  type CacheRuleHostApi,
  applyR2CacheRule,
  cacheRuleDescription,
  desiredCacheRule,
  ensureR2CacheRule,
} from "./src/provision/r2-cache-rule.js";
import {
  CF_CACHE_RULES_GRANT,
  type CfCacheRule,
  type CfCacheRuleset,
  CloudflareApi,
} from "./src/utils/cloudflare-api.js";

const HOST = "assets.example.com";
const failures: string[] = [];

async function test(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).stack ?? err}`);
    console.log(`  ✗ ${label}`);
  }
}

interface Write {
  kind: "add" | "update" | "purge";
  ruleId?: string;
  rule?: CfCacheRule;
  hosts?: string[];
}

function fakeApi(
  ruleset: CfCacheRuleset | null,
  opts: { refuseStatusCodeTtl?: boolean } = {},
): CacheRuleHostApi & { writes: Write[] } {
  const writes: Write[] = [];
  const refuse = (rule: CfCacheRule) => {
    if (opts.refuseStatusCodeTtl && rule.action_parameters.edge_ttl?.status_code_ttl) {
      throw new Error(
        "Cloudflare POST failed: 20120: 'status_code_ttl' is not entitled for this zone",
      );
    }
  };
  return {
    writes,
    async getZoneByName(name: string) {
      return { id: "zone-1", name, name_servers: [], status: "active" };
    },
    async getCacheRuleset() {
      return ruleset;
    },
    async addCacheRule(_zoneId: string, rule: CfCacheRule) {
      refuse(rule);
      writes.push({ kind: "add", rule });
      return { id: ruleset?.id ?? "rs-new", rules: [...(ruleset?.rules ?? []), rule] };
    },
    async updateCacheRule(_zoneId: string, _rs: string, ruleId: string, rule: CfCacheRule) {
      refuse(rule);
      writes.push({ kind: "update", ruleId, rule });
      return { id: _rs, rules: [] };
    },
    async purgeCacheByHosts(_zoneId: string, hosts: string[]) {
      writes.push({ kind: "purge", hosts });
    },
  } as unknown as CacheRuleHostApi & { writes: Write[] };
}

const otherRule: CfCacheRule = {
  id: "r-other",
  description: "cache static on www",
  expression: '(http.host eq "www.example.com")',
  action: "set_cache_settings",
  action_parameters: { cache: true, edge_ttl: { mode: "override_origin", default: 3600 } },
};

console.log("r2 cache rule:");

await test("desired rule: host expression, cache on, respect origin, 4xx/5xx no-store", async () => {
  const r = desiredCacheRule(HOST, { statusCodeTtl: true });
  assert.equal(r.description, `hatchkit: cache ${HOST}`);
  assert.equal(r.expression, `(http.host eq "${HOST}")`);
  assert.equal(r.action, "set_cache_settings");
  assert.equal(r.action_parameters.cache, true);
  assert.deepEqual(r.action_parameters.edge_ttl, {
    mode: "respect_origin",
    status_code_ttl: [{ status_code_range: { from: 400 }, value: -1 }],
  });
  assert.throws(() => desiredCacheRule('x" or true or "', { statusCodeTtl: true }), /hostname/);
});

await test("no ruleset → one add, nothing else", async () => {
  const api = fakeApi(null);
  const r = await ensureR2CacheRule(api, "zone-1", HOST);
  assert.equal(r.action, "created");
  assert.equal(r.statusCodeTtl, true);
  assert.equal(api.writes.length, 1);
  assert.equal(api.writes[0].kind, "add");
  assert.equal(api.writes[0].rule?.description, cacheRuleDescription(HOST));
});

await test("other rules present → append only hatchkit's rule", async () => {
  const api = fakeApi({ id: "rs-1", rules: [otherRule] });
  const r = await ensureR2CacheRule(api, "zone-1", HOST);
  assert.equal(r.action, "created");
  assert.equal(api.writes.length, 1);
  assert.equal(api.writes[0].kind, "add");
  assert.notEqual(api.writes[0].rule?.description, otherRule.description);
});

await test("up-to-date rule → no write", async () => {
  const own = { id: "r-own", ...desiredCacheRule(HOST, { statusCodeTtl: true }) };
  const api = fakeApi({ id: "rs-1", rules: [otherRule, own] });
  const r = await ensureR2CacheRule(api, "zone-1", HOST);
  assert.equal(r.action, "unchanged");
  assert.equal(api.writes.length, 0);
});

await test("outdated rule → patched in place by id", async () => {
  const stale: CfCacheRule = {
    id: "r-own",
    ...desiredCacheRule(HOST, { statusCodeTtl: true }),
    enabled: false,
  };
  const api = fakeApi({ id: "rs-1", rules: [stale] });
  const r = await ensureR2CacheRule(api, "zone-1", HOST);
  assert.equal(r.action, "updated");
  assert.deepEqual(
    api.writes.map((w) => [w.kind, w.ruleId]),
    [["update", "r-own"]],
  );
  assert.equal(api.writes[0].rule?.enabled, true);
});

await test("bypass rule that may match → refuse, name it, write nothing", async () => {
  const bypass: CfCacheRule = {
    id: "r-bypass",
    description: "no cache for images",
    expression: '(http.request.uri.path.extension in {"webp" "avif"})',
    action: "set_cache_settings",
    action_parameters: { cache: false },
  };
  const api = fakeApi({ id: "rs-1", rules: [bypass] });
  await assert.rejects(
    ensureR2CacheRule(api, "zone-1", HOST),
    (err: unknown) =>
      err instanceof CacheRuleConflictError &&
      /no cache for images/.test(err.message) &&
      /--override-bypass/.test(err.message),
  );
  assert.equal(api.writes.length, 0);
  const forced = await ensureR2CacheRule(api, "zone-1", HOST, { overrideBypass: true });
  assert.equal(forced.action, "created");
  assert.equal(forced.conflicts.length, 1);
});

await test("bypass scoped to another single host, or disabled → no conflict", async () => {
  const api = fakeApi({
    id: "rs-1",
    rules: [
      {
        description: "bypass api",
        expression: '(http.host eq "api.example.com")',
        action: "set_cache_settings",
        action_parameters: { cache: false },
      },
      {
        description: "old bypass",
        expression: "true",
        action: "set_cache_settings",
        enabled: false,
        action_parameters: { cache: false },
      },
    ],
  });
  const r = await ensureR2CacheRule(api, "zone-1", HOST);
  assert.equal(r.action, "created");
  assert.equal(r.conflicts.length, 0);
});

await test("zone refuses status-code TTLs → rule without them, flagged", async () => {
  const api = fakeApi(null, { refuseStatusCodeTtl: true });
  const r = await ensureR2CacheRule(api, "zone-1", HOST);
  assert.equal(r.action, "created");
  assert.equal(r.statusCodeTtl, false);
  assert.equal(api.writes.length, 1);
  assert.equal(api.writes[0].rule?.action_parameters.edge_ttl?.status_code_ttl, undefined);
});

await test("dry run → reports, never writes or purges", async () => {
  const api = fakeApi(null);
  const r = await applyR2CacheRule(api, HOST, { dryRun: true, purge: true });
  assert.equal(r.action, "would-create");
  assert.equal(r.zoneName, "example.com");
  assert.equal(r.purged, false);
  assert.equal(api.writes.length, 0);
});

await test("--purge → purge by host after the rule", async () => {
  const api = fakeApi(null);
  const r = await applyR2CacheRule(api, HOST, { purge: true });
  assert.equal(r.purged, true);
  assert.deepEqual(
    api.writes.map((w) => w.kind),
    ["add", "purge"],
  );
  assert.deepEqual(api.writes[1].hosts, [HOST]);
});

await test("missing grant → error names Zone → Cache Rules → Edit (real client)", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ success: false, errors: [{ message: "request is not authorized" }] }),
      { status: 403, headers: { "content-type": "application/json" } },
    )) as typeof globalThis.fetch;
  try {
    const api = new CloudflareApi({ token: "t" });
    await assert.rejects(ensureR2CacheRule(api, "zone-1", HOST), (err: unknown) =>
      (err as Error).message.includes(CF_CACHE_RULES_GRANT),
    );
    await assert.rejects(api.purgeCacheByHosts("zone-1", [HOST]), /Cache Purge → Purge/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n\n")}`);
  process.exit(1);
}
