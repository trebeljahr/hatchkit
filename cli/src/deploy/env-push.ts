/*
 * Push a project's resolved production env onto its Coolify apps.
 *
 * The one env push hatchkit has. `hatchkit sync` runs it as its env
 * pass, and `hatchkit create` runs it before the first `git push`, once
 * every value the run writes (the database URL above all) is in
 * `.env.production`.
 *
 * Why create needs it: the images do not contain `.env.production`
 * (starter/packages/server/Dockerfile), so a value reaches the running
 * container through Coolify env or not at all. A create that left this
 * to a later `hatchkit sync` shipped a server that died at boot with
 * "Missing required environment variable: MONGODB_URI", and the first
 * CI deploy gate failed with it.
 *
 * Which values go where. In a two-package project the file this reads
 * is the server package's (`packages/server/.env.production`), and its
 * values are the server's secrets. A client app gets none of them: only
 * NODE_ENV, its PORT and the client package's own `.env.production`.
 * The starter's client is a Next.js standalone server that reads
 * NODE_ENV, PORT and its drain settings at runtime, and NEXT_PUBLIC_*
 * only at image BUILD time (CI passes them as build args), so a server
 * secret in its container is exposure with no use. Earlier releases
 * pushed the server file to every app, so a client app can still hold
 * server keys: the push removes each one it finds (key names only in
 * the output), and says so when it cannot. A client that does read a
 * value at runtime gets it from the client package's own file.
 *
 * A file at the project root, or a project with no client app, is one
 * shared env: every app gets all of it, as before.
 *
 * Each app's live env is read before the write so the caller learns
 * which apps' env CHANGED. Coolify hands env to a container when it
 * starts it, so a changed app keeps the old values until it is
 * redeployed; `sync --deploy` uses this to redeploy those apps even
 * when their routing was already in sync. Values are compared in memory
 * and never printed — only key names are.
 */

import chalk from "chalk";
import type { CoolifyApi } from "../utils/coolify-api.js";
import { envFileOwner } from "../utils/env-files.js";
import ora from "../utils/spinner.js";
import {
  type ResolvedProdEnv,
  resolveClientProductionEnv,
  resolveProductionEnv,
} from "./env-resolve.js";
import type { RoutedApp } from "./routing.js";
import { TRUSTED_ORIGINS_KEY, mergePushedTrustedOrigins } from "./trusted-origins.js";

/** One Coolify app to push to. */
export interface EnvPushApp {
  uuid: string;
  name: string;
  role: RoutedApp["role"];
  /** The port Traefik forwards to. Every app but a compose app gets it
   *  as PORT: each half binds its own port, and without this the client
   *  inherits the server's. */
  portsExposes: string;
}

/** How one app's live env compared with what was pushed. */
export interface EnvChange {
  uuid: string;
  name: string;
  /** Keys that were missing or held another value. Names only. */
  keys: string[];
  /** The live values could not be read (the token lacks
   *  `read:sensitive`, or the read failed). The app then counts as
   *  changed: nothing shows it isn't. */
  unreadable: boolean;
  /** Server keys this push removed from a client app. Names only. */
  removed: string[];
}

export interface EnvPushOutcome {
  /** `.env.production` relative to the project root. */
  relPath: string;
  /** App name → number of vars pushed (or that would be, on a dry run). */
  pushed: Record<string, number>;
  /** Client app name → server keys removed from it (or that would be,
   *  on a dry run). Names only. Only apps that held any are listed. */
  removed: Record<string, string[]>;
  /** Apps whose env this push changed. Empty on a dry run. */
  changed: EnvChange[];
  /** Keys still holding a scaffold placeholder. Pushed anyway. */
  placeholders: string[];
  /** One line per failure. A non-empty list means some app did not get
   *  the env; `undecrypted` values block the whole push. */
  errors: string[];
}

