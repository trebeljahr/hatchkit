/** Provider-free regression coverage for migration ordering and recovery. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RuntimeMigrationPlan,
  planRuntimeMigration,
} from "./src/deploy/migrate-runtime-plan.js";
import {
  type MigrateRuntimeOptions,
  type MigrationLedger,
  deployAndWait,
  migrate,
  migrationDeployRole,
  migrationProbeMatchesBaseline,
  publicProbeUrls,
  rollback,
  runMigrateRuntimeCli,
  setManifestRuntime,
} from "./src/deploy/migrate-runtime.js";
import type { CoolifyApi } from "./src/utils/coolify-api.js";

const dir = mkdtempSync(join(tmpdir(), "hatchkit-cutover-"));
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
const basePlan = (): RuntimeMigrationPlan =>
  planRuntimeMigration(
    {
      uuid: "old",
      name: "site",
      buildPack: "dockercompose",
      composeRaw: "services:\n  app:\n    image: ghcr.io/test/site:abc123\n    expose: ['80']\n",
      composeDomains: [{ name: "app", domain: "https://site.example" }],
    },
    [],
  );

function fixture(
  settings: {
    activationFails?: boolean;
    activationRetainsOld?: boolean;
    publicAfter?: number;
    missingPrefixSetting?: boolean;
    stopStuck?: boolean;
    gitCommitSha?: string;
    sourceDrifts?: boolean;
    /** Legacy auto-deploy as getApplication reports it; null = absent. */
    autoDeploy?: boolean | null;
  } = {},
) {
  const calls: string[] = [];
  const configured = new Map<string, string[]>();
  const deployed = new Map<string, string[]>();
  const states = new Map([["old", "running:healthy"]]);
  let ledger: MigrationLedger | undefined;
  let seq = 0;
  const api = {
    async getApplication(uuid: string) {
      return {
        uuid,
        name: uuid === "old" ? "site" : uuid,
        environmentId: 1,
        serverUuid: "host",
        gitRepository: "test/site",
        gitCommitSha:
          settings.sourceDrifts && calls.includes("deploy:new1")
            ? "d".repeat(40)
            : (settings.gitCommitSha ?? "c".repeat(40)),
        status: states.get(uuid),
        isAutoDeployEnabled:
          uuid === "old" && settings.autoDeploy !== undefined
            ? (settings.autoDeploy ?? undefined)
            : false,
      };
    },
    async listProjectsWithEnvironments() {
      return [{ uuid: "project", environments: [{ id: 1, uuid: "env", name: "production" }] }];
    },
    async listServers() {
      return [{ uuid: "host", ip: "192.0.2.1" }];
    },
    async createDockerImageApplication(input: { domains: string[] }) {
      const uuid = `new${++seq}`;
      configured.set(uuid, [...input.domains]);
      calls.push(`create:${uuid}`);
      return { uuid };
    },
    async setAppEnvRows(uuid: string) {
      calls.push(`env:${uuid}`);
    },
    async updateApplication(
      uuid: string,
      fields: { domains?: string[]; isStripprefixEnabled?: boolean; isAutoDeployEnabled?: boolean },
    ) {
      if (fields.isAutoDeployEnabled !== undefined)
        calls.push(`autodeploy:${uuid}:${fields.isAutoDeployEnabled}`);
      if (fields.domains) {
        configured.set(uuid, [...fields.domains]);
        calls.push(`routes:${uuid}`);
      }
      if (fields.isStripprefixEnabled !== undefined) calls.push(`prefix:${uuid}`);
      return {
        droppedFields:
          settings.missingPrefixSetting && fields.isStripprefixEnabled !== undefined
            ? ["is_stripprefix_enabled"]
            : [],
      };
    },
    async stopApplication(uuid: string) {
      calls.push(`stop:${uuid}`);
      if (!(settings.stopStuck && uuid === "old")) states.set(uuid, "exited");
      if (uuid === "old") {
        for (const [id, domains] of configured) {
          assert.deepEqual(
            deployed.get(id),
            domains,
            "all configured public routes must have reached containers before legacy stops",
          );
          assert.ok(
            domains.some((d) => d.includes("site.example")),
            "replacement must have public routes",
          );
        }
      }
    },
    async deleteApplicationKeepingVolumes(uuid: string) {
      calls.push(`delete:${uuid}`);
      return "deleted";
    },
  } as unknown as CoolifyApi;
  const deps = {
    async discoverPublicIps() {
      return { v4: "192.0.2.1" };
    },
    saveLedger(value: MigrationLedger) {
      ledger = structuredClone(value);
      calls.push(`ledger:${value.phase}`);
    },
    async probeStatus() {
      return states.get("old") === "exited" ? (settings.publicAfter ?? 200) : 200;
    },
    async probeViaHost(_ip: string, host: string) {
      return [...deployed].some(
        ([uuid, domains]) =>
          states.get(uuid)?.startsWith("running") && domains.includes(`http://${host}`),
      )
        ? 200
        : 404;
    },
    async deployAndWait(_api: unknown, uuid: string) {
      calls.push(`deploy:${uuid}`);
      if (settings.activationFails && configured.get(uuid)?.some((d) => d.includes("site.example")))
        return "failed";
      if (
        settings.activationRetainsOld &&
        configured.get(uuid)?.some((d) => d.includes("site.example"))
      )
        return "finished";
      deployed.set(uuid, [...(configured.get(uuid) ?? [])]);
      states.set(uuid, "running:healthy");
      return "finished";
    },
    async waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean) {
      const value = await read();
      return done(value) ? value : null;
    },
  };
  return { api, deps, calls, configured, deployed, states, ledger: () => ledger };
}

