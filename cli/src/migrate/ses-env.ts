/*
 * migrate-domain — the SES from-address as the app sees it.
 *
 * `manifest.ses.identity` is hatchkit's record of which identity a
 * project sends from. The app never reads the manifest: it reads
 * `SES_FROM_EMAIL` (the SMTP envelope sender) and, on Listmonk projects,
 * `LISTMONK_FROM` (the `"Name <addr>"` display sender) out of its env
 * files. A cutover that moves only the manifest leaves the running app
 * sending from `@mail.<old>` — and once cleanup deletes that identity,
 * SES rejects every one of those sends.
 *
 * So the cutover rewrites those entries too, and cleanup reads them
 * before it deletes anything.
 *
 * Two constraints shape the code:
 *
 *   · Encryption state is per entry and must survive. `.env.production`
 *     is dotenvx-encrypted and committed; `.env.development` is plain.
 *     Each value is re-set with the same `encrypt` flag its line had.
 *
 *   · A value is only rewritten when it can be READ and names the old
 *     identity. Swapping `@<old>` for `@<new>` keeps whatever local part
 *     and display name the operator chose. When the private key isn't on
 *     this machine the value can't be read; the caller decides whether a
 *     recomputed default is acceptable there (first cutover: yes, it is
 *     what provisioning wrote) or not (a re-run: no, it would churn
 *     ciphertext on every invocation and could clobber a customisation).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse as dotenvxParse } from "@dotenvx/dotenvx";
import { parseDotenv } from "../deploy/env-resolve.js";
import { dotenvxSet } from "../utils/dotenvx-safe.js";
import { locateEnvFile } from "../utils/env-files.js";
import { SECRET_KEYS, getSecret } from "../utils/secrets.js";

/** Env entries that carry the sending address. */
export const SES_FROM_ENV_KEYS = ["SES_FROM_EMAIL", "LISTMONK_FROM"] as const;
export type SesFromEnvKey = (typeof SES_FROM_ENV_KEYS)[number];

const ENV_FILES = [".env.production", ".env.development"] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Swap the mail domain in a from-address, keeping everything else.
 *  `"Beauty <noreply@mail.old.com>"` → `"Beauty <noreply@mail.new.com>"`.
 *  Returns null when the value doesn't send from `prevIdentity` — it is
 *  either already moved or something the operator set by hand, and in
 *  both cases not ours to touch. Pure. */
export function rewriteFromAddress(
  value: string,
  prevIdentity: string,
  newIdentity: string,
): string | null {
  const re = new RegExp(`@${escapeRegExp(prevIdentity)}(?=$|[>\\s"'])`, "gi");
  if (!re.test(value)) return null;
  return value.replace(re, `@${newIdentity}`);
}

/** Whether `key`'s line in an env file holds dotenvx ciphertext. Pure. */
export function envEntryIsEncrypted(envText: string, key: string): boolean {
  const re = new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}\\s*=\\s*["']?encrypted:`, "m");
  return re.test(envText);
}

