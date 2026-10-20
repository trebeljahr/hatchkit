/*
 * `hatchkit migrate-client` — serve a deployed fullstack project's
 * client from Cloudflare Workers static assets while the API stays on
 * Coolify, on the same hostname. Design and live proof: the vault note
 * cloudflare-client-topology-2026-10-12 (sections 6 and 10).
 *
 * Side by side, like migrate-runtime. The Coolify client app is never
 * touched by the move: it keeps running, unrouted, so `--rollback` is
 * one route deletion (Traefik answered again 8 s after it on the
 * canary). `--cleanup` deletes it after the soak.
 *
 *   0. Preflight, read-only: manifest, client code a static export
 *      cannot serve, live probes, and (with the provisioner) the zone:
 *      proxied records, foreign routes, the HTTPS rule.
 *   1. Repo files, written locally and never committed or pushed:
 *      wrangler.jsonc, _headers, _redirects, scripts/carry-static.mjs,
 *      the record-ship action, the workflow rewrite
 *      (client-host-workflow.ts). `--repo-only` stops here.
 *   2. The Worker, its own deploy token, CLOUDFLARE_API_TOKEN /
 *      CLOUDFLARE_ACCOUNT_ID on the repo (existing hatchkit code).
 *   3. First version: a local export of HEAD, uploaded and activated.
 *      Nothing routes to the Worker yet, so activation is invisible.
 *   4. HTTPS: the hosts join hatchkit's one Single Redirect rule on the
 *      zone (client-host.ts says why not Always Use HTTPS).
 *   5. No-Worker routes (`/api/*`, the ACME path). Inert alone; checked.
 *   6. `<domain>/*` → the Worker: the cutover. Checked against a
 *      baseline taken before step 5; any failed check deletes the route
 *      again at once.
 *   7. `.hatchkit.json` gets `clientHost: "cloudflare"`.
 *
 * Every write is recorded twice: in the project's run ledger (so
 * `hatchkit destroy` can undo it) and in a migration state file under
 * the config dir (so --rollback and --cleanup never guess).
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { getStore } from "../config.js";
import { readManifest } from "../scaffold/manifest.js";
import type { ProjectManifest } from "../scaffold/manifest.js";
import { CARRY_SCRIPT_REL_PATH, WRANGLER_PACKAGE } from "../scaffold/worker-assets.js";
import { exec } from "../utils/exec.js";
import { RunLedger } from "../utils/run-ledger.js";
import {
  CLIENT_EXPORT_DIR,
  type ClientScan,
  checkExportDir,
  scanClientProject,
  workerConfigFindings,
  writeClientRepoFiles,
} from "./client-host-repo.js";
import {
  type EdgeContext,
  addHttpsRedirectHosts,
  applyEdgeRoutes,
  preflightEdge,
  removeEdgeRoutes,
  removeHttpsRedirectHosts,
  resolveEdgeContext,
} from "./client-host.js";
import { readWorkerName } from "./cloudflare.js";
import { resolveCoolifyRuntime } from "./image-runtime.js";
import {
  DEFAULT_ORIGIN_PATHS,
  type EdgePlan,
  type RoutingPlan,
  computeRoutingPlan,
  defaultClientWorkerName,
  inferTopology,
} from "./routing.js";

export interface MigrateClientOptions {
  projectDir: string;
  action: "migrate" | "rollback" | "cleanup";
  dryRun: boolean;
  /** Write the repo files and stop: no provider is touched. */
  repoOnly: boolean;
  yes: boolean;
  /** Worker name; default wrangler.jsonc `name`, else `<name>-client`. */
  worker?: string;
  /** Override `originPaths` (each a path prefix such as `/api`). */
  originPaths?: string[];
  /** `--cleanup` before the 7-day soak is over. */
  skipSoak?: boolean;
  /** `--cleanup` keeps the GHCR client image package. */
  keepPackage?: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ClientMigrationState {
  version: 1;
  project: string;
  domain: string;
  worker: string;
  accountId?: string;
  zoneId?: string;
  phase: "prepared" | "routed" | "cut-over" | "rolled-back" | "cleaned";
  /** Hosts this migration added to hatchkit's HTTPS rule. */
  httpsHostsAdded: string[];
  /** Patterns of routes this migration created. */
  routesCreated: string[];
  firstVersionId?: string;
  /** When the cutover was verified; the soak runs from here. */
  cutOverAt?: string;
  /** The Coolify client app left running for --rollback. */
  coolifyClientApp?: { uuid: string; name: string };
  updatedAt: string;
}

function stateDir(): string {
  return join(dirname(getStore().path), "client-migrations");
}

export function statePath(project: string): string {
  return join(stateDir(), `${project.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

export function loadState(project: string): ClientMigrationState | null {
  const path = statePath(project);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as ClientMigrationState;
}

function saveState(state: ClientMigrationState): void {
  mkdirSync(stateDir(), { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(statePath(state.project), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface ClientMigrationPlan {
  manifest: ProjectManifest;
  worker: string;
  siteUrl: string;
  apiUrl: string;
  routing: RoutingPlan;
  edge: EdgePlan;
  scan: ClientScan;
  /** Manifest problems; each blocks. */
  blocking: string[];
}

/** Everything decided from local files, no network. */
export function planClientMigration(
  projectDir: string,
  opts: Pick<MigrateClientOptions, "worker" | "originPaths"> = {},
): ClientMigrationPlan {
  const manifest = readManifest(projectDir);
  if (!manifest) throw new Error(`No .hatchkit.json in ${projectDir}.`);
  const blocking: string[] = [];
  const runtime = resolveCoolifyRuntime(manifest.coolifyRuntime);
  if ((manifest.deploymentMode ?? "coolify") !== "coolify") {
    blocking.push(
      `deploymentMode is "${manifest.deploymentMode}"; migrate-client moves a Coolify project's client.`,
    );
  }
  if (manifest.surfaces !== "fullstack" && manifest.surfaces !== "split") {
    blocking.push(
      `surfaces is "${manifest.surfaces}". ${manifest.surfaces === "static" ? "A static site uses `hatchkit cloudflare`." : "There is no client to move."}`,
    );
  }
  if (runtime !== "image") {
    blocking.push('coolifyRuntime is not "image"; run `hatchkit migrate-runtime` first.');
  }
  const topology = inferTopology({ topology: manifest.topology }).topology;
  const worker =
    opts.worker ?? readWorkerName(projectDir) ?? defaultClientWorkerName(manifest.name);
  const originPaths = opts.originPaths ?? manifest.originPaths;
  const siteUrl = `https://${manifest.domain}`;
  const apiUrl = topology === "split" ? `https://api.${manifest.domain}` : siteUrl;
  const routing = computeRoutingPlan({
    name: manifest.name,
    domain: manifest.domain,
    hostnameAliases: (manifest.aliases ?? []).map((a) => a.toLowerCase()),
    topology,
    // Anything but fullstack is already in `blocking`; plan it as
    // fullstack so --dry-run can still print the whole picture.
    surfaces: "fullstack",
    runtime: "image",
    clientHost: "cloudflare",
    clientWorker: worker,
    ...(originPaths ? { originPaths } : {}),
  });
  if (!routing.edge) throw new Error("routing plan has no edge part");
  return {
    manifest,
    worker,
    siteUrl,
    apiUrl,
    routing,
    edge: routing.edge,
    scan: scanClientProject(projectDir),
    blocking,
  };
}

