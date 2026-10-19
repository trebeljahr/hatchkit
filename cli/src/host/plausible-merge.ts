/*
 * `hatchkit plausible merge <old-domain> <new-domain>` — fold one Plausible
 * Community Edition site into another site that already exists, history
 * included.
 *
 * When a project changes domain, the new domain usually has its own site by
 * the time anyone looks, and the old site (now a redirect) holds the
 * history. `plausible rename` cannot help: it calls the Sites API, which CE
 * never serves, and a rename cannot target a domain that already has a
 * site. Plausible has no merge. On 2026-10-19 two such sites were merged by
 * hand in ClickHouse and Postgres (ai-work-notes:
 * projects/hatchkit/plausible-site-merge-2026-10-19.md). This is that
 * recipe, run over Tailscale SSH on the backup host that runs Plausible:
 *
 *  1. Resolve both sites in Postgres. Refuse when one is missing, when the
 *     two sites' event time ranges overlap (the copy would double-count;
 *     `--allow-overlap` accepts it), when the old site's events all come
 *     after the new site's (swapped domains: the live site would be
 *     deleted), when the old site holds imported data
 *     (Plausible's ClickhouseCleanSites worker deletes `imported_*` rows of
 *     a deleted site, and the import belongs to the old site's
 *     `site_imports`), and when backup tables of an earlier merge of the old
 *     site exist (a rerun after a partial failure would copy twice).
 *  2. Back up: a full `pg_dump -Fc` under /root/plausible-site-merge-<date>/
 *     and the two sites' rows of events_v2, sessions_v2 and ingest_counters
 *     in `premerge_<date>_site<old>_*` tables.
 *  3. Copy the old site's rows from the backup tables with
 *     `SELECT * REPLACE (<new> AS site_id)` (ingest_counters also gets the
 *     new domain), and check the copy before anything is deleted.
 *  4. Move the new site's native_stats_start_at / stats_start_date back to
 *     the old site's when they are earlier, or the dashboard hides the old
 *     events.
 *  5. Create the goals the new site lacks with Plausible.Goals.create.
 *  6. Delete the old site with Plausible.Site.Removal.run/1, then its
 *     ClickHouse rows (`mutations_sync = 2`).
 *  7. Compare the counts before and after.
 *
 * Every database command runs through `docker exec` from a small Python
 * runner on the host: argv lists, SQL on stdin, no shell quoting between
 * here and the database. Plausible's containers are found by name
 * (`plausible-<uuid>`, `plausible-db-<uuid>`, `plausible-events-db-<uuid>`),
 * the database names are read from the app container's DATABASE_URL and
 * CLICKHOUSE_DATABASE_URL inside the container, so the Postgres password
 * never leaves it.
 */
import { type BackupHost, backupHost, backupHostExec, backupHosts } from "../backups/provider.js";

/** One command on the host. */
export interface HostStep {
  argv: string[];
  /** Sent to the command's stdin. */
  input?: string;
  /** Write stdout to this host path instead of returning it. Refuses an
   *  existing file and removes a partial one when the command fails. */
  out?: string;
  /** Create this host directory (mode 0700) first. */
  mkdir?: string;
}

/** Runs one step and returns its stdout (for an `out` step: the size in
 *  bytes of the file written). Rejects with the command's stderr tail. */
export type HostRunner = (step: HostStep, timeoutMs?: number) => Promise<string>;

const RUNNER = String.raw`
import json, os, subprocess, sys

step = P["step"]


def done(ok, **fields):
    print(json.dumps(dict(ok=ok, **fields)))
    sys.exit(0 if ok else 1)


if step.get("mkdir"):
    os.makedirs(step["mkdir"], mode=0o700, exist_ok=True)
sink = subprocess.PIPE
if step.get("out"):
    try:
        sink = open(step["out"], "xb")
    except OSError as error:
        done(False, error="cannot write %s: %s" % (step["out"], error.strerror))
try:
    proc = subprocess.run(
        step["argv"],
        input=step.get("input", "").encode(),
        stdout=sink,
        stderr=subprocess.PIPE,
    )
except OSError as error:
    done(False, error="%s: %s" % (step["argv"][0], error.strerror))
finally:
    if sink is not subprocess.PIPE:
        sink.close()
if proc.returncode != 0:
    if step.get("out"):
        os.unlink(step["out"])
    lines = proc.stderr.decode("utf-8", "replace").strip().splitlines()
    done(False, error=" / ".join(lines[-6:]) or "%s exited %d" % (step["argv"][0], proc.returncode))
if step.get("out"):
    done(True, stdout=str(os.path.getsize(step["out"])))
done(True, stdout=proc.stdout.decode("utf-8", "replace"))
`;

// `python3 -c` with the runner and the step as JSON on stdin. No single
// quote: the remote shell sees it inside one.
const BOOT =
  'import json,sys;p=json.load(sys.stdin);exec(compile(p["script"],"plausible-merge.py","exec"),{"__name__":"__main__","P":p})';

