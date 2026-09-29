/*
 * Is a project an isolated world? — the audit behind `hatchkit doctor`'s
 * "project credentials" check and `hatchkit secrets isolate`.
 *
 * ---------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------
 *
 * Hatchkit holds one high-privilege PROVISIONER credential per provider
 * (the Coolify root token, the Cloudflare tokens that can mint other
 * tokens or edit every zone, the shared SES IAM key), and only in its
 * keychain. Every credential a project holds must be minted for that
 * project alone. A provisioner value anywhere project-facing — an env
 * file, the plaintext provisioning cache, a Coolify app env, a GitHub
 * Actions secret, a workflow that reads one — means one compromised repo
 * reaches every other project.
 *
 * ---------------------------------------------------------------------
 * How it looks without printing anything
 * ---------------------------------------------------------------------
 *
 * Values are compared in memory and only key names and file paths are
 * reported. GitHub never returns a secret's value, so for Actions
 * secrets the NAMES that hatchkit used to push the provisioner under are
 * the signal (`COOLIFY_API_TOKEN`, `COOLIFY_TOKEN`), plus the workflows
 * that still read them.
 *
 * A Worker repo's `CLOUDFLARE_API_TOKEN` is judged by its `updated_at`:
 * hatchkit records the token it minted for the repo together with the
 * `updated_at` GitHub reported right after the push. Any other value —
 * a dashboard token pasted by hand, the old shared token — was set at a
 * different time and fails the check.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CloudflareDeployTokenRecord, getConfigPath, getSesConfig } from "../config.js";
import {
  type DeployTokenScope,
  maskId,
  workerDeployTokenName,
} from "../deploy/cloudflare-deploy-token.js";
import {
  PROVISIONER_DEPLOY_SECRET_NAMES,
  TOKEN_ONLY_DEPLOY_SECRET_NAMES,
} from "../deploy/coolify-deploy-hook.js";
import { deriveSesSmtpPassword } from "../provision/ses.js";
import { exec } from "../utils/exec.js";
import { SECRET_KEYS, getSecret } from "../utils/secrets.js";

export type IsolationSeverity = "fail" | "warn";

/** One provisioner value, held in memory only. */
export interface ProvisionerValue {
  provider: "coolify" | "cloudflare" | "ses" | "listmonk";
  /** What it is, for the finding text. Never the value. */
  label: string;
  value: string;
  /** `warn` for a shared credential whose per-project replacement exists
   *  but is backfilled by its own command (Listmonk), so doctor does not
   *  fail every project on it at once. */
  severity: IsolationSeverity;
}

export interface IsolationFinding {
  severity: IsolationSeverity;
  provider: string;
  /** File path, `github:<owner/repo>`, or `coolify:<app>`. */
  where: string;
  /** What was found — key names and labels only. */
  what: string;
}

/** Env keys derived from the shared SES IAM key. Hatchkit no longer
 *  writes them and nothing a project runs reads them (Listmonk's SMTP
 *  settings come straight from the keychain), so any copy left over is a
 *  copy of the provisioner. */
export const SHARED_SES_ENV_KEYS = ["SES_SMTP_USERNAME", "SES_SMTP_PASSWORD"] as const;

/** Every provisioner value in the keychain. Short values are skipped: a
 *  substring match on one would flag unrelated keys. */
export async function collectProvisionerValues(): Promise<ProvisionerValue[]> {
  const out: ProvisionerValue[] = [];
  const add = (
    provider: ProvisionerValue["provider"],
    label: string,
    value: string | null | undefined,
    severity: IsolationSeverity = "fail",
  ) => {
    if (value && value.length >= 16) out.push({ provider, label, value, severity });
  };
  add("coolify", "hatchkit's Coolify token", await getSecret(SECRET_KEYS.coolifyToken));
  add(
    "cloudflare",
    "hatchkit's Cloudflare DNS token",
    await getSecret(SECRET_KEYS.dnsCloudflareToken),
  );
  add(
    "cloudflare",
    "hatchkit's Cloudflare R2 admin token",
    await getSecret(SECRET_KEYS.r2AdminToken),
  );
  add(
    "cloudflare",
    "hatchkit's Cloudflare provisioner token",
    await getSecret(SECRET_KEYS.cloudflareProvisionerToken),
  );
  add(
    "cloudflare",
    "the shared Cloudflare Workers token older hatchkit pushed to every Worker repo",
    await getSecret(SECRET_KEYS.cloudflareWorkersToken),
  );
  add("listmonk", "hatchkit's Listmonk admin token", await getSecret(SECRET_KEYS.listmonkAdminApiToken));
  const sesId = await getSecret(SECRET_KEYS.sesAccessKeyId);
  const sesSecret = await getSecret(SECRET_KEYS.sesSecretAccessKey);
  add("ses", "hatchkit's shared SES access key id", sesId);
  add("ses", "hatchkit's shared SES secret key", sesSecret);
  if (sesSecret) {
    const region = (await getSesConfig().catch(() => null))?.region;
    if (region) {
      add("ses", "the SMTP password of hatchkit's shared SES key", deriveSesSmtpPassword(sesSecret, region));
    }
  }
  add(
    "listmonk",
    "hatchkit's Listmonk API token (give the project its own: `hatchkit listmonk user <project>`)",
    await getSecret(SECRET_KEYS.listmonkApiToken),
    "warn",
  );
  return out;
}

