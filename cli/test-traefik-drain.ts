/**
 * Traefik's own drain check on an image app (src/deploy/traefik-drain.ts).
 *
 * Locks in:
 *
 *   1. The rewrite of Coolify's label set: every router and service of
 *      the app renamed, nothing else touched; each renamed router one
 *      priority below its Coolify twin; the health check on every service
 *      a router really forwards to (not a redirect-only one); idempotent,
 *      and reversible to Coolify's set.
 *   2. Which repos answer the probe: starter-shaped, build-pipeline-shaped,
 *      and a file the Dockerfile copies in.
 *   3. `custom_labels` decodes from Coolify's base64.
 *   4. `hatchkit sync` against a fake Coolify that regenerates the labels
 *      on a domains PATCH, as the real one does with readonly labels on:
 *      no labels and fast Docker timing for an image without the probe;
 *      routing PATCH, then labels from a fresh read, for one with it;
 *      nothing written once converged; labels re-applied after a routing
 *      change wipes them; Docker timing restored when the labels don't
 *      stick.
 *
 * No test touches a real Coolify: `fetch` is replaced by a fake.
 *
 * Run: `node scripts/test.mjs test-traefik-drain.ts`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Conf from "conf";
import {
  DOCKER_DRAIN_TIMING,
  TRAEFIK_DRAIN_TIMING,
  TRAEFIK_HEALTH,
} from "./src/deploy/image-runtime.js";
import { type SyncOptions, runSync } from "./src/deploy/sync.js";
import {
  coolifyLabelsFrom,
  drainLabelState,
  hasTraefikDrain,
  imageAnswersDrainProbe,
  withTraefikDrain,
} from "./src/deploy/traefik-drain.js";
import { decodeCustomLabels } from "./src/utils/coolify-api.js";
import { SECRET_KEYS, setSecret } from "./src/utils/secrets.js";

const failures: string[] = [];
async function expect(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures: Coolify's generator, as fqdnLabelsForTraefik writes it
// (bootstrap/helpers/docker.php, 4.0.0-beta.469), Traefik half + Caddy.
// ---------------------------------------------------------------------------

const UUID = "q8w1e2r3t4y5u6i7o8p9a0s1";

function coolifyLabels(
  uuid: string,
  fqdns: string[],
  port: number,
  opts: { forceHttps?: boolean; stripPrefix?: boolean } = {},
): string {
  const forceHttps = opts.forceHttps ?? true;
  const labels = [
    "traefik.enable=true",
    "traefik.http.middlewares.gzip.compress=true",
    "traefik.http.middlewares.redirect-to-https.redirectscheme.scheme=https",
  ];
  fqdns.forEach((fqdn, i) => {
    const url = new URL(fqdn);
    const path = url.pathname || "/";
    const https = `https-${i}-${uuid}`;
    const http = `http-${i}-${uuid}`;
    const rule = `Host(\`${url.hostname}\`) && PathPrefix(\`${path}\`)`;
    labels.push(
      `traefik.http.routers.${https}.rule=${rule}`,
      `traefik.http.routers.${https}.entryPoints=https`,
      `traefik.http.routers.${https}.service=${https}`,
      `traefik.http.services.${https}.loadbalancer.server.port=${port}`,
    );
    const middlewares: string[] = [];
    if (path !== "/" && opts.stripPrefix) {
      labels.push(`traefik.http.middlewares.${https}-stripprefix.stripprefix.prefixes=${path}`);
      middlewares.push(`${https}-stripprefix`);
    }
    middlewares.push("gzip");
    labels.push(
      `traefik.http.routers.${https}.middlewares=${middlewares.join(",")}`,
      `traefik.http.routers.${https}.tls=true`,
      `traefik.http.routers.${https}.tls.certresolver=letsencrypt`,
      `traefik.http.routers.${http}.rule=${rule}`,
      `traefik.http.routers.${http}.entryPoints=http`,
      `traefik.http.services.${http}.loadbalancer.server.port=${port}`,
      `traefik.http.routers.${http}.service=${http}`,
    );
    if (forceHttps) labels.push(`traefik.http.routers.${http}.middlewares=redirect-to-https`);
    labels.push(
      `caddy_${i}=${fqdn}`,
      `caddy_${i}.encode=zstd gzip`,
      `caddy_${i}.handle_path.${i}_reverse_proxy={{upstreams ${port}}}`,
      `caddy_${i}.handle_path=${path}*`,
    );
  });
  labels.push("caddy_ingress_network=coolify");
  return labels.sort().join("\n");
}

const lines = (text: string) => text.split("\n").filter(Boolean);
const OPTS = { uuid: UUID, healthPath: "/api/health" };
const TWO = coolifyLabels(UUID, ["https://example.com", "https://www.example.com"], 3000);

// ---------------------------------------------------------------------------
// 1. The rewrite
// ---------------------------------------------------------------------------

console.log("\nwithTraefikDrain:");

await expect("renames every router and service of the app, and nothing else", () => {
  const out = withTraefikDrain(TWO, OPTS);
  assert.doesNotMatch(out, new RegExp(`[.=,]https?-\\d+-${UUID}`), "no Coolify name left");
  for (const n of ["https-0", "http-0", "https-1", "http-1"]) {
    assert.match(out, new RegExp(`traefik\\.http\\.routers\\.hk-${n}-${UUID}\\.rule=`));
    assert.match(out, new RegExp(`traefik\\.http\\.routers\\.hk-${n}-${UUID}\\.service=hk-${n}-`));
    assert.match(out, new RegExp(`traefik\\.http\\.services\\.hk-${n}-${UUID}\\.loadbalancer`));
  }
  // Coolify's shared middlewares, Caddy labels and traefik.enable stay
  // byte for byte: identical definitions merge across containers.
  for (const keep of lines(TWO).filter((l) => !l.includes(UUID))) {
    assert.ok(lines(out).includes(keep), `kept: ${keep}`);
  }
});

await expect("each renamed router sits one priority below its Coolify twin", () => {
  const out = lines(withTraefikDrain(TWO, OPTS));
  for (const line of out.filter((l) => /\.rule=/.test(l))) {
    const [key, rule] = [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)];
    const router = key.replace(/\.rule$/, "");
    assert.ok(out.includes(`${router}.priority=${rule.length - 1}`), `${router} priority`);
  }
});

await expect("health check on forwarding services only, with the probe header", () => {
  const out = lines(withTraefikDrain(TWO, OPTS));
  for (const i of [0, 1]) {
    const svc = `traefik.http.services.hk-https-${i}-${UUID}.loadbalancer.healthcheck`;
    assert.ok(out.includes(`${svc}.path=/api/health`));
    assert.ok(out.includes(`${svc}.interval=${TRAEFIK_HEALTH.intervalSeconds}s`));
    assert.ok(out.includes(`${svc}.timeout=${TRAEFIK_HEALTH.timeoutSeconds}s`));
    assert.ok(out.includes(`${svc}.headers.X-Hatchkit-Drain=1`));
  }
  // http routers only redirect to https: their services see no traffic.
  assert.ok(!out.some((l) => l.includes(`hk-http-0-${UUID}.loadbalancer.healthcheck`)));
  const plainHttp = lines(
    withTraefikDrain(coolifyLabels(UUID, ["https://example.com"], 80, { forceHttps: false }), OPTS),
  );
  assert.ok(
    plainHttp.includes(
      `traefik.http.services.hk-http-0-${UUID}.loadbalancer.healthcheck.path=/api/health`,
    ),
    "without force-https the http service forwards, so it is checked too",
  );
});

await expect("a path-routed app's stripprefix middleware is renamed with its router", () => {
  const api = coolifyLabels(UUID, ["https://example.com/api"], 3000, { stripPrefix: true });
  const out = lines(withTraefikDrain(api, OPTS));
  const mw = `hk-https-0-${UUID}-stripprefix`;
  assert.ok(out.includes(`traefik.http.middlewares.${mw}.stripprefix.prefixes=/api`));
  assert.ok(out.includes(`traefik.http.routers.hk-https-0-${UUID}.middlewares=${mw},gzip`));
});

await expect("idempotent, recognisable, and reversible to Coolify's set", () => {
  const once = withTraefikDrain(TWO, OPTS);
  assert.equal(withTraefikDrain(once, OPTS), once);
  assert.equal(drainLabelState(TWO, UUID), "coolify");
  assert.equal(drainLabelState(once, UUID), "hatchkit");
  assert.equal(drainLabelState("traefik.enable=true", UUID), "none");
  assert.equal(drainLabelState(TWO, "someotheruuid0000000000000"), "none");
  assert.equal(hasTraefikDrain(TWO, OPTS), false);
  assert.equal(hasTraefikDrain(once, OPTS), true);
  assert.equal(hasTraefikDrain(once, { ...OPTS, healthPath: "/" }), false, "path change");
  assert.equal(coolifyLabelsFrom(once, UUID), TWO);
});

await expect("leaves another app's labels in the same set alone", () => {
  const other = "zz9zz9zz9zz9zz9zz9zz9zz9";
  const mixed = [TWO, coolifyLabels(other, ["https://other.example"], 80)].join("\n");
  const out = withTraefikDrain(mixed, OPTS);
  assert.match(out, new RegExp(`traefik\\.http\\.routers\\.https-0-${other}\\.rule=`));
  assert.doesNotMatch(out, new RegExp(`hk-https-0-${other}`));
});

// ---------------------------------------------------------------------------
// 2. Which repos answer the probe
// ---------------------------------------------------------------------------

console.log("\nimageAnswersDrainProbe:");

const dirs: string[] = [];
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hk-traefik-drain-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}
const PROBE = 'req.headers["x-hatchkit-drain"]';

await expect("starter shape: per role", () => {
  const dir = repo({
    "packages/client/drain.cjs": PROBE,
    "packages/server/src/drain.ts": "export const old = true;",
  });
  assert.equal(imageAnswersDrainProbe(dir, "client"), true);
  assert.equal(imageAnswersDrainProbe(dir, "server"), false);
  assert.equal(imageAnswersDrainProbe(dir, "app"), true);
});

await expect("build-pipeline shape: Dockerfile or nginx.conf, under the project subdir", () => {
  assert.equal(imageAnswersDrainProbe(repo({ Dockerfile: PROBE }), "app"), true);
  assert.equal(
    imageAnswersDrainProbe(repo({ "site/nginx.conf": "$http_x_hatchkit_drain" }), "app", "site"),
    true,
  );
  assert.equal(imageAnswersDrainProbe(repo({ Dockerfile: "FROM nginx:alpine" }), "app"), false);
});

await expect("a file the Dockerfile copies in", () => {
  const dir = repo({
    Dockerfile:
      "FROM nginx:alpine\nCOPY --chmod=644 docs/nginx.conf /etc/nginx/conf.d/default.conf\n",
    "docs/nginx.conf": "map $http_x_hatchkit_drain $x {}",
  });
  assert.equal(imageAnswersDrainProbe(dir, "app"), true);
});

// ---------------------------------------------------------------------------
// 3. Decoding
// ---------------------------------------------------------------------------

console.log("\ndecodeCustomLabels:");

await expect("base64 from Coolify, plain text as is, empty as absent", () => {
  assert.equal(decodeCustomLabels(Buffer.from(TWO).toString("base64")), TWO);
  assert.equal(decodeCustomLabels(TWO), TWO);
  assert.equal(decodeCustomLabels(""), undefined);
  assert.equal(decodeCustomLabels(null), undefined);
});

// ---------------------------------------------------------------------------
// 4. sync against a fake Coolify
// ---------------------------------------------------------------------------

console.log("\nhatchkit sync:");

const APP_UUID = "s1t2a3t4i5c6a7p8p9u0u1i2";
const MANIFEST = {
  version: 5,
  name: "site",
  domain: "site.example",
  deploymentMode: "coolify",
  surfaces: "static",
  coolifyRuntime: "image",
  containerPorts: { app: 80 },
  topology: "single-origin",
};

interface FakeApp {
  uuid: string;
  name: string;
  build_pack: string;
  fqdn: string;
  ports_exposes: string;
  health_check_enabled: boolean;
  health_check_path: string;
  health_check_interval: number;
  health_check_timeout: number;
  health_check_retries: number;
  health_check_start_period: number;
  custom_labels: string;
}

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** A Coolify with readonly labels on: a PATCH carrying `domains`
 *  regenerates `custom_labels` AFTER applying the request.
 *  `keepLabels: false` drops every custom_labels write; `readonly: false`
 *  leaves the labels alone on a domains PATCH. */
