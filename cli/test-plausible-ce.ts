/**
 * plausible-ce.ts: Community Edition detection for the Sites API.
 *
 * Plausible Community Edition / self-hosted serves the Stats API but NOT
 * the Sites provisioning API at `/api/v1/sites/*`. That route answers a
 * GET with 406 (content negotiation) and a rename PUT with 404 — and a
 * 404 is indistinguishable, by status alone, from Cloud's genuine "no
 * such site". The fix disambiguates with a Stats API probe, which CE
 * does serve: if it still resolves the domain, the site exists and only
 * the Sites API is missing.
 *
 * These goldens lock in:
 *
 *   1. `renameSite` on a CE instance (PUT 404 while the Stats API sees
 *      the site) reports "Sites API unavailable / rename in the
 *      dashboard" — NOT the misleading "Plausible has no site for X".
 *   2. `renameSite` on a genuinely missing site (PUT 404, Stats 404, or
 *      an inconclusive Stats probe) keeps the accurate "no site" error.
 *   3. A 406 is always treated as CE without probing the Stats API.
 *   4. `siteExists` does not false-negative on CE: a 406 or 404 from the
 *      Sites API followed by a positive Stats hit returns true.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  PlausibleSitesApiUnavailableError,
  renameSite,
  siteExists,
} from "./src/provision/plausible.js";

const BASE = "https://plausible.example.com";
const KEY = "test-key";

type RouteResp = { status: number; body?: string; statusText?: string };
interface Routes {
  sitesPut?: RouteResp;
  sitesGet?: RouteResp;
  stats?: RouteResp;
}
interface Call {
  role: "sitesPut" | "sitesGet" | "stats" | "unknown";
  url: string;
  method: string;
}

const NOT_FOUND = JSON.stringify({ message: "Not Found", status: 404 });

function classify(url: string, method: string): Call["role"] {
  if (url.includes("/api/v1/stats/aggregate")) return "stats";
  if (url.includes("/api/v1/sites/")) return method === "PUT" ? "sitesPut" : "sitesGet";
  return "unknown";
}

/** Install a fetch stub that answers the three routes from `routes` and
 *  records every call, runs `fn`, then restores the real fetch. */
async function withFetch(routes: Routes, fn: (calls: Call[]) => Promise<void>): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const role = classify(url, method);
    calls.push({ role, url, method });
    const resp = role === "unknown" ? undefined : routes[role];
    if (!resp) return new Response("unmapped", { status: 598 });
    return new Response(resp.body ?? "", { status: resp.status, statusText: resp.statusText });
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const failures: string[] = [];