export function printPlan(plan: ClientMigrationPlan): void {
  const { manifest, edge } = plan;
  console.log(chalk.bold(`\n  ${manifest.name}`) + chalk.dim(` → ${manifest.domain}`));
  console.log(chalk.dim(`    topology ${plan.routing.topology}, API at ${plan.apiUrl}`));
  console.log(chalk.bold("\n  Cloudflare (zone routes, in creation order):"));
  for (const r of edge.routes) {
    console.log(`    ${r.pattern.padEnd(56)} → ${r.script ?? chalk.dim("no Worker (origin)")}`);
  }
  console.log(chalk.dim(`    HTTPS redirect for: ${edge.hosts.join(", ")}`));
  console.log(chalk.bold("\n  Coolify after the move:"));
  for (const app of plan.routing.apps) {
    console.log(`    ${app.appName.padEnd(28)} ${app.flatDomains.join(", ")}`);
  }
  console.log(
    chalk.dim(
      `    ${manifest.name}-client keeps running unrouted until --cleanup (rollback target).`,
    ),
  );
  const { scan } = plan;
  console.log(chalk.bold("\n  Client scan:"));
  console.log(chalk.dim(`    build: ${scan.buildCommands.join(" && ")} (NEXT_FILE_EXPORT=1)`));
  for (const r of scan.redirects) console.log(chalk.dim(`    _redirects: ${r}`));
  for (const w of scan.warnings) console.log(chalk.yellow(`    ! ${w}`));
  for (const b of [...plan.blocking, ...scan.blocking]) console.log(chalk.red(`    ✗ ${b}`));
  if (!plan.blocking.length && !scan.blocking.length)
    console.log(chalk.green("    ✓ nothing blocks the export"));
}

// ---------------------------------------------------------------------------
// Live probes (read-only, no credentials)
// ---------------------------------------------------------------------------

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SiteSnapshot {
  healthStatus: number;
  healthVersion?: string;
  signInStatus: number;
  ws: string;
  notFoundStatus: number;
  /** `x-powered-by` of the 404 answer: Next.js means the Coolify client. */
  notFoundPoweredBy?: string;
  httpStatus: number;
  httpLocation?: string;
  versionCommit?: string;
  versionApiUrl?: string;
}

const cb = (): string => `hatchkit_cb=${randomBytes(4).toString("hex")}`;

/** What the site answers on every path the move changes. */
export async function snapshotSite(
  siteUrl: string,
  apiUrl: string,
  fetchImpl: FetchLike = fetch,
  wsProbe: (url: string) => Promise<string> = probeWebSocket,
): Promise<SiteSnapshot> {
  const get = async (url: string, init?: RequestInit): Promise<Response | null> =>
    fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...init }).catch(
      () => null,
    );
  const health = await get(`${apiUrl}/api/health?${cb()}`);
  let healthVersion: string | undefined;
  if (health?.ok) {
    const body = (await health.json().catch(() => null)) as { version?: string } | null;
    healthVersion = body?.version ?? undefined;
  }
  // The deploy workflow's own origin probe: a trusted origin reaches the
  // credential check and gets 401 for an address that cannot exist.
  const signIn = await get(`${apiUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { Origin: siteUrl, "Sec-Fetch-Mode": "cors", "content-type": "application/json" },
    body: JSON.stringify({
      email: "hatchkit-origin-probe@example.invalid",
      password: "hatchkit-origin-probe",
    }),
  });
  const missing = await get(`${siteUrl}/hatchkit-probe-${randomBytes(4).toString("hex")}/`);
  const http = await get(`${siteUrl.replace(/^https:/, "http:")}/`);
  const version = await get(`${siteUrl}/version.json?${cb()}`);
  let versionCommit: string | undefined;
  let versionApiUrl: string | undefined;
  if (version?.ok) {
    const body = (await version.json().catch(() => null)) as {
      commit?: string;
      apiUrl?: string;
    } | null;
    versionCommit = body?.commit;
    versionApiUrl = body?.apiUrl;
  }
  return {
    healthStatus: health?.status ?? 0,
    healthVersion,
    signInStatus: signIn?.status ?? 0,
    ws: await wsProbe(`${apiUrl.replace(/^http/, "ws")}/api/ws`),
    notFoundStatus: missing?.status ?? 0,
    notFoundPoweredBy: missing?.headers.get("x-powered-by") ?? undefined,
    httpStatus: http?.status ?? 0,
    httpLocation: http?.headers.get("location") ?? undefined,
    versionCommit,
    versionApiUrl,
  };
}

/** Unauthenticated WebSocket upgrade. The answer's CLASS is what the
 *  cutover compares: `upgraded`, `dropped` (the server closes an
 *  unauthenticated upgrade — the canary's behaviour), or `http <code>`. */
export function probeWebSocket(wsUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const url = new URL(wsUrl.replace(/^ws/, "http"));
    const req = httpsRequest(
      {
        host: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        },
        timeout: 15_000,
      },
      (res) => {
        res.resume();
        resolve(`http ${res.statusCode}`);
      },
    );
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve("upgraded");
    });
    req.on("timeout", () => {
      req.destroy();
      resolve("timeout");
    });
    req.on("error", () => resolve("dropped"));
    req.end();
  });
}

/** Cutover checks: the API paths answer as they did before, and
 *  everything else now comes from the Worker. Returns failures. */
export function compareCutover(
  before: SiteSnapshot,
  after: SiteSnapshot,
  expect: { commit: string; apiUrl: string; siteUrl: string },
): string[] {
  const failures: string[] = [];
  if (after.healthStatus !== 200)
    failures.push(`/api/health answered ${after.healthStatus}, not 200.`);
  if (after.signInStatus !== before.signInStatus) {
    failures.push(
      `sign-in origin probe answered ${after.signInStatus}, was ${before.signInStatus}.`,
    );
  }
  if (after.ws !== before.ws)
    failures.push(`/api/ws upgrade answered "${after.ws}", was "${before.ws}".`);
  if (after.versionCommit !== expect.commit) {
    failures.push(
      `/version.json says ${after.versionCommit ?? "<none>"}, expected ${expect.commit}.`,
    );
  }
  if (after.versionApiUrl && after.versionApiUrl !== expect.apiUrl) {
    failures.push(`client built against ${after.versionApiUrl}, expected ${expect.apiUrl}.`);
  }
  if (after.notFoundStatus !== 404)
    failures.push(`an unknown page answered ${after.notFoundStatus}, not 404.`);
  if (after.notFoundPoweredBy)
    failures.push(`an unknown page still came from ${after.notFoundPoweredBy}.`);
  if (
    ![301, 308].includes(after.httpStatus) ||
    !after.httpLocation?.startsWith(`${expect.siteUrl}/`)
  ) {
    failures.push(
      `http:// answered ${after.httpStatus} ${after.httpLocation ?? ""}, not a redirect to ${expect.siteUrl}/.`,
    );
  }
  return failures;
}