/** Findings for one env map. Pure: `env` is already decrypted in memory. */
export function findProvisionerValuesInEnv(
  env: Record<string, string>,
  provisioners: readonly ProvisionerValue[],
  where: string,
): IsolationFinding[] {
  const out: IsolationFinding[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < 16) continue;
    for (const p of provisioners) {
      if (value === p.value || value.includes(p.value)) {
        out.push({ severity: p.severity, provider: p.provider, where, what: `${key} holds ${p.label}` });
      }
    }
  }
  for (const key of SHARED_SES_ENV_KEYS) {
    if (key in env && !out.some((f) => f.what.startsWith(`${key} `))) {
      out.push({
        severity: "fail",
        provider: "ses",
        where,
        what: `${key} is set — it is derived from hatchkit's shared SES key (an older one, or the current one)`,
      });
    }
  }
  if (env.LISTMONK_API_TOKEN) {
    out.push({
      severity: env.SES_PROJECT_ACCESS_KEY_ID || env.EMAIL_TRANSPORT === "ses" ? "fail" : "warn",
      provider: "listmonk", where,
      what: "Listmonk credentials retain shared relay/subscriber authority; per-project API users do not enforce sender isolation. Migrate newsletters to a dedicated instance or project-bound gateway before claiming full isolation.",
    });
  }
  return out;
}

/** Findings for a project's GitHub Actions secret NAMES. Pure. */
export function findProvisionerSecretNames(names: readonly string[], repo: string): IsolationFinding[] {
  const out: IsolationFinding[] = [];
  for (const name of PROVISIONER_DEPLOY_SECRET_NAMES) {
    if (names.includes(name)) {
      out.push({
        severity: "fail",
        provider: "coolify",
        where: `github:${repo}`,
        what: `${name} — hatchkit pushed its Coolify token under this name`,
      });
    }
  }
  for (const name of TOKEN_ONLY_DEPLOY_SECRET_NAMES) {
    if (names.includes(name)) {
      out.push({
        severity: "warn",
        provider: "coolify",
        where: `github:${repo}`,
        what: `${name} — only works together with a Coolify API token`,
      });
    }
  }
  return out;
}

/** Findings for a Worker repo's `CLOUDFLARE_API_TOKEN`. Pure.
 *
 *  `token` is the recorded token as the provisioner reads it now: its
 *  status and what its policies reach, or null when it no longer exists.
 *  Undefined when it could not be read, which is not a finding. */
export function findCloudflareDeployTokenFindings(input: {
  repo: string;
  worker: string;
  secrets: ReadonlyArray<{ name: string; updatedAt?: string }>;
  record?: CloudflareDeployTokenRecord;
  token?: { status: string; scope: DeployTokenScope | "broader" } | null;
}): IsolationFinding[] {
  const where = `github:${input.repo}`;
  const secret = input.secrets.find((s) => s.name === "CLOUDFLARE_API_TOKEN");
  if (!secret)
    return [
      {
        severity: "warn",
        provider: "cloudflare",
        where,
        what: "No repo-level CLOUDFLARE_API_TOKEN; CI deployment credentials are unverified",
      },
    ];
  const fix = `\`hatchkit secrets isolate <dir>\` gives the repo a token for Worker ${input.worker} alone`;
  const { record } = input;
  if (!record || record.repo !== input.repo || record.worker !== input.worker) {
    return [
      {
        severity: "fail",
        provider: "cloudflare",
        where,
        what: `CLOUDFLARE_API_TOKEN is not a per-project token hatchkit minted — ${fix}`,
      },
    ];
  }
  const name = `${workerDeployTokenName(input.worker)} (${maskId(record.tokenId)})`;
  if (!record.secretUpdatedAt || secret.updatedAt !== record.secretUpdatedAt) {
    return [
      {
        severity: "fail",
        provider: "cloudflare",
        where,
        what: `CLOUDFLARE_API_TOKEN was set at ${secret.updatedAt ?? "an unknown time"}, not when hatchkit pushed ${name} — ${fix}`,
      },
    ];
  }
  if (input.token === null || (input.token && input.token.status !== "active")) {
    return [
      {
        severity: "fail",
        provider: "cloudflare",
        where,
        what: `${name} is ${input.token ? input.token.status : "gone"}, so CI can't deploy — \`hatchkit secrets isolate <dir> --rotate\``,
      },
    ];
  }
  if (input.token === undefined)
    return [
      {
        severity: "warn",
        provider: "cloudflare",
        where,
        what: `${name}: current policy and status could not be verified`,
      },
    ];
  const scope = input.token.scope;
  if (scope === "broader") {
    return [
      {
        severity: "fail",
        provider: "cloudflare",
        where,
        what: `${name} reaches more than Worker ${input.worker} — \`hatchkit secrets isolate <dir> --rotate\``,
      },
    ];
  }
  if (scope === "account") {
    return [
      {
        severity: "fail",
        provider: "cloudflare",
        where,
        what: `${name} is this repo's own token, but it has Workers Scripts Write on the whole account: revocable on its own, not isolated — retry with \`hatchkit secrets isolate <dir> --rotate\``,
      },
    ];
  }
  return [{
    severity: "warn", provider: "cloudflare", where,
    what: `${name} is scoped to Worker ${input.worker}; runtime bindings and cross-resource binding authorization are outside this audit`,
  }];
}

