/*
 * `hatchkit inventory` — read-only survey of what already exists for a
 * project/site across every configured provider.
 *
 * Different beast from `status` and `doctor`:
 *   · `status`    answers "which provider credentials have I stored?"
 *   · `doctor`    answers "are those credentials still valid?"
 *   · `inventory` answers "given THIS project (cwd / name / domain /
 *                 repo), what resources already exist on the providers?"
 *
 * The flow:
 *   1. Infer identity from the current directory — manifest, package.json,
 *      git remote, CNAME file, etc. Asks the user only for what couldn't
 *      be inferred (and confirms inferred values unless --yes).
 *   2. Scan every configured provider in parallel for resources matching
 *      that identity (Coolify app by name, R2 buckets, DNS zone records,
 *      GitHub Pages config, Resend domain verification, etc.).
 *   3. Cross-reference findings to flag drift — e.g. Coolify app fqdn
 *      doesn't match DNS, manifest bucket name doesn't exist live,
 *      gh-pages workflow committed but Pages isn't enabled, CORS on the
 *      live bucket differs from what the manifest records.
 *   4. Render — grouped tree (human) or `--json` for parsing.
 *
 * Everything is read-only. No mutations. Safe to run anywhere.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { confirm, input } from "@inquirer/prompts";
import chalk from "chalk";
import {
  getCoolifyConfig,
  getDnsConfig,
  getGlitchtipConfig,
  getOpenpanelConfig,
  getResendConfig,
  getS3Config,
  getStripeConfig,
} from "./config.js";
import { locateEnvKeysFile, locateEnvProductionFile } from "./deploy/keys.js";
import { MANIFEST_FILENAME, type ProjectManifest, readManifest } from "./scaffold/manifest.js";
import { CloudflareApi } from "./utils/cloudflare-api.js";
import { CoolifyApi, type CoolifyApplication } from "./utils/coolify-api.js";
import { exec, execOk } from "./utils/exec.js";
import { SECRET_KEYS, getSecret } from "./utils/secrets.js";
import { getCliVersion } from "./utils/version.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InventoryInput {
  /** Project / app name. Used to match Coolify apps + buckets + clients. */
  name?: string;
  /** Primary public domain (e.g. "myapp.com" or "docs.myapp.com"). */
  domain?: string;
  /** GitHub repo slug "owner/name". */
  repo?: string;
}

export interface InventoryFinding {
  provider: string;
  /** kebab-case resource kind ("application", "bucket", "dns-record", …). */
  kind: string;
  /** Human label for the resource ("myapp", "myapp-assets", "myapp.com A"). */
  identity: string;
  /**
   *  · `present` — the resource exists, no drift detected.
   *  · `missing` — we looked for it (because something declares it) and
   *                didn't find it; the project is in an incomplete state.
   *  · `drift`   — present, but a recorded/derived expectation doesn't
   *                match the live value.
   *  · `info`    — neutral observation (e.g. "Coolify has 3 unrelated apps").
   */
  status: "present" | "missing" | "drift" | "info";
  detail?: string;
  /** When status === "drift", a list of "X != Y" lines explaining the gap. */
  drift?: string[];
}

export interface InventoryLocal {
  cwd: string;
  isGitRepo: boolean;
  gitRemote?: string;
  gitDefaultBranch?: string;
  /** True when there's a real GitHub remote we can talk to via `gh`. */
  hasGitHubRemote: boolean;
  packageName?: string;
  packageDescription?: string;
  manifestPresent: boolean;
  manifest?: ProjectManifest;
  serverDir?: string;
  clientDir?: string;
  hasDockerfile: boolean;
  composePath?: string;
  /** Path to the gh-pages-deploying workflow, if any. */
  ghPagesWorkflowPath?: string;
  /** Path to the Coolify deploy workflow (`.github/workflows/deploy.yml`),
   *  if any. Tells us "this project is set up for hatchkit-style deploy". */
  deployWorkflowPath?: string;
  /** Contents of any `CNAME` file at repo root or in a docs/site subdir
   *  — GitHub Pages writes this for custom domains. */
  cnameFile?: { path: string; content: string };
  /** True when an encrypted `.env.production` exists (dotenvx header). */
  dotenvxEncrypted: boolean;
  /** True when a `.env.keys` file exists somewhere standard. */
  envKeysPresent: boolean;
}

export interface InventoryReport {
  cliVersion: string;
  cwd: string;
  inferred: InventoryInput;
  /** Where each inferred identity came from. Useful for the user to
   *  trust / correct what we guessed. */
  sources: {
    name?: InferenceSource;
    domain?: InferenceSource;
    repo?: InferenceSource;
  };
  local: InventoryLocal;
  findings: InventoryFinding[];
  drifts: InventoryFinding[];
  skipped: Array<{ provider: string; reason: string }>;
  summary: { present: number; drift: number; missing: number; skipped: number };
}

type InferenceSource =
  | "manifest"
  | "package.json"
  | "git-remote"
  | "cname-file"
  | "cwd-basename"
  | "user"
  | "flag";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface RunInventoryOptions {
  json?: boolean;
  /** Pre-supplied identity from flags — overrides inference. */
  input?: InventoryInput;
  /** Skip confirmation prompts; auto-accept inferred values. */
  yes?: boolean;
}

export async function runInventory(cwd: string, opts: RunInventoryOptions = {}): Promise<void> {
  const report = await collectInventory(cwd, {
    input: opts.input,
    interactive: !opts.json && !opts.yes,
    autoAccept: opts.yes ?? false,
  });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(renderInventoryHuman(report));
}

export interface CollectInventoryOptions {
  input?: InventoryInput;
  /** When true, prompts the user for missing identity values and asks
   *  to confirm inferred ones. When false, takes inferred values as-is
   *  and silently skips lookups that need a value we couldn't infer. */
  interactive?: boolean;
  /** When true (and interactive), skip the "confirm guess" step — only
   *  prompt for fields we genuinely couldn't infer. */
  autoAccept?: boolean;
}

export async function collectInventory(
  cwd: string,
  opts: CollectInventoryOptions = {},
): Promise<InventoryReport> {
  const absCwd = resolve(cwd);
  const local = inferLocal(absCwd);

  // Resolve git remote unconditionally — both for repo inference and
  // for the repo-vs-Coolify-source drift check. Cheap (~one subprocess
  // call) and the result is the same whether or not we prompt.
  const git = await resolveGitRemote(local);
  local.gitRemote = git.remote;
  local.gitDefaultBranch = git.defaultBranch;
  local.hasGitHubRemote = git.hasGitHubRemote;

  // Identity inference — order: explicit input > manifest > package > git/CNAME.
  const { input: inferred, sources } = inferIdentity(local, opts.input ?? {});
  if (git.repo && !inferred.repo) {
    inferred.repo = git.repo;
    sources.repo = "git-remote";
  }

  let identity = inferred;
  if (opts.interactive) {
    identity = await promptForGaps(local, inferred, sources, !!opts.autoAccept);
  }

  // Provider scans — every one is best-effort and returns its own
  // findings + skip reason. Running them in parallel keeps wall-time
  // close to the slowest single round-trip.
  const scanResults = await Promise.all([
    scanCoolify(identity),
    scanDns(identity),
    scanR2(identity, local.manifest),
    scanS3Other(identity),
    scanGitHub(identity),
    scanResend(identity),
    scanGlitchtip(identity),
    scanOpenpanel(identity),
    scanStripe(identity),
  ]);

  const findings: InventoryFinding[] = [];
  const skipped: Array<{ provider: string; reason: string }> = [];
  for (const r of scanResults) {
    findings.push(...r.findings);
    skipped.push(...r.skipped);
  }

  // Drift checks build on already-collected findings + a few extra
  // targeted lookups. They produce more findings (status: "drift" or
  // sometimes "missing") which we append to the same list.
  const driftFindings = await detectDrift(identity, local, scanResults);
  findings.push(...driftFindings);

  const drifts = findings.filter((f) => f.status === "drift");
  const present = findings.filter((f) => f.status === "present").length;
  const missing = findings.filter((f) => f.status === "missing").length;

  return {
    cliVersion: getCliVersion(),
    cwd: absCwd,
    inferred: identity,
    sources,
    local,
    findings,
    drifts,
    skipped,
    summary: { present, drift: drifts.length, missing, skipped: skipped.length },
  };
}

