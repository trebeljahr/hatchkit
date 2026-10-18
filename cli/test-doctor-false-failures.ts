/**
 * `hatchkit doctor` rows that failed on expected states, seen in one run
 * on 2026-10-19 (hatchkit 0.2.18): 8 failing rows, 2 real faults.
 *
 * The properties these lock in:
 *   1. Plausible Community Edition (no Sites API) is ok or warn, proven
 *      through `/api/health` and the Stats API, never a failure on the
 *      Sites API's 404/406 alone.
 *   2. The Cloudflare provisioner's failing probes each print their own
 *      error, a denied grant reads apart from a probe that got no answer,
 *      and the row names the zone it probed.
 *   3. A fetch that failed in the network names `err.cause.code`.
 *   4. A paused provider is one skip row with its reason and date.
 *   5. No Coolify GitHub App source is a skip, not a failure.
 *   6. Manifest migration notes print once per process, with the command
 *      that writes the migrated file.
 *
 * Run: `node scripts/test.mjs test-doctor-false-failures.ts`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearProviderPause,
  getProviderPause,
  getProviderPauses,
  isPausableProvider,
  setProviderPause,
} from "./src/config.js";
import {
  checkCoolifyGithubApp,
  checkPlausibleCommunityEdition,
  describeProbeFailures,
  pausedResult,
} from "./src/doctor.js";
import { MANIFEST_FILENAME, readManifest } from "./src/scaffold/manifest.js";
import { CloudflareApi } from "./src/utils/cloudflare-api.js";
import { errorDetail } from "./src/utils/error-detail.js";

const failures: string[] = [];

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

type Responder = (url: string) => Response | Promise<Response>;

/** Answer every fetch from `respond`, run `fn`, restore the real fetch. */
async function withFetch(respond: Responder, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => respond(String(input))) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** The error undici throws when the connection drops. */
function fetchFailed(code: string): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error(`read ${code}`), { code }),
  });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ── 3. fetch failed names its cause ─────────────────────────────────

await check("errorDetail adds undici's cause code", () => {
  assert.equal(errorDetail(fetchFailed("ECONNRESET")), "fetch failed (ECONNRESET)");
});

await check("errorDetail reads a code through a wrapper's cause chain", () => {
  const wrapped = new Error("Cloudflare GET /zones failed: fetch failed", {
    cause: fetchFailed("UND_ERR_CONNECT_TIMEOUT"),
  });
  assert.equal(
    errorDetail(wrapped),
    "Cloudflare GET /zones failed: fetch failed (UND_ERR_CONNECT_TIMEOUT)",
  );
});

await check("errorDetail reads the code inside an AggregateError cause", () => {
  const cause = new AggregateError([Object.assign(new Error("connect"), { code: "ECONNREFUSED" })]);
  assert.equal(
    errorDetail(new TypeError("fetch failed", { cause })),
    "fetch failed (ECONNREFUSED)",
  );
});

await check("errorDetail leaves a plain error alone", () => {
  assert.equal(errorDetail(new Error("HTTP 503")), "HTTP 503");
  assert.equal(errorDetail("boom"), "boom");
});

// ── 1. Plausible Community Edition ──────────────────────────────────

const BASE = "https://plausible.example.com";
const plausible: Responder = (url) => {
  if (url === `${BASE}/api/health`) return json(200, { postgres: "ok", clickhouse: "ok" });
  if (url.includes("/api/v1/stats/aggregate") && url.includes("site_id=play.example.com")) {
    return json(200, { results: { visitors: { value: 3 } } });
  }
  if (url.includes("/api/v1/stats/aggregate")) return json(401, { error: "Invalid API key" });
  return json(404, { message: "Not Found" });
};

await check("CE with a healthy instance and a known site is ok", async () => {
  await withFetch(plausible, async () => {
    const r = await checkPlausibleCommunityEdition(BASE, "key", ["play.example.com"]);
    assert.equal(r.status, "ok");
    assert.match(r.detail ?? "", /Community Edition: no Sites API, add sites in the dashboard/);
    assert.match(r.detail ?? "", /Stats API key valid for play\.example\.com/);
  });
});

await check("CE outside a project is ok and says the key went unverified", async () => {
  await withFetch(plausible, async () => {
    const r = await checkPlausibleCommunityEdition(BASE, "key", []);
    assert.equal(r.status, "ok");
    assert.match(r.detail ?? "", /API key not verified/);
  });
});

await check("CE that refuses the project's site is a warning, not a failure", async () => {
  await withFetch(plausible, async () => {
    const r = await checkPlausibleCommunityEdition(BASE, "key", ["gone.example.com"]);
    assert.equal(r.status, "warn");
    assert.match(r.detail ?? "", /gone\.example\.com: HTTP 401/);
    assert.ok((r.hint ?? []).length > 0);
  });
});

await check("CE whose health endpoint is down fails with the cause", async () => {
  await withFetch(
    () => {
      throw fetchFailed("ENOTFOUND");
    },
    async () => {
      const r = await checkPlausibleCommunityEdition(BASE, "key", ["play.example.com"]);
      assert.equal(r.status, "fail");
      assert.match(r.detail ?? "", /fetch failed \(ENOTFOUND\)/);
    },
  );
});

