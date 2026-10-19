/*
 * The audit Worker (`hatchkit-audit`). A cron trigger runs it every 6 h
 * (`17 *\/6 * * *`); it audits the account with its own read-only token
 * and mails Rico through SES only when something unexpected happened.
 *
 * Bucket layout (R2 binding AUDIT_BUCKET), every object HMAC-signed
 * (signed-state.ts):
 *   expected.json        what hatchkit expects; written by the laptop
 *   runs/<start>-<pid>   when hatchkit held the operator token; laptop
 *   state/alert.json     fingerprints of the alerts last mailed; Worker
 *   state/last-run.json  when it last ran and what it found; Worker
 *
 * Mail rules: a mail when an alert appears that the last mail did not
 * list, and a reminder when alerts are still open 24 h after the last
 * mail. A run that cannot finish mails too. No all-clear mail.
 *
 * Imports only the other zero-import audit modules: deploy uploads the
 * compiled files as Worker modules side by side.
 */
import {
  type AuditFinding,
  type CloudflareAuditReport,
  CloudflareReader,
  type FetchLike,
  type RunWindow,
  addFindings,
  auditFailed,
  collectCloudflareSnapshot,
  diffCloudflareAccount,
  parseExpected,
  renderAuditText,
} from "./cloudflare.js";
import { sendSesTextMail } from "./ses-send.js";
import { openEnvelope, signEnvelope } from "./signed-state.js";

export const AUDIT_CRON = "17 */6 * * *";
/** 6 h between runs plus 1 h for late starts and audit-log ingest lag. */
export const DEFAULT_WORKER_HOURS = 7;
const RUN_HISTORY_MS = 3 * 24 * 60 * 60 * 1000;
const RUN_DELETE_MS = 7 * 24 * 60 * 60 * 1000;
const REMIND_MS = 24 * 60 * 60 * 1000;