// ---------------------------------------------------------------------------
// Local inference (no network, no prompts)
// ---------------------------------------------------------------------------

function inferLocal(cwd: string): InventoryLocal {
  const manifestPresent = existsSync(join(cwd, MANIFEST_FILENAME));
  let manifest: ProjectManifest | undefined;
  if (manifestPresent) {
    try {
      manifest = readManifest(cwd) ?? undefined;
    } catch {
      // Malformed manifest — leave undefined; inferIdentity falls
      // through to other signals.
    }
  }

  let packageName: string | undefined;
  let packageDescription: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8")) as {
      name?: string;
      description?: string;
    };
    if (typeof pkg.name === "string") packageName = pkg.name.replace(/^@[^/]+\//, "");
    if (typeof pkg.description === "string") packageDescription = pkg.description.trim();
  } catch {
    // No package.json — fine.
  }

  const serverDir = firstExistingDir(cwd, [
    "packages/server",
    "apps/server",
    "apps/api",
    "apps/backend",
    "server",
    "backend",
    "api",
    "src/server",
    "services/server",
  ]);
  const clientDir = firstExistingDir(cwd, [
    "packages/client",
    "packages/web",
    "packages/frontend",
    "apps/web",
    "apps/client",
    "apps/frontend",
    "client",
    "frontend",
    "web",
    "src/client",
  ]);

  const composeCandidates = [
    "compose.yaml",
    "compose.yml",
    "docker-compose.yaml",
    "docker-compose.yml",
  ];
  const composePath = composeCandidates.map((n) => join(cwd, n)).find((p) => existsSync(p));
  const hasDockerfile = existsSync(join(cwd, "Dockerfile"));

  // Workflow detection. We classify a workflow as "pages" when its body
  // mentions `actions/deploy-pages` (the standard GitHub Pages action)
  // or `peaceiris/actions-gh-pages` (the popular community alternative).
  // We classify as "deploy" when it looks like hatchkit's deploy.yml
  // (mentions `COOLIFY_` env or webhook). Reading the body is the only
  // reliable signal — filenames vary too much.
  //
  // Workflows + CNAME files live at the *repo* root by convention, not
  // wherever the user invoked us. Walk up to the git root so inventory
  // from a subdir (e.g. `apps/web/`) still picks them up.
  const repoRoot = findGitRoot(cwd) ?? cwd;
  const workflowsDir = join(repoRoot, ".github", "workflows");
  let ghPagesWorkflowPath: string | undefined;
  let deployWorkflowPath: string | undefined;
  if (existsSync(workflowsDir)) {
    try {
      for (const f of readdirSync(workflowsDir)) {
        if (!/\.ya?ml$/i.test(f)) continue;
        const full = join(workflowsDir, f);
        let body: string;
        try {
          body = readFileSync(full, "utf-8");
        } catch {
          continue;
        }
        if (
          !ghPagesWorkflowPath &&
          /actions\/deploy-pages|peaceiris\/actions-gh-pages/i.test(body)
        ) {
          ghPagesWorkflowPath = full;
        }
        if (!deployWorkflowPath && /COOLIFY_(WEBHOOK|TOKEN)|coolify\.io/i.test(body)) {
          deployWorkflowPath = full;
        }
      }
    } catch {
      // Unreadable workflows dir — skip.
    }
  }

  // CNAME file — GitHub Pages writes this at the publish-root to bind
  // a custom domain. Locations cover the common static-site layouts:
  // repo root (Jekyll), `docs/` (Pages-from-docs setup), `static/` and
  // `docs/static/` (Docusaurus), `public/` and `docs/public/` (Vite /
  // Next.js docs starters), `site/` and `www/` for the loose
  // conventions, and `website/static/` for older Docusaurus.
  let cnameFile: InventoryLocal["cnameFile"];
  for (const rel of [
    "CNAME",
    "docs/CNAME",
    "docs/static/CNAME",
    "docs/public/CNAME",
    "site/CNAME",
    "www/CNAME",
    "website/static/CNAME",
    "static/CNAME",
    "public/CNAME",
  ]) {
    const p = join(repoRoot, rel);
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8").trim();
        if (content) {
          cnameFile = { path: p, content };
          break;
        }
      } catch {
        // Unreadable — skip.
      }
    }
  }

  // dotenvx state — same probes as `hatchkit adopt`.
  const envProdPath = locateEnvProductionFile(cwd);
  let dotenvxEncrypted = false;
  if (envProdPath && existsSync(envProdPath)) {
    try {
      const head = readFileSync(envProdPath, "utf-8").slice(0, 2000);
      dotenvxEncrypted = /DOTENV_PUBLIC_KEY_PRODUCTION/.test(head);
    } catch {
      // Unreadable — leave false.
    }
  }
  const envKeysPresent = !!locateEnvKeysFile(cwd);

  // `.git` lives at the repo root — in a worktree it's a file pointing
  // at the main repo, in a normal clone it's a directory. Either form
  // is fine for existsSync. Walk up from cwd so running `hatchkit
  // inventory` from a subdir (e.g. `apps/web/`) still picks up the
  // repo root for git lookups.
  const gitRoot = findGitRoot(cwd);

  return {
    cwd,
    isGitRepo: !!gitRoot,
    hasGitHubRemote: false, // resolved below
    packageName,
    packageDescription,
    manifestPresent,
    manifest,
    serverDir,
    clientDir,
    hasDockerfile,
    composePath,
    ghPagesWorkflowPath,
    deployWorkflowPath,
    cnameFile,
    dotenvxEncrypted,
    envKeysPresent,
  };
}

function findGitRoot(startDir: string): string | undefined {
  let dir = startDir;
  // Cap at 12 levels — generous for any reasonable monorepo, and a
  // hard ceiling against pathological symlink loops.
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = join(dir, "..");
    const resolved = resolve(parent);
    if (resolved === dir) return undefined; // hit filesystem root
    dir = resolved;
  }
  return undefined;
}

