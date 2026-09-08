/*
 * Joining a Coolify application to the network its database is on.
 *
 * ---------------------------------------------------------------------
 * The failure
 * ---------------------------------------------------------------------
 *
 * Coolify deploys a `dockercompose` application onto a Docker network
 * named after the application's OWN uuid — it appends this to the
 * compose it generates:
 *
 *   networks:
 *     <app-uuid>:
 *       name: <app-uuid>
 *       external: true
 *
 * Coolify-MANAGED databases — anything created through `/databases/*`,
 * which is every datastore `provisionCoolifyMongo` / `-Postgres` /
 * `-Redis` creates — are put on the shared `coolify` network instead.
 * The two networks are isolated. So the app cannot resolve the database
 * by the container hostname that Coolify itself handed us in
 * `internal_db_url` and that we then encrypted into `.env.production`
 * as MONGODB_URI / POSTGRES_URL / REDIS_URL.
 *
 * hatchkit built exactly this broken pairing for months. Observed on
 * tracktime, 2026-09-08 — the server container crash-looped from its
 * very first deploy with:
 *
 *   [server] Failed to start: MongooseServerSelectionError:
 *     getaddrinfo ENOTFOUND x3rnoe4qdk846u4q3wjw2fw0
 *       at connectToDB (file:///app/dist/db/connection.js:11:9)
 *
 * `connect_to_docker_network` ("Connect to Predefined Network" in the
 * dashboard) is the setting that joins the app to `coolify`. Turning it
 * on and redeploying takes `restart_count` back to 0 and the hostname
 * resolves.
 *
 * ---------------------------------------------------------------------
 * Why it took months to find
 * ---------------------------------------------------------------------
 *
 *   · Coolify reports `status: "running:healthy"` for an app whose
 *     container is crash-looping. The only signal in the API record is
 *     `restart_count` climbing with `last_restart_type: "crash"`, and
 *     you only notice that by diffing against a working sibling app.
 *   · The proxy disguises it as a routing bug. caddy-docker-proxy (this
 *     Coolify instance runs Caddy, not Traefik) registers no site for a
 *     container that keeps dying, so the public symptom is `503` with
 *     body `no available server` — byte-identical to the answer for a
 *     hostname nobody ever configured. The afternoon went into label
 *     ordering; the container log had said ENOTFOUND the whole time.
 *
 * Which is why the doctor check this module feeds leads its hint with
 * the log command, not with the fix.
 *
 * ---------------------------------------------------------------------
 * Why it cannot be verified by reading the record back
 * ---------------------------------------------------------------------
 *
 * `PATCH /api/v1/applications/{uuid}` accepts
 * `{"connect_to_docker_network": true}` (verified against Coolify
 * 4.0.0-beta.469), but `GET /api/v1/applications/{uuid}` never returns
 * the field and the `settings` relation it lives in comes back `null`.
 *
 * So: DO NOT write code that asserts on a GET round-trip here. A read
 * returns nothing for a correctly-configured app and nothing for a
 * broken one — the two are indistinguishable through the API's own
 * read path. Verify by EFFECT instead (`restart_count` /
 * `last_restart_type` after the next deploy), which is what
 * {@link appShowsCrashSymptoms} is for.
 *
 * ---------------------------------------------------------------------
 * Scoping
 * ---------------------------------------------------------------------
 *
 * The setting is pushed when the app's env actually points at a
 * Coolify-managed database host, rather than unconditionally. That
 * scope is exact rather than heuristic: `internal_db_url` puts the
 * DATABASE'S OWN UUID in the host position, and `GET /databases` lists
 * every managed database's uuid, so {@link coolifyDbHostsIn} is a set
 * membership test on parsed URL hosts, not a pattern match on secrets.
 * An app with no managed database is left alone — joining it to the
 * shared network would put it on a network with every other project's
 * datastore for no reason.
 */

import chalk from "chalk";
import type { CoolifyApi, CoolifyApplication } from "../utils/coolify-api.js";
import { findCoolifyAppsForProject } from "./coolify-app.js";
import type { Topology } from "./routing.js";

/** One env var whose value points at a Coolify-managed database.
 *  Carries the key and the HOST only — never the value, which is a
 *  connection string with credentials in it. */
export interface CoolifyDbReference {
  /** Env var name, e.g. `MONGODB_URI`. */
  key: string;
  /** Hostname in the connection string — the database's Coolify uuid. */
  host: string;
  /** Human-readable database name from `GET /databases`. */
  database: string;
}

/** Hosts an env map points at that belong to a Coolify-managed database.
 *
 *  Pure and side-effect free so the interesting part is testable without
 *  a Coolify. Matching is on the parsed URL host against the database's
 *  uuid or name — a substring scan over connection strings would match
 *  a password that happens to contain a uuid, and would also mean
 *  touching secret material more than necessary. */