export function hostRunner(host: BackupHost): HostRunner {
  return async (step, timeoutMs = 120_000) => {
    const stdout = await backupHostExec(
      host,
      `python3 -c '${BOOT}'`,
      JSON.stringify({ script: RUNNER, step }),
      timeoutMs,
    );
    return (JSON.parse(stdout.trim().split("\n").pop() ?? "") as { stdout: string }).stdout;
  };
}

// --- containers ------------------------------------------------------------

export interface PlausibleStack {
  uuid: string;
  app: string;
  db: string;
  eventsDb: string;
}

export interface ResolvedStack extends PlausibleStack {
  pgDatabase: string;
  chDatabase: string;
}

/** Coolify's Plausible service, by container name: all three containers of
 *  one uuid, or nothing. */
export function plausibleStacks(names: string[]): PlausibleStack[] {
  const set = new Set(names.map((name) => name.trim()).filter(Boolean));
  const stacks: PlausibleStack[] = [];
  for (const name of [...set].sort()) {
    const uuid = /^plausible-([a-z0-9]+)$/.exec(name)?.[1];
    if (!uuid) continue;
    const db = `plausible-db-${uuid}`;
    const eventsDb = `plausible-events-db-${uuid}`;
    if (set.has(db) && set.has(eventsDb)) stacks.push({ uuid, app: name, db, eventsDb });
  }
  return stacks;
}

const listContainers: HostStep = { argv: ["docker", "ps", "--format", "{{.Names}}"] };

async function findStacks(run: HostRunner): Promise<PlausibleStack[]> {
  return plausibleStacks((await run(listContainers)).split("\n"));
}

function chooseStack(stacks: PlausibleStack[], uuid: string | undefined, where: string) {
  if (uuid) {
    const stack = stacks.find((s) => s.uuid === uuid);
    if (!stack)
      throw new Error(
        `No running Plausible service ${uuid} on ${where} (found: ${stacks.map((s) => s.uuid).join(", ") || "none"}).`,
      );
    return stack;
  }
  if (stacks.length === 1) return stacks[0];
  if (!stacks.length)
    throw new Error(
      `No running Plausible service on ${where}: expected containers plausible-<uuid>, plausible-db-<uuid> and plausible-events-db-<uuid>.`,
    );
  throw new Error(
    `Several Plausible services run on ${where} (${stacks.map((s) => s.uuid).join(", ")}). Pass --service <uuid>.`,
  );
}

/** The database names, read inside the app container. */
async function resolveDatabases(run: HostRunner, stack: PlausibleStack): Promise<ResolvedStack> {
  const out = await run({
    argv: [
      "docker",
      "exec",
      stack.app,
      "sh",
      "-c",
      'printf "%s\\n" "${DATABASE_URL##*/}" "${CLICKHOUSE_DATABASE_URL##*/}"',
    ],
  });
  const [pg, ch] = out.split("\n").map((line) => line.replace(/\?.*$/, "").trim());
  const valid = (name: string | undefined) => !!name && /^[A-Za-z0-9_]+$/.test(name);
  if (!valid(pg) || !valid(ch))
    throw new Error(
      `Could not read the database names from DATABASE_URL and CLICKHOUSE_DATABASE_URL in ${stack.app}.`,
    );
  return { ...stack, pgDatabase: pg, chDatabase: ch };
}

// --- database access -------------------------------------------------------

function psql(stack: ResolvedStack, sql: string): HostStep {
  return {
    argv: [
      "docker",
      "exec",
      "-i",
      stack.db,
      "sh",
      "-c",
      'exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$1"',
      "sh",
      stack.pgDatabase,
    ],
    input: sql,
  };
}

function clickhouse(stack: ResolvedStack, sql: string): HostStep {
  return {
    argv: [
      "docker",
      "exec",
      "-i",
      stack.eventsDb,
      "sh",
      "-c",
      'exec clickhouse-client ${CLICKHOUSE_USER:+--user "$CLICKHOUSE_USER"} ${CLICKHOUSE_PASSWORD:+--password "$CLICKHOUSE_PASSWORD"} --multiquery --database "$1"',
      "sh",
      stack.chDatabase,
    ],
    input: sql,
  };
}

function rpc(stack: ResolvedStack, expression: string): HostStep {
  return { argv: ["docker", "exec", stack.app, "/app/bin/plausible", "rpc", expression] };
}

function pgDump(stack: ResolvedStack, dir: string, file: string): HostStep {
  return {
    argv: [
      "docker",
      "exec",
      stack.db,
      "sh",
      "-c",
      'exec pg_dump -U "${POSTGRES_USER:-postgres}" -Fc "$1"',
      "sh",
      stack.pgDatabase,
    ],
    mkdir: dir,
    out: `${dir}/${file}`,
  };
}

const jsonLines = (out: string) =>
  out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const sqlText = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const pgText = (value: string) => `'${value.replace(/'/g, "''")}'`;

// --- reads -----------------------------------------------------------------

