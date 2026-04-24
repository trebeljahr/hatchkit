/*
 * Provision orchestrator.
 *
 * Model:
 *   · GlitchTip and OpenPanel are "observability" providers. Per
 *     product, one project handles all environments — events are
 *     tagged with `environment: ...` on the SDK side, so dev/staging/
 *     prod share the same DSN/client credentials. This keeps the
 *     dashboards clean even as more envs get added.
 *   · Observability credentials are written to `.env.production`
 *     ONLY by default. Most teams don't want dev events polluting
 *     their real error / analytics metrics. Opt in via
 *     `--enable-dev-obs` when you need to debug the SDK wiring.
 *   · Resend is different: dev and prod keys are genuinely separated
 *     so a bug in dev can't email real users. We still mint two keys
 *     (`<name>-dev` / `<name>-prod`) and write them into the server's
 *     dev/prod env respectively.
 *   · Surfaces: a project can have a server, a client, or both. When
 *     both, the common case is a single shared GlitchTip/OpenPanel
 *     project (same DSN on both SDKs, each tagged automatically by
 *     `sdk.name`). Strict-isolation setups can opt into two projects
 *     via `Surfaces.mode = "separate"`.
 *
 * A 0600-permission cache copy of every written env is kept under
 * ~/<conf-dir>/provisioned/ for recoverability. Secret values never
 * touch stdout.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { ensureGlitchtip, ensureOpenpanel, ensureResend, getConfigPath } from "../config.js";
import { validateProjectName } from "../utils/validate.js";
import {
  type GlitchtipClient,
  deleteGlitchtipClient,
  provisionGlitchtipClient,
} from "./glitchtip.js";
import {
  type OpenpanelClient,
  deleteOpenpanelClient,
  provisionOpenpanelClient,
} from "./openpanel.js";
import {
  type ResendClient,
  createResendDomain,
  deleteResendClient,
  listResendDomains,
  normalizeDomainInput,
  provisionResendClient,
} from "./resend.js";
import { parseEnvLines, writeDevEnv, writeProdEnv } from "./write-env.js";

export type ProvisionService = "glitchtip" | "openpanel" | "resend";

export type SurfaceMode = "shared" | "separate" | "server-only" | "client-only";

export interface Surfaces {
  /** Which SDK surfaces the project has. Drives where env values land
   *  and whether we mint one or two projects per observability vendor. */
  mode: SurfaceMode;
  /** Absolute path to the directory that owns `.env.{development,
   *  production}` for the server bundle. Required unless `mode` is
   *  `"client-only"`. */
  serverEnvDir?: string;
  /** Absolute path for the client bundle's env files. Required unless
   *  `mode` is `"server-only"`. */
  clientEnvDir?: string;
}

export interface ProvisionOptions {
  baseName: string;
  services: ProvisionService[];
  /** Optional pre-selected Resend domain id, skipping the picker. */
  resendDomainId?: string;
  /** If set, resolves the write destinations without prompting.
   *  Pass `false` to force cache-only mode (no writes). */
  surfaces?: Surfaces | false;
  /** Also write observability values to `.env.development`. Off by
   *  default — see the file header. */
  enableDevObs?: boolean;
}

interface WriteBucket {
  /** Display label like "server" or "client". */
  label: string;
  /** Absolute dir containing `.env.{development,production}`. */
  envDir: string;
  /** KEY=VALUE lines destined for `.env.production`. */
  prodLines: string[];
  /** KEY=VALUE lines destined for `.env.development` (only if
   *  enableDevObs or when values are genuinely dev-scoped, e.g.
   *  Resend's dev key). */
  devLines: string[];
}