export function coolifyDbHostsIn(
  env: Array<{ key: string; value: string }>,
  databases: Array<{ uuid: string; name: string }>,
): CoolifyDbReference[] {
  const byHost = new Map<string, string>();
  for (const db of databases) {
    if (db.uuid) byHost.set(db.uuid, db.name || db.uuid);
    if (db.name) byHost.set(db.name, db.name);
  }
  const out: CoolifyDbReference[] = [];
  for (const { key, value } of env) {
    const host = hostOf(value);
    if (!host) continue;
    const database = byHost.get(host);
    if (!database) continue;
    out.push({ key, host, database });
  }
  return out;
}

/** Hostname of a connection string, or undefined when the value isn't
 *  a URL at all (most env vars aren't). `new URL` handles every scheme
 *  hatchkit writes — mongodb:, postgresql:, redis: — and strips the
 *  credentials for us. */
function hostOf(value: string): string | undefined {
  if (!value || !value.includes("://")) return undefined;
  try {
    const host = new URL(value).hostname;
    return host || undefined;
  } catch {
    return undefined;
  }
}

/** True when Coolify's record says this app has been restarting because
 *  it crashed.
 *
 *  `restartCount > 0` alone is not evidence — a redeploy or a manual
 *  restart bumps it too — so `lastRestartType` has to say `crash`.
 *  Undefined counts (older builds that don't report the field) are NOT
 *  treated as a fault: a check that fires on missing data teaches people
 *  to ignore it. */
export function appShowsCrashSymptoms(app: {
  restartCount?: number;
  lastRestartType?: string;
}): boolean {
  if (app.restartCount === undefined || app.restartCount <= 0) return false;
  return (app.lastRestartType ?? "").toLowerCase() === "crash";
}

/** True when Coolify's status string is anything other than a running,
 *  healthy container. Also true for a crash-looping app that Coolify
 *  still calls `running:healthy` — that is the whole point. */
export function appLooksUnhealthy(app: {
  status?: string;
  restartCount?: number;
  lastRestartType?: string;
}): boolean {
  if (appShowsCrashSymptoms(app)) return true;
  const status = (app.status ?? "").toLowerCase();
  // No status at all: the build doesn't report one. Not a fault.
  if (!status) return false;
  return !status.startsWith("running");
}

/** The command that would have saved the afternoon. Kept in one place
 *  so doctor, sync and any future caller all point at the same thing,
 *  and so it leads every hint rather than trailing it. */
export function readTheLogRecipe(coolifyUrl: string, appUuid: string): string[] {
  const base = coolifyUrl.replace(/\/$/, "");
  return [
    "Read the container log FIRST — Coolify's status field lies about crash loops:",
    `  curl -s -H "Authorization: Bearer $COOLIFY_API_TOKEN" \\`,
    `    "${base}/api/v1/applications/${appUuid}/logs?lines=120"`,
    "  (token: the one stored by `hatchkit config add coolify`)",
    `Or in the dashboard: ${base}/project — open the app → Logs.`,
  ];
}

/** Copy-pasteable repair for an app that is missing the setting.
 *  Written as the raw PATCH because that is what was verified to work,
 *  and because the dashboard toggle is three clicks deep under a name
 *  ("Connect to Predefined Network") that doesn't obviously mean
 *  "can reach its own database". */
export function connectToDockerNetworkRecipe(coolifyUrl: string, appUuid: string): string[] {
  const base = coolifyUrl.replace(/\/$/, "");
  return [
    "Join the app to the network its database is on:",
    `  curl -X PATCH -H "Authorization: Bearer $COOLIFY_API_TOKEN" \\`,
    `    -H "Content-Type: application/json" \\`,
    `    -d '{"connect_to_docker_network": true}' \\`,
    `    "${base}/api/v1/applications/${appUuid}"`,
    "Then redeploy (the setting only takes effect on the next deploy):",
    "  hatchkit sync --deploy",
    'Dashboard equivalent: the app → Configuration → Advanced → "Connect to Predefined Network".',
    "Coolify never echoes this field on GET, so there is nothing to read back —",
    "confirm the fix by `restart_count` returning to 0 after the redeploy.",
  ];
}

/** Result of pushing `connect_to_docker_network` onto one app. */
export interface DbNetworkPushResult {
  uuid: string;
  /** True when the PATCH was accepted. False means `error` explains
   *  why, and the app is still unable to reach its database. */
  ok: boolean;
  error?: string;
}

/** Push `connect_to_docker_network: true` onto every listed app.
 *
 *  Never throws: the caller is always mid-flow with a database that
 *  already exists, and a failure here is a caveat with a manual fix,
 *  not a reason to unwind the provisioning. It is also deliberately
 *  unconditional per app — the caller decided the scope; this only
 *  performs the write, and there is no read that could confirm it.
 *
 *  Idempotent: PATCHing `true` onto an app that already has it set is
 *  a no-op on Coolify's side. */
