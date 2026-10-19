/*
 * GlitchTip DSN delivery — getting the DSN `hatchkit add glitchtip`
 * provisioned to the two places a deployed app actually reads it.
 *
 * ---------------------------------------------------------------------
 * The failure this closes
 * ---------------------------------------------------------------------
 *
 * On 2026-10-19 GlitchTip was wired into six projects and every one had
 * to bypass `hatchkit add glitchtip`:
 *
 *   · The server reads `SENTRY_DSN` at boot. The starter's compose file
 *     passes `SENTRY_DSN: ${SENTRY_DSN:-}`, so Coolify creates the key
 *     with an EMPTY value. dotenvx never overrides a variable that is
 *     already set, even to "", so the encrypted `.env.production` value
 *     never reached the process. The Coolify value has to be the DSN.
 *   · The client bundle inlines `NEXT_PUBLIC_SENTRY_DSN` at build time
 *     from the repo VARIABLE `vars.NEXT_PUBLIC_SENTRY_DSN`
 *     (scaffold/client-build-args.ts). An unset variable builds as "",
 *     which again wins over any env file. The repo variable has to hold
 *     the DSN.
 *
 * ---------------------------------------------------------------------
 * Rules every write here follows
 * ---------------------------------------------------------------------
 *
 *   1. Read before writing. A value that already matches is left alone.
 *   2. Replace only what is ours or empty: a missing key, "", a
 *      `CHANGE_ME_` placeholder, a DSN on this GlitchTip host (a
 *      superseded key), or the same public key under another host (a DSN
 *      rendered while GLITCHTIP_DOMAIN was wrong). Any other DSN
 *      (sentry.io, say) is kept and reported; overwriting it could
 *      silently move a project's errors to a different tracker.
 *   3. A Coolify token that can't read values (no `read:sensitive`) only
 *      writes a key that doesn't exist yet; an existing one is reported.
 *   4. Confirm the write by reading it back, as deploy/trusted-origins.ts
 *      does. A missing key after the bulk PATCH is created explicitly.
 *   5. `--no-write` (`write: false`) changes nothing and prints the exact
 *      `gh variable set` command instead.
 *   6. Server apps only, located by deploy/trusted-origins.ts's
 *      `findServerAppsForProject`. The client's NEXT_PUBLIC_* value is
 *      baked in at build time, so a Coolify value on the client app
 *      would change nothing.
 *
 * The DSN's public key ships in every client bundle, so it is not a
 * secret; it is still printed only inside the `gh variable set` command
 * the user is asked to run (under `--no-write`, or when hatchkit could
 * not run it itself).
 *
 * ---------------------------------------------------------------------
 * Who runs it, and when
 * ---------------------------------------------------------------------
 *
 *   · `hatchkit add … glitchtip`, right after provisioning.
 *   · `hatchkit create`, once the Coolify apps and the GitHub repo exist
 *     and before the first push, so the first build and the first boot
 *     already carry the DSN. Its provisioning step runs much earlier,
 *     before either target exists.
 *   · `hatchkit adopt`, after its provisioning step, which already comes
 *     after the Coolify wiring and the push.
 *   · `hatchkit adopt --resume` when it skipped GlitchTip because
 *     `.env.production` already has its names. Nothing was provisioned,
 *     so the DSN comes from those files (`readGlitchtipDsnFromEnv`). A
 *     project adopted before adopt delivered, or whose delivery failed,
 *     is repaired by the resume itself.
 *
 * create and adopt go through `deliverProvisionedDsn`: a target left
 * without the DSN becomes one entry in the flow's own end-of-run list
 * (create's deferred steps, adopt's caveats), and its command is
 * `hatchkit add <project> glitchtip --adopt`. That entry never holds the
 * DSN, because create persists it in `.hatchkit.json`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse as parseDotenv } from "@dotenvx/dotenvx";
import chalk from "chalk";
import { getCoolifyConfig, getGlitchtipConfig } from "../config.js";
import { locateEnvKeysFile, parsePrivateKeyValue } from "../deploy/keys.js";
import { findServerAppsForProject } from "../deploy/trusted-origins.js";
import {
  type ProjectManifest,
  findManifestDirUpward,
  readManifest,
  resolveProjectDir,
} from "../scaffold/manifest.js";
import { detectRepoSlug } from "../secrets/push.js";
import { CoolifyApi } from "../utils/coolify-api.js";
import { exec } from "../utils/exec.js";
import { SECRET_KEYS, getSecret } from "../utils/secrets.js";
import { type DeferralKind, resolveDeferredSteps } from "./deferrals.js";
import { CLIENT_DSN_VAR, SENTRY_DSN_KEY, dsnHostMismatch } from "./glitchtip.js";

/** What a target holds right now. `hidden` = the key exists but the
 *  credential can't read its value. */