export async function runProvision(opts: ProvisionOptions): Promise<void> {
  const nameCheck = validateProjectName(opts.baseName);
  if (nameCheck !== true) throw new Error(`Invalid base name: ${nameCheck}`);

  // Ensure every selected provider is configured *before* any spinner
  // starts. Otherwise a lazy `ensure*` prompt fires underneath the ora
  // spinner and inquirer waits forever for invisible input.
  if (opts.services.includes("glitchtip")) await ensureGlitchtip();
  if (opts.services.includes("openpanel")) await ensureOpenpanel();
  if (opts.services.includes("resend")) await ensureResend();

  const surfaces = await resolveSurfaces(opts);
  const enableDevObs = opts.enableDevObs ?? false;

  // Resend domain: pick once, reused across dev + prod.
  let resendDomainId = opts.resendDomainId;
  if (opts.services.includes("resend") && !resendDomainId) {
    resendDomainId = await pickResendDomain();
  }

  const buckets = initBuckets(surfaces);

  console.log(chalk.bold(`\n  ── Provisioning ${opts.baseName} ──────────────────────────\n`));

  // ── GlitchTip ──
  if (opts.services.includes("glitchtip")) {
    if (surfaces?.mode === "separate") {
      for (const side of ["server", "client"] as const) {
        const projectName = `${opts.baseName}-${side}`;
        const res = await withSpinner(`GlitchTip: creating project ${projectName}`, () =>
          provisionGlitchtipClient(projectName),
        );
        pushObsLines(buckets, side, renderGlitchtipEnv(res, side === "client"), enableDevObs);
      }
    } else {
      const projectName = opts.baseName;
      const res = await withSpinner(`GlitchTip: creating project ${projectName}`, () =>
        provisionGlitchtipClient(projectName),
      );
      // Shared-DSN case: the server SDK reads GLITCHTIP_DSN; the client
      // SDK reads GLITCHTIP_DSN_CLIENT (same value). Both SDKs tag
      // events with `sdk.name`, so filtering by surface in the UI is
      // automatic.
      if (surfaces && (surfaces.mode === "shared" || surfaces.mode === "server-only")) {
        pushObsLines(buckets, "server", renderGlitchtipEnv(res, false), enableDevObs);
      }
      if (surfaces && (surfaces.mode === "shared" || surfaces.mode === "client-only")) {
        pushObsLines(buckets, "client", renderGlitchtipEnv(res, true), enableDevObs);
      }
    }
  }

  // ── OpenPanel ──
  if (opts.services.includes("openpanel")) {
    if (surfaces?.mode === "separate") {
      for (const side of ["server", "client"] as const) {
        const projectName = `${opts.baseName}-${side}`;
        const res = await withSpinner(`OpenPanel: creating project ${projectName}`, () =>
          provisionOpenpanelClient(projectName),
        );
        pushObsLines(buckets, side, renderOpenpanelEnv(res, side === "client"), enableDevObs);
      }
    } else {
      const projectName = opts.baseName;
      const res = await withSpinner(`OpenPanel: creating project ${projectName}`, () =>
        provisionOpenpanelClient(projectName),
      );
      if (surfaces && (surfaces.mode === "shared" || surfaces.mode === "server-only")) {
        pushObsLines(buckets, "server", renderOpenpanelEnv(res, false), enableDevObs);
      }
      if (surfaces && (surfaces.mode === "shared" || surfaces.mode === "client-only")) {
        pushObsLines(buckets, "client", renderOpenpanelEnv(res, true), enableDevObs);
      }
    }
  }

  // ── Resend ── (always server-side; dev/prod keys are not observability)
  if (opts.services.includes("resend")) {
    const serverBucket = buckets.find((b) => b.label === "server");
    if (!serverBucket) {
      console.log(
        chalk.yellow(
          `  Skipping Resend — this project has no server surface, so there's nowhere to put RESEND_API_KEY.`,
        ),
      );
    } else {
      const devRes = await withSpinner(
        `Resend: creating restricted API key ${opts.baseName}-dev`,
        () => provisionResendClient(`${opts.baseName}-dev`, resendDomainId),
      );
      const prodRes = await withSpinner(
        `Resend: creating restricted API key ${opts.baseName}-prod`,
        () => provisionResendClient(`${opts.baseName}-prod`, resendDomainId),
      );
      // Resend is the one case where dev gets its OWN value, not the
      // prod value — dev keys are audience-restricted so they can't
      // email real users.
      serverBucket.devLines.push(...renderResendEnv(devRes));
      serverBucket.prodLines.push(...renderResendEnv(prodRes));
    }
  }

  // Persist 0600 cache copies keyed by surface label.
  const outDir = join(dirname(getConfigPath()), "provisioned");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  for (const b of buckets) {
    for (const phase of ["dev", "prod"] as const) {
      const lines = phase === "dev" ? b.devLines : b.prodLines;
      if (lines.length === 0) continue;
      const path = join(outDir, `${opts.baseName}.${b.label}.${phase}.env`);
      const banner = `# --- ${opts.baseName} / ${b.label} / ${phase} ---`;
      writeFileSync(path, `${banner}\n${lines.join("\n")}\n`, { mode: 0o600 });
    }
  }

  // Cache-only mode (surfaces === false or user said no to write):
  // summarize + point at cache files.
  if (surfaces === null) {
    console.log(chalk.bold("\n  ── Provisioned ────────────────────────────────────────────\n"));
    for (const b of buckets) {
      const prodKeys = parseEnvLines(b.prodLines).map((p) => p.key);
      const devKeys = parseEnvLines(b.devLines).map((p) => p.key);
      if (prodKeys.length > 0 || devKeys.length > 0) {
        console.log(`  ${chalk.bold(b.label)}:`);
        if (prodKeys.length > 0) {
          console.log(
            `    prod: ${chalk.green(`${prodKeys.length} vars`)}  ${chalk.dim(prodKeys.join(", "))}`,
          );
        }
        if (devKeys.length > 0) {
          console.log(
            `    dev:  ${chalk.green(`${devKeys.length} vars`)}  ${chalk.dim(devKeys.join(", "))}`,
          );
        }
      }
    }
    console.log(
      chalk.yellow(
        `\n  Values cached at ${outDir}/${opts.baseName}.*.env (mode 0600).\n` +
          `  Read them with \`cat\` or re-run with a project directory to write directly.\n`,
      ),
    );
    return;
  }

  // Write values into the resolved directories.
  console.log(chalk.bold("\n  ── Writing env into the project ──────────────────────────\n"));
  for (const b of buckets) {
    const prodPairs = parseEnvLines(b.prodLines);
    const devPairs = parseEnvLines(b.devLines);
    if (prodPairs.length === 0 && devPairs.length === 0) continue;

    const relLabel = chalk.dim(`${b.label} → ${relativeTo(b.envDir)}`);
    console.log(`  ${chalk.bold(b.label)}  ${relLabel}`);
    if (prodPairs.length > 0) {
      const prodPath = join(b.envDir, ".env.production");
      const keys = writeProdEnv(prodPath, prodPairs);
      console.log(
        `    ${chalk.green("✓")} .env.production  (encrypted)  ${chalk.dim(keys.join(", "))}`,
      );
    }
    if (devPairs.length > 0) {
      const devPath = join(b.envDir, ".env.development");
      const keys = writeDevEnv(devPath, devPairs);
      console.log(
        `    ${chalk.green("✓")} .env.development ${chalk.dim("(plaintext, gitignored)")}  ${chalk.dim(keys.join(", "))}`,
      );
    }
  }

  console.log();
  if (
    !enableDevObs &&
    (opts.services.includes("glitchtip") || opts.services.includes("openpanel"))
  ) {
    console.log(
      chalk.dim(
        "  Note: observability (GlitchTip/OpenPanel) values went to prod only.\n" +
          "  Dev errors/events would pollute real metrics — pass --enable-dev-obs to\n" +
          "  also populate .env.development when you need to debug SDK wiring.",
      ),
    );
  }
  console.log(chalk.dim(`\n  Cached copies (0600): ${outDir}/${opts.baseName}.*.env\n`));
}

