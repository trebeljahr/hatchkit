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
 *   7. A provider check that got no answer (2026-10-18: Hetzner, `fetch
 *      failed (ETIMEDOUT)`) hints at the network, never at re-entering
 *      a working credential. An HTTP 401 still asks for a new token.
 *   8. API origin agreement (2026-10-19, sprite-tools: "3 of 6
 *      disagree"): a workflow file the project does not have, and the
 *      platform's BETTER_AUTH_URL that doctor never fetches, are not
 *      disagreements. A file that is there and sets no origin, or sets
 *      the wrong one, still fails.
 *
 * Run: `node scripts/test.mjs test-doctor-false-failures.ts`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  checkProjectOperationalState,
  describeProbeFailures,
  fallbackHint,
  hetznerHint,
  pausedResult,
} from "./src/doctor.js";
import { MANIFEST_FILENAME, MANIFEST_VERSION, readManifest } from "./src/scaffold/manifest.js";
import { CloudflareApi } from "./src/utils/cloudflare-api.js";
import { errorDetail, isTransportError } from "./src/utils/error-detail.js";

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

// ── 7. a network error is not a credential error ────────────────────

await check("transport failures are recognised from errorDetail", () => {
  for (const code of ["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET"]) {
    assert.ok(isTransportError(errorDetail(fetchFailed(code))), code);
  }
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.ok(isTransportError(errorDetail(timeout)), "doctor's own 15 s timeout");
  assert.equal(isTransportError("HTTP 401"), false);
  assert.equal(isTransportError("HTTP 503"), false);
});

await check("Hetzner ETIMEDOUT hints at the network, 401 at the token", () => {
  const network = (hetznerHint(errorDetail(fetchFailed("ETIMEDOUT"))) ?? []).join("\n");
  assert.match(network, /Can't reach api\.hetzner\.cloud/);
  assert.match(network, /not a credential problem/);
  assert.doesNotMatch(network, /config add/);

  const denied = (hetznerHint("HTTP 401") ?? []).join("\n");
  assert.match(denied, /invalid or was revoked/);
  assert.match(denied, /hatchkit config add hetzner/);
});

await check("the generic fallback says retry on ETIMEDOUT, re-enter on 401", () => {
  const network = fallbackHint({ name: "Hetzner Cloud", detail: "fetch failed (ETIMEDOUT)" });
  assert.deepEqual(network, [
    "Network error reaching Hetzner Cloud; re-run `hatchkit doctor` before changing credentials.",
  ]);

  const denied = fallbackHint({ name: "Some provider", detail: "HTTP 401" }).join("\n");
  assert.match(denied, /re-enter credentials/);
  assert.match(fallbackHint({ name: "Some provider" }).join("\n"), /re-enter credentials/);
});

// ── 8. API origin agreement counts only values that are there ───────

const ORIGIN = "https://origin.example.com";
const DEPLOY_WORKFLOW = ".github/workflows/build-and-deploy.yml";

/** The API origin row for a single-origin project holding `files`. */
async function originRow(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "hatchkit-doctor-origin-"));
  try {
    writeFileSync(
      join(dir, MANIFEST_FILENAME),
      JSON.stringify({
        version: MANIFEST_VERSION,
        name: "origin-app",
        domain: "origin.example.com",
        surfaces: "fullstack",
        topology: "single-origin",
        deploymentMode: "coolify",
        coolifyRuntime: "image",
        features: [],
      }),
    );
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    const rows = await checkProjectOperationalState(dir);
    const row = rows.find((r) => r.name === "Project origin-app (API origin agreement)");
    assert.ok(row, `no API origin row in ${JSON.stringify(rows)}`);
    return row;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The starter's deploy workflow shape; `null` leaves a line out. */
function deployWorkflow(buildArg: string | null, probe: string | null): string {
  return [
    "jobs:",
    "  build-client:",
    "    steps:",
    "      - uses: docker/build-push-action@v6",
    "        with:",
    "          build-args: |",
    buildArg === null ? "            OTHER=1" : `            NEXT_PUBLIC_API_URL=${buildArg}`,
    "  verify:",
    "    env:",
    probe === null ? "      OTHER: 1" : `      HATCHKIT_API_URL: ${probe}`,
    "",
  ].join("\n");
}

await check("no build-and-deploy.yml and an unfetched server URL is a skip", async () => {
  // sprite-tools: releases from its own deploy.yml, and doctor never
  // reads BETTER_AUTH_URL from the platform.
  const row = await originRow({ ".github/workflows/deploy.yml": `env:\n  SITE: ${ORIGIN}\n` });
  assert.equal(row.status, "skip", row.detail);
  assert.match(row.detail ?? "", /nothing to compare/);
  assert.match(row.detail ?? "", /not verified: BETTER_AUTH_URL/);
  assert.match(row.detail ?? "", /not in this repo: \.github\/workflows\/build-and-deploy\.yml/);
  assert.equal(row.hint, undefined);
});

await check("every value that is there agreeing is ok, the server URL not verified", async () => {
  const row = await originRow({ [DEPLOY_WORKFLOW]: deployWorkflow(ORIGIN, ORIGIN) });
  assert.equal(row.status, "ok", row.detail);
  assert.match(row.detail ?? "", /every applicable place agrees \(not verified: BETTER_AUTH_URL\)/);
});

await check("a build arg naming another host still fails", async () => {
  const row = await originRow({
    [DEPLOY_WORKFLOW]: deployWorkflow("https://old.example.com", ORIGIN),
  });
  assert.equal(row.status, "fail");
  assert.equal(row.detail, `1 of 6 disagree with ${ORIGIN}`);
  const hint = (row.hint ?? []).join("\n");
  assert.match(hint, /build argument \(\.github\/workflows\/build-and-deploy\.yml\): differs/);
  assert.match(hint, /https:\/\/old\.example\.com/);
  assert.match(hint, /\(BETTER_AUTH_URL\): not verified/);
});

await check("a deploy workflow that is there and sets no origin still fails", async () => {
  const row = await originRow({ [DEPLOY_WORKFLOW]: deployWorkflow(null, null) });
  assert.equal(row.status, "fail");
  assert.equal(row.detail, `2 of 6 disagree with ${ORIGIN}`);
  const hint = (row.hint ?? []).join("\n");
  assert.match(hint, /build argument \(\.github\/workflows\/build-and-deploy\.yml\): missing/);
  assert.match(hint, /probe URL \(\.github\/workflows\/build-and-deploy\.yml\): missing/);
});

if (failures.length > 0) {
  console.log("\nDoctor false-failure test failures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}

console.log("\nAll doctor false-failure cases passed.");