export type LiveDsn = { kind: "absent" } | { kind: "hidden" } | { kind: "value"; value: string };

export type DsnWriteDecision = "create" | "replace" | "in-sync" | "keep" | "unreadable";

/** Rules 1–3 of the module header, for one target. */
export function decideDsnWrite(
  live: LiveDsn,
  dsn: string,
  glitchtipUrl?: string,
): DsnWriteDecision {
  if (live.kind === "absent") return "create";
  if (live.kind === "hidden") return "unreadable";
  const value = live.value.trim();
  if (value === dsn) return "in-sync";
  if (value === "" || value.startsWith("CHANGE_ME")) return "replace";
  // The same public key under another host is this very key, rendered
  // while the server's GLITCHTIP_DOMAIN was wrong.
  const key = dsnKey(value);
  if (key && key === dsnKey(dsn)) return "replace";
  // A DSN on the GlitchTip host hatchkit talks to is a superseded key of
  // ours. Without a configured URL to compare against, nothing is ours.
  if (glitchtipUrl && key && !dsnHostMismatch(value, glitchtipUrl)) return "replace";
  return "keep";
}

/** The DSN's public key, or undefined for anything that isn't a DSN. */
function dsnKey(value: string): string | undefined {
  try {
    return new URL(value).username || undefined;
  } catch {
    return undefined;
  }
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "another host";
  }
}

export type DsnDeliveryStatus =
  /** The key was absent and now holds the DSN (read back). */
  | "created"
  /** An empty, placeholder or superseded value was replaced (read back). */
  | "updated"
  | "in-sync"
  /** Holds a DSN for another host — left as is. */
  | "kept"
  /** Coolify token can't read the existing value — left as is. */
  | "unreadable"
  /** `write: false` — what a real run would do. */
  | "would-write"
  /** Nowhere to deliver to (no Coolify, no app, no repo). */
  | "skipped"
  | "failed";

export interface DsnDeliveryOutcome {
  target: "coolify" | "gh-variable";
  /** Coolify app name, or `owner/repo`. */
  where: string;
  key: string;
  status: DsnDeliveryStatus;
  detail?: string;
  /** The exact command that delivers the value (gh only). */
  command?: string;
}

type DeliveryCoolify = Pick<
  CoolifyApi,
  "findApplicationByName" | "listAppEnvRows" | "setAppEnv" | "createAppEnv"
>;

export interface DeliverGlitchtipDsnArgs {
  /** Project root holding `.hatchkit.json`, or the subdir a project in
   *  a monorepo deploys from (its manifest is at the repo root). */
  projectDir?: string;
  /** DSN the server reads as SENTRY_DSN. */
  server?: string;
  /** DSN the client build reads as NEXT_PUBLIC_SENTRY_DSN. */
  client?: string;
  /** False under `--no-write`: probe and print, change nothing. */
  write: boolean;
  /** create: no app has booted yet, and the push that ends the run
   *  deploys them, so there is nothing to tell the user to redeploy. */
  firstDeployPending?: boolean;
  /** Test seams. Default: the configured Coolify / GlitchTip, the
   *  project's `origin` remote, console.log. */
  api?: DeliveryCoolify | null;
  glitchtipUrl?: string;
  repoSlug?: string | null;
  log?: (line: string) => void;
}