// ---------------------------------------------------------------------------
// Surface resolution
// ---------------------------------------------------------------------------

/** Resolve the Surfaces config. Returns the concrete surfaces on
 *  success, or `null` when the user opted out of writing (cache-only
 *  mode). */
async function resolveSurfaces(opts: ProvisionOptions): Promise<Surfaces | null> {
  if (opts.surfaces === false) return null;
  if (opts.surfaces) return opts.surfaces;

  // Step 1 — project dir. Default to `./<baseName>` if it exists.
  const guess = resolve(opts.baseName);
  const guessExists = existsSync(guess);
  const wantWrite = await confirm({
    message: guessExists
      ? `Write values into ${chalk.cyan(relativeTo(guess))} (prod → encrypted .env.production)?`
      : `Write values into a project directory?`,
    default: true,
  });
  if (!wantWrite) return null;

  const projectDir = resolve(
    (
      await input({
        message: "Project directory (relative to cwd):",
        default: guessExists ? relativeTo(guess) : `./${opts.baseName}`,
        validate: (v) => {
          const abs = resolve(v.trim());
          return existsSync(abs) ? true : `No such directory: ${abs}`;
        },
      })
    ).trim(),
  );

  // Step 2 — surfaces.
  const mode = (await select<SurfaceMode>({
    message: "What surfaces does this project have?",
    choices: [
      {
        name: "Server + client — shared observability project (recommended)",
        value: "shared",
      },
      { name: "Server only", value: "server-only" },
      { name: "Client only", value: "client-only" },
      {
        name: "Server + client — separate projects per surface (strict isolation)",
        value: "separate",
      },
    ],
    default: "shared",
  })) as SurfaceMode;

  // Step 3 — env dirs per surface. Auto-detect common monorepo layouts
  // (packages/server, apps/web, etc.) and offer the first match as the
  // default.
  const surfaces: Surfaces = { mode };
  if (mode === "server-only" || mode === "shared" || mode === "separate") {
    const def = detectSurfaceDir(projectDir, [
      "packages/server",
      "apps/server",
      "apps/api",
      "server",
      "", // project root fallback
    ]);
    surfaces.serverEnvDir = resolve(
      projectDir,
      (
        await input({
          message: "Server env directory (relative to project root):",
          default: def,
          validate: (v) => {
            const abs = resolve(projectDir, v.trim());
            return existsSync(abs) ? true : `No such directory: ${abs}`;
          },
        })
      ).trim(),
    );
  }
  if (mode === "client-only" || mode === "shared" || mode === "separate") {
    const def = detectSurfaceDir(projectDir, [
      "packages/client",
      "packages/web",
      "apps/web",
      "apps/client",
      "client",
      "web",
      "", // project root fallback
    ]);
    surfaces.clientEnvDir = resolve(
      projectDir,
      (
        await input({
          message: "Client env directory (relative to project root):",
          default: def,
          validate: (v) => {
            const abs = resolve(projectDir, v.trim());
            return existsSync(abs) ? true : `No such directory: ${abs}`;
          },
        })
      ).trim(),
    );
  }
  return surfaces;
}