export async function enableDockerNetworkForApps(
  api: CoolifyApi,
  apps: Array<{ uuid: string }>,
): Promise<DbNetworkPushResult[]> {
  const out: DbNetworkPushResult[] = [];
  for (const app of apps) {
    try {
      await api.updateApplication(app.uuid, { connectToDockerNetwork: true });
      out.push({ uuid: app.uuid, ok: true });
    } catch (err) {
      out.push({ uuid: app.uuid, ok: false, error: (err as Error).message });
    }
  }
  return out;
}

/** Projects already joined in this process. See the guard in
 *  {@link joinProjectAppsToDatabaseNetwork}. */
const joinedThisRun = new Set<string>();

/** Join a project's Coolify application(s) to the shared `coolify`
 *  network, right after provisioning a managed database for them.
 *
 *  Called from the three provisioners because they are what CREATES the
 *  hazard: the moment a `<db-uuid>` hostname is written into the
 *  project's env, an app that isn't on the shared network is broken.
 *  Keeping the fix next to the cause means it travels with any future
 *  caller of those functions rather than living in one command's
 *  sequencing.
 *
 *  Best-effort and self-reporting: the database already exists by this
 *  point, so a failure here is a caveat with a copy-pasteable repair,
 *  never a reason to unwind. Prints its own outcome — the callers are
 *  already spinner-and-console shaped. */
export async function joinProjectAppsToDatabaseNetwork(args: {
  api: CoolifyApi;
  /** Coolify base URL, for the recipes. */
  coolifyUrl: string;
  projectName: string;
  topology?: Topology;
}): Promise<void> {
  const { api, coolifyUrl, projectName, topology } = args;
  // A `split` run provisions Mongo AND Redis back to back, and both call
  // this. The PATCH is idempotent, but saying "joined 2 app(s)" twice
  // reads like something happened twice. One join per project per
  // process; a failed attempt is not memoized, so a retry still runs.
  if (joinedThisRun.has(projectName)) return;
  let apps: Array<{ uuid: string }>;
  try {
    apps = await findCoolifyAppsForProject(projectName, topology ?? "single-origin");
  } catch (err) {
    apps = [];
    console.log(
      chalk.yellow(`  Couldn't list Coolify apps for "${projectName}": ${(err as Error).message}`),
    );
  }
  if (apps.length === 0) {
    console.log(
      chalk.yellow(
        `  No Coolify app found for "${projectName}" yet — it can't be joined to the database's network.`,
      ),
    );
    console.log(
      chalk.dim(
        "    The app will not resolve the database host until it is. Run `hatchkit sync` once\n" +
          "    the app exists; sync pushes the setting for any app whose env names a managed database.",
      ),
    );
    return;
  }

  const results = await enableDockerNetworkForApps(api, apps);
  const failed = results.filter((r) => !r.ok);
  const okCount = results.length - failed.length;
  if (failed.length === 0) joinedThisRun.add(projectName);
  if (okCount > 0) {
    console.log(
      chalk.green(
        `  ✓ ${okCount} Coolify app(s) joined to the shared \`coolify\` network ` +
          chalk.dim("(connect_to_docker_network — takes effect on the next deploy)"),
      ),
    );
  }
  for (const f of failed) {
    console.log(
      chalk.yellow(
        `  Couldn't set connect_to_docker_network on ${f.uuid}: ${f.error ?? "unknown"}`,
      ),
    );
    console.log(
      chalk.dim(
        `    Without it the app cannot resolve the database hostname and will crash-loop\n` +
          `    with ENOTFOUND while Coolify still reports it as running:healthy.`,
      ),
    );
    for (const line of connectToDockerNetworkRecipe(coolifyUrl, f.uuid)) {
      console.log(chalk.dim(`    ${line}`));
    }
  }
}

/** Does this app's Coolify env point at a Coolify-managed database?
 *
 *  Reads the RUNTIME env off Coolify rather than the local encrypted
 *  `.env.production`: Coolify's env is what the container actually
 *  sees, needs no dotenvx key to inspect, and is the same source the
 *  broken app was reading when it failed to resolve the host.
 *
 *  Returns `[]` — never throws — when either call fails or the app has
 *  no managed database in reach. A check that can't read the data has
 *  nothing to report. */
export async function findCoolifyDbReferences(
  api: CoolifyApi,
  appUuid: string,
): Promise<CoolifyDbReference[]> {
  try {
    const [env, databases] = await Promise.all([api.listAppEnvs(appUuid), api.listDatabases()]);
    return coolifyDbHostsIn(env, databases);
  } catch {
    return [];
  }
}

/** Should this app carry `connect_to_docker_network`?
 *
 *  Only `dockercompose` apps are affected: Coolify puts those on a
 *  per-app network of their own. A nixpacks / dockerfile / static app
 *  is deployed differently and doesn't need the join. */
export function needsDockerNetwork(
  app: Pick<CoolifyApplication, "buildPack">,
  references: CoolifyDbReference[],
): boolean {
  return app.buildPack === "dockercompose" && references.length > 0;
}