export interface SiteStats {
  events: number;
  /** sum(sign) over sessions_v2, which survives the collapsing merges. */
  sessions: number;
  /** uniq(user_id) over events_v2 (approximate, like the dashboard). */
  visitors: number;
  /** sum(value) over ingest_counters (a SummingMergeTree: its row count
   *  shrinks as parts merge, the sum does not). */
  counters: number;
  first: string | null;
  last: string | null;
}

export interface Site {
  id: number;
  domain: string;
  timezone: string | null;
  nativeStatsStartAt: string | null;
  statsStartDate: string | null;
  stats: SiteStats;
}

export interface GoalParams {
  event_name?: string;
  page_path?: string;
  scroll_threshold?: number;
  display_name?: string;
  custom_props?: Record<string, string>;
}

interface GoalRow {
  id: number;
  site_id: number;
  event_name: string | null;
  page_path: string | null;
  scroll_threshold?: number | null;
  display_name?: string | null;
  custom_props?: Record<string, string> | null;
}

const goalKey = (goal: GoalRow | GoalParams) =>
  goal.event_name
    ? `event:${goal.event_name}`
    : `page:${goal.page_path}:${goal.scroll_threshold ?? -1}`;

export const goalLabel = (goal: GoalParams) =>
  goal.display_name ||
  goal.event_name ||
  `Visit ${goal.page_path}${(goal.scroll_threshold ?? -1) > -1 ? ` (scroll ${goal.scroll_threshold} %)` : ""}`;

function goalParams(goal: GoalRow): GoalParams {
  const params: GoalParams = goal.event_name
    ? { event_name: goal.event_name }
    : { page_path: goal.page_path ?? "/" };
  if (!goal.event_name && (goal.scroll_threshold ?? -1) > -1)
    params.scroll_threshold = goal.scroll_threshold ?? -1;
  if (goal.display_name) params.display_name = goal.display_name;
  if (goal.custom_props && Object.keys(goal.custom_props).length)
    params.custom_props = goal.custom_props;
  return params;
}

async function readSites(run: HostRunner, stack: ResolvedStack, domains: string[]) {
  const rows = jsonLines(
    await run(
      psql(
        stack,
        `SELECT json_build_object('id', id, 'domain', domain, 'timezone', timezone, 'native_stats_start_at', native_stats_start_at, 'stats_start_date', stats_start_date) FROM sites WHERE domain IN (${domains.map(pgText).join(", ")});\n`,
      ),
    ),
  );
  return new Map(
    rows.map((row) => [
      String(row.domain),
      {
        id: Number(row.id),
        domain: String(row.domain),
        timezone: (row.timezone as string | null) ?? null,
        nativeStatsStartAt: (row.native_stats_start_at as string | null) ?? null,
        statsStartDate: (row.stats_start_date as string | null) ?? null,
      },
    ]),
  );
}

async function readGoals(run: HostRunner, stack: ResolvedStack, ids: number[]) {
  return jsonLines(
    await run(
      psql(
        stack,
        `SELECT to_jsonb(g) FROM goals g WHERE site_id IN (${ids.join(", ")}) ORDER BY id;\n`,
      ),
    ),
  ) as unknown as GoalRow[];
}

const emptyStats = (): SiteStats => ({
  events: 0,
  sessions: 0,
  visitors: 0,
  counters: 0,
  first: null,
  last: null,
});

interface ClickhouseState {
  stats: Map<number, SiteStats>;
  tables: string[];
}

async function readClickhouse(
  run: HostRunner,
  stack: ResolvedStack,
  ids: number[],
): Promise<ClickhouseState> {
  const list = ids.join(", ");
  const rows = jsonLines(
    await run(
      clickhouse(
        stack,
        [
          `SELECT 'events' AS q, site_id AS site, count() AS n, uniq(user_id) AS visitors, toString(min(timestamp)) AS first, toString(max(timestamp)) AS last FROM events_v2 WHERE site_id IN (${list}) GROUP BY site_id FORMAT JSONEachRow;`,
          `SELECT 'sessions' AS q, site_id AS site, sum(sign) AS n FROM sessions_v2 WHERE site_id IN (${list}) GROUP BY site_id FORMAT JSONEachRow;`,
          `SELECT 'counters' AS q, assumeNotNull(site_id) AS site, sum(value) AS n FROM ingest_counters WHERE site_id IN (${list}) GROUP BY site_id FORMAT JSONEachRow;`,
          "SELECT 'table' AS q, name FROM system.tables WHERE database = currentDatabase() AND (startsWith(name, 'imported_') OR startsWith(name, 'premerge_')) FORMAT JSONEachRow;",
          "",
        ].join("\n"),
      ),
    ),
  );
  const stats = new Map(ids.map((id) => [id, emptyStats()]));
  const tables: string[] = [];
  for (const row of rows) {
    if (row.q === "table") {
      tables.push(String(row.name));
      continue;
    }
    const entry = stats.get(Number(row.site));
    if (!entry) continue;
    if (row.q === "events") {
      entry.events = Number(row.n);
      entry.visitors = Number(row.visitors);
      entry.first = String(row.first);
      entry.last = String(row.last);
    } else if (row.q === "sessions") entry.sessions = Number(row.n);
    else if (row.q === "counters") entry.counters = Number(row.n);
  }
  return { stats, tables: tables.sort() };
}

