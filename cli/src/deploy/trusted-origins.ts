/*
 * TRUSTED_ORIGINS on the server's Coolify application — getting the
 * native shells' origins to where production actually reads them.
 *
 * ---------------------------------------------------------------------
 * The failure this closes
 * ---------------------------------------------------------------------
 *
 * A Capacitor / Electron / Tauri client loads the web bundle from its
 * own document origin (`capacitor://localhost`, `https://localhost`,
 * `app://-`, …). better-auth answers `403 INVALID_ORIGIN` for any origin
 * not in its trusted list, before it checks the password. hatchkit
 * computed the right list at scaffold time but only ever wrote it into
 * `.env.example`, and set nothing but NODE_ENV / PORT / FRONTEND_URL on
 * Coolify on the assumption that everything else arrives in a committed
 * dotenvx `.env.production`.
 *
 * Projects that moved production env into Coolify's fields break that
 * assumption. Tracktime (2026-09): `.env.production` untracked, server
 * image copies only dist + package.json + node_modules, compose takes
 * every value as `${VAR}` from Coolify. The origins never reached
 * production, and a Capacitor build against the real API failed sign-in
 * with 403 until someone added them in the dashboard by hand. curl never
 * showed it: better-auth only force-validates `Origin` when the request
 * carries `Sec-Fetch-*` headers, which browsers and WebViews send and
 * curl does not.
 *
 * ---------------------------------------------------------------------
 * Rules every write here follows
 * ---------------------------------------------------------------------
 *
 *   1. One list. `nativeClientOrigins` (scaffold/native-origins.ts) is
 *      the only mapping; the .env.example rewrite calls it too.
 *   2. Merge, never overwrite. The live value can hold hand-added
 *      origins (a pinned production `chrome-extension://<id>`). Existing
 *      entries keep their order, missing ones are appended, nothing is
 *      removed. If the token cannot READ the live value, nothing is
 *      written — merging into a value you cannot see is overwriting it.
 *   3. Server app only. Chosen by the routing plan's role, never by
 *      guessing from a name: `server` under split, the one `compose` app
 *      under single-origin, nothing for a static project.
 *   4. Confirm the write landed. `PATCH /envs/bulk` upserts on every
 *      build checked, but the write is read back through `GET /envs`,
 *      a missing key is created explicitly with `POST /envs`, and a
 *      value that still doesn't match is a failure, not a green line.
 *   5. Ask first. The before/after list and the security trade are
 *      shown, and nothing is written without a yes (`--yes` skips the
 *      prompt; `--dry-run` shows the diff and stops).
 *   6. Redeploy. The server reads its trusted origins once, at boot. An
 *      app that has already run keeps the old list until it redeploys,
 *      and every caller either redeploys or says so.
 *
 * Domain-independent by construction: nothing here reads the project
 * domain, so `hatchkit rename-domain` has nothing to add or strip.
 */

import chalk from "chalk";
import { getCoolifyConfig } from "../config.js";
import type { ProjectManifest } from "../scaffold/manifest.js";
import {
  malformedOrigins,
  mergeTrustedOrigins,
  nativeClientOrigins,
  parseOriginList,
} from "../scaffold/native-origins.js";
import { readComposeFile } from "../utils/compose.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { type RoutedApp, computeRoutingPlan, inferTopology } from "./routing.js";

export const TRUSTED_ORIGINS_KEY = "TRUSTED_ORIGINS";

/** The Coolify apps that run the better-auth server, out of a routing
 *  plan's apps (or anything carrying the same `role`).
 *
 *  By role, never by name: `split` gives a `-client` and a `-server`
 *  app and only the server reads TRUSTED_ORIGINS; `single-origin` gives
 *  one `compose` app whose compose runs the server; a `static` project
 *  has no server at all, even though its one app is also `compose`. */
export function serverAppsOf<T extends { role: RoutedApp["role"] }>(
  apps: readonly T[],
  surfaces?: string,
): T[] {
  if (surfaces === "static") return [];
  return apps.filter((a) => a.role === "server" || a.role === "compose");
}