export interface R2ObjectLike {
  key: string;
  uploaded: Date;
}
export interface R2BucketLike {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
  list(opts: { prefix?: string; cursor?: string }): Promise<{
    objects: R2ObjectLike[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<unknown>;
}

export interface AuditWorkerEnv {
  AUDIT_BUCKET: R2BucketLike;
  ACCOUNT_ID: string;
  CLOUDFLARE_AUDIT_TOKEN: string;
  EXPECTED_HMAC_KEY: string;
  SES_ACCESS_KEY_ID: string;
  SES_SECRET_ACCESS_KEY: string;
  SES_REGION: string;
  MAIL_FROM: string;
  MAIL_TO: string;
  AUDIT_HOURS?: string;
}

interface AlertState {
  fingerprints: string[];
  mailedAt?: string;
}

export interface WorkerRunResult {
  report?: CloudflareAuditReport;
  mailed: boolean;
  error?: string;
}

const fingerprint = (f: AuditFinding): string => f.dedupeKey ?? `${f.check}|${f.subject}`;

async function readSigned<T>(
  env: AuditWorkerEnv,
  key: string,
  kind: Parameters<typeof openEnvelope>[1],
) {
  const obj = await env.AUDIT_BUCKET.get(key);
  if (!obj) return null;
  return openEnvelope<T>(env.EXPECTED_HMAC_KEY, kind, await obj.text());
}

async function listAll(bucket: R2BucketLike, prefix: string): Promise<R2ObjectLike[]> {
  const out: R2ObjectLike[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await bucket.list({ prefix, cursor });
    out.push(...page.objects);
    if (!page.truncated || !page.cursor) return out;
    cursor = page.cursor;
  }
  throw new Error(`more than 20 pages under ${prefix}`);
}

/** Verified run windows; a bad signature is a tampering finding. */
async function loadRuns(
  env: AuditWorkerEnv,
  now: Date,
  findings: AuditFinding[],
): Promise<RunWindow[]> {
  const runs: RunWindow[] = [];
  const stale: string[] = [];
  for (const obj of await listAll(env.AUDIT_BUCKET, "runs/")) {
    const age = now.getTime() - new Date(obj.uploaded).getTime();
    if (age > RUN_DELETE_MS) {
      stale.push(obj.key);
      continue;
    }
    if (age > RUN_HISTORY_MS) continue;
    try {
      const run = await readSigned<RunWindow>(env, obj.key, "run");
      if (run && typeof run.start === "string") runs.push({ start: run.start, end: run.end });
    } catch (err) {
      findings.push({
        severity: "alert",
        check: "integrity",
        subject: obj.key,
        detail: `run window with an invalid signature (${(err as Error).message}) — someone else wrote the audit bucket`,
        hint: "Follow the incident runbook; only hatchkit with the audit HMAC key writes there.",
      });
    }
  }
  if (stale.length) await env.AUDIT_BUCKET.delete(stale);
  return runs;
}

async function mail(
  env: AuditWorkerEnv,
  subject: string,
  text: string,
  fetchImpl: FetchLike,
  now: Date,
) {
  await sendSesTextMail({
    credentials: {
      accessKeyId: env.SES_ACCESS_KEY_ID,
      secretAccessKey: env.SES_SECRET_ACCESS_KEY,
      region: env.SES_REGION,
    },
    from: env.MAIL_FROM,
    to: env.MAIL_TO,
    subject,
    text,
    now,
    fetch: fetchImpl,
  });
}

const RUNBOOK =
  "Runbook: revoke hatchkit-cloudflare first, then every unknown token; review the audit log for DNS, Worker, Email Routing and zone-setting changes; rotate the per-Worker CI tokens. Details: ai-work-notes projects/hatchkit/cloudflare-daily-audit-design.md.";

export async function runScheduledAudit(
  env: AuditWorkerEnv,
  now: Date,
  deps: { fetch?: FetchLike } = {},
): Promise<WorkerRunResult> {
  const fetchImpl = deps.fetch ?? fetch;
  let mailed = false;
  try {
    const tamper: AuditFinding[] = [];
    let expectedText: unknown;
    try {
      expectedText = await readSigned<unknown>(env, "expected.json", "expected");
    } catch (err) {
      throw new Error(
        `expected.json does not verify (${(err as Error).message}) — someone else wrote the audit bucket`,
      );
    }
    if (!expectedText)
      throw new Error("expected.json is missing; run hatchkit audit cloudflare publish");
    const expected = parseExpected(JSON.stringify(expectedText), "expected.json");
    if (expected.accountId !== env.ACCOUNT_ID)
      throw new Error("expected.json names another account");
    expected.runs = await loadRuns(env, now, tamper);

    const hours = Number(env.AUDIT_HOURS) > 0 ? Number(env.AUDIT_HOURS) : DEFAULT_WORKER_HOURS;
    const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
    const snapshot = await collectCloudflareSnapshot({
      reader: new CloudflareReader(env.CLOUDFLARE_AUDIT_TOKEN, fetchImpl),
      accountId: env.ACCOUNT_ID,
      since,
      before: now,
    });
    const report = diffCloudflareAccount({ snapshot, expected, now, since });
    addFindings(report, tamper);

    let state: AlertState = { fingerprints: [] };
    try {
      state = (await readSigned<AlertState>(env, "state/alert.json", "alert-state")) ?? state;
    } catch {
      // A forged state must not suppress mail: start over, and say so.
      addFindings(report, [
        {
          severity: "alert",
          check: "integrity",
          subject: "state/alert.json",
          detail: "alert state with an invalid signature — someone else wrote the audit bucket",
        },
      ]);
    }

    const current = [
      ...report.findings.filter((f) => f.severity === "alert").map(fingerprint),
      ...report.checks.filter((c) => c.status === "error").map((c) => `${c.check}|error`),
    ];
    const known = new Set(state.fingerprints);
    const fresh = current.filter((f) => !known.has(f));
    const lastMail = state.mailedAt ? Date.parse(state.mailedAt) : 0;
    const remind = current.length > 0 && now.getTime() - lastMail >= REMIND_MS;
    if (auditFailed(report) && (fresh.length > 0 || remind)) {
      const subject = fresh.length
        ? `hatchkit audit: ${report.summary.alerts} alert(s) on Cloudflare`
        : `hatchkit audit: ${report.summary.alerts} alert(s) still open on Cloudflare`;
      await mail(env, subject, `${renderAuditText(report)}\n\n${RUNBOOK}\n`, fetchImpl, now);
      mailed = true;
      state = { fingerprints: current, mailedAt: now.toISOString() };
    } else if (!auditFailed(report)) {
      // Clean: the same alert coming back later is news again.
      state = { fingerprints: [], mailedAt: state.mailedAt };
    } else {
      state = { fingerprints: current, mailedAt: state.mailedAt };
    }
    await env.AUDIT_BUCKET.put(
      "state/alert.json",
      await signEnvelope(env.EXPECTED_HMAC_KEY, "alert-state", state),
    );
    await env.AUDIT_BUCKET.put(
      "state/last-run.json",
      await signEnvelope(env.EXPECTED_HMAC_KEY, "last-run", {
        at: now.toISOString(),
        alerts: report.summary.alerts,
        errors: report.summary.errors,
        mailed,
      }),
    );
    return { report, mailed };
  } catch (err) {
    const message = (err as Error).message;
    try {
      await mail(
        env,
        "hatchkit audit: the Cloudflare check could not run",
        `The audit Worker stopped before it finished:\n\n  ${message}\n\nA check that cannot run is not an all clear.\n\n${RUNBOOK}\n`,
        fetchImpl,
        now,
      );
      mailed = true;
    } catch {
      // Nothing left to tell; the laptop watchdog sees the stale last run.
    }
    try {
      await env.AUDIT_BUCKET.put(
        "state/last-run.json",
        await signEnvelope(env.EXPECTED_HMAC_KEY, "last-run", {
          at: now.toISOString(),
          error: message,
          mailed,
        }),
      );
    } catch {
      // Same.
    }
    return { mailed, error: message };
  }
}

export default {
  async scheduled(
    controller: { scheduledTime: number },
    env: AuditWorkerEnv,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ): Promise<void> {
    ctx.waitUntil(runScheduledAudit(env, new Date(controller.scheduledTime)));
  },
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
};
