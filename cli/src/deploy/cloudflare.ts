/*
 * `hatchkit cloudflare` — wire a static repo to Cloudflare Workers
 * Static Assets.
 *
 * Sibling of deploy/pages.ts. The shape is the same: make sure the repo
 * has the files the deploy needs, push the CI secrets, deal with the
 * custom domain, print what happens next. What differs is the domain
 * step, which is deliberately only half-automated — see
 * `attachCustomDomain` below.
 *
 * Encodes the fractal.garden migration (2026-09-28). Cloudflare serves
 * static asset requests for free and unmetered; only Worker script
 * invocations count against the free plan, and a pure static site runs
 * none.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { confirm, input } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import {
  deleteCloudflareDeployTokenRecord,
  ensureCloudflareProvisioner,
  getCloudflareDeployTokenRecords,
  getCloudflareProvisioner,
  getDnsConfig,
  rememberWorkersSubdomain,
} from "../config.js";
import {
  CLOUDFLARE_PUBLISH_DIR,
  CLOUDFLARE_WRANGLER_REL_PATH,
  applyCloudflareMode,
} from "../scaffold/cloudflare-mode.js";
import { type CfDnsRecord, CloudflareApi } from "../utils/cloudflare-api.js";
import { exec } from "../utils/exec.js";
import type { RunLedger } from "../utils/run-ledger.js";
import { parseDomain, validateDomain } from "../utils/validate.js";
import { maskId, workerDeployTokenName } from "./cloudflare-deploy-token.js";
import {
  CLOUDFLARE_SECRET_NAMES,
  ghSecretDelete,
  listRepoSecrets,
  setCloudflareDeploySecrets,
} from "./gh-actions-secrets.js";

interface RepoInfo {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
}

export interface CloudflareSetupResult {
  /** Where the site will be reachable once the first deploy lands. */
  siteUrl: string;
  /** True when hatchkit attached the custom domain itself. False means
   *  the domain is either absent or left to the user (see
   *  `attachCustomDomain`). */
  customDomainAttached: boolean;
}

// ---------------------------------------------------------------------------
// Entrypoints
// ---------------------------------------------------------------------------

export async function runCloudflareSetup(cwd: string): Promise<void> {
  console.log(chalk.bold("\n  ── hatchkit cloudflare ────────────────────────────────────\n"));
  const repo = await detectRepo(cwd);
  console.log(chalk.dim(`  Repo:  ${repo.fullName}`));

  const raw = await input({
    message: "Custom domain (blank to stay on *.workers.dev):",
    default: "",
  });
  const domain = raw.trim() || null;
  if (domain) {
    const err = validateDomain(domain);
    if (err !== true) throw new Error(`Invalid domain: ${err}`);
  }

  await executeCloudflareSetup(cwd, repo, { domain });
}

/** Programmatic entrypoint for `hatchkit create` / `hatchkit adopt`.
 *  Same pipeline, no prompts. */
