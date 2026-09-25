/**
 * The self-host feature: one compose file a stranger can run, the proxy
 * in front of it, and the CI run that proves both still work.
 *
 * Each property below encodes a failure that cost somebody an afternoon:
 *
 *   1. A pulled service that also declares `build:` is not a pulled
 *      service. Compose quietly builds what it knows how to build when a
 *      pull fails, whatever `pull_policy` says, so a mistyped tag becomes
 *      an OOM-killed build with nothing on screen naming the cause.
 *   2. Only the proxy publishes ports. A datastore with no password and a
 *      published port is a database on the public internet.
 *   3. The socket route must not strip its prefix: the server compares
 *      the upgrade path literally and destroys the socket on anything
 *      else, which shows up as an app that works and never updates.
 *   4. The API must outrank the static catch-all. A catch-all that
 *      swallows the session endpoint answers it with the app shell and a
 *      200, which reaches the browser as a bizarre auth failure.
 *   5. The build-info file is served no-cache, or a rolled-back deploy
 *      keeps reporting the commit it no longer serves.
 *   6. The store-trust switch defaults ON, and its origin list is DERIVED
 *      from nativeClientOrigins — a hardcoded copy drifts, and every
 *      sign-in from a phone or the desktop shell is then refused with
 *      403 INVALID_ORIGIN before the password is checked.
 *   7. The unlistable-extension switch follows the main one when unset.
 *   8. The keys the compose file sets are the keys the starter's server
 *      reads, asserted against that file rather than against a copy of
 *      its names here. A switch the server does not read is worse than
 *      no switch: the stack boots, the setting reads as on, and every
 *      store client is still refused with nothing naming the cause.
 *   9. The self-host web image is built with an EMPTY API URL, or one
 *      published image no longer works behind anybody's domain.
 *  10. The smoke workflow waits for health rather than sleeping, asserts
 *      the site AND the API, and dumps every service's log on failure.
 *  11. Shape handling: `backend` has no client route, `static` is skipped
 *      with a reason, and names, ports and image references are the
 *      project's own.
 *  12. Idempotent: a second apply writes nothing. Every file here is one
 *      hatchkit OWNS and regenerates, so a drifted copy is rewritten and
 *      says so in its own header — a file frozen after its first write
 *      would leave a project running the first version of the stack for
 *      ever while the smoke workflow went on passing against it.
 *  13. A dry run touches nothing. Every write goes through the ledger, so
 *      `--dry-run` is one flag in one place rather than a check each
 *      writer has to remember.
 *
 * Run: `pnpm exec tsx test-selfhost.ts`
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Nothing under features/selfhost opens the config store, but the shared
// scaffold modules it imports may — keep them away from the real one.
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "selfhost-conf-"));

const {
  PROXY_CONFIG_REL,
  SELFHOST_BUILD_OVERRIDE_REL,
  SELFHOST_CI_OVERRIDE_REL,
  SELFHOST_CLIENT_DOCKERFILE_REL,
  SELFHOST_COMPOSE_REL,
  SELFHOST_ENV_EXAMPLE_REL,
  SELFHOST_SMOKE_WORKFLOW_REL,
  SERVER_TRUST_CONFIG_REL,
  STORE_CLIENT_ORIGINS_KEY,
  TRUST_EXTENSION_ORIGINS_KEY,
  TRUST_STORE_APPS_KEY,
  applySelfHost,
  ciImageTag,
  proxyRoutes,
  renderProxyConfig,
  renderSelfHostBuildOverride,
  renderSelfHostCompose,
  renderSelfHostEnvExample,
  renderSmokeWorkflow,
  selfHostClientDockerfile,
  selfHostEnvKeys,
  selfHostServices,
  smokeWorkflowPaths,
  storeClientOrigins,
  trustSwitches,
  versionEnvKey,
} = await import("./src/features/selfhost/index.js");
const { nativeClientOrigins } = await import("./src/scaffold/native-origins.js");
const { FeatureLedger } = await import("./src/features/contract.js");
type FeatureLedger = InstanceType<typeof FeatureLedger>;
type OperationalProject = import("./src/features/operational-context.js").OperationalProject;
type OperationalContext = import("./src/features/operational-context.js").OperationalContext;

const failures: string[] = [];
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

/** Drop comment lines, so an assertion about what a generated file DOES
 *  is not satisfied or broken by a comment explaining what it must not
 *  do — and those comments are half the value of these files. */
function withoutComments(content: string, marker: string): string {
  return content
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(marker))
    .join("\n");
}

