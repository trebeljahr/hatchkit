/**
 * dns.ts: `hatchkit dns link-to-cloudflare` per-zone decisions.
 *
 * Regression cover for 2026-10-07: the command skipped every zone whose
 * status was not "active". A new Cloudflare zone stays "pending" exactly
 * until the registrar delegates to its nameservers, which is what this
 * command does, so it could never delegate a fresh domain. Goldens lock in:
 *
 *   1. pending → delegated at the registrar, then an activation check is
 *      queued so Cloudflare looks before its own backoff.
 *   2. active + registrar already lists the same NS (any case/order,
 *      trailing dot) → unchanged, no write, no activation check.
 *   3. Terminal / unfinished states (moved, deleted, purged, initializing,
 *      unknown) and non-full zones → skipped with a reason, registrar
 *      never touched.
 *   4. A refused activation check (rate limit, token scope) does not
 *      turn a successful delegation into a failure.
 *   5. Dry-run never calls the registrar or Cloudflare.
 *
 * Registrar and Cloudflare are in-memory fakes; nothing reaches INWX.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  type ZoneLinkDeps,
  linkZonesAtRegistrar,
  sameNameservers,
  zoneSkipReason,
} from "./src/dns.js";
import type { CloudflareZone } from "./src/utils/cloudflare-api.js";

const CF_NS = ["monroe.ns.cloudflare.com", "sterling.ns.cloudflare.com"];
const INWX_NS = ["ns.inwx.de", "ns2.inwx.de", "ns3.inwx.eu"];

function zone(name: string, status: string, extra: Partial<CloudflareZone> = {}): CloudflareZone {
  return { id: `id-${name}`, name, name_servers: CF_NS, status, type: "full", ...extra };
}

interface Recorder {
  deps: ZoneLinkDeps;
  writes: Array<{ domain: string; ns: string[] }>;
  reads: string[];
  activationChecks: string[];
}

function fakes(
  registrarNs: Record<string, string[]>,
  opts: { dryRun?: boolean; activationError?: string } = {},
): Recorder {
  const rec: Recorder = {
    writes: [],
    reads: [],
    activationChecks: [],
    deps: undefined as unknown as ZoneLinkDeps,
  };
  rec.deps = {
    dryRun: opts.dryRun ?? false,
    activationCheck: true,
    log: () => {},
    registrar: {
      async getDomainInfo(domain: string) {
        rec.reads.push(domain);
        const ns = registrarNs[domain];
        if (!ns) throw new Error(`domain ${domain} not on this account`);
        return { domain, ns };
      },
      async setDomainNameservers(domain: string, ns: string[]) {
        rec.writes.push({ domain, ns });
        registrarNs[domain] = ns;
      },
    },
    cf: {
      async triggerActivationCheck(zoneId: string) {
        rec.activationChecks.push(zoneId);
        if (opts.activationError) throw new Error(opts.activationError);
      },
    },
  };
  return rec;
}

const failures: string[] = [];

async function expect(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

await expect(
  "pending zone with registrar NS elsewhere → delegated + activation check",
  async () => {
    const rec = fakes({ "hydroxyl.app": [...INWX_NS] });
    const [res] = await linkZonesAtRegistrar([zone("hydroxyl.app", "pending")], rec.deps);
    assert.equal(res?.outcome, "delegated");
    assert.equal(res?.activationCheck, "queued");
    assert.deepEqual(rec.writes, [{ domain: "hydroxyl.app", ns: CF_NS }]);
    assert.deepEqual(rec.activationChecks, ["id-hydroxyl.app"]);
  },
);

await expect("pending zone already delegated by hand → unchanged, still re-checked", async () => {
  const rec = fakes({ "hydroxyl.app": [...CF_NS] });
  const [res] = await linkZonesAtRegistrar([zone("hydroxyl.app", "pending")], rec.deps);
  assert.equal(res?.outcome, "unchanged");
  assert.equal(rec.writes.length, 0);
  assert.deepEqual(rec.activationChecks, ["id-hydroxyl.app"]);
});

await expect("active zone + same NS → unchanged, no write, no activation check", async () => {
  // Registrar spelling differs only in case, order and a trailing dot.
  const rec = fakes({
    "fractal.garden": ["STERLING.ns.cloudflare.com.", "monroe.ns.cloudflare.com"],
  });
  const [res] = await linkZonesAtRegistrar([zone("fractal.garden", "active")], rec.deps);
  assert.equal(res?.outcome, "unchanged");
  assert.equal(rec.writes.length, 0);
  assert.equal(rec.activationChecks.length, 0);
  assert.equal(res?.activationCheck, undefined);
});

await expect("active zone + drifted NS → re-pushed, no activation check", async () => {
  const rec = fakes({ "fractal.garden": [...INWX_NS] });
  const [res] = await linkZonesAtRegistrar([zone("fractal.garden", "active")], rec.deps);
  assert.equal(res?.outcome, "delegated");
  assert.equal(rec.writes.length, 1);
  assert.equal(rec.activationChecks.length, 0);
});

await expect(
  "moved / deleted / purged / initializing / unknown → skipped, registrar untouched",
  async () => {
    const rec = fakes({});
    const statuses = ["moved", "deleted", "purged", "initializing", "deactivated"];
    const results = await linkZonesAtRegistrar(
      statuses.map((s) => zone(`${s}.example`, s)),
      rec.deps,
    );
    assert.deepEqual(
      results.map((r) => r.outcome),
      statuses.map(() => "skipped"),
    );
    for (const r of results) assert.ok(r.detail && r.detail.length > 0, `${r.zone} has no reason`);
    assert.match(results[0]?.detail ?? "", /deliberate/);
    assert.equal(rec.reads.length + rec.writes.length + rec.activationChecks.length, 0);
  },
);

await expect("partial (CNAME-setup) zone and zone without NS → skipped", () => {
  assert.match(
    zoneSkipReason(zone("cname.example", "pending", { type: "partial" })) ?? "",
    /partial/,
  );
  assert.match(
    zoneSkipReason(zone("bare.example", "pending", { name_servers: [] })) ?? "",
    /not assigned/,
  );
  assert.equal(zoneSkipReason(zone("ok.example", "pending")), null);
  assert.equal(zoneSkipReason(zone("legacy.example", "pending", { type: undefined })), null);
});

await expect("refused activation check keeps the delegation a success", async () => {
  const rec = fakes(
    { "hydroxyl.app": [...INWX_NS] },
    { activationError: "Cloudflare PUT /zones/x/activation_check failed: 1224: rate limited" },
  );
  const [res] = await linkZonesAtRegistrar([zone("hydroxyl.app", "pending")], rec.deps);
  assert.equal(res?.outcome, "delegated");
  assert.equal(res?.activationCheck, "failed");
});

await expect("registrar error → failed, next zone still processed", async () => {
  const rec = fakes({ "b.example": [...INWX_NS] });
  const results = await linkZonesAtRegistrar(
    [zone("a.example", "pending"), zone("b.example", "pending")],
    rec.deps,
  );
  assert.deepEqual(
    results.map((r) => r.outcome),
    ["failed", "delegated"],
  );
  assert.deepEqual(rec.activationChecks, ["id-b.example"]);
});

await expect("dry-run → would-delegate, no registrar or Cloudflare calls", async () => {
  const rec = fakes({ "hydroxyl.app": [...INWX_NS] }, { dryRun: true });
  const results = await linkZonesAtRegistrar(
    [zone("hydroxyl.app", "pending"), zone("gone.example", "deleted")],
    rec.deps,
  );
  assert.deepEqual(
    results.map((r) => r.outcome),
    ["would-delegate", "skipped"],
  );
  assert.equal(rec.reads.length + rec.writes.length + rec.activationChecks.length, 0);
});

await expect("sameNameservers ignores case, order and trailing dot; not subsets", () => {
  assert.ok(sameNameservers(["A.ns.example.", "b.ns.example"], ["b.ns.example", "a.ns.example"]));
  assert.ok(!sameNameservers(["a.ns.example"], ["a.ns.example", "b.ns.example"]));
});

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("dns link-to-cloudflare checks ok");
