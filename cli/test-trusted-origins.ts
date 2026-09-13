/**
 * Native-client origins → TRUSTED_ORIGINS on the server's Coolify app.
 *
 * The bug these encode (tracktime, 2026-09): hatchkit computed the
 * Capacitor origins at scaffold time but only ever wrote them into
 * `.env.example`. The project kept its production env in Coolify, so the
 * origins never reached the server, and a real phone got
 * `403 INVALID_ORIGIN` on sign-in while every curl test passed (curl sends
 * no `Sec-Fetch-*`, so better-auth never validated its Origin).
 *
 * The properties that keep it from coming back:
 *   1. One mapping. The .env.example rewrite and the Coolify push produce
 *      the same list, and both call sites stay wired to it.
 *   2. Merge, never overwrite: hand-added origins survive in their order,
 *      duplicates collapse, nothing is removed — and a live value the
 *      token can't read is never written over.
 *   3. A write is only "updated" once GET /envs shows it. A missing key
 *      is created with POST; a write that changed nothing is a failure.
 *   4. Server app only, chosen by routing role — never the client half.
 *   5. No write without confirmation, and a redeploy is owed on an app
 *      that has already booted.
 *   6. Domain-independent: rename-domain neither adds nor strips them.
 *
 * No test touches a real Coolify: `fetch` is replaced by a stateful fake.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.js (pulled in by deploy/trusted-origins.ts) opens its store at
// import time — keep it away from the user's real config.
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "trusted-origins-conf-"));

const {
  hasNativeClient,
  malformedOrigins,
  mergeTrustedOrigins,
  nativeClientOrigins,
  parseOriginList,
} = await import("./src/scaffold/native-origins.js");
const {
  TRUSTED_ORIGINS_KEY,
  ensureNativeTrustedOrigins,
  mergePushedTrustedOrigins,
  pushNativeOriginsToServerApps,
  redeployNotice,
  securityNote,
  serverAppsOf,
} = await import("./src/deploy/trusted-origins.js");
const { computeRoutingPlan } = await import("./src/deploy/routing.js");
const { CoolifyApi } = await import("./src/utils/coolify-api.js");
const { updateEnvExample } = await import("./src/scaffold/starter-files.js");
const { _internals: renameInternals } = await import("./src/deploy/rename-domain.js");
const { setWorkflowDeployVerifyUrls } = await import("./src/scaffold/deploy-verification.js");

const failures: string[] = [];

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

// ---------------------------------------------------------------------------
// A stateful fake Coolify env store
// ---------------------------------------------------------------------------

interface EnvRow {
  key: string;
  value: string;
  is_preview: boolean;
}

interface FakeOptions {
  /** Emulate a token without `read:sensitive`: rows come back with no
   *  `value` field at all. */
  hideValues?: boolean;
  /** Emulate a build whose bulk PATCH only updates existing keys. */
  bulkCreates?: boolean;
  /** Emulate a build where POST /envs also silently does nothing. */
  postCreates?: boolean;
}

function fakeCoolify(rows: EnvRow[], opts: FakeOptions = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const { bulkCreates = true, postCreates = true } = opts;
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = new URL(String(url)).pathname.replace(/^\/api\/v1/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "GET" && /\/envs$/.test(path)) {
      return json(
        rows.map((r) => (opts.hideValues ? { key: r.key, is_preview: r.is_preview } : { ...r })),
      );
    }
    if (method === "PATCH" && /\/envs\/bulk$/.test(path)) {
      for (const item of (body as { data: EnvRow[] }).data) {
        const existing = rows.find((r) => r.key === item.key && r.is_preview === !!item.is_preview);
        if (existing) existing.value = item.value;
        else if (bulkCreates) rows.push({ key: item.key, value: item.value, is_preview: false });
      }
      return json([], 201);
    }
    if (method === "POST" && /\/envs$/.test(path)) {
      const item = body as EnvRow;
      if (rows.some((r) => r.key === item.key && !r.is_preview)) {
        return json({ message: "Environment variable already exists." }, 409);
      }
      if (postCreates) rows.push({ key: item.key, value: item.value, is_preview: false });
      return json({ uuid: "env-1" }, 201);
    }
    return json({ message: "unexpected call" }, 500);
  };
  return { fetch: impl as unknown as typeof fetch, calls, rows };
}

