/*
 * What hatchkit expects on its Cloudflare account, built from what it
 * already records on this machine. Sync on purpose: the operator-use exit
 * hook builds it while the process exits.
 *
 *   · per-Worker CI tokens: `cloudflareDeployTokens` and ledger
 *     `cloudflareWorkerToken` steps;
 *   · per-project R2 tokens and buckets: ledger `r2Token`/`r2Bucket`
 *     steps and the `s3Buckets` of every local `.hatchkit.json`;
 *   · Workers: the CI-token records and manifest `clientWorker(s)`;
 *   · zones: manifest domains and aliases, `defaults.rootDomain`;
 *   · Email Routing destinations: `defaults.forwardingEmail`, manifest
 *     email intents, ledger `cloudflareEmailDestination` steps;
 *   · run windows from `operator-uses.ts`;
 *   · whatever Rico accepted (`config.cloudflareAudit.accepted`).
 *
 * Tokens are matched by id only. A name proves nothing: anyone holding
 * the operator token can call a token `caddy`.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  getCloudflareDeployTokenRecords,
  getConfiguredCloudflareAccountId,
  getStore,
} from "../config.js";
import { MANIFEST_FILENAME, readManifestWithMigrationInfo } from "../scaffold/manifest.js";
import { defaultProjectRoots } from "../secrets/global/consumers.js";
import { loadAllLedgers } from "../utils/run-ledger.js";
import {
  type CloudflareExpected,
  DEFAULT_OAUTH_APPS,
  type ExpectedToken,
  type ExpectedTokenKind,
} from "./cloudflare.js";
import { readOperatorRuns } from "./operator-uses.js";

/** The GitHub Actions variable the scheduled check reads. */
export const EXPECTED_VARIABLE = "HATCHKIT_CLOUDFLARE_EXPECTED";
/** Run windows older than this are not published. */
const RUN_HISTORY_MS = 3 * 24 * 60 * 60 * 1000;

export interface CloudflareAuditAccepted {
  operator?: string;
  /** Token id → why it may stay. */
  tokens?: Record<string, string>;
  workers?: string[];
  buckets?: string[];
  zones?: string[];
  emailDestinations?: string[];
  members?: string[];
  oauthClients?: string[];
  oauthApps?: string[];
}

export interface CloudflareAuditConfig {
  /** `owner/repo` of the private repo that runs the daily check. */
  repo?: string;
  accepted?: CloudflareAuditAccepted;
}

export function getAuditConfig(): CloudflareAuditConfig {
  return (getStore().get("cloudflareAudit") as CloudflareAuditConfig | undefined) ?? {};
}

export function getAuditRepo(): string | undefined {
  return getAuditConfig().repo;
}

