/**
 * `hatchkit sync` points DNS at the server the project's apps run on,
 * not at the first server Coolify lists.
 *
 * Run: `node scripts/test.mjs test-sync-dns-server.ts`
 */
import assert from "node:assert/strict";
import { projectServer } from "./src/deploy/sync.js";

const servers = [
  { id: 1, uuid: "ops-uuid", name: "ops-vps", ip: "100.64.0.2" },
  { id: 0, uuid: "app-uuid", name: "app-vps", ip: "host.docker.internal" },
];

function fakeApi(list: typeof servers, appServer: Record<string, string | undefined>) {
  return {
    listServers: async () => list,
    getApplication: async (uuid: string) => {
      if (!(uuid in appServer)) throw new Error("404");
      return { uuid, serverUuid: appServer[uuid] } as never;
    },
    findServer: async ({ ip }: { ip: string }) => {
      const s = list.find((x) => x.ip === ip);
      return s ? ({ uuid: s.uuid, name: s.name, ip: s.ip } as never) : null;
    },
  };
}

// The app runs on the second server Coolify lists.
assert.deepEqual(await projectServer(fakeApi(servers, { a1: "app-uuid" }), ["a1"]), {
  uuid: "app-uuid",
  ip: "host.docker.internal",
  name: "app-vps",
});

// An app Coolify cannot load is skipped; the next one decides.
assert.equal(
  (await projectServer(fakeApi(servers, { a2: "app-uuid" }), ["gone", "a2"])).name,
  "app-vps",
);

// One server: no question.
assert.equal((await projectServer(fakeApi([servers[1]!], {}), [])).uuid, "app-uuid");

// Several servers and no app to read: refuse instead of taking the first.
await assert.rejects(
  projectServer(fakeApi(servers, {}), []),
  /cannot tell which of 2 Coolify servers/,
);

console.log("  ✓ sync DNS follows the project's own server");
