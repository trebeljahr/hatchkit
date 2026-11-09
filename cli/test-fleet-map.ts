// `hatchkit map`: parsers, the extras registry, the pure builder, the
// layout and the HTML page. Fixtures use made-up names only (app-vps,
// ops-vps, edge-vps, example.com, 203.0.113.0/24, 100.64.0.0/10); no
// network, keychain or real fleet data.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFleetMap, coolifyHealth, projectStem, relationFromLedger } from "./src/map/build.js";
import {
  HOST_TIMERS_COMMAND,
  configuredProviders,
  fqdnHosts,
  parseSystemctlShow,
  repoSlug,
  serviceVersion,
  timersFromShow,
} from "./src/map/collect.js";
import {
  countRepos,
  discoverRepos,
  isMainCheckout,
  launchdJob,
  launchdProgram,
  manifestSummary,
  parseLaunchctlList,
  parseTailnetPolicy,
  parseTailscaleStatus,
  readStateSummary,
  readTerraformState,
} from "./src/map/discover.js";
import { EXTRAS_ENV, loadExtras, resolveExtrasPath, validateExtras } from "./src/map/extras.js";
import { renderPlate, rowsFor } from "./src/map/layout.js";
import type { FleetFacts, MapNode } from "./src/map/model.js";
import { countTiers } from "./src/map/model.js";
import { renderMapHtml } from "./src/map/render.js";
import {
  humanizeCalendar,
  humanizeCron,
  humanizeLaunchd,
  humanizeTimer,
  parseTimespan,
} from "./src/map/schedule.js";
import { CoolifyApi } from "./src/utils/coolify-api.js";