export type NativeOriginsStatus =
  /** Every wanted origin is already trusted — nothing written. */
  | "in-sync"
  /** `--dry-run`: the diff was shown, nothing written. */
  | "would-update"
  /** Written and read back. */
  | "updated"
  /** The user said no at the prompt. */
  | "declined"
  /** No TTY to ask on and no `--yes` — nothing written. */
  | "needs-confirmation"
  /** The token can't read env values, so a merge is impossible. */
  | "unreadable"
  /** A read, write or read-back failed. */
  | "failed";

export interface NativeOriginsOutcome {
  app: string;
  uuid: string;
  status: NativeOriginsStatus;
  before: string[];
  after: string[];
  added: string[];
  /** Existing entries better-auth can never match (a path, a trailing
   *  slash). Reported, never removed. */
  malformed: string[];
  /** True when the value changed on an app that has already booted with
   *  the old list. */
  needsRedeploy: boolean;
  detail?: string;
}

export interface EnsureNativeOriginsArgs {
  api: CoolifyApi;
  app: { uuid: string; name: string };
  features: readonly string[];
  dryRun?: boolean;
  /** Skip the confirmation prompt. */
  yes?: boolean;
  /** Suppress human output (the caller renders JSON). */
  json?: boolean;
  /** The app was created by this run and has never deployed, so the new
   *  value is what its first boot reads — no redeploy owed. */
  freshApp?: boolean;
  /** Prompt override for tests; defaults to @inquirer/prompts `confirm`. */
  confirm?: (message: string) => Promise<boolean>;
  /** Whether a prompt can be shown. Defaults to "stdin and stdout are
   *  TTYs and this isn't a JSON run". */
  interactive?: boolean;
  /** Line sink for tests; defaults to console.log. */
  log?: (line: string) => void;
}

/** Merge the project's native origins into TRUSTED_ORIGINS on ONE server
 *  app, following every rule in the module header. Never throws: the
 *  outcome carries the failure so a caller can keep going. */
