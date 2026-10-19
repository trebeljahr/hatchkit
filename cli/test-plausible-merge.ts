// `hatchkit plausible merge`: the 2026-10-19 recipe against a fake host.
//
// On 2026-10-19 beauty.trebeljahr.com (site 10) was folded into
// collectionofbeauty.com (site 19) by hand in ClickHouse and Postgres,
// because Plausible CE has no Sites API and no merge. The fake below holds
// that pair: a Postgres `sites`/`goals` table, ClickHouse events_v2,
// sessions_v2 and ingest_counters, and the two Plausible rpc calls. It
// answers the exact SQL the command sends, so every test checks both what
// was written and what was refused. The last part sends steps over a fake
// `tailscale` on PATH to the real Python runner, with a fake `docker`.
// Nothing here reaches a real host.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStore } from "./src/config.js";
import {
  type HostRunner,
  type HostStep,
  type MergePlan,
  type MergeResult,
  hostRunner,
  normalizeDomain,
  plausibleStacks,
  runPlausibleMerge,
} from "./src/host/plausible-merge.js";

const UUID = "c8378br07og1w4ta45uxh57l";
const NOW = new Date("2026-10-19T04:11:02Z");
const OLD = "beauty.trebeljahr.com";
const NEW = "collectionofbeauty.com";

type Row = Record<string, unknown> & { site_id: number };
interface Goal {
  id: number;
  site_id: number;
  event_name: string | null;
  page_path: string | null;
  scroll_threshold: number;
  display_name: string;
  custom_props: Record<string, string>;
}

/** The host: three containers, two databases, one rpc. */
class FakeHost {
  containers = [
    `plausible-${UUID}`,
    `plausible-db-${UUID}`,
    `plausible-events-db-${UUID}`,
    "coolify",
    "coolify-proxy",
  ];
  sites = new Map<number, Record<string, unknown>>([
    [
      10,
      {
        id: 10,
        domain: OLD,
        timezone: "Europe/Berlin",
        native_stats_start_at: "2026-05-13T08:21:32",
        stats_start_date: "2026-05-13",
      },
    ],
    [
      19,
      {
        id: 19,
        domain: NEW,
        timezone: "Australia/Sydney",
        native_stats_start_at: "2026-10-17T02:49:13",
        stats_start_date: "2026-10-17",
      },
    ],
  ]);
  goals: Goal[] = [
    goal(1, 10, { event_name: "Outbound Link: Click" }),
    goal(2, 10, { event_name: "File Download" }),
    goal(3, 10, { event_name: "404" }),
    goal(4, 10, { event_name: "Signup", custom_props: { plan: "pro" } }),
    goal(5, 10, { page_path: "/pricing", scroll_threshold: 50, display_name: "Pricing read" }),
    goal(6, 19, { event_name: "Signup" }),
  ];
  tables = new Map<string, Row[]>([
    [
      "events_v2",
      [
        ...events(10, "2026-05-13 08:21:32", 3),
        { site_id: 10, timestamp: "2026-10-17 02:25:33", user_id: 9001 },
        ...events(19, "2026-10-17 02:49:13", 2),
        ...events(7, "2026-01-01 00:00:00", 4),
      ],
    ],
    [
      "sessions_v2",
      [
        { site_id: 10, sign: 1 },
        { site_id: 10, sign: 1 },
        { site_id: 10, sign: -1 },
        { site_id: 10, sign: 1 },
        { site_id: 19, sign: 1 },
        { site_id: 7, sign: 1 },
      ],
    ],
    [
      "ingest_counters",
      [
        { site_id: 10, domain: OLD, metric: "buffered", value: 4 },
        { site_id: 19, domain: NEW, metric: "buffered", value: 2 },
      ],
    ],
    ["imported_visitors", [{ site_id: 7 }]],
    ["imported_pages", []],
  ]);
  files = new Set<string>();
  steps: HostStep[] = [];
  /** A step whose argv or input matches fails like the host would. */
  failOn: RegExp | null = null;
  mutationsSync = false;
  nextGoalId = 100;

