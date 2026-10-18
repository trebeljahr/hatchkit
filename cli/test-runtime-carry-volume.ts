/**
 * `hatchkit migrate-runtime --carry-volume` — moving a compose app whose
 * state is a named Docker volume.
 *
 * The replacement mounts the SAME volume by name; nothing is copied. So
 * every way this can go wrong is a way to lose or fork production data,
 * and each has an assertion here:
 *
 *   · without the flag the move is still refused;
 *   · the Docker volume name is derived AND confirmed against Coolify's
 *     own record — a wrong name does not fail, it mounts an empty volume;
 *   · the storage is on the new app, read back, before its first deploy;
 *   · `--same-json` stops a replacement that reads other data before it
 *     has a public route;
 *   · rollback and cleanup delete one app while the other serves from the
 *     volume, so every DELETE must carry `delete_volumes=false`.
 *
 * Provider-free: Coolify is a fake `fetch` or a fake client throughout.
 *
 * Run: `pnpm --filter hatchkit run test:runtime-carry-volume`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SourceRow, readsOnlyCarriedVolumes } from "./src/backups/sources.js";
import {
  type EnvRow,
  type LiveComposeApp,
  type RuntimeMigrationPlan,
  composeDockerVolumeName,
  interpolate,
  planRuntimeMigration,
} from "./src/deploy/migrate-runtime-plan.js";
import {
  type MigrateRuntimeOptions,
  type MigrationLedger,
  attachCarriedVolumes,
  cleanup,
  jsonField,
  migrate,
  rollback,
  runMigrateRuntimeCli,
  splitBackupReaders,
} from "./src/deploy/migrate-runtime.js";
import { CoolifyApi, type CoolifyPersistentStorage } from "./src/utils/coolify-api.js";

const failures: string[] = [];
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "hatchkit-carry-"));
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

// The first consumer's shape: one service, one named volume, `:?` guards.
const COMPOSE = `services:
  client:
    image: \${CLIENT_IMAGE:-ghcr.io/test/site:main}
    volumes:
      - auth-data:/app/data
    environment:
      PORT: "6657"
      AUTH_DB_PATH: /app/data/auth.db
      BETTER_AUTH_SECRET: \${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET must be configured in Coolify}
      SMTP_HOST: \${SMTP_HOST:-}
volumes:
  auth-data:
`;
const UUID = "bwmqy47daye8znhfspycftmi";
const DOCKER_VOLUME = `${UUID}_auth-data`;
const env = (key: string, value: string): EnvRow => ({
  key,
  value,
  isPreview: false,
  isLiteral: false,
  isMultiline: false,
});
const ENV = [env("CLIENT_IMAGE", "ghcr.io/test/site:abc123"), env("BETTER_AUTH_SECRET", "s3cr3t")];
const live = (extra: Partial<LiveComposeApp> = {}): LiveComposeApp => ({
  uuid: UUID,
  name: "site",
  buildPack: "dockercompose",
  composeRaw: COMPOSE,
  composeDomains: [{ name: "client", domain: "https://site.example" }],
  persistentStorages: [{ name: DOCKER_VOLUME, mountPath: "/app/data" }],
  ...extra,
});
const CARRY = {
  carryVolumes: { client: ["auth-data"] },
  healthPaths: { client: "/api/health" },
  sameJson: { client: [{ path: "/api/health", field: "databaseId" }] },
};

try {
  // -------------------------------------------------------------------------
  console.log("\ncarry-volume — plan");

  await check("without the flag a volume still blocks the move", () => {
    const plan = planRuntimeMigration(live(), ENV, { healthPaths: CARRY.healthPaths });
    assert.equal(plan.apps.length, 0);
    assert.equal(plan.blockers.length, 1);
    assert.match(
      plan.blockers[0],
      /service "client" mounts volumes \(\["auth-data:\/app\/data"\]\)/,
    );
    assert.match(plan.blockers[0], /would not follow a replacement app/);
    // …and names the way through, with its condition.
    assert.match(plan.blockers[0], /two containers writing.*--carry-volume client=auth-data/);
  });

  await check("with the flag the plan records the Docker volume and mount path", () => {
    const plan = planRuntimeMigration(live(), ENV, CARRY);
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(plan.apps[0].carriedVolumes, [
      { volume: "auth-data", dockerVolume: DOCKER_VOLUME, mountPath: "/app/data" },
    ]);
    assert.equal(plan.apps[0].port, 6657);
    assert.equal(plan.apps[0].healthCheck.path, "/api/health");
    assert.deepEqual(plan.apps[0].sameJson, [
      {
        path: "/api/health",
        field: "databaseId",
        publicUrl: "https://site.example/api/health",
      },
    ]);
  });

  await check(
    "the plan warns that two containers write the volume, now and on every deploy",
    () => {
      const plan = planRuntimeMigration(live(), ENV, CARRY);
      const warning = plan.warnings.find((w) => w.includes(DOCKER_VOLUME)) ?? "";
      assert.match(warning, /Two containers write it during verification/);
      assert.match(warning, /every later rolling deploy/);
      assert.ok(!plan.warnings.some((w) => /--same-json/.test(w)), "a check was requested");
      const unchecked = planRuntimeMigration(live(), ENV, { ...CARRY, sameJson: {} });
      assert.ok(
        unchecked.warnings.some((w) => /nothing compares.*--same-json client=/.test(w)),
        "carrying without a data comparison is called out",
      );
    },
  );

  await check("the Docker volume name must match Coolify's own record", () => {
    const unread = planRuntimeMigration(live({ persistentStorages: undefined }), ENV, CARRY);
    assert.match(unread.blockers.join(" "), /did not report this app's storages/);
    const other = planRuntimeMigration(
      live({ persistentStorages: [{ name: "something-else", mountPath: "/app/data" }] }),
      ENV,
      CARRY,
    );
    assert.match(other.blockers.join(" "), new RegExp(`records no volume ${DOCKER_VOLUME}`));
    assert.match(other.blockers.join(" "), /empty volume/);
    const elsewhere = planRuntimeMigration(
      live({ persistentStorages: [{ name: DOCKER_VOLUME, mountPath: "/data" }] }),
      ENV,
      CARRY,
    );
    assert.match(elsewhere.blockers.join(" "), /records .* at \/data, the compose file mounts/);
    for (const plan of [unread, other, elsewhere]) assert.equal(plan.apps.length, 0);
  });

  await check("Coolify's slug is applied to the compose volume name", () => {
    assert.equal(composeDockerVolumeName("u1", "auth_data"), "u1_auth-data");
    assert.equal(composeDockerVolumeName("u1", "Auth.Data"), "u1_authdata");
    const plan = planRuntimeMigration(
      live({
        composeRaw: COMPOSE.replaceAll("auth-data", "auth_data"),
        persistentStorages: [{ name: DOCKER_VOLUME, mountPath: "/app/data" }],
      }),
      ENV,
      { ...CARRY, carryVolumes: { client: ["auth_data"] } },
    );
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.apps[0].carriedVolumes?.[0].dockerVolume, DOCKER_VOLUME);
  });

  await check("only a plain, writable, named volume can be carried", () => {
    const withVolumes = (volumes: string, top = "  auth-data:\n") =>
      planRuntimeMigration(
        live({
          composeRaw: `services:\n  client:\n    image: ghcr.io/test/site:abc\n    expose: ['80']\n    volumes:\n${volumes}volumes:\n${top}`,
        }),
        [],
        { carryVolumes: { client: ["auth-data"] } },
      );
    assert.deepEqual(
      withVolumes("      - { type: volume, source: auth-data, target: /app/data }\n").blockers,
      [],
      "long syntax",
    );
    for (const [volumes, top, reason] of [
      ["      - auth-data:/app/data:ro\n", undefined, /read-only/],
      ["      - ./data:/app/data\n", undefined, /mounts no named volume "auth-data"/],
      ["      - /srv/data:/app/data\n", undefined, /mounts volumes/],
      [
        "      - auth-data:/app/data\n      - uploads:/app/uploads\n",
        undefined,
        /mounts volumes.*--carry-volume client=uploads/,
      ],
      ["      - auth-data:/app/data\n", "  auth-data:\n    external: true\n", /sets external/],
      ["      - auth-data:/app/data\n", "  auth-data:\n    name: shared\n", /sets name/],
      [
        "      - { type: volume, source: auth-data, target: /app/data, volume: { nocopy: true } }\n",
        undefined,
        /mounts volumes/,
      ],
    ] as const) {
      const plan = withVolumes(volumes, top);
      assert.equal(plan.apps.length, 0, volumes);
      assert.match(plan.blockers.join(" "), reason, volumes);
    }
  });

  await check("the flags must name real services, volumes and routed paths", () => {
    const unknown = planRuntimeMigration(live(), ENV, {
      carryVolumes: { client: ["auth-data"], worker: ["x"] },
      sameJson: { api: [{ path: "/health", field: "id" }] },
    });
    assert.match(unknown.blockers.join(" "), /--carry-volume names unknown service "worker"/);
    assert.match(unknown.blockers.join(" "), /--same-json names unknown service "api"/);
    const missing = planRuntimeMigration(live(), ENV, { carryVolumes: { client: ["uploads"] } });
    assert.match(missing.blockers.join(" "), /mounts no named volume "uploads"/);
    const unrouted = planRuntimeMigration(
      live({ composeDomains: [{ name: "client", domain: "https://site.example/app" }] }),
      ENV,
      CARRY,
    );
    assert.match(unrouted.blockers.join(" "), /no public route .* covers \/api\/health/);
  });

  await check("`${VAR:?…}` resolves to the value, never to its own text", () => {
    const plan = planRuntimeMigration(live(), ENV, CARRY);
    const copied = Object.fromEntries(plan.apps[0].env.map((e) => [e.key, e.value]));
    assert.equal(copied.BETTER_AUTH_SECRET, "s3cr3t");
    assert.equal(copied.SMTP_HOST, "");
    assert.ok(!plan.apps[0].env.some((e) => e.value.includes("${")));
    const map = new Map([
      ["A", "1"],
      ["EMPTY", ""],
    ]);
    assert.deepEqual(interpolate("${A:?x}|${A?x}|${A:+set}|${EMPTY:+set}|${EMPTY+set}", map), {
      value: "1|1|set||set",
      missing: [],
      required: [],
    });
    assert.deepEqual(interpolate("${EMPTY:?x}${NONE?x}${EMPTY?x}", map).required, [
      "EMPTY",
      "NONE",
    ]);
    const unset = planRuntimeMigration(live(), [ENV[0]], CARRY);
    assert.equal(unset.apps.length, 0);
    assert.match(unset.blockers.join(" "), /BETTER_AUTH_SECRET is required by the compose file/);
  });

  // -------------------------------------------------------------------------
  console.log("\ncarry-volume — storage on the new app");

  const VOLUME = { volume: "auth-data", dockerVolume: DOCKER_VOLUME, mountPath: "/app/data" };
  /** A Coolify that holds one new app's storages. */
  function storageApi(
    settings: {
      /** POST …/storages exists (later than 4.0.0-beta.469). */
      post?: boolean;
      /** What the operator adds in the dashboard once asked. */
      operator?: Partial<CoolifyPersistentStorage> | false;
      /** PATCH answers 200 and changes nothing. */
      patchIgnored?: boolean;
      rows?: CoolifyPersistentStorage[];
    } = {},
  ) {
    const rows: CoolifyPersistentStorage[] = [...(settings.rows ?? [])];
    const patches: Array<{ id: number; name?: string; mountPath?: string }> = [];
    let asked = false;
    return {
      rows,
      patches,
      api: {
        async listApplicationStorages() {
          return { persistent: structuredClone(rows), fileCount: 0 };
        },
        async createPersistentStorage(uuid: string, s: { name: string; mountPath: string }) {
          if (!settings.post) {
            asked = true;
            return "unsupported" as const;
          }
          rows.push({ id: 11, name: `${uuid}-${s.name}`, mountPath: s.mountPath, hostPath: null });
          return "created" as const;
        },
        async updatePersistentStorage(
          _uuid: string,
          s: { id: number; name?: string; mountPath?: string },
        ) {
          patches.push(s);
          if (settings.patchIgnored) return;
          const row = rows.find((r) => r.id === s.id);
          if (row && s.name !== undefined) row.name = s.name;
          if (row && s.mountPath !== undefined) row.mountPath = s.mountPath;
        },
      },
      /** Polls once; the operator acts between the request and the poll. */
      async waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean) {
        if (asked && settings.operator !== false && !rows.some((r) => r.id === 7)) {
          rows.push({
            id: 7,
            // The dashboard names a volume `<app uuid>-<name>`.
            name: "new1-auth-data",
            mountPath: "/app/data",
            hostPath: null,
            ...settings.operator,
          });
        }
        const value = await read();
        return done(value) ? value : null;
      },
    };
  }
  const attach = (f: ReturnType<typeof storageApi>, lines: string[] = []) =>
    attachCarriedVolumes(f.api, { uuid: "new1", name: "site" }, [VOLUME], {
      waitFor: f.waitFor as never,
      dashboardUrl:
        "https://coolify.example/project/p/environment/e/application/new1/persistent-storage",
      log: (line) => lines.push(line),
    });

  await check("4.0.0-beta.469: operator adds the row, it is renamed and read back", async () => {
    const f = storageApi();
    const lines: string[] = [];
    assert.equal(await attach(f, lines), null);
    assert.deepEqual(f.patches, [{ id: 7, name: DOCKER_VOLUME, mountPath: "/app/data" }]);
    assert.deepEqual(f.rows, [
      { id: 7, name: DOCKER_VOLUME, mountPath: "/app/data", hostPath: null },
    ]);
    const said = lines.join("\n");
    assert.match(said, /application\/new1\/persistent-storage/);
    assert.match(
      said,
      /Volume Mount\s+Name: auth-data\s+Source Path: leave empty\s+Destination Path: \/app\/data/,
    );
    assert.match(said, /Do not deploy/);
  });

  await check("a Coolify with POST creates the row itself, then renames it", async () => {
    const f = storageApi({ post: true });
    const lines: string[] = [];
    assert.equal(await attach(f, lines), null);
    assert.deepEqual(f.patches, [{ id: 11, name: DOCKER_VOLUME, mountPath: "/app/data" }]);
    assert.equal(lines.length, 0, "no operator step is asked for");
  });

  await check("a row that is already right is left alone (re-run)", async () => {
    const f = storageApi({
      rows: [{ id: 3, name: DOCKER_VOLUME, mountPath: "/app/data", hostPath: null }],
    });
    assert.equal(await attach(f), null);
    assert.deepEqual(f.patches, []);
  });

  await check("any difference on read-back stops the run", async () => {
    assert.match(
      (await attach(storageApi({ operator: false }))) ?? "",
      /no storage at \/app\/data/,
    );
    const ignored = storageApi({ patchIgnored: true });
    assert.match(
      (await attach(ignored)) ?? "",
      new RegExp(
        `would mount \\[new1-auth-data:/app/data\\].*expected \\[${DOCKER_VOLUME}:/app/data\\]`,
      ),
    );
    const bind = storageApi({ operator: { hostPath: "/srv/data" } });
    assert.match((await attach(bind)) ?? "", /source path \(\/srv\/data\).*bind mount/);
    assert.deepEqual(bind.patches, [], "a bind mount is never renamed into place");
    const extra = storageApi({
      rows: [{ id: 2, name: "new1-cache", mountPath: "/cache", hostPath: null }],
    });
    assert.match((await attach(extra)) ?? "", /would mount \[new1-cache:\/cache, /);
    const twice = storageApi({
      rows: [
        { id: 2, name: "a", mountPath: "/app/data", hostPath: null },
        { id: 3, name: "b", mountPath: "/app/data/", hostPath: null },
      ],
    });
    assert.match((await attach(twice)) ?? "", /has 2 storages at \/app\/data/);
  });

  await check("a mount path typed with a trailing slash is corrected, not duplicated", async () => {
    const f = storageApi({ operator: { mountPath: "/app/data/" } });
    assert.equal(await attach(f), null);
    assert.equal(f.rows[0].mountPath, "/app/data");
  });

  /** A `fetch` standing in for Coolify's HTTP API. */
  function coolifyHttp(
    respond: (method: string, path: string, body: unknown) => Response | undefined,
  ) {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const path = `${url.pathname.replace(/^\/api\/v1/, "")}${url.search}`;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, path, body });
      return respond(method, path, body) ?? json({});
    };
    return { requests, fetch: impl as unknown as typeof fetch };
  }
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  async function withCoolify<T>(
    http: ReturnType<typeof coolifyHttp>,
    fn: (api: CoolifyApi) => Promise<T>,
  ): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = http.fetch;
    try {
      return await fn(new CoolifyApi({ url: "https://coolify.example", token: "t" }));
    } finally {
      globalThis.fetch = original;
    }
  }

  await check("the HTTP calls are the ones Coolify 4.0.0-beta.469 accepts", async () => {
    const http = coolifyHttp((method) =>
      method === "GET"
        ? json({
            persistent_storages: [
              { id: 7, name: "new1-auth-data", mount_path: "/app/data", host_path: null },
              { id: 8, name: "new1-bind", mount_path: "/x", host_path: "/srv/x" },
            ],
            file_storages: [{ id: 1 }],
          })
        : method === "POST"
          ? json({ message: "Not found." }, 404)
          : undefined,
    );
    await withCoolify(http, async (api) => {
      assert.deepEqual(await api.listApplicationStorages("new1"), {
        persistent: [
          { id: 7, name: "new1-auth-data", mountPath: "/app/data", hostPath: null },
          { id: 8, name: "new1-bind", mountPath: "/x", hostPath: "/srv/x" },
        ],
        fileCount: 1,
      });
      assert.equal(
        await api.createPersistentStorage("new1", { name: "auth-data", mountPath: "/app/data" }),
        "unsupported",
      );
      await api.updatePersistentStorage("new1", {
        id: 7,
        name: DOCKER_VOLUME,
        mountPath: "/app/data",
      });
    });
    assert.deepEqual(
      http.requests.map((r) => `${r.method} ${r.path}`),
      [
        "GET /applications/new1/storages",
        "POST /applications/new1/storages",
        "PATCH /applications/new1/storages",
      ],
    );
    // `id` + `type` are required; `host_path` is refused by later builds.
    assert.deepEqual(http.requests[2].body, {
      id: 7,
      type: "persistent",
      name: DOCKER_VOLUME,
      mount_path: "/app/data",
    });
    assert.deepEqual(http.requests[1].body, {
      type: "persistent",
      name: "auth-data",
      mount_path: "/app/data",
    });
  });

  await check("POST: 405 is also 'no such route', 201 is created, 422 is an error", async () => {
    for (const [status, expected] of [
      [405, "unsupported"],
      [201, "created"],
    ] as const) {
      const http = coolifyHttp(() => json({}, status));
      assert.equal(
        await withCoolify(http, (api) =>
          api.createPersistentStorage("new1", { name: "auth-data", mountPath: "/app/data" }),
        ),
        expected,
      );
    }
    await assert.rejects(
      withCoolify(
        coolifyHttp(() => json({ message: "Validation failed." }, 422)),
        (api) => api.createPersistentStorage("new1", { name: "a", mountPath: "/a" }),
      ),
      /422/,
    );
  });

  // -------------------------------------------------------------------------
  console.log("\ncarry-volume — cutover");

  const options: MigrateRuntimeOptions = {
    targets: ["site"],
    projectDir: dir,
    action: "migrate",
    dryRun: false,
    yes: true,
    healthPaths: {},
    noSecrets: true,
    keepLiveTag: true,
  };
  const carryPlan = (): RuntimeMigrationPlan =>
    planRuntimeMigration(
      live({
        uuid: "old",
        persistentStorages: [{ name: "old_auth-data", mountPath: "/app/data" }],
      }),
      ENV,
      CARRY,
    );

  /** One compose app `old` and whatever `migrate` creates beside it. The
   *  replacement reports production's database only when the carried
   *  volume was on it at the moment its container was created. */
  function cutover(
    settings: {
      patchIgnored?: boolean;
      /** Production's health body before the run. */
      production?: unknown;
      /** The replacement's answer once it serves the public URL. */
      afterCutover?: unknown;
    } = {},
  ) {
    const calls: string[] = [];
    const states = new Map([["old", "running:healthy"]]);
    const names = new Map([["old", "site"]]);
    const configured = new Map<string, string[]>();
    const storages: CoolifyPersistentStorage[] = [];
    let replacementSees: string | undefined;
    let asked = false;
    let ledger: MigrationLedger | undefined;
    const api = {
      async getApplication(uuid: string) {
        return {
          uuid,
          name: names.get(uuid) ?? uuid,
          environmentId: 1,
          serverUuid: "host",
          gitRepository: "test/site",
          status: states.get(uuid),
          isAutoDeployEnabled: false,
        };
      },
      async listProjectsWithEnvironments() {
        return [{ uuid: "project", environments: [{ id: 1, uuid: "env", name: "production" }] }];
      },
      async listServers() {
        return [{ uuid: "host", ip: "192.0.2.1" }];
      },
      async createDockerImageApplication(input: { domains: string[] }) {
        configured.set("new1", [...input.domains]);
        calls.push("create:new1");
        return { uuid: "new1" };
      },
      async setAppEnvRows(uuid: string) {
        calls.push(`env:${uuid}`);
      },
      async updateApplication(uuid: string, fields: { name?: string; domains?: string[] }) {
        if (fields.name) {
          names.set(uuid, fields.name);
          calls.push(`rename:${uuid}:${fields.name}`);
        }
        if (fields.domains) {
          configured.set(uuid, [...fields.domains]);
          calls.push(
            `routes:${uuid}:${fields.domains.some((d) => d.includes("site.example")) ? "public" : "private"}`,
          );
        }
        return { droppedFields: [] };
      },
      async stopApplication(uuid: string) {
        calls.push(`stop:${uuid}`);
        states.set(uuid, "exited");
      },
      async deleteApplicationKeepingVolumes(uuid: string) {
        calls.push(`delete:${uuid}`);
        return "deleted";
      },
      async listApplicationStorages() {
        return { persistent: structuredClone(storages), fileCount: 0 };
      },
      async createPersistentStorage() {
        asked = true;
        return "unsupported" as const;
      },
      async updatePersistentStorage(_uuid: string, s: { id: number; name?: string }) {
        calls.push(`storage:${s.name}`);
        const row = storages.find((r) => r.id === s.id);
        if (row && s.name && !settings.patchIgnored) row.name = s.name;
      },
    } as unknown as CoolifyApi;
    const production =
      "production" in settings ? settings.production : { status: "ok", databaseId: "db-1" };
    const deps = {
      async discoverPublicIps() {
        return { v4: "192.0.2.1" };
      },
      saveLedger(value: MigrationLedger) {
        ledger = structuredClone(value);
        calls.push(`ledger:${value.phase}`);
      },
      async probeStatus() {
        return 200;
      },
      async probeViaHost(_ip: string, host: string) {
        return configured.get("new1")?.includes(`http://${host}`) ? 200 : 404;
      },
      async deployAndWait(_api: unknown, uuid: string) {
        calls.push(`deploy:${uuid}`);
        states.set(uuid, "running:healthy");
        if (uuid === "new1") {
          replacementSees = storages.some((r) => (r.hostPath ?? r.name) === "old_auth-data")
            ? "db-1"
            : "db-of-an-empty-volume";
        }
        return "finished";
      },
      async waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean) {
        if (asked && storages.length === 0) {
          storages.push({ id: 7, name: "new1-auth-data", mountPath: "/app/data", hostPath: null });
        }
        const value = await read();
        return done(value) ? value : null;
      },
      async readJson() {
        return states.get("old") === "exited"
          ? (settings.afterCutover ?? { status: "ok", databaseId: replacementSees })
          : production;
      },
      async readJsonViaHost() {
        return { status: "ok", databaseId: replacementSees };
      },
    };
    return { api, deps, calls, storages, ledger: () => ledger };
  }
  const run = (f: ReturnType<typeof cutover>, plan = carryPlan()) =>
    quiet(() => migrate(f.api, "https://coolify.example", plan, options, f.deps));

  await check("the volume is on the new app before its first deploy, and recorded", async () => {
    const f = cutover();
    assert.equal(await run(f), true);
    assert.ok(f.calls.includes("storage:old_auth-data"));
    assert.ok(
      f.calls.indexOf("storage:old_auth-data") < f.calls.indexOf("deploy:new1"),
      "storage precedes the first container",
    );
    assert.ok(f.calls.indexOf("create:new1") < f.calls.indexOf("storage:old_auth-data"));
    assert.deepEqual(f.ledger()?.apps[0].carriedVolumes, [
      { volume: "auth-data", dockerVolume: "old_auth-data", mountPath: "/app/data" },
    ]);
    assert.equal(f.ledger()?.phase, "cut-over");
    assert.ok(f.calls.indexOf("routes:new1:public") < f.calls.indexOf("stop:old"));
  });

  await check("a storage that does not read back stops before any deploy", async () => {
    const f = cutover({ patchIgnored: true });
    assert.equal(await run(f), false);
    assert.ok(!f.calls.includes("deploy:new1"), "nothing started on the wrong mount");
    assert.ok(!f.calls.includes("stop:old"));
    assert.ok(f.calls.includes("rename:old:site"), "the compose app has its name back");
  });

  await check(
    "--same-json: different data stops the run with the compose app untouched",
    async () => {
      // The replacement comes up healthy on an empty volume: the plan was
      // made without the carry, so nothing mounts production's data.
      const plan = carryPlan();
      plan.apps[0].carriedVolumes = undefined;
      const f = cutover();
      assert.equal(await run(f, plan), false);
      assert.ok(f.calls.includes("deploy:new1"), "it deployed, healthy, on the private host");
      assert.ok(!f.calls.includes("routes:new1:public"), "it never got a public route");
      assert.ok(!f.calls.includes("stop:old"), "the compose app keeps serving");
      assert.ok(f.calls.includes("stop:new1"));
      assert.ok(f.calls.includes("rename:old:site"));
      assert.equal(f.ledger()?.phase, "prepared");
    },
  );

  await check(
    "--same-json: a field production does not report stops before any change",
    async () => {
      for (const production of [{ status: "ok" }, { databaseId: "" }, { databaseId: {} }, null]) {
        const f = cutover({ production });
        assert.equal(await run(f), false);
        assert.deepEqual(f.calls, [], JSON.stringify(production));
      }
    },
  );

  await check("--same-json: the public URL is asked again after the cutover", async () => {
    const f = cutover({ afterCutover: { status: "ok", databaseId: "db-2" } });
    assert.equal(await run(f), false);
    assert.equal(f.ledger()?.phase, "cutting-over", "not eligible for --cleanup");
  });

  await check("jsonField reads scalars by dot path and nothing else", () => {
    assert.equal(jsonField({ databaseId: "db-1" }, "databaseId"), '"db-1"');
    assert.equal(jsonField({ db: { id: 4 } }, "db.id"), "4");
    assert.notEqual(jsonField({ id: "1" }, "id"), jsonField({ id: 1 }, "id"));
    for (const body of [null, "x", [], { databaseId: null }, { databaseId: [1] }, {}])
      assert.equal(jsonField(body, "databaseId"), undefined);
  });

  await check("the flags are parsed strictly", async () => {
    for (const args of [
      ["--carry-volume"],
      ["--carry-volume", "client"],
      ["--carry-volume", "client=./data"],
      ["--carry-volume", "client=a", "--carry-volume", "client=a"],
      ["--carry-volume", "client=auth-data", "--rollback"],
      ["--same-json"],
      ["--same-json", "client=/api/health"],
      ["--same-json", "client=api/health:databaseId"],
      ["--same-json", "client=/api/health:databaseId", "--cleanup"],
    ])
      await assert.rejects(
        runMigrateRuntimeCli(args),
        /--carry-volume|--same-json/,
        args.join(" "),
      );
  });

  // -------------------------------------------------------------------------
  console.log("\ncarry-volume — backups");

  const filesInVolume: SourceRow = {
    project: "site",
    source: "auth-db",
    kind: "files",
    state: "ok",
    paths: [`/var/lib/docker/volumes/${DOCKER_VOLUME}/_data`],
  };
  const container: SourceRow = {
    project: "site",
    source: "app-postgres",
    kind: "postgres",
    state: "ok",
    selector: { project: UUID, service: "postgres" },
  };
  const filesElsewhere: SourceRow = {
    ...filesInVolume,
    source: "config",
    paths: [`/var/lib/docker/volumes/${DOCKER_VOLUME}/_data`, `/data/coolify/applications/${UUID}`],
  };

  await check("a files source inside the carried volume passes; every other reader blocks", () => {
    const plan = planRuntimeMigration(live(), ENV, CARRY);
    const rows = [filesInVolume, container, filesElsewhere];
    assert.deepEqual(splitBackupReaders(rows, plan, readsOnlyCarriedVolumes), {
      following: [filesInVolume],
      blocking: [container, filesElsewhere],
    });
    // No carry, no exception.
    const bare = { ...plan, apps: plan.apps.map((a) => ({ ...a, carriedVolumes: undefined })) };
    assert.equal(splitBackupReaders(rows, bare, readsOnlyCarriedVolumes).following.length, 0);
    assert.equal(readsOnlyCarriedVolumes(filesInVolume, [`${DOCKER_VOLUME}-other`]), false);
    assert.equal(
      readsOnlyCarriedVolumes(
        { ...filesInVolume, paths: [`/mnt/docker/volumes/${DOCKER_VOLUME}`] },
        [DOCKER_VOLUME],
      ),
      true,
      "a relocated Docker data root",
    );
    assert.equal(readsOnlyCarriedVolumes({ ...filesInVolume, paths: [] }, [DOCKER_VOLUME]), false);
  });

  // -------------------------------------------------------------------------
  console.log("\ncarry-volume — rollback and cleanup keep the volume");

  const KEEP = /[?&]delete_volumes=false(?:&|$)/;
  const ledgerFor = (phase: MigrationLedger["phase"]): MigrationLedger => ({
    version: 1,
    source: { uuid: "old", name: "site", legacyName: "site-legacy-compose" },
    apps: [
      {
        uuid: "new1",
        name: "site",
        service: "client",
        steadyTag: "main",
        carriedVolumes: [
          { volume: "auth-data", dockerVolume: "old_auth-data", mountPath: "/app/data" },
        ],
      },
    ],
    secrets: [],
    phase,
    updatedAt: "",
    publicBaseline: [["https://site.example/api/health", 200]],
  });
  /** Coolify over HTTP, with the app statuses the two paths wait for. */
  function retiring(statuses: Record<string, string>) {
    const status = new Map(Object.entries(statuses));
    const http = coolifyHttp((method, path) => {
      const app = path.match(/^\/applications\/([^/?]+)/)?.[1] ?? "";
      if (method === "POST" && /\/stop\?/.test(path)) status.set(app, "exited");
      if (method === "GET" && path === `/applications/${app}`)
        return json({ uuid: app, name: app, status: status.get(app) });
      return undefined;
    });
    const deps = {
      saveLedger() {},
      async probeStatus() {
        return 200;
      },
      async deployAndWait(_api: unknown, uuid: string) {
        status.set(uuid, "running:healthy");
        return "finished";
      },
      async waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean) {
        const value = await read();
        return done(value) ? value : null;
      },
    };
    return { http, deps };
  }
  const deletes = (http: ReturnType<typeof coolifyHttp>) =>
    http.requests.filter((r) => r.method === "DELETE").map((r) => r.path);

  await check("rollback deletes the replacement with delete_volumes=false", async () => {
    for (const phase of ["cut-over", "cutting-over", "prepared"] as const) {
      const f = retiring({ old: "exited", new1: "running:healthy" });
      const ok = await withCoolify(f.http, (api) =>
        quiet(() => rollback(api, ledgerFor(phase), { ...options, action: "rollback" }, f.deps)),
      );
      assert.equal(ok, true, phase);
      const removed = deletes(f.http);
      assert.equal(removed.length, 1, phase);
      assert.match(removed[0], /^\/applications\/new1\?/);
      assert.match(removed[0], KEEP, `${phase}: ${removed[0]}`);
    }
  });

  await check("cleanup deletes the compose app with delete_volumes=false", async () => {
    const f = retiring({ old: "exited", new1: "running:healthy" });
    const ok = await withCoolify(f.http, (api) =>
      quiet(() => cleanup(api, ledgerFor("cut-over"), { ...options, action: "cleanup" })),
    );
    assert.equal(ok, true);
    const removed = deletes(f.http);
    assert.equal(removed.length, 1);
    assert.match(removed[0], /^\/applications\/old\?/);
    assert.match(removed[0], KEEP, removed[0]);
  });

  await check("the guard above would catch the plain delete", async () => {
    // Coolify defaults delete_volumes to true; this is the call that
    // must never appear in either path.
    const http = coolifyHttp(() => undefined);
    await withCoolify(http, (api) => api.deleteApplication("new1"));
    assert.doesNotMatch(deletes(http)[0], KEEP);
    const source = readFileSync(
      new URL("./src/deploy/migrate-runtime.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /\.deleteApplication\(/,
      "migrate-runtime.ts uses the plain delete",
    );
    assert.doesNotMatch(source, /delete_volumes=/, "migrate-runtime.ts builds its own delete URL");
    assert.equal(
      [...source.matchAll(/\.deleteApplicationKeepingVolumes\(/g)].length,
      2,
      "one delete in rollback, one in cleanup — review any new one against a carried volume",
    );
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nAll carry-volume assertions passed.");