export async function ensureNativeTrustedOrigins(
  args: EnsureNativeOriginsArgs,
): Promise<NativeOriginsOutcome> {
  const { api, app } = args;
  const log = args.json ? () => {} : (args.log ?? ((line: string) => console.log(line)));
  const wanted = nativeClientOrigins(args.features);
  const outcome = (
    status: NativeOriginsStatus,
    extra: Partial<NativeOriginsOutcome> = {},
  ): NativeOriginsOutcome => ({
    app: app.name,
    uuid: app.uuid,
    status,
    before: [],
    after: [],
    added: [],
    malformed: [],
    needsRedeploy: false,
    ...extra,
  });
  if (wanted.length === 0) return outcome("in-sync");

  let live: EnvRead;
  try {
    live = await readTrustedOrigins(api, app.uuid);
  } catch (err) {
    const detail = `couldn't read env on "${app.name}": ${(err as Error).message}`;
    log(chalk.red(`    ✗ ${TRUSTED_ORIGINS_KEY}: ${detail}`));
    return outcome("failed", { detail });
  }

  if (live.kind === "hidden") {
    const detail =
      `this Coolify token can't read env values (it lacks \`read:sensitive\`), so the live ` +
      `${TRUSTED_ORIGINS_KEY} can't be merged — writing blind would overwrite any hand-added origin.`;
    log(chalk.yellow(`\n  ${TRUSTED_ORIGINS_KEY} on "${app.name}": not changed`));
    log(chalk.dim(`    ${detail}`));
    log(
      chalk.dim(
        `    Fix: give the token read:sensitive, or add these by hand in Coolify → "${app.name}" →\n` +
          `    Environment Variables, keeping every existing entry: ${wanted.join(", ")}`,
      ),
    );
    return outcome("unreadable", { detail });
  }

  const merge = mergeTrustedOrigins(live.kind === "value" ? live.value : undefined, wanted);
  const malformed = malformedOrigins(merge.before);
  const fields = {
    before: merge.before,
    after: merge.after,
    added: merge.added,
    malformed,
  };

  if (!merge.changed) {
    log(
      chalk.green(
        `    ✓ ${TRUSTED_ORIGINS_KEY} on "${app.name}" already trusts the native clients`,
      ),
    );
    renderMalformed(log, malformed);
    return outcome("in-sync", fields);
  }

  renderDiff(log, app.name, merge, live.kind === "absent");
  renderMalformed(log, malformed);
  for (const line of securityNote(merge.added)) log(chalk.yellow(`    ${line}`));

  if (args.dryRun) {
    log(chalk.dim(`    --dry-run: ${TRUSTED_ORIGINS_KEY} not written.`));
    return outcome("would-update", fields);
  }

  if (!args.yes) {
    const interactive =
      args.interactive ?? (!args.json && !!process.stdin.isTTY && !!process.stdout.isTTY);
    if (!interactive) {
      log(
        chalk.yellow(
          `    Not written: changing production ${TRUSTED_ORIGINS_KEY} needs confirmation, and there is\n` +
            "    no terminal to ask on. Re-run interactively, or pass --yes once you accept the diff above.",
        ),
      );
      return outcome("needs-confirmation", fields);
    }
    const ask = args.confirm ?? defaultConfirm;
    const ok = await ask(
      `Trust ${merge.added.length} native origin(s) in production ${TRUSTED_ORIGINS_KEY} on "${app.name}"?`,
    );
    if (!ok) {
      log(chalk.dim(`    Skipped. ${TRUSTED_ORIGINS_KEY} on "${app.name}" left as it was.`));
      return outcome("declined", fields);
    }
  }

  try {
    await api.setAppEnv(app.uuid, { [TRUSTED_ORIGINS_KEY]: merge.value });
    let check = await readTrustedOrigins(api, app.uuid);
    if (check.kind === "absent") {
      // The bulk PATCH upserts on every build we've checked. If this one
      // didn't, make the key exist explicitly rather than report a write
      // that changed nothing.
      await api.createAppEnv(app.uuid, TRUSTED_ORIGINS_KEY, merge.value);
      check = await readTrustedOrigins(api, app.uuid);
    }
    if (check.kind === "absent") {
      throw new Error(
        `Coolify accepted the write but ${TRUSTED_ORIGINS_KEY} is still absent on read-back`,
      );
    }
    if (check.kind === "value" && check.value.trim() !== merge.value) {
      throw new Error(
        `read-back doesn't match: expected "${merge.value}", Coolify reports "${check.value}"`,
      );
    }
    const detail =
      check.kind === "hidden"
        ? "key confirmed on read-back; this token can't read values, so the value itself wasn't compared"
        : undefined;
    log(
      chalk.green(
        `    ✓ ${TRUSTED_ORIGINS_KEY} on "${app.name}" now trusts ${merge.added.join(", ")} (read back from Coolify)`,
      ),
    );
    if (detail) log(chalk.dim(`      ${detail}`));
    return outcome("updated", {
      ...fields,
      needsRedeploy: !args.freshApp,
      ...(detail ? { detail } : {}),
    });
  } catch (err) {
    const detail = `write to "${app.name}" not confirmed: ${(err as Error).message}`;
    log(chalk.red(`    ✗ ${TRUSTED_ORIGINS_KEY}: ${detail}`));
    return outcome("failed", { ...fields, detail });
  }
}

/** Run {@link ensureNativeTrustedOrigins} on every server app in `apps`
 *  and print the redeploy notice the result calls for.
 *
 *  The one entry point `create`, `adopt`, `update` and `sync` share, so
 *  "which app" and "what happens after the write" can't differ between
 *  them. Returns `[]` without touching Coolify when the project has no
 *  native client. */
