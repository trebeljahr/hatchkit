/*
 * Laptop side of the audit Worker: deploy it, publish the signed expected
 * state and run windows to its bucket, and watch that nobody changed it.
 *
 * Writes use the operator token (only Rico's interactive runs have it):
 * the bucket, the Worker script, its secrets and its cron trigger. The
 * watchdog reads with the audit token only.
 *
 * Why a watchdog: the Worker lives on the account it audits, and the
 * operator token holds Workers Admin and R2 Edit. A leaked copy cannot
 * forge the signed state, but it can replace or delete the Worker. Then
 * no mail comes. `hatchkit audit cloudflare` (and so every local run)
 * checks the Worker's deployment id, cron trigger, secrets and last run.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCloudflareProvisioner } from "../config.js";
import { SECRET_KEYS, getSecret, setSecret } from "../utils/secrets.js";
import {
  API_BASE,
  type AuditFinding,
  type CloudflareReader,
  type FetchLike,
  type RunWindow,
} from "./cloudflare.js";
import {
  type AuditWorkerConfig,
  buildLocalExpected,
  getAuditWorker,
  setAuditWorker,
} from "./expected.js";
import { newHmacKey, openEnvelope, signEnvelope } from "./signed-state.js";
import { AUDIT_CRON, DEFAULT_WORKER_HOURS } from "./worker.js";

export const AUDIT_WORKER_NAME = "hatchkit-audit";
export const AUDIT_BUCKET_NAME = "hatchkit-audit";
export const WORKER_MODULES = [
  "worker.js",
  "cloudflare.js",
  "ses-send.js",
  "signed-state.js",
] as const;
export const WORKER_SECRETS = [
  "CLOUDFLARE_AUDIT_TOKEN",
  "EXPECTED_HMAC_KEY",
  "SES_ACCESS_KEY_ID",
  "SES_SECRET_ACCESS_KEY",
] as const;
const COMPATIBILITY_DATE = "2026-10-01";
const TIMEOUT_MS = 30_000;
/** A last run older than this means the cron stopped (6 h interval + slack). */
const LAST_RUN_MAX_AGE_MS = (6 + 2) * 60 * 60 * 1000;

export interface OperatorAccess {
  token: string;
  accountId: string;
}

export interface DeployDeps {
  fetch?: FetchLike;
  operator?: () => Promise<OperatorAccess | null>;
  /** Compiled module source by file name. Default: the files next to this one. */
  readModule?: (name: string) => string;
  now?: () => Date;
}

async function operatorAccess(deps: DeployDeps): Promise<OperatorAccess> {
  const found = deps.operator
    ? await deps.operator()
    : await getCloudflareProvisioner().then((p) =>
        p ? { token: p.token, accountId: p.accountId } : null,
      );
  if (!found?.token || !found.accountId) {
    throw new Error(
      "No Cloudflare operator token: run hatchkit config add cloudflare in your own terminal.",
    );
  }
  return found;
}

function defaultReadModule(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    return readFileSync(join(here, name), "utf-8");
  } catch {
    throw new Error(
      `Compiled Worker module ${name} not found next to ${here}. Deploy from the built CLI (pnpm --filter hatchkit build, or the installed hatchkit).`,
    );
  }
}

async function cf(
  op: OperatorAccess,
  fetchImpl: FetchLike,
  method: string,
  path: string,
  body?: BodyInit,
  contentType?: string,
): Promise<unknown> {
  const res = await fetchImpl(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${op.token}`,
      ...(contentType ? { "Content-Type": contentType } : {}),
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: unknown;
    errors?: Array<{ code: number; message: string }>;
  } | null;
  if (!res.ok || json?.success === false) {
    const why = json?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || res.statusText;
    throw new Error(`Cloudflare ${method} ${path}: HTTP ${res.status} ${why}`);
  }
  return json?.result;
}

async function hmacKeyFromKeychain(create: boolean): Promise<string> {
  const existing = await getSecret(SECRET_KEYS.cloudflareAuditHmacKey);
  if (existing) return existing;
  if (!create)
    throw new Error("No audit HMAC key in the keychain; run hatchkit audit cloudflare deploy.");
  const key = newHmacKey();
  await setSecret(SECRET_KEYS.cloudflareAuditHmacKey, key);
  return key;
}

async function putObject(
  op: OperatorAccess,
  fetchImpl: FetchLike,
  bucket: string,
  key: string,
  body: string,
): Promise<void> {
  await cf(
    op,
    fetchImpl,
    "PUT",
    `/accounts/${op.accountId}/r2/buckets/${bucket}/objects/${key.split("/").map(encodeURIComponent).join("/")}`,
    body,
    "application/json",
  );
}

/** Sign and upload the expected state. Operator token + HMAC key. */
export async function publishExpectedToWorker(
  deps: DeployDeps = {},
): Promise<{ bytes: number; worker: AuditWorkerConfig }> {
  const worker = getAuditWorker();
  if (!worker)
    throw new Error("No audit Worker yet: hatchkit audit cloudflare deploy --from <address>");
  const op = await operatorAccess(deps);
  const expected = buildLocalExpected({ now: (deps.now ?? (() => new Date()))() });
  if (!expected.accountId) expected.accountId = op.accountId;
  if (expected.accountId !== op.accountId) {
    throw new Error(
      `The operator token's account (${op.accountId}) is not the configured one (${expected.accountId}).`,
    );
  }
  const body = await signEnvelope(await hmacKeyFromKeychain(false), "expected", expected);
  await putObject(op, deps.fetch ?? fetch, worker.bucket, "expected.json", body);
  return { bytes: body.length, worker };
}

