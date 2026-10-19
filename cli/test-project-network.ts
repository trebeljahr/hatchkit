/**
 * One Docker network per project (src/deploy/project-network.ts).
 *
 * Why it exists: on dedicated-vps every app, every app database and
 * Coolify's own Postgres, Redis and dashboard shared the `coolify`
 * network, so one compromised app could connect to all of them (audit of
 * 2026-10-19). The properties pinned here:
 *   1. A new resource joins the network its project ALREADY runs on —
 *      even the shared one. Splitting a project strands its database.
 *   2. Only a project with nothing on the server gets `hk-<project>`,
 *      created once and then reused.
 *   3. The destination uuid reaches Coolify's create body, and the
 *      network is read back from the app/database record.
 *   4. A Coolify without the destinations API keeps working (old
 *      behaviour), and says so.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  describePlacement,
  findProjectDestination,
  placeProjectResource,
  projectNetworkName,
  resolveProjectDestination,
} from "./src/deploy/project-network.js";
import { CoolifyApi } from "./src/utils/coolify-api.js";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n    ${(err as Error).message.split("\n").join("\n    ")}`);
  }
}

const SHARED = { uuid: "dest-shared", name: "coolify", network: "coolify" };

function fakeApi(opts: {
  destinations?: Array<{ uuid: string; name: string; network: string }>;
  apps?: Record<string, { uuid?: string; network?: string } | Error>;
  databases?: Array<{ uuid: string; name: string; dest?: { uuid?: string; network?: string } }>;
  destinationsUnsupported?: boolean;
}) {
  const created: string[] = [];
  const destinations = [...(opts.destinations ?? [SHARED])];
  const api = {
    async listServerDestinations() {
      if (opts.destinationsUnsupported)
        throw new Error("Coolify API GET /servers/s/destinations failed: 404 Not Found");
      return destinations;
    },
    async createServerDestination(_server: string, network: string) {
      created.push(network);
      const d = { uuid: `dest-${network}`, name: network, network };
      destinations.push(d);
      return d;
    },
    async getApplication(uuid: string) {
      const a = opts.apps?.[uuid];
      if (a instanceof Error) throw a;
      if (!a) throw new Error(`404 ${uuid}`);
      return { uuid, name: uuid, destination: a } as Awaited<
        ReturnType<CoolifyApi["getApplication"]>
      >;
    },
    async listDatabases() {
      return (opts.databases ?? []).map(({ uuid, name }) => ({ uuid, name }));
    },
    async getDatabase(uuid: string) {
      const db = (opts.databases ?? []).find((d) => d.uuid === uuid);
      return { uuid, destination: db?.dest };
    },
  };
  return { api, created };
}

async function main() {
  console.log("\nproject-network — names");

  await check("hk-<project>, lower-cased, within Docker's name rules", () => {
    assert.equal(projectNetworkName("tiao"), "hk-tiao");
    assert.equal(projectNetworkName("Collection of Beauty!"), "hk-collection-of-beauty");
    assert.equal(projectNetworkName("-weird.name_"), "hk-weird.name");
    assert.match(projectNetworkName("x".repeat(80)), /^hk-x{50}$/);
  });

  await check("a name with nothing usable in it is refused, not turned into `hk-`", () => {
    assert.throws(() => projectNetworkName("!!!"), /network name/);
  });

  console.log("\nproject-network — where a new resource goes");

  await check(
    "a project with nothing on the server gets its own network, created once",
    async () => {
      const { api, created } = fakeApi({});
      const first = await resolveProjectDestination(api, { serverUuid: "s", projectName: "tiao" });
      assert.deepEqual(first, { uuid: "dest-hk-tiao", network: "hk-tiao", source: "created" });
      const second = await resolveProjectDestination(api, { serverUuid: "s", projectName: "tiao" });
      assert.equal(second.source, "existing");
      assert.deepEqual(created, ["hk-tiao"]);
    },
  );

  await check("a project that already runs on `coolify` stays there (never split)", async () => {
    const { api, created } = fakeApi({
      destinations: [SHARED, { uuid: "dest-hk-tiao", name: "hk-tiao", network: "hk-tiao" }],
    });
    const p = await resolveProjectDestination(api, {
      serverUuid: "s",
      projectName: "tiao",
      follow: { uuid: "dest-shared", network: "coolify" },
    });
    assert.deepEqual(p, { uuid: "dest-shared", network: "coolify", source: "followed" });
    assert.deepEqual(created, []);
  });

  await check("follow by network name when the record carries no uuid", async () => {
    const { api } = fakeApi({});
    const p = await resolveProjectDestination(api, {
      serverUuid: "s",
      projectName: "tiao",
      follow: { network: "coolify" },
    });
    assert.equal(p.uuid, "dest-shared");
  });

  await check("a followed destination that is not on this server is ignored", async () => {
    const { api, created } = fakeApi({});
    const p = await resolveProjectDestination(api, {
      serverUuid: "s",
      projectName: "tiao",
      follow: { uuid: "dest-elsewhere", network: "other" },
    });
    assert.equal(p.network, "hk-tiao");
    assert.deepEqual(created, ["hk-tiao"]);
  });

  console.log("\nproject-network — where the project already runs");

  await check("the first readable app decides", async () => {
    const { api } = fakeApi({
      apps: { broken: new Error("500"), good: { uuid: "dest-hk-tiao", network: "hk-tiao" } },
    });
    const dest = await findProjectDestination(api, {
      projectName: "tiao",
      appUuids: ["broken", "good"],
    });
    assert.deepEqual(dest, { uuid: "dest-hk-tiao", network: "hk-tiao" });
  });

  await check(
    "no app yet: a database named <project>-… decides; another project's does not",
    async () => {
      const { api } = fakeApi({
        databases: [
          { uuid: "d1", name: "tiaox-mongo", dest: { uuid: "dest-other", network: "hk-tiaox" } },
          { uuid: "d2", name: "tiao-redis", dest: { uuid: "dest-shared", network: "coolify" } },
        ],
      });
      const dest = await findProjectDestination(api, { projectName: "tiao", appUuids: [] });
      assert.deepEqual(dest, { uuid: "dest-shared", network: "coolify" });
    },
  );

  await check("nothing at all: null", async () => {
    const { api } = fakeApi({});
    assert.equal(await findProjectDestination(api, { projectName: "tiao", appUuids: [] }), null);
  });

  await check(
    "placeProjectResource: an existing database pulls a new app onto its network",
    async () => {
      const { api, created } = fakeApi({
        databases: [
          { uuid: "d2", name: "tiao-redis", dest: { uuid: "dest-shared", network: "coolify" } },
        ],
      });
      const { placement, note } = await placeProjectResource(api, {
        serverUuid: "s",
        projectName: "tiao",
        appUuids: [],
      });
      assert.equal(placement?.network, "coolify");
      assert.match(note, /shared `coolify` network, where the rest of the project runs/);
      assert.deepEqual(created, []);
    },
  );

  await check(
    "placeProjectResource: no destinations API → Coolify's default, said out loud",
    async () => {
      const { api } = fakeApi({ destinationsUnsupported: true });
      const { placement, note } = await placeProjectResource(api, {
        serverUuid: "s",
        projectName: "tiao",
        appUuids: [],
      });
      assert.equal(placement, undefined);
      assert.match(note, /couldn't choose a project network .*404.*default network/);
    },
  );

  await check("describePlacement names the network", () => {
    assert.match(
      describePlacement({ uuid: "u", network: "hk-a", source: "created" }),
      /own network `hk-a` \(created\)/,
    );
    assert.match(
      describePlacement({ uuid: "u", network: "hk-a", source: "existing" }),
      /project's network `hk-a`/,
    );
  });

  console.log("\nproject-network — what reaches Coolify");

  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = `${url.pathname.replace(/^\/api\/v1/, "")}${url.search}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, body });
    const reply = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (path === "/servers/s/destinations" && method === "GET") {
      return reply([
        { uuid: "dest-shared", name: "localhost-coolify", network: "coolify", server_uuid: "s" },
        { name: "no uuid" },
      ]);
    }
    if (path === "/servers/s/destinations" && method === "POST")
      return reply({ uuid: "dest-new", network: "hk-tiao" });
    if (path === "/databases/d1")
      return reply({
        uuid: "d1",
        internal_db_url: "redis://x",
        destination: { uuid: "dest-shared", network: "coolify", id: 0 },
      });
    if (path === "/applications/a1")
      return reply({
        uuid: "a1",
        name: "tiao",
        destination: { network: "hk-tiao", server: { uuid: "s" } },
      });
    return reply({ uuid: "created" });
  }) as typeof fetch;
  try {
    const api = new CoolifyApi({ url: "https://coolify.test", token: "t" });

    await check("destinations are listed and created per server", async () => {
      assert.deepEqual(await api.listServerDestinations("s"), [
        { uuid: "dest-shared", name: "localhost-coolify", network: "coolify" },
      ]);
      assert.deepEqual(await api.createServerDestination("s", "hk-tiao", "hk-tiao"), {
        uuid: "dest-new",
        name: "hk-tiao",
        network: "hk-tiao",
      });
      assert.deepEqual(requests.at(-1), {
        method: "POST",
        path: "/servers/s/destinations",
        body: { network: "hk-tiao", name: "hk-tiao" },
      });
    });

    await check("an app's and a database's network are read from their records", async () => {
      assert.deepEqual((await api.getApplication("a1")).destination, { network: "hk-tiao" });
      assert.equal((await api.getApplication("a1")).serverUuid, "s");
      const db = await api.getDatabase("d1");
      assert.deepEqual(db.destination, { uuid: "dest-shared", network: "coolify" });
      assert.equal(db.internal_db_url, "redis://x");
    });

    await check("destination_uuid is sent on every create, and only when chosen", async () => {
      requests.length = 0;
      await api.createRedisDatabase({
        serverUuid: "s",
        projectUuid: "p",
        name: "tiao-redis",
        destinationUuid: "dest-new",
      });
      await api.createMongodbDatabase({ serverUuid: "s", projectUuid: "p", name: "tiao-mongo" });
      await api.createPostgresqlDatabase({
        serverUuid: "s",
        projectUuid: "p",
        name: "tiao-pg",
        destinationUuid: "dest-new",
      });
      await api.createDockerImageApplication({
        projectUuid: "p",
        serverUuid: "s",
        name: "tiao",
        image: { name: "ghcr.io/x/tiao", tag: "live" },
        portsExposes: "3000",
        domains: ["https://tiao.test"],
        healthCheck: { path: "/health" },
        destinationUuid: "dest-new",
      } as Parameters<CoolifyApi["createDockerImageApplication"]>[0]);
      await api.createApplicationFromPublicRepo({
        projectUuid: "p",
        serverUuid: "s",
        gitRepository: "https://github.com/x/tiao",
        name: "tiao",
        destinationUuid: "dest-new",
      });
      const sent = requests.map((r) => [
        r.path,
        (r.body as Record<string, unknown>).destination_uuid,
      ]);
      assert.deepEqual(sent, [
        ["/databases/redis", "dest-new"],
        ["/databases/mongodb", undefined],
        ["/databases/postgresql", "dest-new"],
        ["/applications/dockerimage", "dest-new"],
        ["/applications/public", "dest-new"],
      ]);
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nall project-network checks passed");
}

main();
