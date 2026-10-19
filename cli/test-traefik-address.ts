/** Where migrate-runtime reaches Traefik: override, then tailnet, then public. */
import assert from "node:assert/strict";
import { getStore } from "./src/config.js";
import { planRuntimeMigration } from "./src/deploy/migrate-runtime-plan.js";
import { checkTraefikReachable } from "./src/deploy/migrate-runtime.js";
import {
  TRAEFIK_ADDRESS_ENV,
  type TraefikAddress,
  isTailnetIpv4,
  resolveTraefikAddress,
  traefikAddressFor,
} from "./src/deploy/traefik-address.js";
import type { CoolifyApi } from "./src/utils/coolify-api.js";

const backupHosts = [
  { transport: "tailscale" as const, target: "root@shared-vps", serverUuid: "shared" },
  { transport: "tailscale" as const, target: "root@dedicated-vps", serverUuid: "srv" },
];
const asked: string[] = [];
const tailnet = async (peer: string) => {
  asked.push(peer);
  return "100.117.14.6";
};

// 1. Tailnet address when the backup host is this app's server.
assert.deepEqual(
  await resolveTraefikAddress({
    serverUuid: "srv",
    publicV4: "46.225.212.114",
    backupHosts,
    tailnetIpv4: tailnet,
  }),
  {
    ok: true,
    address: "100.117.14.6",
    source: "tailnet",
    detail: "tailnet address of dedicated-vps",
  },
);
assert.deepEqual(asked, ["dedicated-vps"], "the host on this server, its target without the user");

// 2. The override wins, and no lookup runs.
asked.length = 0;
const overridden = await resolveTraefikAddress({
  serverUuid: "srv",
  publicV4: "46.225.212.114",
  override: " 10.0.0.5 ",
  backupHosts,
  tailnetIpv4: tailnet,
});
assert.equal(overridden.ok && overridden.address, "10.0.0.5");
assert.equal(overridden.ok && overridden.source, "override");
assert.deepEqual(asked, []);
for (const override of ["dedicated-vps.tail5ecaf2.ts.net", "fd7a:115c:a1e0::1"]) {
  const r = await resolveTraefikAddress({ serverUuid: "srv", override, tailnetIpv4: tailnet });
  assert.equal(r.ok && r.address, override);
}
for (const override of ["http://10.0.0.5", "10.0.0.5:80", "a b"]) {
  const r = await resolveTraefikAddress({
    serverUuid: "srv",
    publicV4: "46.225.212.114",
    override,
  });
  assert.equal(r.ok, false, `an unusable override refuses, never falls back: ${override}`);
}

// 3. Public IPv4 when the tailnet address is unknown.
const publicOnly = (r: TraefikAddress) => (r.ok && r.source === "public" ? r.address : r);
asked.length = 0;
assert.equal(
  publicOnly(
    await resolveTraefikAddress({
      serverUuid: "other",
      publicV4: "46.225.212.114",
      backupHosts,
      tailnetIpv4: tailnet,
    }),
  ),
  "46.225.212.114",
);
assert.deepEqual(asked, [], "no backup host on this server: nothing is asked");
assert.equal(
  publicOnly(await resolveTraefikAddress({ serverUuid: "srv", publicV4: "46.225.212.114" })),
  "46.225.212.114",
);
const lookupFails = await resolveTraefikAddress({
  serverUuid: "srv",
  publicV4: "46.225.212.114",
  backupHosts,
  tailnetIpv4: async () => {
    throw new Error("Tailscale is stopped.");
  },
});
assert.equal(publicOnly(lookupFails), "46.225.212.114");
assert.match(lookupFails.ok ? lookupFails.detail : "", /tailscale ip -4 dedicated-vps failed/);
assert.equal(
  publicOnly(
    await resolveTraefikAddress({
      serverUuid: "srv",
      publicV4: "46.225.212.114",
      backupHosts,
      tailnetIpv4: async () => "192.168.1.4",
    }),
  ),
  "46.225.212.114",
  "an address outside 100.64.0.0/10 is not a tailnet address",
);
assert.equal((await resolveTraefikAddress({ serverUuid: "srv" })).ok, false);

assert.ok(isTailnetIpv4("100.64.0.1") && isTailnetIpv4("100.127.255.254"));
assert.ok(!isTailnetIpv4("100.128.0.1") && !isTailnetIpv4("100.63.0.1"));

// traefikAddressFor reads the environment and the backups provider.
getStore().set("providers.backups", {
  status: "configured",
  repositoryBase: "s3:https://acct.r2.cloudflarestorage.com/backups",
  hosts: { "dedicated-vps": backupHosts[1] },
  autoRegister: false,
});
process.env[TRAEFIK_ADDRESS_ENV] = "10.0.0.9";
const fromEnv = await traefikAddressFor("srv", "46.225.212.114");
assert.equal(fromEnv.ok && `${fromEnv.source} ${fromEnv.address}`, "override 10.0.0.9");
delete process.env[TRAEFIK_ADDRESS_ENV];
const otherServer = await traefikAddressFor("other", "46.225.212.114");
assert.equal(otherServer.ok && otherServer.source, "public");

// --dry-run asks Traefik at the resolved address, by the public hostname.
const plan = planRuntimeMigration(
  {
    uuid: "old",
    name: "site",
    buildPack: "dockercompose",
    composeRaw: "services:\n  app:\n    image: ghcr.io/test/site:abc123\n    expose: ['80']\n",
    composeDomains: [{ name: "app", domain: "https://site.example" }],
  },
  [],
);
const api = {
  async getApplication() {
    return { uuid: "old", serverUuid: "srv" };
  },
  async listServers() {
    return [{ uuid: "srv", ip: "host.docker.internal" }];
  },
} as unknown as CoolifyApi;
const probes: string[] = [];
const deps = {
  async discoverPublicIps() {
    return { v4: "46.225.212.114" };
  },
  async traefikAddressFor(): Promise<TraefikAddress> {
    return { ok: true, address: "100.117.14.6", source: "tailnet", detail: "tailnet" };
  },
  async probeViaHost(ip: string, host: string, path: string) {
    probes.push(`${ip} ${host} ${path}`);
    return 200;
  },
};
assert.equal(await checkTraefikReachable(api, plan, deps), true);
assert.deepEqual(probes, ["100.117.14.6 site.example /"]);
assert.equal(
  await checkTraefikReachable(api, plan, { ...deps, probeViaHost: async () => null }),
  false,
  "no answer from Traefik fails the dry run, as the real run would refuse",
);

console.log("✓ Traefik probe address: override, tailnet, public fallback; dry-run probe");