async function readImported(
  run: HostRunner,
  stack: ResolvedStack,
  tables: string[],
  siteId: number,
): Promise<Record<string, number>> {
  const imported = tables.filter((t) => /^imported_[a-z0-9_]+$/.test(t));
  if (!imported.length) return {};
  const rows = jsonLines(
    await run(
      clickhouse(
        stack,
        `${imported
          .map(
            (t) =>
              `SELECT '${t}' AS t, count() AS n FROM ${t} WHERE site_id = ${siteId} FORMAT JSONEachRow;`,
          )
          .join("\n")}\n`,
      ),
    ),
  );
  return Object.fromEntries(
    rows.filter((row) => Number(row.n) > 0).map((row) => [String(row.t), Number(row.n)]),
  );
}

// --- the plan --------------------------------------------------------------

export const MERGED_TABLES = ["events_v2", "sessions_v2", "ingest_counters"] as const;

export interface StartDateChange {
  field: "native_stats_start_at" | "stats_start_date";
  from: string | null;
  to: string;
}

export interface MergePlan {
  host: string;
  stack: ResolvedStack;
  old: Site;
  new: Site;
  overlap: boolean;
  backupDir: string;
  dumpFile: string;
  backupTables: Record<(typeof MERGED_TABLES)[number], string>;
  startDates: StartDateChange[];
  goals: GoalParams[];
  notes: string[];
}

export interface MergeOptions {
  oldDomain: string;
  newDomain: string;
  allowOverlap?: boolean;
  /** The Coolify uuid of the Plausible service, when the host runs several. */
  service?: string;
  now?: Date;
}

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function normalizeDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (!DOMAIN.test(domain)) throw new Error(`Not a site domain: ${JSON.stringify(value)}.`);
  return domain;
}

const earlier = (a: string | null, b: string | null) => (a && (!b || a < b) ? a : null);

/** Every read and check, no write. Throws when the merge must not run. */
export async function planMerge(
  run: HostRunner,
  host: string,
  options: MergeOptions,
): Promise<MergePlan> {
  const oldDomain = normalizeDomain(options.oldDomain);
  const newDomain = normalizeDomain(options.newDomain);
  if (oldDomain === newDomain) throw new Error("Old and new domain are the same site.");
  const now = options.now ?? new Date();

  const stack = await resolveDatabases(
    run,
    chooseStack(await findStacks(run), options.service, host),
  );
  const sites = await readSites(run, stack, [oldDomain, newDomain]);
  const missing = [oldDomain, newDomain].filter((d) => !sites.has(d));
  if (missing.length)
    throw new Error(
      `Plausible on ${host} has no site ${missing.join(" or ")}. Both sites must exist: merge folds the old site into the new one.`,
    );
  const oldRow = sites.get(oldDomain) as Omit<Site, "stats">;
  const newRow = sites.get(newDomain) as Omit<Site, "stats">;

  const ch = await readClickhouse(run, stack, [oldRow.id, newRow.id]);
  const old: Site = { ...oldRow, stats: ch.stats.get(oldRow.id) ?? emptyStats() };
  const next: Site = { ...newRow, stats: ch.stats.get(newRow.id) ?? emptyStats() };

  const earlierRun = ch.tables.filter((t) => new RegExp(`^premerge_\\d{8}_site${old.id}_`).test(t));
  if (earlierRun.length)
    throw new Error(
      `A merge of ${oldDomain} (site ${old.id}) already started: ${earlierRun.join(", ")} exist. Finish or undo it by hand (counts against the backup tables), then drop those tables.`,
    );

  const imported = await readImported(run, stack, ch.tables, old.id);
  if (Object.keys(imported).length)
    throw new Error(
      `${oldDomain} holds imported data (${Object.entries(imported)
        .map(([t, n]) => `${t}: ${n}`)
        .join(
          ", ",
        )}). merge does not carry imports, and deleting the site deletes them. Import the same data into ${newDomain} first, or merge by hand.`,
    );

  const o = old.stats;
  const n = next.stats;
  const overlap =
    !!(o.first && o.last && n.first && n.last) &&
    (o.first as string) <= (n.last as string) &&
    (n.first as string) <= (o.last as string);
  if (overlap && !options.allowOverlap)
    throw new Error(
      `The two sites' events overlap in time (${oldDomain} ${o.first} – ${o.last}, ${newDomain} ${n.first} – ${n.last}): a pageview tracked by both would count twice. Pass --allow-overlap to merge anyway.`,
    );
  // Without overlap, the old site's events come either before the new
  // site's (the domain moved) or after them: the arguments are swapped, and
  // the merge would delete the site that still receives traffic.
  if (!overlap && o.first && n.last && (o.first as string) > (n.last as string))
    throw new Error(
      `${oldDomain}'s events (${o.first} – ${o.last}) all come after ${newDomain}'s (${n.first} – ${n.last}). merge deletes the old site: did you swap the domains? The order is merge <old-domain> <new-domain>.`,
    );

  const goals = await readGoals(run, stack, [old.id, next.id]);
  const newGoals = goals.filter((g) => g.site_id === next.id);
  const have = new Set(newGoals.map(goalKey));
  const toCreate = goals
    .filter((g) => g.site_id === old.id && !have.has(goalKey(g)))
    .map(goalParams);
  const names = new Set(newGoals.map((g) => g.display_name).filter(Boolean));
  const clashes = toCreate.filter((g) => g.display_name && names.has(g.display_name));
  if (clashes.length)
    throw new Error(
      `${newDomain} already has another goal named ${clashes.map((g) => JSON.stringify(g.display_name)).join(", ")}. Rename one of them in the dashboard, then rerun.`,
    );

  const startDates: StartDateChange[] = [];
  const native = earlier(old.nativeStatsStartAt, next.nativeStatsStartAt);
  if (native)
    startDates.push({ field: "native_stats_start_at", from: next.nativeStatsStartAt, to: native });
  const statsStart = earlier(old.statsStartDate, next.statsStartDate);
  if (statsStart)
    startDates.push({ field: "stats_start_date", from: next.statsStartDate, to: statsStart });

  const iso = now.toISOString().slice(0, 10);
  const stamp = iso.replace(/-/g, "");
  const notes: string[] = [];
  if (overlap) notes.push("--allow-overlap: events both sites recorded will count twice.");
  if (old.timezone && next.timezone && old.timezone !== next.timezone)
    notes.push(
      `Timezones differ (${oldDomain} ${old.timezone}, ${newDomain} ${next.timezone}); ${newDomain} keeps ${next.timezone}.`,
    );
  if (!o.events)
    notes.push(`${oldDomain} has no events; only its goals and start date carry over.`);
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  if (o.last && o.last > hourAgo)
    notes.push(
      `${oldDomain} recorded an event at ${o.last} UTC: events it receives between the copy and the delete are lost. Its tracker must report ${newDomain}.`,
    );

  return {
    host,
    stack,
    old,
    new: next,
    overlap,
    backupDir: `/root/plausible-site-merge-${iso}`,
    dumpFile: `plausible-db-site${old.id}-${now.toISOString().slice(11, 19).replace(/:/g, "")}.pgdump`,
    backupTables: Object.fromEntries(
      MERGED_TABLES.map((t) => [t, `premerge_${stamp}_site${old.id}_${t}`]),
    ) as MergePlan["backupTables"],
    startDates,
    goals: toCreate,
    notes,
  };
}