function fakeCoolify(app: FakeApp, opts: { keepLabels?: boolean; readonly?: boolean } = {}) {
  const calls: Call[] = [];
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v1/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, ...(body ? { body } : {}) });
    if (method === "GET" && path === "/applications")
      return json([{ uuid: app.uuid, name: app.name }]);
    if (path === `/applications/${app.uuid}`) {
      if (method === "GET") return json(app);
      if (method === "PATCH") {
        for (const [k, v] of Object.entries(body ?? {})) {
          if (k === "domains") app.fqdn = String(v);
          else if (k === "custom_labels") {
            if (opts.keepLabels !== false) app.custom_labels = String(v);
          } else if (k in app) (app as unknown as Record<string, unknown>)[k] = v;
        }
        if (body && "domains" in body && opts.readonly !== false) {
          app.custom_labels = Buffer.from(
            coolifyLabels(app.uuid, app.fqdn.split(","), 80),
          ).toString("base64");
        }
        return json({ uuid: app.uuid });
      }
    }
    if (method === "GET" && /^\/applications\/[^/]+\/envs$/.test(path)) return json([]);
    if (method === "GET" && path === "/databases") return json([]);
    return json({ message: `fake Coolify: unhandled ${method} ${path}` }, 404);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

function siteApp(overrides: Partial<FakeApp> = {}): FakeApp {
  return {
    uuid: APP_UUID,
    name: "site",
    build_pack: "dockerimage",
    fqdn: "https://site.example",
    ports_exposes: "80",
    health_check_enabled: true,
    health_check_path: "/",
    health_check_interval: DOCKER_DRAIN_TIMING.intervalSeconds,
    health_check_timeout: DOCKER_DRAIN_TIMING.timeoutSeconds,
    health_check_retries: DOCKER_DRAIN_TIMING.retries,
    health_check_start_period: DOCKER_DRAIN_TIMING.startPeriodSeconds,
    custom_labels: Buffer.from(coolifyLabels(APP_UUID, ["https://site.example"], 80)).toString(
      "base64",
    ),
    ...overrides,
  };
}

