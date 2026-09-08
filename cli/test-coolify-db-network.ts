/**
 * `connect_to_docker_network` — the setting that lets a Coolify app
 * reach the Coolify-managed database hatchkit provisioned for it.
 *
 * The bug these encode, observed on tracktime 2026-09-08 against
 * Coolify 4.0.0-beta.469:
 *
 *   [server] Failed to start: MongooseServerSelectionError:
 *     getaddrinfo ENOTFOUND x3rnoe4qdk846u4q3wjw2fw0
 *
 * A `dockercompose` app is deployed onto a Docker network named after
 * its own uuid; a Coolify-managed database sits on the shared `coolify`
 * network. Isolated, so the app cannot resolve the hostname Coolify
 * itself wrote into `internal_db_url` and hatchkit encrypted into
 * MONGODB_URI. The app crash-looped from its first deploy while Coolify
 * reported `running:healthy` and the proxy answered `503 no available
 * server` — the same body an unconfigured hostname gets.
 *
 * The properties that keep that from coming back:
 *   1. The field is WRITE-ONLY. Nothing may assert on a GET round-trip;
 *      the observable proxy is `restart_count` + `last_restart_type`.
 *   2. Detection is a set-membership test on parsed URL hosts against
 *      the managed-database list — not a substring scan over secrets.
 *   3. `restart_count > 0` alone is not a fault. A redeploy bumps it.
 *   4. A rejected `connect_to_docker_network` must THROW, not be
 *      dropped and retried: dropping it leaves the app broken in
 *      exactly the way that is hardest to see.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  appLooksUnhealthy,
  appShowsCrashSymptoms,
  connectToDockerNetworkRecipe,
  coolifyDbHostsIn,
  enableDockerNetworkForApps,
  needsDockerNetwork,
  readTheLogRecipe,
} from "./src/deploy/coolify-db-network.js";
import { CoolifyApi, describeCoolifyPatchLimit } from "./src/utils/coolify-api.js";

const failures: string[] = [];

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

/** The database uuid from the real incident, and a realistic
 *  `internal_db_url` built around it. */
const DB_UUID = "x3rnoe4qdk846u4q3wjw2fw0";
const MONGO_URL = `mongodb://root:s3cr3tp4ss@${DB_UUID}:27017/?directConnection=true`;
const DATABASES = [{ uuid: DB_UUID, name: "tracktime-mongo" }];

/** Stand in for `fetch` so no test touches a real Coolify. Records the
 *  method, path and body of every request; answers 200 unless the body
 *  carries a field named in `rejects`. */