/** The writes, in order, as one line each. */
export function plannedWrites(plan: MergePlan): string[] {
  const { old, new: next } = plan;
  const writes = [
    `pg_dump -Fc of ${plan.stack.pgDatabase} to ${plan.backupDir}/${plan.dumpFile}`,
    `ClickHouse backup of sites ${old.id} and ${next.id}: ${Object.values(plan.backupTables).join(", ")}`,
    `Copy site ${old.id}'s rows to site ${next.id} (${old.stats.events} events, ${old.stats.sessions} sessions; ingest_counters rows get the domain ${next.domain})`,
  ];
  for (const change of plan.startDates)
    writes.push(`Set ${next.domain} ${change.field} ${change.from ?? "(empty)"} → ${change.to}`);
  if (plan.goals.length)
    writes.push(`Create goals on ${next.domain}: ${plan.goals.map(goalLabel).join(", ")}`);
  writes.push(
    `Delete site ${old.id} (${old.domain}) with Plausible.Site.Removal.run/1, then its ClickHouse rows (mutations_sync = 2)`,
  );
  return writes;
}

// --- the merge -------------------------------------------------------------

export interface MergeResult {
  host: string;
  service: string;
  old: { id: number; domain: string; before: SiteStats; after: SiteStats };
  new: { id: number; domain: string; before: SiteStats; after: SiteStats };
  copied: { events: number; sessions: number; counters: number };
  backups: { dump: string; dumpBytes: number; tables: string[] };
  startDates: StartDateChange[];
  goalsCreated: string[];
  notes: string[];
}

/** An error after the first write: says what is already done and how to undo it. */
class MergeError extends Error {
  constructor(
    message: string,
    readonly hint: string[],
  ) {
    super(message);
  }
}