async function sync(
  app: FakeApp,
  files: Record<string, string>,
  fakeOpts: { keepLabels?: boolean; readonly?: boolean } = {},
  syncOpts: Partial<SyncOptions> = {},
) {
  const dir = repo({ ".hatchkit.json": JSON.stringify(MANIFEST), ...files });
  const fake = fakeCoolify(app, fakeOpts);
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const out: string[] = [];
  globalThis.fetch = fake.fetch;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  try {
    const result = await runSync({ projectDir: dir, ...ROUTING_ONLY, ...syncOpts });
    return { result, calls: fake.calls, out: out.join("\n") };
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
}

const ROUTING_ONLY: Omit<SyncOptions, "projectDir"> = {
  env: false,
  dns: false,
  secrets: false,
  preflight: false,
  nativeOrigins: false,
};
const patches = (calls: Call[]) =>
  calls.filter((c) => c.method === "PATCH").map((c) => c.body ?? {});
const labelsOf = (app: FakeApp) => Buffer.from(app.custom_labels, "base64").toString("utf8");
const SITE_OPTS = { uuid: APP_UUID, healthPath: "/" };
const NGINX_WITH_PROBE = {
  Dockerfile: "FROM nginx:alpine\nCOPY nginx.conf /etc/nginx/conf.d/default.conf\n",
  "nginx.conf": "map $http_x_hatchkit_drain $p {}",
};

new Conf({ projectName: "hatchkit", cwd: process.env.HATCHKIT_CONF_DIR }).set("providers.coolify", {
  status: "configured",
  url: "https://coolify.test.local",
});
await setSecret(SECRET_KEYS.coolifyToken, "test-coolify-token");

await expect("an image without the probe: no labels, Docker keeps draining fast", async () => {
  const app = siteApp();
  const { calls, out } = await sync(app, { Dockerfile: "FROM nginx:alpine" });
  assert.deepEqual(patches(calls), [], "already converged on Docker's timing");
  assert.equal(drainLabelState(labelsOf(app), APP_UUID), "coolify");
  assert.match(out, /traefik drain check: off — the repo's image doesn't answer/);
});

await expect("an image with the probe: routing PATCH, then labels from a fresh read", async () => {
  const app = siteApp();
  const { calls, result } = await sync(app, NGINX_WITH_PROBE);
  const [routing, labels] = patches(calls);
  assert.equal(routing.health_check_interval, TRAEFIK_DRAIN_TIMING.intervalSeconds);
  assert.equal("custom_labels" in routing, false, "labels never ride with domains");
  assert.ok(labels.custom_labels, "labels written on their own");
  assert.equal(patches(calls).length, 2);
  assert.equal(hasTraefikDrain(labelsOf(app), SITE_OPTS), true);
  assert.equal(app.health_check_interval, TRAEFIK_DRAIN_TIMING.intervalSeconds);
  assert.equal(result.ok, true, result.error);
});

await expect("converged: nothing written", async () => {
  const app = siteApp({
    health_check_interval: TRAEFIK_DRAIN_TIMING.intervalSeconds,
    custom_labels: Buffer.from(
      withTraefikDrain(coolifyLabels(APP_UUID, ["https://site.example"], 80), SITE_OPTS),
    ).toString("base64"),
  });
  const { calls } = await sync(app, NGINX_WITH_PROBE);
  assert.deepEqual(patches(calls), []);
});

await expect("a routing change wipes the labels; sync writes them again", async () => {
  const app = siteApp({
    fqdn: "https://old.example",
    health_check_interval: TRAEFIK_DRAIN_TIMING.intervalSeconds,
    custom_labels: Buffer.from(
      withTraefikDrain(coolifyLabels(APP_UUID, ["https://old.example"], 80), SITE_OPTS),
    ).toString("base64"),
  });
  const { calls } = await sync(app, NGINX_WITH_PROBE);
  assert.equal(patches(calls).length, 2, "domains, then labels");
  assert.equal(app.fqdn, "https://site.example");
  assert.equal(hasTraefikDrain(labelsOf(app), SITE_OPTS), true);
  assert.match(labelsOf(app), /Host\(`site\.example`\)/, "built on the regenerated set");
});

await expect("labels that don't stick: error, and Docker's fast timing back", async () => {
  const app = siteApp();
  const { calls, result } = await sync(app, NGINX_WITH_PROBE, { keepLabels: false });
  const last = patches(calls).at(-1) ?? {};
  assert.equal(last.health_check_interval, DOCKER_DRAIN_TIMING.intervalSeconds);
  assert.equal(app.health_check_interval, DOCKER_DRAIN_TIMING.intervalSeconds);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Traefik drain check not written/);
});