const failures: string[] = [];
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).stack ?? err}`);
  }
}

const scratch = mkdtempSync(join(tmpdir(), "hatchkit-fleet-map-"));

// ---------------------------------------------------------------------------
// schedules
// ---------------------------------------------------------------------------

await check("cron in words", () => {
  assert.equal(humanizeCron("* * * * *"), "every minute");
  assert.equal(humanizeCron("*/5 * * * *"), "every 5 min");
  assert.equal(humanizeCron("*/60 * * * *"), "hourly");
  assert.equal(humanizeCron("0 * * * *"), "hourly");
  assert.equal(humanizeCron("15 * * * *"), "hourly at :15");
  assert.equal(humanizeCron("0 */6 * * *"), "every 6 h");
  assert.equal(humanizeCron("0 21 * * *"), "daily 21:00 UTC");
  assert.equal(humanizeCron("30 3 * * 1"), "Mon 03:30 UTC");
  assert.equal(humanizeCron("0 0 1 * *"), "cron 0 0 1 * *");
  assert.equal(humanizeCron("nonsense"), "cron nonsense");
});

await check("systemd calendar and monotonic timers in words", () => {
  assert.equal(humanizeCalendar("*-*-* 16:00:00 UTC"), "16:00 UTC");
  assert.equal(humanizeCalendar("*-*-* *:00:00"), "hourly");
  assert.equal(humanizeCalendar("*-*-* *:50:00 UTC"), "hourly at :50");
  assert.equal(humanizeCalendar("*-*-* 00/4:00:00 UTC"), "every 4 h");
  assert.equal(humanizeCalendar("*-*-* *:00/15:00 UTC"), "every 15 min");
  assert.equal(humanizeCalendar("Sun *-*-* 02:00:00 UTC"), "Sun 02:00 UTC");
  assert.equal(humanizeCalendar("hourly"), "hourly");
  assert.equal(parseTimespan("5min"), 300);
  assert.equal(parseTimespan("1h 30min"), 5400);
  assert.equal(parseTimespan("soon"), null);
  // systemctl prints one TimersMonotonic= line per trigger; both survive.
  assert.equal(
    humanizeTimer(
      "",
      "{ OnUnitActiveUSec=5min ; next_elapse=2min } ; { OnBootUSec=3min ; next_elapse=3min }",
    ),
    "every 5 min",
  );
  assert.equal(humanizeTimer("", "{ OnBootUSec=2min ; next_elapse=2min }"), "at boot");
  assert.equal(
    humanizeTimer("{ OnCalendar=*-*-* 04:30:00 UTC ; next_elapse=Tue }", ""),
    "04:30 UTC",
  );
});

await check("launchd plists in words", () => {
  assert.equal(humanizeLaunchd({ KeepAlive: true }), "always on");
  assert.equal(humanizeLaunchd({ StartInterval: 900 }), "every 15 min");
  assert.equal(humanizeLaunchd({ StartInterval: 10 }), "every 10 s");
  assert.equal(
    humanizeLaunchd({ StartCalendarInterval: { Hour: 3, Minute: 30, Weekday: 0 } }),
    "Sun 03:30",
  );
  assert.equal(
    humanizeLaunchd({ StartCalendarInterval: [{ Hour: 7, Minute: 30 }, { Hour: 19 }] }),
    "07:30, 19:00",
  );
  assert.equal(humanizeLaunchd({ StartOnMount: true }), "when a volume mounts");
  assert.equal(humanizeLaunchd({ RunAtLoad: true }), "at login");
  assert.equal(humanizeLaunchd({}), "on demand");
});

// ---------------------------------------------------------------------------
// local discovery parsers
// ---------------------------------------------------------------------------

await check("launchctl list and job health", () => {
  const status = parseLaunchctlList(
    "PID\tStatus\tLabel\n-\t0\tcom.example.sync\n4242\t0\tcom.example.server\n-\t1\tcom.example.broken\n",
  );
  assert.deepEqual(status.get("com.example.sync"), { pid: undefined, status: 0 });
  assert.equal(status.get("com.example.server")?.pid, 4242);
  const broken = launchdJob(
    "com.example.broken",
    { StartInterval: 3600 },
    status.get("com.example.broken"),
  );
  assert.equal(broken.lastExit, 1);
  assert.equal(broken.running, false);
  assert.equal(broken.when, "hourly");
  const unloaded = launchdJob("com.example.gone", {}, undefined);
  assert.equal(unloaded.loaded, false);
});

await check("launchd program is a bare script name, never a command line", () => {
  assert.equal(
    launchdProgram({
      ProgramArguments: ["/bin/zsh", "-lc", "cd /Users/me/x && ./sync.sh --token abc"],
    }),
    "sync.sh",
  );
  assert.equal(launchdProgram({ ProgramArguments: ["/Users/me/bin/box-sync"] }), "box-sync");
  assert.equal(launchdProgram({ Program: "/usr/local/bin/caddy" }), "caddy");
  assert.equal(launchdProgram({}), undefined);
});

await check("tailscale status keeps names and tags, drops addresses and keys", () => {
  const facts = parseTailscaleStatus(
    JSON.stringify({
      Self: {
        HostName: "laptop",
        DNSName: "laptop.tail0000.ts.net.",
        OS: "macOS",
        TailscaleIPs: ["100.64.0.1"],
      },
      Peer: {
        "nodekey:aaa": {
          HostName: "app-vps",
          DNSName: "app-vps.tail0000.ts.net.",
          OS: "linux",
          Online: true,
          Tags: ["tag:apps"],
          TailscaleIPs: ["100.64.0.2"],
          PublicKey: "nodekey:aaa",
        },
        "nodekey:bbb": {
          HostName: "ops-vps",
          DNSName: "ops-vps.tail0000.ts.net.",
          OS: "linux",
          Online: true,
          Tags: ["tag:ops"],
          ExitNodeOption: true,
        },
        "nodekey:ccc": {
          HostName: "Pocket Phone",
          DNSName: "pocket-phone.tail0000.ts.net.",
          OS: "android",
          Online: false,
        },
      },
    }),
  );
  assert.equal(facts.self?.id, "laptop");
  assert.deepEqual(
    facts.peers.map((p) => p.id),
    ["app-vps", "ops-vps", "pocket-phone"],
  );
  assert.equal(facts.peers[1].exitNode, true);
  const text = JSON.stringify(facts);
  assert.ok(!text.includes("100.64."), "no tailnet addresses");
  assert.ok(!text.includes("nodekey"), "no node keys");
});

await check("tailnet policy grants and legacy acls", () => {
  const grants = parseTailnetPolicy({
    grants: [{ src: ["tag:apps"], dst: ["tag:ops"], ip: ["tcp:443", "tcp:2222"] }],
    acls: [
      { action: "accept", src: ["autogroup:admin"], dst: ["tag:ops:22", "tag:apps:*"] },
      { action: "deny", src: ["*"], dst: ["*:*"] },
    ],
  });
  assert.deepEqual(grants[0], {
    src: ["tag:apps"],
    dst: ["tag:ops"],
    ports: ["tcp:443", "tcp:2222"],
  });
  assert.deepEqual(grants[1], {
    src: ["autogroup:admin"],
    dst: ["tag:ops", "tag:apps"],
    ports: ["22"],
  });
  assert.equal(grants.length, 2);
});

await check("Terraform state: managed resources and the server name, nothing else", () => {
  const state = JSON.stringify({
    resources: [
      { mode: "data", type: "hcloud_ssh_key", instances: [{}] },
      { mode: "managed", type: "hcloud_firewall", instances: [{ attributes: { name: "fw" } }] },
      {
        mode: "managed",
        type: "hcloud_server",
        instances: [{ attributes: { name: "ops-vps", ipv4_address: "203.0.113.7", id: "123" } }],
      },
    ],
  });
  assert.deepEqual(readStateSummary(state), { resources: 2, server: "ops-vps" });
  assert.deepEqual(readStateSummary("{not json"), { resources: 0 });

  const stacks = join(scratch, "stacks");
  const ws = join(stacks, "hardened-vps", "terraform.tfstate.d", "ops-vps");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "terraform.tfstate"), state);
  const empty = join(stacks, "hardened-vps", "terraform.tfstate.d", "gone");
  mkdirSync(empty, { recursive: true });
  writeFileSync(join(empty, "terraform.tfstate"), JSON.stringify({ resources: [] }));
  mkdirSync(join(stacks, "dns-only"), { recursive: true });
  writeFileSync(
    join(stacks, "dns-only", "terraform.tfstate"),
    JSON.stringify({
      resources: [{ mode: "managed", type: "cloudflare_record", instances: [{}, {}] }],
    }),
  );
  const facts = readTerraformState(stacks);
  assert.deepEqual(facts.workspaces, [
    { stack: "dns-only", name: "default", resources: 2, server: undefined },
    { stack: "hardened-vps", name: "ops-vps", resources: 2, server: "ops-vps" },
  ]);
  assert.ok(!JSON.stringify(facts).includes("203.0.113"));
  assert.deepEqual(readTerraformState(join(scratch, "missing")).workspaces, []);
});

await check("repos: main checkouts only, manifest summary, package description", async () => {
  const root = join(scratch, "projects");
  mkdirSync(join(root, "game", ".git"), { recursive: true });
  writeFileSync(
    join(root, "game", ".hatchkit.json"),
    JSON.stringify({
      name: "game",
      domain: "game.example.com",
      aliases: ["www.game.example.com"],
      secretish: "x",
    }),
  );
  mkdirSync(join(root, "site", ".git"), { recursive: true });
  writeFileSync(join(root, "site", "package.json"), JSON.stringify({ description: "A site" }));
  mkdirSync(join(root, "game-wt-feature"), { recursive: true });
  writeFileSync(join(root, "game-wt-feature", ".git"), "gitdir: ../game/.git/worktrees/feature\n");
  mkdirSync(join(root, "notes"), { recursive: true });
  assert.equal(isMainCheckout(join(root, "game-wt-feature", ".git")), false);
  const repos = await discoverRepos([root]);
  assert.deepEqual(
    repos.map((r) => r.name),
    ["game", "site"],
  );
  assert.deepEqual(repos[0].manifest, {
    name: "game",
    domain: "game.example.com",
    aliases: ["www.game.example.com"],
    description: undefined,
    deploymentMode: undefined,
  });
  assert.equal(repos[1].description, "A site");
  assert.equal(manifestSummary({ domain: "x" }), undefined);
});

await check("GitHub counts", () => {
  assert.deepEqual(
    countRepos([
      { visibility: "PUBLIC" },
      { visibility: "PRIVATE", isArchived: true },
      { visibility: "INTERNAL" },
    ]),
    { repos: 3, private: 2, archived: 1 },
  );
});

// ---------------------------------------------------------------------------
// remote collector helpers
// ---------------------------------------------------------------------------

await check("Coolify fqdn, repo slug and service version", () => {
  assert.deepEqual(
    fqdnHosts("https://a.example.com,http://b.example.com:8080/x, https://a.example.com"),
    ["a.example.com", "b.example.com"],
  );
  assert.equal(repoSlug("git@github.com:acme/game.git"), "acme/game");
  assert.equal(repoSlug("https://github.com/acme/game"), "acme/game");
  assert.equal(repoSlug("acme/game"), "acme/game");
  assert.equal(repoSlug("ghcr.io/acme/game:live"), undefined);
  assert.equal(serviceVersion("glitchtip", ["glitchtip/glitchtip:6.2.6", "postgres:18"]), "6.2.6");
  assert.equal(serviceVersion("uptime-kuma", ["louislam/uptime-kuma:2.5.9-rootless"]), "2.5.9");
  assert.equal(
    serviceVersion("plausible", ["registry/plausible-abcdefghijklmnopqrstuvwx:2026"]),
    undefined,
  );
  assert.equal(serviceVersion("listmonk", ["postgres:18.6-alpine"]), undefined);
});

await check("systemctl show: blocks, repeated keys, failed services", () => {
  const text = [
    "Id=hatchkit-backups.timer",
    "ActiveState=active",
    "TimersCalendar={ OnCalendar=*-*-* 16:00:00 UTC ; next_elapse=Tue }",
    "",
    "TimersMonotonic={ OnUnitActiveUSec=5min ; next_elapse=1min }",
    "TimersMonotonic={ OnBootUSec=3min ; next_elapse=3min }",
    "Id=hatchkit-guard-check.timer",
    "ActiveState=active",
    "",
    "",
    "Id=hatchkit-backups.service",
    "Description=Encrypted project data backups",
    "ActiveState=inactive",
    "Result=success",
    "",
    "Id=hatchkit-guard-check.service",
    "Description=Check the guard",
    "ActiveState=failed",
    "Result=exit-code",
  ].join("\n");
  assert.equal(parseSystemctlShow(text).length, 4);
  const timers = timersFromShow(text);
  assert.deepEqual(timers, [
    {
      unit: "hatchkit-backups.timer",
      description: "Encrypted project data backups",
      when: "16:00 UTC",
      active: true,
      failed: false,
    },
    {
      unit: "hatchkit-guard-check.timer",
      description: "Check the guard",
      when: "every 5 min",
      active: true,
      failed: true,
    },
  ]);
  // The host command only reads.
  assert.match(HOST_TIMERS_COMMAND, /systemctl list-unit-files/);
  assert.doesNotMatch(HOST_TIMERS_COMMAND, /\b(start|stop|restart|enable|disable|rm|tee)\b/);
});

await check("configured providers come from status flags, paused ones drop out", () => {
  assert.deepEqual(
    configuredProviders(
      {
        coolify: { status: "configured", url: "https://coolify.example.com" },
        hetzner: { status: "unconfigured" },
        stripe: { status: "configured" },
        s3: { r2: { endpoint: "https://x.r2.cloudflarestorage.com" }, aws: {} },
        gpu: {},
      },
      ["stripe"],
    ),
    ["coolify", "s3:r2"],
  );
});

await check("Coolify placements keep names and drop compose bodies and env", async () => {
  const realFetch = globalThis.fetch;
  const body: Record<string, unknown> = {
    "/applications": [
      {
        uuid: "a1",
        name: "game-server",
        environment_id: 4,
        status: "running:healthy",
        build_pack: "dockerimage",
        fqdn: "https://game.example.com",
        git_repository: "acme/game",
        docker_compose: "DATABASE_URL=postgres://user:hunter2@db",
        destination: { server: { name: "app-vps", ip: "203.0.113.10" } },
      },
    ],
    "/databases": [
      {
        uuid: "d1",
        name: "game-postgres",
        database_type: "standalone-postgresql",
        status: "running:healthy",
        internal_db_url: "postgres://user:hunter2@db",
        destination: { server: { name: "app-vps" } },
      },
    ],
    "/services": [
      {
        uuid: "s1",
        name: "glitchtip",
        status: "degraded:unhealthy",
        server: { name: "ops-vps", ip: "203.0.113.11" },
        docker_compose_raw: "SECRET_KEY=hunter2",
        applications: [{ image: "glitchtip/glitchtip:6.2.6" }],
        databases: [{ image: "postgres:18" }],
      },
    ],
  };
  globalThis.fetch = (async (url: string | URL) => {
    const path = String(url).replace(/^.*\/api\/v1/, "");
    return new Response(JSON.stringify(body[path] ?? []), { status: 200 });
  }) as typeof fetch;
  try {
    const p = await new CoolifyApi({
      url: "https://coolify.example.com",
      token: "t",
    }).listPlacements();
    assert.equal(p.applications[0].server, "app-vps");
    assert.equal(p.applications[0].environmentId, 4);
    assert.equal(p.databases[0].type, "standalone-postgresql");
    assert.equal(p.services[0].server, "ops-vps");
    assert.deepEqual(p.services[0].images, ["glitchtip/glitchtip:6.2.6", "postgres:18"]);
    const text = JSON.stringify(p);
    assert.ok(!text.includes("hunter2"), "no env values");
    assert.ok(!text.includes("203.0.113"), "no addresses");
    assert.ok(!text.includes('"a1"') && !text.includes('"s1"'), "no uuids");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// extras registry
// ---------------------------------------------------------------------------

await check("extras: YAML loads, shorthand forms expand, errors name the field", () => {
  const file = join(scratch, "map-extras.yaml");
  writeFileSync(
    file,
    [
      "title: Example Fleet",
      "launchdPrefixes: [com.example.]",
      "nodes:",
      "  - id: laptop-extra",
      "    components:",
      "      - Notes vault",
      "      - { label: no offsite copy, gap: true }",
      "      - { label: readers, tier: none }",
      "projects:",
      "  - { name: game, domain: game.example.com, aliases: [game-old] }",
      "looseEnds:",
      "  - Something to fix",
    ].join("\n"),
  );
  const x = loadExtras(file);
  assert.equal(x.title, "Example Fleet");
  assert.deepEqual(x.nodes?.[0].components?.[0], { label: "Notes vault" });
  assert.equal(x.nodes?.[0].components?.[1].gap, true);
  assert.deepEqual(x.projects?.[0].domains, ["game.example.com"]);
  assert.deepEqual(x.looseEnds, [{ title: "Something to fix" }]);
  assert.deepEqual(loadExtras(null), {});
  assert.throws(() => validateExtras({ nodez: [] }), /nodez: is not a known key/);
  assert.throws(
    () => validateExtras({ nodes: [{ id: "x", components: [{ label: "y", tier: "seen" }] }] }),
    /nodes\[0\]\.components\[0\]\.tier: must be listed, made, outside, none/,
  );
  assert.throws(() => validateExtras({ jobs: [{ name: "j" }] }), /jobs\[0\]\.node: is required/);
});

await check("extras path: flag, then env, then the default; an explicit miss is an error", () => {
  const home = join(scratch, "home");
  mkdirSync(join(home, ".config", "hatchkit"), { recursive: true });
  assert.equal(resolveExtrasPath(undefined, {}, home), null);
  const def = join(home, ".config", "hatchkit", "map-extras.yaml");
  writeFileSync(def, "title: x\n");
  assert.equal(resolveExtrasPath(undefined, {}, home), def);
  const other = join(scratch, "other.yaml");
  writeFileSync(other, "{}");
  assert.equal(resolveExtrasPath(undefined, { [EXTRAS_ENV]: other }, home), other);
  assert.equal(resolveExtrasPath(other, { [EXTRAS_ENV]: def }, home), other);
  assert.throws(() => resolveExtrasPath(join(scratch, "nope.yaml"), {}, home), /not found/);
});

// ---------------------------------------------------------------------------
// the builder
// ---------------------------------------------------------------------------

function fakeFacts(): FleetFacts {
  return {
    generatedAt: "2030-01-01T00:00:00.000Z",
    cliVersion: "0.0.0-test",
    local: { name: "laptop", os: "macOS" },
    overview: {
      present: ["coolify", "dns:cloudflare", "s3:r2", "glitchtip"],
      glitchtipProjects: 2,
      crossReferenceWarnings: [
        { headline: "Coolify apps deploying from a missing GitHub repo", subjects: ["acme/gone"] },
      ],
    },
    providers: ["cloudflare", "coolify", "dns", "ghcr", "github", "hetzner", "ses"],
    coolify: {
      version: "4.0.0",
      servers: [
        { name: "localhost", hetznerName: "app-vps", coolifyHost: true },
        { name: "ops-vps", hetznerName: "ops-vps", coolifyHost: false },
      ],
      apps: [
        {
          name: "game-server",
          server: "localhost",
          project: "game",
          status: "running:healthy",
          buildPack: "dockerimage",
          domains: ["game.example.com", "203-0-113-10.sslip.io"],
          repo: "acme/game",
        },
        {
          name: "old-compose",
          server: "localhost",
          project: "legacy",
          status: "exited:unhealthy",
          domains: [],
        },
      ],
      databases: [{ name: "game-postgres", type: "standalone-postgresql", server: "localhost" }],
      services: [
        { name: "glitchtip", server: "ops-vps", status: "running:healthy", versions: ["6.2.6"] },
        { name: "plausible", server: "ops-vps", status: "degraded:unhealthy", versions: [] },
      ],
      projects: ["game", "legacy"],
    },
    hetzner: {
      servers: [
        { name: "app-vps", type: "cpx21", role: "projects" },
        { name: "ops-vps", type: "cx22", role: "shared" },
        { name: "edge-vps", type: "cx22", role: "bot" },
      ],
    },
    terraform: {
      workspaces: [
        { stack: "hardened-vps", name: "ops-vps", server: "ops-vps", resources: 2 },
        { stack: "hardened-vps", name: "edge-vps", server: "edge-vps", resources: 2 },
      ],
    },
    cloudflare: {
      zones: ["example.com", "example.org"],
      buckets: ["game-assets", "backups"],
      workers: [
        { name: "game-client", hasAssets: true, crons: [], hosts: ["game.example.com"] },
        {
          name: "monitor",
          hasAssets: false,
          crons: ["*/5 * * * *"],
          deployedFrom: "wrangler",
          hosts: [],
        },
        {
          name: "hatchkit-audit",
          hasAssets: false,
          crons: ["0 */6 * * *"],
          deployedFrom: "api",
          hosts: [],
        },
      ],
    },
    deployTokens: [{ worker: "game-client", repo: "acme/game" }],
    backups: {
      target: "r2",
      hosts: [
        { name: "apps-host", server: "localhost", schedule: "16:00" },
        { name: "ops-vps", server: "ops-vps", schedule: "17:00" },
      ],
    },
    hostTimers: {
      "apps-host": {
        timers: [
          { unit: "hatchkit-backups.timer", when: "16:00 UTC", active: true },
          { unit: "hatchkit-tailnet-dns-check.timer", when: "every 30 s", active: true },
          { unit: "hatchkit-guard-check.timer", when: "every 5 min", active: true, failed: true },
        ],
      },
      "ops-vps": { error: "tailscale ssh: timed out" },
    },
    tailscale: {
      self: { id: "laptop", hostName: "laptop" },
      peers: [
        { id: "app-vps", hostName: "app-vps", online: true, tags: ["tag:apps"], exitNode: false },
        { id: "ops-vps", hostName: "ops-vps", online: true, tags: ["tag:ops"], exitNode: true },
        {
          id: "pocket-phone",
          hostName: "Pocket Phone",
          os: "android",
          online: true,
          tags: [],
          exitNode: false,
        },
        { id: "friends-box", hostName: "friends-box", online: false, tags: [], exitNode: false },
      ],
      grants: [{ src: ["tag:apps"], dst: ["tag:ops"], ports: ["tcp:443"] }],
    },
    launchd: [
      {
        label: "com.hatchkit.dev-caddy",
        when: "always on",
        running: true,
        lastExit: 0,
        loaded: true,
      },
      {
        label: "com.example.sync",
        when: "every 15 min",
        running: false,
        lastExit: 0,
        loaded: true,
      },
      { label: "com.example.digest", when: "hourly", running: false, lastExit: 1, loaded: true },
    ],
    ledgers: [
      { name: "game", kinds: ["scaffold", "coolifyApp"] },
      { name: "site-old", kinds: ["manifest", "keychain"] },
    ],
    repos: [
      {
        name: "game",
        lastCommit: "2030-01-01",
        manifest: { name: "game", domain: "game.example.com" },
      },
      { name: "site", lastCommit: "2029-12-30", description: "A site" },
    ],
    github: { owners: ["acme"], repos: 12, private: 3, archived: 1 },
    macRunner: true,
    sources: [
      { key: "coolify", label: "Coolify", status: "ok" },
      { key: "hetzner", label: "Hetzner", status: "error", detail: "HTTP 401" },
    ],
  };
}

await check("builder: places, tiers and gaps from live facts alone", () => {
  const map = buildFleetMap(fakeFacts());
  const ids = map.nodes.map((n) => n.id);
  assert.deepEqual(ids, [
    "github",
    "cloudflare",
    "apis",
    "local",
    "app-vps",
    "ops-vps",
    "edge-vps",
    "pocket-phone",
    "friends-box",
  ]);
  const app = map.nodes.find((n) => n.id === "app-vps") as MapNode;
  const comp = (n: MapNode, id: string) => n.components.find((c) => c.id === id);
  assert.equal(comp(app, "coolify")?.tier, "listed");
  assert.equal(comp(app, "apps")?.label, "2 apps on Coolify");
  assert.equal(comp(app, "apps")?.note, "1 not healthy");
  assert.equal(comp(app, "backups")?.label, "restic backups 16:00 UTC");
  assert.equal(comp(app, "timers")?.note, "1 failed");
  assert.equal(comp(app, "tailnet-dns")?.tier, "made");
  assert.equal(comp(app, "gap:terraform")?.gap, true, "app-vps has no workspace");
  const ops = map.nodes.find((n) => n.id === "ops-vps") as MapNode;
  assert.equal(comp(ops, "service:glitchtip")?.tier, "listed", "overview lists GlitchTip");
  assert.equal(comp(ops, "service:plausible")?.tier, "made");
  assert.match(comp(ops, "timers")?.note ?? "", /not read: tailscale ssh: timed out/);
  assert.equal(comp(ops, "exit-node")?.tier, "outside");
  const edge = map.nodes.find((n) => n.id === "edge-vps") as MapNode;
  assert.equal(comp(edge, "gap:backups")?.gap, true);
  assert.equal(comp(edge, "terraform")?.tier, "made");
  const cf = map.nodes.find((n) => n.id === "cloudflare") as MapNode;
  const workers = comp(cf, "workers");
  assert.equal(workers?.note, "2 through hatchkit · 2 on cron");
  assert.deepEqual(
    workers?.items?.map((i) => [i.name, i.tier]),
    [
      ["game-client", "made"],
      ["monitor", "outside"],
      ["hatchkit-audit", "made"],
    ],
  );
  assert.deepEqual(countTiers(map.nodes), map.tiers);
  assert.equal(map.tiers.gaps, 2);
  assert.ok(map.tiers.listed >= 5 && map.tiers.made >= 10);
});

await check("builder: edges, jobs and findings", () => {
  const map = buildFleetMap(fakeFacts());
  const e = (from: string, to: string) => map.edges.find((x) => x.from === from && x.to === to);
  assert.equal(e("github", "cloudflare")?.label, "1 Worker deploy on push");
  assert.equal(e("cloudflare", "app-vps")?.label, "proxied public traffic");
  assert.equal(e("cloudflare", "ops-vps")?.label, "proxied public traffic");
  assert.equal(e("github", "app-vps")?.label, "GHCR images · deploy hooks");
  assert.equal(e("app-vps", "ops-vps")?.label !== undefined, true);
  assert.equal(e("ops-vps", "cloudflare")?.label, "restic → R2");
  assert.equal(e("local", "app-vps")?.manual, true);
  assert.ok(
    map.edges.some(
      (x) => x.from === "app-vps" && x.to === "ops-vps" && x.label === "tailnet tcp:443",
    ),
  );
  assert.ok(!map.edges.some((x) => x.from === x.to));

  const job = (name: string) => map.jobs.find((j) => j.name === name);
  assert.equal(job("dev-caddy")?.tier, "made");
  assert.equal(job("digest")?.health, "fail");
  assert.equal(job("guard-check")?.detail, "failed on app-vps");
  assert.equal(job("backups")?.where, "app-vps · hatchkit timers");
  assert.equal(job("monitor")?.when, "every 5 min");
  assert.equal(job("hatchkit-audit")?.tier, "made");

  const titles = map.findings.map((f) => f.title);
  for (const want of [
    "app-vps sits outside Terraform.",
    "edge-vps has no hatchkit backups.",
    "launchd job com.example.digest is failing.",
    "Host timer hatchkit-guard-check.timer failed on app-vps.",
    "Coolify app old-compose is exited:unhealthy.",
    "Coolify service plausible is degraded:unhealthy.",
    "1 Worker deploy without a hatchkit token.",
    "Coolify apps deploying from a missing GitHub repo (1).",
    "Not read: Hetzner.",
  ]) {
    assert.ok(titles.includes(want), `finding: ${want}\n  have: ${titles.join(" | ")}`);
  }
});

await check("builder: extras merge, rename, hide, add and report unknown edges", () => {
  const extras = validateExtras({
    title: "Example Fleet",
    localName: "My laptop",
    hide: ["friends-box"],
    groups: ["Games", "Sites"],
    nodes: [
      { id: "local", components: ["notes vault", { label: "no offsite copy", gap: true }] },
      { id: "pocket-phone", name: "Phone", subtitle: "chat" },
      {
        id: "stores",
        name: "Stores",
        kind: "world",
        components: [{ label: "itch.io", tier: "none" }],
      },
      { id: "edge-vps", components: [{ label: "bot", tier: "outside" }] },
    ],
    edges: [
      { from: "edge-vps", to: "pocket-phone", label: "messages", both: true },
      { from: "edge-vps", to: "nowhere", label: "?" },
    ],
    jobs: [{ name: "bot", node: "edge-vps", where: "edge-vps · systemd", when: "always on" }],
    looseEnds: [{ title: "Bot has no backups.", detail: "Copies stay on the box." }],
  });
  const map = buildFleetMap(fakeFacts(), extras);
  assert.equal(map.title, "Example Fleet");
  assert.ok(!map.nodes.some((n) => n.id === "friends-box"));
  const local = map.nodes.find((n) => n.id === "local") as MapNode;
  assert.equal(local.name, "My laptop");
  assert.ok(local.components.some((c) => c.label === "notes vault" && c.tier === "outside"));
  assert.ok(local.components.some((c) => c.label === "no offsite copy" && c.gap && !c.tier));
  assert.equal(map.nodes.find((n) => n.id === "pocket-phone")?.name, "Phone");
  const stores = map.nodes.find((n) => n.id === "stores") as MapNode;
  assert.equal(stores.zone, "public");
  assert.equal(stores.components[0].tier, undefined);
  assert.ok(map.edges.some((e) => e.from === "edge-vps" && e.to === "pocket-phone" && e.both));
  assert.ok(map.findings.some((f) => f.title.includes("edge-vps → nowhere")));
  assert.ok(map.findings.some((f) => f.title === "Bot has no backups."));
  assert.equal(map.jobs.find((j) => j.name === "bot")?.where, "edge-vps · systemd");
  assert.equal(map.jobs.find((j) => j.name === "dev-caddy")?.where, "My laptop · launchd");
  // Without the extras the same facts give one outside piece fewer per extra.
  const plain = buildFleetMap(fakeFacts());
  assert.equal(map.tiers.outside, plain.tiers.outside + 2);
  assert.equal(map.tiers.gaps, plain.tiers.gaps + 1);
});

await check("builder: projects join ledgers, tokens, Coolify, manifests and aliases", () => {
  const extras = validateExtras({
    groups: ["Games", "Sites"],
    projects: [
      { name: "game", group: "Games", blurb: "A game", ships: ["Steam"] },
      { name: "site", group: "Sites", aliases: ["site-old"] },
      { name: "notes", group: "Sites" },
    ],
  });
  const map = buildFleetMap(fakeFacts(), extras);
  const p = (name: string) => map.projects.find((x) => x.name === name);
  const game = p("game");
  assert.equal(game?.hatchkit, "starter");
  assert.deepEqual(game?.ships, ["Steam", "Workers", "Coolify"]);
  assert.deepEqual(game?.servers, ["app-vps"]);
  assert.deepEqual(game?.domains, ["game.example.com"], "sslip.io hosts dropped");
  assert.equal(game?.lastCommit, "2030-01-01");
  assert.equal(game?.tier, "listed");
  assert.equal(p("site")?.hatchkit, "adopted", "ledger site-old is an alias of site");
  assert.equal(p("site")?.blurb, "A site");
  assert.equal(p("site")?.tier, "made");
  assert.equal(p("notes")?.tier, "outside");
  assert.equal(p("legacy")?.group, "Not grouped");
  assert.equal(p("monitor")?.ships.includes("Workers"), true);
  assert.deepEqual(map.projectGroups, ["Games", "Sites", "Not grouped"]);
  assert.equal(relationFromLedger(["github", "coolifyApp"]), "provisioned");
  assert.equal(projectStem("game-backend"), "game");
  assert.equal(coolifyHealth("running:healthy"), "ok");
  assert.equal(coolifyHealth("running:unhealthy"), "warn");
  assert.equal(coolifyHealth("exited:unhealthy"), "fail");
});

// ---------------------------------------------------------------------------
// layout + page
// ---------------------------------------------------------------------------

const box = (id: string, labels: number, zone: "public" | "tailnet" = "public"): MapNode => ({
  id,
  name: id,
  kind: zone === "public" ? "platform" : "server",
  zone,
  components: Array.from({ length: labels }, (_, i) => ({
    id: String(i),
    label: "x".repeat(30),
    tier: "made" as const,
    source: "test",
  })),
});

await check("layout: wrapped rows are balanced, never one box alone", () => {
  const seven = Array.from({ length: 7 }, (_, i) => box(`n${i}`, 1));
  const rows = rowsFor(seven);
  assert.ok(rows.length >= 2);
  assert.ok(Math.min(...rows.map((r) => r.length)) >= 2, rows.map((r) => r.length).join("/"));
  assert.deepEqual(
    rowsFor([box("a", 1), box("b", 1)]).map((r) => r.length),
    [2],
  );
  assert.deepEqual(rowsFor([]), []);
});

await check("layout: an edge skipping a row drops through a gutter, not a box", () => {
  const top = Array.from({ length: 7 }, (_, i) => box(`p${i}`, 2));
  const low = box("srv", 2, "tailnet");
  const plate = renderPlate(
    [...top, low],
    [{ from: "p0", to: "srv", label: "deploys", source: "t" }],
  );
  assert.match(plate.svg, /^<svg class="map"/);
  assert.equal((plate.svg.match(/class="node-g"/g) ?? []).length, 8);
  const d = /<path d="(M[^"]+)" class="edge"/.exec(plate.svg)?.[1] ?? "";
  const pts = d
    .slice(1)
    .split(" L")
    .map((p) => p.split(" ").map(Number));
  assert.equal(pts.length, 6, `a six-point route: ${d}`);
  // The gutter segment's x lies outside every box of the second row.
  const gx = pts[2][0];
  const rects = [
    ...plate.svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="7"/g),
  ].map((m) => m.slice(1).map(Number));
  const [y1, y2] = [pts[2][1], pts[3][1]];
  for (const [x, y, w, h] of rects) {
    const crossesRow = y < Math.max(y1, y2) && y + h > Math.min(y1, y2);
    if (crossesRow) assert.ok(gx < x || gx > x + w, `gutter x ${gx} inside box at ${x}..${x + w}`);
  }
});

await check("page: self-contained, escaped, no addresses", () => {
  const extras = validateExtras({
    nodes: [{ id: "local", components: ['<script>alert("x")</script>'] }],
  });
  const map = buildFleetMap(fakeFacts(), extras);
  const html = renderMapHtml(map);
  assert.match(html, /^<!doctype html>/);
  assert.ok(!html.includes("<script"), "no script tags, and labels are escaped");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), "no external requests");
  assert.ok(!html.includes("203.0.113") && !html.includes("100.64."));
  for (const section of [
    "What hatchkit sees",
    "Places",
    "Projects",
    "Clockwork",
    "Loose ends",
    "Sources",
  ]) {
    assert.ok(html.includes(`<h2>${section}</h2>`), section);
  }
  assert.ok(html.includes(`${map.tiers.listed} listed`));
});

rmSync(scratch, { recursive: true, force: true });
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("fleet map: all checks passed");