// ── 2. Cloudflare provisioner probes ────────────────────────────────

await check("probes tell a denied grant from a probe with no answer", async () => {
  const api = new CloudflareApi({ token: "t", accountId: "acc" });
  await withFetch(
    (url) => {
      if (url.includes("/dns_records")) {
        return json(403, {
          success: false,
          errors: [{ code: 9109, message: "Unauthorized to access requested resource" }],
        });
      }
      if (url.includes("/workers/routes")) throw fetchFailed("ECONNRESET");
      return json(200, { success: true, result: [] });
    },
    async () => {
      const probes = await api.probeProvisionerPermissions({ accountId: "acc", zoneId: "z1" });
      const dns = probes.find((p) => p.permission === "Zone → DNS → Edit");
      const routes = probes.find((p) => p.permission === "Zone → Workers Routes → Edit");
      assert.equal(dns?.reason, "denied");
      assert.equal(routes?.reason, "error");
      assert.match(routes?.detail ?? "", /ECONNRESET/);

      const msg = describeProbeFailures(probes, "example.com") ?? "";
      assert.match(msg, /^missing permissions \(zone example\.com\): Zone → DNS → Edit \[9109: /);
      assert.match(msg, /and probes could not run \(zone example\.com\): Zone → Workers Routes/);
      assert.match(msg, /fetch failed \(ECONNRESET\)/);
      assert.doesNotMatch(msg, /Cloudflare GET/, "the call prefix is trimmed");
    },
  );
});

await check("a run with only unanswered probes is not called a scope gap", () => {
  const msg = describeProbeFailures(
    [{ permission: "Zone → DNS → Edit", ok: false, reason: "error", detail: "HTTP 502" }],
    undefined,
  );
  assert.equal(msg, "probes could not run: Zone → DNS → Edit [HTTP 502]");
});

await check("every probe passing yields no failure", () => {
  assert.equal(describeProbeFailures([{ permission: "x", ok: true }], "example.com"), undefined);
});

// ── 4. paused providers ─────────────────────────────────────────────

await check("a paused provider is one skip row with its reason and date", () => {
  assert.equal(pausedResult("glitchtip"), undefined);
  setProviderPause("glitchtip", { reason: "stopped to save memory", since: "2026-10-05" });
  assert.deepEqual(getProviderPause("glitchtip"), {
    reason: "stopped to save memory",
    since: "2026-10-05",
  });
  const row = pausedResult("glitchtip");
  assert.equal(row?.status, "skip");
  assert.equal(row?.paused, true);
  assert.equal(row?.name, "GlitchTip");
  assert.match(row?.detail ?? "", /paused since 2026-10-05: stopped to save memory/);
  assert.match(row?.detail ?? "", /hatchkit config resume glitchtip/);
});

await check("resume clears only that provider", () => {
  setProviderPause("plausible", { reason: "migrating", since: "2026-10-19" });
  assert.equal(clearProviderPause("glitchtip"), true);
  assert.equal(clearProviderPause("glitchtip"), false);
  assert.equal(pausedResult("glitchtip"), undefined);
  assert.deepEqual(Object.keys(getProviderPauses()), ["plausible"]);
  clearProviderPause("plausible");
});

await check("only known providers can be paused", () => {
  assert.equal(isPausableProvider("glitchtip"), true);
  assert.equal(isPausableProvider("toString"), false);
  assert.equal(isPausableProvider("openpanel"), false);
});

// ── 5. Coolify GitHub App sources are optional ──────────────────────

await check("no GitHub App source is a skip that names the command", async () => {
  await withFetch(
    (url) => (url.includes("/github-apps") ? json(200, []) : json(404, {})),
    async () => {
      const rows = await checkCoolifyGithubApp({ url: "https://coolify.example.com", token: "t" });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "skip");
      assert.match(rows[0].detail ?? "", /hatchkit create --private/);
    },
  );
});

// ── 6. manifest migration notes once ────────────────────────────────

await check("migration notes print once per process, with the persisting command", () => {
  const dir = mkdtempSync(join(tmpdir(), "hatchkit-doctor-notes-"));
  const lines: string[] = [];
  const log = console.log;
  try {
    writeFileSync(
      join(dir, MANIFEST_FILENAME),
      JSON.stringify({
        version: 1,
        cliVersion: "test",
        scaffoldedAt: "2025-01-01T00:00:00.000Z",
        name: "notes-app",
        domain: "notes.example.com",
        features: [],
        mlServices: [],
        s3Provider: "none",
        deployTarget: "existing",
        surfaces: "shared",
        ports: { server: 3000, client: 5173 },
      }),
    );
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    for (let i = 0; i < 5; i++) assert.ok(readManifest(dir));
  } finally {
    console.log = log;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(lines.length > 1, "the v1 manifest migrates");
  assert.equal(new Set(lines).size, lines.length, `a line repeated:\n${lines.join("\n")}`);
  const hints = lines.filter((l) => l.includes("hatchkit update"));
  assert.equal(hints.length, 1);
  assert.match(hints[0], /migrated in memory only/);
});

if (failures.length > 0) {
  console.log("\nDoctor false-failure test failures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}

console.log("\nAll doctor false-failure cases passed.");