export function setAuditRepo(repo: string): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Not an owner/repo: ${repo}`);
  getStore().set("cloudflareAudit", { ...getAuditConfig(), repo });
}

const LIST_KINDS = {
  worker: "workers",
  bucket: "buckets",
  zone: "zones",
  email: "emailDestinations",
  member: "members",
  "oauth-client": "oauthClients",
  "oauth-app": "oauthApps",
} as const satisfies Record<string, keyof CloudflareAuditAccepted>;

export const ACCEPT_KINDS = ["token", "operator", ...Object.keys(LIST_KINDS)] as const;

/** Parse `kind:value[=note]`. */
export function parseAcceptArg(arg: string): { kind: string; value: string; note?: string } {
  const m = arg.match(/^([a-z-]+):([^=]+)(?:=(.*))?$/);
  if (!m || !(ACCEPT_KINDS as readonly string[]).includes(m[1])) {
    throw new Error(
      `Expected <kind>:<value>, kind one of ${ACCEPT_KINDS.join(", ")}; got "${arg}"`,
    );
  }
  const [, kind, value, note] = m;
  if ((kind === "token" || kind === "operator") && !/^[0-9a-f]{32}$/i.test(value)) {
    throw new Error(`A token is accepted by its 32-hex id, not its name: "${value}"`);
  }
  return { kind, value: value.trim(), note: note?.trim() || undefined };
}

/** Add (or with `remove`, drop) accepted entries. Local config only. */
export function updateAccepted(args: string[], remove = false): CloudflareAuditAccepted {
  const accepted: CloudflareAuditAccepted = structuredClone(getAuditConfig().accepted ?? {});
  for (const arg of args) {
    const { kind, value, note } = parseAcceptArg(arg);
    if (kind === "operator") {
      if (remove) delete accepted.operator;
      else accepted.operator = value;
    } else if (kind === "token") {
      const tokens = { ...(accepted.tokens ?? {}) };
      if (remove) delete tokens[value];
      else tokens[value] = note ?? tokens[value] ?? "accepted";
      accepted.tokens = tokens;
    } else {
      const key = LIST_KINDS[kind as keyof typeof LIST_KINDS];
      const set = new Set(accepted[key] ?? []);
      if (remove) set.delete(value);
      else set.add(value);
      accepted[key] = [...set].sort();
    }
  }
  getStore().set("cloudflareAudit", { ...getAuditConfig(), accepted });
  return accepted;
}

/** Accept a whole inventory listing at once (first run). Never tokens. */
export function acceptInventory(inventory: {
  workers?: string[];
  buckets?: string[];
  zones?: string[];
  emailDestinations?: string[];
  members?: string[];
  oauthClients?: string[];
}): CloudflareAuditAccepted {
  const accepted: CloudflareAuditAccepted = structuredClone(getAuditConfig().accepted ?? {});
  for (const key of Object.keys(inventory) as Array<keyof typeof inventory>) {
    const values = inventory[key];
    if (!values) continue;
    accepted[key] = [...new Set([...(accepted[key] ?? []), ...values])].sort();
  }
  getStore().set("cloudflareAudit", { ...getAuditConfig(), accepted });
  return accepted;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Manifests at depth ≤ 1 under the project roots (worktrees sit deeper). */
function localManifests(roots: string[]) {
  const dirs = new Set<string>();
  for (const root of roots) {
    if (!isDir(root)) continue;
    dirs.add(root);
    for (const child of readdirSync(root)) {
      if (!child.startsWith(".") && child !== "node_modules") dirs.add(join(root, child));
    }
  }
  const out = [];
  for (const dir of dirs) {
    if (!existsSync(join(dir, MANIFEST_FILENAME))) continue;
    try {
      // The non-logging reader: stdout may be --json.
      const manifest = readManifestWithMigrationInfo(dir)?.manifest;
      if (manifest) out.push(manifest);
    } catch {
      // A broken manifest is doctor's business, not the audit's.
    }
  }
  return out;
}

function bucketFromRepositoryBase(base: string | undefined): string | undefined {
  // s3:https://<account>.r2.cloudflarestorage.com/<bucket>/<prefix>
  return base?.match(/r2\.cloudflarestorage\.com\/([^/]+)/)?.[1];
}

export interface BuildExpectedOptions {
  now: Date;
  projectRoots?: string[];
  operatorUsesPath?: string;
}

export function buildLocalExpected(opts: BuildExpectedOptions): CloudflareExpected {
  const store = getStore();
  const accepted = getAuditConfig().accepted ?? {};
  const tokens = new Map<string, ExpectedToken>();
  const addToken = (id: string | undefined, kind: ExpectedTokenKind, note?: string) => {
    if (id && !tokens.has(id)) tokens.set(id, { id, kind, ...(note ? { note } : {}) });
  };
  const workers = new Set<string>(accepted.workers ?? []);
  const buckets = new Set<string>(accepted.buckets ?? []);
  const domains = new Set<string>();
  const zones = new Set<string>((accepted.zones ?? []).map((z) => z.toLowerCase()));
  const destinations = new Set<string>(
    (accepted.emailDestinations ?? []).map((d) => d.toLowerCase()),
  );

  for (const record of Object.values(getCloudflareDeployTokenRecords())) {
    addToken(record.tokenId, "worker", `CI token of Worker ${record.worker} (${record.repo})`);
    workers.add(record.worker);
  }

  for (const ledger of loadAllLedgers()) {
    for (const step of ledger.steps) {
      if (step.kind === "cloudflareWorkerToken") {
        addToken(step.tokenId, "worker", `CI token of Worker ${step.worker}`);
        workers.add(step.worker);
      } else if (step.kind === "r2Token") {
        addToken(step.tokenId, "r2", `R2 token of ${ledger.name}`);
      } else if (step.kind === "r2Bucket") {
        buckets.add(step.bucketName);
      } else if (step.kind === "cloudflareEmailDestination") {
        destinations.add(step.email.toLowerCase());
      } else if (step.kind === "cloudflareWorkerRoute" && step.script) {
        workers.add(step.script);
      }
    }
  }

  for (const manifest of localManifests(opts.projectRoots ?? defaultProjectRoots())) {
    const s3 = manifest.s3Buckets as Record<string, unknown> | undefined;
    if (s3) {
      if (typeof s3.tokenId === "string")
        addToken(s3.tokenId, "r2", `R2 token of ${manifest.name}`);
      for (const [key, value] of Object.entries(s3)) {
        if (!value || typeof value !== "object") continue;
        const bucket = value as { name?: string; tokenId?: string };
        if (bucket.name) buckets.add(bucket.name);
        addToken(bucket.tokenId, "r2", `R2 token of ${manifest.name} (${key})`);
      }
    }
    if (manifest.clientWorker) workers.add(manifest.clientWorker);
    for (const worker of Object.values(manifest.clientWorkers ?? {}))
      if (worker) workers.add(worker);
    for (const domain of [manifest.domain, ...(manifest.aliases ?? [])]) {
      if (domain) domains.add(domain.toLowerCase());
    }
    const email = manifest.integrations?.email;
    if (email?.domain) domains.add(email.domain.toLowerCase());
    if (email?.destinationEmail) destinations.add(email.destinationEmail.toLowerCase());
    for (const to of Object.values(email?.addressDestinations ?? {}))
      destinations.add(to.toLowerCase());
  }

  const defaults = store.get("defaults") as
    | { forwardingEmail?: string; rootDomain?: string }
    | undefined;
  if (defaults?.forwardingEmail) destinations.add(defaults.forwardingEmail.toLowerCase());
  if (defaults?.rootDomain) domains.add(defaults.rootDomain.toLowerCase());
  const backups = store.get("providers.backups") as { repositoryBase?: string } | undefined;
  const backupBucket = bucketFromRepositoryBase(backups?.repositoryBase);
  if (backupBucket) buckets.add(backupBucket);

  // A domain is its zone or sits under it. Publish every parent name so
  // the check matches zones without knowing the zone list.
  for (const domain of domains) {
    const labels = domain.split(".");
    for (let i = 0; i < labels.length - 1; i++) zones.add(labels.slice(i).join("."));
  }

  for (const [id, note] of Object.entries(accepted.tokens ?? {})) addToken(id, "accepted", note);

  const accountId = getConfiguredCloudflareAccountId() ?? "";
  const since = new Date(opts.now.getTime() - RUN_HISTORY_MS);
  return {
    version: 1,
    accountId,
    generatedAt: opts.now.toISOString(),
    ...(accepted.operator ? { operatorTokenId: accepted.operator } : {}),
    tokens: [...tokens.values()],
    workers: [...workers].sort(),
    buckets: [...buckets].sort(),
    zones: [...zones].sort(),
    emailDestinations: [...destinations].sort(),
    members: [...(accepted.members ?? [])].sort(),
    oauthClients: [...(accepted.oauthClients ?? [])].sort(),
    oauthApps: [...new Set([...DEFAULT_OAUTH_APPS, ...(accepted.oauthApps ?? [])])],
    runs: readOperatorRuns(since, opts.operatorUsesPath),
  };
}