function fakeCoolify(rejects: string[] = []): {
  fetch: typeof fetch;
  calls: Array<{ method: string; path: string; body: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method: init?.method ?? "GET", path: String(url), body });
    const offending = rejects.filter((f) => f in body);
    if (offending.length > 0) {
      const errors = Object.fromEntries(offending.map((f) => [f, ["This field is not allowed."]]));
      return new Response(JSON.stringify({ message: "Validation failed.", errors }), {
        status: 422,
        statusText: "Unprocessable Entity",
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

async function withFakeFetch<T>(
  fake: { fetch: typeof fetch },
  fn: (api: CoolifyApi) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    return await fn(new CoolifyApi({ url: "https://coolify.example", token: "t" }));
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// Detecting a reference to a Coolify-managed database
// ---------------------------------------------------------------------------

await check("finds the managed database behind a real internal_db_url", () => {
  const refs = coolifyDbHostsIn([{ key: "MONGODB_URI", value: MONGO_URL }], DATABASES);
  assert.deepEqual(refs, [
    { key: "MONGODB_URI", host: DB_UUID, database: "tracktime-mongo" },
  ]);
});

await check("matches postgres and redis URLs the same way", () => {
  const dbs = [
    { uuid: "pg000000000000000000000a", name: "app-postgres" },
    { uuid: "rd000000000000000000000b", name: "app-redis" },
  ];
  const refs = coolifyDbHostsIn(
    [
      { key: "POSTGRES_URL", value: "postgresql://u:p@pg000000000000000000000a:5432/app" },
      { key: "REDIS_URL", value: "redis://:p@rd000000000000000000000b:6379" },
    ],
    dbs,
  );
  assert.deepEqual(
    refs.map((r) => r.key),
    ["POSTGRES_URL", "REDIS_URL"],
  );
});

await check("a database addressed by NAME is matched too", () => {
  const refs = coolifyDbHostsIn(
    [{ key: "MONGODB_URI", value: "mongodb://root:p@tracktime-mongo:27017/db" }],
    DATABASES,
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0].database, "tracktime-mongo");
});

await check("an in-stack compose service is NOT a managed database", () => {
  // `single-origin` runs mongo as a service in the project's own
  // compose, on the app's own network. It needs no join, and claiming
  // otherwise would put every such project on the shared network.
  const refs = coolifyDbHostsIn(
    [{ key: "MONGODB_URI", value: "mongodb://mongo:27017/app" }],
    DATABASES,
  );
  assert.deepEqual(refs, []);
});

await check("a credential that merely CONTAINS a db uuid is not a match", () => {
  // The reason detection parses the URL host instead of scanning the
  // string: a password is not a hostname.
  const refs = coolifyDbHostsIn(
    [{ key: "SOME_TOKEN", value: `https://api.example.com/?k=${DB_UUID}` }],
    DATABASES,
  );
  assert.deepEqual(refs, []);
});

await check("non-URL env values are ignored without throwing", () => {
  const refs = coolifyDbHostsIn(
    [
      { key: "NODE_ENV", value: "production" },
      { key: "EMPTY", value: "" },
      { key: "NOT_A_URL", value: "mongodb://[::broken" },
    ],
    DATABASES,
  );
  assert.deepEqual(refs, []);
});

await check("no managed databases at all means nothing to reference", () => {
  assert.deepEqual(coolifyDbHostsIn([{ key: "MONGODB_URI", value: MONGO_URL }], []), []);
});

// ---------------------------------------------------------------------------
// Scoping: which apps need the join
// ---------------------------------------------------------------------------

const REFS = coolifyDbHostsIn([{ key: "MONGODB_URI", value: MONGO_URL }], DATABASES);

await check("a dockercompose app pointed at a managed database needs the join", () => {
  assert.equal(needsDockerNetwork({ buildPack: "dockercompose" }, REFS), true);
});

await check("a dockercompose app with no managed database is left alone", () => {
  assert.equal(needsDockerNetwork({ buildPack: "dockercompose" }, []), false);
});

await check("non-compose build packs are unaffected", () => {
  for (const buildPack of ["nixpacks", "static", "dockerfile"] as const) {
    assert.equal(needsDockerNetwork({ buildPack }, REFS), false, buildPack);
  }
});

// ---------------------------------------------------------------------------
// Crash evidence — the only thing the API will tell us
// ---------------------------------------------------------------------------

await check("restart_count climbing with last_restart_type=crash is a fault", () => {
  assert.equal(appShowsCrashSymptoms({ restartCount: 41, lastRestartType: "crash" }), true);
});

await check("a redeploy's restart is NOT a fault", () => {
  assert.equal(appShowsCrashSymptoms({ restartCount: 3, lastRestartType: "manual" }), false);
  assert.equal(appShowsCrashSymptoms({ restartCount: 3 }), false);
});

await check("zero restarts, or a build that doesn't report them, is not a fault", () => {
  assert.equal(appShowsCrashSymptoms({ restartCount: 0, lastRestartType: "crash" }), false);
  assert.equal(appShowsCrashSymptoms({}), false);
});

await check("a crash-looping app Coolify calls running:healthy still reads as unhealthy", () => {
  // The disguise that cost months: the status field is not evidence.
  assert.equal(
    appLooksUnhealthy({ status: "running:healthy", restartCount: 41, lastRestartType: "crash" }),
    true,
  );
});

await check("a genuinely healthy app is not flagged", () => {
  assert.equal(
    appLooksUnhealthy({ status: "running:healthy", restartCount: 0, lastRestartType: "" }),
    false,
  );
});

await check("a non-running status is unhealthy on its own", () => {
  assert.equal(appLooksUnhealthy({ status: "exited:unhealthy" }), true);
});

await check("a build that reports no status at all is not flagged", () => {
  assert.equal(appLooksUnhealthy({}), false);
});

// ---------------------------------------------------------------------------
// The write, and the fact that it cannot be read back
// ---------------------------------------------------------------------------

await check("updateApplication sends connect_to_docker_network as a real PATCH field", async () => {
  const fake = fakeCoolify();
  await withFakeFetch(fake, (api) =>
    api.updateApplication("abc", { connectToDockerNetwork: true }),
  );
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].method, "PATCH");
  assert.equal(fake.calls[0].body.connect_to_docker_network, true);
});

await check("getApplication does NOT surface the field — there is nothing to read back", async () => {
  // Coolify never echoes it, so a reader would see `undefined` on a
  // correctly-configured app and `undefined` on a broken one. If this
  // ever fails because someone added the field, they've built an
  // assertion that cannot distinguish those two states.
  const impl = async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        uuid: "abc",
        name: "tracktime",
        build_pack: "dockercompose",
        status: "running:healthy",
        restart_count: 41,
        last_restart_type: "crash",
        settings: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const app = await withFakeFetch({ fetch: impl as unknown as typeof fetch }, (api) =>
    api.getApplication("abc"),
  );
  assert.ok(
    !("connectToDockerNetwork" in app),
    "the field is write-only; surfacing it invites an assertion that can never be true",
  );
  assert.equal(app.restartCount, 41, "the observable proxy IS surfaced");
  assert.equal(app.lastRestartType, "crash");
  assert.equal(app.status, "running:healthy");
});

await check("restart_count is read whether Coolify reports a number or a string", async () => {
  for (const [raw, expected] of [
    [7, 7],
    ["7", 7],
    ["", undefined],
    [null, undefined],
    [-1, undefined],
  ] as const) {
    const impl = async (): Promise<Response> =>
      new Response(JSON.stringify({ uuid: "abc", restart_count: raw }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const app = await withFakeFetch({ fetch: impl as unknown as typeof fetch }, (api) =>
      api.getApplication("abc"),
    );
    assert.equal(app.restartCount, expected, `restart_count: ${JSON.stringify(raw)}`);
  }
});

await check("a rejected connect_to_docker_network THROWS rather than being dropped", async () => {
  // It is not best-effort. Dropping it would report success for a call
  // that left the app unable to reach its database — the exact silent
  // breakage this whole module exists to end.
  const fake = fakeCoolify(["connect_to_docker_network"]);
  await assert.rejects(
    () =>
      withFakeFetch(fake, (api) =>
        api.updateApplication("abc", {
          connectToDockerNetwork: true,
          dockerComposeDomains: [{ name: "app", domain: "https://x.com" }],
        }),
      ),
    /This field is not allowed/,
  );
  assert.equal(fake.calls.length, 1, "essential fields are never dropped, so never retried");
});

await check("a rejection is explained rather than surfaced raw", () => {
  const text = describeCoolifyPatchLimit("connect_to_docker_network");
  assert.ok(text, "the field must be explained");
  assert.match(text, /Connect to Predefined Network/, "name the dashboard toggle");
  assert.match(text, /ENOTFOUND/, "and the failure it prevents");
});

await check("enableDockerNetworkForApps never throws, and reports per app", async () => {
  const fake = fakeCoolify(["connect_to_docker_network"]);
  const results = await withFakeFetch(fake, (api) =>
    enableDockerNetworkForApps(api, [{ uuid: "a" }, { uuid: "b" }]),
  );
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => !r.ok && r.error));
  assert.ok(
    results[0].error?.includes("not allowed"),
    "the caller needs Coolify's own words to act on",
  );
});

await check("every app in the list is patched", async () => {
  const fake = fakeCoolify();
  const results = await withFakeFetch(fake, (api) =>
    enableDockerNetworkForApps(api, [{ uuid: "client" }, { uuid: "server" }]),
  );
  assert.ok(results.every((r) => r.ok));
  assert.equal(fake.calls.length, 2, "split topology has two halves and either can be the broken one");
});

// ---------------------------------------------------------------------------
// The hints
// ---------------------------------------------------------------------------

await check("the log recipe leads, and names the logs endpoint", () => {
  const lines = readTheLogRecipe("https://coolify.example/", "abc");
  assert.match(lines[0], /log/i, "the log has to be the first thing seen, not the last");
  assert.ok(
    lines.some((l) => l.includes("/api/v1/applications/abc/logs?lines=120")),
    "the exact call, copy-pasteable",
  );
  assert.ok(
    lines.every((l) => !l.includes("coolify.example//")),
    "a trailing slash on the configured URL must not double up",
  );
});

await check("the repair recipe carries the verified PATCH and the redeploy", () => {
  const lines = connectToDockerNetworkRecipe("https://coolify.example", "abc");
  const text = lines.join("\n");
  assert.match(text, /"connect_to_docker_network": true/, "the body that was verified to work");
  assert.match(text, /PATCH/);
  assert.match(text, /\/api\/v1\/applications\/abc/);
  assert.match(text, /hatchkit sync --deploy/, "the setting only takes effect on the next deploy");
  assert.match(text, /nothing to read back/i, "warn the next person off a GET round-trip");
});

if (failures.length > 0) {
  console.log("\nCoolify DB-network test failures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}

console.log("\nAll Coolify DB-network cases passed.");