export function rollbackSteps(plan: MergePlan): string[] {
  const { old, new: next } = plan;
  const t = plan.backupTables;
  const steps = [
    `Undo on ${plan.host} (recipe: ai-work-notes projects/hatchkit/plausible-site-merge-2026-10-19.md):`,
    `  Postgres: if site ${old.id} is gone, restore it and its goals from ${plan.backupDir}/${plan.dumpFile} (pg_restore into a scratch database, copy the rows back).`,
  ];
  for (const change of plan.startDates)
    steps.push(
      `  Postgres: sites.${change.field} of site ${next.id} was ${change.from ?? "NULL"}.`,
    );
  if (plan.goals.length)
    steps.push(
      `  Postgres: goals created on site ${next.id}: ${plan.goals.map(goalLabel).join(", ")}.`,
    );
  // Without overlap every copied row is at or before the old site's last
  // event, and every row of the new site's own is after it.
  const last = old.stats.last;
  if (!plan.overlap && last)
    steps.push(
      `  ClickHouse: SET mutations_sync = 2; ALTER TABLE events_v2 DELETE WHERE site_id = ${next.id} AND timestamp <= '${last}' (sessions_v2 likewise, ingest_counters on event_timebucket).`,
    );
  else
    steps.push(
      `  ClickHouse: SET mutations_sync = 2; ALTER TABLE <t> DELETE WHERE site_id = ${next.id} for events_v2, sessions_v2, ingest_counters, then copy site ${next.id}'s rows back from the backups (rows it received after the backup are lost).`,
    );
  steps.push(
    `  ClickHouse: if site ${old.id}'s rows are gone, INSERT INTO <t> SELECT * FROM ${t.events_v2} WHERE site_id = ${old.id} (likewise ${t.sessions_v2}, ${t.ingest_counters}).`,
  );
  return steps;
}

async function siteStats(run: HostRunner, stack: ResolvedStack, ids: number[]) {
  return (await readClickhouse(run, stack, ids)).stats;
}

const check = (ok: boolean, message: string, hint: string[]) => {
  if (!ok) throw new MergeError(message, hint);
};