async function withFake<T>(
  fake: { fetch: typeof fetch },
  fn: (api: InstanceType<typeof CoolifyApi>) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    return await fn(new CoolifyApi({ url: "https://coolify.example", token: "t" }));
  } finally {
    globalThis.fetch = original;
  }
}

const APP = { uuid: "srv-uuid", name: "tracktime-server" };
const silent = () => {};
const writes = (calls: Array<{ method: string }>) => calls.filter((c) => c.method !== "GET").length;

// ---------------------------------------------------------------------------
// 1. The mapping
// ---------------------------------------------------------------------------

console.log("\nnativeClientOrigins:");

const COMBOS: Array<[string[], string[]]> = [
  [[], []],
  [["websocket", "stripe"], []],
  [["mobile"], ["capacitor://localhost", "https://localhost"]],
  [["desktop"], ["app://-"]],
  [["desktop-tauri"], ["tauri://localhost", "http://tauri.localhost"]],
  [
    ["desktop", "mobile"],
    ["capacitor://localhost", "https://localhost", "app://-"],
  ],
  [
    ["desktop-tauri", "mobile"],
    ["capacitor://localhost", "https://localhost", "tauri://localhost", "http://tauri.localhost"],
  ],
  [
    ["desktop-tauri", "desktop", "mobile", "s3"],
    [
      "capacitor://localhost",
      "https://localhost",
      "app://-",
      "tauri://localhost",
      "http://tauri.localhost",
    ],
  ],
];
for (const [features, expected] of COMBOS) {
  await check(`[${features.join(", ") || "none"}] → ${expected.join(", ") || "(none)"}`, () => {
    assert.deepEqual(nativeClientOrigins(features), expected);
    assert.equal(hasNativeClient(features), expected.length > 0);
  });
}

await check("every origin is an exact scheme://host — no path, no trailing slash", () => {
  // better-auth matches verbatim in production; `https://localhost/` is
  // a silent 403.
  const all = nativeClientOrigins(["mobile", "desktop", "desktop-tauri"]);
  assert.deepEqual(malformedOrigins(all), []);
  for (const o of all) assert.ok(!o.endsWith("/"), o);
});

await check("Android's Capacitor origin is https, not http", () => {
  // androidScheme defaults to https.
  assert.ok(nativeClientOrigins(["mobile"]).includes("https://localhost"));
  assert.ok(!nativeClientOrigins(["mobile"]).includes("http://localhost"));
});

// ---------------------------------------------------------------------------
// 2. The merge
// ---------------------------------------------------------------------------

console.log("\nmergeTrustedOrigins:");

await check("keeps a hand-added origin and its position, appends only what's missing", () => {
  const m = mergeTrustedOrigins("chrome-extension://abcdef,https://localhost", [
    "capacitor://localhost",
    "https://localhost",
  ]);
  assert.deepEqual(m.after, [
    "chrome-extension://abcdef",
    "https://localhost",
    "capacitor://localhost",
  ]);
  assert.deepEqual(m.added, ["capacitor://localhost"]);
  assert.equal(m.value, "chrome-extension://abcdef,https://localhost,capacitor://localhost");
  assert.ok(m.changed);
});

await check("never removes an origin, whatever it is", () => {
  const live = "https://a.example, chrome-extension://x ,app://-,https://broken.example/";
  const m = mergeTrustedOrigins(live, ["app://-"]);
  for (const o of parseOriginList(live)) assert.ok(m.after.includes(o), `${o} dropped`);
  assert.equal(m.changed, false);
});

await check("de-duplicates, keeping first occurrence order", () => {
  const m = mergeTrustedOrigins("app://-,https://a.example,app://-", ["tauri://localhost"]);
  assert.deepEqual(m.after, ["app://-", "https://a.example", "tauri://localhost"]);
});

await check("a duplicate alone is not a reason to write", () => {
  assert.equal(mergeTrustedOrigins("app://-,app://-", ["app://-"]).changed, false);
});

await check("unset / empty / quoted live values", () => {
  assert.deepEqual(mergeTrustedOrigins(undefined, ["app://-"]).after, ["app://-"]);
  assert.deepEqual(mergeTrustedOrigins("", ["app://-"]).after, ["app://-"]);
  assert.deepEqual(parseOriginList('"https://a.example,app://-"'), [
    "https://a.example",
    "app://-",
  ]);
});

