/**
 * Deployment-topology routing — the contract `create`, `adopt` and
 * `sync` all read.
 *
 * These assertions encode two Coolify behaviours that hatchkit got
 * wrong for months, both verified against Coolify 4.0.0-beta.469's
 * source and a live install:
 *
 *  1. `docker_compose_domains` is STORED as a map keyed by service name
 *     (`ApplicationsController` does `->put($name, $entry)`), so two
 *     array entries with the same `name` are a silent last-wins drop.
 *     Every hatchkit project shipped with four `server` entries and
 *     therefore ended up routing only the LAST one — which is why
 *     `https://<domain>/api` never existed anywhere and every
 *     hatchkit-scaffolded fullstack API was unreachable.
 *     → `collapseComposeDomains` must comma-join instead.
 *
 *  2. A non-`/` path pulls in Coolify's Traefik `stripprefix`
 *     middleware, so `/api/health` would arrive at Express as
 *     `/health`. → `stripPrefix` must be false whenever routing uses a
 *     path.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  collapseComposeDomains,
  computeRoutingPlan,
  inferTopology,
  resolvePublicService,
  splitDomainString,
} from "./src/deploy/routing.js";
import { listComposeServices, validateComposeServices } from "./src/utils/compose.js";

const failures: string[] = [];

function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

const STARTER_SERVICES = ["server", "client", "mongo", "redis"];

const fullstack = {
  name: "streaks",
  domain: "streaks.trebeljahr.com",
  surfaces: "fullstack" as const,
  ports: { server: 5276, client: 6999 },
  composeServices: STARTER_SERVICES,
};

// ---------------------------------------------------------------------------
// single-origin
// ---------------------------------------------------------------------------

check("single-origin: one app, named after the project", () => {
  const plan = computeRoutingPlan({ ...fullstack, topology: "single-origin" });
  assert.equal(plan.apps.length, 1);
  assert.equal(plan.apps[0].appName, "streaks");
  assert.equal(plan.apps[0].role, "compose");
  assert.deepEqual(plan.extraDnsHostnames, [], "single-origin needs no extra DNS");
});

check("single-origin: client takes the bare domain, server takes /api", () => {
  const plan = computeRoutingPlan({ ...fullstack, topology: "single-origin" });
  assert.deepEqual(plan.apps[0].composeDomains, [
    { name: "client", domain: "https://streaks.trebeljahr.com" },
    { name: "server", domain: "https://streaks.trebeljahr.com/api" },
  ]);
});

check("single-origin: NEVER emits the literal service name `app`", () => {
  // The bug that started all this: sync hardcoded `[{name:"app",…}]`,
  // a service that exists in no hatchkit compose file. Coolify accepts
  // such a PATCH with 200 OK and then emits no Traefik labels at all.
  const plan = computeRoutingPlan({ ...fullstack, topology: "single-origin" });
  for (const entry of plan.apps[0].composeDomains) {
    assert.ok(
      STARTER_SERVICES.includes(entry.name),
      `routed service "${entry.name}" is not declared in the starter compose`,
    );
  }
});

check("single-origin: one entry per service (Coolify stores a map)", () => {
  const plan = computeRoutingPlan({ ...fullstack, topology: "single-origin" });
  const names = plan.apps[0].composeDomains.map((d) => d.name);
  assert.equal(new Set(names).size, names.length, "duplicate service names would be last-wins");
});

check("single-origin: strip-prefix disabled because routing uses /api", () => {
  const plan = computeRoutingPlan({ ...fullstack, topology: "single-origin" });
  assert.equal(plan.apps[0].stripPrefix, false);
});

check("single-origin: backend-only routes everything at the server, path-free", () => {
  const plan = computeRoutingPlan({
    ...fullstack,
    surfaces: "backend",
    composeServices: ["server", "mongo", "redis"],
    topology: "single-origin",
  });
  assert.deepEqual(plan.apps[0].composeDomains, [
    { name: "server", domain: "https://streaks.trebeljahr.com" },
  ]);
  assert.equal(plan.apps[0].stripPrefix, true, "no path route → leave Coolify's default alone");
});

check("single-origin: static has no API route", () => {
  const plan = computeRoutingPlan({
    ...fullstack,
    surfaces: "static",
    composeServices: ["client"],
    topology: "single-origin",
  });
  assert.deepEqual(plan.apps[0].composeDomains, [
    { name: "client", domain: "https://streaks.trebeljahr.com" },
  ]);
  assert.equal(plan.apps[0].stripPrefix, true);
});

// ---------------------------------------------------------------------------
// split
// ---------------------------------------------------------------------------

check("split: two apps with the names sync looks for", () => {
  const plan = computeRoutingPlan({ ...fullstack, topology: "split" });
  assert.deepEqual(
    plan.apps.map((a) => a.appName),
    ["streaks-client", "streaks-server"],
  );
});

check("split: client at <domain>, server at api.<domain>, both path-free", () => {
  const plan = computeRoutingPlan({ ...fullstack, topology: "split" });
  assert.deepEqual(plan.apps[0].composeDomains, [
    { name: "client", domain: "https://streaks.trebeljahr.com" },
  ]);
  assert.deepEqual(plan.apps[1].composeDomains, [
    { name: "server", domain: "https://api.streaks.trebeljahr.com" },
  ]);
  assert.ok(plan.apps.every((a) => a.stripPrefix));
});

check("split: reports the extra DNS record the topology needs", () => {
  const plan = computeRoutingPlan({ ...fullstack, topology: "split" });
  assert.deepEqual(plan.extraDnsHostnames, ["api.streaks.trebeljahr.com"]);
});

check("split: accepts -backend / -frontend as lookup aliases", () => {
  // tiao's working stack is `tiao-backend` / `tiao-frontend`. Refusing
  // to match those names would mean sync silently skipping a real,
  // serving deployment.
  const plan = computeRoutingPlan({ ...fullstack, name: "tiao", topology: "split" });
  assert.ok(plan.apps[0].aliases.includes("tiao-frontend"));
  assert.ok(plan.apps[1].aliases.includes("tiao-backend"));
});

// ---------------------------------------------------------------------------
// Service-name resolution
// ---------------------------------------------------------------------------

check("publicService: an explicit pin wins when the service exists", () => {
  assert.equal(
    resolvePublicService({ ...fullstack, topology: "single-origin", publicService: "server" }),
    "server",
  );
});

check("publicService: a pin naming a phantom service is ignored", () => {
  // A manifest carrying `publicService: "app"` (or any stale value)
  // must not be able to push a name the compose doesn't declare.
  assert.equal(
    resolvePublicService({ ...fullstack, topology: "single-origin", publicService: "app" }),
    "client",
  );
});

check("publicService: infers from a user-authored compose with other names", () => {
  assert.equal(
    resolvePublicService({
      ...fullstack,
      surfaces: undefined,
      topology: "single-origin",
      composeServices: ["web", "api", "postgres"],
    }),
    "web",
  );
});

check("publicService: skips infrastructure services entirely", () => {
  assert.equal(
    resolvePublicService({
      ...fullstack,
      surfaces: undefined,
      topology: "single-origin",
      composeServices: ["postgres", "redis", "gateway"],
    }),
    "gateway",
  );
});

// ---------------------------------------------------------------------------
// collapseComposeDomains — the map-shape fix
// ---------------------------------------------------------------------------

check("collapse: several domains for one service become one comma-joined entry", () => {
  // Pre-fix, hatchkit sent exactly this array and Coolify kept only
  // `https://api.x.com/ws`.
  assert.deepEqual(
    collapseComposeDomains([
      { name: "client", domain: "https://x.com" },
      { name: "server", domain: "https://api.x.com" },
      { name: "server", domain: "https://x.com/api" },
      { name: "server", domain: "https://api.x.com/ws" },
    ]),
    [
      { name: "client", domain: "https://x.com" },
      { name: "server", domain: "https://api.x.com,https://x.com/api,https://api.x.com/ws" },
    ],
  );
});

check("collapse: idempotent, and dedupes repeated FQDNs", () => {
  const once = collapseComposeDomains([
    { name: "server", domain: "https://a.com" },
    { name: "server", domain: "https://a.com" },
    { name: "server", domain: "https://b.com" },
  ]);
  assert.deepEqual(once, [{ name: "server", domain: "https://a.com,https://b.com" }]);
  assert.deepEqual(collapseComposeDomains(once), once);
});

check("splitDomainString: reverses the comma-join", () => {
  assert.deepEqual(splitDomainString("https://a.com, https://b.com/api"), [
    "https://a.com",
    "https://b.com/api",
  ]);
  assert.deepEqual(splitDomainString(""), []);
});

// ---------------------------------------------------------------------------
// Topology inference
// ---------------------------------------------------------------------------

check("inferTopology: an explicit manifest value always wins", () => {
  const r = inferTopology({ topology: "split", composeServices: STARTER_SERVICES });
  assert.equal(r.topology, "split");
  assert.equal(r.source, "manifest");
});

check("inferTopology: pre-topology manifests default to single-origin", () => {
  // Every manifest written before the field existed came from a run
  // that created ONE Coolify app running the multi-service compose.
  // Defaulting there is what preserves the behaviour of what's already
  // deployed.
  assert.equal(inferTopology({ composeServices: STARTER_SERVICES }).topology, "single-origin");
  assert.equal(inferTopology({}).topology, "single-origin");
});

check("inferTopology: never guesses split", () => {
  // Nothing on disk distinguishes "should be split" from "is
  // single-origin", so guessing it would silently re-point a live
  // project at a subdomain with no DNS.
  for (const services of [undefined, [], STARTER_SERVICES, ["client"], ["server"]]) {
    assert.notEqual(inferTopology({ composeServices: services }).topology, "split");
  }
});

check("inferTopology: reports where the value came from", () => {
  assert.equal(inferTopology({ composeServices: STARTER_SERVICES }).source, "compose");
  assert.equal(inferTopology({}).source, "default");
});

// ---------------------------------------------------------------------------
// Compose parsing + validation
// ---------------------------------------------------------------------------

const STARTER_COMPOSE = `
# comment
services:
  server:
    image: ghcr.io/o/r-server:main
    environment:
      PORT: "5276"
    depends_on:
      - mongo
  client:
    image: ghcr.io/o/r-client:main
  mongo:
    image: mongo:7
  redis:
    image: redis:7-alpine
volumes:
  mongo-data:
`;

check("listComposeServices: top-level keys only", () => {
  assert.deepEqual(listComposeServices(STARTER_COMPOSE), ["server", "client", "mongo", "redis"]);
});

check("listComposeServices: ignores x- extension keys and stops at services", () => {
  assert.deepEqual(
    listComposeServices("x-shared: &s\n  a: b\nservices:\n  web:\n    image: x\nvolumes:\n  v:\n"),
    ["web"],
  );
});

check("validateComposeServices: no project dir means 'unknown', not 'empty'", () => {
  // Blocking a deploy on our parser's limits would be worse than the
  // risk it guards against.
  assert.equal(validateComposeServices(undefined, ["app"]).ok, true);
});

if (failures.length > 0) {
  console.log("\nRouting test failures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}

console.log("\nAll routing cases passed.");