function envEntryPresent(envText: string, key: string): boolean {
  return new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}\\s*=`, "m").test(envText);
}

/** The `.env.keys` private key for `.env.production`, from wherever a
 *  workstation or CI keeps it. Undefined when nothing is found — the
 *  caller then treats encrypted values as unreadable. */
async function productionPrivateKey(
  envPath: string,
  projectDir: string,
  projectName: string,
): Promise<string | undefined> {
  if (process.env.DOTENV_PRIVATE_KEY_PRODUCTION) return process.env.DOTENV_PRIVATE_KEY_PRODUCTION;
  for (const dir of [dirname(envPath), projectDir]) {
    const keysPath = join(dir, ".env.keys");
    if (!existsSync(keysPath)) continue;
    const parsed = dotenvxParse(readFileSync(keysPath, "utf-8"), { processEnv: {} }) as Record<
      string,
      string
    >;
    if (parsed.DOTENV_PRIVATE_KEY_PRODUCTION) return parsed.DOTENV_PRIVATE_KEY_PRODUCTION;
  }
  try {
    return (await getSecret(SECRET_KEYS.dotenvxPrivateKey(projectName))) ?? undefined;
  } catch {
    // A refused keychain read just means "can't decrypt here" — the
    // caller already has a path for unreadable values.
    return undefined;
  }
}

export interface FromEnvEntry {
  /** Absolute path of the env file. */
  path: string;
  /** Path relative to the project dir, for log lines. */
  relPath: string;
  key: SesFromEnvKey;
  encrypted: boolean;
  /** Decrypted value, or null when it could not be read. */
  value: string | null;
}

/** Every from-address entry in the project's env files, decrypted where
 *  possible. Never throws for a missing key or file. */
export async function readSesFromEnv(
  projectDir: string,
  projectName: string,
): Promise<FromEnvEntry[]> {
  const out: FromEnvEntry[] = [];
  for (const file of ENV_FILES) {
    const path = locateEnvFile(projectDir, file);
    if (!path) continue;
    const text = readFileSync(path, "utf-8");
    const keys = SES_FROM_ENV_KEYS.filter((k) => envEntryPresent(text, k));
    if (keys.length === 0) continue;

    const anyEncrypted = keys.some((k) => envEntryIsEncrypted(text, k));
    const privateKey = anyEncrypted
      ? await productionPrivateKey(path, projectDir, projectName)
      : undefined;
    let parsed: Record<string, string> = {};
    try {
      // Without a key, dotenvx's parse logs a MISSING_PRIVATE_KEY error
      // per encrypted entry straight to the console. Unreadable is an
      // outcome this module handles, not an error, so read the raw
      // values instead and let `encrypted:` mark them.
      parsed =
        anyEncrypted && !privateKey
          ? parseDotenv(text)
          : (dotenvxParse(text, { privateKey, processEnv: {} }) as Record<string, string>);
    } catch {
      parsed = {};
    }

    for (const key of keys) {
      const raw = parsed[key];
      const readable = typeof raw === "string" && !raw.startsWith("encrypted:");
      out.push({
        path,
        relPath: relative(projectDir, path),
        key,
        encrypted: envEntryIsEncrypted(text, key),
        value: readable ? raw : null,
      });
    }
  }
  return out;
}

export interface RewriteSesFromEnvOptions {
  projectDir: string;
  projectName: string;
  prevIdentity: string;
  newIdentity: string;
  /** Write the recomputed default (`noreply@<new>`, `"<name> <noreply@<new>>"`)
   *  into entries that can't be decrypted here. */
  defaultsWhenUnreadable: boolean;
}

export interface RewriteSesFromEnvResult {
  /** Entries whose value changed. */
  rewritten: string[];
  /** Entries that could not be read and were left as they are. */
  unreadable: string[];
  /** One log line per entry considered. */
  detail: string[];
}

/** Move every from-address entry off `prevIdentity`. Idempotent: an
 *  entry already on `newIdentity` is reported and left alone. */
export async function rewriteSesFromEnv(
  opts: RewriteSesFromEnvOptions,
): Promise<RewriteSesFromEnvResult> {
  const defaults: Record<SesFromEnvKey, string> = {
    SES_FROM_EMAIL: `noreply@${opts.newIdentity}`,
    LISTMONK_FROM: `${opts.projectName} <noreply@${opts.newIdentity}>`,
  };
  const result: RewriteSesFromEnvResult = { rewritten: [], unreadable: [], detail: [] };

  for (const entry of await readSesFromEnv(opts.projectDir, opts.projectName)) {
    const label = `${entry.relPath} ${entry.key}`;
    let next: string | null;
    if (entry.value === null) {
      if (!opts.defaultsWhenUnreadable) {
        result.unreadable.push(label);
        result.detail.push(`${label}: can't decrypt here — left as is`);
        continue;
      }
      next = defaults[entry.key];
    } else {
      next = rewriteFromAddress(entry.value, opts.prevIdentity, opts.newIdentity);
      if (next === null) {
        const onNew = entry.value.toLowerCase().includes(`@${opts.newIdentity.toLowerCase()}`);
        result.detail.push(
          onNew
            ? `${label}: already ${entry.value}`
            : `${label}: ${entry.value} doesn't send from @${opts.prevIdentity} — left as is`,
        );
        continue;
      }
    }
    const res = dotenvxSet(entry.key, next, { path: entry.path, encrypt: entry.encrypted });
    const failed = res.processedEnvs.find((e) => e.error);
    if (failed?.error) {
      throw new Error(`could not write ${label}: ${failed.error.message}`);
    }
    result.rewritten.push(label);
    result.detail.push(`${label} → ${next}${entry.encrypted ? " (encrypted)" : ""}`);
  }
  return result;
}