/** Deliver the DSNs to Coolify (`SENTRY_DSN` on each server app) and the
 *  repo variable (`NEXT_PUBLIC_SENTRY_DSN`). Never throws: every target
 *  gets an outcome, and a failed one says how to finish it by hand. */
export async function deliverGlitchtipDsn(
  args: DeliverGlitchtipDsnArgs,
): Promise<DsnDeliveryOutcome[]> {
  const log = args.log ?? ((line: string) => console.log(line));
  const project = args.projectDir ? locateProject(args.projectDir) : null;
  const glitchtipUrl = args.glitchtipUrl ?? (await getGlitchtipConfig().catch(() => null))?.url;
  const outcomes: DsnDeliveryOutcome[] = [];
  if (!args.server && !args.client) return outcomes;

  log(chalk.bold("\n  ── GlitchTip DSN delivery ────────────────────────────────\n"));

  if (args.server) {
    outcomes.push(
      ...(await deliverServer({ ...args, server: args.server, project, glitchtipUrl, log })),
    );
  }
  if (args.client && project?.manifest.surfaces !== "backend") {
    outcomes.push(
      await deliverClient({ ...args, client: args.client, project, glitchtipUrl, log }),
    );
  }

  const restart = outcomes.filter(
    (o) => o.target === "coolify" && (o.status === "created" || o.status === "updated"),
  );
  if (restart.length > 0 && !args.firstDeployPending) {
    log(
      chalk.yellow(
        `  The server reads ${SENTRY_DSN_KEY} once, at boot: redeploy ${restart.map((o) => `"${o.where}"`).join(", ")} to start reporting.`,
      ),
    );
  }
  if (
    outcomes.some(
      (o) => o.target === "gh-variable" && (o.status === "created" || o.status === "updated"),
    )
  ) {
    log(
      chalk.yellow(
        `  The client bundle inlines ${CLIENT_DSN_VAR} at build time: the next client build picks it up.`,
      ),
    );
  }
  return outcomes;
}

/** A project's manifest, the directory that holds it, and the directory
 *  it deploys from (where its compose file is). The two differ for a
 *  project deployed from a subdir of its repo: create and adopt keep
 *  `.hatchkit.json` at the repo root but provision from the subdir. A
 *  manifest further up whose `projectSubdir` doesn't lead back to
 *  `projectDir` is another project's, and is ignored. */
interface LocatedProject {
  manifest: ProjectManifest;
  rootDir: string;
  deployDir: string;
}

function locateProject(projectDir: string): LocatedProject | null {
  const rootDir = findManifestDirUpward(projectDir);
  const manifest = rootDir ? readManifest(rootDir) : null;
  if (!rootDir || !manifest) return null;
  const deployDir = resolveProjectDir(rootDir, manifest);
  if (resolve(rootDir) !== resolve(projectDir) && resolve(deployDir) !== resolve(projectDir)) {
    return null;
  }
  return { manifest, rootDir, deployDir };
}

// ── create / adopt ───────────────────────────────────────────────────

/** Deferral key create records when a target was left without the DSN.
 *  Any later delivery that leaves nothing open clears it. */
export const DSN_DELIVERY_STEP_KEY = "glitchtip-dsn-delivery";
const DSN_DELIVERY_LABEL = "GlitchTip DSN → Coolify / repo variable";

export interface DsnDeliveryFollowUp {
  key: string;
  label: string;
  /** `failed` when a read or write went wrong; `declined` (shown as
   *  "skipped") when a target wasn't there or couldn't be read. */
  kind: Extract<DeferralKind, "failed" | "declined">;
  /** One line per open target. Never holds the DSN. */
  reason: string;
  command: string;
}

/** The targets a run left without the DSN, as one follow-up for the
 *  flow's end-of-run list. Null when nothing is left: every target
 *  holds the DSN, or holds another tracker's DSN on purpose (`kept`). */