  run: HostRunner = async (step) => {
    this.steps.push(structuredClone(step));
    const text = `${step.argv.join(" ")}\n${step.input ?? ""}`;
    if (this.failOn?.test(text)) throw new Error("Backup host shared-vps: injected failure");
    const [docker, verb, ...rest] = step.argv;
    assert.equal(docker, "docker");
    if (verb === "ps") return `${this.containers.join("\n")}\n`;
    const container = rest.find((arg) => arg.startsWith("plausible-"));
    if (container === `plausible-${UUID}` && rest.includes("rpc"))
      return this.rpc(rest[rest.length - 1]);
    if (container === `plausible-${UUID}`)
      return "plausible_db?sslmode=disable\nplausible_events_db\n";
    if (container === `plausible-db-${UUID}` && step.out) {
      assert.equal(rest.at(-1), "plausible_db");
      if (this.files.has(step.out))
        throw new Error(`Backup host shared-vps: cannot write ${step.out}`);
      this.files.add(step.out);
      return "48213";
    }
    if (container === `plausible-db-${UUID}`) {
      assert.equal(rest.at(-1), "plausible_db");
      return this.postgres(step.input ?? "");
    }
    if (container === `plausible-events-db-${UUID}`) {
      assert.equal(rest.at(-1), "plausible_events_db");
      return this.clickhouse(step.input ?? "");
    }
    throw new Error(`unexpected step ${step.argv.join(" ")}`);
  };

