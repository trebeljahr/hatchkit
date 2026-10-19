/*
 * `hatchkit audit cloudflare` — command surface for audit/cloudflare.ts.
 *
 * Reads Cloudflare with the read-only audit token only: env
 * `HATCHKIT_CLOUDFLARE_AUDIT_TOKEN`, else keychain `cloudflare:audit`.
 * It never falls back to the operator token. `accept`/`forget` write the
 * local config; `publish` writes one GitHub Actions variable.
 */
import { readFileSync } from "node:fs";
import chalk from "chalk";
import { getConfiguredCloudflareAccountId } from "../config.js";
import { exec } from "../utils/exec.js";
import { SECRET_KEYS, getSecret, setSecret } from "../utils/secrets.js";
import { getCliVersion } from "../utils/version.js";
import {
  type AuditFinding,
  type CloudflareAuditReport,
  type CloudflareExpected,
  CloudflareReader,
  type FetchLike,
  auditFailed,
  collectCloudflareSnapshot,
  diffCloudflareAccount,
  parseExpected,
} from "./cloudflare.js";
import {
  EXPECTED_VARIABLE,
  acceptInventory,
  buildLocalExpected,
  getAuditRepo,
  setAuditRepo,
  updateAccepted,
} from "./expected.js";

export const AUDIT_USAGE = `Usage:
  hatchkit audit cloudflare [--json | --markdown] [--hours <n>] [--expected <file>] [--account <id>]
  hatchkit audit cloudflare accept <kind>:<value>[=<note>]… | --inventory
  hatchkit audit cloudflare forget <kind>:<value>…
  hatchkit audit cloudflare publish [--repo <owner/repo>] [--dry-run]
  hatchkit audit cloudflare workflow [--version <hatchkit version>]
  hatchkit audit cloudflare set-token

audit cloudflare lists what is on the Cloudflare account and reports what
hatchkit did not create, so a leaked operator token is noticed within a day:
  - account and user API tokens hatchkit has no record of (matched by id)
  - audit log entries of the last --hours (default 36) made by the operator
    token outside a recorded hatchkit run, by an unknown token, by the Global
    API Key, or by an OAuth app nobody allowed
  - Workers, R2 buckets, zones, Email Routing destinations and rules, members
    and OAuth clients nobody accepted
It reads with its own read-only token (env HATCHKIT_CLOUDFLARE_AUDIT_TOKEN or
keychain cloudflare:audit, stored by set-token), never the operator token, and
changes nothing on Cloudflare. Exits 1 on an alert or a check it could not run.

The expected state comes from this machine (CI-token records, run ledgers,
local .hatchkit.json files, accepted entries, operator run windows), or from
--expected / env HATCHKIT_CLOUDFLARE_EXPECTED (the scheduled GitHub Action).

accept   keeps something: token:<id>, operator:<id>, worker:, bucket:, zone:,
         email:, member:, oauth-client:, oauth-app:. --inventory accepts every
         current Worker, bucket, zone, destination, member and OAuth client
         (never tokens). Local config only.
publish  writes the expected state to the repo variable ${EXPECTED_VARIABLE}
         with gh and remembers --repo. hatchkit then republishes on its own
         after each run that used the operator token.
workflow prints the GitHub Actions workflow for that private repo.`;

const AUDIT_TOKEN_ENV = "HATCHKIT_CLOUDFLARE_AUDIT_TOKEN";
const EXPECTED_ENV = "HATCHKIT_CLOUDFLARE_EXPECTED";
const WORKFLOW_FILE = "cloudflare-audit.yml";
/** A daily run looks back 36 h: GitHub starts scheduled runs late at
 *  times, and a gap between two runs' windows would go unread. */
const DEFAULT_HOURS = 36;
const WATCHDOG_MAX_AGE_MS = 36 * 60 * 60 * 1000;

/** Strip control bytes: names on the account are attacker-controlled.
 *  Newlines and tabs too (a forged "✓ … nothing unexpected" line), and
 *  bidi and line-separator characters that reorder or split what is shown. */
export const printable = (text: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes are what we strip
  text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "?");