export async function applyMerge(
  run: HostRunner,
  plan: MergePlan,
  log: (line: string) => void = () => {},
): Promise<MergeResult> {
  const { stack, old, new: next } = plan;
  const undo = rollbackSteps(plan);
  const backup = plan.backupTables;

  log(`pg_dump → ${plan.backupDir}/${plan.dumpFile}`);
  const dumpBytes = Number(await run(pgDump(stack, plan.backupDir, plan.dumpFile), 600_000));

  log(`ClickHouse backup → ${Object.values(backup).join(", ")}`);
  const backedUp = jsonLines(
    await run(
      clickhouse(
        stack,
        [
          ...MERGED_TABLES.flatMap((t) => [
            `CREATE TABLE ${backup[t]} AS ${t};`,
            `INSERT INTO ${backup[t]} SELECT * FROM ${t} WHERE site_id IN (${old.id}, ${next.id});`,
          ]),
          `SELECT 'events' AS q, count() AS n FROM ${backup.events_v2} WHERE site_id = ${old.id} FORMAT JSONEachRow;`,
          `SELECT 'sessions' AS q, sum(sign) AS n FROM ${backup.sessions_v2} WHERE site_id = ${old.id} FORMAT JSONEachRow;`,
          `SELECT 'counters' AS q, sum(value) AS n FROM ${backup.ingest_counters} WHERE site_id = ${old.id} FORMAT JSONEachRow;`,
          "",
        ].join("\n"),
      ),
      600_000,
    ).catch((error: Error) => {
      throw new MergeError(`The ClickHouse backup failed: ${error.message}`, [
        `Nothing was copied. Drop the backup tables that exist (DROP TABLE IF EXISTS ${Object.values(backup).join(", ")}), then rerun.`,
      ]);
    }),
  );
  const copied = { events: 0, sessions: 0, counters: 0 };
  for (const row of backedUp) copied[row.q as keyof typeof copied] = Number(row.n);
  check(
    copied.events >= old.stats.events && copied.counters >= old.stats.counters,
    `The backup holds fewer rows of site ${old.id} than the plan counted (${copied.events} events, planned ${old.stats.events}). Nothing was copied; drop ${Object.values(backup).join(", ")} and rerun.`,
    [],
  );

  log(`Copy site ${old.id} → site ${next.id}`);
  await run(
    clickhouse(
      stack,
      [
        `INSERT INTO events_v2 SELECT * REPLACE (${next.id} AS site_id) FROM ${backup.events_v2} WHERE site_id = ${old.id};`,
        `INSERT INTO sessions_v2 SELECT * REPLACE (${next.id} AS site_id) FROM ${backup.sessions_v2} WHERE site_id = ${old.id};`,
        `INSERT INTO ingest_counters SELECT * REPLACE (${next.id} AS site_id, ${sqlText(next.domain)} AS domain) FROM ${backup.ingest_counters} WHERE site_id = ${old.id};`,
        "",
      ].join("\n"),
    ),
    600_000,
  ).catch((error: Error) => {
    throw new MergeError(`Copying site ${old.id}'s rows failed: ${error.message}`, undo);
  });
  const afterCopy = (await siteStats(run, stack, [next.id])).get(next.id) ?? emptyStats();
  check(
    afterCopy.events >= next.stats.events + copied.events &&
      afterCopy.counters >= next.stats.counters + copied.counters,
    `After the copy, site ${next.id} has ${afterCopy.events} events, expected at least ${next.stats.events + copied.events}. Site ${old.id} is untouched.`,
    undo,
  );

  try {
    if (plan.startDates.length) {
      log(`Start dates of site ${next.id}`);
      await run(
        psql(
          stack,
          `UPDATE sites n SET native_stats_start_at = LEAST(n.native_stats_start_at, o.native_stats_start_at), stats_start_date = LEAST(n.stats_start_date, o.stats_start_date) FROM sites o WHERE n.id = ${next.id} AND o.id = ${old.id};\n`,
        ),
      );
    }

    const created: string[] = [];
    if (plan.goals.length) {
      log(`Goals: ${plan.goals.map(goalLabel).join(", ")}`);
      const payload = Buffer.from(JSON.stringify(plan.goals)).toString("base64");
      await run(
        rpc(
          stack,
          [
            `site = Plausible.Repo.get!(Plausible.Site, ${next.id})`,
            `true = site.domain == ${JSON.stringify(next.domain)}`,
            `for params <- Jason.decode!(Base.decode64!("${payload}")) do`,
            "  case Plausible.Goals.create(site, params) do",
            '    {:ok, goal} -> IO.puts("created goal #{goal.id}")',
            '    {:error, reason} -> raise "goal not created: #{inspect(reason)}"',
            "  end",
            "end",
          ].join("\n"),
        ),
      );
      const have = new Set(
        (await readGoals(run, stack, [next.id])).filter((g) => g.site_id === next.id).map(goalKey),
      );
      const absent = plan.goals.filter((g) => !have.has(goalKey(g)));
      check(
        !absent.length,
        `Goals missing on ${next.domain} after Plausible.Goals.create: ${absent.map(goalLabel).join(", ")}.`,
        undo,
      );
      created.push(...plan.goals.map(goalLabel));
    }

    log(`Delete site ${old.id} (${old.domain})`);
    await run(
      rpc(
        stack,
        [
          `site = Plausible.Repo.get!(Plausible.Site, ${old.id})`,
          `true = site.domain == ${JSON.stringify(old.domain)}`,
          "{:ok, _} = Plausible.Site.Removal.run(site)",
          'IO.puts("removed")',
        ].join("\n"),
      ),
    );
    const left = (
      await run(psql(stack, `SELECT count(*) FROM sites WHERE id = ${old.id};\n`))
    ).trim();
    check(
      left === "0",
      `Site ${old.id} is still in Postgres after Plausible.Site.Removal.run.`,
      undo,
    );

    log(`Delete site ${old.id}'s ClickHouse rows`);
    await run(
      clickhouse(
        stack,
        [
          "SET mutations_sync = 2;",
          ...MERGED_TABLES.map((t) => `ALTER TABLE ${t} DELETE WHERE site_id = ${old.id};`),
          "",
        ].join("\n"),
      ),
      600_000,
    );

    const after = await siteStats(run, stack, [old.id, next.id]);
    const oldAfter = after.get(old.id) ?? emptyStats();
    const newAfter = after.get(next.id) ?? emptyStats();
    check(
      !oldAfter.events && !oldAfter.counters && !oldAfter.sessions,
      `Site ${old.id} still has ClickHouse rows after the delete (${oldAfter.events} events).`,
      undo,
    );
    check(
      newAfter.events >= next.stats.events + copied.events &&
        newAfter.sessions >= next.stats.sessions + copied.sessions,
      `Site ${next.id} has ${newAfter.events} events and ${newAfter.sessions} sessions, expected at least ${next.stats.events + copied.events} and ${next.stats.sessions + copied.sessions}.`,
      undo,
    );

    return {
      host: plan.host,
      service: stack.uuid,
      old: { id: old.id, domain: old.domain, before: old.stats, after: oldAfter },
      new: { id: next.id, domain: next.domain, before: next.stats, after: newAfter },
      copied,
      backups: {
        dump: `${plan.backupDir}/${plan.dumpFile}`,
        dumpBytes,
        tables: Object.values(backup),
      },
      startDates: plan.startDates,
      goalsCreated: created,
      notes: plan.notes,
    };
  } catch (error) {
    if (error instanceof MergeError) throw error;
    throw new MergeError((error as Error).message, undo);
  }
}

// --- the command -----------------------------------------------------------

export const MERGE_USAGE = `Usage:
  hatchkit plausible merge <old-domain> <new-domain> [--dry-run] [--allow-overlap]
                           [--host <name>] [--service <uuid>] [--yes] [--json]`;

export interface MergeDeps {
  runnerFor: (host: BackupHost) => HostRunner;
  confirm: (message: string) => Promise<boolean>;
  log: (line: string) => void;
  now: () => Date;
}

/** The backup host that runs Plausible: --host, the only host, or the one
 *  host of several that runs a Plausible service. */