  postgres(sql: string): string {
    let m = /FROM sites WHERE domain IN \(([^)]*)\);/.exec(sql);
    if (m) {
      const domains = m[1].split(", ").map((d) => d.slice(1, -1));
      return lines([...this.sites.values()].filter((s) => domains.includes(String(s.domain))));
    }
    m = /SELECT to_jsonb\(g\) FROM goals g WHERE site_id IN \(([^)]*)\) ORDER BY id;/.exec(sql);
    if (m) {
      const ids = m[1].split(", ").map(Number);
      return lines(this.goals.filter((g) => ids.includes(g.site_id)));
    }
    m = /^UPDATE sites n SET .* WHERE n\.id = (\d+) AND o\.id = (\d+);/.exec(sql);
    if (m) {
      const n = this.sites.get(Number(m[1]));
      const o = this.sites.get(Number(m[2]));
      assert.ok(n && o);
      for (const field of ["native_stats_start_at", "stats_start_date"]) {
        const values = [n[field], o[field]].filter(Boolean) as string[];
        n[field] = values.sort()[0] ?? null;
      }
      return "";
    }
    m = /^SELECT count\(\*\) FROM sites WHERE id = (\d+);/.exec(sql);
    if (m) return `${this.sites.has(Number(m[1])) ? 1 : 0}\n`;
    throw new Error(`unexpected SQL ${sql}`);
  }

  clickhouse(input: string): string {
    const out: unknown[] = [];
    let sync = false;
    const statements: [RegExp, (m: RegExpExecArray) => void][] = [
      [
        /^SET mutations_sync = 2$/,
        () => {
          sync = true;
        },
      ],
      [
        /^SELECT '(\w+)' AS q, .* FROM (\w+) WHERE site_id (?:IN \(([^)]*)\)|= (\d+))( GROUP BY site_id)? FORMAT JSONEachRow$/,
        ([, q, table, list, single, grouped]) => {
          const ids = (list ?? single).split(", ").map(Number);
          const rows = this.table(table).filter((r) => ids.includes(r.site_id));
          const agg = (rs: Row[]) =>
            q === "events"
              ? rs.length
              : rs.reduce((sum, r) => sum + Number(q === "sessions" ? r.sign : r.value), 0);
          if (!grouped) return void out.push({ q, n: String(agg(rows)) });
          for (const id of ids) {
            const rs = rows.filter((r) => r.site_id === id);
            if (!rs.length) continue;
            const row: Record<string, unknown> = { q, site: String(id), n: String(agg(rs)) };
            if (q === "events") {
              const times = rs.map((r) => String(r.timestamp)).sort();
              row.visitors = String(new Set(rs.map((r) => r.user_id)).size);
              row.first = times[0];
              row.last = times.at(-1);
            }
            out.push(row);
          }
        },
      ],
      [
        /^SELECT 'table' AS q, name FROM system\.tables /,
        () => {
          for (const name of this.tables.keys())
            if (/^(imported|premerge)_/.test(name)) out.push({ q: "table", name });
        },
      ],
      [
        /^SELECT '(\w+)' AS t, count\(\) AS n FROM (\w+) WHERE site_id = (\d+) FORMAT JSONEachRow$/,
        ([, t, table, site]) => {
          assert.equal(t, table);
          out.push({ t, n: String(this.count(table, Number(site))) });
        },
      ],
      [
        /^CREATE TABLE (\w+) AS (\w+)$/,
        ([, backup, source]) => {
          if (this.tables.has(backup))
            throw new Error(`Backup host shared-vps: Table ${backup} already exists.`);
          this.table(source);
          this.tables.set(backup, []);
        },
      ],
      [
        /^INSERT INTO (\w+) SELECT \* FROM (\w+) WHERE site_id IN \(([^)]*)\)$/,
        ([, target, source, list]) => {
          const ids = list.split(", ").map(Number);
          const rows = this.table(source).filter((r) => ids.includes(r.site_id));
          this.table(target).push(...rows.map((r) => ({ ...r })));
        },
      ],
      [
        /^INSERT INTO (\w+) SELECT \* REPLACE \((\d+) AS site_id(?:, '([^']*)' AS domain)?\) FROM (\w+) WHERE site_id = (\d+)$/,
        ([, target, to, domain, source, from]) => {
          if (target === "ingest_counters")
            assert.ok(domain, "ingest_counters gets the new domain");
          const copies = this.table(source)
            .filter((r) => r.site_id === Number(from))
            .map((r) => ({ ...r, site_id: Number(to), ...(domain ? { domain } : {}) }));
          this.table(target).push(...copies);
        },
      ],
      [
        /^ALTER TABLE (\w+) DELETE WHERE site_id = (\d+)$/,
        ([, table, site]) => {
          assert.ok(sync, "ALTER … DELETE runs with mutations_sync = 2");
          this.mutationsSync = true;
          this.tables.set(
            table,
            this.table(table).filter((r) => r.site_id !== Number(site)),
          );
        },
      ],
    ];
    for (const sql of input.split(";\n").map((s) => s.trim())) {
      if (!sql) continue;
      const hit = statements.find(([re]) => re.test(sql));
      if (!hit) throw new Error(`unexpected ClickHouse SQL ${sql}`);
      hit[1](hit[0].exec(sql) as RegExpExecArray);
    }
    return lines(out);
  }

  rpc(expression: string): string {
    const id = Number(/Plausible\.Repo\.get!\(Plausible\.Site, (\d+)\)/.exec(expression)?.[1]);
    const site = this.sites.get(id);
    if (!site) throw new Error("Backup host shared-vps: ** (Ecto.NoResultsError)");
    const domain = /true = site\.domain == "([^"]+)"/.exec(expression)?.[1];
    if (domain !== site.domain) throw new Error("Backup host shared-vps: ** (MatchError)");
    const payload = /Base\.decode64!\("([^"]+)"\)/.exec(expression)?.[1];
    if (payload && expression.includes("Plausible.Goals.create(site, params)")) {
      for (const params of JSON.parse(Buffer.from(payload, "base64").toString()))
        this.goals.push(goal(this.nextGoalId++, id, params));
      return "created\n";
    }
    if (expression.includes("{:ok, _} = Plausible.Site.Removal.run(site)")) {
      this.sites.delete(id);
      this.goals = this.goals.filter((g) => g.site_id !== id);
      return "removed\n";
    }
    throw new Error(`unexpected rpc ${expression}`);
  }

  table(name: string): Row[] {
    const rows = this.tables.get(name);
    if (!rows) throw new Error(`Backup host shared-vps: Table ${name} does not exist.`);
    return rows;
  }

  /** Steps that change something. */
  writes(): string[] {
    return this.steps.flatMap((step) => {
      if (step.out || step.mkdir) return [`dump ${step.out}`];
      if (step.argv.includes("rpc"))
        return [step.argv.at(-1)?.includes("Removal") ? "rpc removal" : "rpc goals"];
      const sql = step.input ?? "";
      return sql
        .split(";\n")
        .map((s) => s.trim())
        .filter((s) => /^(UPDATE|INSERT|CREATE|ALTER|DELETE|DROP)/.test(s))
        .map((s) => s.split(" ").slice(0, 3).join(" "));
    });
  }

  count(table: string, site: number, field?: string) {
    const rows = this.table(table).filter((r) => r.site_id === site);
    return field ? rows.reduce((sum, r) => sum + Number(r[field]), 0) : rows.length;
  }
}