/** Upload one run window. Used by operator-uses.ts while hatchkit runs. */
export async function uploadRunWindow(
  op: OperatorAccess,
  key: string,
  run: RunWindow,
  deps: { fetch?: FetchLike; hmacKey?: string } = {},
): Promise<void> {
  const worker = getAuditWorker();
  if (!worker) return;
  const hmac = deps.hmacKey ?? (await hmacKeyFromKeychain(false));
  await putObject(
    op,
    deps.fetch ?? fetch,
    worker.bucket,
    key,
    await signEnvelope(hmac, "run", run),
  );
}

export interface DeployOptions {
  from: string;
  to: string;
  region: string;
  dryRun: boolean;
}

export interface DeployPlan {
  worker: string;
  bucket: string;
  cron: string;
  hours: number;
  modules: string[];
  secrets: Array<{ name: string; source: string; present: boolean }>;
  steps: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function deployAuditWorker(
  opts: DeployOptions,
  deps: DeployDeps = {},
): Promise<DeployPlan> {
  if (!EMAIL.test(opts.from) || !EMAIL.test(opts.to))
    throw new Error("--from and --to must be email addresses.");
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(opts.region))
    throw new Error(`Not an AWS region: ${opts.region}`);
  const fetchImpl = deps.fetch ?? fetch;
  const readModule = deps.readModule ?? defaultReadModule;
  const modules = WORKER_MODULES.map((name) => ({ name, source: readModule(name) }));

  const secretSources: Record<(typeof WORKER_SECRETS)[number], string> = {
    CLOUDFLARE_AUDIT_TOKEN: SECRET_KEYS.cloudflareAuditToken,
    EXPECTED_HMAC_KEY: SECRET_KEYS.cloudflareAuditHmacKey,
    SES_ACCESS_KEY_ID: SECRET_KEYS.cloudflareAuditSesAccessKeyId,
    SES_SECRET_ACCESS_KEY: SECRET_KEYS.cloudflareAuditSesSecretAccessKey,
  };
  const secrets: DeployPlan["secrets"] = [];
  const values: Record<string, string> = {};
  for (const name of WORKER_SECRETS) {
    const value =
      name === "EXPECTED_HMAC_KEY" && !opts.dryRun
        ? await hmacKeyFromKeychain(true)
        : await getSecret(secretSources[name]);
    if (value) values[name] = value;
    secrets.push({
      name,
      source: `keychain ${secretSources[name]}`,
      present: !!value || name === "EXPECTED_HMAC_KEY",
    });
  }
  const plan: DeployPlan = {
    worker: AUDIT_WORKER_NAME,
    bucket: AUDIT_BUCKET_NAME,
    cron: AUDIT_CRON,
    hours: DEFAULT_WORKER_HOURS,
    modules: modules.map((m) => m.name),
    secrets,
    steps: [
      `create R2 bucket ${AUDIT_BUCKET_NAME} if missing`,
      `upload Worker ${AUDIT_WORKER_NAME} (${modules.length} modules, R2 binding AUDIT_BUCKET, mail ${opts.from} → ${opts.to} via SES ${opts.region}), keeping its secrets`,
      `set secrets ${WORKER_SECRETS.join(", ")} from the keychain`,
      `set cron trigger "${AUDIT_CRON}"`,
      "publish the signed expected state",
      "record the deployment id for the watchdog",
    ],
  };
  const missing = secrets.filter((s) => !s.present).map((s) => `${s.name} (${s.source})`);
  if (missing.length) {
    throw Object.assign(new Error(`Missing before deploy: ${missing.join(", ")}`), {
      hint: [
        "hatchkit audit cloudflare set-token      stores the read-only Cloudflare token",
        "hatchkit audit cloudflare set-ses-key    stores the Worker's own SES key",
      ],
    });
  }
  if (opts.dryRun) return plan;

  const op = await operatorAccess(deps);
  try {
    await cf(
      op,
      fetchImpl,
      "POST",
      `/accounts/${op.accountId}/r2/buckets`,
      JSON.stringify({ name: AUDIT_BUCKET_NAME }),
      "application/json",
    );
  } catch (err) {
    // 10004: the bucket exists already (a re-deploy).
    if (!/\b10004\b|already exists/i.test((err as Error).message)) throw err;
  }