function detectSurfaceDir(projectDir: string, candidates: string[]): string {
  for (const c of candidates) {
    if (existsSync(join(projectDir, c))) return c || ".";
  }
  return ".";
}

function relativeTo(p: string, from = process.cwd()): string {
  const rel = relative(from, p);
  return rel === "" ? "." : rel.startsWith("..") ? p : `./${rel}`;
}

function initBuckets(surfaces: Surfaces | null): WriteBucket[] {
  if (!surfaces) {
    // Cache-only: still separate by surface label for readable output.
    return [
      { label: "server", envDir: "", prodLines: [], devLines: [] },
      { label: "client", envDir: "", prodLines: [], devLines: [] },
    ];
  }
  const out: WriteBucket[] = [];
  if (surfaces.serverEnvDir) {
    out.push({ label: "server", envDir: surfaces.serverEnvDir, prodLines: [], devLines: [] });
  }
  if (surfaces.clientEnvDir) {
    out.push({ label: "client", envDir: surfaces.clientEnvDir, prodLines: [], devLines: [] });
  }
  return out;
}

/** Append observability env lines to the right bucket(s). In default
 *  mode these go to prod only; `enableDevObs` mirrors them into dev
 *  too for wiring debugging. */
function pushObsLines(
  buckets: WriteBucket[],
  side: "server" | "client",
  lines: string[],
  enableDevObs: boolean,
): void {
  const bucket = buckets.find((b) => b.label === side);
  if (!bucket) return;
  bucket.prodLines.push(...lines);
  if (enableDevObs) bucket.devLines.push(...lines);
}