function goal(id: number, site: number, params: Partial<Goal>): Goal {
  return {
    id,
    site_id: site,
    event_name: params.event_name ?? null,
    page_path: params.page_path ?? null,
    scroll_threshold: params.scroll_threshold ?? -1,
    display_name: params.display_name ?? params.event_name ?? `Visit ${params.page_path}`,
    custom_props: params.custom_props ?? {},
  };
}

function events(site: number, start: string, n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    site_id: site,
    timestamp: start.replace(/\d\d$/, String(Number(start.slice(-2)) + i).padStart(2, "0")),
    user_id: site * 1000 + i,
  }));
}

const lines = (rows: unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join("");

getStore().set("providers.backups", {
  status: "configured",
  repositoryBase: "s3:https://account.eu.r2.cloudflarestorage.com/backups",
  hosts: {
    "shared-vps": { transport: "tailscale", target: "root@shared-vps", serverUuid: "shared-uuid" },
  },
  autoRegister: false,
});

function deps(host: FakeHost, extra: Record<string, unknown> = {}) {
  const log: string[] = [];
  return {
    log,
    deps: {
      runnerFor: () => host.run,
      log: (line: string) => log.push(line),
      now: () => NOW,
      confirm: async () => {
        throw new Error("prompted");
      },
      ...extra,
    },
  };
}

async function refused(host: FakeHost, args: string[], pattern: RegExp) {
  await assert.rejects(runPlausibleMerge(args, deps(host).deps), pattern);
  assert.deepEqual(host.writes(), [], `no write before a refusal (${args.join(" ")})`);
}

// --- container names and domains ---------------------------------------------
assert.deepEqual(
  plausibleStacks([
    `plausible-${UUID}`,
    `plausible-db-${UUID}`,
    `plausible-events-db-${UUID}`,
    "plausible-abc",
    "plausible-db-abc",
    "plausible-db-zzz",
    "plausible-events-db-zzz",
  ]),
  [
    {
      uuid: UUID,
      app: `plausible-${UUID}`,
      db: `plausible-db-${UUID}`,
      eventsDb: `plausible-events-db-${UUID}`,
    },
  ],
  "only a uuid with all three containers is a Plausible service",
);
assert.equal(normalizeDomain("  Beauty.Trebeljahr.COM "), OLD);
for (const bad of ["beauty'.trebeljahr.com", "localhost", "a.com/x", "-a.com", ""])
  assert.throws(() => normalizeDomain(bad), /Not a site domain/);

// --- dry run: every read, no write -------------------------------------------
{
  const host = new FakeHost();
  const { log, deps: d } = deps(host);
  const plan = (await runPlausibleMerge([OLD, NEW, "--dry-run"], d)) as MergePlan;
  assert.deepEqual(host.writes(), []);
  assert.equal(plan.old.id, 10);
  assert.equal(plan.new.id, 19);
  assert.equal(plan.overlap, false);
  assert.equal(plan.backupDir, "/root/plausible-site-merge-2026-10-19");
  assert.equal(plan.dumpFile, "plausible-db-site10-041102.pgdump");
  assert.deepEqual(plan.backupTables, {
    events_v2: "premerge_20261019_site10_events_v2",
    sessions_v2: "premerge_20261019_site10_sessions_v2",
    ingest_counters: "premerge_20261019_site10_ingest_counters",
  });
  assert.deepEqual(plan.old.stats, {
    events: 4,
    sessions: 2,
    visitors: 4,
    counters: 4,
    first: "2026-05-13 08:21:32",
    last: "2026-10-17 02:25:33",
  });
  assert.deepEqual(plan.startDates, [
    { field: "native_stats_start_at", from: "2026-10-17T02:49:13", to: "2026-05-13T08:21:32" },
    { field: "stats_start_date", from: "2026-10-17", to: "2026-05-13" },
  ]);
  // "Signup" is on both sites: only the four the new site lacks are created.
  assert.deepEqual(plan.goals, [
    { event_name: "Outbound Link: Click", display_name: "Outbound Link: Click" },
    { event_name: "File Download", display_name: "File Download" },
    { event_name: "404", display_name: "404" },
    { page_path: "/pricing", scroll_threshold: 50, display_name: "Pricing read" },
  ]);
  assert.match(plan.notes.join("\n"), /Timezones differ.*keeps Australia\/Sydney/);
  const text = log.join("\n");
  assert.match(text, /Plausible merge on shared-vps \(plausible-c8378br07og1w4ta45uxh57l\)/);
  assert.match(
    text,
    /1\. pg_dump -Fc of plausible_db to \/root\/plausible-site-merge-2026-10-19\//,
  );
  assert.match(
    text,
    /Create goals on collectionofbeauty\.com: Outbound Link: Click, File Download, 404, Pricing read/,
  );
  assert.match(text, /Dry run: nothing written\./);
}

// --- the merge ----------------------------------------------------------------
{
  const host = new FakeHost();
  const before = { events: host.count("events_v2", 19) + host.count("events_v2", 10) };
  const { log, deps: d } = deps(host);
  const result = (await runPlausibleMerge([OLD, NEW, "--yes"], d)) as MergeResult;

  assert.deepEqual(host.writes(), [
    "dump /root/plausible-site-merge-2026-10-19/plausible-db-site10-041102.pgdump",
    "CREATE TABLE premerge_20261019_site10_events_v2",
    "INSERT INTO premerge_20261019_site10_events_v2",
    "CREATE TABLE premerge_20261019_site10_sessions_v2",
    "INSERT INTO premerge_20261019_site10_sessions_v2",
    "CREATE TABLE premerge_20261019_site10_ingest_counters",
    "INSERT INTO premerge_20261019_site10_ingest_counters",
    "INSERT INTO events_v2",
    "INSERT INTO sessions_v2",
    "INSERT INTO ingest_counters",
    "UPDATE sites n",
    "rpc goals",
    "rpc removal",
    "ALTER TABLE events_v2",
    "ALTER TABLE sessions_v2",
    "ALTER TABLE ingest_counters",
  ]);
  assert.equal(host.steps.find((s) => s.out)?.mkdir, "/root/plausible-site-merge-2026-10-19");
  assert.ok(host.mutationsSync);

  // ClickHouse: everything of site 10 now belongs to site 19, nothing else moved.
  assert.equal(host.count("events_v2", 19), before.events);
  assert.equal(host.count("events_v2", 10), 0);
  assert.equal(host.count("events_v2", 7), 4);
  assert.equal(host.count("sessions_v2", 19, "sign"), 3);
  assert.equal(host.count("ingest_counters", 19, "value"), 6);
  assert.deepEqual(
    [
      ...new Set(
        host
          .table("ingest_counters")
          .filter((r) => r.site_id === 19)
          .map((r) => r.domain),
      ),
    ],
    [NEW],
  );
  // The backups hold both sites as they were.
  assert.equal(host.count("premerge_20261019_site10_events_v2", 10), 4);
  assert.equal(host.count("premerge_20261019_site10_events_v2", 19), 2);
  assert.equal(host.count("premerge_20261019_site10_events_v2", 7), 0);

  // Postgres: old site gone, start dates moved back, goals carried.
  assert.equal(host.sites.has(10), false);
  assert.equal(host.sites.get(19)?.native_stats_start_at, "2026-05-13T08:21:32");
  assert.equal(host.sites.get(19)?.stats_start_date, "2026-05-13");
  assert.deepEqual(
    host.goals.filter((g) => g.site_id === 19).map((g) => g.display_name),
    ["Signup", "Outbound Link: Click", "File Download", "404", "Pricing read"],
  );
  assert.equal(host.goals.find((g) => g.display_name === "Pricing read")?.scroll_threshold, 50);

  assert.deepEqual(result.copied, { events: 4, sessions: 2, counters: 4 });
  assert.deepEqual(
    {
      events: result.new.after.events,
      sessions: result.new.after.sessions,
      visitors: result.new.after.visitors,
    },
    { events: 6, sessions: 3, visitors: 6 },
  );
  assert.equal(result.old.after.events, 0);
  assert.equal(result.backups.dumpBytes, 48213);
  const text = log.join("\n");
  assert.match(text, /✓ beauty\.trebeljahr\.com merged into collectionofbeauty\.com/);
  assert.match(text, /collectionofbeauty\.com after\s+6\s+3\s+6/);

  // Run again: the old site is gone, so nothing happens.
  host.steps = [];
  await refused(host, [OLD, NEW, "--yes"], /has no site beauty\.trebeljahr\.com/);
}

// --- refusals: nothing is written ---------------------------------------------
{
  const host = new FakeHost();
  host.sites.delete(19);
  await refused(
    host,
    [OLD, NEW, "--dry-run"],
    /no site collectionofbeauty\.com\. Both sites must exist/,
  );
}
{
  // site 19 recorded a pageview while site 10 still did.
  const host = new FakeHost();
  host.table("events_v2").push({ site_id: 19, timestamp: "2026-10-17 01:00:00", user_id: 1 });
  await refused(host, [OLD, NEW, "--yes"], /overlap in time.*--allow-overlap/);
  const plan = (await runPlausibleMerge(
    [OLD, NEW, "--dry-run", "--allow-overlap"],
    deps(host).deps,
  )) as MergePlan;
  assert.equal(plan.overlap, true);
  assert.match(plan.notes[0], /count twice/);
  assert.deepEqual(host.writes(), []);
}
{
  // The arguments the other way round: the merge would delete the live site.
  const host = new FakeHost();
  await refused(
    host,
    [NEW, OLD, "--dry-run"],
    /all come after beauty\.trebeljahr\.com's.*did you swap the domains\?/,
  );
}
{
  // An old site that still receives traffic: allowed, with a note.
  const host = new FakeHost();
  host.table("events_v2").push({ site_id: 10, timestamp: "2026-10-17 02:30:00", user_id: 1 });
  host.tables.set(
    "events_v2",
    host.table("events_v2").filter((r) => r.site_id !== 19),
  );
  const plan = (await runPlausibleMerge(
    [OLD, NEW, "--dry-run"],
    deps(host, { now: () => new Date("2026-10-17T03:00:00Z") }).deps,
  )) as MergePlan;
  assert.match(plan.notes.join("\n"), /recorded an event at 2026-10-17 02:30:00 UTC.*lost/);
}
{
  const host = new FakeHost();
  host.table("imported_pages").push({ site_id: 10 }, { site_id: 10 });
  await refused(host, [OLD, NEW, "--yes"], /holds imported data \(imported_pages: 2\)/);
}
{
  const host = new FakeHost();
  host.tables.set("premerge_20261018_site10_events_v2", []);
  await refused(host, [OLD, NEW, "--yes"], /already started: premerge_20261018_site10_events_v2/);
}
{
  const host = new FakeHost();
  host.goals.push(goal(7, 19, { event_name: "Download", display_name: "File Download" }));
  await refused(host, [OLD, NEW, "--yes"], /another goal named "File Download"/);
}
{
  const host = new FakeHost();
  host.containers.push("plausible-second", "plausible-db-second", "plausible-events-db-second");
  await refused(host, [OLD, NEW, "--dry-run"], /Several Plausible services.*--service <uuid>/);
  const plan = (await runPlausibleMerge(
    [OLD, NEW, "--dry-run", "--service", UUID],
    deps(host).deps,
  )) as MergePlan;
  assert.equal(plan.stack.uuid, UUID);
  await refused(
    host,
    [OLD, NEW, "--dry-run", "--service", "nope"],
    /No running Plausible service nope/,
  );
}
{
  const host = new FakeHost();
  host.containers = ["coolify"];
  await refused(host, [OLD, NEW, "--dry-run"], /No running Plausible service on shared-vps/);
}
{
  const host = new FakeHost();
  await refused(host, [OLD, OLD, "--dry-run"], /same site/);
  await refused(host, [OLD, "--dry-run"], /Usage:/);
  await refused(host, [OLD, NEW, "--force"], /Unknown or incomplete option: --force/);
  await refused(host, [OLD, NEW, "--json"], /--json prints no prompt/);
  assert.equal(host.steps.length, 0, "argument errors never reach the host");
  // Answering no at the prompt writes nothing.
  const { log, deps: d } = deps(host, { confirm: async () => false });
  await runPlausibleMerge([OLD, NEW], d);
  assert.deepEqual(host.writes(), []);
  assert.match(log.join("\n"), /Cancelled\. Nothing written\./);
}

// --- failures after the first write: stop, say how to undo ------------------
{
  // The copy fails: site 10 stays, the error carries the rollback.
  const host = new FakeHost();
  host.failOn = /INSERT INTO events_v2 SELECT \* REPLACE/;
  const error = await runPlausibleMerge([OLD, NEW, "--yes"], deps(host).deps).then(
    () => assert.fail("expected the merge to stop"),
    (e: Error & { hint?: string[] }) => e,
  );
  assert.match(
    error.message,
    /Copying site 10's rows failed: Backup host shared-vps: injected failure/,
  );
  assert.match(error.hint?.join("\n") ?? "", /premerge_20261019_site10_events_v2/);
  assert.ok(host.sites.has(10));
  assert.equal(host.count("events_v2", 10), 4);
  assert.ok(!host.writes().some((w) => w.startsWith("rpc") || w.startsWith("ALTER")));
  // A rerun sees the backup tables and refuses instead of copying twice.
  host.failOn = null;
  host.steps = [];
  await refused(host, [OLD, NEW, "--yes"], /already started/);
}
{
  // The backup fails half-way: nothing copied, and the hint says what to drop.
  const host = new FakeHost();
  host.failOn = /INSERT INTO premerge_20261019_site10_sessions_v2/;
  const error = await runPlausibleMerge([OLD, NEW, "--yes"], deps(host).deps).then(
    () => assert.fail("expected the merge to stop"),
    (e: Error & { hint?: string[] }) => e,
  );
  assert.match(error.message, /The ClickHouse backup failed/);
  assert.match(
    error.hint?.join("\n") ?? "",
    /DROP TABLE IF EXISTS premerge_20261019_site10_events_v2/,
  );
  assert.equal(host.count("events_v2", 19), 2);
}
{
  // Removal fails: ClickHouse rows of site 10 are not deleted.
  const host = new FakeHost();
  host.failOn = /Removal\.run/;
  const error = await runPlausibleMerge([OLD, NEW, "--yes"], deps(host).deps).then(
    () => assert.fail("expected the merge to stop"),
    (e: Error & { hint?: string[] }) => e,
  );
  assert.match(error.message, /injected failure/);
  const hint = error.hint?.join("\n") ?? "";
  assert.match(hint, /pg_restore/);
  assert.match(hint, /sites\.native_stats_start_at of site 19 was 2026-10-17T02:49:13/);
  assert.match(
    hint,
    /goals created on site 19: Outbound Link: Click, File Download, 404, Pricing read/,
  );
  assert.match(
    hint,
    /ALTER TABLE events_v2 DELETE WHERE site_id = 19 AND timestamp <= '2026-10-17 02:25:33'/,
  );
  assert.ok(host.sites.has(10));
  assert.equal(host.count("events_v2", 10), 4);
  assert.ok(!host.writes().some((w) => w.startsWith("ALTER")));
}

// --- host selection -----------------------------------------------------------
{
  const shared = new FakeHost();
  const dedicated = new FakeHost();
  dedicated.containers = ["coolify", "listmonk-abc"];
  const meta = { transport: "tailscale" as const };
  getStore().set("providers.backups", {
    status: "configured",
    repositoryBase: "s3:https://account.eu.r2.cloudflarestorage.com/backups",
    hosts: {
      "dedicated-vps": { ...meta, target: "root@dedicated-vps", serverUuid: "dedicated-uuid" },
      "shared-vps": { ...meta, target: "root@shared-vps", serverUuid: "shared-uuid" },
    },
    autoRegister: false,
  });
  const runnerFor = (h: { name: string }) => (h.name === "shared-vps" ? shared.run : dedicated.run);
  const plan = (await runPlausibleMerge([OLD, NEW, "--dry-run"], {
    ...deps(shared).deps,
    runnerFor,
  })) as MergePlan;
  assert.equal(plan.host, "shared-vps", "the one host that runs Plausible");
  await assert.rejects(
    runPlausibleMerge([OLD, NEW, "--dry-run", "--host", "dedicated-vps"], {
      ...deps(shared).deps,
      runnerFor,
    }),
    /No running Plausible service on dedicated-vps/,
  );
  dedicated.containers = shared.containers;
  await assert.rejects(
    runPlausibleMerge([OLD, NEW, "--dry-run"], { ...deps(shared).deps, runnerFor }),
    /Plausible runs on several backup hosts \(dedicated-vps, shared-vps\)\. Pass --host <name>\./,
  );
}

// --- over Tailscale SSH: the Python runner with a fake docker ------------------
const dir = mkdtempSync(join(tmpdir(), "hatchkit-plausible-merge-"));
try {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_DIR = dir;
  // `tailscale ssh <target> <command>` runs the command here, as the host's shell would.
  writeFileSync(
    join(bin, "tailscale"),
    `#!/bin/sh\nprintf '%s\\n' "$1" "$2" > "${dir}/ssh"\nshift 2\nexec sh -c "$1"\n`,
  );
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env python3
import json, os, sys
data = sys.stdin.read()
with open(os.path.join(os.environ["FAKE_DIR"], "docker.json"), "w") as f:
    json.dump({"argv": sys.argv[1:], "stdin": data}, f)
mode = os.environ.get("FAKE_DOCKER", "ok")
if mode == "fail":
    sys.stderr.write("psql: warming up\\nERROR:  relation \\"sites\\" does not exist\\n")
    sys.exit(3)
sys.stdout.write("dump-bytes" if mode == "dump" else "1|row\\n")
`,
  );
  chmodSync(join(bin, "tailscale"), 0o755);
  chmodSync(join(bin, "docker"), 0o755);
  const run = hostRunner({
    name: "shared-vps",
    transport: "tailscale",
    target: "root@shared-vps",
    serverUuid: "shared-uuid",
  });
  const seen = () => JSON.parse(readFileSync(join(dir, "docker.json"), "utf8"));

  // argv arrives as a list: quotes, $ and newlines are not the shell's.
  const tricky = ["docker", "exec", "c", "rpc", `IO.puts("a'b $HOME")\nok`];
  assert.equal(await run({ argv: tricky, input: "SELECT 1;\n" }), "1|row\n");
  assert.deepEqual(seen(), { argv: tricky.slice(1), stdin: "SELECT 1;\n" });
  assert.deepEqual(readFileSync(join(dir, "ssh"), "utf8").split("\n").slice(0, 2), [
    "ssh",
    "root@shared-vps",
  ]);

  // An out step writes the file and returns its size; it never overwrites.
  process.env.FAKE_DOCKER = "dump";
  const out = join(dir, "backup", "plausible-db.pgdump");
  assert.equal(
    await run({ argv: ["docker", "exec", "db"], mkdir: join(dir, "backup"), out }),
    "10",
  );
  assert.equal(readFileSync(out, "utf8"), "dump-bytes");
  await assert.rejects(
    run({ argv: ["docker", "exec", "db"], out }),
    /cannot write .*plausible-db\.pgdump: File exists/,
  );

  // A failing command: its stderr tail is the error, a partial dump is removed.
  process.env.FAKE_DOCKER = "fail";
  await assert.rejects(
    run({ argv: ["docker", "exec", "db"], input: "SELECT 1;" }),
    /Backup host shared-vps: psql: warming up \/ ERROR: {2}relation "sites" does not exist/,
  );
  const partial = join(dir, "backup", "second.pgdump");
  await assert.rejects(run({ argv: ["docker", "exec", "db"], out: partial }), /relation "sites"/);
  assert.equal(existsSync(partial), false);
} finally {
  delete process.env.FAKE_DOCKER;
  rmSync(dir, { recursive: true, force: true });
}

console.log("plausible merge: all checks passed");
