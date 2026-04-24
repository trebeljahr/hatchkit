import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { confirm, input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { ensureDns, getDnsConfig } from "../config.js";
import { exec } from "../utils/exec.js";
import { parseDomain, validateDomain } from "../utils/validate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What kind of site lives in a folder — determines the build workflow. */
type SiteKind = "static" | "node-build" | "jekyll";

interface Detected {
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
  console.log(chalk.dim(`  Repo:  ${repo.fullName} (${repo.private ? "private" : "public"})`));
  if (repo.private) {
    console.log(
      chalk.yellow(
        "  ⚠ Private repos need a paid GitHub plan (Pro/Team/Enterprise) for Pages.\n    Continuing anyway — will fail at API call if unsupported.",
      ),
    );
  }

  // 2. Pick a site. Auto-confirm when there's one obvious candidate;
  //    ask when zero or many. Also let the user override the detected
  //    publish folder before we commit to writing anything.
  const confirmed = await pickSite(cwd);

  // 3. Custom domain (optional).
  const domain = await promptDomain();

  // 4. Enable Pages via GitHub API.
  await enablePages(repo);

  // 5. Write the workflow — unless the repo already has a Pages-deploying
  //    workflow (ours or otherwise). Avoids clobbering an existing setup.
  writeWorkflow(cwd, repo, confirmed);

  // 6. CNAME file — only when a custom domain is chosen.
  if (domain) writeCnameFile(cwd, confirmed, domain);

  // 7. Pages CNAME + DNS wiring.
  if (domain) {
    await setPagesCname(repo, domain);
    await configureDns(domain);
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
  // Jekyll always builds to _site — nothing to ask.
  if (detected.kind === "jekyll") return detected;

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
  const res = await exec(
    "gh",
    ["api", "-X", "PUT", `repos/${repo.fullName}/pages`, "-f", `cname=${domain}`],
    { silent: true, spinner: `Registering ${domain} with Pages...` },
  );
  if (res.exitCode !== 0) {
    // Non-fatal: DNS might not be in place yet.
    console.log(
      chalk.yellow(
        `  ⚠ Couldn't set Pages CNAME to ${domain} (${res.stderr.trim()}).\n    Set it manually in Settings → Pages once DNS resolves.`,
      ),
    );
  }
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

  // node-build
  const pm = d.packageManager ?? "npm";
  const installCmd = pm === "npm" ? "npm ci" : `${pm} install --frozen-lockfile`;
  const buildCmd = `${pm} run ${d.buildScript ?? "build"}`;
  const wd = d.workDir ? `\n        working-directory: ${d.workDir}` : "";
  const nodeSetup =
    pm === "pnpm"
      ? `      - uses: pnpm/action-setup@v4
        with:
          version: 9
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
      - name: Build
        run: ${buildCmd}${wd}
${tail}`;
}

function writeCnameFile(cwd: string, d: Detected, domain: string): void {
  // CNAME lives at the root of the *published* content so GitHub serves
  // it from the built site. Location depends on kind + workDir.
  //   - jekyll / static: source dir (Jekyll copies it into _site; static
  //     publishes the source dir directly).
  //   - node-build: prefer `<workDir>/public/` (Vite/CRA/Astro copy that
  //     verbatim into the build output). Fall back to the build dir root.
  const siteDir = d.workDir ? join(cwd, d.workDir) : cwd;
  let target: string;

  if (d.kind === "node-build") {
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

async function configureDns(domain: string): Promise<void> {
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

  if (!dns || dns.provider === "manual") {
    printManualDnsRecords(baseDomain, subdomain, target, isApex);
    return;
  }

  if (dns.provider === "cloudflare") {
    if (!dns.apiToken) {
      console.log(chalk.yellow("  ⚠ Cloudflare token missing from keychain."));
      printManualDnsRecords(baseDomain, subdomain, target, isApex);
      return;
    }
    await configureCloudflareDns(dns.apiToken, baseDomain, subdomain, target, isApex);
    return;
  }

  // INWX auto-wiring isn't implemented — XML-RPC + rarely used for Pages.
  console.log(
    chalk.dim("  INWX auto-configure isn't implemented for Pages — showing manual records:"),
  );
  printManualDnsRecords(baseDomain, subdomain, target, isApex);
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

interface CfZone {
  id: string;
  name: string;
}
interface CfResp<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

async function cfApi<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json()) as CfResp<T>;
  if (!data.success) {
    throw new Error(
      `Cloudflare API ${path} failed: ${data.errors.map((e) => `${e.code} ${e.message}`).join(", ")}`,
    );
  }
  return data.result;
}

async function configureCloudflareDns(
  token: string,
  baseDomain: string,
  subdomain: string,
  target: string,
  isApex: boolean,
): Promise<void> {
  const zones = await cfApi<CfZone[]>(token, `/zones?name=${encodeURIComponent(baseDomain)}`);
  if (zones.length === 0) {
    console.log(
      chalk.yellow(
        `  ⚠ No Cloudflare zone found for ${baseDomain}. Falling back to manual records.`,
      ),
    );
    printManualDnsRecords(baseDomain, subdomain, target, isApex);
    return;
  }
  const zone = zones[0];
  const recordName = isApex ? baseDomain : `${subdomain}.${baseDomain}`;

  const records = isApex
    ? GITHUB_APEX_A.map((ip) => ({ type: "A", name: recordName, content: ip, proxied: false }))
    : [{ type: "CNAME", name: recordName, content: target, proxied: false }];

  for (const rec of records) {
    const existing = await cfApi<Array<{ id: string; content: string }>>(
      token,
      `/zones/${zone.id}/dns_records?type=${rec.type}&name=${encodeURIComponent(rec.name)}`,
    );
    const match = existing.find((r) => r.content === rec.content);
    if (match) {
      console.log(chalk.dim(`    ${rec.type} ${rec.name} → ${rec.content} (already set)`));
      continue;
    }
    // A different record with the same name+type — update in place to
    // keep the zone tidy.
    const stale = existing[0];
    if (stale) {
      await cfApi(token, `/zones/${zone.id}/dns_records/${stale.id}`, {
        method: "PUT",
        body: rec,
      });
      console.log(chalk.green(`    ✓ ${rec.type} ${rec.name} → ${rec.content} (updated)`));
    } else {
      await cfApi(token, `/zones/${zone.id}/dns_records`, { method: "POST", body: rec });
      console.log(chalk.green(`    ✓ ${rec.type} ${rec.name} → ${rec.content} (created)`));
    }
  }
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
