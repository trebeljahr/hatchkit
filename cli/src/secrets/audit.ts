/*
 * cli/src/secrets/audit.ts — Audit shape builders + value redactor.
 *
 * Single source of truth for what `hatchkit secrets rotate` prints to
 * stdout. Every code path that emits rotation output (JSON or human)
 * goes through here so the "names + outcomes only, never values" rule
 * has one enforcement point.
 *
 * `redactValues(obj)` is defence-in-depth: the audit TYPE
 * (`AdapterAuditEntry`) carries no value-shaped fields, but the
 * redactor walks any object before stdout and replaces strings that
 * match credential heuristics with '[REDACTED]'. Belt and braces.
 */

import chalk from "chalk";
import type { AdapterAuditEntry, RotationAudit } from "./types.js";

/** Suffix patterns commonly used for credential env-var names. Used
 *  by `redactValues` to mark anything keyed under one of these as a
 *  secret, regardless of how its value looks. */
const CREDENTIAL_KEY_SUFFIXES = [
  "_SECRET",
  "_KEY",
  "_TOKEN",
  "_PASSWORD",
  "_DSN",
  "_PRIVATE_KEY",
];

/** Probably-a-secret value heuristics, applied to ANY string value
 *  (not just credential-named keys). The bar is intentionally loose —
 *  false positives ('[REDACTED]' in place of an innocent string) are
 *  cheap; false negatives (a leaked secret in the audit) are not. */
function looksLikeCredentialValue(value: string): boolean {
  // Hex 32+ chars (dotenvx keys, MD5/SHA digests, R2 access keys).
  if (/^[0-9a-f]{32,}$/i.test(value)) return true;
  // Base64-ish 24+ chars (Stripe whsec, JWT segments, GH PATs).
  if (/^[A-Za-z0-9+/=_-]{24,}$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value)) {
    return true;
  }
  // Common credential prefixes used by upstream APIs.
  if (/^(sk_|pk_|whsec_|rk_|ghp_|gho_|ghu_|ghs_|github_pat_|xoxb-|xoxp-)/i.test(value)) {
    return true;
  }
  // DSN-shaped URLs (Sentry/GlitchTip).
  if (/^https?:\/\/[^:@/]+:[^@/]+@/.test(value)) return true;
  return false;
}

function keyLooksSecret(key: string): boolean {
  const upper = key.toUpperCase();
  return CREDENTIAL_KEY_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

/** Walk an object and replace any string value that looks like a
 *  credential with '[REDACTED]'. Operates on a deep clone — does not
 *  mutate the input. Arrays, nested objects, and primitives all
 *  preserved by shape. */
export function redactValues<T>(input: T): T {
  return walk(input) as T;
}

function walk(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => walk(v));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, k);
    }
    return out;
  }
  if (typeof value === "string") {
    if (parentKey && keyLooksSecret(parentKey)) return "[REDACTED]";
    if (looksLikeCredentialValue(value)) return "[REDACTED]";
    return value;
  }
  return value;
}

/** Strip secret-shaped substrings out of an error message produced by
 *  an adapter. Adapters MUST NOT throw error messages containing
 *  values, but the orchestrator wraps each adapter call in
 *  `wrapAdapterError` (see `orchestrator.ts`) which calls this as
 *  defence-in-depth. */
export function redactErrorMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{32,}/gi, "[REDACTED]")
    .replace(/(sk_|pk_|whsec_|rk_|ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/https?:\/\/[^:@/]+:[^@/]+@/g, "https://[REDACTED]@");
}

/** Build the final `RotationAudit` from in-flight orchestrator state.
 *  Currently a pass-through (the orchestrator assembles the shape
 *  directly), but exported as a stable seam so future refactors can
 *  inject normalization (sorted adapter order, deduped env keys, etc.). */
export function buildAudit(audit: RotationAudit): RotationAudit {
  return {
    ...audit,
    adapters: audit.adapters.map((a) => ({
      ...a,
      envKeysChanged: [...a.envKeysChanged].sort(),
      deployTargetsUpdated: [...a.deployTargetsUpdated],
    })),
  };
}

/** Emit the audit to stdout in the user's chosen format. JSON mode
 *  writes exactly one NDJSON line of the redacted audit and returns
 *  — no human-mode lines, no banner. Human mode prints a colored
 *  per-adapter summary. */
export function printAudit(audit: RotationAudit, opts: { json: boolean }): void {
  const built = buildAudit(audit);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(redactValues(built))}\n`);
    return;
  }
  renderAuditHuman(built);
}

/** Chalk-coloured per-adapter summary for terminal output. */
export function renderAuditHuman(audit: RotationAudit): void {
  console.log("");
  console.log(
    chalk.bold(
      `  hatchkit secrets rotate — ${audit.project}${audit.dryRun ? chalk.yellow(" (dry-run)") : ""}`,
    ),
  );
  console.log(chalk.dim(`  ${audit.projectDir}`));
  console.log(chalk.dim(`  ${audit.startedAt} → ${audit.finishedAt}`));
  console.log("");

  if (audit.adapters.length === 0) {
    console.log(chalk.dim("  No adapters matched this project."));
    return;
  }

  for (const entry of audit.adapters) {
    renderEntry(entry);
  }
}

function renderEntry(entry: AdapterAuditEntry): void {
  const prefix = `  · ${chalk.cyan(entry.provider)}`;
  if (entry.skipReason === "adapter-not-detected") {
    console.log(`${prefix} ${chalk.dim("skipped (not detected for this project)")}`);
    return;
  }

  const keys = entry.envKeysChanged.length
    ? entry.envKeysChanged.join(", ")
    : chalk.dim("(no env keys)");
  console.log(`${prefix}  ${keys}`);

  const targets = entry.deployTargetsUpdated.length
    ? entry.deployTargetsUpdated.join(", ")
    : chalk.dim("none");
  console.log(`      deploy: ${targets}`);

  const verifyColor =
    entry.verificationResult === "ok"
      ? chalk.green
      : entry.verificationResult === "failed"
        ? chalk.red
        : chalk.dim;
  console.log(`      verify: ${verifyColor(entry.verificationResult)}`);

  const revokeText =
    entry.oldRevoked === true
      ? chalk.green("revoked")
      : entry.oldRevoked === false
        ? chalk.red("revoke failed — old credential may still be live")
        : chalk.yellow("held (rollback blob preserved in keychain)");
  console.log(`      revoke: ${revokeText}`);

  if (entry.skipReason) {
    console.log(chalk.dim(`      skip:   ${entry.skipReason}`));
  }
}