/** Workflows that read a provisioner-token secret. */
export function findWorkflowTokenReads(projectDir: string): IsolationFinding[] {
  const dir = join(projectDir, ".github", "workflows");
  if (!existsSync(dir)) return [];
  const out: IsolationFinding[] = [];
  for (const file of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const text = readFileSync(join(dir, file), "utf8");
    const read = PROVISIONER_DEPLOY_SECRET_NAMES.filter((n) =>
      new RegExp(`\\bsecrets\\.${n}\\b`).test(text),
    );
    if (read.length > 0) {
      out.push({
        severity: "fail",
        provider: "coolify",
        where: `.github/workflows/${file}`,
        what: `reads ${read.join(", ")}`,
      });
    }
  }
  return out;
}

/** The plaintext provisioning cache files that belong to `name`. */
export function provisionedCacheFiles(name: string): string[] {
  const dir = join(dirname(getConfigPath()), "provisioned");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${name}.`) && f.endsWith(".env"))
    .map((f) => join(dir, f));
}

/** Parse a plain `KEY=value` env file (no decryption). */
export function parsePlainEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export interface AuditOptions {
  /** Provisioner values; read from the keychain when omitted. */
  provisioners?: ProvisionerValue[];
  /** Decrypt and scan the project's env files (the slow part). */
  envFiles?: boolean;
  /** List the repo's Actions secret names (one `gh` call). */
  github?: boolean;
  /** Read the project's Coolify app envs (one API call per app). */
  coolify?: boolean;
  /** Read the recorded Cloudflare deploy token's state (one API call). */
  cloudflare?: boolean;
}

/** The recorded deploy token as the provisioner sees it now: null when
 *  it no longer exists, undefined when it can't be read. */
async function readDeployToken(
  record: CloudflareDeployTokenRecord,
): Promise<{ status: string; scope: DeployTokenScope | "broader" } | null | undefined> {
  const { getCloudflareProvisioner } = await import("../config.js");
  const prov = await getCloudflareProvisioner();
  if (!prov) return undefined;
  const { CloudflareApi } = await import("../utils/cloudflare-api.js");
  const { classifyDeployTokenPolicies } = await import("../deploy/cloudflare-deploy-token.js");
  try {
    const t = await new CloudflareApi({ token: prov.token }).getAccountToken(
      record.accountId,
      record.tokenId,
    );
    if (!t) return null;
    return {
      status: t.status,
      scope: classifyDeployTokenPolicies(t.policies ?? [], record),
    };
  } catch {
    return undefined;
  }
}

/** Everything the rule forbids, for one project. Read-only. */
export async function auditProjectIsolation(
  projectDir: string,
  opts: AuditOptions = {},
): Promise<{ name: string; repo?: string; findings: IsolationFinding[] }> {
  const { readManifest } = await import("../scaffold/manifest.js");
  const manifest = readManifest(projectDir);
  const name = manifest?.name ?? projectDir.split("/").pop() ?? projectDir;
  const provisioners = opts.provisioners ?? (await collectProvisionerValues());
  const findings: IsolationFinding[] = [];
  const senderEnvs: Array<{ where: string; env: Record<string, string> }> = [];

  if (opts.envFiles !== false) {
    const { readDevEnv, readEncryptedProd } = await import("./env-writer.js");
    for (const [label, read] of [
      [".env.production", () => readEncryptedProd(projectDir)],
      ["dev env", () => readDevEnv(projectDir)],
    ] as const) {
      try {
        const env = read();
        findings.push(...findProvisionerValuesInEnv(env, provisioners, label));
        senderEnvs.push({ where: label, env });
      } catch {
        // A missing file or a key that can't be located is not a finding.
      }
    }
  }
  for (const file of provisionedCacheFiles(name)) {
    findings.push(
      ...findProvisionerValuesInEnv(parsePlainEnv(readFileSync(file, "utf8")), provisioners, file),
    );
  }
  findings.push(...findWorkflowTokenReads(projectDir));

  let repo: string | undefined;
  if (opts.github !== false) {
    const remote = await exec("git", ["-C", projectDir, "remote", "get-url", "origin"], {
      silent: true,
    });
    const { listRepoSecrets, repoSlugFromRemote } = await import("../deploy/gh-actions-secrets.js");
    repo = remote.exitCode === 0 ? repoSlugFromRemote(remote.stdout.trim()) : undefined;
    const secrets = repo ? await listRepoSecrets(repo) : null;
    if (repo && !secrets && existsSync(join(projectDir, "wrangler.jsonc"))) {
      findings.push({
        severity: "warn",
        provider: "cloudflare",
        where: `github:${repo}`,
        what: "GitHub secret metadata could not be read; credential isolation is unverified",
      });
    }
    if (repo && secrets) {
      findings.push(
        ...findProvisionerSecretNames(
          secrets.map((s) => s.name),
          repo,
        ),
      );
      const { readWorkerName } = await import("../deploy/cloudflare.js");
      const worker = readWorkerName(projectDir);
      if (worker) {
        const { getCloudflareDeployTokenRecords } = await import("../config.js");
        const record = getCloudflareDeployTokenRecords()[worker];
        const token =
          record && opts.cloudflare !== false ? await readDeployToken(record) : undefined;
        findings.push(
          ...findCloudflareDeployTokenFindings({
            repo,
            worker,
            secrets,
            record,
            token,
          }),
        );
      }
    }
  }

  if (
    opts.coolify !== false &&
    manifest &&
    (manifest.deploymentMode === undefined || manifest.deploymentMode === "coolify")
  ) {
    const { getCoolifyConfig } = await import("../config.js");
    const cfg = await getCoolifyConfig();
    if (cfg) {
      const { findCoolifyAppsForProject } = await import("../deploy/coolify-app.js");
      const { CoolifyApi } = await import("../utils/coolify-api.js");
      const api = new CoolifyApi({ url: cfg.url, token: cfg.token });
      const apps = await findCoolifyAppsForProject(name, manifest.topology).catch(() => []);
      for (const app of apps) {
        const env = Object.fromEntries(
          (await api.listAppEnvs(app.uuid).catch(() => [])).map((e) => [e.key, e.value]),
        );
        findings.push(...findProvisionerValuesInEnv(env, provisioners, `coolify:${app.uuid}`));
        senderEnvs.push({ where: `coolify:${app.uuid}`, env });
      }
    }
  }
  if (senderEnvs.some(({ env }) => env.SES_PROJECT_ACCESS_KEY_ID || env.EMAIL_TRANSPORT === "ses")) {
    const { auditProjectSenderEnvs } = await import("../provision/ses-sender-audit.js");
    findings.push(...await auditProjectSenderEnvs(name, senderEnvs));
  }
  return { name, repo, findings };
}

/** Findings as `hatchkit doctor` check results. */
export function isolationCheckResults(
  name: string,
  findings: readonly IsolationFinding[],
): Array<{
  name: string;
  status: "ok" | "fail" | "warn";
  detail: string;
  hint?: string[];
}> {
  const title = `Project ${name} (credentials are project-scoped)`;
  if (findings.length === 0) {
    return [
      {
        name: title,
        status: "ok",
        detail: "no provisioner credential in any project-facing place",
      },
    ];
  }
  const fails = findings.filter((f) => f.severity === "fail");
  return [
    {
      name: title,
      status: fails.length > 0 ? "fail" : "warn",
      detail:
        fails.length > 0
          ? `${fails.length} place(s) hold one of hatchkit's provisioner credentials`
          : `${findings.length} shared credential(s) tracked for a later migration`,
      hint: [
        ...findings.map((f) => `${f.severity === "fail" ? "✗" : "!"} ${f.where}: ${f.what}`),
        "",
        "A provisioner credential in one project reaches every project on the same",
        "provider. `hatchkit secrets isolate <project> --dry-run` shows the fix (Coolify",
        "deploy hooks, a Cloudflare token per Worker); afterwards rotate the shared",
        "credential (see the isolation design notes).",
      ],
    },
  ];
}