export function dsnDeliveryFollowUp(
  project: string,
  outcomes: readonly DsnDeliveryOutcome[],
): DsnDeliveryFollowUp | null {
  const open = outcomes.filter(
    (o) => o.status === "failed" || o.status === "skipped" || o.status === "unreadable",
  );
  if (open.length === 0) return null;
  return {
    key: DSN_DELIVERY_STEP_KEY,
    label: DSN_DELIVERY_LABEL,
    kind: open.some((o) => o.status === "failed") ? "failed" : "declined",
    reason: open
      .map(
        (o) =>
          `${o.target === "coolify" ? `Coolify ${SENTRY_DSN_KEY}` : `${CLIENT_DSN_VAR} repo variable`}: ${firstSentence(o.detail ?? o.status)}`,
      )
      .join("; "),
    command: `hatchkit add ${project} glitchtip --adopt`,
  };
}

/** The opening sentence of a detail, without the `Run: gh variable set
 *  … --body <DSN>` instruction some details end with. */
function firstSentence(detail: string): string {
  return detail.split(" Run: ")[0].split(/\.\s/)[0].replace(/[.:]$/, "");
}

/** create / adopt: deliver the DSNs `runProvision` returned. Unlike
 *  `deliverGlitchtipDsn` it cannot throw (an unreadable manifest, a
 *  keychain error), because a throw inside either flow reaches its
 *  rollback prompt. When nothing is left open, a recorded
 *  {@link DSN_DELIVERY_STEP_KEY} deferral is cleared. */
export async function deliverProvisionedDsn(
  args: DeliverGlitchtipDsnArgs & { project: string },
): Promise<{ outcomes: DsnDeliveryOutcome[]; followUp: DsnDeliveryFollowUp | null }> {
  let outcomes: DsnDeliveryOutcome[];
  try {
    outcomes = await deliverGlitchtipDsn(args);
  } catch (err) {
    const reason = firstLine(err);
    (args.log ?? ((line: string) => console.log(line)))(
      chalk.red(`  ✗ GlitchTip DSN delivery: ${reason}`),
    );
    return {
      outcomes: [],
      followUp: {
        key: DSN_DELIVERY_STEP_KEY,
        label: DSN_DELIVERY_LABEL,
        kind: "failed",
        reason,
        command: `hatchkit add ${args.project} glitchtip --adopt`,
      },
    };
  }
  const followUp = dsnDeliveryFollowUp(args.project, outcomes);
  if (!followUp && args.write && args.projectDir) {
    try {
      const rootDir = locateProject(args.projectDir)?.rootDir;
      if (rootDir) resolveDeferredSteps(rootDir, [DSN_DELIVERY_STEP_KEY]);
    } catch {
      // The DSN is delivered. A stale entry only repeats a command that
      // now finds both targets in sync.
    }
  }
  return { outcomes, followUp };
}

// ── adopt --resume ───────────────────────────────────────────────────

/** Where a resumed adopt looks for the DSN, per side: the name the
 *  starter reads first, so when both hold a DSN on this GlitchTip the
 *  one the app runs with wins; then hatchkit's own, last because
 *  `readGlitchtipDsnFromEnv` keeps only it when no GlitchTip URL is
 *  configured. A DSN on another host (the glitchtip.example.com values
 *  `add` wrote before f49c942) is dropped by the host check, whatever
 *  its place. */
const RESUME_DSN_NAMES = {
  server: [SENTRY_DSN_KEY, "GLITCHTIP_DSN"],
  client: [CLIENT_DSN_VAR, "PUBLIC_GLITCHTIP_DSN"],
} as const;

export interface DsnFromEnv {
  server?: string;
  client?: string;
  /** Why a side yields no DSN, one line each. Never holds a value. */
  problems: string[];
}