// ---------------------------------------------------------------------------
// First version (local build)
// ---------------------------------------------------------------------------

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  const res = await exec(cmd, args, { cwd, env });
  if (res.exitCode !== 0)
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${res.stderr || res.stdout}`);
  return res.stdout;
}

/** Build-time values the workflow takes from repo variables. */
async function repoVariables(projectDir: string, names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const res = await exec("gh", ["variable", "get", name], { cwd: projectDir, silent: true });
    if (res.exitCode === 0) out[name] = res.stdout.trim();
  }
  return out;
}

/**
 * Export HEAD locally, write version.json, carry (nothing on a first
 * upload) and deploy it as the Worker's first version. Returns the
 * version id. Wrangler runs with the provisioner token in its env only.
 */
export async function uploadFirstVersion(args: {
  projectDir: string;
  plan: ClientMigrationPlan;
  commit: string;
  token: string;
  accountId: string;
}): Promise<string> {
  const { projectDir, plan } = args;
  const vars = await repoVariables(projectDir, [
    "NEXT_PUBLIC_PLAUSIBLE_DOMAIN",
    "NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL",
    "NEXT_PUBLIC_SENTRY_DSN",
  ]);
  const env: Record<string, string> = {
    ...vars,
    NEXT_FILE_EXPORT: "1",
    NEXT_PUBLIC_API_URL: plan.apiUrl,
    NEXT_PUBLIC_WS_URL: plan.apiUrl.replace(/^http/, "ws"),
    COMMIT_SHA: args.commit,
  };
  for (const command of plan.scan.buildCommands) {
    console.log(chalk.dim(`    $ ${command}`));
    await run("sh", ["-c", command], projectDir, env);
  }
  const out = join(projectDir, CLIENT_EXPORT_DIR);
  const problems = checkExportDir(out, CLIENT_EXPORT_DIR);
  if (problems.length)
    throw new Error(`export fails the Workers limits:\n  ${problems.join("\n  ")}`);
  writeFileSync(
    join(out, "version.json"),
    `${JSON.stringify({ commit: args.commit, apiUrl: plan.apiUrl })}\n`,
  );
  // A distinct release id for the locally built seed: CI's build of the
  // same commit then carries the seed's chunks under their own entry.
  await run(
    "node",
    [
      CARRY_SCRIPT_REL_PATH,
      "--site",
      plan.siteUrl,
      "--out",
      CLIENT_EXPORT_DIR,
      "--release",
      `${args.commit}-local`,
    ],
    projectDir,
    {},
  );
  const outputFile = join(tmpdir(), `hatchkit-wrangler-${randomBytes(4).toString("hex")}.ndjson`);
  try {
    // The first version may go live in one step: no route sends traffic
    // to the Worker yet, so the seconds of 404s a one-step deploy leaves
    // on new chunks reach nobody. Every later version is uploaded by CI
    // and switched in the deploy job.
    await run(
      "pnpm",
      ["dlx", WRANGLER_PACKAGE, "deploy", "--message", `${args.commit} (hatchkit migrate-client)`],
      projectDir,
      {
        CLOUDFLARE_API_TOKEN: args.token,
        CLOUDFLARE_ACCOUNT_ID: args.accountId,
        WRANGLER_OUTPUT_FILE_PATH: outputFile,
        WRANGLER_SEND_METRICS: "false",
      },
    );
    const row = readFileSync(outputFile, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type?: string; version_id?: string })
      .find((r) => (r.type === "deploy" || r.type === "version-upload") && r.version_id);
    if (!row?.version_id) throw new Error("wrangler reported no version id");
    return row.version_id;
  } finally {
    rmSync(outputFile, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cloudflareContext(edge: EdgePlan): Promise<EdgeContext | null> {
  const { getCloudflareProvisioner } = await import("../config.js");
  const prov = await getCloudflareProvisioner().catch(() => null);
  if (!prov) return null;
  const { CloudflareApi } = await import("../utils/cloudflare-api.js");
  const api = new CloudflareApi({ token: prov.token, accountId: prov.accountId });
  const ctx = await resolveEdgeContext(api, prov.accountId, edge);
  const { getDnsConfig } = await import("../config.js");
  const dns = await getDnsConfig().catch(() => null);
  return dns?.apiToken ? { ...ctx, dnsApi: new CloudflareApi({ token: dns.apiToken }) } : ctx;
}

async function headCommit(projectDir: string): Promise<string> {
  const res = await exec("git", ["rev-parse", "HEAD"], { cwd: projectDir, silent: true });
  if (res.exitCode !== 0) throw new Error("not a git repository");
  return res.stdout.trim();
}

async function repoSlug(projectDir: string): Promise<string> {
  const res = await exec(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    {
      cwd: projectDir,
      silent: true,
    },
  );
  if (res.exitCode !== 0 || !res.stdout.trim())
    throw new Error("Couldn't resolve the GitHub repo (gh repo view).");
  return res.stdout.trim();
}

export async function runMigrateClient(opts: MigrateClientOptions): Promise<boolean> {
  console.log(
    chalk.bold(
      `\n  ── hatchkit migrate-client${opts.action === "migrate" ? "" : ` --${opts.action}`} ──\n`,
    ),
  );
  if (opts.action === "rollback") return rollbackClient(opts);
  if (opts.action === "cleanup") return cleanupClient(opts);

  const plan = planClientMigration(opts.projectDir, opts);
  printPlan(plan);
  const blocked = [...plan.blocking, ...plan.scan.blocking];
  if (plan.manifest.clientHost === "cloudflare") {
    console.log(
      chalk.green(
        '\n  .hatchkit.json already says clientHost "cloudflare". Use `hatchkit sync` to reconcile routes.',
      ),
    );
    return true;
  }

  console.log(chalk.bold("\n  Live (read-only):"));
  const before = await snapshotSite(plan.siteUrl, plan.apiUrl);
  console.log(
    chalk.dim(
      `    /api/health ${before.healthStatus}${before.healthVersion ? ` version ${before.healthVersion}` : " (reports no version)"}`,
    ),
  );
  console.log(
    chalk.dim(
      `    sign-in origin probe ${before.signInStatus}, /api/ws ${before.ws}, http:// ${before.httpStatus}`,
    ),
  );
  if (!before.healthVersion) {
    console.log(
      chalk.yellow(
        "    ! the server reports no version on /api/health; the workflow's deploy-client job waits for it. Add `version: process.env.COMMIT_SHA` and the COMMIT_SHA build arg first.",
      ),
    );
  }

  let ctx: EdgeContext | null = null;
  if (!opts.repoOnly) {
    ctx = await cloudflareContext(plan.edge).catch((err) => {
      console.log(chalk.yellow(`    ! Cloudflare: ${(err as Error).message}`));
      return null;
    });
    if (!ctx)
      console.log(chalk.dim("    Cloudflare checks skipped: no provisioner token in reach."));
    else {
      const pre = await preflightEdge(ctx, plan.edge);
      console.log(
        chalk.dim(
          `    zone ${ctx.zoneName}: ${pre.diff.present.length} planned route(s) present, ${pre.diff.missing.length} missing`,
        ),
      );
      for (const b of pre.blocking) {
        // A Worker with no version is expected before step 3.
        if (/has no deployed version|does not exist/.test(b)) console.log(chalk.dim(`    · ${b}`));
        else {
          console.log(chalk.red(`    ✗ ${b}`));
          blocked.push(b);
        }
      }
    }
  }

  if (opts.dryRun) {
    console.log(chalk.dim("\n  --dry-run: nothing written."));
    return blocked.length === 0;
  }
  if (blocked.length) {
    console.log(chalk.red("\n  Blocked — nothing written."));
    return false;
  }

  // ── 1. repo files ───────────────────────────────────────────────────
  const changes = writeClientRepoFiles(
    opts.projectDir,
    { worker: plan.worker, siteUrl: plan.siteUrl, apiUrl: plan.apiUrl },
    plan.scan,
  );
  console.log(chalk.bold("\n  Repo files:"));
  for (const c of changes) console.log(chalk.dim(`    ${c}`));
  if (!changes.length) console.log(chalk.dim("    already in place"));
  for (const f of workerConfigFindings(opts.projectDir)) console.log(chalk.yellow(`    ! ${f}`));
  if (opts.repoOnly) {
    console.log(chalk.dim("\n  --repo-only: commit these files; nothing else was touched."));
    return true;
  }
  if (!ctx) {
    console.log(
      chalk.red(
        "\n  Cloudflare token needed for the live steps (`hatchkit config add cloudflare`).",
      ),
    );
    return false;
  }

  if (!opts.yes) {
    const go = await confirm({
      message: `Create Worker ${plan.worker}, its deploy token, the repo's Cloudflare secrets, the HTTPS redirect and ${plan.edge.routes.length} routes on ${ctx.zoneName}?`,
      default: false,
    });
    if (!go) return false;
  }

  const state: ClientMigrationState = loadState(plan.manifest.name) ?? {
    version: 1,
    project: plan.manifest.name,
    domain: plan.manifest.domain,
    worker: plan.worker,
    phase: "prepared",
    httpsHostsAdded: [],
    routesCreated: [],
    updatedAt: "",
  };
  state.accountId = ctx.accountId;
  state.zoneId = ctx.zoneId;
  const ledger = RunLedger.resumeOrStart(plan.manifest.name);
  try {
    const { CoolifyApi } = await import("../utils/coolify-api.js");
    const { getCoolifyConfig } = await import("../config.js");
    const coolify = await getCoolifyConfig();
    if (coolify) {
      const found = await new CoolifyApi({ url: coolify.url, token: coolify.token })
        .findApplicationByName(`${plan.manifest.name}-client`)
        .catch(() => null);
      if (found) state.coolifyClientApp = found;
    }
    saveState(state);

    // ── 2. Worker + token + repo secrets ─────────────────────────────────
    const { setCloudflareDeploySecrets } = await import("./gh-actions-secrets.js");
    const pushed = await setCloudflareDeploySecrets({
      projectDir: opts.projectDir,
      repoSlug: await repoSlug(opts.projectDir),
      workerName: plan.worker,
      createWorker: true,
      ledger,
    });
    if (!pushed.ok) throw new Error(pushed.error ?? "Cloudflare deploy token setup failed");
    console.log(
      chalk.green(
        `  ✓ Worker ${plan.worker}${pushed.worker?.created ? " (created)" : ""}; repo secrets ${pushed.inSync ? "already set" : pushed.pushed.join(", ")}`,
      ),
    );

    // ── 3. first version ────────────────────────────────────────────────
    const commit = await headCommit(opts.projectDir);
    const deployments = await ctx.api.listWorkerDeployments(ctx.accountId, plan.worker);
    if (!deployments[0]?.versions.length) {
      const { getCloudflareProvisioner } = await import("../config.js");
      const prov = await getCloudflareProvisioner();
      if (!prov) throw new Error("provisioner vanished");
      console.log(chalk.dim(`  Building and uploading ${commit.slice(0, 7)} (first version)…`));
      state.firstVersionId = await uploadFirstVersion({
        projectDir: opts.projectDir,
        plan,
        commit,
        token: prov.token,
        accountId: prov.accountId,
      });
      saveState(state);
      console.log(chalk.green(`  ✓ version ${state.firstVersionId} active (no route yet)`));
    }
    const pre = await preflightEdge(ctx, plan.edge);
    if (pre.blocking.length) {
      for (const b of pre.blocking) console.log(chalk.red(`  ✗ ${b}`));
      return false;
    }

    // ── 4. HTTPS ────────────────────────────────────────────────────────
    const https = await addHttpsRedirectHosts(ctx, plan.edge.hosts, ledger);
    state.httpsHostsAdded = [...new Set([...state.httpsHostsAdded, ...https.added])];
    saveState(state);
    console.log(chalk.green(`  ✓ HTTPS redirect covers ${plan.edge.hosts.join(", ")}`));

    // ── 5. no-Worker routes ─────────────────────────────────────────────
    const record = (pattern: string): void => {
      state.routesCreated = [...new Set([...state.routesCreated, pattern])];
      saveState(state);
    };
    await applyEdgeRoutes(ctx, plan.edge, {
      originRoutesOnly: true,
      ledger,
      onRoute: (r, o) => {
        if (o === "created") record(r.pattern);
        console.log(chalk.dim(`    ${o} ${r.pattern} → ${r.script ?? "no Worker"}`));
      },
    });
    const mid = await snapshotSite(plan.siteUrl, plan.apiUrl);
    if (mid.healthStatus !== before.healthStatus) {
      console.log(
        chalk.red(
          `  ✗ /api/health changed to ${mid.healthStatus} after the no-Worker routes. Stopping (they are inert; --rollback removes them).`,
        ),
      );
      return false;
    }

    // ── 6. cutover ──────────────────────────────────────────────────────
    await applyEdgeRoutes(ctx, plan.edge, {
      ledger,
      onRoute: (r, o) => {
        if (o === "created") record(r.pattern);
        if (r.script) console.log(chalk.bold(`    ${o} ${r.pattern} → ${r.script}`));
      },
    });
    state.phase = "routed";
    saveState(state);
    const expectCommit = state.firstVersionId ? commit : undefined;
    let failures: string[] = [];
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      const after = await snapshotSite(plan.siteUrl, plan.apiUrl);
      failures = compareCutover(before, after, {
        commit: expectCommit ?? after.versionCommit ?? "",
        apiUrl: plan.apiUrl,
        siteUrl: plan.siteUrl,
      });
      if (!failures.length) break;
    }
    if (failures.length) {
      for (const f of failures) console.log(chalk.red(`  ✗ ${f}`));
      console.log(
        chalk.yellow("  Deleting the Worker route(s) again — Traefik answers within seconds."),
      );
      await removeEdgeRoutes(ctx, plan.edge, { clientOnly: true });
      return false;
    }
    console.log(
      chalk.green(
        "  ✓ cutover verified: page, /version.json, /api/health, sign-in probe, /api/ws, 404, http→https",
      ),
    );

    // ── 7. manifest ─────────────────────────────────────────────────────
    const fields: Record<string, unknown> = { clientHost: "cloudflare" };
    const defaults = plan.routing.topology === "split" ? [] : [...DEFAULT_ORIGIN_PATHS];
    if (opts.originPaths && JSON.stringify(opts.originPaths) !== JSON.stringify(defaults)) {
      fields.originPaths = opts.originPaths;
    }
    // Spliced in, not rewritten: the diff is exactly this move.
    const { addManifestFields } = await import("./migrate-runtime.js");
    if (!addManifestFields(opts.projectDir, fields)) {
      console.log(
        chalk.yellow(
          `  ! couldn't add ${JSON.stringify(fields)} to .hatchkit.json; add it by hand.`,
        ),
      );
    }
    state.phase = "cut-over";
    state.cutOverAt = new Date().toISOString();
    saveState(state);
    console.log(chalk.bold("\n  Done. Next:"));
    console.log(
      chalk.dim(
        "    1. Commit the repo files and .hatchkit.json, then push: CI now uploads and switches the Worker.",
      ),
    );
    console.log(
      chalk.dim(
        `    2. Soak. ${state.coolifyClientApp?.name ?? `${plan.manifest.name}-client`} keeps running for --rollback.`,
      ),
    );
    console.log(chalk.dim("    3. After the soak: hatchkit migrate-client --cleanup --dry-run"));
    return true;
  } finally {
    // resumeOrStart reopened the project ledger; close it again.
    ledger.complete();
  }
}

