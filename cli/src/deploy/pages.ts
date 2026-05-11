import { resolve4 } from "node:dns/promises";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { ensureDns, getDnsConfig } from "../config.js";
import { CloudflareApi } from "../utils/cloudflare-api.js";
import { exec } from "../utils/exec.js";
import { parseDomain, validateDomain } from "../utils/validate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What kind of site lives in a folder — determines the build workflow. */
export type SiteKind = "static" | "node-build" | "docusaurus" | "jekyll";

export interface Detected {
  kind: SiteKind;
  /** Folder uploaded to Pages. Relative to repo root. */
  publishDir: string;
  /** Package manager for node-build sites. */
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
  /** npm script name used for the build (usually "build"). */
  buildScript?: string;
  /** Working directory for the build. Empty string = repo root. */
  workDir: string;
}

interface SiteCandidate {
  /** Path relative to cwd. Empty string = repo root. */
  dir: string;
  detected: Detected;
}

interface RepoInfo {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

// GitHub's apex A records (docs: configuring-a-custom-domain-for-your-github-pages-site)
const GITHUB_APEX_A = ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"];

/** Directories we scan when looking for sites. Empty = repo root. */
const SCAN_DIRS = ["", "docs", "site", "www", "web"];

const WORKFLOW_FILENAME = "gh-pages.yml";

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function runPagesSetup(cwd: string): Promise<void> {
  console.log(chalk.bold("\n  ── hatchkit gh-pages ──────────────────────────────────────\n"));

  // 1. Repo — must be a git repo with an `origin` pointing at GitHub.
  const repo = await detectRepo(cwd);
  printRepoHeader(repo);

  // 2. Pick a site. Auto-confirm when there's one obvious candidate;
  //    ask when zero or many. Also let the user override the detected
  //    publish folder before we commit to writing anything.
  const confirmed = await pickSite(cwd);

  // 3. Custom domain (optional).
  const domain = await promptDomain();

  await executePagesSetup(cwd, repo, confirmed, domain);
}

/** Programmatic entrypoint for the create/adopt flows.
 *
 *  Takes already-resolved values (detected site shape, optional
 *  custom domain) and runs the same enable / workflow / DNS / cert
 *  pipeline as the interactive flow. Skips the pickSite + promptDomain
 *  steps so it's safe to call from within a larger non-interactive
 *  scaffold.
 *
 *  Returns the public URL the site will be served from so callers
 *  can include it in their summary. */
export async function runPagesSetupProgrammatic(
  cwd: string,
  opts: { detected: Detected; domain: string | null },
): Promise<{ pageUrl: string }> {
  const repo = await detectRepo(cwd);
  printRepoHeader(repo);
  await executePagesSetup(cwd, repo, opts.detected, opts.domain);
  return {
    pageUrl: opts.domain
      ? `https://${opts.domain}`
      : `https://${repo.owner}.github.io/${repo.repo}/`,
  };
}

function printRepoHeader(repo: RepoInfo): void {
  console.log(chalk.dim(`  Repo:  ${repo.fullName} (${repo.private ? "private" : "public"})`));
  if (repo.private) {
    console.log(
      chalk.yellow(
        "  ⚠ Private repos need a paid GitHub plan (Pro/Team/Enterprise) for Pages.\n    Continuing anyway — will fail at API call if unsupported.",
      ),
    );
  }
}

/** The shared execution pipeline used by both the interactive
 *  `runPagesSetup` and the programmatic `runPagesSetupProgrammatic`.
 *  Everything from "we know what to deploy and where" onwards lives
 *  here — anything *before* that (site detection, domain prompt) is
 *  caller-specific. */
async function executePagesSetup(
  cwd: string,
  repo: RepoInfo,
  confirmed: Detected,
  domain: string | null,
): Promise<void> {
  // 4. Enable Pages via GitHub API.
  await enablePages(repo);

  // 5. Write the workflow — unless the repo already has a Pages-deploying
  //    workflow (ours or otherwise). Avoids clobbering an existing setup.
  writeWorkflow(cwd, repo, confirmed);

  // 6. CNAME file — only when a custom domain is chosen.
  if (domain) writeCnameFile(cwd, confirmed, domain);

  // 7. DNS + Pages CNAME + HTTPS.
  //
  // Order matters: GitHub validates the cname by resolving DNS the moment
  // we PUT it. If DNS isn't in place yet, validation fails silently, cert
  // provisioning is never kicked off, and GitHub doesn't retry. So:
  //   a. Wire DNS first.
  //   b. Wait for DNS to actually resolve (only when we wrote it ourselves).
  //   c. Then tell GitHub the cname — bouncing it first if a prior run
  //      left it stuck without a cert.
  //   d. Wait for the Let's Encrypt cert to be issued, then flip
  //      `https_enforced` so http:// redirects to https://.
  if (domain) {
    const { wired } = await configureDns(domain);
    if (wired) await waitForDnsResolves(domain);
    await setPagesCname(repo, domain);
    await provisionHttps(repo, wired);
  }

  printSummary(repo, confirmed, domain);
}

// ---------------------------------------------------------------------------
// Repo detection
// ---------------------------------------------------------------------------

async function detectRepo(cwd: string): Promise<RepoInfo> {
  const res = await exec(
    "gh",
    ["repo", "view", "--json", "nameWithOwner,visibility,defaultBranchRef,owner,name"],
    { cwd, silent: true },
  );
  if (res.exitCode !== 0) {
    throw new Error(
      "Couldn't resolve the GitHub repo for this directory. Make sure you're inside a git repo with an `origin` remote and that `gh auth status` works.",
    );
  }
  const parsed = JSON.parse(res.stdout) as {
    nameWithOwner: string;
    visibility: string;
    defaultBranchRef: { name: string };
    owner: { login: string };
    name: string;
  };
  return {
    owner: parsed.owner.login,
    repo: parsed.name,
    fullName: parsed.nameWithOwner,
    defaultBranch: parsed.defaultBranchRef?.name ?? "main",
    private: parsed.visibility === "PRIVATE",
  };
}

// ---------------------------------------------------------------------------
// Site detection
// ---------------------------------------------------------------------------

async function pickSite(cwd: string): Promise<Detected> {
  const candidates = findSiteCandidates(cwd);

  if (candidates.length === 0) {
    console.log(
      chalk.yellow("  No site detected in the usual spots (root / docs / site / www / web)."),
    );
    return promptManualSite(cwd);
  }

  let chosen: SiteCandidate;
  if (candidates.length === 1) {
    chosen = candidates[0];
    console.log(chalk.dim(`  Site:  ${describeCandidate(chosen)} ${chalk.dim("(auto-detected)")}`));
  } else {
    console.log(chalk.dim(`  Found ${candidates.length} possible sites — pick one:`));
    chosen = await select<SiteCandidate>({
      message: "Which site do you want to deploy?",
      choices: candidates.map((c) => ({ name: describeCandidate(c), value: c })),
    });
  }

  return confirmProjectShape(chosen.detected);
}

function describeCandidate(c: SiteCandidate): string {
  const loc = c.dir === "" ? "repo root" : `${c.dir}/`;
  const extra =
    c.detected.kind === "node-build"
      ? ` (${c.detected.packageManager} run ${c.detected.buildScript} → ${c.detected.publishDir}/)`
      : c.detected.kind === "docusaurus"
        ? ` (${c.detected.packageManager} run build → ${c.detected.publishDir}/)`
        : c.detected.kind === "jekyll"
          ? ` → ${c.detected.publishDir}/`
          : "";
  return `${c.detected.kind} at ${loc}${extra}`;
}

function findSiteCandidates(cwd: string): SiteCandidate[] {
  const results: SiteCandidate[] = [];
  for (const sub of SCAN_DIRS) {
    const abs = sub ? join(cwd, sub) : cwd;
    if (sub && !existsSync(abs)) continue;
    const detected = detectAt(abs, sub);
    if (detected) results.push({ dir: sub, detected });
  }
  return results;
}

/** Classify a single directory. Returns null if nothing site-shaped lives there. */
function detectAt(absDir: string, subPath: string): Detected | null {
  // Jekyll first — clearest signal (Gemfile + _config.yml).
  if (existsSync(join(absDir, "Gemfile")) && existsSync(join(absDir, "_config.yml"))) {
    return {
      kind: "jekyll",
      publishDir: subPath ? `${subPath}/_site` : "_site",
      workDir: subPath,
    };
  }

  // Docusaurus before generic node-build — output dir is fixed (`build/`)
  // and the workflow needs Pages-aware tweaks (cache key, baseUrl) the
  // generic flow doesn't apply.
  const docusaurusConfig = ["docusaurus.config.ts", "docusaurus.config.js", "docusaurus.config.mjs"]
    .map((f) => join(absDir, f))
    .find((p) => existsSync(p));
  if (docusaurusConfig && existsSync(join(absDir, "package.json"))) {
    return {
      kind: "docusaurus",
      publishDir: subPath ? `${subPath}/build` : "build",
      packageManager: detectPackageManager(absDir),
      buildScript: "build",
      workDir: subPath,
    };
  }

  // Node build: package.json with a "build" script.
  const pkgPath = join(absDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
        private?: boolean;
        workspaces?: unknown;
      };
      const buildCmd = pkg.scripts?.build;
      // Skip workspace roots (they typically fan out to children, not
      // build a deployable site themselves). Heuristic: `workspaces` in
      // package.json (npm/yarn/bun) or a `pnpm-workspace.yaml` sibling.
      // User can still pick the root manually via promptManualSite.
      const isWorkspaceRoot =
        pkg.workspaces !== undefined || existsSync(join(absDir, "pnpm-workspace.yaml"));
      if (buildCmd && !isWorkspaceRoot) {
        const outDir = guessNodeOutDir(buildCmd);
        return {
          kind: "node-build",
          publishDir: subPath ? `${subPath}/${outDir}` : outDir,
          packageManager: detectPackageManager(absDir),
          buildScript: "build",
          workDir: subPath,
        };
      }
    } catch {
      // fall through
    }
  }

  // Plain static: index.html.
  if (existsSync(join(absDir, "index.html"))) {
    return {
      kind: "static",
      publishDir: subPath || ".",
      workDir: subPath,
    };
  }

  return null;
}

