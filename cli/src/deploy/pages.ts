import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { confirm, input } from "@inquirer/prompts";
import chalk from "chalk";
import { ensureDns, getDnsConfig } from "../config.js";
import { exec } from "../utils/exec.js";
import { parseDomain, validateDomain } from "../utils/validate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What kind of site lives in this repo — determines the build workflow. */
type SiteKind = "static" | "node-build" | "jekyll";

interface Detected {
  kind: SiteKind;
  /** Final folder uploaded to Pages. Relative to repo root. */
  publishDir: string;
  /** Package manager for node-build sites. */
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
  /** npm script name used for the build (usually "build"). */
  buildScript?: string;
  /** Working directory for the build (e.g. "docs" for a Jekyll subsite). */
  workDir?: string;
}

interface RepoInfo {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

// GitHub's apex A records (https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)
const GITHUB_APEX_A = ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"];

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function runPagesSetup(cwd: string): Promise<void> {
  console.log(chalk.bold("\n  ── hatchkit pages ─────────────────────────────────────────\n"));

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

  // 2. Project type — detected defaults, confirmed interactively.
  const detected = detectProject(cwd);
  console.log(
    chalk.dim(
      `  Type:  ${detected.kind}${detected.workDir ? ` (in ${detected.workDir}/)` : ""}, publish ${detected.publishDir}/`,
    ),
  );
  const confirmed = await confirmProjectShape(detected);

  // 3. Custom domain (optional).
  const domain = await promptDomain();

  // 4. Enable Pages via GitHub API.
  await enablePages(repo);

  // 5. Write the workflow (and any adjacent bits — CNAME, base path).
  writeWorkflow(cwd, repo, confirmed);
  if (domain) writeCnameFile(cwd, confirmed, domain);

  // 6. Wire DNS if we can, else print manual records.
  if (domain) {
    await setPagesCname(repo, domain);
    await configureDns(domain);
  }

  // 7. Summary.
  printSummary(repo, confirmed, domain);
}

// ---------------------------------------------------------------------------
// Repo detection
// ---------------------------------------------------------------------------

async function detectRepo(cwd: string): Promise<RepoInfo> {
  const res = await exec(
    "gh",
    ["repo", "view", "--json", "nameWithOwner,url,visibility,defaultBranchRef,owner,name"],
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
// Project detection
// ---------------------------------------------------------------------------

function detectProject(cwd: string): Detected {
  // Jekyll: Gemfile + _config.yml, either at root or under docs/
  for (const sub of ["", "docs"]) {
    const dir = sub ? join(cwd, sub) : cwd;
    if (existsSync(join(dir, "Gemfile")) && existsSync(join(dir, "_config.yml"))) {
      return {
        kind: "jekyll",
        publishDir: sub ? `${sub}/_site` : "_site",
        workDir: sub || undefined,
      };
    }
  }

  // Node build: package.json with a "build" script
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      const buildScript = scripts.build ? "build" : undefined;
      if (buildScript) {
        const pm = detectPackageManager(cwd);
        return {
          kind: "node-build",
          publishDir: guessNodeOutDir(scripts.build ?? ""),
          packageManager: pm,
          buildScript,
        };
      }
    } catch {
      // fall through — treat as static
    }
  }

  // Static: index.html at root counts.
  return {
    kind: "static",
    publishDir: ".",
  };
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
  if (buildCmd.includes("next")) return "out"; // only valid with `next export`
  if (buildCmd.includes("vite")) return "dist";
  if (buildCmd.includes("react-scripts")) return "build";
  return "dist";
}

async function confirmProjectShape(detected: Detected): Promise<Detected> {
  // For obvious cases (jekyll, static with no package.json) skip the back-and-forth.
  if (detected.kind === "jekyll") return detected;

  const publishDir = await input({
    message: "Folder to publish (relative to repo root):",
    default: detected.publishDir,
  });
  return { ...detected, publishDir };
}

// ---------------------------------------------------------------------------
// Domain prompts
// ---------------------------------------------------------------------------

async function promptDomain(): Promise<string | null> {
  const wantCustom = await confirm({
    message: "Use a custom domain?",
    default: false,
  });
  if (!wantCustom) return null;

  const domain = await input({
    message: "Domain (e.g. sprites.example.com or example.com):",
    validate: validateDomain,
  });
  return domain;
}

// ---------------------------------------------------------------------------
// GitHub Pages API
// ---------------------------------------------------------------------------

async function enablePages(repo: RepoInfo): Promise<void> {
  // POST is the "create" call. If already enabled, GitHub returns 409 —
  // treat that as success since the desired state matches.
  const res = await exec(
    "gh",
    ["api", "-X", "POST", `repos/${repo.fullName}/pages`, "-f", "build_type=workflow"],
    { silent: true, spinner: "Enabling GitHub Pages..." },
  );
  if (res.exitCode === 0) return;
  if (res.stderr.includes("409") || res.stdout.includes("already")) {
    // Already enabled — make sure build_type is workflow.
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
    // Non-fatal: DNS might not be in place yet. Surface the error but
    // don't abort — the rest of the setup is still useful.
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
  const outPath = join(workflowsDir, "pages.yml");
  if (existsSync(outPath)) {
    console.log(
      chalk.yellow(
        `  ⚠ .github/workflows/pages.yml already exists — leaving it untouched.\n    Delete it and re-run if you want a fresh one.`,
      ),
    );
    return;
  }
  const yaml = renderWorkflow(repo, d);
  writeFileSync(outPath, yaml);
  console.log(chalk.green(`  ✓ Wrote .github/workflows/pages.yml`));
}

function renderWorkflow(repo: RepoInfo, d: Detected): string {
  const branch = repo.defaultBranch;
  const head = `name: Deploy to GitHub Pages

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
    return `${head}${tail}`;
  }

  if (d.kind === "jekyll") {
    const wd = d.workDir ? `\n        working-directory: ${d.workDir}` : "";
    const buildPath = d.workDir ? `${d.workDir}/_site` : "_site";
    return `name: Deploy to GitHub Pages

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
      - uses: ruby/setup-ruby@v1
        with:
          ruby-version: "3.2"
          bundler-cache: true${wd ? `\n          working-directory: ${d.workDir}` : ""}
      - uses: actions/configure-pages@v5
        id: pages
      - name: Build with Jekyll
        run: bundle exec jekyll build --baseurl "\${{ steps.pages.outputs.base_path }}"${wd}
        env:
          JEKYLL_ENV: production
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ${buildPath}

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
  const nodeSetup =
    pm === "pnpm"
      ? `      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm`
      : pm === "yarn"
        ? `      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: yarn`
        : pm === "bun"
          ? `      - uses: oven-sh/setup-bun@v2`
          : `      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm`;

  return `${head}${nodeSetup}
      - name: Install dependencies
        run: ${installCmd}
      - name: Build
        run: ${buildCmd}
${tail}`;
}

function writeCnameFile(cwd: string, d: Detected, domain: string): void {
  // CNAME lives at the root of the *published* content so GitHub serves
  // it from the built site. For static sites that's the repo root; for
  // Jekyll it's the source folder (Jekyll copies it into _site). For
  // node builds, drop it in `public/` if it exists, else at the root of
  // the build output which the user will need to wire manually.
  let target: string;
  if (d.kind === "jekyll") {
    target = d.workDir ? join(cwd, d.workDir, "CNAME") : join(cwd, "CNAME");
  } else if (d.kind === "static") {
    target = join(cwd, "CNAME");
  } else {
    // node-build: prefer `public/` (Vite, CRA, Astro all copy it verbatim).
    const publicDir = join(cwd, "public");
    if (existsSync(publicDir)) {
      target = join(publicDir, "CNAME");
    } else {
      target = join(cwd, "CNAME");
      console.log(
        chalk.yellow(
          `  ⚠ No public/ folder found. Wrote CNAME at the repo root — make sure your build copies it into ${d.publishDir}/.`,
        ),
      );
    }
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

  // Figure out what DNS provider to use. If not configured, give the
  // user a chance to configure one, else fall back to manual records.
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

  // INWX: no automatic wiring yet — it's XML-RPC and rarely hosts
  // GitHub Pages sites in practice. Fall back to manual instructions.
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
  // Resolve the zone id from the base domain.
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
    // Look for an existing record with the same name+type so we update
    // rather than stacking duplicates on repeat runs.
    const existing = await cfApi<Array<{ id: string; content: string }>>(
      token,
      `/zones/${zone.id}/dns_records?type=${rec.type}&name=${encodeURIComponent(rec.name)}`,
    );
    const match = existing.find((r) => r.content === rec.content);
    if (match) {
      console.log(chalk.dim(`    ${rec.type} ${rec.name} → ${rec.content} (already set)`));
      continue;
    }
    // If there's an existing record for the same name+type with a
    // different content, update the first one in place (apex A) or
    // update the CNAME. Keeps the zone tidy.
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
  console.log(`  Branch:    ${chalk.dim(repo.defaultBranch)} → triggers pages.yml`);
  console.log(`  Publish:   ${chalk.dim(d.publishDir + "/")}`);
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