// ---------------------------------------------------------------------------
// Unprovision — inverse of runProvision. Deletes the -dev and -prod
// clients from each selected service, plus the local .env cache.
// ---------------------------------------------------------------------------

export interface UnprovisionOptions {
  baseName: string;
  services: ProvisionService[];
  /** Don't hit any API or remove any file — just print what would happen. */
  dryRun?: boolean;
}

export async function runUnprovision(opts: UnprovisionOptions): Promise<void> {
  const nameCheck = validateProjectName(opts.baseName);
  if (nameCheck !== true) throw new Error(`Invalid base name: ${nameCheck}`);

  // Configure providers before any spinner — same reasoning as runProvision.
  if (opts.services.includes("glitchtip")) await ensureGlitchtip();
  if (opts.services.includes("openpanel")) await ensureOpenpanel();
  if (opts.services.includes("resend")) await ensureResend();

  if (opts.dryRun) {
    console.log(chalk.yellow("\n  [dry-run] No clients will be deleted.\n"));
  }
  console.log(chalk.bold(`\n  ── Deleting ${opts.baseName} ─────────────────────────────\n`));

  // Observability: try the shared name first, then the -server/-client
  // split variants. Each `runDelete` quietly reports "already gone" on
  // a 404, so best-effort teardown covers both layouts.
  if (opts.services.includes("glitchtip")) {
    for (const name of observabilityNames(opts.baseName)) {
      await runDelete(`GlitchTip: deleting project ${name}`, opts.dryRun, () =>
        deleteGlitchtipClient(name),
      );
    }
  }
  if (opts.services.includes("openpanel")) {
    for (const name of observabilityNames(opts.baseName)) {
      await runDelete(`OpenPanel: deleting project ${name}`, opts.dryRun, () =>
        deleteOpenpanelClient(name),
      );
    }
  }
  // Resend keeps the -dev/-prod pair.
  if (opts.services.includes("resend")) {
    for (const env of ["dev", "prod"] as const) {
      const name = `${opts.baseName}-${env}`;
      await runDelete(`Resend: deleting API key ${name}`, opts.dryRun, () =>
        deleteResendClient(name),
      );
    }
  }

  // Clean up the local .env cache. Mirror runProvision's write locations.
  const outDir = join(dirname(getConfigPath()), "provisioned");
  const cachedPaths = [
    `${opts.baseName}.server.dev.env`,
    `${opts.baseName}.server.prod.env`,
    `${opts.baseName}.client.dev.env`,
    `${opts.baseName}.client.prod.env`,
    // Legacy pre-surfaces layout — clean up so re-runs don't leave junk.
    `${opts.baseName}.dev.env`,
    `${opts.baseName}.prod.env`,
  ];
  for (const name of cachedPaths) {
    const path = join(outDir, name);
    if (!existsSync(path)) continue;
    if (opts.dryRun) {
      console.log(chalk.dim(`  would remove ${path}`));
      continue;
    }
    rmSync(path);
    console.log(chalk.dim(`  ✓ removed ${path}`));
  }
  console.log();
}

/** Candidate project names for observability teardown. Covers the
 *  shared (single-project) and split (server/client) layouts so a
 *  single `hatchkit remove` cleans up either. */
function observabilityNames(baseName: string): string[] {
  return [baseName, `${baseName}-server`, `${baseName}-client`];
}

/** Run a delete via spinner, mapping "not-found" to a dim "already gone"
 *  so re-runs stay quiet. */