/** The DSNs a project's `.env.production` files hold, for `adopt
 *  --resume`. Per side, the first name whose value is a DSN on the
 *  configured GlitchTip host; without a configured URL, only hatchkit's
 *  own name (`SENTRY_DSN` may belong to another tracker). Values are
 *  decrypted in memory with the key from `.env.keys` or the keychain,
 *  and never printed. Never throws. */
export async function readGlitchtipDsnFromEnv(args: {
  project: string;
  projectDir: string;
  serverEnvPath?: string | null;
  clientEnvPath?: string | null;
  /** Test seams. Default: the configured GlitchTip URL, and the
   *  project's `.env.keys` then its keychain entry. */
  glitchtipUrl?: string | null;
  privateKey?: string | null;
}): Promise<DsnFromEnv> {
  const out: DsnFromEnv = { problems: [] };
  const glitchtipUrl =
    args.glitchtipUrl === undefined
      ? (await getGlitchtipConfig().catch(() => null))?.url
      : (args.glitchtipUrl ?? undefined);
  let cachedKey = args.privateKey;
  const keyFor = async (envPath: string): Promise<string | undefined> => {
    if (cachedKey !== undefined) return cachedKey ?? undefined;
    cachedKey = null;
    for (const keysPath of [
      join(dirname(envPath), ".env.keys"),
      locateEnvKeysFile(args.projectDir),
    ]) {
      if (keysPath && existsSync(keysPath)) {
        cachedKey = parsePrivateKeyValue(readFileSync(keysPath, "utf-8")) ?? null;
        if (cachedKey) return cachedKey;
      }
    }
    cachedKey =
      (await getSecret(SECRET_KEYS.dotenvxPrivateKey(args.project)).catch(() => null)) ?? null;
    return cachedKey ?? undefined;
  };

  for (const side of ["server", "client"] as const) {
    const envPath = side === "server" ? args.serverEnvPath : args.clientEnvPath;
    if (!envPath || !existsSync(envPath)) continue;
    const file = relative(args.projectDir, envPath) || envPath;
    try {
      const text = readFileSync(envPath, "utf-8");
      const privateKey = await keyFor(envPath);
      // Without a key dotenvx prints an error per encrypted value; one
      // line here says the same.
      if (!privateKey && /^\s*[A-Za-z_]\w*\s*=\s*["']?encrypted:/m.test(text)) {
        out.problems.push(
          `couldn't decrypt ${file}: no DOTENV_PRIVATE_KEY_PRODUCTION in .env.keys or the keychain`,
        );
        continue;
      }
      const env = parseDotenv(text, { privateKey, processEnv: {} }) as Record<string, string>;
      const names = glitchtipUrl ? RESUME_DSN_NAMES[side] : RESUME_DSN_NAMES[side].slice(-1);
      const present = names.filter((name) => (env[name] ?? "").trim() !== "");
      if (present.some((name) => env[name].startsWith("encrypted:"))) {
        out.problems.push(
          `couldn't decrypt ${file}: the DOTENV_PRIVATE_KEY_PRODUCTION found doesn't open it`,
        );
        continue;
      }
      const dsns = present.filter((name) => dsnKey(env[name].trim()) !== undefined);
      const pick = dsns.find(
        (name) => !glitchtipUrl || !dsnHostMismatch(env[name].trim(), glitchtipUrl),
      );
      if (pick) {
        out[side] = env[pick].trim();
      } else if (dsns.length > 0) {
        out.problems.push(
          `${dsns.join(" / ")} in ${file} point${dsns.length === 1 ? "s" : ""} at ${hostOf(env[dsns[0]].trim())}, not ${hostOf(glitchtipUrl ?? "")}. If GlitchTip's GLITCHTIP_DOMAIN was wrong, fix it and redeploy GlitchTip`,
        );
      } else {
        out.problems.push(`no GlitchTip DSN under ${names.join(" / ")} in ${file}`);
      }
    } catch (err) {
      out.problems.push(`couldn't read ${file}: ${firstLine(err)}`);
    }
  }
  return out;
}

// ── Coolify ──────────────────────────────────────────────────────────

async function deliverServer(
  args: DeliverGlitchtipDsnArgs & {
    server: string;
    project: LocatedProject | null;
    glitchtipUrl?: string;
    log: (line: string) => void;
  },
): Promise<DsnDeliveryOutcome[]> {
  const { project, log } = args;
  const skip = (where: string, detail: string): DsnDeliveryOutcome[] => {
    log(chalk.dim(`  · Coolify ${SENTRY_DSN_KEY}: ${detail}`));
    return [{ target: "coolify", where, key: SENTRY_DSN_KEY, status: "skipped", detail }];
  };
  if (!project) {
    return skip(
      "-",
      `no .hatchkit.json to find the server app from. If it runs on Coolify, set ${SENTRY_DSN_KEY} there to the DSN in .env.production.`,
    );
  }
  const { manifest } = project;
  if ((manifest.deploymentMode ?? "coolify") !== "coolify" || manifest.surfaces === "static") {
    return [];
  }
  let api = args.api;
  if (api === undefined) {
    const cfg = await getCoolifyConfig();
    api = cfg ? new CoolifyApi({ url: cfg.url, token: cfg.token }) : null;
  }
  if (!api) {
    return skip(
      manifest.name,
      `Coolify isn't configured. Set ${SENTRY_DSN_KEY} on the server app to the DSN in .env.production.`,
    );
  }
  let apps: Array<{ uuid: string; name: string }>;
  try {
    apps = await findServerAppsForProject({ api, projectDir: project.deployDir, manifest });
  } catch (err) {
    return [
      failed(
        log,
        manifest.name,
        `couldn't list Coolify apps: ${firstLine(err)}. Set ${SENTRY_DSN_KEY} on the server app by hand.`,
      ),
    ];
  }
  if (apps.length === 0) {
    return skip(
      manifest.name,
      `no Coolify server app for "${manifest.name}" yet. Once it exists, re-run \`hatchkit add ${manifest.name} glitchtip --adopt\` to set ${SENTRY_DSN_KEY} on it.`,
    );
  }
  const out: DsnDeliveryOutcome[] = [];
  for (const app of apps) {
    out.push(await deliverToCoolifyApp({ ...args, api, app }));
  }
  return out;
}

async function readCoolifyDsn(api: DeliveryCoolify, uuid: string): Promise<LiveDsn> {
  const rows = (await api.listAppEnvRows(uuid)).filter(
    (r) => !r.isPreview && r.key === SENTRY_DSN_KEY,
  );
  if (rows.length === 0) return { kind: "absent" };
  const value = rows[0].value;
  return value === undefined ? { kind: "hidden" } : { kind: "value", value };
}

async function deliverToCoolifyApp(args: {
  api: DeliveryCoolify;
  app: { uuid: string; name: string };
  server: string;
  write: boolean;
  glitchtipUrl?: string;
  log: (line: string) => void;
}): Promise<DsnDeliveryOutcome> {
  const { api, app, server: dsn, log } = args;
  const base = { target: "coolify" as const, where: app.name, key: SENTRY_DSN_KEY };
  let live: LiveDsn;
  try {
    live = await readCoolifyDsn(api, app.uuid);
  } catch (err) {
    return failed(log, app.name, `couldn't read env on "${app.name}": ${firstLine(err)}`);
  }
  const decision = decideDsnWrite(live, dsn, args.glitchtipUrl);
  if (decision === "in-sync") {
    log(chalk.green(`  ✓ Coolify "${app.name}": ${SENTRY_DSN_KEY} already holds this DSN`));
    return { ...base, status: "in-sync" };
  }
  if (decision === "keep") {
    const detail = `${SENTRY_DSN_KEY} holds a DSN for ${live.kind === "value" ? hostOf(live.value) : "another host"}; left as is. It overrides .env.production, so this app keeps reporting there. Replace it in Coolify if it is stale.`;
    log(chalk.yellow(`  ! Coolify "${app.name}": ${detail}`));
    return { ...base, status: "kept", detail };
  }
  if (decision === "unreadable") {
    const detail = `${SENTRY_DSN_KEY} exists, but this Coolify token can't read values (it lacks read:sensitive), so hatchkit won't overwrite it blind. An empty value hides the DSN in .env.production: set it in Coolify → "${app.name}" → Environment Variables.`;
    log(chalk.yellow(`  ! Coolify "${app.name}": ${detail}`));
    return { ...base, status: "unreadable", detail };
  }
  const verb = decision === "create" ? "create" : `replace the ${describeLive(live)}`;
  if (!args.write) {
    const detail = `would ${verb} ${SENTRY_DSN_KEY} (the DSN is in the provisioned cache)`;
    log(chalk.dim(`  · Coolify "${app.name}": ${detail}`));
    return { ...base, status: "would-write", detail };
  }
  try {
    await api.setAppEnv(app.uuid, { [SENTRY_DSN_KEY]: dsn });
    let check = await readCoolifyDsn(api, app.uuid);
    if (check.kind === "absent") {
      await api.createAppEnv(app.uuid, SENTRY_DSN_KEY, dsn);
      check = await readCoolifyDsn(api, app.uuid);
    }
    if (check.kind === "absent") {
      throw new Error(`Coolify accepted the write but ${SENTRY_DSN_KEY} is absent on read-back`);
    }
    if (check.kind === "value" && check.value.trim() !== dsn) {
      throw new Error("read-back doesn't match the DSN that was written");
    }
  } catch (err) {
    return failed(
      log,
      app.name,
      `${SENTRY_DSN_KEY} write to "${app.name}" not confirmed: ${firstLine(err)}`,
    );
  }
  const status = decision === "create" ? "created" : "updated";
  log(
    chalk.green(
      `  ✓ Coolify "${app.name}": ${SENTRY_DSN_KEY} ${status === "created" ? "set" : `replaced the ${describeLive(live)}`} (read back)`,
    ),
  );
  return { ...base, status };
}

function describeLive(live: LiveDsn): string {
  if (live.kind !== "value") return "value";
  const v = live.value.trim();
  if (v === "") return "empty value";
  if (v.startsWith("CHANGE_ME")) return "placeholder";
  return "superseded DSN";
}

// ── GitHub repo variable ─────────────────────────────────────────────

/** Quote for a command the reader pastes into a shell. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function ghVariableSetCommand(repo: string | undefined, dsn: string): string {
  return `gh variable set ${CLIENT_DSN_VAR} --repo ${repo ?? "<owner/name>"} --body ${shellQuote(dsn)}`;
}

async function readRepoVariable(repo: string): Promise<LiveDsn> {
  const res = await exec("gh", ["api", `repos/${repo}/actions/variables/${CLIENT_DSN_VAR}`], {
    silent: true,
  });
  if (res.exitCode !== 0) {
    if (/404|Not Found/.test(res.stderr + res.stdout)) return { kind: "absent" };
    throw new Error((res.stderr || res.stdout).trim() || `gh api exited ${res.exitCode}`);
  }
  const value = (JSON.parse(res.stdout) as { value?: string }).value ?? "";
  return { kind: "value", value };
}

async function deliverClient(
  args: DeliverGlitchtipDsnArgs & {
    client: string;
    project: LocatedProject | null;
    glitchtipUrl?: string;
    log: (line: string) => void;
  },
): Promise<DsnDeliveryOutcome> {
  const { client: dsn, log } = args;
  const repo =
    args.repoSlug === undefined
      ? await detectRepoSlug(args.projectDir ?? process.cwd())
      : (args.repoSlug ?? undefined);
  const command = ghVariableSetCommand(repo, dsn);
  const base = {
    target: "gh-variable" as const,
    where: repo ?? "-",
    key: CLIENT_DSN_VAR,
    command,
  };
  if (!repo) {
    const detail = `no GitHub origin remote to set ${CLIENT_DSN_VAR} on. Run, with the repo filled in:`;
    log(chalk.yellow(`  ! Repo variable: ${detail}`));
    log(`      ${command}`);
    return { ...base, status: "skipped", detail };
  }
  // Workflows live at the repo root, above a subdir-deployed project.
  warnIfNoWorkflowReads(args.project?.rootDir ?? args.projectDir, log);

  let live: LiveDsn | undefined;
  try {
    live = await readRepoVariable(repo);
  } catch (err) {
    if (args.write) {
      return failed(
        log,
        repo,
        `couldn't read ${CLIENT_DSN_VAR} on ${repo}: ${firstLine(err)}. Run: ${command}`,
        "gh-variable",
        CLIENT_DSN_VAR,
        command,
      );
    }
  }
  const decision = live ? decideDsnWrite(live, dsn, args.glitchtipUrl) : "create";
  if (decision === "in-sync") {
    log(chalk.green(`  ✓ ${repo}: ${CLIENT_DSN_VAR} already holds this DSN`));
    return { ...base, status: "in-sync" };
  }
  if (decision === "keep") {
    const detail = `${CLIENT_DSN_VAR} holds a DSN for ${live?.kind === "value" ? hostOf(live.value) : "another host"}; left as is. To switch the client to this project, run: ${command}`;
    log(chalk.yellow(`  ! ${repo}: ${detail}`));
    return { ...base, status: "kept", detail };
  }
  if (!args.write) {
    log(chalk.dim(`  · ${repo}: not written (--no-write). To set ${CLIENT_DSN_VAR}, run:`));
    log(`      ${command}`);
    return { ...base, status: "would-write" };
  }
  try {
    const res = await exec(
      "gh",
      ["variable", "set", CLIENT_DSN_VAR, "--repo", repo, "--body", dsn],
      { silent: true },
    );
    if (res.exitCode !== 0) {
      throw new Error((res.stderr || res.stdout).trim() || `gh exited ${res.exitCode}`);
    }
    const check = await readRepoVariable(repo);
    if (check.kind !== "value" || check.value.trim() !== dsn) {
      throw new Error("read-back doesn't match the DSN that was written");
    }
  } catch (err) {
    return failed(
      log,
      repo,
      `${CLIENT_DSN_VAR} on ${repo} not confirmed: ${firstLine(err)}. Run: ${command}`,
      "gh-variable",
      CLIENT_DSN_VAR,
      command,
    );
  }
  const status = live?.kind === "absent" ? "created" : "updated";
  log(
    chalk.green(
      `  ✓ ${repo}: ${CLIENT_DSN_VAR} ${status === "created" ? "set" : `replaced the ${describeLive(live ?? { kind: "absent" })}`} (read back)`,
    ),
  );
  return { ...base, status };
}

/** Like mac-runner's check: the variable does nothing unless a workflow
 *  passes it into the client build. Silent when there's no checkout. */
function warnIfNoWorkflowReads(projectDir: string | undefined, log: (line: string) => void): void {
  if (!projectDir) return;
  const dir = join(projectDir, ".github", "workflows");
  if (!existsSync(dir)) return;
  const reads = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .some((f) => readFileSync(join(dir, f), "utf-8").includes(`vars.${CLIENT_DSN_VAR}`));
  if (reads) return;
  log(
    chalk.yellow(
      `  ! No workflow in ${dir} reads vars.${CLIENT_DSN_VAR}, so the client build won't see it. Pass it as a build arg: ${CLIENT_DSN_VAR}=\${{ vars.${CLIENT_DSN_VAR} }}.`,
    ),
  );
}

// ── shared ───────────────────────────────────────────────────────────

function failed(
  log: (line: string) => void,
  where: string,
  detail: string,
  target: DsnDeliveryOutcome["target"] = "coolify",
  key: string = SENTRY_DSN_KEY,
  command?: string,
): DsnDeliveryOutcome {
  log(chalk.red(`  ✗ ${detail}`));
  return { target, where, key, status: "failed", detail, ...(command ? { command } : {}) };
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}