async function expect(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

async function caught(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to throw, but it resolved");
}

console.log("renameSite:");

await expect(
  "CE (PUT 404 + Stats sees site) → Sites-API-unavailable, points at the dashboard",
  async () => {
    await withFetch(
      {
        sitesPut: { status: 404, body: NOT_FOUND, statusText: "Not Found" },
        stats: { status: 200, body: '{"results":{"visitors":{"value":3}}}' },
      },
      async (calls) => {
        const err = await caught(() =>
          renameSite(BASE, KEY, "protocol.example.com", "play.example.com"),
        );
        assert.ok(
          err instanceof PlausibleSitesApiUnavailableError,
          `expected PlausibleSitesApiUnavailableError, got ${err.name}: ${err.message}`,
        );
        assert.match(err.message, /Sites API is not available/);
        assert.match(err.message, /dashboard/);
        assert.match(err.message, /stats history is preserved/i);
        // Must NOT fall through to the misleading "no site for X" text.
        assert.doesNotMatch(err.message, /has no site for/);
        // The Stats probe is what breaks the tie, so it must have run.
        assert.ok(
          calls.some((c) => c.role === "stats"),
          "expected a Stats API probe",
        );
      },
    );
  },
);

await expect(
  "genuinely missing site (PUT 404 + Stats 404) → accurate 'no site' error",
  async () => {
    await withFetch(
      { sitesPut: { status: 404, body: NOT_FOUND }, stats: { status: 404, body: NOT_FOUND } },
      async () => {
        const err = await caught(() =>
          renameSite(BASE, KEY, "ghost.example.com", "new.example.com"),
        );
        assert.ok(
          !(err instanceof PlausibleSitesApiUnavailableError),
          "should be a plain not-found error",
        );
        assert.match(err.message, /has no site for "ghost\.example\.com"/);
      },
    );
  },
);

await expect(
  "inconclusive Stats probe (PUT 404 + Stats 401) → 'no site' (Cloud-safe default)",
  async () => {
    await withFetch(
      { sitesPut: { status: 404, body: NOT_FOUND }, stats: { status: 401 } },
      async () => {
        const err = await caught(() =>
          renameSite(BASE, KEY, "ghost.example.com", "new.example.com"),
        );
        assert.ok(!(err instanceof PlausibleSitesApiUnavailableError));
        assert.match(err.message, /has no site for/);
      },
    );
  },
);

await expect("PUT 406 → Sites-API-unavailable without probing the Stats API", async () => {
  await withFetch({ sitesPut: { status: 406 } }, async (calls) => {
    const err = await caught(() =>
      renameSite(BASE, KEY, "protocol.example.com", "play.example.com"),
    );
    assert.ok(err instanceof PlausibleSitesApiUnavailableError, `got ${err.name}: ${err.message}`);
    assert.match(err.message, /dashboard/);
    assert.equal(
      calls.filter((c) => c.role === "stats").length,
      0,
      "406 is unambiguous — no Stats probe",
    );
  });
});

await expect("PUT 200 → success, no Stats probe", async () => {
  await withFetch({ sitesPut: { status: 200, body: "{}" } }, async (calls) => {
    const result = await renameSite(BASE, KEY, "Old.Example.com", "new.example.com");
    assert.deepEqual(result, {
      oldDomain: "old.example.com",
      newDomain: "new.example.com",
      baseUrl: BASE,
    });
    assert.equal(calls.filter((c) => c.role === "stats").length, 0);
    assert.equal(calls.filter((c) => c.role === "sitesPut").length, 1);
  });
});

await expect("PUT 500 → generic rename-failed error", async () => {
  await withFetch(
    { sitesPut: { status: 500, statusText: "Internal Server Error", body: "boom" } },
    async () => {
      const err = await caught(() => renameSite(BASE, KEY, "a.example.com", "b.example.com"));
      assert.ok(!(err instanceof PlausibleSitesApiUnavailableError));
      assert.match(err.message, /rename site failed: 500/);
    },
  );
});

await expect("identical domains → rejected before any network call", async () => {
  await withFetch({}, async (calls) => {
    const err = await caught(() => renameSite(BASE, KEY, "same.example.com", "same.example.com"));
    assert.match(err.message, /identical/);
    assert.equal(calls.length, 0);
  });
});

console.log("siteExists:");

await expect("Sites API 200 → exists, no Stats probe", async () => {
  await withFetch({ sitesGet: { status: 200, body: "{}" } }, async (calls) => {
    assert.equal(await siteExists(BASE, KEY, "live.example.com"), true);
    assert.equal(calls.filter((c) => c.role === "stats").length, 0);
  });
});

await expect("CE 406 + Stats sees site → exists (no false negative)", async () => {
  await withFetch(
    {
      sitesGet: { status: 406 },
      stats: { status: 200, body: '{"results":{"visitors":{"value":0}}}' },
    },
    async (calls) => {
      assert.equal(await siteExists(BASE, KEY, "protocol.example.com"), true);
      assert.ok(calls.some((c) => c.role === "stats"));
    },
  );
});

await expect("CE 404 + Stats sees site → exists (item-route-404 variant)", async () => {
  await withFetch(
    { sitesGet: { status: 404, body: NOT_FOUND }, stats: { status: 200, body: "{}" } },
    async () => {
      assert.equal(await siteExists(BASE, KEY, "protocol.example.com"), true);
    },
  );
});

await expect("404 + Stats 404 → does not exist", async () => {
  await withFetch(
    { sitesGet: { status: 404, body: NOT_FOUND }, stats: { status: 404, body: NOT_FOUND } },
    async () => {
      assert.equal(await siteExists(BASE, KEY, "ghost.example.com"), false);
    },
  );
});

await expect("406 + inconclusive Stats (401) → does not exist", async () => {
  await withFetch({ sitesGet: { status: 406 }, stats: { status: 401 } }, async () => {
    assert.equal(await siteExists(BASE, KEY, "protocol.example.com"), false);
  });
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll plausible-ce tests passed.");