async function rollbackClient(opts: MigrateClientOptions): Promise<boolean> {
  const plan = planClientMigration(opts.projectDir, opts);
  const state = loadState(plan.manifest.name);
  if (!state?.zoneId) {
    console.log(
      chalk.red(
        `  No migration state for ${plan.manifest.name}; nothing hatchkit made to roll back.`,
      ),
    );
    return false;
  }
  console.log(chalk.bold("  Plan:"));
  for (const p of state.routesCreated) console.log(chalk.dim(`    delete route ${p}`));
  if (state.httpsHostsAdded.length) {
    console.log(
      chalk.dim(`    remove ${state.httpsHostsAdded.join(", ")} from the HTTPS redirect rule`),
    );
  }
  console.log(chalk.dim("    drop clientHost from .hatchkit.json"));
  console.log(
    chalk.dim(
      `    keep Worker ${state.worker}, its token and repo secrets (harmless without a route)`,
    ),
  );
  if (opts.dryRun) return true;
  if (!opts.yes && !(await confirm({ message: "Roll back?", default: false }))) return false;
  const { getCloudflareProvisioner } = await import("../config.js");
  const prov = await getCloudflareProvisioner();
  if (!prov) throw new Error("Cloudflare provisioner needed for --rollback.");
  const { CloudflareApi } = await import("../utils/cloudflare-api.js");
  const api = new CloudflareApi({ token: prov.token, accountId: prov.accountId });
  const ours = {
    ...plan.edge,
    routes: plan.edge.routes.filter((r) => state.routesCreated.includes(r.pattern)),
  };
  await removeEdgeRoutes({ api, zoneId: state.zoneId }, ours, {
    onRoute: (r, o) => console.log(chalk.dim(`    ${o} ${r.pattern}`)),
  });
  if (state.httpsHostsAdded.length) {
    const res = await removeHttpsRedirectHosts(api, state.zoneId, state.httpsHostsAdded);
    console.log(chalk.dim(`    HTTPS rule: ${res}`));
  }
  dropManifestKeys(opts.projectDir, ["clientHost", "originPaths"]);
  state.phase = "rolled-back";
  state.routesCreated = [];
  state.httpsHostsAdded = [];
  saveState(state);
  console.log(chalk.green(`\n  ✓ ${plan.manifest.domain} is served by Coolify again.`));
  console.log(
    chalk.dim("    Revert the workflow commit and push, so CI deploys the Coolify client again."),
  );
  return true;
}