function firstExistingDir(root: string, rels: string[]): string | undefined {
  for (const rel of rels) {
    const p = join(root, rel);
    try {
      if (statSync(p).isDirectory()) return p;
    } catch {
      // ENOENT — try next.
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Identity inference (combines local signals + caller-supplied input)
// ---------------------------------------------------------------------------

interface IdentitySources {
  name?: InferenceSource;
  domain?: InferenceSource;
  repo?: InferenceSource;
}

function inferIdentity(
  local: InventoryLocal,
  override: InventoryInput,
): { input: InventoryInput; sources: IdentitySources } {
  const sources: IdentitySources = {};
  const out: InventoryInput = {};

  // name: flag > manifest > package.json > basename(cwd) as last resort
  if (override.name) {
    out.name = override.name;
    sources.name = "flag";
  } else if (local.manifest?.name) {
    out.name = local.manifest.name;
    sources.name = "manifest";
  } else if (local.packageName) {
    out.name = local.packageName;
    sources.name = "package.json";
  } else {
    const base = local.cwd.split("/").filter(Boolean).pop();
    if (base && /^[a-z0-9][a-z0-9-]*$/i.test(base)) {
      // Last-resort guess from cwd basename. Surfaced with its own
      // source so the renderer can show low confidence — and so
      // interactive mode re-confirms before letting it drive scans.
      out.name = base;
      sources.name = "cwd-basename";
    }
  }

  // domain: flag > manifest > CNAME file > package homepage url? (skip;
  // too noisy). We deliberately don't derive a domain from the project
  // name — too speculative, and the matching layer already tries common
  // domain patterns against any zone we list.
  if (override.domain) {
    out.domain = override.domain;
    sources.domain = "flag";
  } else if (local.manifest?.domain) {
    out.domain = local.manifest.domain;
    sources.domain = "manifest";
  } else if (local.cnameFile?.content) {
    out.domain = local.cnameFile.content;
    sources.domain = "cname-file";
  }

  // repo: flag > git remote
  if (override.repo) {
    out.repo = override.repo;
    sources.repo = "flag";
  } else {
    // git remote is resolved async — leave undefined here; the caller
    // fills it via resolveGitRemote (run before prompting).
  }

  return { input: out, sources };
}

async function resolveGitRemote(local: InventoryLocal): Promise<{
  remote?: string;
  repo?: string;
  defaultBranch?: string;
  hasGitHubRemote: boolean;
}> {
  if (!local.isGitRepo) return { hasGitHubRemote: false };
  // Run git from the repo root if we found one — works from any subdir.
  const gitCwd = findGitRoot(local.cwd) ?? local.cwd;
  let remote: string | undefined;
  let defaultBranch: string | undefined;
  try {
    const res = await exec("git", ["remote", "get-url", "origin"], {
      cwd: gitCwd,
      silent: true,
    });
    if (res.exitCode === 0) {
      const out = res.stdout.trim();
      if (out) remote = out;
    }
  } catch {
    // git missing — fine.
  }
  try {
    const res = await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: gitCwd,
      silent: true,
    });
    if (res.exitCode === 0) {
      // Output is "origin/main" — strip the remote prefix.
      const out = res.stdout.trim().replace(/^origin\//, "");
      if (out) defaultBranch = out;
    }
  } catch {
    // Unset — fine.
  }

  const repo = repoSlugFromUrl(remote);
  return {
    remote,
    repo,
    defaultBranch,
    hasGitHubRemote: !!repo,
  };
}

function repoSlugFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const ssh = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (https) return `${https[1]}/${https[2]}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Interactive prompts (only for unknowns)
// ---------------------------------------------------------------------------

async function promptForGaps(
  local: InventoryLocal,
  inferred: InventoryInput,
  sources: IdentitySources,
  autoAccept: boolean,
): Promise<InventoryInput> {
  // Print a summary of what we found before asking.
  console.log(chalk.bold("\n  Detected from this directory:"));
  console.log(`    ${labelRow("Project name", inferred.name, sources.name)}`);
  console.log(`    ${labelRow("Domain", inferred.domain, sources.domain)}`);
  console.log(`    ${labelRow("GitHub repo", inferred.repo, sources.repo)}`);
  if (local.manifestPresent) console.log(chalk.dim(`    + ${MANIFEST_FILENAME} present`));
  if (local.dotenvxEncrypted) console.log(chalk.dim("    + .env.production is dotenvx-encrypted"));
  if (local.composePath)
    console.log(chalk.dim(`    + compose: ${rel(local.cwd, local.composePath)}`));
  if (local.ghPagesWorkflowPath)
    console.log(chalk.dim(`    + gh-pages workflow: ${rel(local.cwd, local.ghPagesWorkflowPath)}`));
  if (local.deployWorkflowPath)
    console.log(
      chalk.dim(`    + Coolify deploy workflow: ${rel(local.cwd, local.deployWorkflowPath)}`),
    );
  if (local.cnameFile)
    console.log(
      chalk.dim(
        `    + CNAME at ${rel(local.cwd, local.cnameFile.path)} → ${local.cnameFile.content}`,
      ),
    );
  console.log("");

  const out: InventoryInput = { ...inferred };

  // Name: required for most lookups. Always confirm or prompt.
  if (!out.name) {
    out.name = await input({
      message: "Project / app name (matches Coolify apps, buckets, clients):",
      validate: (v) => (v.trim().length > 0 ? true : "Required"),
    });
  } else if (!autoAccept) {
    const ok = await confirm({
      message: `Use ${chalk.bold(out.name)} as the project name?`,
      default: true,
    });
    if (!ok) {
      out.name = await input({
        message: "Project / app name:",
        default: out.name,
        validate: (v) => (v.trim().length > 0 ? true : "Required"),
      });
    }
  }

  // Domain: optional. Skip lookups that need it if blank.
  if (!out.domain) {
    const want = autoAccept
      ? false
      : await confirm({
          message: "Want to scan for resources tied to a specific domain?",
          default: true,
        });
    if (want) {
      out.domain = await input({
        message: "Primary domain (e.g. myapp.com — empty to skip):",
      });
      out.domain = out.domain?.trim() || undefined;
    }
  } else if (!autoAccept) {
    const ok = await confirm({
      message: `Use ${chalk.bold(out.domain)} as the primary domain?`,
      default: true,
    });
    if (!ok) {
      out.domain = await input({ message: "Primary domain (empty to skip):", default: out.domain });
      out.domain = out.domain?.trim() || undefined;
    }
  }

  // Repo: optional. Skip GH-side lookups if blank.
  if (!out.repo) {
    const want = autoAccept
      ? false
      : await confirm({
          message: "Want to scan a GitHub repo (Pages, secrets, visibility)?",
          default: false,
        });
    if (want) {
      out.repo = await input({
        message: "GitHub repo slug (owner/name — empty to skip):",
        validate: (v) =>
          !v.trim() || /^[^/\s]+\/[^/\s]+$/.test(v.trim()) ? true : "Expected owner/name format",
      });
      out.repo = out.repo?.trim() || undefined;
    }
  } else if (!autoAccept) {
    const ok = await confirm({
      message: `Use ${chalk.bold(out.repo)} as the GitHub repo?`,
      default: true,
    });
    if (!ok) {
      out.repo = await input({
        message: "GitHub repo slug (owner/name — empty to skip):",
        default: out.repo,
        validate: (v) =>
          !v.trim() || /^[^/\s]+\/[^/\s]+$/.test(v.trim()) ? true : "Expected owner/name format",
      });
      out.repo = out.repo?.trim() || undefined;
    }
  }

  return out;
}

function labelRow(
  label: string,
  value: string | undefined,
  source: InferenceSource | undefined,
): string {
  if (!value) return `${label.padEnd(14)} ${chalk.dim("·")} ${chalk.dim("(not detected)")}`;
  const src = source ? chalk.dim(`  ← ${source}`) : chalk.dim("  ← guess");
  return `${label.padEnd(14)} ${chalk.green("✓")} ${chalk.bold(value)}${src}`;
}

function rel(cwd: string, abs: string): string {
  if (abs.startsWith(`${cwd}/`)) return abs.slice(cwd.length + 1);
  return abs;
}

// ---------------------------------------------------------------------------
// Provider scans
// ---------------------------------------------------------------------------

interface ScanResult {
  provider: string;
  findings: InventoryFinding[];
  skipped: Array<{ provider: string; reason: string }>;
  /** Stash of raw values used by detectDrift — keeps the drift pass
   *  from re-issuing the same API calls. */
  raw?: Record<string, unknown>;
}

async function scanCoolify(input: InventoryInput): Promise<ScanResult> {
  const provider = "coolify";
  const findings: InventoryFinding[] = [];
  const skipped: Array<{ provider: string; reason: string }> = [];
  const cfg = await getCoolifyConfig();
  if (!cfg) {
    skipped.push({ provider, reason: "not configured (`hatchkit config add coolify`)" });
    return { provider, findings, skipped };
  }
  if (!input.name) {
    skipped.push({ provider, reason: "no project name to match against" });
    return { provider, findings, skipped };
  }

  const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
  let projects: Array<{ id: number; name: string }> = [];
  let apps: Array<{ uuid: string; name: string; description?: string }> = [];
  try {
    [projects, apps] = await Promise.all([
      api.listProjects().catch(() => []),
      api.listApplications().catch(() => []),
    ]);
  } catch (err) {
    skipped.push({
      provider,
      reason: `Coolify request failed: ${(err as Error).message.split("\n")[0]}`,
    });
    return { provider, findings, skipped };
  }

  const wantedNames = nameAliases(input.name);
  const projectMatches = projects.filter((p) => wantedNames.includes(p.name));
  const appMatches = apps.filter((a) => wantedNames.includes(a.name));

  for (const p of projectMatches) {
    findings.push({
      provider,
      kind: "project",
      identity: p.name,
      status: "present",
      detail: `Coolify project (id: ${p.id})`,
    });
  }

  // Hydrate each app match with its full details so drift can compare
  // fqdn / git_repository / server uuid. One call per match is cheap.
  const hydrated: CoolifyApplication[] = [];
  for (const a of appMatches) {
    try {
      const full = await api.getApplication(a.uuid);
      hydrated.push(full);
      const fqdns = collectFqdns(full);
      const detail = [
        `Coolify app (${full.buildPack ?? "?"})`,
        fqdns.length ? `fqdn: ${fqdns.join(", ")}` : "no fqdn",
        full.gitRepository ? `repo: ${full.gitRepository}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      findings.push({
        provider,
        kind: "application",
        identity: full.name,
        status: "present",
        detail,
      });
    } catch (err) {
      findings.push({
        provider,
        kind: "application",
        identity: a.name,
        status: "info",
        detail: `couldn't load detail: ${(err as Error).message.split("\n")[0]}`,
      });
    }
  }

  if (projectMatches.length === 0 && appMatches.length === 0) {
    findings.push({
      provider,
      kind: "application",
      identity: input.name,
      status: "missing",
      detail: `no Coolify project or app named ${wantedNames.join(" / ")} (${apps.length} app(s) total)`,
    });
  }

  return { provider, findings, skipped, raw: { hydrated } };
}