function project(over: Partial<OperationalProject> = {}): OperationalProject {
  return {
    name: "acme",
    domain: "acme.example.com",
    topology: "single-origin",
    surfaces: "fullstack",
    features: ["websocket", "mobile", "desktop"],
    repoSlug: "someone/acme",
    ...over,
  };
}

const full = project();

/** A context rooted at a real directory, with a real ledger. Nothing here
 *  fakes the ledger: the two invariants this file checks — idempotent, and
 *  a dry run that touches nothing — are properties of the ledger doing the
 *  writing, so a stub would assert them of the stub. */
function context(
  projectDir: string,
  over: Partial<OperationalProject> = {},
  opts: { dryRun?: boolean } = {},
): OperationalContext {
  return {
    projectDir,
    project: project(over),
    mode: "create",
    ledger: new FeatureLedger(projectDir, opts.dryRun === true),
    log: (): void => undefined,
  };
}

/** Every file a fullstack project's self-host stack is made of. */
const STACK_FILES = [
  SELFHOST_COMPOSE_REL,
  PROXY_CONFIG_REL,
  SELFHOST_BUILD_OVERRIDE_REL,
  SELFHOST_CI_OVERRIDE_REL,
  SELFHOST_ENV_EXAMPLE_REL,
  SELFHOST_SMOKE_WORKFLOW_REL,
  SELFHOST_CLIENT_DOCKERFILE_REL,
];