try {
  for (const args of [
    ["--image"],
    ["--image", "app=ghcr.io/test/site:latest", "--keep-live-tag"],
    ["--image", `app=ghcr.io/test/site@sha256:${"a".repeat(64)}`, "--keep-live-tag"],
    ["--rollback-commit", "main"],
  ])
    await assert.rejects(runMigrateRuntimeCli(args), /--image|--rollback-commit|sha256 digest/);
  {
    const f = fixture();
    const plan = basePlan();
    plan.apps[0].sourceImage = { ...plan.apps[0].image };
    plan.apps[0].image = { name: "ghcr.io/test/site", tag: `sha256-${"a".repeat(64)}` };
    plan.apps[0].steadyTag = plan.apps[0].image.tag;
    assert.equal(
      await migrate(
        f.api,
        "https://coolify.example",
        plan,
        { ...options, keepLiveTag: false },
        f.deps,
      ),
      false,
    );
    assert.equal(f.calls.length, 0, "unsafe tag restoration refused before any mutation");
    assert.equal(await migrate(f.api, "https://coolify.example", plan, options, f.deps), false);
    assert.equal(f.calls.length, 0, "legacy source commit must be explicit before mutation");
    assert.equal(
      await migrate(
        f.api,
        "https://coolify.example",
        plan,
        { ...options, rollbackCommit: "d".repeat(40) },
        f.deps,
      ),
      false,
    );
    assert.equal(f.calls.length, 0, "legacy source readback must match before mutation");
    assert.equal(
      await migrate(
        f.api,
        "https://coolify.example",
        plan,
        { ...options, rollbackCommit: "c".repeat(40) },
        f.deps,
      ),
      true,
    );
    assert.equal(f.ledger()?.source.rollbackGitCommitSha, "c".repeat(40));
    const drifting = fixture({ sourceDrifts: true });
    assert.equal(
      await migrate(
        drifting.api,
        "https://coolify.example",
        plan,
        { ...options, rollbackCommit: "c".repeat(40) },
        drifting.deps,
      ),
      false,
    );
    assert.ok(
      !drifting.calls.includes("stop:old"),
      "source drift during deploy must leave legacy serving",
    );
    const changed = fixture({ gitCommitSha: "d".repeat(40) });
    assert.equal(await rollback(changed.api, f.ledger()!, options, changed.deps), false);
    assert.equal(
      changed.calls.length,
      0,
      "source drift blocks rollback before deploying or stopping anything",
    );
    assert.equal(f.ledger()?.apps[0].image, `ghcr.io/test/site@sha256:${"a".repeat(64)}`);
    assert.equal(f.ledger()?.apps[0].sourceImage, "ghcr.io/test/site:abc123");
  }
  {
    const f = fixture();
    assert.equal(
      await migrate(f.api, "https://coolify.example", basePlan(), options, f.deps),
      true,
    );
    assert.equal(
      f.calls.filter((c) => c === "deploy:new1").length,
      2,
      "private deployment and public-router activation both run",
    );
    assert.ok(
      f.calls.indexOf("ledger:cutting-over") < f.calls.indexOf("stop:old"),
      "rollback state is durable before stopping source",
    );
    assert.equal(f.ledger()?.phase, "cut-over");
  }
  {
    const f = fixture();
    const plan = basePlan();
    plan.apps = [
      { ...plan.apps[0], role: "client" },
      { ...plan.apps[0], role: "server", appName: "site-server" },
    ];
    assert.equal(
      await migrate(
        f.api,
        "https://coolify.example",
        plan,
        { ...options, noSecrets: false },
        {
          ...f.deps,
          async ghSecretExists() {
            return true;
          },
        },
      ),
      false,
    );
    assert.ok(
      !f.calls.some((call) => call.startsWith("create:")),
      "mixed generic and split deployment targets must fail before any mutation",
    );
  }
  for (const [reported, recorded] of [
    [null, "unknown"],
    [true, true],
    [false, false],
  ] as const) {
    const f = fixture({ autoDeploy: reported });
    assert.equal(
      await migrate(f.api, "https://coolify.example", basePlan(), options, f.deps),
      true,
    );
    assert.equal(f.ledger()?.source.autoDeployWasEnabled, recorded);
    const disabled = f.calls.indexOf("autodeploy:old:false");
    if (reported === false) {
      assert.equal(disabled, -1, "auto-deploy Coolify reports off is left untouched");
    } else {
      assert.ok(disabled >= 0, `auto-deploy reported as ${reported} is turned off`);
      assert.ok(disabled < f.calls.indexOf("stop:old"), "auto-deploy is off before the stop");
    }
    const r = fixture({ autoDeploy: reported });
    r.states.set("old", "exited");
    r.states.set("new1", "running:healthy");
    assert.equal(await rollback(r.api, f.ledger()!, options, r.deps), true);
    assert.deepEqual(
      r.calls.filter((c) => c.startsWith("autodeploy:")),
      reported === true ? ["autodeploy:old:true"] : [],
      "rollback restores only a recorded true",
    );
  }
  {
    const f = fixture({ activationFails: true });
    assert.equal(
      await migrate(f.api, "https://coolify.example", basePlan(), options, f.deps),
      false,
    );
    assert.ok(!f.calls.includes("stop:old"), "failed activation must leave source serving");
    assert.ok(
      f.calls.includes("stop:new1"),
      "aborting removes any replacement routers already activated",
    );
  }
  {
    const f = fixture({ activationRetainsOld: true });
    assert.equal(
      await migrate(f.api, "https://coolify.example", basePlan(), options, f.deps),
      false,
    );
    assert.ok(
      !f.calls.includes("stop:old"),
      "a retained private-only container cannot prove production-router activation",
    );
  }
  {
    const f = fixture({ publicAfter: 404 });
    assert.equal(
      await migrate(f.api, "https://coolify.example", basePlan(), options, f.deps),
      false,
    );
    assert.equal(
      f.ledger()?.phase,
      "cutting-over",
      "a failed route check is not eligible for cleanup",
    );
  }
  {
    const f = fixture({ stopStuck: true });
    assert.equal(
      await migrate(f.api, "https://coolify.example", basePlan(), options, f.deps),
      false,
    );
    assert.equal(
      f.ledger()?.phase,
      "cutting-over",
      "old source still answering does not prove cutover",
    );
  }
  {
    const f = fixture({ missingPrefixSetting: true });
    const plan = basePlan();
    plan.apps[0].domains = ["https://site.example/api"];
    plan.apps[0].healthCheck.path = "/api/health";
    assert.deepEqual(publicProbeUrls(plan.apps[0]), ["https://site.example/api/health"]);
    assert.equal(await migrate(f.api, "https://coolify.example", plan, options, f.deps), false);
    assert.ok(!f.calls.includes("stop:old"));
    assert.ok(
      !f.calls.includes("deploy:new1"),
      "dropped prefix setting fails before exposing a replacement",
    );
  }
  {
    const f = fixture({ missingPrefixSetting: true });
    const plan = basePlan();
    plan.apps[0].domains = ["https://site.example/api"];
    plan.apps[0].healthCheck.path = "/api/health";
    assert.equal(
      await migrate(
        f.api,
        "https://coolify.example",
        plan,
        { ...options, stripPrefixSafe: ["other"] },
        f.deps,
      ),
      false,
    );
    assert.ok(!f.calls.includes("deploy:new1"), "opt-in names a different service");
  }
  {
    const f = fixture({ missingPrefixSetting: true });
    const plan = basePlan();
    plan.apps[0].domains = ["https://site.example/api"];
    plan.apps[0].healthCheck.path = "/api/health";
    assert.equal(
      await migrate(
        f.api,
        "https://coolify.example",
        plan,
        { ...options, stripPrefixSafe: ["app"] },
        f.deps,
      ),
      true,
    );
    assert.ok(f.calls.includes("stop:old"), "prefix-tolerant service completes the cutover");
  }
  await assert.rejects(
    runMigrateRuntimeCli(["--strip-prefix-safe", "bad name"]),
    /--strip-prefix-safe/,
  );
  {
    let polls = 0;
    assert.match(
      await deployAndWait(
        {
          async queueDeploy() {
            return {};
          },
          async listApplicationDeployments() {
            polls++;
            return [{ deploymentUuid: "previous", status: "finished" }];
          },
        },
        "new",
      ),
      /not queued/,
    );
    assert.equal(polls, 0, "unrelated prior success cannot stand in for a missing deployment ID");
    assert.equal(
      await deployAndWait(
        {
          async queueDeploy() {
            return { deploymentUuid: "this-run" };
          },
          async listApplicationDeployments() {
            return [
              { deploymentUuid: "previous", status: "finished" },
              { deploymentUuid: "this-run", status: "failed" },
            ];
          },
        },
        "new",
        async () => {},
      ),
      "failed",
    );
  }
  {
    const f = fixture();
    // Interrupted after issuing the source stop, before marking cut-over.
    const ledger: MigrationLedger = {
      version: 1,
      source: { uuid: "old", name: "site", legacyName: "site-legacy-compose" },
      apps: [{ uuid: "new1", name: "site", service: "app", steadyTag: "main" }],
      secrets: [],
      phase: "cutting-over",
      updatedAt: "",
      publicBaseline: [["https://site.example/", 200]],
    };
    f.states.set("old", "exited");
    f.states.set("new1", "running:healthy");
    assert.equal(await rollback(f.api, ledger, options, f.deps), true);
    assert.equal(
      f.calls.filter((c) => c === "deploy:old").length,
      1,
      "rollback queues exactly once",
    );
    assert.ok(f.calls.indexOf("deploy:old") < f.calls.indexOf("stop:new1"));
    assert.ok(f.calls.indexOf("stop:new1") < f.calls.indexOf("delete:new1"));
  }
  {
    const plan = basePlan();
    plan.source.name = "site-server";
    assert.equal(migrationDeployRole(plan, 0), "server");
    plan.source.name = "site-client";
    assert.equal(migrationDeployRole(plan, 0), "client");
    plan.source.name = "site";
    assert.equal(migrationDeployRole(plan, 0), undefined);
  }
  for (const [before, after, expected] of [
    [200, 404, false],
    [200, 200, true],
    [302, 200, false],
    [null, 200, false],
    [503, 503, false],
  ] as const) {
    assert.equal(migrationProbeMatchesBaseline(before, after), expected);
  }
  {
    const path = join(dir, ".hatchkit.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 4,
        name: "site",
        coolifyRuntime: "compose",
        containerPorts: { client: 80 },
        custom: [1, 2],
      }),
    );
    assert.equal(setManifestRuntime(dir, "image", { server: 3001 }), true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      version: 4,
      name: "site",
      coolifyRuntime: "image",
      containerPorts: { client: 80, server: 3001 },
      custom: [1, 2],
    });
    assert.equal(setManifestRuntime(dir, "compose"), true);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).coolifyRuntime, "compose");
  }
  for (const extra of [
    "    secrets: [password]\n",
    "    configs: [nginx]\n",
    "    networks: [private]\n",
    "    env_file: .env.extra\n",
    "    labels:\n      - 'traefik.http.routers.app.rule=Host(`site.example`) && PathPrefix(`/api`)'\n",
    "    labels:\n      - 'traefik.http.routers.app.middlewares=auth@file'\n",
  ]) {
    const plan = planRuntimeMigration(
      {
        uuid: "old",
        name: "site",
        buildPack: "dockercompose",
        composeRaw: `services:\n  app:\n    image: ghcr.io/test/site:abc\n    expose: ['80']\n${extra}`,
        composeDomains: [{ name: "app", domain: "https://site.example" }],
      },
      [],
    );
    assert.ok(plan.blockers.length > 0, `unsupported setting must block: ${extra}`);
    assert.equal(plan.apps.length, 0);
  }
  console.log(
    "✓ Runtime cutover ordering, exact deployment identity, route gates, rollback, and unsupported-state guards",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