function collectFqdns(app: CoolifyApplication): string[] {
  const fqdns: string[] = [];
  if (app.fqdn) {
    for (const part of app.fqdn.split(",")) {
      const trimmed = part
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "");
      if (trimmed) fqdns.push(trimmed);
    }
  }
  if (app.dockerComposeDomains) {
    for (const d of app.dockerComposeDomains) {
      const stripped = d.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (stripped) fqdns.push(stripped);
    }
  }
  return Array.from(new Set(fqdns));
}

/** Project name aliases we'll match against remote resources.
 *  Keep in sync with `hatchkit adopt`'s detectProject — same family of
 *  conventions (raw, -server, -client, -web). */
function nameAliases(name: string): string[] {
  return [name, `${name}-server`, `${name}-client`, `${name}-web`, `${name}-api`];
}

async function scanDns(input: InventoryInput): Promise<ScanResult> {
  const provider = "dns";
  const findings: InventoryFinding[] = [];
  const skipped: Array<{ provider: string; reason: string }> = [];
  const cfg = await getDnsConfig();
  if (!cfg) {
    skipped.push({ provider, reason: "not configured (`hatchkit config add dns`)" });
    return { provider, findings, skipped };
  }
  if (cfg.provider !== "cloudflare") {
    skipped.push({
      provider,
      reason: `${cfg.provider} provider has no list API exposed (Cloudflare only for now)`,
    });
    return { provider, findings, skipped };
  }
  if (!cfg.apiToken) {
    skipped.push({ provider, reason: "Cloudflare API token missing from keychain" });
    return { provider, findings, skipped };
  }
  if (!input.domain) {
    skipped.push({ provider, reason: "no domain to look up" });
    return { provider, findings, skipped };
  }

  const cf = new CloudflareApi({ token: cfg.apiToken });
  const apex = apexOf(input.domain);
  let zone: { id: string; name: string } | null;
  try {
    zone = await cf.getZoneByName(apex);
  } catch (err) {
    skipped.push({
      provider,
      reason: `Cloudflare zone lookup failed: ${(err as Error).message.split("\n")[0]}`,
    });
    return { provider, findings, skipped };
  }
  if (!zone) {
    findings.push({
      provider,
      kind: "zone",
      identity: apex,
      status: "missing",
      detail: "no Cloudflare zone for this apex",
    });
    return { provider, findings, skipped };
  }

  findings.push({
    provider,
    kind: "zone",
    identity: zone.name,
    status: "present",
    detail: `zone id ${zone.id}`,
  });

  // Probe a curated set of relevant record names. For each we run an
  // exact name+type lookup — much cheaper than listing every record in
  // the zone and filtering. Misses the long tail but covers >95% of
  // hatchkit-managed naming.
  const probes = relevantRecordProbes(input);
  type RawRec = { id: string; name: string; type: string; content: string; proxied: boolean };
  const dnsRecords: RawRec[] = [];
  for (const probe of probes) {
    try {
      const rec = await cf.findRecord(zone.id, probe.name, probe.type);
      if (rec) {
        dnsRecords.push(rec);
        findings.push({
          provider,
          kind: "dns-record",
          identity: `${rec.name} ${rec.type}`,
          status: "present",
          detail: `${rec.content}${rec.proxied ? " (proxied)" : ""}`,
        });
      }
    } catch {
      // Record probe failed — skip silently; the zone-level finding
      // already proves auth works.
    }
  }

  return { provider, findings, skipped, raw: { zone, dnsRecords } };
}

