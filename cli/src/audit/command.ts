/*
 * `hatchkit audit cloudflare` — command surface for audit/*.
 *
 * The check itself reads Cloudflare with the read-only audit token only:
 * env `HATCHKIT_CLOUDFLARE_AUDIT_TOKEN`, else keychain `cloudflare:audit`.
 * It never falls back to the operator token. `deploy` and `publish` use
 * the operator token (they write the audit Worker and its bucket);
 * `accept`/`forget` write the local config only.
 */
import { readFileSync } from "node:fs";
import chalk from "chalk";
import { getConfiguredCloudflareAccountId } from "../config.js";
import { SECRET_KEYS, getSecret, setSecret } from "../utils/secrets.js";
import {
  type AuditFinding,
  type CloudflareAuditReport,
  type CloudflareExpected,
  CloudflareReader,
  addFindings,
  auditFailed,
  collectCloudflareSnapshot,
  diffCloudflareAccount,
  parseExpected,
  renderAuditText,
} from "./cloudflare.js";
import {
  type DeployDeps,
  auditWorkerWatchdog,
  deployAuditWorker,
  publishExpectedToWorker,
} from "./deploy.js";
import { acceptInventory, buildLocalExpected, getAuditWorker, updateAccepted } from "./expected.js";
import { sendSesTextMail } from "./ses-send.js";
import { AUDIT_CRON } from "./worker.js";

export const AUDIT_USAGE = `Usage:
  hatchkit audit cloudflare [--json] [--hours <n>] [--expected <file>] [--account <id>]
  hatchkit audit cloudflare accept <kind>:<value>[=<note>]… | --inventory
  hatchkit audit cloudflare forget <kind>:<value>…
  hatchkit audit cloudflare deploy --from <address> [--to <address>] [--region <aws region>] [--dry-run]
  hatchkit audit cloudflare publish
  hatchkit audit cloudflare set-token | set-ses-key | test-mail

audit cloudflare lists what is on the Cloudflare account and reports what
hatchkit did not create, so a leaked operator token is noticed within hours:
  - account and user API tokens hatchkit has no record of (by id), disabled too
  - audit log entries of the last --hours (default 36) made by the operator
    token outside a recorded hatchkit run, by an unknown token, by the Global
    API Key, or by an OAuth app nobody allowed
  - Workers, R2 buckets, zones, Email Routing destinations and rules, members
    and OAuth clients nobody accepted
  - with the audit Worker deployed: whether it is still the one hatchkit
    deployed, still scheduled, and ran in the last 8 h
It reads with its own read-only token (env HATCHKIT_CLOUDFLARE_AUDIT_TOKEN or
keychain cloudflare:audit, stored by set-token), never the operator token, and
changes nothing on Cloudflare. Exits 1 on an alert or a check it could not run.

accept   keeps something: token:<id>, operator:<id>, worker:, bucket:, zone:,
         email:, member:, oauth-client:, oauth-app:. --inventory accepts every
         current Worker, bucket, zone, destination, member and OAuth client
         (never tokens). Local config only.
deploy   creates the R2 bucket hatchkit-audit and the Worker hatchkit-audit
         (cron "${AUDIT_CRON}", every 6 h over the last 7 h) with the operator
         token, sets its secrets from the keychain (audit token, HMAC key,
         SES key) and publishes the signed expected state. It mails --to
         (default ricotrebeljahr@gmail.com) through SES only when something
         unexpected happened. --dry-run lists the steps.
publish  re-signs and uploads the expected state. hatchkit also does this,
         with its run window, after every command that used the operator token.
set-ses-key stores the Worker's own SES key (ses:SendEmail, one sender, one
         recipient); test-mail sends one mail with it from this machine.`;

const AUDIT_TOKEN_ENV = "HATCHKIT_CLOUDFLARE_AUDIT_TOKEN";
const EXPECTED_ENV = "HATCHKIT_CLOUDFLARE_EXPECTED";
const DEFAULT_HOURS = 36;
const DEFAULT_MAIL_TO = "ricotrebeljahr@gmail.com";

export interface AuditRunDeps extends DeployDeps {
  env?: NodeJS.ProcessEnv;
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
  return { expected: buildLocalExpected({ now }), local: true };
}