/** Inline Markdown that cannot open links, images, HTML or table cells. */
const md = (text: string): string =>
  printable(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // `:` and `.` too, so GFM does not autolink https://… or www.… names.
    .replace(/[\\`*_{}[\]()#+!|~:.=-]/g, (c) => `\\${c}`);

export interface AuditRunDeps {
  fetch?: FetchLike;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  /** Last scheduled run of the workflow, for the watchdog. */
  lastWorkflowRun?: (repo: string) => Promise<{ createdAt: string; conclusion?: string } | null>;
}

async function auditToken(env: NodeJS.ProcessEnv): Promise<string> {
  const fromEnv = env[AUDIT_TOKEN_ENV]?.trim();
  if (fromEnv) return fromEnv;
  let stored: string | null = null;
  try {
    stored = await getSecret(SECRET_KEYS.cloudflareAuditToken);
  } catch (err) {
    throw Object.assign(new Error(`Could not read the audit token: ${(err as Error).message}`), {
      hint: [`Set ${AUDIT_TOKEN_ENV}, or run hatchkit audit cloudflare set-token interactively.`],
    });
  }
  if (!stored) {
    throw Object.assign(new Error("No Cloudflare audit token."), {
      hint: [
        "Create the read-only user token hatchkit-audit (grants: hatchkit-human-tasks.md),",
        `then run hatchkit audit cloudflare set-token, or set ${AUDIT_TOKEN_ENV}.`,
        "The operator token is never used for this check.",
      ],
    });
  }
  return stored;
}

function loadExpected(
  expectedFile: string | undefined,
  env: NodeJS.ProcessEnv,
  now: Date,
): { expected: CloudflareExpected; local: boolean } {
  if (expectedFile) {
    return {
      expected: parseExpected(readFileSync(expectedFile, "utf-8"), expectedFile),
      local: false,
    };
  }
  const fromEnv = env[EXPECTED_ENV]?.trim();
  if (fromEnv) return { expected: parseExpected(fromEnv, EXPECTED_ENV), local: false };
  if (env.GITHUB_ACTIONS === "true") {
    // An empty variable must not turn into "this runner's empty config".
    throw new Error(
      `${EXPECTED_ENV} is empty. Run hatchkit audit cloudflare publish on the laptop.`,
    );
  }
  return { expected: buildLocalExpected({ now }), local: true };
}

async function defaultLastWorkflowRun(
  repo: string,
): Promise<{ createdAt: string; conclusion?: string } | null> {
  const res = await exec(
    "gh",
    [
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      WORKFLOW_FILE,
      "--event",
      "schedule",
      "--limit",
      "1",
      "--json",
      "createdAt,conclusion",
    ],
    { silent: true },
  );
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `gh exited ${res.exitCode}`);
  const runs = JSON.parse(res.stdout || "[]") as Array<{ createdAt: string; conclusion?: string }>;
  return runs[0] ?? null;
}

/** The laptop watches the Action: no recent run means nobody is watching. */
async function watchdogFinding(
  repo: string,
  now: Date,
  deps: AuditRunDeps,
): Promise<AuditFinding | null> {
  try {
    const last = await (deps.lastWorkflowRun ?? defaultLastWorkflowRun)(repo);
    const age = last ? now.getTime() - Date.parse(last.createdAt) : Number.POSITIVE_INFINITY;
    if (age > WATCHDOG_MAX_AGE_MS) {
      return {
        severity: "alert",
        check: "watchdog",
        subject: `${repo} ${WORKFLOW_FILE}`,
        detail: last
          ? `last scheduled run ${last.createdAt}, more than 36 h ago`
          : "the workflow has never run",
        hint: "Check the workflow is enabled (Actions tab) and its secret is set.",
      };
    }
    // A red scheduled run is an alert here too: it may be the check
    // failing to run, which the laptop must not report as clean.
    return last?.conclusion && last.conclusion !== "success"
      ? {
          severity: "alert",
          check: "watchdog",
          subject: `${repo} ${WORKFLOW_FILE}`,
          detail: `last run ${last.createdAt} ended ${last.conclusion}`,
        }
      : null;
  } catch (err) {
    return {
      severity: "info",
      check: "watchdog",
      subject: `${repo} ${WORKFLOW_FILE}`,
      detail: `could not read the last run: ${(err as Error).message}`,
    };
  }
}

export async function runCloudflareAudit(
  opts: { hours?: number; expectedFile?: string; accountId?: string },
  deps: AuditRunDeps = {},
): Promise<CloudflareAuditReport> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const { expected, local } = loadExpected(opts.expectedFile, env, now);
  const accountId = opts.accountId ?? (expected.accountId || getConfiguredCloudflareAccountId());
  if (!accountId || !/^[0-9a-f]{32}$/i.test(accountId)) {
    throw new Error(
      "No Cloudflare account id: pass --account <id> or run hatchkit config add cloudflare.",
    );
  }
  const token = await auditToken(env);
  const since = new Date(now.getTime() - (opts.hours ?? DEFAULT_HOURS) * 60 * 60 * 1000);
  const snapshot = await collectCloudflareSnapshot({
    reader: new CloudflareReader(token, deps.fetch),
    accountId,
    since,
    before: now,
  });
  const report = diffCloudflareAccount({
    snapshot,
    expected: { ...expected, accountId },
    now,
    since,
  });
  const repo = local ? getAuditRepo() : undefined;
  if (repo) {
    const finding = await watchdogFinding(repo, now, deps);
    if (finding) {
      report.findings.push(finding);
      report.summary[finding.severity === "alert" ? "alerts" : "info"]++;
      report.findings.sort((x, y) =>
        x.severity === y.severity ? 0 : x.severity === "alert" ? -1 : 1,
      );
    }
  }
  return report;
}

export function renderAuditHuman(report: CloudflareAuditReport): string {
  const lines: string[] = [];
  lines.push(
    chalk.bold(
      `Cloudflare audit — account ${report.accountId}, ${report.window.since} → ${report.window.before}`,
    ),
  );
  for (const check of report.checks) {
    const icon =
      check.status === "ok"
        ? chalk.green("✓")
        : check.status === "skipped"
          ? chalk.dim("-")
          : chalk.red("✗");
    lines.push(`  ${icon} ${check.check} — ${printable(check.detail)}`);
  }
  for (const f of report.findings) {
    const tag = f.severity === "alert" ? chalk.red("ALERT") : chalk.dim("info ");
    lines.push(`  ${tag} [${f.check}] ${printable(f.subject)} — ${printable(f.detail)}`);
    if (f.hint) lines.push(chalk.dim(`        → ${printable(f.hint)}`));
  }
  lines.push(
    auditFailed(report)
      ? chalk.red(`${report.summary.alerts} alert(s), ${report.summary.errors} check(s) failed.`)
      : chalk.green("Nothing unexpected."),
  );
  return lines.join("\n");
}

/** For the GitHub job summary. Every account-sourced string is escaped. */
export function renderAuditMarkdown(report: CloudflareAuditReport): string {
  const skipped = report.checks.filter((c) => c.status === "skipped").length;
  const lines = [
    `## Cloudflare audit: ${auditFailed(report) ? "ALERT" : "all clear"}${skipped ? ` (${skipped} check skipped)` : ""}`,
    "",
    `Account \`${md(report.accountId)}\`, ${md(report.window.since)} to ${md(report.window.before)}.`,
    "",
    "| Check | Status | Detail |",
    "| --- | --- | --- |",
    ...report.checks.map((c) => `| ${c.check} | ${c.status} | ${md(c.detail)} |`),
  ];
  if (report.findings.length) {
    lines.push("", "| Severity | Check | Subject | Detail |", "| --- | --- | --- | --- |");
    for (const f of report.findings) {
      const detail = f.hint ? `${f.detail} → ${f.hint}` : f.detail;
      lines.push(`| ${f.severity} | ${f.check} | ${md(f.subject)} | ${md(detail)} |`);
    }
  }
  lines.push(
    "",
    "Incident runbook: ai-work-notes projects/hatchkit/cloudflare-daily-audit-design.md.",
  );
  return lines.join("\n");
}

export function renderAuditWorkflow(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) throw new Error(`Not a version: ${version}`);
  return `# Daily Cloudflare audit (hatchkit audit cloudflare). Fails — and GitHub
# mails the repo owner — when the account holds something hatchkit did not
# create, or when the check cannot run. Keep this repo private.
#   secret   CLOUDFLARE_AUDIT_TOKEN        read-only user token hatchkit-audit
#   variable ${EXPECTED_VARIABLE}  hatchkit audit cloudflare publish
name: cloudflare-audit
on:
  schedule:
    - cron: "17 6 * * *"
  workflow_dispatch:
permissions: {}
concurrency:
  group: cloudflare-audit
jobs:
  audit:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      - name: Audit the Cloudflare account
        env:
          HATCHKIT_CLOUDFLARE_AUDIT_TOKEN: \${{ secrets.CLOUDFLARE_AUDIT_TOKEN }}
          HATCHKIT_CLOUDFLARE_EXPECTED: \${{ vars.${EXPECTED_VARIABLE} }}
          HATCHKIT_KEYCHAIN_ACCESS: deny
          HATCHKIT_CONF_DIR: \${{ runner.temp }}/hatchkit
          NO_COLOR: "1"
        run: |
          set -o pipefail
          npx -y hatchkit@${version} audit cloudflare --markdown | tee -a "$GITHUB_STEP_SUMMARY"
`;
}