  const form = new FormData();
  const metadata = {
    main_module: "worker.js",
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [
      { type: "r2_bucket", name: "AUDIT_BUCKET", bucket_name: AUDIT_BUCKET_NAME },
      { type: "plain_text", name: "ACCOUNT_ID", text: op.accountId },
      { type: "plain_text", name: "MAIL_FROM", text: opts.from },
      { type: "plain_text", name: "MAIL_TO", text: opts.to },
      { type: "plain_text", name: "SES_REGION", text: opts.region },
      { type: "plain_text", name: "AUDIT_HOURS", text: String(DEFAULT_WORKER_HOURS) },
    ],
    keep_bindings: ["secret_text"],
  };
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const m of modules) {
    form.append(m.name, new Blob([m.source], { type: "application/javascript+module" }), m.name);
  }
  const script = `/accounts/${op.accountId}/workers/scripts/${AUDIT_WORKER_NAME}`;
  await cf(op, fetchImpl, "PUT", script, form);
  for (const name of WORKER_SECRETS) {
    await cf(
      op,
      fetchImpl,
      "PUT",
      `${script}/secrets`,
      JSON.stringify({ name, text: values[name], type: "secret_text" }),
      "application/json",
    );
  }
  await cf(
    op,
    fetchImpl,
    "PUT",
    `${script}/schedules`,
    JSON.stringify([{ cron: AUDIT_CRON }]),
    "application/json",
  );

  const worker: AuditWorkerConfig = {
    name: AUDIT_WORKER_NAME,
    bucket: AUDIT_BUCKET_NAME,
    mailFrom: opts.from,
    mailTo: opts.to,
    sesRegion: opts.region,
  };
  setAuditWorker(worker);
  await publishExpectedToWorker({ ...deps, operator: async () => op });
  const deployments = (await cf(op, fetchImpl, "GET", `${script}/deployments`)) as {
    deployments?: Array<{ id?: string }>;
  };
  setAuditWorker({
    ...worker,
    deploymentId: deployments?.deployments?.[0]?.id,
    deployedAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
  return plan;
}

/** Local-only: is the Worker still the one hatchkit deployed, and running? */
export async function auditWorkerWatchdog(
  reader: CloudflareReader,
  accountId: string,
  now: Date,
  hmacKey?: string,
): Promise<AuditFinding[]> {
  const worker = getAuditWorker();
  if (!worker) return [];
  const findings: AuditFinding[] = [];
  const alert = (subject: string, detail: string, hint?: string) =>
    findings.push({ severity: "alert", check: "watchdog", subject, detail, hint });
  const script = `/accounts/${accountId}/workers/scripts/${worker.name}`;
  const redeploy =
    "If you did not change it: follow the incident runbook, then hatchkit audit cloudflare deploy.";
  try {
    const deployments = (
      await reader.get<{ deployments?: Array<{ id?: string }> }>(`${script}/deployments`)
    ).result;
    const latest = deployments?.deployments?.[0]?.id;
    if (worker.deploymentId && latest !== worker.deploymentId) {
      alert(
        worker.name,
        `the Worker's deployment is ${latest ?? "gone"}, not the one hatchkit deployed (${worker.deploymentId})`,
        redeploy,
      );
    }
  } catch (err) {
    alert(
      worker.name,
      `could not read the Worker's deployments: ${(err as Error).message}`,
      redeploy,
    );
  }
  try {
    const schedules = (
      await reader.get<{ schedules?: Array<{ cron?: string }> }>(`${script}/schedules`)
    ).result;
    if (!schedules?.schedules?.some((s) => s.cron === AUDIT_CRON)) {
      alert(worker.name, `the cron trigger "${AUDIT_CRON}" is gone`, redeploy);
    }
  } catch (err) {
    alert(worker.name, `could not read the cron trigger: ${(err as Error).message}`, redeploy);
  }
  try {
    const listed = (await reader.get<Array<{ name?: string }>>(`${script}/secrets`)).result ?? [];
    const names = new Set(listed.map((s) => s.name));
    const missing = WORKER_SECRETS.filter((n) => !names.has(n));
    if (missing.length) alert(worker.name, `secrets missing: ${missing.join(", ")}`, redeploy);
  } catch (err) {
    alert(worker.name, `could not list the Worker's secrets: ${(err as Error).message}`, redeploy);
  }
  try {
    const text = await reader.raw(
      `/accounts/${accountId}/r2/buckets/${worker.bucket}/objects/state/last-run.json`,
    );
    let last: { at?: string; error?: string };
    let verified = false;
    if (hmacKey) {
      last = await openEnvelope(hmacKey, "last-run", text);
      verified = true;
    } else {
      last = JSON.parse(JSON.parse(text).payload);
    }
    const age = now.getTime() - Date.parse(last.at ?? "");
    if (!(age <= LAST_RUN_MAX_AGE_MS)) {
      alert(
        worker.name,
        `last run ${last.at ?? "never"}, more than 8 h ago — the cron stopped or the Worker crashes before it writes`,
        redeploy,
      );
    } else if (last.error) {
      alert(worker.name, `last run ${last.at} could not finish: ${last.error}`);
    } else if (!verified) {
      findings.push({
        severity: "info",
        check: "watchdog",
        subject: worker.name,
        detail: `last run ${last.at}; signature not checked (no keychain access to the HMAC key)`,
      });
    }
  } catch (err) {
    alert(worker.name, `could not read the Worker's last run: ${(err as Error).message}`, redeploy);
  }
  return findings;
}