async function optionalSecret(key: string): Promise<string | undefined> {
  try {
    return (await getSecret(key)) ?? undefined;
  } catch {
    return undefined;
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
  const reader = new CloudflareReader(token, deps.fetch);
  const snapshot = await collectCloudflareSnapshot({ reader, accountId, since, before: now });
  const report = diffCloudflareAccount({
    snapshot,
    expected: { ...expected, accountId },
    now,
    since,
  });
  if (local && getAuditWorker()) {
    const hmac = await optionalSecret(SECRET_KEYS.cloudflareAuditHmacKey);
    addFindings(report, await auditWorkerWatchdog(reader, accountId, now, hmac));
  }
  return report;
}

export function renderAuditHuman(report: CloudflareAuditReport): string {
  const text = renderAuditText(report);
  return text
    .split("\n")
    .map((line) =>
      line.startsWith("  ALERT")
        ? chalk.red(line)
        : line.startsWith("  info") || line.startsWith("        →")
          ? chalk.dim(line)
          : line,
    )
    .join("\n");
}

function takeValue(rest: string[], flag: string): string {
  const value = rest.shift();
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.\n\n${AUDIT_USAGE}`);
  return value;
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

async function storeSesKey(): Promise<void> {
  const { confirmPastedSecret } = await import("../config.js");
  const id = await confirmPastedSecret("Access key id of the audit Worker's IAM user");
  if (!/^A[KS]IA[A-Z0-9]{12,}$/.test(id))
    throw new Error("That does not look like an AWS access key id.");
  const secret = await confirmPastedSecret("Its secret access key");
  await setSecret(SECRET_KEYS.cloudflareAuditSesAccessKeyId, id);
  await setSecret(SECRET_KEYS.cloudflareAuditSesSecretAccessKey, secret);
  console.log(chalk.green("Saved. hatchkit audit cloudflare test-mail sends one mail with it."));
}

async function sendTestMail(deps: AuditRunDeps, from?: string, region?: string): Promise<void> {
  const worker = getAuditWorker();
  const mailFrom = from ?? worker?.mailFrom;
  const sesRegion = region ?? worker?.sesRegion;
  if (!mailFrom || !sesRegion)
    throw new Error("test-mail needs --from and --region until the Worker is deployed.");
  const accessKeyId = await getSecret(SECRET_KEYS.cloudflareAuditSesAccessKeyId);
  const secretAccessKey = await getSecret(SECRET_KEYS.cloudflareAuditSesSecretAccessKey);
  if (!accessKeyId || !secretAccessKey)
    throw new Error("No SES key yet: hatchkit audit cloudflare set-ses-key");
  const to = worker?.mailTo ?? DEFAULT_MAIL_TO;
  const sent = await sendSesTextMail({
    credentials: { accessKeyId, secretAccessKey, region: sesRegion },
    from: mailFrom,
    to,
    subject: "hatchkit audit: test mail",
    text: "This is a test from hatchkit audit cloudflare test-mail. The audit Worker sends mail like this only when something unexpected happened on the Cloudflare account.\n",
    fetch: deps.fetch,
  });
  console.log(`Sent to ${to} (SES message ${sent.messageId ?? "?"}).`);
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

  if (action === "deploy") {
    const dryRun = without("--dry-run");
    let from: string | undefined;
    let to = DEFAULT_MAIL_TO;
    let region: string | undefined = getAuditWorker()?.sesRegion;
    while (rest.length) {
      const flag = rest.shift() as string;
      if (flag === "--from") from = takeValue(rest, flag);
      else if (flag === "--to") to = takeValue(rest, flag);
      else if (flag === "--region") region = takeValue(rest, flag);
      else throw new Error(`Unknown deploy option: ${flag}\n\n${AUDIT_USAGE}`);
    }
    from ??= getAuditWorker()?.mailFrom;
    if (!from) throw new Error(`deploy needs --from <a verified SES sender>.\n\n${AUDIT_USAGE}`);
    if (!region) {
      const { getStore } = await import("../config.js");
      region = (getStore().get("providers.ses") as { region?: string } | undefined)?.region;
    }
    if (!region) throw new Error("deploy needs --region (the SES region of the sender).");
    const plan = await deployAuditWorker({ from, to, region, dryRun }, deps);
    if (json) console.log(JSON.stringify({ dryRun, ...plan }, null, 2));
    else {
      console.log(dryRun ? "Would:" : "Done:");
      for (const step of plan.steps) console.log(`  - ${step}`);
    }
    return;
  }

  if (action === "publish") {
    if (rest.length) throw new Error(`publish takes no options.\n\n${AUDIT_USAGE}`);
    const { bytes, worker } = await publishExpectedToWorker(deps);
    console.log(
      `Published the signed expected state to ${worker.bucket}/expected.json (${bytes} bytes).`,
    );
    return;
  }

  if (action === "set-token" || action === "set-ses-key") {
    if (rest.length) throw new Error(`${action} takes no options.\n\n${AUDIT_USAGE}`);
    if (action === "set-token") await storeAuditToken(deps);
    else await storeSesKey();
    return;
  }

  if (action === "test-mail") {
    let from: string | undefined;
    let region: string | undefined;
    while (rest.length) {
      const flag = rest.shift() as string;
      if (flag === "--from") from = takeValue(rest, flag);
      else if (flag === "--region") region = takeValue(rest, flag);
      else throw new Error(`Unknown test-mail option: ${flag}\n\n${AUDIT_USAGE}`);
    }
    await sendTestMail(deps, from, region);
    return;
  }

  if (action !== "scan") throw new Error(AUDIT_USAGE);
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
  else console.log(renderAuditHuman(report));
  if (auditFailed(report)) process.exitCode = 1;
}
