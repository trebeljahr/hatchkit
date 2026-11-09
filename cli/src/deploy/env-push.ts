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
 * Each app's live env is read before the write so the caller learns
 * which apps' env CHANGED. Coolify hands env to a container when it
 * starts it, so a changed app keeps the old values until it is
 * redeployed; `sync --deploy` uses this to redeploy those apps even
 * when their routing was already in sync. Values are compared in memory
 * and never printed — only key names are.
 */

import chalk from "chalk";
import type { CoolifyApi } from "../utils/coolify-api.js";
import ora from "../utils/spinner.js";
import { resolveProductionEnv } from "./env-resolve.js";
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
}

export interface EnvPushOutcome {
  /** `.env.production` relative to the project root. */
  relPath: string;
  /** App name → number of vars pushed (or that would be, on a dry run). */
  pushed: Record<string, number>;
  /** Apps whose env this push changed. Empty on a dry run. */
  changed: EnvChange[];
  /** Keys still holding a scaffold placeholder. Pushed anyway. */
  placeholders: string[];
  /** One line per failure. A non-empty list means some app did not get
   *  the env; `undecrypted` values block the whole push. */
  errors: string[];
}

/** Push `.env.production` (decrypted) onto every app in `apps`.
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

  for (const app of args.apps) {
    const values: Record<string, string> = { ...baseline, ...resolvedEnv.values };
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
    if (dryRun) {
      if (!json) {
        console.log(
          chalk.dim(
            `    · env → ${app.name}: would push ${count} var(s) from ${resolvedEnv.relPath}`,
          ),
        );
      }
      outcome.pushed[app.name] = count;
      continue;
    }
    const before = await liveEnvDiff(api, app.uuid, values);
    const spinner = json ? null : ora(`Coolify: env → "${app.name}"`).start();
    try {
      await api.setAppEnv(app.uuid, values);
      outcome.pushed[app.name] = count;
      if (before.unreadable || before.keys.length > 0) {
        outcome.changed.push({ uuid: app.uuid, name: app.name, ...before });
      }
      // Names only. These are production secrets.
      spinner?.succeed(
        `Coolify: pushed ${count} env var(s) to "${app.name}"${describeChange(before)}`,
      );
    } catch (err) {
      spinner?.fail(`Coolify: env push failed: ${(err as Error).message}`);
      outcome.errors.push(`env ${app.name}: ${(err as Error).message}`);
    }
  }
  return outcome;
}

/** Which of `values` the app's live PRODUCTION env lacks or holds with
 *  another value. Exported for tests. */
export async function liveEnvDiff(
  api: CoolifyApi,
  appUuid: string,
  values: Record<string, string>,
): Promise<{ keys: string[]; unreadable: boolean }> {
  let rows: Awaited<ReturnType<CoolifyApi["listAppEnvRows"]>>;
  try {
    rows = await api.listAppEnvRows(appUuid);
  } catch {
    return { keys: [], unreadable: true };
  }
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