/** Days between the cutover and `--cleanup`. */
export const SOAK_DAYS = 7;

export interface CleanupFacts {
  /** `/version.json` commit, or undefined. */
  versionCommit?: string;
  /** Newest release in `/release-assets.json`: only the Worker serves it. */
  manifestNewest?: string;
  /** `x-powered-by` of `/` (Next.js = the Coolify client container). */
  poweredBy?: string;
  /** Script of the `<domain>/*` route, null for none, undefined when absent. */
  clientRoute?: string | null;
  /** The recorded Coolify client app as Coolify reports it now; null when
   *  it is already gone. */
  app?: { uuid: string; name: string; fqdn: string | null; buildPack?: string } | null;
  /** Whether the GHCR client package exists. */
  packageExists?: boolean;
}

export interface CleanupPlan {
  blocking: string[];
  deleteApp?: { uuid: string; name: string };
  deletePackage?: string;
  deleteSecrets: string[];
}

/**
 * What `--cleanup` may delete, and what stops it. Pure. Deletes only what
 * it has checked (the convention in the vault's coolify-retirement-index):
 *
 *   · the soak is over (or --skip-soak);
 *   · the site answers from the Worker: `/release-assets.json` (a file only
 *     the Worker serves) names the commit `/version.json` reports, and `/`
 *     carries no `x-powered-by`;
 *   · `<domain>/*` routes to this project's Worker;
 *   · the Coolify app is still this project's client: its domains include
 *     the project's domain and it is a Docker Image app.
 *
 * Never a DNS record (the route needs it proxied), the server app, a
 * database, or the ACME route (the server still holds a certificate for
 * the host under single-origin).
 */