async function pickHost(name: string | undefined, runnerFor: MergeDeps["runnerFor"]) {
  if (name) return backupHost(name);
  const hosts = backupHosts();
  if (hosts.length === 1) return hosts[0];
  const found: BackupHost[] = [];
  for (const host of hosts) if ((await findStacks(runnerFor(host))).length) found.push(host);
  if (found.length === 1) return found[0];
  throw new Error(
    found.length
      ? `Plausible runs on several backup hosts (${found.map((h) => h.name).join(", ")}). Pass --host <name>.`
      : `No backup host runs Plausible (checked ${hosts.map((h) => h.name).join(", ")}).`,
  );
}

const printable = (text: string) =>
  Array.from(text, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "?" : c;
  }).join("");

const count = (n: number) => n.toLocaleString("en-US");

function siteLine(label: string, site: Site) {
  const s = site.stats;
  const range = s.first ? `${s.first} – ${s.last}` : "no events";
  return `  ${label} ${site.domain} (site ${site.id}): ${count(s.events)} events, ${count(s.sessions)} sessions, ${count(s.visitors)} visitors, ${range}`;
}

function statsTable(result: MergeResult): string[] {
  const row = (name: string, s: SiteStats) =>
    `    ${name.padEnd(36)} ${count(s.events).padStart(9)} ${count(s.sessions).padStart(9)} ${count(s.visitors).padStart(9)}`;
  return [
    `    ${"".padEnd(36)} ${"events".padStart(9)} ${"sessions".padStart(9)} ${"visitors".padStart(9)}`,
    row(`${result.old.domain} before`, result.old.before),
    row(`${result.new.domain} before`, result.new.before),
    row(`${result.new.domain} after`, result.new.after),
    row(`${result.old.domain} after`, result.old.after),
  ];
}

export async function runPlausibleMerge(
  args: string[],
  deps: Partial<MergeDeps> = {},
): Promise<MergeResult | MergePlan> {
  const runnerFor = deps.runnerFor ?? hostRunner;
  const log = deps.log ?? ((line: string) => console.log(printable(line)));
  const positionals: string[] = [];
  const flags = { dryRun: false, allowOverlap: false, yes: false, json: false };
  let hostName: string | undefined;
  let service: string | undefined;
  const rest = [...args];
  while (rest.length) {
    const arg = rest.shift() as string;
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--allow-overlap") flags.allowOverlap = true;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--host" && rest[0] && !rest[0].startsWith("-")) hostName = rest.shift();
    else if (arg === "--service" && rest[0] && !rest[0].startsWith("-")) service = rest.shift();
    else if (!arg.startsWith("-")) positionals.push(arg);
    else throw new Error(`Unknown or incomplete option: ${arg}\n\n${MERGE_USAGE}`);
  }
  if (positionals.length !== 2) throw new Error(MERGE_USAGE);
  if (flags.json && !flags.dryRun && !flags.yes)
    throw new Error("--json prints no prompt: pass --dry-run, or --yes after a dry run.");
  const say = flags.json ? () => {} : log;

  const host = await pickHost(hostName, runnerFor);
  const run = runnerFor(host);
  const plan = await planMerge(run, host.name, {
    oldDomain: positionals[0],
    newDomain: positionals[1],
    allowOverlap: flags.allowOverlap,
    service,
    now: (deps.now ?? (() => new Date()))(),
  });

  say(`  Plausible merge on ${host.name} (plausible-${plan.stack.uuid})`);
  say(siteLine("old", plan.old));
  say(siteLine("new", plan.new));
  say(
    plan.overlap
      ? "  ! the event ranges overlap (--allow-overlap)"
      : "  ✓ no overlap, no imported data, no earlier merge of the old site",
  );
  for (const note of plan.notes) say(`  · ${note}`);
  say("  Writes:");
  plannedWrites(plan).forEach((line, i) => say(`    ${i + 1}. ${line}`));

  if (flags.dryRun) {
    say("  Dry run: nothing written.");
    if (flags.json)
      console.log(JSON.stringify({ dryRun: true, plan, writes: plannedWrites(plan) }, null, 2));
    return plan;
  }
  if (!flags.yes) {
    if (!process.stdin.isTTY && !deps.confirm)
      throw new Error(
        "Merging writes to production Plausible and deletes the old site. Run --dry-run first, then pass --yes.",
      );
    const confirm =
      deps.confirm ??
      (async (message: string) => {
        const { confirm: ask } = await import("@inquirer/prompts");
        return ask({ message, default: false });
      });
    if (
      !(await confirm(
        `Merge ${plan.old.domain} into ${plan.new.domain} and delete ${plan.old.domain}?`,
      ))
    ) {
      say("  Cancelled. Nothing written.");
      return plan;
    }
  }

  const result = await applyMerge(run, plan, (line) => say(`  → ${line}`));
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else {
    say(`  ✓ ${result.old.domain} merged into ${result.new.domain}`);
    for (const line of statsTable(result)) say(line);
    say(
      `  Backups: ${result.backups.dump} (${count(result.backups.dumpBytes)} bytes), ${result.backups.tables.join(", ")}`,
    );
    say("  Drop the backup tables once nobody needs the rollback.");
  }
  return result;
}