export async function runCloudflareSetupProgrammatic(
  cwd: string,
  opts: { domain: string | null; workerName?: string; ledger?: RunLedger },
): Promise<CloudflareSetupResult> {
  const repo = await detectRepo(cwd);
  console.log(chalk.dim(`  Repo:  ${repo.fullName}`));
  return executeCloudflareSetup(cwd, repo, opts);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function executeCloudflareSetup(
  cwd: string,
  repo: RepoInfo,
  opts: { domain: string | null; workerName?: string; ledger?: RunLedger },
): Promise<CloudflareSetupResult> {
  // 1. The provisioner. `hatchkit create` has usually already run this
  //    via the provider stepper; `hatchkit cloudflare` in a hand-rolled
  //    repo has not, so prompt here rather than failing. It stays in the
  //    keychain: the repo gets a token minted for its one Worker.
  const prov = await ensureCloudflareProvisioner();
  const api = new CloudflareApi({
    token: prov.token,
    accountId: prov.accountId,
  });

  // 2. Files. A scaffolded project already has them (the create flow
  //    wrote them during the prune); an adopted repo does not.
  //    applyCloudflareMode is idempotent, so calling it twice is fine.
  const workerName = opts.workerName ?? readWorkerName(cwd) ?? repo.repo;
  const modifications: string[] = [];
  applyCloudflareMode(cwd, { workerName, defaultBranch: repo.defaultBranch }, modifications);
  for (const m of modifications) console.log(chalk.dim(`  · ${m}`));

  // 3. The Worker's own deploy token, pushed as the repo's CI secret. A
  //    new project's Worker is created empty first: a per-Worker role
  //    can only name a Worker that exists.
  const pushed = await setCloudflareDeploySecrets({
    projectDir: cwd,
    repoSlug: repo.fullName,
    workerName,
    createWorker: true,
    ledger: opts.ledger,
  });
  if (pushed.worker?.created) {
    console.log(
      chalk.dim(`  · created empty Worker "${workerName}" — the first CI deploy uploads the site`),
    );
  }
  if (!pushed.ok) {
    const retained = pushed.worker?.created ? ` Empty Worker ${workerName} remains for retry.` : "";
    throw new Error((pushed.error ?? "Cloudflare deploy token setup failed") + retained);
  }

  // 4. Custom domain.
  let customDomainAttached = false;
  if (opts.domain) {
    customDomainAttached = await attachCustomDomain({
      api,
      accountId: prov.accountId,
      hostname: opts.domain,
      workerName,
      ledger: opts.ledger,
    });
  }

  let workersSubdomain = prov.workersSubdomain;
  if (!workersSubdomain) {
    workersSubdomain =
      (await api.getWorkersSubdomain(prov.accountId).catch(() => null)) ?? undefined;
    if (workersSubdomain) rememberWorkersSubdomain(prov.accountId, workersSubdomain);
  }
  const previewUrl = workersSubdomain
    ? `https://${workerName}.${workersSubdomain}.workers.dev`
    : `https://${workerName}.<your-subdomain>.workers.dev`;
  const siteUrl = opts.domain && customDomainAttached ? `https://${opts.domain}` : previewUrl;

  printSummary({
    workerName,
    previewUrl,
    domain: opts.domain,
    customDomainAttached,
    branch: repo.defaultBranch,
  });

  return { siteUrl, customDomainAttached };
}

// ---------------------------------------------------------------------------
// Custom domain
// ---------------------------------------------------------------------------

/**
 * Attach `hostname` to the Worker — but only when doing so is safe.
 *
 * Cloudflare manages the DNS record and the certificate for a Worker
 * Custom Domain itself, and refuses to create one over a hostname that
 * already has records it didn't make: `code: 100117`. The only way
 * through is to delete the existing records first, and between that
 * delete and the attach the hostname serves nothing. On a live site
 * that is a self-inflicted outage.
 *
 * So the two cases get different treatment, which is the whole point of
 * this function:
 *
 *   · No records at the hostname — a brand-new project's domain.
 *     Nothing is serving it, there is no window to fall into, and the
 *     attach either works or fails harmlessly. Automated.
 *
 *   · Records already there — a live site being migrated. hatchkit
 *     prints the sequence and the rollback and stops. Deciding when to
 *     take a site down is the user's call, not a CLI's, and the
 *     playbook's advice ("screenshot the records first, do both in one
 *     sitting") is something a human does, not something a flag covers.
 *
 * Returns true only when the domain is actually attached.
 */
async function attachCustomDomain(params: {
  api: CloudflareApi;
  accountId: string;
  hostname: string;
  workerName: string;
  ledger?: RunLedger;
}): Promise<boolean> {
  const { api, accountId, hostname, workerName, ledger } = params;

  const spinner = ora(`Cloudflare: resolving zone for ${hostname}`).start();
  let zone: Awaited<ReturnType<CloudflareApi["resolveZoneForName"]>>;
  try {
    zone = await api.resolveZoneForName(hostname);
  } catch (err) {
    spinner.fail(`Cloudflare: zone lookup failed — ${(err as Error).message}`);
    printManualDomainSteps(hostname, workerName, []);
    return false;
  }
  if (!zone) {
    spinner.fail(`Cloudflare: no zone in this account manages ${hostname}`);
    console.log(
      chalk.dim(
        `  Add ${parseDomain(hostname).baseDomain} to Cloudflare first, then re-run \`hatchkit cloudflare\`.`,
      ),
    );
    return false;
  }
  spinner.succeed(`Cloudflare: zone ${zone.name}`);

  // Already attached? Re-running the command must not look like a
  // failure.
  try {
    const bound = await api.listWorkerCustomDomains(accountId);
    const hit = bound.find((d) => d.hostname === hostname);
    if (hit) {
      console.log(chalk.green(`  ✓ ${hostname} already attached to Worker "${hit.service}"`));
      return true;
    }
  } catch {
    // Non-fatal: fall through to the attach, which will tell us.
  }

  // The deciding read.
  let existing: CfDnsRecord[] = [];
  try {
    existing = await api.findRecordsByName(zone.id, hostname);
  } catch (err) {
    console.log(
      chalk.yellow(`  Couldn't list DNS records for ${hostname}: ${(err as Error).message}`),
    );
    printManualDomainSteps(hostname, workerName, []);
    return false;
  }

  if (existing.length > 0) {
    console.log(
      chalk.yellow(
        `\n  ${hostname} already has ${existing.length} DNS record(s). Not touching them.`,
      ),
    );
    printManualDomainSteps(hostname, workerName, existing);
    return false;
  }

  const attachSpinner = ora(`Cloudflare: attaching ${hostname} to Worker "${workerName}"`).start();
  try {
    const created = await api.attachWorkerCustomDomain({
      accountId,
      zoneId: zone.id,
      hostname,
      service: workerName,
    });
    attachSpinner.succeed(`Cloudflare: ${hostname} → Worker "${workerName}"`);
    ledger?.record({
      kind: "cloudflareWorkerDomain",
      accountId,
      domainId: created.id,
      hostname,
    });
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    attachSpinner.fail(`Cloudflare: attach failed — ${msg}`);
    if (/100117/.test(msg)) {
      console.log(
        chalk.dim(
          "  Cloudflare reports existing DNS records at this hostname even though the\n" +
            "  record listing came back empty — most likely a record was added between\n" +
            "  the two calls, or it lives in a different zone.",
        ),
      );
    }
    printManualDomainSteps(hostname, workerName, existing);
    return false;
  }
}

/** The manual cutover. Printed verbatim so the user can work through it
 *  in one sitting, which is what the downtime window demands. */
function printManualDomainSteps(
  hostname: string,
  workerName: string,
  existing: CfDnsRecord[],
): void {
  console.log(chalk.bold(`\n  Attach ${hostname} by hand:\n`));
  if (existing.length > 0) {
    console.log(chalk.dim("  Records currently at this hostname (screenshot these — they are"));
    console.log(chalk.dim("  your rollback; re-creating them restores the old host in seconds):"));
    for (const r of existing) {
      console.log(
        chalk.dim(
          `    ${r.type.padEnd(6)} ${r.name} → ${r.content}${r.proxied ? " (proxied)" : ""}`,
        ),
      );
    }
    console.log("");
  }
  console.log(
    chalk.dim(
      `    1. Deploy first and click through ${chalk.cyan(`${workerName}.<subdomain>.workers.dev`)}.\n` +
        "       Confirm every route, the 404 page, robots.txt and sitemap.xml.\n" +
        `    2. Check where ${hostname} actually redirects today. An apex that 308s to\n` +
        "       www while every canonical tag claims the apex will break each indexed URL\n" +
        "       if you point the apex straight at the Worker.\n" +
        `    3. Delete the records above in the Cloudflare dashboard.\n` +
        `    4. Workers & Pages → ${workerName} → Settings → Domains & Routes → Add custom\n` +
        `       domain → ${hostname}. Steps 3 and 4 are one sitting: the host serves\n` +
        "       nothing in between.\n" +
        "    5. Verify the cache headers and that the old host's response headers are gone.",
    ),
  );
  console.log("");
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export interface CloudflareUndoOptions {
  dryRun?: boolean;
  yes?: boolean;
}

/**
 * Reverse what `hatchkit cloudflare` did: detach the custom domain and
 * remove the workflow + wrangler config it wrote.
 *
 * Deliberately does NOT delete the Worker itself or its uploaded
 * assets — `wrangler delete` is the user's call, and a detached domain
 * already takes the site off the public hostname. Also does not
 * re-create whatever DNS records the migration replaced; hatchkit never
 * deleted them (it refuses to), so there is nothing of ours to restore.
 */
export async function runCloudflareUndo(cwd: string, opts: CloudflareUndoOptions): Promise<void> {
  console.log(chalk.bold("\n  ── hatchkit cloudflare --undo ─────────────────────────────\n"));
  const repo = await detectRepo(cwd);
  console.log(chalk.dim(`  Repo:  ${repo.fullName}`));

  const workerName = readWorkerName(cwd) ?? repo.repo;
  const prov = await getCloudflareProvisioner();
  const api = prov ? new CloudflareApi({ token: prov.token, accountId: prov.accountId }) : null;

  const files = [
    join(cwd, ".github", "workflows", "deploy.yml"),
    join(cwd, CLOUDFLARE_WRANGLER_REL_PATH),
  ].filter((p) => existsSync(p));

  let domains: Array<{ id: string; hostname: string }> = [];
  let tokens: Array<{ id: string; name: string }> = [];
  if (api && prov) {
    try {
      domains = (await api.listWorkerCustomDomains(prov.accountId))
        .filter((d) => d.service === workerName)
        .map((d) => ({ id: d.id, hostname: d.hostname }));
    } catch (err) {
      console.log(chalk.dim(`  (couldn't list custom domains: ${(err as Error).message})`));
    }
    const record = getCloudflareDeployTokenRecords()[workerName];
    if (record?.accountId === prov.accountId && record.repo === repo.fullName) {
      tokens = [{ id: record.tokenId, name: record.tokenName }];
    }
  }

  const record = getCloudflareDeployTokenRecords()[workerName];
  const secretMetadata = tokens.length ? await listRepoSecrets(repo.fullName) : null;
  const ownsSecrets =
    !!record?.secretUpdatedAt &&
    !!record?.accountSecretUpdatedAt &&
    secretMetadata?.find((secret) => secret.name === "CLOUDFLARE_API_TOKEN")?.updatedAt ===
      record.secretUpdatedAt &&
    secretMetadata?.find((secret) => secret.name === "CLOUDFLARE_ACCOUNT_ID")?.updatedAt ===
      record.accountSecretUpdatedAt;

  if (files.length === 0 && domains.length === 0 && tokens.length === 0) {
    console.log(
      chalk.dim(
        "\n  Nothing to undo — no wrangler config, workflow, custom domain or deploy token.\n",
      ),
    );
    return;
  }

  console.log(chalk.bold("\n  Plan:\n"));
  for (const d of domains) console.log(chalk.dim(`    detach custom domain  ${d.hostname}`));
  for (const t of tokens) {
    console.log(
      chalk.dim(`    revoke deploy token   ${workerDeployTokenName(workerName)} (${maskId(t.id)})`),
    );
  }
  if (ownsSecrets) {
    console.log(chalk.dim(`    delete repo secrets   ${CLOUDFLARE_SECRET_NAMES.join(", ")}`));
  }
  for (const f of files)
    console.log(chalk.dim(`    remove file           ${f.replace(cwd + "/", "")}`));
  console.log(
    chalk.dim(
      `\n    The Worker "${workerName}" and its assets are left in place — delete it with\n` +
        `    \`pnpm dlx wrangler delete\` if you want it gone.`,
    ),
  );

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

  if (api && prov) {
    for (const d of domains) {
      const res = await api.deleteWorkerCustomDomain(prov.accountId, d.id);
      console.log(chalk.dim(`  · ${d.hostname}: ${res}`));
    }
    for (const t of tokens) {
      const res = await api.deleteAccountToken(prov.accountId, t.id);
      console.log(chalk.dim(`  · ${workerDeployTokenName(workerName)} ${maskId(t.id)}: ${res}`));
    }
    if (tokens.length > 0) {
      if (getCloudflareDeployTokenRecords()[workerName])
        deleteCloudflareDeployTokenRecord(workerName);
      for (const name of ownsSecrets ? CLOUDFLARE_SECRET_NAMES : []) {
        const res = await ghSecretDelete(repo.fullName, name).catch(
          (err) => (err as Error).message,
        );
        console.log(chalk.dim(`  · ${name}: ${res}`));
      }
    }
  }
  const { unlinkSync } = await import("node:fs");
  for (const f of files) {
    unlinkSync(f);
    console.log(chalk.dim(`  · removed ${f.replace(cwd + "/", "")}`));
  }
  console.log(chalk.bold("\n  ── Done ───────────────────────────────────────────────────\n"));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function detectRepo(cwd: string): Promise<RepoInfo> {
  const res = await exec(
    "gh",
    ["repo", "view", "--json", "nameWithOwner,defaultBranchRef,owner,name"],
    { cwd, silent: true },
  );
  if (res.exitCode !== 0) {
    throw new Error(
      "Couldn't resolve the GitHub repo for this directory. Make sure you're inside a git repo with an `origin` remote and that `gh auth status` works.",
    );
  }
  const parsed = JSON.parse(res.stdout) as {
    nameWithOwner: string;
    defaultBranchRef: { name: string } | null;
    owner: { login: string };
    name: string;
  };
  return {
    owner: parsed.owner.login,
    repo: parsed.name,
    fullName: parsed.nameWithOwner,
    defaultBranch: parsed.defaultBranchRef?.name ?? "main",
  };
}

/** Pull `name` out of an existing wrangler.jsonc. JSONC, so a real
 *  parse would need a comment-stripping pass; a scoped regex on the
 *  top-level `"name"` key is enough and doesn't add a dependency.
 *  Returns null when the file is absent or the key isn't found. */
export function readWorkerName(projectDir: string): string | null {
  const path = join(projectDir, CLOUDFLARE_WRANGLER_REL_PATH);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const m = raw.match(/^\s*"name"\s*:\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

function printSummary(params: {
  workerName: string;
  previewUrl: string;
  domain: string | null;
  customDomainAttached: boolean;
  branch: string;
}): void {
  console.log(chalk.bold("\n  ── Summary ───────────────────────────────────────────────\n"));
  console.log(`  Worker:    ${chalk.cyan(params.workerName)}`);
  console.log(`  Assets:    ${chalk.dim(CLOUDFLARE_PUBLISH_DIR)}`);
  console.log(`  Preview:   ${chalk.cyan(params.previewUrl)}`);
  if (params.domain) {
    console.log(
      `  Domain:    ${params.customDomainAttached ? chalk.cyan(`https://${params.domain}`) : chalk.yellow(`${params.domain} (attach by hand — see above)`)}`,
    );
  }
  console.log(
    chalk.dim(
      `\n  Push to ${params.branch} to deploy. To try it locally first:\n` +
        "    pnpm build && pnpm dlx wrangler deploy",
    ),
  );
  console.log("");
}

/** True when the Cloudflare DNS provider is configured, which is what
 *  lets hatchkit read the zone's records before deciding whether an
 *  automatic domain attach is safe. Used by doctor. */
export async function hasCloudflareDnsAccess(): Promise<boolean> {
  const dns = await getDnsConfig();
  return !!dns?.apiToken;
}