await check("malformedOrigins flags trailing slashes and paths, not valid origins", () => {
  assert.deepEqual(
    malformedOrigins(["https://a.example/", "https://a.example/api", "chrome-extension://abc"]),
    ["https://a.example/", "https://a.example/api"],
  );
});

// ---------------------------------------------------------------------------
// 3. Server-app selection
// ---------------------------------------------------------------------------

console.log("\nserverAppsOf:");

await check("split → only the server half", () => {
  const plan = computeRoutingPlan({
    name: "tracktime",
    domain: "tracktime.example",
    topology: "split",
    surfaces: "split",
  });
  assert.deepEqual(
    serverAppsOf(plan.apps, "split").map((a) => a.appName),
    ["tracktime-server"],
  );
});

await check("single-origin fullstack → the one compose app", () => {
  const plan = computeRoutingPlan({
    name: "tt",
    domain: "tt.example",
    topology: "single-origin",
    surfaces: "fullstack",
  });
  assert.deepEqual(
    serverAppsOf(plan.apps, "fullstack").map((a) => a.appName),
    ["tt"],
  );
});

await check("static → none, even though its app is a compose app", () => {
  const plan = computeRoutingPlan({
    name: "tt",
    domain: "tt.example",
    topology: "single-origin",
    surfaces: "static",
  });
  assert.equal(plan.apps[0].role, "compose");
  assert.deepEqual(serverAppsOf(plan.apps, "static"), []);
});

await check("by role, not by name — a client app NAMED like a server is not chosen", () => {
  const apps = [
    { uuid: "1", name: "x-server", role: "client" as const },
    { uuid: "2", name: "x-frontend", role: "server" as const },
  ];
  assert.deepEqual(
    serverAppsOf(apps).map((a) => a.uuid),
    ["2"],
  );
});

// ---------------------------------------------------------------------------
// 4. The Coolify push
// ---------------------------------------------------------------------------

console.log("\nensureNativeTrustedOrigins:");

await check("merges into a live hand-added list, writes, reads back, owes a redeploy", async () => {
  const fake = fakeCoolify([
    { key: "TRUSTED_ORIGINS", value: "chrome-extension://pinned", is_preview: false },
  ]);
  const o = await withFake(fake, (api) =>
    ensureNativeTrustedOrigins({ api, app: APP, features: ["mobile"], yes: true, log: silent }),
  );
  assert.equal(o.status, "updated");
  assert.equal(o.needsRedeploy, true);
  const patch = fake.calls.find((c) => c.method === "PATCH");
  assert.deepEqual(
    (patch?.body as { data: EnvRow[] }).data.map((d) => [d.key, d.value]),
    [["TRUSTED_ORIGINS", "chrome-extension://pinned,capacitor://localhost,https://localhost"]],
  );
  assert.equal(patch?.path, "/applications/srv-uuid/envs/bulk");
  // Read back after the write, not just before it.
  const lastGet = fake.calls.map((c) => c.method).lastIndexOf("GET");
  assert.ok(lastGet > fake.calls.indexOf(patch as (typeof fake.calls)[number]));
  assert.equal(
    fake.rows[0].value,
    "chrome-extension://pinned,capacitor://localhost,https://localhost",
  );
});

await check(
  "missing key the bulk PATCH didn't create → created with POST, then confirmed",
  async () => {
    const fake = fakeCoolify([], { bulkCreates: false });
    const o = await withFake(fake, (api) =>
      ensureNativeTrustedOrigins({ api, app: APP, features: ["desktop"], yes: true, log: silent }),
    );
    assert.equal(o.status, "updated");
    assert.ok(
      fake.calls.some((c) => c.method === "POST" && c.path === "/applications/srv-uuid/envs"),
    );
    assert.deepEqual(fake.rows, [{ key: "TRUSTED_ORIGINS", value: "app://-", is_preview: false }]);
  },
);

await check("a green write that set nothing is reported as FAILED", async () => {
  const fake = fakeCoolify([], { bulkCreates: false, postCreates: false });
  const o = await withFake(fake, (api) =>
    ensureNativeTrustedOrigins({ api, app: APP, features: ["mobile"], yes: true, log: silent }),
  );
  assert.equal(o.status, "failed");
  assert.match(o.detail ?? "", /still absent on read-back/);
});