export async function pushNativeOriginsToServerApps(args: {
  api: CoolifyApi;
  apps: ReadonlyArray<{ uuid: string; name: string; role: RoutedApp["role"]; created?: boolean }>;
  features: readonly string[];
  surfaces?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  /** False when the caller is about to redeploy the apps itself. */
  printRedeployNotice?: boolean;
  confirm?: (message: string) => Promise<boolean>;
  interactive?: boolean;
  log?: (line: string) => void;
}): Promise<NativeOriginsOutcome[]> {
  if (nativeClientOrigins(args.features).length === 0) return [];
  const targets = serverAppsOf(args.apps, args.surfaces);
  const log = args.json ? () => {} : (args.log ?? ((line: string) => console.log(line)));
  if (targets.length === 0) return [];
  log(chalk.bold(`\n  Native client origins (${TRUSTED_ORIGINS_KEY})`));
  const outcomes: NativeOriginsOutcome[] = [];
  for (const app of targets) {
    outcomes.push(
      await ensureNativeTrustedOrigins({
        api: args.api,
        app,
        features: args.features,
        dryRun: args.dryRun,
        yes: args.yes,
        json: args.json,
        freshApp: app.created === true,
        confirm: args.confirm,
        interactive: args.interactive,
        log: args.log,
      }),
    );
  }
  if (args.printRedeployNotice !== false) {
    for (const line of redeployNotice(outcomes)) log(chalk.yellow(line));
  }
  return outcomes;
}

/** Push native origins for a project known only by its manifest — the
 *  `hatchkit update` path, which has no Coolify app handles of its own.
 *
 *  Locates the server app the same way `sync` does (routing plan role,
 *  then hatchkit's name or an accepted alias) and hands it to
 *  {@link pushNativeOriginsToServerApps}. Returns `null` — having touched
 *  nothing — when there's nothing to do here: no native client, a
 *  non-Coolify deploy, Coolify not configured, or no server app found.
 *  Each of those prints the `hatchkit sync` command that finishes it. */
export async function pushNativeOriginsForProject(args: {
  projectDir: string;
  manifest: ProjectManifest;
  dryRun?: boolean;
  yes?: boolean;
}): Promise<NativeOriginsOutcome[] | null> {
  const { manifest } = args;
  if (!nativeClientOrigins(manifest.features).length) return null;
  const later = chalk.dim(
    `  Run \`hatchkit sync --dry-run\` to see the ${TRUSTED_ORIGINS_KEY} diff once the project is on Coolify.`,
  );
  if ((manifest.deploymentMode ?? "coolify") !== "coolify" || manifest.surfaces === "static") {
    return null;
  }
  const cfg = await getCoolifyConfig();
  if (!cfg) {
    console.log(chalk.yellow(`\n  Coolify isn't configured — ${TRUSTED_ORIGINS_KEY} not checked.`));
    console.log(later);
    return null;
  }
  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  const compose = readComposeFile(args.projectDir);
  const topology = inferTopology({
    topology: manifest.topology,
    composeServices: compose?.services,
  }).topology;
  const plan = computeRoutingPlan({
    name: manifest.name,
    domain: manifest.domain,
    topology,
    surfaces: manifest.surfaces,
    ports: manifest.ports,
    publicService: manifest.publicService,
    composeServices: compose?.services,
  });
  const apps: Array<{ uuid: string; name: string; role: RoutedApp["role"] }> = [];
  for (const routed of serverAppsOf(plan.apps, manifest.surfaces)) {
    for (const name of [routed.appName, ...routed.aliases]) {
      const found = await api.findApplicationByName(name);
      if (found) {
        apps.push({ uuid: found.uuid, name: found.name || name, role: routed.role });
        break;
      }
    }
  }
  if (apps.length === 0) {
    console.log(
      chalk.yellow(
        `\n  No Coolify server app found for "${manifest.name}" — ${TRUSTED_ORIGINS_KEY} not checked.`,
      ),
    );
    console.log(later);
    return null;
  }
  return pushNativeOriginsToServerApps({
    api,
    apps,
    features: manifest.features,
    surfaces: manifest.surfaces,
    dryRun: args.dryRun,
    yes: args.yes,
  });
}

/** The lines telling the user their running server still has the old
 *  list. Empty when nothing that has already booted was changed. */
