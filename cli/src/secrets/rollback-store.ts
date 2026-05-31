/*
 * cli/src/secrets/rollback-store.ts — Per-(project, adapter) rollback
 * blob persistence, backed by the OS keychain via keytar.
 *
 * Why the keychain (not an encrypted tmp file):
 *   · keytar is already a hard dependency (cli/src/utils/secrets.ts).
 *   · Every other per-project secret in this codebase lives there —
 *     adding a parallel filesystem path drifts.
 *   · Encrypted tmp files create their own leak surface (accidental
 *     tarball, find ~ -name '*.json', backup-to-cloud sync).
 *
 * Account-name pattern: `secrets-rollback:${project}:${adapter}`.
 * Value shape: JSON-stringified { version, timestamp, values, handle }.
 *
 * `clearAllSecrets()` in utils/secrets.ts already sweeps every
 * keytar entry under the hatchkit service, so `config reset` cleans
 * these up by default — no new wildcard needed.
 */

import { deleteSecret, getSecret, setSecret } from "../utils/secrets.js";
import type { OldCred } from "./types.js";

const ROLLBACK_VERSION = 1;
/** Refuse to act on rollback blobs older than 30 days — long-stale
 *  entries usually mean the operator forgot they existed and a forced
 *  restore would overwrite a now-correct credential. Operator can
 *  override with `--force` at the rollback command level. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface RollbackBlob {
  version: number;
  timestamp: string;
  values: Record<string, string>;
  handle: Record<string, string>;
}

/** Build the keychain account name. Kept here as a single function so
 *  every store operation hits the same shape. Exported for tests +
 *  for migrate-on-destroy logic that needs to recognize the pattern. */
export function rollbackAccount(project: string, adapter: string): string {
  return `secrets-rollback:${project}:${adapter}`;
}

/** Persist the OLD credential for one (project, adapter) BEFORE
 *  createNew runs. The orchestrator calls this immediately after
 *  `adapter.captureOld(ctx)` returns and BEFORE any mutation, so a
 *  crash between capture and createNew leaves an authoritative
 *  recovery blob. Overwrites any prior blob for the same key. */
export async function saveRollback(
  project: string,
  adapter: string,
  old: OldCred,
): Promise<void> {
  const blob: RollbackBlob = {
    version: ROLLBACK_VERSION,
    timestamp: new Date().toISOString(),
    values: { ...old.values },
    handle: { ...old.handle },
  };
  await setSecret(rollbackAccount(project, adapter), JSON.stringify(blob));
}

export interface LoadRollbackOptions {
  /** Skip the 30-day staleness check. The rollback command exposes
   *  this as `--force` for the rare case where the operator really
   *  wants to revert a very old change. */
  force?: boolean;
}

/** Read the most recently saved rollback blob for one (project,
 *  adapter). Returns null when no blob exists; throws when the blob
 *  is older than 30 days (unless `opts.force` is set) or has a future
 *  unknown `version`. JSON parse errors throw — a corrupted entry is
 *  operator-visible. */
export async function loadRollback(
  project: string,
  adapter: string,
  opts: LoadRollbackOptions = {},
): Promise<RollbackBlob | null> {
  const raw = await getSecret(rollbackAccount(project, adapter));
  if (!raw) return null;
  let parsed: RollbackBlob;
  try {
    parsed = JSON.parse(raw) as RollbackBlob;
  } catch (err) {
    throw new Error(
      `Rollback blob for ${project}/${adapter} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof parsed.version !== "number" || parsed.version > ROLLBACK_VERSION) {
    throw new Error(
      `Rollback blob for ${project}/${adapter} has unknown version ${parsed.version}. Upgrade hatchkit?`,
    );
  }
  if (!opts.force && parsed.timestamp) {
    const age = Date.now() - new Date(parsed.timestamp).getTime();
    if (Number.isFinite(age) && age > MAX_AGE_MS) {
      throw new Error(
        `Rollback blob for ${project}/${adapter} is older than 30 days (${parsed.timestamp}). Refusing to act — a stale rollback can clobber a now-correct credential. Pass --force if you really want to restore.`,
      );
    }
  }
  return parsed;
}

/** Delete the rollback blob for one (project, adapter). Called only
 *  when the rotation fully succeeded (verify === 'ok' AND oldRevoked
 *  === true). Anything else keeps the blob around for operator
 *  inspection. */
export async function clearRollback(project: string, adapter: string): Promise<void> {
  await deleteSecret(rollbackAccount(project, adapter));
}