await check("a read-back that doesn't match the write is FAILED", async () => {
  const fake = fakeCoolify([{ key: "TRUSTED_ORIGINS", value: "app://-", is_preview: false }]);
  const original = fake.fetch;
  // Coolify accepts the PATCH and keeps the old value.
  fake.fetch = (async (url: string | URL | Request, init?: RequestInit) =>
    init?.method === "PATCH"
      ? new Response("[]", { status: 201 })
      : original(url, init)) as unknown as typeof fetch;
  const o = await withFake(fake, (api) =>
    ensureNativeTrustedOrigins({ api, app: APP, features: ["mobile"], yes: true, log: silent }),
  );
  assert.equal(o.status, "failed");
  assert.match(o.detail ?? "", /read-back doesn't match/);
});

await check("unreadable live value (no read:sensitive) → nothing written", async () => {
  const fake = fakeCoolify(
    [{ key: "TRUSTED_ORIGINS", value: "chrome-extension://pinned", is_preview: false }],
    { hideValues: true },
  );
  const o = await withFake(fake, (api) =>
    ensureNativeTrustedOrigins({ api, app: APP, features: ["mobile"], yes: true, log: silent }),
  );
  assert.equal(o.status, "unreadable");
  assert.equal(writes(fake.calls), 0);
  assert.equal(fake.rows[0].value, "chrome-extension://pinned");
});

await check("a PREVIEW row with the key doesn't count as the production value", async () => {
  const fake = fakeCoolify([
    { key: "TRUSTED_ORIGINS", value: "capacitor://localhost,https://localhost", is_preview: true },
  ]);
  const o = await withFake(fake, (api) =>
    ensureNativeTrustedOrigins({ api, app: APP, features: ["mobile"], yes: true, log: silent }),
  );
  assert.equal(o.status, "updated");
  assert.ok(fake.rows.some((r) => r.key === TRUSTED_ORIGINS_KEY && !r.is_preview));
});

await check("already trusted → in-sync, no write", async () => {
  const fake = fakeCoolify([
    { key: "TRUSTED_ORIGINS", value: "https://localhost,capacitor://localhost", is_preview: false },
  ]);
  const o = await withFake(fake, (api) =>
    ensureNativeTrustedOrigins({ api, app: APP, features: ["mobile"], yes: true, log: silent }),
  );
  assert.equal(o.status, "in-sync");
  assert.equal(writes(fake.calls), 0);
});

await check("--dry-run shows the diff and writes nothing", async () => {
  const fake = fakeCoolify([]);
  const lines: string[] = [];
  const o = await withFake(fake, (api) =>
    ensureNativeTrustedOrigins({
      api,
      app: APP,
      features: ["mobile"],
      dryRun: true,
      log: (l) => lines.push(l),
    }),
  );
  assert.equal(o.status, "would-update");
  assert.equal(writes(fake.calls), 0);
  const text = lines.join("\n");
  assert.match(text, /before: \(not set\)/);
  assert.match(text, /after:\s+capacitor:\/\/localhost,https:\/\/localhost/);
});

await check("no TTY and no --yes → needs-confirmation, nothing written", async () => {
  const fake = fakeCoolify([]);
  const o = await withFake(fake, (api) =>
    ensureNativeTrustedOrigins({
      api,
      app: APP,
      features: ["mobile"],
      interactive: false,
      log: silent,
    }),
  );
  assert.equal(o.status, "needs-confirmation");
  assert.equal(writes(fake.calls), 0);
});

await check("the prompt names the app; a no writes nothing", async () => {
  const fake = fakeCoolify([]);
  const asked: string[] = [];
  const lines: string[] = [];
  const o = await withFake(fake, (api) =>
    ensureNativeTrustedOrigins({
      api,
      app: APP,
      features: ["mobile"],
      interactive: true,
      confirm: async (m) => {
        asked.push(m);
        return false;
      },
      log: (l) => lines.push(l),
    }),
  );
  assert.equal(o.status, "declined");
  assert.equal(writes(fake.calls), 0);
  assert.match(asked[0], /tracktime-server/);
  // The trade is shown before the question, in plain words.
  assert.match(lines.join("\n"), /page served from https:\/\/localhost on a/);
});

await check("security note: https://localhost trade named only when it's being added", () => {
  assert.ok(securityNote(["https://localhost"]).join(" ").includes("https://localhost on a"));
  assert.ok(!securityNote(["app://-"]).join(" ").includes("https://localhost"));
});

await check("a fresh (never-deployed) app owes no redeploy; a live one does", async () => {
  const fresh = await withFake(fakeCoolify([]), (api) =>
    ensureNativeTrustedOrigins({
      api,
      app: APP,
      features: ["desktop"],
      yes: true,
      freshApp: true,
      log: silent,
    }),
  );
  assert.equal(fresh.needsRedeploy, false);
  assert.deepEqual(redeployNotice([fresh]), []);
  const live = await withFake(fakeCoolify([]), (api) =>
    ensureNativeTrustedOrigins({ api, app: APP, features: ["desktop"], yes: true, log: silent }),
  );
  assert.match(redeployNotice([live]).join("\n"), /still has the OLD list/);
});

console.log("\npushNativeOriginsToServerApps:");

await check("split: the client app is never read or written", async () => {
  const fake = fakeCoolify([]);
  const outcomes = await withFake(fake, (api) =>
    pushNativeOriginsToServerApps({
      api,
      apps: [
        { uuid: "client-uuid", name: "tt-client", role: "client" },
        { uuid: "server-uuid", name: "tt-server", role: "server" },
      ],
      features: ["mobile"],
      surfaces: "split",
      yes: true,
      log: silent,
    }),
  );
  assert.deepEqual(
    outcomes.map((o) => o.app),
    ["tt-server"],
  );
  assert.ok(fake.calls.length > 0);
  assert.ok(fake.calls.every((c) => !c.path.includes("client-uuid")));
});

await check("no native feature → Coolify is not called at all", async () => {
  const fake = fakeCoolify([]);
  const outcomes = await withFake(fake, (api) =>
    pushNativeOriginsToServerApps({
      api,
      apps: [{ uuid: "u", name: "tt", role: "compose" }],
      features: ["websocket"],
      yes: true,
      log: silent,
    }),
  );
  assert.deepEqual(outcomes, []);
  assert.equal(fake.calls.length, 0);
});

console.log("\nsync env pass — .env.production TRUSTED_ORIGINS:");

await check("the file value is merged into the live one, not pushed over it", async () => {
  const fake = fakeCoolify([
    { key: "TRUSTED_ORIGINS", value: "chrome-extension://pinned,app://-", is_preview: false },
  ]);
  const merged = await withFake(fake, (api) =>
    mergePushedTrustedOrigins(api, "srv-uuid", "app://-,tauri://localhost"),
  );
  assert.equal(merged, "chrome-extension://pinned,app://-,tauri://localhost");
});

await check("unreadable live value → null (the caller drops the key)", async () => {
  const fake = fakeCoolify([{ key: "TRUSTED_ORIGINS", value: "x://y", is_preview: false }], {
    hideValues: true,
  });
  assert.equal(
    await withFake(fake, (api) => mergePushedTrustedOrigins(api, "srv-uuid", "app://-")),
    null,
  );
});

// ---------------------------------------------------------------------------
// 5. One list, two call sites
// ---------------------------------------------------------------------------

console.log("\none source of truth:");

const SRC = join(import.meta.dirname, "src");
const source = (rel: string) => readFileSync(join(SRC, rel), "utf-8");
/** The text of one top-level exported function, up to the next one. */
function functionBody(rel: string, name: string): string {
  const text = source(rel);
  const start = text.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} not found in ${rel}`);
  const next = text.indexOf("\nexport ", start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

for (const features of [["mobile"], ["desktop"], ["desktop-tauri", "mobile"]]) {
  await check(`.env.example and the Coolify push write the same list [${features}]`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "trusted-origins-env-"));
    try {
      writeFileSync(
        join(dir, ".env.example"),
        "FRONTEND_URL=http://localhost:3000\n# TRUSTED_ORIGINS=\n",
      );
      updateEnvExample(dir, ".env.example", {
        domain: "tt.example",
        features,
      } as unknown as Parameters<typeof updateEnvExample>[2]);
      const fileValue = /^TRUSTED_ORIGINS=(.*)$/m.exec(
        readFileSync(join(dir, ".env.example"), "utf-8"),
      )?.[1];
      const fake = fakeCoolify([]);
      await withFake(fake, (api) =>
        pushNativeOriginsToServerApps({
          api,
          apps: [{ uuid: "u", name: "tt", role: "compose" }],
          features,
          yes: true,
          log: silent,
        }),
      );
      assert.equal(fake.rows[0]?.value, fileValue);
      assert.equal(fileValue, nativeClientOrigins(features).join(","));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

await check("`hatchkit create` still pushes: runCoolifySetup calls the shared push", () => {
  // If this fails, the .env.example rewrite is back to being the only
  // place the origins land — the exact tracktime failure.
  const body = functionBody("deploy/coolify.ts", "runCoolifySetup");
  assert.match(body, /pushNativeOriginsToServerApps\(\{[\s\S]*?features: config\.features/);
});

await check("`hatchkit sync` still pushes: runSync calls the shared push", () => {
  const body = functionBody("deploy/sync.ts", "runSync");
  assert.match(body, /pushNativeOriginsToServerApps\(\{[\s\S]*?features: manifest\.features/);
});

await check("`hatchkit adopt` still pushes: wireProjectIntoCoolify calls the shared push", () => {
  const body = functionBody("deploy/coolify-app.ts", "wireProjectIntoCoolify");
  assert.match(body, /pushNativeOriginsToServerApps\(\{/);
  assert.match(source("adopt.ts"), /nativeClientFeatures:/);
});

await check("`hatchkit update` still pushes after adding a native feature", () => {
  const body = functionBody("scaffold/update.ts", "runUpdate");
  assert.match(body, /pushNativeOriginsForProject\(/);
});

await check("the .env.example rewrite uses the shared mapping, not its own literals", () => {
  const text = source("scaffold/starter-files.ts");
  assert.match(text, /nativeClientOrigins\(config\.features\)/);
  assert.ok(!text.includes('"capacitor://localhost"'), "literal origin reintroduced");
});

await check("no module but native-origins.ts spells an origin out", () => {
  for (const rel of ["deploy/trusted-origins.ts", "deploy/sync.ts", "deploy/coolify.ts"]) {
    assert.ok(!source(rel).includes('"tauri://localhost"'), `${rel} carries a literal`);
    assert.ok(!source(rel).includes('"capacitor://localhost"'), `${rel} carries a literal`);
  }
});

// ---------------------------------------------------------------------------
// 6. Domain independence
// ---------------------------------------------------------------------------

console.log("\nrename-domain:");

await check("stacks-env rewrite swaps the domain and leaves native origins alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "trusted-origins-rename-"));
  try {
    const path = join(dir, "coolify.env");
    writeFileSync(
      path,
      'TRUSTED_ORIGINS="https://old.example.com,capacitor://localhost,https://localhost,app://-,tauri://localhost,http://tauri.localhost"\n',
    );
    const edit = renameInternals.rewriteStacksEnv(
      path,
      "old.example.com",
      "new.example.com",
      "example.com",
      "example.com",
    );
    assert.equal(
      edit.after,
      'TRUSTED_ORIGINS="https://new.example.com,capacitor://localhost,https://localhost,app://-,tauri://localhost,http://tauri.localhost"\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check("the workflow URL rewrite rename-domain uses doesn't touch the native list", () => {
  const wf = [
    "          HATCHKIT_WEB_URL: https://old.example.com",
    "          HATCHKIT_API_URL: https://old.example.com",
    '          HATCHKIT_NATIVE_ORIGINS: "capacitor://localhost,https://localhost"',
  ].join("\n");
  const after = setWorkflowDeployVerifyUrls(wf, "new.example.com");
  assert.match(after, /HATCHKIT_NATIVE_ORIGINS: "capacitor:\/\/localhost,https:\/\/localhost"/);
  assert.match(after, /HATCHKIT_WEB_URL: https:\/\/new\.example\.com/);
});

await check("rename-domain has no path to Coolify's TRUSTED_ORIGINS", () => {
  const text = source("deploy/rename-domain.ts");
  assert.ok(!/nativeClientOrigins|trusted-origins\.js|setAppEnv/.test(text));
});

rmSync(process.env.HATCHKIT_CONF_DIR as string, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log("\n  all trusted-origins checks passed\n");