export function planClientCleanup(args: {
  domain: string;
  worker: string;
  packageName: string;
  cutOverAt?: string;
  now: Date;
  skipSoak?: boolean;
  keepPackage?: boolean;
  secrets: string[];
  facts: CleanupFacts;
}): CleanupPlan {
  const { facts } = args;
  const blocking: string[] = [];
  if (!args.skipSoak) {
    const from = args.cutOverAt ? Date.parse(args.cutOverAt) : Number.NaN;
    const ends = from + SOAK_DAYS * 86_400_000;
    if (!Number.isFinite(from))
      blocking.push("cutover time unknown; pass --skip-soak to clean up anyway.");
    else if (args.now.getTime() < ends) {
      blocking.push(
        `soak runs until ${new Date(ends).toISOString().slice(0, 10)}; pass --skip-soak to clean up earlier.`,
      );
    }
  }
  if (!facts.versionCommit)
    blocking.push(`https://${args.domain}/version.json does not answer with a commit.`);
  else if (!facts.manifestNewest?.startsWith(facts.versionCommit)) {
    blocking.push(
      `https://${args.domain} is not answered by the Worker: /release-assets.json newest is ${facts.manifestNewest ?? "<none>"}, /version.json says ${facts.versionCommit}.`,
    );
  }
  if (facts.poweredBy)
    blocking.push(`https://${args.domain}/ is still answered by ${facts.poweredBy}.`);
  if (facts.clientRoute !== args.worker) {
    blocking.push(
      `route ${args.domain}/* points at ${facts.clientRoute === undefined ? "nothing (no route)" : (facts.clientRoute ?? "no Worker")}, not ${args.worker}.`,
    );
  }
  let deleteApp: CleanupPlan["deleteApp"];
  if (facts.app) {
    const routesDomain = (facts.app.fqdn ?? "").split(",").some(
      (u) =>
        u
          .trim()
          .replace(/^https?:\/\//, "")
          .replace(/\/.*$/, "") === args.domain,
    );
    if (!routesDomain || facts.app.buildPack !== "dockerimage") {
      blocking.push(
        `Coolify app ${facts.app.name} (${facts.app.uuid}) no longer looks like this project's client (domains ${facts.app.fqdn ?? "none"}, ${facts.app.buildPack ?? "?"}); not deleting it.`,
      );
    } else deleteApp = { uuid: facts.app.uuid, name: facts.app.name };
  }
  return {
    blocking,
    ...(deleteApp ? { deleteApp } : {}),
    ...(facts.packageExists && !args.keepPackage ? { deletePackage: args.packageName } : {}),
    deleteSecrets: args.secrets,
  };
}

/** GitHub API path of the client image package: user or org. */
async function packageApiPath(slug: string, pkg: string): Promise<string> {
  const owner = slug.split("/")[0];
  const me = await exec("gh", ["api", "/user", "--jq", ".login"], { silent: true });
  return me.exitCode === 0 && me.stdout.trim() === owner
    ? `/user/packages/container/${pkg}`
    : `/orgs/${owner}/packages/container/${pkg}`;
}

async function gatherCleanupFacts(args: {
  domain: string;
  appUuid?: string;
  packagePath: string;
  edge: EdgePlan;
}): Promise<CleanupFacts> {
  const facts: CleanupFacts = {};
  const site = `https://${args.domain}`;
  const get = (path: string) =>
    fetch(`${site}${path}${path.includes("?") ? "&" : "?"}${cb()}`, {
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
  const version = await get("/version.json");
  if (version?.ok)
    facts.versionCommit = (
      (await version.json().catch(() => null)) as { commit?: string } | null
    )?.commit;
  const assets = await get("/release-assets.json");
  if (assets?.ok) {
    const body = (await assets.json().catch(() => null)) as {
      releases?: Array<{ sha?: string }>;
    } | null;
    facts.manifestNewest = body?.releases?.[0]?.sha;
  }
  const page = await get("/");
  facts.poweredBy = page?.headers.get("x-powered-by") ?? undefined;

  const ctx = await cloudflareContext(args.edge);
  if (ctx) {
    const routes = await ctx.api.listWorkerRoutes(ctx.zoneId);
    const route = routes.find((r) => r.pattern === `${args.domain}/*`);
    facts.clientRoute = route ? (route.script ?? null) : undefined;
  }
  if (args.appUuid) {
    const { getCoolifyConfig } = await import("../config.js");
    const cfg = await getCoolifyConfig();
    if (!cfg) throw new Error("Coolify is not configured.");
    const { CoolifyApi } = await import("../utils/coolify-api.js");
    try {
      const app = await new CoolifyApi({ url: cfg.url, token: cfg.token }).getApplication(
        args.appUuid,
      );
      facts.app = { uuid: args.appUuid, name: app.name, fqdn: app.fqdn, buildPack: app.buildPack };
    } catch (err) {
      if (isCoolifyNotFound(err)) facts.app = null;
      else throw err;
    }
  }
  const pkg = await exec("gh", ["api", args.packagePath], { silent: true });
  facts.packageExists = pkg.exitCode === 0;
  return facts;
}

function isCoolifyNotFound(err: unknown): boolean {
  return (
    (err as { status?: number }).status === 404 || /404|not found/i.test((err as Error).message)
  );
}

/** Poll until Coolify answers 404 for the app. Coolify deletes
 *  asynchronously: the app still answers for a while after the DELETE is
 *  accepted (mood-magic, 2026-10-18). Only a 404 counts: a timeout or a
 *  500 does not show that the app is gone. */
export async function waitForAppGone(
  getApp: () => Promise<unknown>,
  opts: { attempts: number; intervalMs: number },
): Promise<{ gone: boolean; lastError?: string }> {
  let lastError: string | undefined;
  for (let i = 0; i < opts.attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, opts.intervalMs));
    try {
      await getApp();
      lastError = undefined;
    } catch (err) {
      if (isCoolifyNotFound(err)) return { gone: true };
      lastError = (err as Error).message;
    }
  }
  return { gone: false, lastError };
}

async function cleanupClient(opts: MigrateClientOptions): Promise<boolean> {
  const plan = planClientMigration(opts.projectDir, opts);
  const { manifest } = plan;
  const state = loadState(manifest.name);
  if (state?.phase !== "cut-over" || manifest.clientHost !== "cloudflare") {
    console.log(
      chalk.red(
        `  ${manifest.name} is not cut over (phase ${state?.phase ?? "none"}); nothing to clean up.`,
      ),
    );
    return false;
  }
  const { deployHookSecretNames } = await import("./coolify-deploy-hook.js");
  const secrets = Object.values(deployHookSecretNames("client"));
  const slug = await repoSlug(opts.projectDir);
  const packageName = `${slug.split("/")[1]}-client`;
  const packagePath = await packageApiPath(slug, packageName);
  const facts = await gatherCleanupFacts({
    domain: manifest.domain,
    appUuid: state.coolifyClientApp?.uuid,
    packagePath,
    edge: plan.edge,
  });
  const cleanup = planClientCleanup({
    domain: manifest.domain,
    worker: plan.worker,
    packageName,
    cutOverAt: state.cutOverAt ?? state.updatedAt,
    now: new Date(),
    skipSoak: opts.skipSoak,
    keepPackage: opts.keepPackage,
    secrets,
    facts,
  });

  console.log(chalk.bold("  Checks:"));
  console.log(
    chalk.dim(
      `    /version.json ${facts.versionCommit ?? "—"}, release-assets newest ${facts.manifestNewest ?? "—"}`,
    ),
  );
  console.log(chalk.dim(`    route ${manifest.domain}/* → ${facts.clientRoute ?? "—"}`));
  for (const b of cleanup.blocking) console.log(chalk.red(`    ✗ ${b}`));
  console.log(chalk.bold("  Plan:"));
  if (cleanup.deleteApp) {
    console.log(
      chalk.dim(
        `    delete Coolify app ${cleanup.deleteApp.name} (${cleanup.deleteApp.uuid}), volumes kept — ends --rollback`,
      ),
    );
  } else
    console.log(
      chalk.dim(`    Coolify client app: ${facts.app === null ? "already gone" : "none recorded"}`),
    );
  if (cleanup.deletePackage)
    console.log(
      chalk.dim(
        `    delete GHCR package ghcr.io/${slug.split("/")[0]}/${cleanup.deletePackage} (GitHub can restore it for 30 days)`,
      ),
    );
  console.log(chalk.dim(`    delete repo secrets ${secrets.join(", ")}`));
  console.log(
    chalk.dim(
      `    keep: the server app, databases, DNS, the /api/* and ACME routes, Worker ${plan.worker}`,
    ),
  );
  if (cleanup.blocking.length) return false;
  if (opts.dryRun) return true;
  if (!opts.yes) {
    const { input } = await import("@inquirer/prompts");
    const answer = await input({ message: "Type DELETE to delete the items above:" });
    if (answer.trim() !== "DELETE") return false;
  }

  let ok = true;
  const { getCoolifyConfig } = await import("../config.js");
  const { CoolifyApi } = await import("../utils/coolify-api.js");
  if (cleanup.deleteApp) {
    const cfg = await getCoolifyConfig();
    if (!cfg) throw new Error("Coolify is not configured.");
    const coolify = new CoolifyApi({ url: cfg.url, token: cfg.token, timeoutMs: 30_000 });
    const { name, uuid } = cleanup.deleteApp;
    console.log(chalk.dim(`    Deleting Coolify app ${name}…`));
    const deleted = await coolify.deleteApplicationKeepingVolumes(uuid);
    console.log(
      chalk.dim(
        `    ${deleted === "deleted" ? "Coolify accepted the delete" : "Coolify no longer has the app"}.`,
      ),
    );
    console.log(chalk.dim("    Checking the backup sources that read it…"));
    const { reconcileBackupsAfterRemoval } = await import("../backups/sources.js");
    const backups = await reconcileBackupsAfterRemoval({
      uuids: [uuid],
      dryRun: false,
      settleMs: 30_000,
    });
    for (const line of backups.lines)
      console.log(backups.failed ? chalk.yellow(`    ${line}`) : chalk.dim(`    ${line}`));
    if (backups.lines.length === 0) console.log(chalk.dim("    No backup source to change."));
    console.log(chalk.dim("    Waiting for Coolify to remove the app (24 checks, 5 s apart)…"));
    const wait = await waitForAppGone(() => coolify.getApplication(uuid), {
      attempts: 24,
      intervalMs: 5_000,
    });
    console.log(
      wait.gone
        ? chalk.green(`  ✓ deleted ${name}`)
        : chalk.red(
            `  ✗ ${name} still exists${wait.lastError ? ` (last check: ${wait.lastError})` : ""}`,
          ),
    );
    ok &&= wait.gone;
  }
  if (cleanup.deletePackage) {
    const del = await exec("gh", ["api", "-X", "DELETE", packagePath], { silent: true });
    const still = await exec("gh", ["api", packagePath], { silent: true });
    const gone = del.exitCode === 0 && still.exitCode !== 0;
    console.log(
      gone
        ? chalk.green(`  ✓ deleted GHCR ${cleanup.deletePackage}`)
        : chalk.red(`  ✗ GHCR ${cleanup.deletePackage}: ${del.stderr.trim() || "still there"}`),
    );
    ok &&= gone;
  }
  const { ghSecretDelete } = await import("./gh-actions-secrets.js");
  for (const name of secrets) {
    const res = await ghSecretDelete(slug, name).catch((err) => (err as Error).message);
    console.log(chalk.dim(`    ${name}: ${res}`));
  }
  const after = await gatherCleanupFacts({ domain: manifest.domain, packagePath, edge: plan.edge });
  const stillWorker =
    !!after.versionCommit &&
    !!after.manifestNewest?.startsWith(after.versionCommit) &&
    !after.poweredBy;
  console.log(
    stillWorker
      ? chalk.green(`  ✓ ${manifest.domain} still answers from ${plan.worker}`)
      : chalk.red(`  ✗ ${manifest.domain} no longer answers from the Worker — check now`),
  );
  ok &&= stillWorker;
  if (ok) {
    state.phase = "cleaned";
    saveState(state);
  }
  return ok;
}

/** Remove keys from .hatchkit.json without running manifest migrations
 *  (re-serialised with the two-space indent hatchkit writes). */
export function dropManifestKeys(projectDir: string, keys: string[]): boolean {
  const path = join(projectDir, ".hatchkit.json");
  if (!existsSync(path)) return false;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  if (!keys.some((k) => k in parsed)) return false;
  for (const k of keys) delete parsed[k];
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
  return true;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseMigrateClientArgs(args: string[], cwd: string): MigrateClientOptions {
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const known = new Set([
    "--dry-run",
    "--repo-only",
    "--rollback",
    "--cleanup",
    "--yes",
    "--skip-soak",
    "--keep-package",
    "--worker",
    "--origin-path",
    "--dir",
  ]);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    if (!known.has(args[i]))
      throw new Error(`Unknown option ${args[i]} (see \`hatchkit help migrate-client\`).`);
    if (["--worker", "--origin-path", "--dir"].includes(args[i])) i++;
  }
  if (args.includes("--rollback") && args.includes("--cleanup")) {
    throw new Error("--rollback and --cleanup are separate steps.");
  }
  const originPaths = args.flatMap((a, i) =>
    a === "--origin-path" && args[i + 1] ? [args[i + 1]] : [],
  );
  return {
    projectDir: value("--dir") ?? cwd,
    action: args.includes("--rollback")
      ? "rollback"
      : args.includes("--cleanup")
        ? "cleanup"
        : "migrate",
    dryRun: args.includes("--dry-run"),
    repoOnly: args.includes("--repo-only"),
    yes: args.includes("--yes"),
    ...(args.includes("--skip-soak") ? { skipSoak: true } : {}),
    ...(args.includes("--keep-package") ? { keepPackage: true } : {}),
    ...(value("--worker") ? { worker: value("--worker") } : {}),
    ...(originPaths.length ? { originPaths } : {}),
  };
}

export async function runMigrateClientCli(args: string[]): Promise<void> {
  const ok = await runMigrateClient(parseMigrateClientArgs(args, process.cwd()));
  if (!ok) process.exitCode = 1;
}