/** Push `.env.production` (decrypted) onto every app in `apps`: all of
 *  it to the server side, and to a client app only what the client
 *  needs (see the module header).
 *
 *  Returns null when the project has no `.env.production`: a project
 *  holding every value in Coolify is a legitimate setup, so that is
 *  "nothing to push from here", never "the env is empty". */
export async function pushProductionEnv(args: {
  api: CoolifyApi;
  projectDir: string;
  project: { name: string; domain: string; surfaces?: string };
  apps: EnvPushApp[];
  dryRun?: boolean;
  json?: boolean;
}): Promise<EnvPushOutcome | null> {
  const { api, project, dryRun, json } = args;
  const resolvedEnv = await resolveProductionEnv(args.projectDir);
  if (!resolvedEnv) return null;
  const outcome: EnvPushOutcome = {
    relPath: resolvedEnv.relPath,
    pushed: {},
    removed: {},
    changed: [],
    placeholders: [],
    errors: [],
  };

  if (resolvedEnv.undecrypted.length > 0) {
    // Pushing `encrypted:...` as though it were a value would put
    // ciphertext into the container and fail at a much more confusing
    // point, so refuse the whole push rather than half of it.
    const err =
      `${resolvedEnv.relPath}: ${resolvedEnv.undecrypted.length} value(s) still encrypted ` +
      `(${resolvedEnv.undecrypted.join(", ")}) — DOTENV_PRIVATE_KEY_PRODUCTION is missing or wrong. ` +
      `Run \`hatchkit keys show ${project.name}\` to check, then re-run.`;
    outcome.errors.push(err);
    if (!json) console.log(chalk.yellow(`\n  ${err}`));
    return outcome;
  }

  // Placeholders are pushed, not blocked — several are optional and a
  // project can legitimately ship without them — but they are called
  // out, because a `CHANGE_ME…` in Coolify is a value-shaped string that
  // silently misconfigures the app.
  if (resolvedEnv.placeholders.length > 0 && !json) {
    console.log(
      chalk.yellow(
        `\n  ${resolvedEnv.placeholders.length} value(s) in ${resolvedEnv.relPath} are still scaffold placeholders:`,
      ),
    );
    console.log(chalk.dim(`    ${resolvedEnv.placeholders.join(", ")}`));
    console.log(
      chalk.dim(
        "    The provision step that fills these never ran. Set them (`hatchkit add <project> …`,\n" +
          "    or `dotenvx set <KEY> <value> -f .env.production --encrypt`) before relying on them.",
      ),
    );
  }
  outcome.placeholders = resolvedEnv.placeholders;

  // Baseline first so file values win: the at-rest store is the source
  // of truth, and these only fill gaps it doesn't cover.
  const baseline: Record<string, string> = { NODE_ENV: "production" };
  if (project.surfaces !== "static") baseline.FRONTEND_URL = `https://${project.domain}`;

  const clientSide = await clientEnvPlan(args.projectDir, resolvedEnv, args.apps, json);

  for (const app of args.apps) {
    const isClient = clientSide !== null && app.role === "client";
    const values: Record<string, string> = isClient
      ? { NODE_ENV: "production", ...clientSide.values }
      : { ...baseline, ...resolvedEnv.values };
    if (app.role !== "compose") values.PORT = app.portsExposes;
    // TRUSTED_ORIGINS is a list the dashboard adds to by hand (a pinned
    // browser-extension id, say). Pushing the file's value verbatim
    // would silently drop those, so merge it into the live one instead:
    // live entries keep their order, the file's missing ones are
    // appended, nothing is removed.
    if (TRUSTED_ORIGINS_KEY in values && !dryRun) {
      try {
        const merged = await mergePushedTrustedOrigins(api, app.uuid, values[TRUSTED_ORIGINS_KEY]);
        if (merged === null) {
          delete values[TRUSTED_ORIGINS_KEY];
          if (!json) {
            console.log(
              chalk.yellow(
                `    · env → ${app.name}: ${TRUSTED_ORIGINS_KEY} not pushed — this token can't read the live value to merge into.`,
              ),
            );
          }
        } else {
          values[TRUSTED_ORIGINS_KEY] = merged;
        }
      } catch (err) {
        delete values[TRUSTED_ORIGINS_KEY];
        outcome.errors.push(
          `env ${app.name}: couldn't read live ${TRUSTED_ORIGINS_KEY} to merge — not pushed: ${(err as Error).message}`,
        );
      }
    }
    const count = Object.keys(values).length;
    // The live rows, read once: for the change report, and on a client
    // app for the server keys it still holds.
    let rows: LiveRows | null = null;
    if (!dryRun || isClient) {
      try {
        rows = await api.listAppEnvRows(app.uuid);
      } catch {
        rows = null;
      }
    }
    const stale =
      isClient && rows ? staleServerKeys(rows, clientSide.serverKeys, values, clientSide.keep) : [];
    if (dryRun) {
      if (!json) {
        console.log(
          chalk.dim(
            `    · env → ${app.name}: would push ${count} var(s) from ${isClient ? clientSide.source : resolvedEnv.relPath}`,
          ),
        );
        if (stale.length > 0) {
          console.log(
            chalk.dim(
              `    · env → ${app.name}: would remove ${stale.length} server key(s): ${stale.map((r) => r.key).join(", ")}`,
            ),
          );
        }
      }
      outcome.pushed[app.name] = count;
      if (stale.length > 0) outcome.removed[app.name] = stale.map((r) => r.key);
      if (isClient && rows === null) {
        outcome.errors.push(
          `env ${app.name}: couldn't read its env to check for server keys left by an earlier push`,
        );
      }
      continue;
    }
    const before = rows ? diffRows(rows, values) : { keys: [], unreadable: true };
    const spinner = json ? null : ora(`Coolify: env → "${app.name}"`).start();
    try {
      await api.setAppEnv(app.uuid, values);
      outcome.pushed[app.name] = count;
      spinner?.succeed(
        `Coolify: pushed ${count} env var(s) to "${app.name}"${describeChange(before)}`,
      );
    } catch (err) {
      spinner?.fail(`Coolify: env push failed: ${(err as Error).message}`);
      outcome.errors.push(`env ${app.name}: ${(err as Error).message}`);
      continue;
    }
    const removed = isClient
      ? await removeStaleServerKeys(api, app, rows, stale, outcome.errors, json)
      : [];
    if (removed.length > 0) outcome.removed[app.name] = removed;
    if (before.unreadable || before.keys.length > 0 || removed.length > 0) {
      outcome.changed.push({ uuid: app.uuid, name: app.name, ...before, removed });
    }
  }
  return outcome;
}

