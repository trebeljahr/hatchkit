/**
 * Zero-downtime deploys — the `image` runtime and `migrate-runtime`.
 *
 * Every hatchkit project used to be a Coolify `dockercompose` app, and
 * Coolify redeploys those by stopping the container before starting its
 * replacement: an outage on every push. Coolify only does rolling
 * updates for Docker Image (and Dockerfile/Nixpacks/Static) apps, and
 * only waits for the new container when a health check is on. These
 * assertions pin the pieces that make that true:
 *
 *   · routing emits one Docker Image app per service, each with a health
 *     check and the container's REAL port;
 *   · the deploy workflows pin `docker_registry_image_tag` on image apps
 *     (an env var would be ignored) and keep the env pin for compose ones;
 *   · every Debian runtime image ships curl, which Coolify's health check
 *     runs inside the container — without it every deploy is rolled back;
 *   · `migrate-runtime` reproduces what a compose service got from
 *     Coolify (image, env, port, every hostname) and refuses the moves
 *     that would lose data.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COOLIFY_STOP_TIMEOUT_SECONDS,
  SHUTDOWN_DRAIN_SECONDS,
  healthCheckFor,
  healthCheckPayload,
  healthCheckToConverge,
  parseImageRef,
  resolveCoolifyRuntime,
  rollingUpdateBlocker,
  rollingUpdateNamingUnknown,
  worstCaseDrainDropSeconds,
} from "./src/deploy/image-runtime.js";
import {
  type EnvRow,
  deploySecretNameFor,
  hostsFromTraefikLabels,
  interpolate,
  planRuntimeMigration,
} from "./src/deploy/migrate-runtime-plan.js";
import { addManifestFields } from "./src/deploy/migrate-runtime.js";
import { computeRoutingPlan, needsManagedDatastores } from "./src/deploy/routing.js";

const failures: string[] = [];

function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

const REPO = join(import.meta.dirname, "..");
const row = (key: string, value: string, extra: Partial<EnvRow> = {}): EnvRow => ({
  key,
  value,
  isPreview: false,
  isLiteral: true,
  isMultiline: false,
  ...extra,
});

console.log("\nimage runtime — primitives");

check("parseImageRef splits the tag after the last slash only", () => {
  assert.deepEqual(parseImageRef("ghcr.io/o/r:main"), { name: "ghcr.io/o/r", tag: "main" });
  assert.deepEqual(parseImageRef("ghcr.io/o/r"), { name: "ghcr.io/o/r", tag: "latest" });
  assert.deepEqual(parseImageRef("localhost:5000/r"), { name: "localhost:5000/r", tag: "latest" });
  assert.deepEqual(parseImageRef("localhost:5000/r:v1"), { name: "localhost:5000/r", tag: "v1" });
});

check("a manifest without coolifyRuntime is compose — what it was deployed as", () => {
  assert.equal(resolveCoolifyRuntime(undefined), "compose");
  assert.equal(resolveCoolifyRuntime("image"), "image");
  assert.equal(resolveCoolifyRuntime("nonsense"), "compose");
});

check("server health check is /api/health, everything else /", () => {
  assert.equal(healthCheckFor("server").path, "/api/health");
  assert.equal(healthCheckFor("client").path, "/");
  assert.equal(healthCheckFor("app").path, "/");
  assert.equal(healthCheckFor("app", { surfaces: "backend" }).path, "/api/health");
});

check("health payload turns the check ON and never sends health_check_type", () => {
  const body = healthCheckPayload(healthCheckFor("server"));
  assert.equal(body.health_check_enabled, true);
  assert.equal(body.health_check_path, "/api/health");
  // localhost resolves to ::1 under busybox wget; an IPv4-only server
  // (Next.js with HOSTNAME=0.0.0.0) then fails a healthy container.
  assert.equal(body.health_check_host, "127.0.0.1");
  assert.equal("health_check_type" in body, false);
  assert.equal("health_check_port" in body, false);
});

// The three numbers carry two budgets (see "The last second" in
// image-runtime.ts). Moving any of them has to keep both.
check("health timing drains a stopping container well inside docker stop", () => {
  const t = healthCheckFor("server");
  assert.deepEqual(
    [t.intervalSeconds, t.retries, t.startPeriodSeconds, t.timeoutSeconds],
    [2, 5, 15, 5],
  );
  // Out of Traefik before the drain ends, with room for a slow probe or
  // a late refresh…
  const MARGIN = 3;
  assert.ok(
    worstCaseDrainDropSeconds(t) + MARGIN <= SHUTDOWN_DRAIN_SECONDS,
    `drop by ${worstCaseDrainDropSeconds(t)}s + ${MARGIN}s margin must fit in the ${SHUTDOWN_DRAIN_SECONDS}s drain`,
  );
  // …and closed before docker stop's SIGKILL, with time to close.
  const CLOSE = 8;
  assert.ok(
    SHUTDOWN_DRAIN_SECONDS + CLOSE <= COOLIFY_STOP_TIMEOUT_SECONDS,
    `${SHUTDOWN_DRAIN_SECONDS}s drain + ${CLOSE}s to close must fit in docker stop's ${COOLIFY_STOP_TIMEOUT_SECONDS}s`,
  );
  // The pre-drain timing (5 s × 12) could never drain: 60 s+ of routing
  // to a container that exits after 30.
  assert.ok(worstCaseDrainDropSeconds({ intervalSeconds: 5, retries: 12 }) > 30);
});

check("health timing still gives a booting container ~25 s", () => {
  const t = healthCheckFor("client");
  // Coolify sleeps the start period, then polls `retries` times, each
  // `interval` plus ~1 s of round trip apart. collection-of-beauty
  // (Next.js standalone) took up to 15 s on 2026-09-29.
  const window = t.startPeriodSeconds + (t.retries - 1) * (t.intervalSeconds + 1);
  assert.ok(window >= 25, `boot window ${window}s`);
});

check("sync converges health timing, keeps the path, and leaves a match alone", () => {
  const fallback = healthCheckFor("client");
  // Off → the whole default check.
  assert.deepEqual(healthCheckToConverge({ enabled: false }, fallback), fallback);
  assert.deepEqual(healthCheckToConverge({}, fallback), fallback);
  // On with pre-drain timing → hatchkit's timing on the app's own path.
  const old = {
    enabled: true,
    path: "/healthz",
    intervalSeconds: 5,
    timeoutSeconds: 5,
    retries: 12,
    startPeriodSeconds: 5,
  };
  const pushed = healthCheckToConverge(old, fallback);
  assert.ok(pushed);
  assert.equal(pushed.path, "/healthz");
  assert.equal(pushed.intervalSeconds, 2);
  assert.equal(pushed.retries, 5);
  assert.equal(pushed.startPeriodSeconds, 15);
  // Already converged → nothing to PATCH.
  assert.equal(
    healthCheckToConverge(
      {
        enabled: true,
        path: "/",
        intervalSeconds: 2,
        timeoutSeconds: 5,
        retries: 5,
        startPeriodSeconds: 15,
      },
      fallback,
    ),
    undefined,
  );
  // Timing Coolify didn't return can't be compared — no PATCH on that alone.
  assert.equal(healthCheckToConverge({ enabled: true, path: "/" }, fallback), undefined);
});

check("rollingUpdateBlocker names every Coolify fallback to stop-then-start", () => {
  assert.match(rollingUpdateBlocker({ buildPack: "dockercompose" }) ?? "", /Compose/);
  assert.match(
    rollingUpdateBlocker({
      buildPack: "dockerimage",
      healthCheck: { enabled: true },
      portsMappings: "3001:3001",
    }) ?? "",
    /port mapping/,
  );
  assert.match(
    rollingUpdateBlocker({ buildPack: "dockerimage", healthCheck: { enabled: false } }) ?? "",
    /health check off/,
  );
  assert.equal(
    rollingUpdateBlocker({ buildPack: "dockerimage", healthCheck: { enabled: true, path: "/" } }),
    null,
  );
});

check("container naming, unknown buildpacks and Coolify's --ip substring gate cannot pass", () => {
  const app = { buildPack: "dockerimage", healthCheck: { enabled: true } };
  assert.match(
    rollingUpdateBlocker({ ...app, isConsistentContainerNameEnabled: true }) ?? "",
    /consistent container name/,
  );
  assert.match(
    rollingUpdateBlocker({ ...app, customInternalName: "fixed-name" }) ?? "",
    /custom internal/,
  );
  assert.match(
    rollingUpdateBlocker({ ...app, customDockerRunOptions: "--ipc=host" }) ?? "",
    /--ip/,
  );
  assert.match(rollingUpdateBlocker({ ...app, buildPack: "unknown" }) ?? "", /unknown build pack/);
  assert.match(
    rollingUpdateBlocker({ healthCheck: { enabled: true } }) ?? "",
    /unknown build pack/,
  );
  assert.equal(rollingUpdateNamingUnknown({}), true);
  assert.equal(
    rollingUpdateNamingUnknown({
      isConsistentContainerNameEnabled: false,
      customInternalName: null,
    }),
    false,
  );
});

console.log("\nimage runtime — routing");

const base = {
  name: "demo",
  domain: "demo.example.com",
  images: {
    client: "ghcr.io/o/demo-client:main",
    server: "ghcr.io/o/demo-server:main",
  },
  runtime: "image" as const,
};

check("static → one image app named after the project, on the client image", () => {
  const plan = computeRoutingPlan({ ...base, topology: "single-origin", surfaces: "static" });
  assert.equal(plan.apps.length, 1);
  const [app] = plan.apps;
  assert.equal(app.appName, "demo");
  assert.equal(app.role, "app");
  assert.equal(app.runtime, "image");
  assert.deepEqual(app.image, { name: "ghcr.io/o/demo-client", tag: "main" });
  assert.deepEqual(app.flatDomains, ["https://demo.example.com"]);
  assert.equal(app.portsExposes, "3000");
  assert.equal(app.healthCheck?.path, "/");
  assert.deepEqual(app.composeDomains, []);
});

check("image app port is the CONTAINER port, not the dev port", () => {
  const plan = computeRoutingPlan({
    ...base,
    topology: "single-origin",
    surfaces: "static",
    ports: { client: 3001 },
    containerPorts: { app: 80 },
  });
  assert.equal(plan.apps[0].portsExposes, "80");
});

check("single-origin fullstack → client + server apps, /api path with stripprefix off", () => {
  const plan = computeRoutingPlan({ ...base, topology: "single-origin", surfaces: "fullstack" });
  assert.deepEqual(
    plan.apps.map((a) => [a.appName, a.role, a.flatDomains, a.stripPrefix]),
    [
      ["demo-client", "client", ["https://demo.example.com"], undefined],
      ["demo-server", "server", ["https://demo.example.com/api"], false],
    ],
  );
  assert.equal(plan.apps[1].healthCheck?.path, "/api/health");
  assert.deepEqual(plan.extraDnsHostnames, []);
});

check("split → server on api.<domain>, never on the client too", () => {
  const plan = computeRoutingPlan({
    ...base,
    topology: "split",
    surfaces: "fullstack",
    hostnameAliases: ["api.demo.example.com", "www.demo.example.com"],
  });
  assert.deepEqual(plan.apps[0].flatDomains, [
    "https://demo.example.com",
    "https://www.demo.example.com",
  ]);
  assert.deepEqual(plan.apps[1].flatDomains, ["https://api.demo.example.com"]);
  assert.equal(plan.apps[1].stripPrefix, undefined);
  assert.deepEqual(plan.extraDnsHostnames, ["api.demo.example.com"]);
});

check("a missing image stays undefined — the provisioner refuses rather than guesses", () => {
  const plan = computeRoutingPlan({
    name: "x",
    domain: "x.example.com",
    topology: "single-origin",
    surfaces: "static",
    runtime: "image",
  });
  assert.equal(plan.apps[0].image, undefined);
});

check("compose runtime is untouched by the image work", () => {
  const plan = computeRoutingPlan({
    name: "demo",
    domain: "demo.example.com",
    topology: "single-origin",
    surfaces: "fullstack",
  });
  assert.equal(plan.apps.length, 1);
  assert.equal(plan.apps[0].role, "compose");
  assert.equal(plan.apps[0].runtime, "compose");
  assert.equal(plan.apps[0].healthCheck, undefined);
});

check("managed datastores: split, or any server on the image runtime", () => {
  assert.equal(needsManagedDatastores({ topology: "split", surfaces: "fullstack" }), true);
  assert.equal(
    needsManagedDatastores({ topology: "single-origin", runtime: "image", surfaces: "fullstack" }),
    true,
  );
  assert.equal(
    needsManagedDatastores({
      topology: "single-origin",
      runtime: "compose",
      surfaces: "fullstack",
    }),
    false,
  );
  assert.equal(needsManagedDatastores({ runtime: "image", surfaces: "static" }), false);
});

console.log("\nmigrate-runtime — plan");

const STATIC_WITH_LABELS = `services:
  app:
    image: 'ghcr.io/o/site:latest'
    restart: unless-stopped
    expose:
      - '80'
    environment:
      - NODE_ENV=production
      - DOTENV_PRIVATE_KEY_PRODUCTION
    labels:
      - traefik.enable=true
      - 'traefik.http.routers.site-https.rule=Host(\`site.com\`) || Host(\`www.site.com\`)'
      - 'traefik.http.routers.site-http.rule=Host(\`site.com\`) || Host(\`www.site.com\`)'
`;

check("static app: image, expose port, every hostname incl. hand-written labels", () => {
  const plan = planRuntimeMigration(
    {
      uuid: "u1",
      name: "site",
      buildPack: "dockercompose",
      composeRaw: STATIC_WITH_LABELS,
      composeDomains: [{ name: "app", domain: "https://site.com" }],
    },
    [
      row("DOTENV_PRIVATE_KEY_PRODUCTION", "secret"),
      row("SERVICE_FQDN_APP", "site.com", { isLiteral: false }),
      row("APP_IMAGE", "ghcr.io/o/site:abc"),
      row("NODE_ENV", "development"),
      row("NODE_ENV", "preview-only", { isPreview: true }),
    ],
  );
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.legacyName, "site-legacy-compose");
  const [app] = plan.apps;
  assert.equal(app.appName, "site");
  assert.deepEqual(app.image, { name: "ghcr.io/o/site", tag: "latest" });
  assert.equal(app.port, 80);
  assert.deepEqual(app.domains, ["https://site.com", "https://www.site.com"]);
  const env = Object.fromEntries(app.env.map((e) => [e.key, e.value]));
  // The service's own entry wins over the app-level row, as in compose.
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.DOTENV_PRIVATE_KEY_PRODUCTION, "secret");
  // Compose-only magic and image pins don't follow.
  assert.equal("SERVICE_FQDN_APP" in env, false);
  assert.equal("APP_IMAGE" in env, false);
  assert.ok(plan.warnings.some((w) => /hand-written Traefik labels/.test(w)));
});

check("pinned image: starts on the live sha, settles on the default's tag", () => {
  const plan = planRuntimeMigration(
    {
      uuid: "u2",
      name: "tt-client",
      buildPack: "dockercompose",
      composeRaw: `services:
  client:
    image: '\${CLIENT_IMAGE:-ghcr.io/o/tt-client:main}'
    environment:
      PORT: '6477'
`,
      composeDomains: [{ name: "client", domain: "https://tt.dev" }],
    },
    [row("CLIENT_IMAGE", "ghcr.io/o/tt-client:45d6361"), row("PORT", "3000")],
  );
  assert.deepEqual(plan.blockers, []);
  const [app] = plan.apps;
  assert.deepEqual(app.image, { name: "ghcr.io/o/tt-client", tag: "45d6361" });
  assert.equal(app.steadyTag, "main");
  // The service's PORT, not the app-level one it overrides.
  assert.equal(app.port, 6477);
  assert.equal(app.portSource, "the service's PORT env");
});

check("a service named server gets /api/health; --health-path overrides", () => {
  const raw = `services:
  server:
    image: 'ghcr.io/o/api:main'
    environment:
      PORT: '5159'
`;
  const live = {
    uuid: "u3",
    name: "tt-server",
    buildPack: "dockercompose",
    composeRaw: raw,
    composeDomains: [{ name: "server", domain: "https://api.tt.dev" }],
  };
  assert.equal(planRuntimeMigration(live, []).apps[0].healthCheck.path, "/api/health");
  assert.equal(
    planRuntimeMigration(live, [], { healthPaths: { server: "/healthz" } }).apps[0].healthCheck
      .path,
    "/healthz",
  );
});

check("hyphenated service: Coolify stores its domains under the underscored name", () => {
  const plan = planRuntimeMigration(
    {
      uuid: "u4",
      name: "kuma",
      buildPack: "dockercompose",
      composeRaw:
        "services:\n  uptime-kuma:\n    image: 'louislam/uptime-kuma:2'\n    expose: ['3001']\n",
      composeDomains: [{ name: "uptime_kuma", domain: "https://up.example.com" }],
    },
    [],
  );
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.apps[0].domains, ["https://up.example.com"]);
});

check("datastores and volumes block the move — their data would not follow", () => {
  const plan = planRuntimeMigration(
    {
      uuid: "u5",
      name: "full",
      buildPack: "dockercompose",
      composeRaw: `services:
  server:
    image: 'ghcr.io/o/s:main'
    volumes: ['data:/app/data']
    environment: { PORT: '3000' }
  mongo:
    image: 'mongo:7'
    volumes: ['mongo-data:/data/db']
`,
      composeDomains: [{ name: "server", domain: "https://full.dev" }],
    },
    [],
  );
  assert.equal(plan.apps.length, 0);
  assert.ok(plan.blockers.some((b) => /"mongo".*datastore/.test(b)));
  assert.ok(plan.blockers.some((b) => /"server" mounts volumes/.test(b)));
});

check("a sibling reached by compose hostname blocks the split", () => {
  const plan = planRuntimeMigration(
    {
      uuid: "u6",
      name: "two",
      buildPack: "dockercompose",
      composeRaw: `services:
  server:
    image: 'ghcr.io/o/s:main'
    environment: { PORT: '4000' }
  client:
    image: 'ghcr.io/o/c:main'
    environment: { PORT: '80', BACKEND_URL: 'http://server:4000' }
`,
      composeDomains: [
        { name: "server", domain: "https://api.two.dev" },
        { name: "client", domain: "https://two.dev" },
      ],
    },
    [],
  );
  assert.ok(plan.blockers.some((b) => /reaches "server" by its compose hostname/.test(b)));
});

check("never-deployed, placeholder image and unreadable env all refuse", () => {
  const never = planRuntimeMigration(
    { uuid: "a", name: "n", buildPack: "dockercompose", composeRaw: null },
    [],
  );
  assert.match(never.blockers[0], /never deployed/);
  const placeholder = planRuntimeMigration(
    {
      uuid: "b",
      name: "p",
      buildPack: "dockercompose",
      composeRaw:
        "services:\n  client:\n    image: '${CLIENT_IMAGE:-ghcr.io/OWNER/REPO-client:main}'\n    expose: ['3000']\n",
      composeDomains: [{ name: "client", domain: "https://p.dev" }],
    },
    [],
  );
  assert.ok(placeholder.blockers.some((b) => /OWNER\/REPO/.test(b)));
  const hidden = planRuntimeMigration(
    {
      uuid: "c",
      name: "h",
      buildPack: "dockercompose",
      composeRaw: "services:\n  app:\n    image: 'x/y:1'\n    expose: ['80']\n",
      composeDomains: [{ name: "app", domain: "https://h.dev" }],
    },
    [{ key: "SECRET", value: undefined, isPreview: false, isLiteral: true, isMultiline: false }],
  );
  assert.ok(hidden.blockers.some((b) => /read:sensitive/.test(b)));
});

check("interpolate follows compose: :-, -, $$ and unset → empty", () => {
  const env = new Map([
    ["A", "1"],
    ["EMPTY", ""],
  ]);
  assert.equal(
    interpolate("${A}-${B:-two}-${EMPTY:-d}-${EMPTY-d}-$$-$A", env).value,
    "1-two-d--$-1",
  );
  assert.deepEqual(interpolate("${MISSING}", env), { value: "", missing: ["MISSING"] });
});

check("Host() rules are read from every router rule label", () => {
  assert.deepEqual(
    hostsFromTraefikLabels([
      "traefik.enable=true",
      "traefik.http.routers.a.rule=Host(`A.com`) || Host(`b.com`)",
      "traefik.http.routers.b.rule=Host(`a.com`) && PathPrefix(`/x`)",
    ]),
    ["a.com", "b.com"],
  );
});

check("deploy secret follows the app's role suffix", () => {
  assert.equal(deploySecretNameFor("site"), "COOLIFY_RESOURCE_UUID");
  assert.equal(deploySecretNameFor("tracktime-client"), "COOLIFY_CLIENT_RESOURCE_UUID");
  assert.equal(deploySecretNameFor("tiao-backend"), "COOLIFY_SERVER_RESOURCE_UUID");
});

check("migrate-runtime adds its manifest fields without rewriting the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-manifest-"));
  const original = '{\n  "version": 4,\n  "aliases": ["a.com", "b.com"],\n  "name": "x"\n}\n';
  writeFileSync(join(dir, ".hatchkit.json"), original);
  assert.equal(
    addManifestFields(dir, { coolifyRuntime: "image", containerPorts: { app: 80 } }),
    true,
  );
  const after = readFileSync(join(dir, ".hatchkit.json"), "utf-8");
  assert.equal(
    after,
    '{\n  "version": 4,\n  "aliases": ["a.com", "b.com"],\n  "name": "x",\n  "coolifyRuntime": "image",\n  "containerPorts": {\n    "app": 80\n  }\n}\n',
  );
  assert.deepEqual(JSON.parse(after).containerPorts, { app: 80 });
  // Already recorded: left alone.
  assert.equal(addManifestFields(dir, { coolifyRuntime: "image" }), false);
});

console.log("\nimage runtime — shipped files");

check("both deploy workflows choose the image in GHCR, for image and compose apps alike", () => {
  for (const file of [
    "starter/.github/workflows/build-and-deploy.yml",
    "cli/src/templates/build-pipeline/deploy.yml.hbs",
  ]) {
    const text = readFileSync(join(REPO, file), "utf-8");
    // Image apps pull docker_registry_image_tag, compose apps interpolate
    // an env var; both are set to `:live` once by hatchkit, so the one
    // thing the workflow moves is that tag — no build-pack branch, and
    // no Coolify API call that would need a token.
    assert.match(
      text,
      /docker buildx imagetools create --tag "\$image:live"/,
      `${file}: promotes :live`,
    );
    assert.ok(!text.includes("/api/v1/"), `${file}: still calls the Coolify API`);
    assert.ok(!text.includes("docker_registry_image_tag"), `${file}: still pins on Coolify`);
  }
});

check("every Debian runtime stage installs curl for Coolify's health check", () => {
  for (const file of [
    "starter/packages/server/Dockerfile",
    "starter/packages/client/Dockerfile",
    "cli/src/templates/build-pipeline/Dockerfile.nextjs.hbs",
    "cli/src/templates/build-pipeline/Dockerfile.nextjs-monorepo.hbs",
  ]) {
    const text = readFileSync(join(REPO, file), "utf-8");
    const runtime = text.slice(text.indexOf("bookworm-slim AS runtime"));
    assert.ok(runtime.length > 0, `${file}: has a bookworm-slim runtime stage`);
    assert.match(
      runtime,
      /apt-get install -y --no-install-recommends curl/,
      `${file}: runtime stage installs curl`,
    );
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nAll image-runtime assertions passed.");