/** Paths the ledger recorded under one action. */
function filesWith(ledger: FeatureLedger, action: string): string[] {
  return ledger.entries.filter((e) => e.action === action).map((e) => e.file);
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

console.log("\nservices\n");

check("no pulled service declares build:", () => {
  const compose = renderSelfHostCompose(full);
  assert.equal(/^\s*build:/m.test(compose), false, "the base compose declares a build: section");
  for (const service of selfHostServices(full)) {
    assert.equal(service.pulled, true, `${service.name} is not marked as pulled`);
  }
});

check("only the proxy publishes ports", () => {
  const services = selfHostServices(full);
  const publishing = services.filter((s) => s.published.length > 0);
  assert.deepEqual(
    publishing.map((s) => s.role),
    ["proxy"],
  );
  assert.deepEqual(publishing[0].published, ["80:80", "443:443", "443:443/udp"]);
  // And the rendered file agrees: one `ports:` block, under the proxy.
  const compose = renderSelfHostCompose(full);
  assert.equal(compose.match(/^\s{4}ports:$/gm)?.length, 1);
});

check("every service has a healthcheck, and the app halves a start interval", () => {
  for (const service of selfHostServices(full)) {
    assert.ok(service.healthcheck.test.length > 0, `${service.name} has no healthcheck`);
    assert.ok(service.healthcheck.startPeriod, `${service.name} has no start_period`);
  }
  for (const service of selfHostServices(full)) {
    if (service.role === "datastore") continue;
    assert.ok(service.healthcheck.startInterval, `${service.name} has no start_interval`);
  }
  // Compose refuses start_interval without start_period.
  const compose = renderSelfHostCompose(full);
  const intervals = compose.match(/^\s*start_interval:/gm)?.length ?? 0;
  const periods = compose.match(/^\s*start_period:/gm)?.length ?? 0;
  assert.ok(intervals > 0 && periods >= intervals);
});

check("the proxy is gated on both app halves being healthy", () => {
  const proxy = selfHostServices(full).find((s) => s.role === "proxy");
  assert.deepEqual([...(proxy?.dependsOnHealthy ?? [])], ["server", "client"]);
  const backendProxy = selfHostServices(project({ surfaces: "backend" })).find(
    (s) => s.role === "proxy",
  );
  assert.deepEqual([...(backendProxy?.dependsOnHealthy ?? [])], ["server"]);
});

check("names, ports and image references are the project's own", () => {
  const custom = project({ name: "widgets", repoSlug: "org/widgets" });
  const services = selfHostServices(custom, { ports: { server: 7001, client: 7002 } });
  const server = services.find((s) => s.role === "server");
  const client = services.find((s) => s.role === "client");
  assert.equal(server?.expose, 7001);
  assert.equal(client?.expose, 7002);
  assert.equal(server?.image, "ghcr.io/org/widgets-server:${WIDGETS_VERSION:-latest}");
  assert.equal(client?.image, "ghcr.io/org/widgets-client-selfhost:${WIDGETS_VERSION:-latest}");
  assert.equal(versionEnvKey("track-your-time"), "TRACK_YOUR_TIME_VERSION");
  assert.match(renderSelfHostCompose(custom), /^name: widgets$/m);
});

check("the self-host web image has its own package name", () => {
  const client = selfHostServices(full).find((s) => s.role === "client");
  assert.ok(client);
  assert.match(client.image, /-client-selfhost:/);
  assert.equal(/[^-]-client:/.test(client.image), false, "pulls the domain-baked client image");
});

check("redis follows the websocket feature; mongo is always there", () => {
  const withWs = selfHostServices(full).map((s) => s.name);
  assert.ok(withWs.includes("mongo") && withWs.includes("redis"));
  const without = selfHostServices(project({ features: [] })).map((s) => s.name);
  assert.ok(without.includes("mongo"));
  assert.equal(without.includes("redis"), false);
  const server = selfHostServices(project({ features: [] })).find((s) => s.role === "server");
  assert.equal(
    server?.environment.some(([k]) => k === "REDIS_URL"),
    false,
  );
});

check("the trust and mail keys land inside the server's environment block", () => {
  // The bug: extra env lines appended AFTER the service block carried the
  // right six-space indent and therefore landed inside whatever key came
  // last — `healthcheck:` — and `docker compose config` rejected the file
  // with "additional properties not allowed".
  const compose = renderSelfHostCompose(full, {}, [
    "TRUST_STORE_APPS: ${TRUST_STORE_APPS:-true}",
    "SENTRY_DSN: ${SENTRY_DSN:-}",
  ]);
  const lines = compose.split("\n");
  const start = lines.findIndex((l) => l === "  server:");
  assert.ok(start >= 0);
  const envStart = lines.findIndex((l, i) => i > start && l === "    environment:");
  const envEnd = lines.findIndex((l, i) => i > envStart && /^ {4}\S/.test(l));
  const block = lines.slice(envStart, envEnd).join("\n");
  assert.match(block, /TRUST_STORE_APPS:/);
  assert.match(block, /SENTRY_DSN:/);
  assert.equal(/healthcheck:/.test(block), false);
});

check("the required values fail fast with a message, not a default", () => {
  const compose = renderSelfHostCompose(full);
  assert.match(compose, /APP_DOMAIN:\s*\$\{APP_DOMAIN:\?/);
  assert.match(compose, /BETTER_AUTH_SECRET:\s*\$\{BETTER_AUTH_SECRET:\?/);
});

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

console.log("\nproxy\n");

check("the API prefix and the socket path go to the server, the rest to the client", () => {
  const routes = proxyRoutes(full);
  const byKind = Object.fromEntries(routes.map((r) => [r.kind, r]));
  assert.equal(byKind.api.target, "server");
  assert.equal(byKind.api.path, "/api/*");
  assert.equal(byKind.socket.target, "server");
  assert.equal(byKind.socket.path, "/api/ws");
  assert.equal(byKind.catchall.target, "client");
  assert.equal(byKind.api.upstream, "server:3000");
  assert.equal(byKind.catchall.upstream, "client:3001");
});

check("the socket route does not strip its prefix", () => {
  const socket = proxyRoutes(full).find((r) => r.kind === "socket");
  assert.ok(socket);
  assert.equal(socket.stripPrefix, false);
  // Caddy's handle_path is the prefix-stripping form — it must appear on
  // no rule. The comments name it, which is the point of them, so only
  // the directives are checked.
  const config = renderProxyConfig(full);
  assert.equal(
    /handle_path/.test(withoutComments(config, "#")),
    false,
    "the proxy config uses handle_path",
  );
  assert.match(config, /handle \/api\/ws \{/);
});

check("the API rules come before the catch-all, for a proxy that matches in order", () => {
  const routes = proxyRoutes(full);
  const api = routes.findIndex((r) => r.kind === "api");
  const socket = routes.findIndex((r) => r.kind === "socket");
  const catchall = routes.findIndex((r) => r.kind === "catchall");
  assert.ok(api < catchall && socket < catchall);
  assert.equal(catchall, routes.length - 1);
  const config = renderProxyConfig(full);
  assert.ok(config.indexOf("handle /api/*") < config.lastIndexOf("handle {"));
});

check("the build-info file is served no-cache", () => {
  const info = proxyRoutes(full).find((r) => r.kind === "buildinfo");
  assert.ok(info);
  assert.equal(info.path, "/version.json");
  assert.deepEqual(
    info.headers.map(([k, v]) => `${k}: ${v}`),
    ["Cache-Control: no-cache"],
  );
  assert.match(
    renderProxyConfig(full),
    /handle \/version\.json \{\n\t\theader Cache-Control "no-cache"/,
  );
});

check("a custom API prefix and socket path carry through", () => {
  const routes = proxyRoutes(full, { apiPrefix: "/backend", socketPath: "/socket" });
  const byKind = Object.fromEntries(routes.map((r) => [r.kind, r]));
  assert.equal(byKind.api.path, "/backend/*");
  assert.equal(byKind.socket.path, "/socket");
  assert.match(renderProxyConfig(full, { socketPath: "/socket" }), /handle \/socket \{/);
});

check("no websocket feature, no socket route", () => {
  const routes = proxyRoutes(project({ features: ["mobile"] }));
  assert.equal(
    routes.some((r) => r.kind === "socket"),
    false,
  );
  assert.equal(/handle \/api\/ws/.test(renderProxyConfig(project({ features: [] }))), false);
});

check("a backend project has no client route", () => {
  const backend = project({ surfaces: "backend" });
  const routes = proxyRoutes(backend);
  assert.equal(
    routes.some((r) => r.target === "client"),
    false,
  );
  assert.equal(
    routes.some((r) => r.kind === "buildinfo"),
    false,
  );
  assert.equal(routes.find((r) => r.kind === "catchall")?.upstream, "server:3000");
  assert.equal(
    selfHostServices(backend).some((s) => s.role === "client"),
    false,
  );
  assert.equal(/client:/.test(renderProxyConfig(backend)), false);
});

check("a static project gets no routes and no services", () => {
  const stat = project({ surfaces: "static" });
  assert.deepEqual(proxyRoutes(stat), []);
  assert.deepEqual(selfHostServices(stat), []);
  assert.equal(renderSmokeWorkflow(stat), "");
});

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

console.log("\ntrust\n");

check("the store-trust switch defaults on", () => {
  const sw = trustSwitches(full).find((s) => s.key === TRUST_STORE_APPS_KEY);
  assert.equal(sw?.default, "true");
  assert.match(renderSelfHostCompose(full, {}, []), /^/);
  const compose = renderSelfHostCompose(full, {}, [
    `${TRUST_STORE_APPS_KEY}: \${${TRUST_STORE_APPS_KEY}:-true}`,
  ]);
  assert.match(compose, /TRUST_STORE_APPS: \$\{TRUST_STORE_APPS:-true\}/);
});

check("the origin list is nativeClientOrigins for the project's features", () => {
  assert.deepEqual(storeClientOrigins(full), nativeClientOrigins(full.features));
  const mobileOnly = project({ features: ["mobile"] });
  assert.deepEqual(storeClientOrigins(mobileOnly), ["capacitor://localhost", "https://localhost"]);
  const desktopOnly = project({ features: ["desktop"] });
  assert.deepEqual(storeClientOrigins(desktopOnly), nativeClientOrigins(["desktop"]));
  // Change the features, change the list.
  assert.notDeepEqual(storeClientOrigins(mobileOnly), storeClientOrigins(desktopOnly));
  assert.deepEqual(storeClientOrigins(project({ features: [] })), []);
});

check("a published extension id joins the list as an origin", () => {
  const origins = storeClientOrigins(full, { extensionId: "abcdefghijklmnop" });
  assert.ok(origins.includes("chrome-extension://abcdefghijklmnop"));
  // Already an origin: taken as written, with no trailing slash — the
  // auth layer matches these verbatim.
  const asOrigin = storeClientOrigins(full, { extensionId: "chrome-extension://xyz/" });
  assert.ok(asOrigin.includes("chrome-extension://xyz"));
});

check("the derived list reaches the compose file", () => {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-trust-"));
  try {
    applySelfHost(context(dir));
    const compose = readFileSync(join(dir, SELFHOST_COMPOSE_REL), "utf-8");
    assert.match(
      compose,
      new RegExp(
        `${STORE_CLIENT_ORIGINS_KEY}: \\$\\{${STORE_CLIENT_ORIGINS_KEY}:-capacitor://localhost,https://localhost,app://-\\}`,
      ),
    );
    assert.match(compose, /TRUST_STORE_APPS: \$\{TRUST_STORE_APPS:-true\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("the unlistable-extension switch follows the main one when unset", () => {
  const sw = trustSwitches(full).find((s) => s.key === TRUST_EXTENSION_ORIGINS_KEY);
  assert.equal(sw?.default, "", "an explicit default would stop it following the main switch");
  assert.match(sw?.comment.join(" ") ?? "", /follows TRUST_STORE_APPS/);
  assert.match(sw?.comment.join(" ") ?? "", /no session cookie/);
});

// The other half of the pair: the server that reads these keys. Asserted
// against the starter's own source, because the only thing that makes a
// switch real is the server honouring it — and a key renamed on one side
// alone leaves a compose file whose settings are decoration.
const STARTER_TRUST_CONFIG = resolve(
  join(import.meta.dirname, "..", "starter", SERVER_TRUST_CONFIG_REL),
);
const starterTrustConfig = existsSync(STARTER_TRUST_CONFIG)
  ? readFileSync(STARTER_TRUST_CONFIG, "utf-8")
  : null;

if (starterTrustConfig === null) {
  console.log(`  - starter not populated at ${STARTER_TRUST_CONFIG}, skipping the paired checks`);
} else {
  check("every key the compose file sets is a key the starter's server reads", () => {
    for (const sw of trustSwitches(full)) {
      assert.match(
        starterTrustConfig,
        new RegExp(`getOptional\\("${sw.key}"\\)`),
        `${sw.key} is written into the compose file but never read in ${SERVER_TRUST_CONFIG_REL}`,
      );
    }
  });

  check("the server appends the store origins unless the switch is off", () => {
    // The rule itself, not just the key: buildTrustedOrigins has to read the
    // derived list through the switch, or the compose file is setting a
    // variable that reaches nothing.
    assert.match(
      starterTrustConfig,
      /trustStoreApps[\s\S]{0,120}parseOriginList\(\s*source\.storeClientOrigins/,
    );
    assert.match(starterTrustConfig, /storeClientOrigins: env\.STORE_CLIENT_ORIGINS/);
  });

  check("the server's default for the store switch is on, not off", () => {
    // `!FALSE_FLAGS.includes(...)`: anything but an explicit false is on,
    // including the key being absent altogether. An `=== "true"` here would
    // make the compose default the only thing keeping store clients working,
    // and a hand-written .env without the key would refuse them.
    assert.match(starterTrustConfig, /resolveTrustStoreApps[\s\S]{0,200}!FALSE_FLAGS\.includes/);
  });

  check("the server's extension switch follows the store switch when unset", () => {
    // The fallback return, after the explicit true/false branches.
    assert.match(
      starterTrustConfig,
      /resolveTrustExtensionOrigins[\s\S]{0,400}return trustStoreApps;/,
    );
  });
}

// ---------------------------------------------------------------------------
// The empty API URL
// ---------------------------------------------------------------------------

console.log("\nempty api url\n");

check("the build override keeps the API URL empty", () => {
  const override = renderSelfHostBuildOverride(full);
  assert.match(override, /NEXT_PUBLIC_API_URL: ""/);
  assert.equal(
    /NEXT_PUBLIC_API_URL: "[^"]+"/.test(override),
    false,
    "the build override bakes a URL into the image",
  );
  assert.match(override, /pull_policy: build/);
  assert.match(override, /image: acme-client-selfhost:local/);
});

check("the smoke workflow builds the web image with an empty API URL", () => {
  const workflow = renderSmokeWorkflow(full);
  assert.match(workflow, /^\s+NEXT_PUBLIC_API_URL=$/m);
  assert.equal(/NEXT_PUBLIC_API_URL=\S/.test(workflow), false);
});

check("the derived client Dockerfile drops the guard that rejects an empty URL", () => {
  const base = [
    "FROM node:24 AS build",
    "ARG NEXT_PUBLIC_API_URL",
    "ARG NEXT_PUBLIC_SENTRY_DSN",
    "ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \\",
    "    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \\",
    "    HATCHKIT_IMAGE_BUILD=1",
    "RUN pnpm --filter client run build",
    "",
  ].join("\n");
  const derived = selfHostClientDockerfile(base);
  assert.equal(/HATCHKIT_IMAGE_BUILD/.test(withoutComments(derived, "#")), false);
  // The line before it keeps its value and loses its continuation.
  assert.match(derived, /NEXT_PUBLIC_SENTRY_DSN=\$NEXT_PUBLIC_SENTRY_DSN\n/);
  assert.match(derived, /EMPTY NEXT_PUBLIC_API_URL/);
  assert.match(derived, /RUN pnpm --filter client run build/);
  // Idempotent, and a hand-rolled file with no guard is left alone.
  assert.equal(selfHostClientDockerfile(derived), derived);
  const hand = "FROM scratch\n";
  assert.equal(selfHostClientDockerfile(hand), hand);
});

// ---------------------------------------------------------------------------
// Env example
// ---------------------------------------------------------------------------

console.log("\nenv example\n");

check("the env example carries the domain, the secret, the datastores and mail", () => {
  const keys = selfHostEnvKeys(full);
  const names = keys.map((k) => k.key);
  for (const expected of [
    "APP_DOMAIN",
    "BETTER_AUTH_SECRET",
    "ACME_VERSION",
    "MONGODB_URI",
    "REDIS_URL",
    TRUST_STORE_APPS_KEY,
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  assert.ok(keys.some((k) => k.group === "mail"));
  // Only the two that stop the stack are required.
  assert.deepEqual(
    keys.filter((k) => k.required).map((k) => k.key),
    ["APP_DOMAIN", "BETTER_AUTH_SECRET"],
  );
  // Nothing that is not needed to boot.
  for (const unwanted of ["STRIPE_SECRET_KEY", "AWS_ACCESS_KEY_ID", "S3_BUCKET_NAME"]) {
    assert.equal(names.includes(unwanted), false, `${unwanted} is not needed to boot`);
  }
});

check("the env example follows the project's datastores and name", () => {
  const names = selfHostEnvKeys(project({ features: [], name: "widgets" })).map((k) => k.key);
  assert.equal(names.includes("REDIS_URL"), false);
  assert.ok(names.includes("WIDGETS_VERSION"));
  assert.deepEqual(selfHostEnvKeys(project({ surfaces: "static" })), []);
  // The secret ships blank: a plausible placeholder would boot.
  const secret = selfHostEnvKeys(full).find((k) => k.key === "BETTER_AUTH_SECRET");
  assert.equal(secret?.example, "");
  assert.match(renderSelfHostEnvExample(full), /^BETTER_AUTH_SECRET=$/m);
  assert.match(renderSelfHostEnvExample(full), /^APP_DOMAIN=acme\.example\.com$/m);
});

check("every required env key is backed by a fail-fast form in the compose file", () => {
  const compose = renderSelfHostCompose(full);
  for (const key of selfHostEnvKeys(full).filter((k) => k.required)) {
    assert.match(compose, new RegExp(`\\$\\{${key.key}:\\?`), `${key.key} has no :? form`);
  }
});

// ---------------------------------------------------------------------------
// Smoke workflow
// ---------------------------------------------------------------------------

console.log("\nsmoke workflow\n");

check("it waits for health rather than sleeping", () => {
  const workflow = renderSmokeWorkflow(full);
  assert.match(workflow, /up -d --no-build --wait --wait-timeout \d+/);
  assert.equal(/^\s*(run: )?sleep /m.test(workflow), false, "the workflow sleeps");
});

check("it asserts both the site and the API", () => {
  const workflow = renderSmokeWorkflow(full);
  assert.match(workflow, /https:\/\/\$APP_DOMAIN\/api\/health/);
  assert.match(workflow, /https:\/\/\$APP_DOMAIN\//);
  assert.match(workflow, /the site answered HTTP/);
  assert.match(workflow, /answered HTTP \$status through the proxy/);
  // The proxy rules this feature owns are asserted too.
  assert.match(workflow, /version\.json/);
  assert.match(workflow, /did not upgrade through the proxy/);
});

check("it dumps every service's log on failure, and tears the stack down", () => {
  const workflow = renderSmokeWorkflow(full);
  assert.match(workflow, /if: failure\(\)/);
  assert.match(workflow, /for service in \$\(\$COMPOSE config --services\); do/);
  assert.match(workflow, /\$COMPOSE logs .*"\$service"/);
  assert.match(workflow, /if: always\(\)\n\s+run: \$COMPOSE down -v --remove-orphans/);
});

check("it runs on pull requests touching the self-host files, and on a schedule", () => {
  const workflow = renderSmokeWorkflow(full);
  assert.match(workflow, /^on:\n {2}pull_request:\n {4}paths:$/m);
  assert.match(workflow, /^ {2}schedule:$/m);
  assert.match(workflow, /^ {2}workflow_dispatch:$/m);
  const paths = smokeWorkflowPaths(full);
  for (const rel of [
    SELFHOST_COMPOSE_REL,
    SELFHOST_CI_OVERRIDE_REL,
    PROXY_CONFIG_REL,
    SELFHOST_SMOKE_WORKFLOW_REL,
    SELFHOST_CLIENT_DOCKERFILE_REL,
  ]) {
    assert.ok(paths.includes(rel), `${rel} does not re-run the smoke test`);
  }
});

check("the CI override pins the tags the workflow builds, and never pulls", () => {
  const workflow = renderSmokeWorkflow(full);
  assert.match(workflow, new RegExp(`tags: ${ciImageTag(full, "server")}`));
  assert.match(workflow, new RegExp(`tags: ${ciImageTag(full, "client")}`));
  const dir = mkdtempSync(join(tmpdir(), "selfhost-ci-"));
  try {
    applySelfHost(context(dir));
    const override = readFileSync(join(dir, SELFHOST_CI_OVERRIDE_REL), "utf-8");
    assert.match(override, new RegExp(`image: ${ciImageTag(full, "server")}`));
    assert.match(override, /pull_policy: never/);
    assert.match(override, /interval: 5s/);
    // Only intervals — the probes stay the base file's own.
    assert.equal(/test:/.test(override), false, "the CI override redefines a probe");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a backend project's workflow asserts the API and not a site", () => {
  const workflow = renderSmokeWorkflow(project({ surfaces: "backend" }));
  assert.match(workflow, /\/api\/health/);
  assert.equal(/the site answered HTTP/.test(workflow), false);
  assert.equal(/version\.json/.test(workflow), false);
});

// ---------------------------------------------------------------------------
// applySelfHost
// ---------------------------------------------------------------------------

console.log("\napply\n");

function scaffold(dir: string): void {
  const dockerfile = join(dir, "packages/client/Dockerfile");
  mkdirSync(dirname(dockerfile), { recursive: true });
  writeFileSync(
    dockerfile,
    [
      "FROM node:24 AS build",
      "ARG NEXT_PUBLIC_API_URL",
      "ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \\",
      "    HATCHKIT_IMAGE_BUILD=1",
      "RUN pnpm --filter client run build",
      "",
    ].join("\n"),
    "utf-8",
  );
}

check("it writes the whole stack, and the files are the ones it names", () => {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-apply-"));
  try {
    scaffold(dir);
    const ctx = context(dir);
    const outcome = applySelfHost(ctx);
    assert.equal(outcome.skipped, undefined);
    const written = filesWith(ctx.ledger, "written");
    for (const rel of STACK_FILES) {
      assert.ok(written.includes(rel), `${rel} was not written`);
      assert.ok(existsSync(join(dir, rel)), `${rel} is missing on disk`);
    }
    assert.deepEqual(ctx.ledger.conflicts(), []);
    assert.ok(outcome.notes.some((n) => /EMPTY NEXT_PUBLIC_API_URL/.test(n)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("every generated file says hatchkit owns it", () => {
  // `writeIfChanged` overwrites, so the person editing one of these loses
  // the edit on the next update. The only warning they get is the one in
  // the file itself, which makes its presence part of the contract.
  const dir = mkdtempSync(join(tmpdir(), "selfhost-owned-"));
  try {
    scaffold(dir);
    applySelfHost(context(dir));
    for (const rel of STACK_FILES) {
      const head = readFileSync(join(dir, rel), "utf-8").slice(0, 400);
      assert.match(head, /Generated and owned by hatchkit/, `${rel} does not say it is owned`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("the notes are things only a person can do", () => {
  // The ledger already reports every file. A note that restated one would
  // be noise in the place the genuinely manual steps are read.
  const dir = mkdtempSync(join(tmpdir(), "selfhost-notes-"));
  try {
    scaffold(dir);
    const notes = applySelfHost(context(dir)).notes;
    assert.ok(
      notes.some((n) => /Publish .*-server/.test(n)),
      "no note about publishing images",
    );
    assert.ok(
      notes.some((n) => /A\/AAAA record/.test(n)),
      "no note about DNS",
    );
    assert.ok(
      notes.some((n) => n.includes(TRUST_STORE_APPS_KEY) && n.includes(SERVER_TRUST_CONFIG_REL)),
      "no note about which clients may sign in",
    );
    for (const rel of STACK_FILES) {
      assert.equal(
        notes.some((n) => n.includes(rel)),
        false,
        `a note restates ${rel}, which the ledger already reports`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("applying twice writes nothing the second time", () => {
  // `update` re-applies the whole operational layer on every run, so a
  // module that is not idempotent corrupts a project a little more each
  // time — and does it silently.
  const dir = mkdtempSync(join(tmpdir(), "selfhost-idem-"));
  try {
    scaffold(dir);
    applySelfHost(context(dir));
    const before = STACK_FILES.map((rel) => readFileSync(join(dir, rel), "utf-8"));

    const second = context(dir);
    applySelfHost(second);
    assert.deepEqual(filesWith(second.ledger, "written"), []);
    assert.deepEqual(filesWith(second.ledger, "would-write"), []);
    for (const entry of second.ledger.entries) {
      assert.ok(
        entry.action === "unchanged" || entry.action === "absent",
        `${entry.file} is ${entry.action} on a re-run`,
      );
    }
    assert.deepEqual(
      STACK_FILES.map((rel) => readFileSync(join(dir, rel), "utf-8")),
      before,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a drifted owned file is regenerated, not left alone", () => {
  // The other half of ownership. A file frozen after its first write
  // leaves a project running the first version of the stack for ever,
  // while the smoke workflow keeps passing against it.
  const dir = mkdtempSync(join(tmpdir(), "selfhost-drift-"));
  try {
    scaffold(dir);
    applySelfHost(context(dir));
    const generated = readFileSync(join(dir, PROXY_CONFIG_REL), "utf-8");
    writeFileSync(join(dir, PROXY_CONFIG_REL), "# hand-tuned\n", "utf-8");

    const again = context(dir);
    applySelfHost(again);
    assert.deepEqual(filesWith(again.ledger, "written"), [PROXY_CONFIG_REL]);
    assert.equal(readFileSync(join(dir, PROXY_CONFIG_REL), "utf-8"), generated);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a dry run touches nothing and reports what it would have written", () => {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-dry-"));
  try {
    scaffold(dir);
    const ctx = context(dir, {}, { dryRun: true });
    applySelfHost(ctx);
    const would = filesWith(ctx.ledger, "would-write");
    for (const rel of STACK_FILES) {
      assert.ok(would.includes(rel), `${rel} is not reported as would-write`);
      assert.equal(existsSync(join(dir, rel)), false, `${rel} was written during a dry run`);
    }
    assert.deepEqual(filesWith(ctx.ledger, "written"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a static project is skipped with a reason, and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-static-"));
  try {
    const ctx = context(dir, { surfaces: "static" });
    const outcome = applySelfHost(ctx);
    assert.match(outcome.skipped ?? "", /no server half/);
    assert.deepEqual(outcome.notes, []);
    assert.deepEqual(ctx.ledger.entries, []);
    assert.equal(existsSync(join(dir, SELFHOST_COMPOSE_REL)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a missing client Dockerfile is a note for a person, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-nodf-"));
  try {
    const ctx = context(dir);
    const outcome = applySelfHost(ctx);
    const written = filesWith(ctx.ledger, "written");
    assert.ok(written.includes(SELFHOST_COMPOSE_REL));
    assert.equal(written.includes(SELFHOST_CLIENT_DOCKERFILE_REL), false);
    assert.ok(
      outcome.notes.some(
        (n) => n.includes(SELFHOST_CLIENT_DOCKERFILE_REL) && /EMPTY NEXT_PUBLIC_API_URL/.test(n),
      ),
      "no note telling the reader to write the self-host Dockerfile by hand",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("the self-host image never builds the docs, whenever it is derived", () => {
  // The bug this encodes: this file is derived from the project's own
  // client Dockerfile, and the docs module retrofits THAT Dockerfile
  // after this module has already run. So the first apply derived from a
  // Dockerfile with no docs step and the second from one with it, which
  // meant `hatchkit update` rewrote this file on the run after the docs
  // landed — and the rewritten file built the docs a second time, onto
  // every self-hoster's own domain, which is the duplicate-content
  // problem the docs feature exists to prevent.
  const pristine = [
    "FROM node:24 AS deps",
    "COPY packages/client/package.json packages/client/",
    "",
    "FROM deps AS build",
    "COPY packages/client packages/client",
    "ENV HATCHKIT_IMAGE_BUILD=1",
    "RUN pnpm --filter client run build",
    "",
    "FROM nginx AS runtime",
    "",
  ].join("\n");

  // The same Dockerfile once the docs module has retrofitted it: a
  // manifest copy, the sources, and the build step after the client build.
  const withDocs = [
    "FROM node:24 AS deps",
    "COPY packages/client/package.json packages/client/",
    "COPY docs-site/package.json docs-site/",
    "",
    "FROM deps AS build",
    "COPY packages/client packages/client",
    "# The docs site and the step that builds it into the client's output.",
    "COPY docs-site docs-site",
    "COPY scripts/docs scripts/docs",
    "ENV HATCHKIT_IMAGE_BUILD=1",
    "RUN pnpm --filter client run build",
    "",
    "# The docs, published at https://x/docs/. Built HERE, in the web",
    "# image, and NEVER added to the client package's own build script.",
    "RUN node scripts/docs/build-into-client.mjs",
    "",
    "FROM nginx AS runtime",
    "",
  ].join("\n");

  const fromPristine = selfHostClientDockerfile(pristine);
  const fromDocs = selfHostClientDockerfile(withDocs);

  // Neither carries the docs.
  assert.equal(/build-into-client/.test(fromDocs), false);
  assert.equal(/docs-site/.test(fromDocs), false);
  assert.equal(/scripts\/docs/.test(fromDocs), false);

  // And the two derivations agree byte for byte — that equality is what
  // makes the module's output independent of whether the docs module has
  // run yet, which is what the ledger's `unchanged` depends on.
  assert.equal(fromDocs, fromPristine);
});

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log("\n  all selfhost checks passed\n");