type LiveRows = Awaited<ReturnType<CoolifyApi["listAppEnvRows"]>>;

/** What a client app gets when the pushed file is the server package's,
 *  or null when every app shares the one file. */
interface ClientEnvPlan {
  /** The client package's own values (decrypted ones only). */
  values: Record<string, string>;
  /** Keys a client app keeps even when the server file names them too:
   *  everything the client file declares, decrypted or not. */
  keep: Set<string>;
  /** Keys that are the server's: removed from a client app that holds
   *  them. */
  serverKeys: Set<string>;
  /** For log lines: where the client's values came from. */
  source: string;
}

async function clientEnvPlan(
  projectDir: string,
  serverEnv: ResolvedProdEnv,
  apps: EnvPushApp[],
  json: boolean | undefined,
): Promise<ClientEnvPlan | null> {
  if (!apps.some((a) => a.role === "client")) return null;
  if (envFileOwner(projectDir, serverEnv.path) !== "server") return null;
  const clientEnv = await resolveClientProductionEnv(projectDir);
  if (clientEnv && clientEnv.undecrypted.length > 0 && !json) {
    console.log(
      chalk.yellow(
        `\n  ${clientEnv.relPath}: ${clientEnv.undecrypted.length} value(s) still encrypted ` +
          `(${clientEnv.undecrypted.join(", ")}) — not pushed to the client app. Its key is ` +
          `${clientEnv.relPath.replace(/\.env\.production$/, ".env.keys")}, not the keychain's.`,
      ),
    );
  }
  return {
    values: clientEnv?.values ?? {},
    keep: new Set([...Object.keys(clientEnv?.values ?? {}), ...(clientEnv?.undecrypted ?? [])]),
    serverKeys: new Set([
      ...Object.keys(serverEnv.values),
      // The key that decrypts the server file. `create` and `keys push`
      // used to put it on every app.
      "DOTENV_PRIVATE_KEY_PRODUCTION",
    ]),
    source: clientEnv ? clientEnv.relPath : "the baseline (no client .env.production)",
  };
}