async function runDelete(
  label: string,
  dryRun: boolean | undefined,
  fn: () => Promise<"deleted" | "not-found">,
): Promise<void> {
  if (dryRun) {
    console.log(chalk.dim(`  would ${label.toLowerCase()}`));
    return;
  }
  const ora = (await import("ora")).default;
  const spinner = ora(label).start();
  try {
    const result = await fn();
    if (result === "deleted") {
      spinner.succeed(label);
    } else {
      spinner.info(`${label} — already gone`);
    }
  } catch (err) {
    spinner.fail(label);
    // Don't throw on one failure — a single service being flaky shouldn't
    // block the rest of the teardown.
    console.log(chalk.red(`    ${(err as Error).message}`));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const ora = (await import("ora")).default;
  const spinner = ora(label).start();
  try {
    const res = await fn();
    spinner.succeed(label);
    return res;
  } catch (err) {
    spinner.fail(label);
    throw err;
  }
}

async function pickResendDomain(): Promise<string | undefined> {
  const domains = await listResendDomains();
  const sorted = [...domains].sort((a, b) => {
    const av = a.status === "verified" ? 0 : 1;
    const bv = b.status === "verified" ? 0 : 1;
    return av - bv || a.name.localeCompare(b.name);
  });

  const ADD_NEW = "__add_new__";
  const NONE = "";

  const choices = [
    ...sorted.map((d) => ({
      name: d.status === "verified" ? d.name : `${d.name}  ${chalk.dim(`(${d.status})`)}`,
      value: d.id,
    })),
    { name: chalk.cyan("＋ Add a new sending domain…"), value: ADD_NEW },
    { name: "— no domain restriction (account-wide) —", value: NONE },
  ];

  const picked = await select({
    message: "Resend sending domain (both keys will be scoped to it):",
    choices,
  });

  if (picked === NONE) return undefined;
  if (picked !== ADD_NEW) return picked;

  // Add-new flow.
  const raw = await input({
    message: "New sending domain (bare domain — e.g. playtiao.com or mail.playtiao.com):",
    validate: (v) => {
      const n = normalizeDomainInput(v);
      if (!n) return "Enter a domain.";
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(n)) {
        return "That doesn't look like a valid domain.";
      }
      return true;
    },
  });
  const name = normalizeDomainInput(raw);
  const created = await withSpinner(`Resend: creating domain ${name}`, () =>
    createResendDomain(name),
  );
  console.log(
    chalk.yellow(
      `  ${created.name} created (status: ${created.status}). Add the DNS records in the Resend dashboard before sending — https://resend.com/domains/${created.id}`,
    ),
  );
  return created.id;
}

/** Server env uses the plain names; browser env uses a `PUBLIC_`
 *  prefix (Vite / Astro / SvelteKit / Remix convention — bundlers
 *  typically only expose variables with this kind of prefix to
 *  browser code). The client SDK doesn't need OPENPANEL_CLIENT_SECRET
 *  — browser events are anonymous — so we omit it from the client
 *  bundle. */
function renderGlitchtipEnv(c: GlitchtipClient, forClient: boolean): string[] {
  return [`${forClient ? "PUBLIC_GLITCHTIP_DSN" : "GLITCHTIP_DSN"}=${c.dsn}`];
}

function renderOpenpanelEnv(c: OpenpanelClient, forClient: boolean): string[] {
  if (forClient) {
    return [`PUBLIC_OPENPANEL_API_URL=${c.apiUrl}`, `PUBLIC_OPENPANEL_CLIENT_ID=${c.clientId}`];
  }
  return [
    `OPENPANEL_API_URL=${c.apiUrl}`,
    `OPENPANEL_CLIENT_ID=${c.clientId}`,
    `OPENPANEL_CLIENT_SECRET=${c.clientSecret}`,
  ];
}

function renderResendEnv(c: ResendClient): string[] {
  return [`RESEND_API_KEY=${c.apiKey}`];
}