function detectPackageManager(cwd: string): "pnpm" | "npm" | "yarn" | "bun" {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

/** Best-guess output folder from a typical build script. Users confirm it. */
function guessNodeOutDir(buildCmd: string): string {
  if (buildCmd.includes("astro")) return "dist";
  if (buildCmd.includes("next")) return "out"; // requires `output: "export"`
  if (buildCmd.includes("vite")) return "dist";
  if (buildCmd.includes("react-scripts")) return "build";
  return "dist";
}

async function confirmProjectShape(detected: Detected): Promise<Detected> {
  // Jekyll always builds to _site, Docusaurus to build/ — nothing to ask.
  if (detected.kind === "jekyll" || detected.kind === "docusaurus") return detected;

  const publishDir = await input({
    message: "Folder to publish (relative to repo root):",
    default: detected.publishDir,
  });
  return { ...detected, publishDir };
}

/** Manual fallback when nothing was auto-detected. */
async function promptManualSite(cwd: string): Promise<Detected> {
  const kind = await select<SiteKind>({
    message: "What kind of site is this?",
    choices: [
      { name: "static — plain HTML, no build step", value: "static" },
      { name: "node-build — package.json with a `build` script", value: "node-build" },
      { name: "docusaurus — docs site built with Docusaurus 3", value: "docusaurus" },
      { name: "jekyll", value: "jekyll" },
    ],
  });

  const workDir = await input({
    message: "Site lives in (relative to repo root, '.' for root):",
    default: ".",
  });
  const normWorkDir = workDir === "." ? "" : workDir;

  if (kind === "jekyll") {
    return {
      kind,
      publishDir: normWorkDir ? `${normWorkDir}/_site` : "_site",
      workDir: normWorkDir,
    };
  }

  if (kind === "docusaurus") {
    return {
      kind,
      publishDir: normWorkDir ? `${normWorkDir}/build` : "build",
      packageManager: detectPackageManager(normWorkDir ? join(cwd, normWorkDir) : cwd),
      buildScript: "build",
      workDir: normWorkDir,
    };
  }

  if (kind === "static") {
    return { kind, publishDir: normWorkDir || ".", workDir: normWorkDir };
  }

  // node-build
  const publishDir = await input({
    message: "Build output folder (relative to repo root):",
    default: normWorkDir ? `${normWorkDir}/dist` : "dist",
  });
  return {
    kind,
    publishDir,
    packageManager: detectPackageManager(normWorkDir ? join(cwd, normWorkDir) : cwd),
    buildScript: "build",
    workDir: normWorkDir,
  };
}

// ---------------------------------------------------------------------------
// Domain prompt
// ---------------------------------------------------------------------------

async function promptDomain(): Promise<string | null> {
  const wantCustom = await confirm({
    message: "Use a custom domain?",
    default: false,
  });
  if (!wantCustom) return null;
  return input({
    message: "Domain (e.g. sprites.example.com or example.com):",
    validate: validateDomain,
  });
}

// ---------------------------------------------------------------------------
// GitHub Pages API
// ---------------------------------------------------------------------------

async function enablePages(repo: RepoInfo): Promise<void> {
  // POST creates. If Pages is already enabled, GitHub returns 409 — fall
  // back to PUT so build_type=workflow lands either way.
  const res = await exec(
    "gh",
    ["api", "-X", "POST", `repos/${repo.fullName}/pages`, "-f", "build_type=workflow"],
    { silent: true, spinner: "Enabling GitHub Pages..." },
  );
  if (res.exitCode === 0) return;
  if (res.stderr.includes("409") || res.stdout.includes("already")) {
    const put = await exec(
      "gh",
      ["api", "-X", "PUT", `repos/${repo.fullName}/pages`, "-f", "build_type=workflow"],
      { silent: true, spinner: "Pages already enabled — ensuring workflow build type..." },
    );
    if (put.exitCode !== 0) {
      throw new Error(`Couldn't set Pages build type: ${put.stderr.trim()}`);
    }
    return;
  }
  throw new Error(`Couldn't enable Pages: ${res.stderr.trim() || res.stdout.trim()}`);
}

async function setPagesCname(repo: RepoInfo, domain: string): Promise<void> {
  // If the cname is already correct but no cert exists, GitHub is stuck
  // (most often because an earlier run set the cname before DNS was live,
  // so the validation+cert flow ran against missing DNS and never retried).
  // Bounce the cname — clear, then re-set — to force a fresh validation
  // pass now that DNS is in place. Idempotent on the happy path: if a cert
  // is already issued we skip the bounce entirely.
  const current = await getPagesInfo(repo);
  const stuck = current?.cname === domain && !current?.https_certificate;
  if (stuck) {
    await exec("gh", ["api", "-X", "PUT", `repos/${repo.fullName}/pages`, "-f", "cname="], {
      silent: true,
      spinner: "Resetting Pages CNAME to retry cert provisioning...",
    });
    await sleep(2000);
  }

  const res = await exec(
    "gh",
    ["api", "-X", "PUT", `repos/${repo.fullName}/pages`, "-f", `cname=${domain}`],
    { silent: true, spinner: `Registering ${domain} with Pages...` },
  );
  if (res.exitCode !== 0) {
    // Non-fatal: DNS might still not be visible to GitHub yet.
    console.log(
      chalk.yellow(
        `  ⚠ Couldn't set Pages CNAME to ${domain} (${res.stderr.trim()}).\n    Set it manually in Settings → Pages once DNS resolves.`,
      ),
    );
  }
}

interface PagesInfo {
  cname: string | null;
  https_enforced: boolean;
  https_certificate?: { state: string };
}

async function getPagesInfo(repo: RepoInfo): Promise<PagesInfo | null> {
  const res = await exec("gh", ["api", `repos/${repo.fullName}/pages`], { silent: true });
  if (res.exitCode !== 0) return null;
  try {
    return JSON.parse(res.stdout) as PagesInfo;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTPS provisioning
// ---------------------------------------------------------------------------

/**
 * Wait for `domain` to resolve to one of GitHub's Pages IPs. Important when
 * we just wrote DNS records via API — GitHub validates the cname by hitting
 * authoritative DNS, and Cloudflare propagation is usually a few seconds
 * but can briefly lag. Bounded wait; on timeout we proceed anyway.
 */
async function waitForDnsResolves(domain: string, timeoutMs = 60_000): Promise<boolean> {
  const githubIps = new Set(GITHUB_APEX_A);
  const spinner = ora(`Waiting for DNS for ${domain} to resolve to GitHub...`).start();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ips = await resolve4(domain);
      if (ips.some((ip) => githubIps.has(ip))) {
        spinner.succeed(`DNS resolves: ${domain} → ${ips[0]}`);
        return true;
      }
    } catch {
      // ENOTFOUND / SERVFAIL — keep polling.
    }
    await sleep(3000);
  }
  spinner.warn(`DNS for ${domain} hasn't propagated yet — continuing anyway`);
  return false;
}

/**
 * Drive GitHub's HTTPS state machine to completion: poll until the Let's
 * Encrypt cert is `issued`, then flip `https_enforced=true` so http://
 * redirects to https://. Pre-existing fully-configured sites short-circuit
 * on the first poll.
 *
 * If the user added DNS records manually we don't know when they'll land,
 * so we skip the wait and print the finishing commands instead of blocking
 * the CLI for what could be hours.
 */
async function provisionHttps(repo: RepoInfo, autoDns: boolean): Promise<void> {
  if (!autoDns) {
    console.log(
      chalk.dim(
        `\n  Once your DNS records resolve, GitHub will provision an HTTPS cert (usually <5 min).`,
      ),
    );
    console.log(chalk.dim(`  Check:  gh api repos/${repo.fullName}/pages | jq .https_certificate`));
    console.log(
      chalk.dim(`  Enforce: gh api -X PUT repos/${repo.fullName}/pages -F https_enforced=true`),
    );
    return;
  }

  const issued = await waitForCertIssued(repo);
  if (!issued) {
    console.log(
      chalk.yellow(
        `\n  ⚠ HTTPS cert wasn't issued within the wait window — leaving https_enforced off.`,
      ),
    );
    console.log(chalk.dim(`  Check:  gh api repos/${repo.fullName}/pages | jq .https_certificate`));
    console.log(
      chalk.dim(`  Enforce: gh api -X PUT repos/${repo.fullName}/pages -F https_enforced=true`),
    );
    return;
  }

  const info = await getPagesInfo(repo);
  if (info?.https_enforced) {
    console.log(chalk.dim("  HTTPS already enforced."));
    return;
  }

  const res = await exec(
    "gh",
    ["api", "-X", "PUT", `repos/${repo.fullName}/pages`, "-F", "https_enforced=true"],
    { silent: true, spinner: "Enabling Enforce HTTPS..." },
  );
  if (res.exitCode !== 0) {
    console.log(
      chalk.yellow(
        `  ⚠ Couldn't enable HTTPS enforcement: ${res.stderr.trim() || res.stdout.trim()}`,
      ),
    );
    console.log(
      chalk.dim(`    Run later: gh api -X PUT repos/${repo.fullName}/pages -F https_enforced=true`),
    );
  }
}

async function waitForCertIssued(repo: RepoInfo, timeoutMs = 5 * 60_000): Promise<boolean> {
  const spinner = ora("Waiting for GitHub to provision the HTTPS certificate...").start();
  const start = Date.now();
  let lastState = "pending";
  while (Date.now() - start < timeoutMs) {
    const info = await getPagesInfo(repo);
    const state = info?.https_certificate?.state;
    if (state) lastState = state;
    if (state === "issued" || state === "approved") {
      spinner.succeed(`HTTPS certificate ${state}`);
      return true;
    }
    spinner.text = `Waiting for HTTPS certificate (state: ${lastState})...`;
    await sleep(15_000);
  }
  spinner.warn(`HTTPS cert not ready after ${Math.round(timeoutMs / 1000)}s (last: ${lastState})`);
  return false;
}

// ---------------------------------------------------------------------------
// Workflow + CNAME file
// ---------------------------------------------------------------------------

function writeWorkflow(cwd: string, repo: RepoInfo, d: Detected): void {
  const workflowsDir = join(cwd, ".github", "workflows");
  mkdirSync(workflowsDir, { recursive: true });

  // Don't overwrite any existing Pages-deploying workflow. Looking for
  // `actions/deploy-pages` in every workflow file catches our own
  // gh-pages.yml as well as hand-written ones (e.g. docs.yml).
  const existing = findExistingPagesWorkflow(workflowsDir);
  if (existing) {
    console.log(
      chalk.yellow(
        `  ⚠ Existing Pages workflow found at .github/workflows/${existing} — leaving it untouched.\n    Delete it and re-run if you want a fresh ${WORKFLOW_FILENAME}.`,
      ),
    );
    return;
  }

  const outPath = join(workflowsDir, WORKFLOW_FILENAME);
  writeFileSync(outPath, renderWorkflow(repo, d));
  console.log(chalk.green(`  ✓ Wrote .github/workflows/${WORKFLOW_FILENAME}`));
}

function findExistingPagesWorkflow(workflowsDir: string): string | null {
  if (!existsSync(workflowsDir)) return null;
  const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  for (const f of files) {
    const contents = readFileSync(join(workflowsDir, f), "utf8");
    if (contents.includes("actions/deploy-pages")) return f;
  }
  return null;
}

function renderWorkflow(repo: RepoInfo, d: Detected): string {
  const branch = repo.defaultBranch;
  const header = `name: Deploy to GitHub Pages

on:
  push:
    branches: [${branch}]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;

  const tail = `      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ${d.publishDir}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
`;

  if (d.kind === "static") {
    return `${header}${tail}`;
  }

  if (d.kind === "jekyll") {
    const wdLine = d.workDir ? `\n          working-directory: ${d.workDir}` : "";
    const jekyllWd = d.workDir ? `\n        working-directory: ${d.workDir}` : "";
    return `${header}      - uses: ruby/setup-ruby@v1
        with:
          ruby-version: "3.2"
          bundler-cache: true${wdLine}
      - uses: actions/configure-pages@v5
        id: pages
      - name: Build with Jekyll
        run: bundle exec jekyll build --baseurl "\${{ steps.pages.outputs.base_path }}"${jekyllWd}
        env:
          JEKYLL_ENV: production
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ${d.publishDir}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
`;
  }

  // node-build or docusaurus — both install + build via a node package
  // manager. Docusaurus differs only in step labels and the implicit
  // publishDir = `build/` (set by detectAt).
  const pm = d.packageManager ?? "npm";
  const installCmd = pm === "npm" ? "npm ci" : `${pm} install --frozen-lockfile`;
  const buildCmd = `${pm} run ${d.buildScript ?? "build"}`;
  const wd = d.workDir ? `\n        working-directory: ${d.workDir}` : "";
  const buildLabel = d.kind === "docusaurus" ? "Build with Docusaurus" : "Build";
  const nodeSetup =
    pm === "pnpm"
      ? `      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm${d.workDir ? `\n          cache-dependency-path: ${d.workDir}/pnpm-lock.yaml` : ""}`
      : pm === "yarn"
        ? `      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: yarn${d.workDir ? `\n          cache-dependency-path: ${d.workDir}/yarn.lock` : ""}`
        : pm === "bun"
          ? `      - uses: oven-sh/setup-bun@v2`
          : `      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm${d.workDir ? `\n          cache-dependency-path: ${d.workDir}/package-lock.json` : ""}`;

  return `${header}${nodeSetup}
      - name: Install dependencies
        run: ${installCmd}${wd}
      - name: ${buildLabel}
        run: ${buildCmd}${wd}
${tail}`;
}

function writeCnameFile(cwd: string, d: Detected, domain: string): void {
  // CNAME lives at the root of the *published* content so GitHub serves
  // it from the built site. Location depends on kind + workDir.
  //   - jekyll / static: source dir (Jekyll copies it into _site; static
  //     publishes the source dir directly).
  //   - docusaurus: `<workDir>/static/` — Docusaurus copies static/* verbatim into build/.
  //   - node-build: prefer `<workDir>/public/` (Vite/CRA/Astro copy that
  //     verbatim into the build output). Fall back to the build dir root.
  const siteDir = d.workDir ? join(cwd, d.workDir) : cwd;
  let target: string;

  if (d.kind === "docusaurus") {
    const staticDir = join(siteDir, "static");
    if (existsSync(staticDir)) {
      target = join(staticDir, "CNAME");
    } else {
      target = join(siteDir, "CNAME");
      console.log(
        chalk.yellow(
          `  ⚠ No static/ folder in ${d.workDir || "repo root"}. Wrote CNAME there — Docusaurus normally copies static/ into build/.`,
        ),
      );
    }
  } else if (d.kind === "node-build") {
    const publicDir = join(siteDir, "public");
    if (existsSync(publicDir)) {
      target = join(publicDir, "CNAME");
    } else {
      target = join(siteDir, "CNAME");
      console.log(
        chalk.yellow(
          `  ⚠ No public/ folder in ${d.workDir || "repo root"}. Wrote CNAME there — make sure your build copies it into ${d.publishDir}/.`,
        ),
      );
    }
  } else {
    target = join(siteDir, "CNAME");
  }

  writeFileSync(target, `${domain}\n`);
  console.log(chalk.green(`  ✓ Wrote ${target.slice(cwd.length + 1)}`));
}

// ---------------------------------------------------------------------------
// DNS wiring
// ---------------------------------------------------------------------------

async function configureDns(domain: string): Promise<{ wired: boolean }> {
  const { baseDomain, subdomain } = parseDomain(domain);
  const isApex = subdomain === "";
  const ghUser = await getGitHubUser();
  const target = `${ghUser}.github.io`;

  let dns = await getDnsConfig();
  if (!dns) {
    const wantConfigure = await confirm({
      message: "No DNS provider configured. Configure one now?",
      default: true,
    });
    if (wantConfigure) dns = await ensureDns();
  }

  if (!dns) {
    printManualDnsRecords(baseDomain, subdomain, target, isApex);
    return { wired: false };
  }

  if (!dns.apiToken) {
    console.log(chalk.yellow("  ⚠ Cloudflare token missing from keychain."));
    printManualDnsRecords(baseDomain, subdomain, target, isApex);
    return { wired: false };
  }
  return configureCloudflareDns(dns.apiToken, baseDomain, subdomain, target, isApex);
}

async function getGitHubUser(): Promise<string> {
  const res = await exec("gh", ["api", "user", "--jq", ".login"], { silent: true });
  if (res.exitCode !== 0) {
    throw new Error("Couldn't resolve the GitHub user via `gh api user`.");
  }
  return res.stdout.trim();
}

function printManualDnsRecords(
  baseDomain: string,
  subdomain: string,
  target: string,
  isApex: boolean,
): void {
  console.log(chalk.bold("\n  Add these DNS records at your provider:\n"));
  if (isApex) {
    for (const ip of GITHUB_APEX_A) {
      console.log(chalk.dim(`    A    @    ${ip}`));
    }
  } else {
    console.log(chalk.dim(`    CNAME ${subdomain} ${target}`));
  }
  console.log(chalk.dim(`\n  Zone: ${baseDomain}\n`));
}

async function configureCloudflareDns(
  token: string,
  baseDomain: string,
  subdomain: string,
  target: string,
  isApex: boolean,
): Promise<{ wired: boolean }> {
  const api = new CloudflareApi({ token });
  const zone = await api.getZoneByName(baseDomain);
  if (!zone) {
    console.log(
      chalk.yellow(
        `  ⚠ No Cloudflare zone found for ${baseDomain}. Falling back to manual records.`,
      ),
    );
    printManualDnsRecords(baseDomain, subdomain, target, isApex);
    return { wired: false };
  }
  const recordName = isApex ? baseDomain : `${subdomain}.${baseDomain}`;

  // GitHub Pages apex needs A records for all four IPs (round-robin
  // redundancy). For a subdomain, one CNAME to the github.io target
  // is enough. Both flavours run with proxied=false because Cloudflare's
  // orange cloud breaks GitHub Pages' Let's Encrypt cert issuance.
  const records: Array<{ type: "A" | "CNAME"; content: string }> = isApex
    ? GITHUB_APEX_A.map((ip) => ({ type: "A", content: ip }))
    : [{ type: "CNAME", content: target }];

  for (const rec of records) {
    const result = await api.upsertRecord(zone.id, {
      type: rec.type,
      name: recordName,
      content: rec.content,
      proxied: false,
    });
    const status = result.created ? "created" : result.updated ? "updated" : "already set";
    const line = `    ${rec.type} ${recordName} → ${rec.content} (${status})`;
    console.log(
      result.created || result.updated ? chalk.green(`✓ ${line.trimStart()}`) : chalk.dim(line),
    );
  }
  return { wired: true };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(repo: RepoInfo, d: Detected, domain: string | null): void {
  console.log(chalk.bold("\n  ── Done ───────────────────────────────────────────────────\n"));
  const url = domain ? `https://${domain}` : `https://${repo.owner}.github.io/${repo.repo}/`;
  console.log(`  Site:      ${chalk.cyan(url)}`);
  console.log(`  Branch:    ${chalk.dim(repo.defaultBranch)} → triggers ${WORKFLOW_FILENAME}`);
  console.log(`  Publish:   ${chalk.dim(d.publishDir + "/")}`);
  if (d.workDir) {
    console.log(`  Source:    ${chalk.dim(d.workDir + "/")}`);
  }
  if (domain) {
    console.log(chalk.yellow(`\n  First-time DNS propagation can take a few minutes.`));
    console.log(
      chalk.dim(
        `  Once it resolves, GitHub will provision a cert automatically (Settings → Pages).`,
      ),
    );
  }
  console.log(
    chalk.yellow(
      `\n  Next: commit & push the new workflow (and CNAME file) to ${repo.defaultBranch}.\n`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

interface UndoOptions {
  dryRun: boolean;
  yes: boolean;
}

interface UndoPlan {
  pagesEnabled: boolean;
  cname: string | null;
  workflowPath: string | null;
  cnamePaths: string[];
  cloudflare: {
    /** When false we either have no Cloudflare token or no matching zone. */
    available: boolean;
    zoneId?: string;
    baseDomain?: string;
    records: Array<{ id: string; type: string; name: string; content: string }>;
  };
}

/**
 * Reverse what `hatchkit gh-pages` did: disables Pages, deletes the
 * Cloudflare records it created, removes the workflow file, removes any
 * CNAME files matching the registered domain. Idempotent — safe to run
 * even if some pieces are already gone.
 */
export async function runPagesUndo(cwd: string, opts: UndoOptions): Promise<void> {
  console.log(chalk.bold("\n  ── hatchkit gh-pages --undo ───────────────────────────────\n"));

  const repo = await detectRepo(cwd);
  console.log(chalk.dim(`  Repo:  ${repo.fullName}`));

  const plan = await buildUndoPlan(cwd, repo);
  if (!isAnythingToUndo(plan)) {
    console.log(
      chalk.dim("\n  Nothing to undo — no Pages config, workflow, or CNAME files found.\n"),
    );
    return;
  }

  printUndoPlan(plan);

  if (opts.dryRun) {
    console.log(chalk.dim("\n  --dry-run set, nothing changed.\n"));
    return;
  }

  if (!opts.yes) {
    const ok = await confirm({
      message: "Proceed with the steps above?",
      default: false,
    });
    if (!ok) {
      console.log(chalk.dim("\n  Aborted — nothing changed.\n"));
      return;
    }
  }

  await executeUndo(repo, plan);

  console.log(chalk.bold("\n  ── Done ───────────────────────────────────────────────────\n"));
  if (plan.cname) {
    console.log(
      chalk.dim(
        `  DNS at other providers (registrar caches, AAAA records, etc.) may need manual cleanup.\n`,
      ),
    );
  }
}

async function buildUndoPlan(cwd: string, repo: RepoInfo): Promise<UndoPlan> {
  const info = await getPagesInfo(repo);
  const cname = info?.cname ?? null;

  // Workflow: only the one we write. Hand-written Pages workflows
  // (e.g. docs.yml) belong to the user — don't touch them.
  const wfPath = join(cwd, ".github", "workflows", WORKFLOW_FILENAME);
  const workflowPath = existsSync(wfPath) ? wfPath : null;

  // CNAME files: scan the spots `writeCnameFile` could have written.
  // Only flag files whose content matches the registered cname so we
  // never delete a CNAME the user wrote for some other purpose.
  const cnamePaths = cname ? findCnameFiles(cwd, cname) : [];

  // Cloudflare records: present only if a cname was registered AND
  // we have a Cloudflare token AND the zone is in this account.
  const cloudflare: UndoPlan["cloudflare"] = { available: false, records: [] };
  if (cname) {
    const dns = await getDnsConfig();
    if (dns?.apiToken) {
      const { baseDomain, subdomain } = parseDomain(cname);
      const recordName = subdomain === "" ? baseDomain : `${subdomain}.${baseDomain}`;
      const api = new CloudflareApi({ token: dns.apiToken });
      const zone = await api.getZoneByName(baseDomain);
      if (zone) {
        const ghUser = await getGitHubUser().catch(() => "");
        const target = ghUser ? `${ghUser}.github.io` : "";
        const all = await api.findRecordsByName(zone.id, recordName);
        // Only delete records that match what hatchkit could plausibly
        // have written: A records pointing at GitHub's Pages IPs, or a
        // CNAME pointing at <user>.github.io. Anything else stays.
        const records = all.filter(
          (r) =>
            (r.type === "A" && GITHUB_APEX_A.includes(r.content)) ||
            (r.type === "CNAME" && target && r.content === target),
        );
        cloudflare.available = true;
        cloudflare.zoneId = zone.id;
        cloudflare.baseDomain = baseDomain;
        cloudflare.records = records.map((r) => ({
          id: r.id,
          type: r.type,
          name: r.name,
          content: r.content,
        }));
      }
    }
  }

  return {
    pagesEnabled: info !== null,
    cname,
    workflowPath,
    cnamePaths,
    cloudflare,
  };
}

function isAnythingToUndo(plan: UndoPlan): boolean {
  return (
    plan.pagesEnabled ||
    plan.workflowPath !== null ||
    plan.cnamePaths.length > 0 ||
    plan.cloudflare.records.length > 0
  );
}

function printUndoPlan(plan: UndoPlan): void {
  console.log(chalk.bold("\n  Will undo:\n"));
  if (plan.pagesEnabled) {
    const suffix = plan.cname ? ` (cname: ${plan.cname})` : "";
    console.log(chalk.yellow(`    • Disable GitHub Pages${suffix}`));
  }
  for (const rec of plan.cloudflare.records) {
    console.log(chalk.yellow(`    • Delete Cloudflare ${rec.type} ${rec.name} → ${rec.content}`));
  }
  if (plan.workflowPath) {
    console.log(chalk.yellow(`    • Delete ${relPath(plan.workflowPath)}`));
  }
  for (const p of plan.cnamePaths) {
    console.log(chalk.yellow(`    • Delete ${relPath(p)}`));
  }
  if (plan.cname && !plan.cloudflare.available) {
    console.log(
      chalk.dim(
        `\n  (Cloudflare records for ${plan.cname} can't be auto-deleted — no token / zone not in this account.\n   Remove them manually at your DNS provider.)`,
      ),
    );
  }
}

async function executeUndo(repo: RepoInfo, plan: UndoPlan): Promise<void> {
  if (plan.pagesEnabled) {
    const res = await exec("gh", ["api", "-X", "DELETE", `repos/${repo.fullName}/pages`], {
      silent: true,
      spinner: "Disabling GitHub Pages...",
    });
    if (res.exitCode !== 0) {
      console.log(
        chalk.yellow(`  ⚠ Couldn't disable Pages: ${res.stderr.trim() || res.stdout.trim()}`),
      );
    }
  }

  if (plan.cloudflare.records.length > 0 && plan.cloudflare.zoneId) {
    const dns = await getDnsConfig();
    if (dns?.apiToken) {
      const api = new CloudflareApi({ token: dns.apiToken });
      for (const rec of plan.cloudflare.records) {
        const result = await api.deleteRecord(plan.cloudflare.zoneId, rec.id);
        const tag = result === "deleted" ? chalk.green("✓") : chalk.dim("—");
        console.log(`  ${tag} Cloudflare ${rec.type} ${rec.name} → ${rec.content} (${result})`);
      }
    }
  }

  if (plan.workflowPath) {
    try {
      unlinkSync(plan.workflowPath);
      console.log(chalk.green(`  ✓ Removed ${relPath(plan.workflowPath)}`));
    } catch (err) {
      console.log(
        chalk.yellow(
          `  ⚠ Couldn't remove ${relPath(plan.workflowPath)}: ${(err as Error).message}`,
        ),
      );
    }
  }

  for (const p of plan.cnamePaths) {
    try {
      unlinkSync(p);
      console.log(chalk.green(`  ✓ Removed ${relPath(p)}`));
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ Couldn't remove ${relPath(p)}: ${(err as Error).message}`));
    }
  }
}

/**
 * Look for `CNAME` files in the places `writeCnameFile` could have put
 * one, in the current working dir and each candidate scan dir. Only
 * returns files whose content matches `expected` (trimmed, case-insensitive)
 * so we never delete an unrelated CNAME file.
 */
function findCnameFiles(cwd: string, expected: string): string[] {
  const target = expected.trim().toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();

  const bases = ["", ...SCAN_DIRS.filter((d) => d !== "")];
  for (const base of bases) {
    const baseAbs = base ? join(cwd, base) : cwd;
    if (base && !existsSync(baseAbs)) continue;
    for (const sub of ["", "public", "static"]) {
      const subAbs = sub ? join(baseAbs, sub) : baseAbs;
      const candidate = join(subAbs, "CNAME");
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (!existsSync(candidate)) continue;
      try {
        const content = readFileSync(candidate, "utf8").trim().toLowerCase();
        if (content === target) out.push(candidate);
      } catch {
        // unreadable — skip
      }
    }
  }
  return out;
}

function relPath(p: string): string {
  const cwd = process.cwd();
  return p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
}