function takeValue(rest: string[], flag: string): string {
  const value = rest.shift();
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.\n\n${AUDIT_USAGE}`);
  return value;
}

async function publishExpected(repo: string | undefined, dryRun: boolean, json: boolean) {
  const target = repo ?? getAuditRepo();
  if (!target)
    throw new Error("No repo yet: hatchkit audit cloudflare publish --repo <owner/repo>");
  const expected = buildLocalExpected({ now: new Date() });
  if (!expected.accountId)
    throw new Error("No Cloudflare account id in config: hatchkit config add cloudflare.");
  const body = JSON.stringify(expected);
  if (!dryRun) {
    const res = await exec(
      "gh",
      ["variable", "set", EXPECTED_VARIABLE, "--repo", target, "--body", body],
      {
        silent: true,
      },
    );
    if (res.exitCode !== 0)
      throw new Error(`gh variable set failed: ${res.stderr.trim() || res.stdout.trim()}`);
    if (repo) setAuditRepo(repo);
  }
  const summary = {
    repo: target,
    variable: EXPECTED_VARIABLE,
    dryRun,
    tokens: expected.tokens.length,
    workers: expected.workers.length,
    buckets: expected.buckets.length,
    zones: expected.zones.length,
    emailDestinations: expected.emailDestinations.length,
    runs: expected.runs.length,
    operatorTokenId: expected.operatorTokenId ?? null,
    bytes: body.length,
  };
  if (json) console.log(JSON.stringify(dryRun ? { ...summary, expected } : summary, null, 2));
  else {
    console.log(
      `${dryRun ? "Would publish" : "Published"} ${EXPECTED_VARIABLE} to ${target} (${body.length} bytes).`,
    );
    if (!expected.operatorTokenId) {
      console.log(
        chalk.yellow("  No operator token id yet: hatchkit audit cloudflare accept operator:<id>"),
      );
    }
  }
}

async function storeAuditToken(deps: AuditRunDeps): Promise<void> {
  const { confirmPastedSecret } = await import("../config.js");
  const token = await confirmPastedSecret("hatchkit-audit token (read-only user token)");
  const reader = new CloudflareReader(token, deps.fetch);
  const verified = await reader
    .get<{ id?: string; status?: string }>("/user/tokens/verify")
    .catch((err: Error) => {
      throw new Error(
        `Cloudflare did not accept it as a user token (${err.message}). Create it under My Profile → API Tokens.`,
      );
    });
  if (verified.result?.status !== "active")
    throw new Error(`Token status is ${verified.result?.status}.`);
  await setSecret(SECRET_KEYS.cloudflareAuditToken, token);
  console.log(chalk.green(`Saved as keychain slot ${SECRET_KEYS.cloudflareAuditToken}.`));
}

export async function runAuditCommand(args: string[], deps: AuditRunDeps = {}): Promise<void> {
  if (args[0] !== "cloudflare") throw new Error(AUDIT_USAGE);
  const rest = args.slice(1);
  const action = rest[0] && !rest[0].startsWith("--") ? (rest.shift() as string) : "scan";
  const json = rest.includes("--json");
  const without = (flag: string) => {
    const i = rest.indexOf(flag);
    if (i >= 0) rest.splice(i, 1);
    return i >= 0;
  };
  without("--json");

  if (action === "accept" || action === "forget") {
    const inventory = without("--inventory");
    if (inventory && action === "accept") {
      if (rest.length)
        throw new Error(`accept --inventory takes no other arguments.\n\n${AUDIT_USAGE}`);
      const report = await runCloudflareAudit({}, deps);
      const pick = (check: AuditFinding["check"]) =>
        report.findings
          .filter((f) => f.check === check && f.severity === "alert")
          .map((f) => f.subject);
      const oauth = report.findings
        .filter((f) => f.check === "oauth-clients")
        .map((f) => f.subject.match(/\(([^)]+)\)$/)?.[1])
        .filter((id): id is string => !!id);
      const accepted = acceptInventory({
        workers: pick("workers"),
        buckets: pick("buckets"),
        zones: pick("zones"),
        emailDestinations: pick("email-destinations"),
        members: pick("members").filter((m) => !m.endsWith(":missing")),
        oauthClients: oauth,
      });
      console.log(JSON.stringify({ accepted }, null, 2));
      return;
    }
    if (!rest.length) throw new Error(`${action} needs <kind>:<value>.\n\n${AUDIT_USAGE}`);
    const accepted = updateAccepted(rest, action === "forget");
    console.log(JSON.stringify({ accepted }, null, 2));
    return;
  }

  if (action === "publish") {
    const dryRun = without("--dry-run");
    let repo: string | undefined;
    while (rest.length) {
      const flag = rest.shift() as string;
      if (flag === "--repo" && !repo) repo = takeValue(rest, flag);
      else throw new Error(`Unknown publish option: ${flag}\n\n${AUDIT_USAGE}`);
    }
    await publishExpected(repo, dryRun, json);
    return;
  }

  if (action === "workflow") {
    let version = getCliVersion();
    while (rest.length) {
      const flag = rest.shift() as string;
      if (flag === "--version") version = takeValue(rest, flag);
      else throw new Error(`Unknown workflow option: ${flag}\n\n${AUDIT_USAGE}`);
    }
    process.stdout.write(renderAuditWorkflow(version));
    return;
  }

  if (action === "set-token") {
    if (rest.length) throw new Error(`set-token takes no options.\n\n${AUDIT_USAGE}`);
    await storeAuditToken(deps);
    return;
  }

  if (action !== "scan") throw new Error(AUDIT_USAGE);
  const markdown = without("--markdown");
  if (markdown && json) throw new Error("Pick one of --json and --markdown.");
  const opts: { hours?: number; expectedFile?: string; accountId?: string } = {};
  while (rest.length) {
    const flag = rest.shift() as string;
    if (flag === "--hours" && opts.hours === undefined) {
      const hours = Number(takeValue(rest, flag));
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 90) {
        throw new Error("--hours must be between 0 and 2160.");
      }
      opts.hours = hours;
    } else if (flag === "--expected" && !opts.expectedFile)
      opts.expectedFile = takeValue(rest, flag);
    else if (flag === "--account" && !opts.accountId) opts.accountId = takeValue(rest, flag);
    else throw new Error(`Unknown or repeated audit cloudflare option: ${flag}\n\n${AUDIT_USAGE}`);
  }
  const report = await runCloudflareAudit(opts, deps);
  if (json) console.log(JSON.stringify(report, null, 2));
  else if (markdown) console.log(renderAuditMarkdown(report));
  else console.log(renderAuditHuman(report));
  if (auditFailed(report)) process.exitCode = 1;
}