await expect("labels Coolify won't show: left alone, Docker keeps draining fast", async () => {
  const app = siteApp({ custom_labels: "" });
  const { calls, out } = await sync(app, NGINX_WITH_PROBE);
  assert.deepEqual(patches(calls), []);
  assert.match(out, /needs read:sensitive/);
});

await expect(
  "readonly labels off: a domain change is not rewritten onto stale routes",
  async () => {
    const app = siteApp({
      fqdn: "https://old.example",
      health_check_interval: TRAEFIK_DRAIN_TIMING.intervalSeconds,
      custom_labels: Buffer.from(
        withTraefikDrain(coolifyLabels(APP_UUID, ["https://old.example"], 80), SITE_OPTS),
      ).toString("base64"),
    });
    const { result } = await sync(app, NGINX_WITH_PROBE, { readonly: false });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /don't route site\.example/);
    assert.equal(
      app.health_check_interval,
      DOCKER_DRAIN_TIMING.intervalSeconds,
      "Docker drains again",
    );
  },
);

await expect("--no-traefik-drain: Coolify's labels back, Docker fast again", async () => {
  const coolify = coolifyLabels(APP_UUID, ["https://site.example"], 80);
  const app = siteApp({
    health_check_interval: TRAEFIK_DRAIN_TIMING.intervalSeconds,
    custom_labels: Buffer.from(withTraefikDrain(coolify, SITE_OPTS)).toString("base64"),
  });
  const { result, calls } = await sync(app, NGINX_WITH_PROBE, {}, { traefikDrain: false });
  assert.equal(result.ok, true, result.error);
  assert.equal(app.health_check_interval, DOCKER_DRAIN_TIMING.intervalSeconds);
  assert.equal(drainLabelState(labelsOf(app), APP_UUID), "coolify");
  assert.ok(!JSON.stringify(result.apps).includes("traefik.http"), "no labels in the result");
  assert.ok(patches(calls).length >= 1);
});

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall traefik-drain checks passed");