/** Production rows of a client app that carry a server key the client
 *  is not pushed. */
function staleServerKeys(
  rows: LiveRows,
  serverKeys: Set<string>,
  pushed: Record<string, string>,
  keep: Set<string>,
): LiveRows {
  return rows.filter(
    (r) => !r.isPreview && serverKeys.has(r.key) && !(r.key in pushed) && !keep.has(r.key),
  );
}

/** Delete `stale` from a client app. Returns the keys removed; a key
 *  that could not be removed is an error naming the dashboard fix. */
async function removeStaleServerKeys(
  api: CoolifyApi,
  app: EnvPushApp,
  rows: LiveRows | null,
  stale: LiveRows,
  errors: string[],
  json: boolean | undefined,
): Promise<string[]> {
  if (rows === null) {
    errors.push(
      `env ${app.name}: couldn't read its env to check for server keys left by an earlier push`,
    );
    return [];
  }
  const removed: string[] = [];
  const failed: string[] = [];
  let reason = "";
  for (const row of stale) {
    if (!row.uuid) {
      failed.push(row.key);
      reason ||= "Coolify returned no row uuid";
      continue;
    }
    try {
      await api.deleteAppEnv(app.uuid, row.uuid);
      removed.push(row.key);
    } catch (err) {
      failed.push(row.key);
      reason ||= (err as Error).message.split("\n")[0];
    }
  }
  if (removed.length > 0 && !json) {
    console.log(
      chalk.green(`  ✓ Coolify: removed ${removed.length} server key(s) from "${app.name}"`) +
        chalk.dim(` (${removed.join(", ")})`),
    );
  }
  if (failed.length > 0) {
    errors.push(
      `env ${app.name}: still holds server key(s) ${failed.join(", ")} — couldn't remove them (${reason}). ` +
        "Delete them in the Coolify dashboard (the app → Environment Variables), or give the token the delete ability and re-run.",
    );
  }
  return removed;
}

/** Which of `values` the app's live PRODUCTION env lacks or holds with
 *  another value. Exported for tests. */
export async function liveEnvDiff(
  api: CoolifyApi,
  appUuid: string,
  values: Record<string, string>,
): Promise<{ keys: string[]; unreadable: boolean }> {
  let rows: LiveRows;
  try {
    rows = await api.listAppEnvRows(appUuid);
  } catch {
    return { keys: [], unreadable: true };
  }
  return diffRows(rows, values);
}

function diffRows(
  rows: LiveRows,
  values: Record<string, string>,
): { keys: string[]; unreadable: boolean } {
  const live = new Map<string, string | undefined>();
  for (const row of rows) if (!row.isPreview) live.set(row.key, row.value);
  const keys: string[] = [];
  let unreadable = false;
  for (const [key, value] of Object.entries(values)) {
    if (!live.has(key)) {
      keys.push(key);
      continue;
    }
    const current = live.get(key);
    if (current === undefined) unreadable = true;
    else if (current !== value) keys.push(key);
  }
  return { keys, unreadable };
}

function describeChange(diff: { keys: string[]; unreadable: boolean }): string {
  if (diff.keys.length > 0) return chalk.dim(` (changed: ${diff.keys.join(", ")})`);
  if (diff.unreadable) return chalk.dim(" (live values unreadable; counted as changed)");
  return chalk.dim(" (unchanged)");
}