export function redeployNotice(outcomes: readonly NativeOriginsOutcome[]): string[] {
  const stale = outcomes.filter((o) => o.status === "updated" && o.needsRedeploy);
  if (stale.length === 0) return [];
  return [
    `\n  ⚠ ${stale.map((o) => `"${o.app}"`).join(", ")}: ${TRUSTED_ORIGINS_KEY} changed, but the running server`,
    "    read its trusted origins at boot and still has the OLD list. Native sign-in keeps",
    "    failing with 403 INVALID_ORIGIN until it redeploys: `hatchkit sync --deploy`, or",
    "    Redeploy in the Coolify dashboard.",
  ];
}

/** Merge a TRUSTED_ORIGINS value about to be pushed from `.env.production`
 *  into the live one, for `hatchkit sync`'s env pass.
 *
 *  That pass used to push the file's value verbatim, which silently
 *  dropped any origin added in the dashboard. Now the live list keeps its
 *  entries and order and the file's missing ones are appended. Returns
 *  `null` when the live value exists but can't be read — the caller must
 *  then leave the key out of the push. */
export async function mergePushedTrustedOrigins(
  api: CoolifyApi,
  appUuid: string,
  fileValue: string,
): Promise<string | null> {
  const live = await readTrustedOrigins(api, appUuid);
  if (live.kind === "hidden") return null;
  const fileOrigins = parseOriginList(fileValue);
  if (live.kind === "absent") return mergeTrustedOrigins(undefined, fileOrigins).value;
  return mergeTrustedOrigins(live.value, fileOrigins).value;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type EnvRead = { kind: "absent" } | { kind: "hidden" } | { kind: "value"; value: string };

/** The PRODUCTION TRUSTED_ORIGINS row. GET /envs mixes preview rows into
 *  the same list and the same key can appear in both. */
async function readTrustedOrigins(api: CoolifyApi, appUuid: string): Promise<EnvRead> {
  const rows = await api.listAppEnvRows(appUuid);
  const row = rows.find((r) => r.key === TRUSTED_ORIGINS_KEY && !r.isPreview);
  if (!row) return { kind: "absent" };
  if (row.value === undefined) return { kind: "hidden" };
  return { kind: "value", value: row.value };
}

/** Why each added origin is a decision rather than a formality. */
export function securityNote(added: readonly string[]): string[] {
  const lines = [
    "Security trade: a trusted origin passes better-auth's origin check for ANY page served",
    "from it, not only your app's shell.",
  ];
  if (added.includes("https://localhost")) {
    lines.push(
      "Trusting https://localhost in production means a page served from https://localhost on a",
      "user's own machine also passes the origin check. Capacitor on Android needs it (androidScheme",
      "defaults to https) and it is accepted practice, but it is your call.",
    );
  }
  return lines;
}

function renderDiff(
  log: (line: string) => void,
  appName: string,
  merge: ReturnType<typeof mergeTrustedOrigins>,
  absent: boolean,
): void {
  log(chalk.yellow(`\n    · ${TRUSTED_ORIGINS_KEY} on "${appName}" (production):`));
  log(
    chalk.dim(
      `        before: ${absent ? "(not set)" : merge.before.length > 0 ? merge.before.join(",") : "(empty)"}`,
    ),
  );
  log(chalk.dim(`        after:  ${merge.value}`));
  for (const origin of merge.added) log(chalk.green(`        + ${origin}`));
}

function renderMalformed(log: (line: string) => void, malformed: readonly string[]): void {
  if (malformed.length === 0) return;
  log(
    chalk.yellow(
      `      ! existing entr${malformed.length === 1 ? "y" : "ies"} better-auth can never match (exact match — no path or trailing slash): ${malformed.join(", ")}`,
    ),
  );
  log(chalk.dim("        left in place; fix by hand if it was meant to trust something."));
}

async function defaultConfirm(message: string): Promise<boolean> {
  const { confirm } = await import("@inquirer/prompts");
  return confirm({ message, default: true });
}