function apexOf(domain: string): string {
  // crude but adequate: take the last two labels.
  const parts = domain.replace(/\.$/, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

function relevantRecordProbes(
  input: InventoryInput,
): Array<{ name: string; type: "A" | "AAAA" | "CNAME" }> {
  if (!input.domain) return [];
  const apex = apexOf(input.domain);
  const out: Array<{ name: string; type: "A" | "AAAA" | "CNAME" }> = [];
  const names = new Set<string>([
    input.domain,
    apex,
    `www.${apex}`,
    `api.${apex}`,
    `s3.${apex}`,
    `assets.${apex}`,
    `cdn.${apex}`,
    `docs.${apex}`,
  ]);
  if (input.name) names.add(`${input.name}.${apex}`);
  for (const n of names) {
    out.push({ name: n, type: "A" });
    out.push({ name: n, type: "CNAME" });
  }
  return out;
}

async function scanR2(
  input: InventoryInput,
  manifest: ProjectManifest | undefined,
): Promise<ScanResult> {
  const provider = "s3:r2";
  const findings: InventoryFinding[] = [];
  const skipped: Array<{ provider: string; reason: string }> = [];
  const cfg = await getS3Config("r2");
  if (!cfg) {
    skipped.push({ provider, reason: "R2 not configured (`hatchkit config add s3` → r2)" });
    return { provider, findings, skipped };
  }
  const adminToken = await getSecret(SECRET_KEYS.r2AdminToken);
  if (!adminToken) {
    skipped.push({ provider, reason: "R2 admin token not in keychain; can't list buckets" });
    return { provider, findings, skipped };
  }
  const accountId =
    manifest?.s3Buckets?.accountId ??
    cfg.endpoint?.match(/https?:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com/i)?.[1];
  if (!accountId) {
    skipped.push({ provider, reason: "couldn't derive R2 account id from manifest or endpoint" });
    return { provider, findings, skipped };
  }
  const cf = new CloudflareApi({ token: adminToken });

  // Candidate bucket names: manifest entries first (authoritative —
  // these are buckets hatchkit knows it created), then naming-convention
  // guesses for projects without a manifest.
  const candidates = new Set<string>();
  const manifestBuckets: Array<{ name: string; manifestKey: string }> = [];
  if (manifest?.s3Buckets) {
    for (const [key, value] of Object.entries(manifest.s3Buckets)) {
      if (!value || typeof value !== "object") continue;
      const v = value as { name?: string };
      if (typeof v.name === "string" && v.name) {
        candidates.add(v.name);
        manifestBuckets.push({ name: v.name, manifestKey: key });
      }
    }
  }
  if (input.name) {
    candidates.add(`${input.name}-assets`);
    candidates.add(`${input.name}-state`);
    candidates.add(input.name);
  }

  const live: Array<{
    name: string;
    bucket: { name: string; location?: string; storage_class?: string } | null;
    cors?: Array<{ allowed?: { origins?: string[] } }> | null;
    customDomains?: Array<{ domain: string; enabled: boolean }>;
  }> = [];

  for (const name of candidates) {
    try {
      const bucket = await cf.getR2Bucket(accountId, name);
      if (!bucket) {
        live.push({ name, bucket: null });
        continue;
      }
      const [cors, domains] = await Promise.all([
        cf.getR2BucketCors(accountId, name).catch(() => null),
        cf.listR2CustomDomains(accountId, name).catch(() => []),
      ]);
      live.push({ name, bucket, cors, customDomains: domains });
      const domainSummary = (domains ?? [])
        .filter((d) => d.enabled)
        .map((d) => d.domain)
        .join(", ");
      const corsSummary = cors?.[0]?.allowed?.origins?.length
        ? `${cors[0].allowed.origins.length} CORS origin(s)`
        : "no CORS";
      findings.push({
        provider,
        kind: "bucket",
        identity: name,
        status: "present",
        detail: [
          bucket.storage_class ? `class: ${bucket.storage_class}` : undefined,
          domainSummary ? `custom: ${domainSummary}` : undefined,
          corsSummary,
        ]
          .filter(Boolean)
          .join(" · "),
      });
    } catch (err) {
      // Auth probably broken — bubble as skip rather than per-bucket fail.
      skipped.push({
        provider,
        reason: `R2 lookup for "${name}" failed: ${(err as Error).message.split("\n")[0]}`,
      });
      return { provider, findings, skipped, raw: { accountId, live, manifestBuckets } };
    }
  }

  // If we looked but nothing matched, leave a breadcrumb. Without
  // this, scanR2 returns empty findings and the user wonders whether
  // we even tried.
  if (findings.length === 0 && candidates.size > 0) {
    findings.push({
      provider,
      kind: "bucket",
      identity: input.name ?? "(candidates)",
      status: "missing",
      detail: `no R2 bucket matches ${Array.from(candidates).join(" / ")} (account ${accountId.slice(0, 6)}…)`,
    });
  }

  return { provider, findings, skipped, raw: { accountId, live, manifestBuckets } };
}

async function scanS3Other(_input: InventoryInput): Promise<ScanResult> {
  // Hetzner Object Storage + AWS S3 don't have a "list all buckets for
  // this access key" call exposed in the existing client. We surface
  // presence only, so the user knows where else to look. A full impl
  // would need an `@aws-sdk/client-s3` `ListBuckets` call, which is
  // already a dep — but adding that here doubles the surface area;
  // ship without for now and revisit if anyone asks.
  const provider = "s3";
  const findings: InventoryFinding[] = [];
  const skipped: Array<{ provider: string; reason: string }> = [];
  for (const p of ["hetzner", "aws"] as const) {
    const cfg = await getS3Config(p);
    if (cfg) {
      findings.push({
        provider: `s3:${p}`,
        kind: "credentials",
        identity: p,
        status: "info",
        detail: `endpoint: ${cfg.endpoint} — bucket inventory not implemented for ${p}`,
      });
    } else {
      skipped.push({ provider: `s3:${p}`, reason: "not configured" });
    }
  }
  return { provider, findings, skipped };
}

async function scanGitHub(input: InventoryInput): Promise<ScanResult> {
  const provider = "github";
  const findings: InventoryFinding[] = [];
  const skipped: Array<{ provider: string; reason: string }> = [];
  if (!input.repo) {
    skipped.push({ provider, reason: "no GitHub repo to look up" });
    return { provider, findings, skipped };
  }
  if (!(await execOk("gh", ["--version"]))) {
    skipped.push({ provider, reason: "`gh` CLI not installed" });
    return { provider, findings, skipped };
  }
  if (!(await execOk("gh", ["auth", "status"]))) {
    skipped.push({ provider, reason: "`gh` not authenticated (run `gh auth login`)" });
    return { provider, findings, skipped };
  }

  // Repo metadata.
  let repoInfo: {
    visibility?: string;
    defaultBranchRef?: { name?: string };
    description?: string;
    homepageUrl?: string;
    isArchived?: boolean;
  } = {};
  try {
    const res = await exec(
      "gh",
      [
        "repo",
        "view",
        input.repo,
        "--json",
        "visibility,defaultBranchRef,description,homepageUrl,isArchived",
      ],
      { silent: true },
    );
    if (res.exitCode === 0) {
      repoInfo = JSON.parse(res.stdout) as typeof repoInfo;
      findings.push({
        provider,
        kind: "repository",
        identity: input.repo,
        status: "present",
        detail: [
          repoInfo.visibility?.toLowerCase(),
          `default: ${repoInfo.defaultBranchRef?.name ?? "?"}`,
          repoInfo.isArchived ? "archived" : undefined,
          repoInfo.homepageUrl ? `homepage: ${repoInfo.homepageUrl}` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      });
    } else {
      findings.push({
        provider,
        kind: "repository",
        identity: input.repo,
        status: "missing",
        detail: res.stderr.trim().split("\n")[0],
      });
      return { provider, findings, skipped, raw: { repoInfo } };
    }
  } catch (err) {
    findings.push({
      provider,
      kind: "repository",
      identity: input.repo,
      status: "info",
      detail: `gh repo view failed: ${(err as Error).message.split("\n")[0]}`,
    });
  }

  // GitHub Pages.
  interface PagesInfo {
    status?: string;
    cname?: string | null;
    https_enforced?: boolean;
    source?: { branch?: string; path?: string };
    html_url?: string;
  }
  let pages: PagesInfo | null = null;
  try {
    const res = await exec("gh", ["api", `repos/${input.repo}/pages`], { silent: true });
    if (res.exitCode === 0) {
      pages = JSON.parse(res.stdout) as PagesInfo;
      findings.push({
        provider: "github-pages",
        kind: "page-site",
        identity: input.repo,
        status: "present",
        detail: [
          pages?.status,
          pages?.cname ? `cname: ${pages.cname}` : "no custom domain",
          pages?.html_url,
        ]
          .filter(Boolean)
          .join(" · "),
      });
    } else if (/HTTP 404/.test(res.stderr)) {
      findings.push({
        provider: "github-pages",
        kind: "page-site",
        identity: input.repo,
        status: "missing",
        detail: "Pages is not enabled on this repo",
      });
    } else {
      findings.push({
        provider: "github-pages",
        kind: "page-site",
        identity: input.repo,
        status: "info",
        detail: `gh api repos/<repo>/pages failed: ${res.stderr.trim().split("\n")[0]}`,
      });
    }
  } catch (err) {
    findings.push({
      provider: "github-pages",
      kind: "page-site",
      identity: input.repo,
      status: "info",
      detail: `pages probe failed: ${(err as Error).message.split("\n")[0]}`,
    });
  }

  // Repo secrets — surface only the ones hatchkit cares about, by name.
  const relevantSecrets = [
    "DOTENV_PRIVATE_KEY_PRODUCTION",
    "COOLIFY_API_URL",
    "COOLIFY_API_TOKEN",
    "COOLIFY_APP_UUID",
  ];
  try {
    const res = await exec(
      "gh",
      ["secret", "list", "--repo", input.repo, "--json", "name,updatedAt"],
      { silent: true },
    );
    if (res.exitCode === 0) {
      const all = JSON.parse(res.stdout) as Array<{ name: string; updatedAt?: string }>;
      const haves = new Set(all.map((s) => s.name));
      for (const want of relevantSecrets) {
        if (haves.has(want)) {
          findings.push({
            provider,
            kind: "secret",
            identity: want,
            status: "present",
            detail: "set on repo",
          });
        }
      }
      const extras = all.length;
      findings.push({
        provider,
        kind: "secret-summary",
        identity: input.repo,
        status: "info",
        detail: `${extras} secret(s) total on repo`,
      });
    }
  } catch {
    // Non-fatal — secret-listing requires admin scope on the gh token.
  }

  return { provider, findings, skipped, raw: { repoInfo, pages } };
}

async function scanResend(input: InventoryInput): Promise<ScanResult> {
  const provider = "resend";
  const findings: InventoryFinding[] = [];
  const skipped: Array<{ provider: string; reason: string }> = [];
  const cfg = await getResendConfig();
  if (!cfg) {
    skipped.push({ provider, reason: "not configured" });
    return { provider, findings, skipped };
  }
  if (!input.domain) {
    skipped.push({ provider, reason: "no domain to match against verified Resend domains" });
    return { provider, findings, skipped };
  }
  try {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ name?: string; status?: string }> };
    const apex = apexOf(input.domain);
    const matches = (body.data ?? []).filter(
      (d) => typeof d.name === "string" && (d.name === input.domain || d.name === apex),
    );
    if (matches.length === 0) {
      findings.push({
        provider,
        kind: "verified-domain",
        identity: input.domain,
        status: "missing",
        detail: `no Resend domain entry for ${input.domain} (${(body.data ?? []).length} domain(s) total)`,
      });
    } else {
      for (const m of matches) {
        findings.push({
          provider,
          kind: "verified-domain",
          identity: m.name ?? input.domain,
          status: "present",
          detail: `status: ${m.status ?? "?"}`,
        });
      }
    }
  } catch (err) {
    skipped.push({
      provider,
      reason: `Resend lookup failed: ${(err as Error).message.split("\n")[0]}`,
    });
  }
  return { provider, findings, skipped };
}

async function scanGlitchtip(input: InventoryInput): Promise<ScanResult> {
  const provider = "glitchtip";
  const findings: InventoryFinding[] = [];
  const skipped: Array<{ provider: string; reason: string }> = [];
  const cfg = await getGlitchtipConfig();
  if (!cfg) {
    skipped.push({ provider, reason: "not configured" });
    return { provider, findings, skipped };
  }
  if (!input.name) {
    skipped.push({ provider, reason: "no project name to match against GlitchTip projects" });
    return { provider, findings, skipped };
  }
  try {
    const res = await fetch(
      `${cfg.url.replace(/\/$/, "")}/api/0/organizations/${cfg.organizationSlug}/projects/`,
      { headers: { Authorization: `Bearer ${cfg.token}` } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Array<{ name?: string; slug?: string; platform?: string }>;
    const wanted = nameAliases(input.name);
    const matches = body.filter(
      (p) =>
        (typeof p.name === "string" && wanted.includes(p.name)) ||
        (typeof p.slug === "string" && wanted.includes(p.slug)),
    );
    if (matches.length === 0) {
      findings.push({
        provider,
        kind: "project",
        identity: input.name,
        status: "missing",
        detail: `no GlitchTip project matching ${wanted.join(" / ")} (${body.length} total in org)`,
      });
    } else {
      for (const p of matches) {
        findings.push({
          provider,
          kind: "project",
          identity: p.slug ?? p.name ?? input.name,
          status: "present",
          detail: p.platform ? `platform: ${p.platform}` : undefined,
        });
      }
    }
  } catch (err) {
    skipped.push({
      provider,
      reason: `GlitchTip lookup failed: ${(err as Error).message.split("\n")[0]}`,
    });
  }
  return { provider, findings, skipped };
}

async function scanOpenpanel(input: InventoryInput): Promise<ScanResult> {
  const provider = "openpanel";
  const findings: InventoryFinding[] = [];
  const skipped: Array<{ provider: string; reason: string }> = [];
  const cfg = await getOpenpanelConfig();
  if (!cfg) {
    skipped.push({ provider, reason: "not configured" });
    return { provider, findings, skipped };
  }
  if (!input.name) {
    skipped.push({ provider, reason: "no project name to match against OpenPanel projects" });
    return { provider, findings, skipped };
  }
  try {
    const base = (cfg.apiUrl ?? cfg.url).replace(/\/$/, "");
    const res = await fetch(`${base}/manage/projects`, {
      headers: {
        "openpanel-client-id": cfg.rootClientId,
        "openpanel-client-secret": cfg.rootClientSecret,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // OpenPanel's manage API sometimes returns a bare array, sometimes
    // `{ data: [...] }`. Accept either shape.
    const raw = (await res.json()) as unknown;
    const projects: Array<{ name?: string; id?: string }> = Array.isArray(raw)
      ? (raw as Array<{ name?: string; id?: string }>)
      : ((raw as { data?: Array<{ name?: string; id?: string }> }).data ?? []);
    const wanted = nameAliases(input.name);
    const matches = projects.filter(
      (p) =>
        (typeof p.name === "string" && wanted.includes(p.name)) ||
        (typeof p.id === "string" && wanted.includes(p.id)),
    );
    if (matches.length === 0) {
      findings.push({
        provider,
        kind: "project",
        identity: input.name,
        status: "missing",
        detail: `no OpenPanel project matching ${wanted.join(" / ")} (${projects.length} total)`,
      });
    } else {
      for (const p of matches) {
        findings.push({
          provider,
          kind: "project",
          identity: p.name ?? p.id ?? input.name,
          status: "present",
        });
      }
    }
  } catch (err) {
    skipped.push({
      provider,
      reason: `OpenPanel lookup failed: ${(err as Error).message.split("\n")[0]}`,
    });
  }
  return { provider, findings, skipped };
}

async function scanStripe(input: InventoryInput): Promise<ScanResult> {
  const provider = "stripe";
  const findings: InventoryFinding[] = [];
  const skipped: Array<{ provider: string; reason: string }> = [];
  const cfg = await getStripeConfig();
  if (!cfg) {
    skipped.push({ provider, reason: "not configured" });
    return { provider, findings, skipped };
  }
  if (!input.domain) {
    skipped.push({
      provider,
      reason: "no domain to match against Stripe webhook endpoints",
    });
    return { provider, findings, skipped };
  }
  // Probe each mode that has a stored master key.
  for (const mode of ["test", "live"] as const) {
    const key = mode === "test" ? cfg.testSecretKey : cfg.liveSecretKey;
    if (!key) continue;
    try {
      const res = await fetch("https://api.stripe.com/v1/webhook_endpoints?limit=100", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        data?: Array<{ id?: string; url?: string; status?: string }>;
      };
      const matches = (body.data ?? []).filter(
        (w) => typeof w.url === "string" && w.url.includes(input.domain ?? ""),
      );
      if (matches.length === 0) {
        findings.push({
          provider,
          kind: "webhook-endpoint",
          identity: `${mode} mode`,
          status: "missing",
          detail: `no webhook endpoint with URL containing ${input.domain} (${(body.data ?? []).length} endpoint(s) in ${mode} mode)`,
        });
      } else {
        for (const w of matches) {
          findings.push({
            provider,
            kind: "webhook-endpoint",
            identity: `${mode}:${w.id ?? "?"}`,
            status: "present",
            detail: `${w.url} (${w.status ?? "?"})`,
          });
        }
      }
    } catch (err) {
      skipped.push({
        provider,
        reason: `Stripe ${mode}-mode lookup failed: ${(err as Error).message.split("\n")[0]}`,
      });
    }
  }
  return { provider, findings, skipped };
}

// ---------------------------------------------------------------------------
// Drift detection (cross-references between scan results + local state)
// ---------------------------------------------------------------------------

async function detectDrift(
  input: InventoryInput,
  local: InventoryLocal,
  scanResults: ScanResult[],
): Promise<InventoryFinding[]> {
  const out: InventoryFinding[] = [];
  const byProvider = new Map(scanResults.map((r) => [r.provider, r] as const));

  const coolify = byProvider.get("coolify");
  const dns = byProvider.get("dns");
  const r2 = byProvider.get("s3:r2");
  const github = byProvider.get("github");

  // D1: Coolify app fqdn vs DNS A record content (when both are
  //     present). We resolve via the Cloudflare zone records we already
  //     fetched in scanDns — no extra network hop.
  if (coolify?.raw && dns?.raw && input.domain) {
    const hydrated = (coolify.raw.hydrated ?? []) as CoolifyApplication[];
    const dnsRecords = (dns.raw.dnsRecords ?? []) as Array<{
      name: string;
      type: string;
      content: string;
      proxied: boolean;
    }>;
    for (const app of hydrated) {
      const fqdns = collectFqdns(app);
      const matchedFqdn = fqdns.find(
        (f) => f === input.domain || f.endsWith(`.${apexOf(input.domain ?? "")}`),
      );
      if (!matchedFqdn) continue;
      const aRecord = dnsRecords.find((r) => r.type === "A" && r.name === matchedFqdn);
      if (!aRecord) {
        out.push({
          provider: "drift",
          kind: "coolify-dns",
          identity: `${app.name} → ${matchedFqdn}`,
          status: "drift",
          drift: [
            `Coolify app "${app.name}" serves ${matchedFqdn} but no A record exists in Cloudflare for that name`,
          ],
        });
        continue;
      }
      // Best-effort: compare against the Coolify server's public IP
      // when we can pull it. The server uuid lives on the application.
      if (app.serverUuid) {
        try {
          const cfgC = await getCoolifyConfig();
          if (cfgC) {
            const api = new CoolifyApi({ url: cfgC.url, token: cfgC.token });
            const domains = await api.getServerDomains(app.serverUuid).catch(() => []);
            const ips = Array.from(
              new Set(domains.map((d) => d.ip).filter((ip): ip is string => !!ip)),
            );
            if (ips.length > 0 && !ips.includes(aRecord.content) && !aRecord.proxied) {
              out.push({
                provider: "drift",
                kind: "coolify-dns",
                identity: `${app.name} → ${matchedFqdn}`,
                status: "drift",
                drift: [
                  `Cloudflare A record points to ${aRecord.content}`,
                  `Coolify server IP(s): ${ips.join(", ")}`,
                  `(record is not proxied — direct IP mismatch will black-hole traffic)`,
                ],
              });
            }
          }
        } catch {
          // Couldn't resolve server IP — skip silently.
        }
      }
    }
  }

  // D2: Coolify app git_repository vs local git remote — same project
  //     name on different repos is a common gotcha during renames.
  if (coolify?.raw && local.gitRemote) {
    const hydrated = (coolify.raw.hydrated ?? []) as CoolifyApplication[];
    const localSlug = repoSlugFromUrl(local.gitRemote);
    for (const app of hydrated) {
      if (!app.gitRepository) continue;
      const remoteSlug =
        repoSlugFromUrl(app.gitRepository) ??
        app.gitRepository.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
      if (localSlug && remoteSlug && localSlug.toLowerCase() !== remoteSlug.toLowerCase()) {
        out.push({
          provider: "drift",
          kind: "coolify-source",
          identity: app.name,
          status: "drift",
          drift: [
            `Coolify app deploys from: ${app.gitRepository}`,
            `Local git remote:         ${local.gitRemote}`,
          ],
        });
      }
    }
  }

  // D3: Manifest-listed buckets that don't actually exist live.
  if (r2?.raw) {
    const manifestBuckets = (r2.raw.manifestBuckets ?? []) as Array<{
      name: string;
      manifestKey: string;
    }>;
    const live = (r2.raw.live ?? []) as Array<{
      name: string;
      bucket: { name: string } | null;
    }>;
    for (const mb of manifestBuckets) {
      const hit = live.find((l) => l.name === mb.name);
      if (!hit || !hit.bucket) {
        out.push({
          provider: "drift",
          kind: "bucket",
          identity: mb.name,
          status: "drift",
          drift: [
            `Manifest s3Buckets.${mb.manifestKey} = "${mb.name}"`,
            `Live R2: no bucket with that name`,
            `Fix: \`hatchkit provision s3\` to reconcile, or remove the entry from .hatchkit.json`,
          ],
        });
      }
    }
  }

  // D4: R2 CORS — manifest-recorded origins vs live policy. Mirrors
  //     `doctor.checkProjectS3CorsState` but inventory runs against the
  //     buckets it scanned instead of re-walking the manifest.
  if (r2?.raw && local.manifest?.s3Buckets) {
    const live = (r2.raw.live ?? []) as Array<{
      name: string;
      cors?: Array<{ allowed?: { origins?: string[] } }> | null;
    }>;
    const assets = local.manifest.s3Buckets.assets;
    if (
      assets &&
      typeof assets === "object" &&
      "cors" in assets &&
      assets.cors &&
      !assets.cors.skipped
    ) {
      const recorded = (assets.cors.origins ?? []).slice().sort();
      const hit = live.find((l) => l.name === assets.name);
      const liveOrigins = (hit?.cors?.[0]?.allowed?.origins ?? []).slice().sort();
      const same =
        recorded.length === liveOrigins.length && recorded.every((o, i) => o === liveOrigins[i]);
      if (!same && recorded.length > 0) {
        out.push({
          provider: "drift",
          kind: "bucket-cors",
          identity: assets.name,
          status: "drift",
          drift: [
            `Manifest origins: ${recorded.join(", ") || "(empty)"}`,
            `Live origins:     ${liveOrigins.join(", ") || "(empty)"}`,
            `Fix: \`hatchkit provision s3\` to reconcile`,
          ],
        });
      }
    }
  }

  // D5: gh-pages workflow on disk but Pages isn't enabled — or vice
  //     versa (Pages enabled but no workflow committed).
  if (github?.raw) {
    const pages = github.raw.pages as { status?: string; cname?: string | null } | null;
    if (local.ghPagesWorkflowPath && !pages) {
      out.push({
        provider: "drift",
        kind: "github-pages-state",
        identity: input.repo ?? "(repo)",
        status: "drift",
        drift: [
          `Local workflow exists: ${rel(local.cwd, local.ghPagesWorkflowPath)}`,
          `GitHub Pages: not enabled`,
          `Fix: \`hatchkit gh-pages\` or enable Pages in repo Settings`,
        ],
      });
    }
    if (!local.ghPagesWorkflowPath && pages && pages.status) {
      out.push({
        provider: "drift",
        kind: "github-pages-state",
        identity: input.repo ?? "(repo)",
        status: "drift",
        drift: [
          `GitHub Pages enabled (status: ${pages.status})`,
          `No Pages-deploying workflow in .github/workflows`,
          `Fix: commit a Pages-deploying workflow or disable Pages in repo Settings`,
        ],
      });
    }

    // D5b: CNAME file vs Pages custom domain. If both exist and disagree,
    //      one will silently win on next deploy — usually painful.
    if (local.cnameFile && pages?.cname && local.cnameFile.content !== pages.cname) {
      out.push({
        provider: "drift",
        kind: "github-pages-cname",
        identity: input.repo ?? "(repo)",
        status: "drift",
        drift: [
          `CNAME file:    ${local.cnameFile.content} (at ${rel(local.cwd, local.cnameFile.path)})`,
          `Pages setting: ${pages.cname}`,
        ],
      });
    }
  }

  // D6: dotenvx in use locally but no DOTENV_PRIVATE_KEY_PRODUCTION
  //     secret on the GitHub repo. The deploy workflow will need that
  //     to decrypt at runtime.
  if (github?.raw && local.dotenvxEncrypted) {
    const repoSecrets = github.findings.filter((f) => f.kind === "secret");
    const hasKey = repoSecrets.some((s) => s.identity === "DOTENV_PRIVATE_KEY_PRODUCTION");
    if (!hasKey && input.name) {
      out.push({
        provider: "drift",
        kind: "missing-secret",
        identity: "DOTENV_PRIVATE_KEY_PRODUCTION",
        status: "drift",
        drift: [
          ".env.production is dotenvx-encrypted locally",
          `GitHub repo ${input.repo} has no DOTENV_PRIVATE_KEY_PRODUCTION secret`,
          `Fix: \`hatchkit keys push ${input.name} --target=gh --repo ${input.repo}\``,
        ],
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Renderer (human)
// ---------------------------------------------------------------------------

export function renderInventoryHuman(report: InventoryReport): string {
  const lines: string[] = [];
  lines.push(chalk.bold("  hatchkit inventory"));
  lines.push(chalk.dim(`  cwd: ${report.cwd}`));
  lines.push("");
  lines.push(chalk.bold("  Identity:"));
  lines.push(
    `    name   ${report.inferred.name ? chalk.bold(report.inferred.name) : chalk.dim("·")}${sourceTag(report.sources.name)}`,
  );
  lines.push(
    `    domain ${report.inferred.domain ? chalk.bold(report.inferred.domain) : chalk.dim("·")}${sourceTag(report.sources.domain)}`,
  );
  lines.push(
    `    repo   ${report.inferred.repo ? chalk.bold(report.inferred.repo) : chalk.dim("·")}${sourceTag(report.sources.repo)}`,
  );
  lines.push("");

  // Group findings by provider for display.
  const grouped = new Map<string, InventoryFinding[]>();
  for (const f of report.findings) {
    const key = f.provider;
    const existing = grouped.get(key);
    if (existing) existing.push(f);
    else grouped.set(key, [f]);
  }

  // Drifts first — they're the actionable thing.
  if (report.drifts.length > 0) {
    lines.push(chalk.bold.yellow("  ⚠ Drift detected:"));
    for (const d of report.drifts) {
      lines.push(`    ${chalk.yellow("⚠")} ${chalk.bold(d.identity)} ${chalk.dim(`(${d.kind})`)}`);
      for (const line of d.drift ?? []) {
        lines.push(`        ${chalk.dim("→")} ${line}`);
      }
    }
    lines.push("");
  }

  // Per-provider sections (skip "drift" pseudo-provider — already
  // surfaced above).
  for (const [providerKey, findings] of grouped) {
    if (providerKey === "drift") continue;
    lines.push(chalk.bold(`  ${providerKey}`));
    for (const f of findings) {
      const icon =
        f.status === "present"
          ? chalk.green("✓")
          : f.status === "missing"
            ? chalk.red("✗")
            : f.status === "drift"
              ? chalk.yellow("⚠")
              : chalk.dim("·");
      const kind = chalk.dim(`(${f.kind})`);
      const detail = f.detail ? chalk.dim(` — ${f.detail}`) : "";
      lines.push(`    ${icon} ${f.identity} ${kind}${detail}`);
    }
    lines.push("");
  }

  if (report.skipped.length > 0) {
    lines.push(chalk.dim("  Skipped:"));
    for (const s of report.skipped) {
      lines.push(chalk.dim(`    · ${s.provider}: ${s.reason}`));
    }
    lines.push("");
  }

  lines.push(
    `  ${chalk.green(`${report.summary.present} present`)}  ${
      report.summary.drift > 0
        ? chalk.yellow(`${report.summary.drift} drift`)
        : chalk.dim("0 drift")
    }  ${
      report.summary.missing > 0
        ? chalk.red(`${report.summary.missing} missing`)
        : chalk.dim("0 missing")
    }  ${chalk.dim(`${report.summary.skipped} skipped`)}`,
  );
  lines.push("");
  return lines.join("\n");
}

function sourceTag(s: InferenceSource | undefined): string {
  if (!s) return chalk.dim("  (will prompt)");
  return chalk.dim(`  ← ${s}`);
}
