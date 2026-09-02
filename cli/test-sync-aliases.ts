/**
 * Multi-hostname routing: manifest `aliases[]` → routing-plan payloads.
 *
 * A project can serve several public hostnames from one deployment
 * (e.g. a marketing apex + www next to the canonical app subdomain,
 * plus a legacy domain kept alive for origin-keyed browser storage).
 * The manifest records them as `aliases` next to the primary `domain`;
 * `manifestHostnames` normalizes + dedupes them, and callers feed the
 * tail into `computeRoutingPlan` as `hostnameAliases` so every
 * user-facing routing entry comma-joins them (one Traefik router per
 * URL — Coolify splits on commas, see deploy/routing.ts header).
 * Goldens lock in:
 *
 *   1. manifestHostnames normalizes (scheme/case/trailing-dot) and
 *      dedupes, primary first.
 *
 *   2. single-origin static → the public entry's domain is the joined
 *      https list, ports_exposes stays 80, and there is no API entry —
 *      matching the mesozoic-protocol acceptance shape.
 *
 *   3. single-origin fullstack → aliases ride the client entry; the
 *      `/api` entry stays primary-only (aliases are user-facing
 *      hostnames, not extra API endpoints).
 *
 *   4. split → the client app carries the aliases; the server app keeps
 *      only `api.<domain>`.
 *
 *   5. no aliases → plan identical to one computed without the field
 *      (pre-aliases behavior preserved byte-for-byte).
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { computeRoutingPlan } from "./src/deploy/routing.js";
import { manifestHostnames } from "./src/scaffold/manifest.js";

const failures: string[] = [];

async function expect(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

console.log("manifestHostnames:");

await expect("primary first, aliases normalized + deduped", () => {
  const hosts = manifestHostnames({
    domain: "Play.MesozoicProtocol.com",
    aliases: [
      "https://mesozoicprotocol.com/",
      "www.mesozoicprotocol.com.",
      "play.mesozoicprotocol.com",
      "mesozoicprotocol.com",
    ],
  });
  assert.deepEqual(hosts, [
    "play.mesozoicprotocol.com",
    "mesozoicprotocol.com",
    "www.mesozoicprotocol.com",
  ]);
});

await expect("no aliases → just the primary domain", () => {
  assert.deepEqual(manifestHostnames({ domain: "example.com" }), ["example.com"]);
});

console.log("\ncomputeRoutingPlan with hostnameAliases:");

const mesozoicAliases = manifestHostnames({
  domain: "play.mesozoicprotocol.com",
  aliases: ["mesozoicprotocol.com", "www.mesozoicprotocol.com", "protocol.trebeljahr.com"],
}).slice(1);

await expect("single-origin static joins primary + aliases; no API entry", () => {
  const plan = computeRoutingPlan({
    name: "mesozoic-protocol",
    domain: "play.mesozoicprotocol.com",
    hostnameAliases: mesozoicAliases,
    topology: "single-origin",
    surfaces: "static",
  });
  assert.equal(plan.apps.length, 1);
  const app = plan.apps[0]!;
  assert.equal(app.portsExposes, "80");
  assert.deepEqual(app.composeDomains, [
    {
      name: "client",
      domain:
        "https://play.mesozoicprotocol.com,https://mesozoicprotocol.com," +
        "https://www.mesozoicprotocol.com,https://protocol.trebeljahr.com",
    },
  ]);
  assert.deepEqual(app.flatDomains, [
    "https://play.mesozoicprotocol.com",
    "https://mesozoicprotocol.com",
    "https://www.mesozoicprotocol.com",
    "https://protocol.trebeljahr.com",
  ]);
});

await expect("single-origin fullstack: aliases on client entry, /api stays primary-only", () => {
  const plan = computeRoutingPlan({
    name: "raptor-runner",
    domain: "raptor.example.com",
    hostnameAliases: ["raptor.example.org"],
    topology: "single-origin",
    surfaces: "fullstack",
  });
  const app = plan.apps[0]!;
  assert.deepEqual(app.composeDomains, [
    { name: "client", domain: "https://raptor.example.com,https://raptor.example.org" },
    { name: "server", domain: "https://raptor.example.com/api" },
  ]);
  // The path route still forces stripprefix OFF even with aliases.
  assert.equal(app.stripPrefix, false);
  assert.deepEqual(app.flatDomains, [
    "https://raptor.example.com",
    "https://raptor.example.org",
    "https://raptor.example.com/api",
  ]);
});

await expect("split: client app carries the aliases; server app stays api-only", () => {
  const plan = computeRoutingPlan({
    name: "raptor-runner",
    domain: "raptor.example.com",
    hostnameAliases: ["raptor.example.org"],
    topology: "split",
    surfaces: "fullstack",
  });
  const client = plan.apps.find((a) => a.role === "client");
  const server = plan.apps.find((a) => a.role === "server");
  assert.ok(client && server, "both split apps exist");
  assert.deepEqual(client.composeDomains, [
    { name: "client", domain: "https://raptor.example.com,https://raptor.example.org" },
  ]);
  assert.deepEqual(client.flatDomains, [
    "https://raptor.example.com",
    "https://raptor.example.org",
  ]);
  assert.deepEqual(server.composeDomains, [
    { name: "server", domain: "https://api.raptor.example.com" },
  ]);
  assert.deepEqual(server.flatDomains, ["https://api.raptor.example.com"]);
});

await expect("alias duplicating the primary is dropped", () => {
  const plan = computeRoutingPlan({
    name: "raptor-runner",
    domain: "raptor.example.com",
    hostnameAliases: ["raptor.example.com", "raptor.example.org"],
    topology: "single-origin",
    surfaces: "static",
  });
  assert.deepEqual(plan.apps[0]!.flatDomains, [
    "https://raptor.example.com",
    "https://raptor.example.org",
  ]);
});

await expect("no aliases → plan identical to pre-aliases behavior", () => {
  for (const hostnameAliases of [undefined, []] as const) {
    for (const topology of ["single-origin", "split"] as const) {
      const base = computeRoutingPlan({
        name: "raptor-runner",
        domain: "raptor.example.com",
        topology,
        surfaces: "fullstack",
      });
      const withField = computeRoutingPlan({
        name: "raptor-runner",
        domain: "raptor.example.com",
        ...(hostnameAliases !== undefined ? { hostnameAliases: [...hostnameAliases] } : {}),
        topology,
        surfaces: "fullstack",
      });
      assert.deepEqual(withField, base);
    }
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} sync-aliases test(s) failed:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("\nAll sync-aliases tests passed.");
