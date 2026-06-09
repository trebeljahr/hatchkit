/*
 * cli/src/features/signing/github.ts — `gh secret set` push wrapper
 * for the 20 signing-related repo secrets. Idempotent — `gh secret set`
 * upserts.
 *
 * Reuses the auth flow of cli/src/deploy/gh-actions-secrets.ts but
 * stays separate to keep blast radius scoped (the Coolify deploy
 * pipeline has its own 4 secrets; this pushes a different ~16 per
 * platform). Errors here MUST NOT leak the secret value into stderr —
 * see `redactSecretValue` below.
 */

import { exec } from "../../utils/exec.js";

export interface PushSigningSecretsInput {
  /** Project working directory with .git access. */
  projectDir: string;
  /** GitHub repo slug `owner/repo`. */
  repoSlug: string;
  /** Map of secret name → plaintext value. Order preserved. */
  secrets: Record<string, string>;
}

export interface PushSigningSecretsResult {
  pushed: string[];
  failed: Array<{ name: string; error: string }>;
}

/** Push the given secrets to GitHub repo settings. Each `gh secret
 *  set` invocation is its own subprocess so a single failure doesn't
 *  abort the rest. */
export async function pushSigningSecrets(
  input: PushSigningSecretsInput,
): Promise<PushSigningSecretsResult> {
  const pushed: string[] = [];
  const failed: PushSigningSecretsResult["failed"] = [];
  for (const [name, value] of Object.entries(input.secrets)) {
    try {
      await ghSecretSet(input.projectDir, input.repoSlug, name, value);
      pushed.push(name);
    } catch (err) {
      const msg = (err as Error).message;
      failed.push({ name, error: redactSecretValue(msg, value) });
    }
  }
  return { pushed, failed };
}

async function ghSecretSet(cwd: string, repo: string, name: string, value: string): Promise<void> {
  // Pass the secret via stdin to avoid it showing up in `ps`/argv. The
  // gh CLI reads stdin when `--body -` is supplied. The exec helper
  // forwards `input` through to the child's stdin.
  const res = await exec("gh", ["secret", "set", name, "--repo", repo, "--body", "-"], {
    cwd,
    input: value,
    silent: true,
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `gh secret set ${name} exited ${res.exitCode}: ${redactSecretValue(res.stderr.trim(), value)}`,
    );
  }
}

/** Replace any occurrence of the plaintext secret in an error message
 *  with `***`. Belt-and-braces — `gh` doesn't normally echo the body,
 *  but a malformed body (e.g. JSON with embedded newlines) can end up
 *  quoted back. */
export function redactSecretValue(text: string, value: string): string {
  if (!value || value.length < 4) return text;
  return text.split(value).join("***");
}

/** Check whether a repo-level Actions secret already exists. Used to
 *  decide whether the ledger should record this push (so destroy only
 *  removes secrets Hatchkit created). Errs toward "exists" on probe
 *  failure to avoid deleting a user-set secret on destroy. */
export async function ghSigningSecretExists(
  cwd: string,
  repoSlug: string,
  name: string,
): Promise<boolean> {
  const res = await exec(
    "gh",
    [
      "secret",
      "list",
      "--repo",
      repoSlug,
      "--json",
      "name",
      "-q",
      `.[] | select(.name=="${name}") | .name`,
    ],
    { cwd, silent: true },
  );
  if (res.exitCode !== 0) return true;
  return res.stdout.trim().length > 0;
}

/** Names of every signing-related repo secret Hatchkit can push. Used
 *  by `hatchkit destroy` to know what to remove. Grouped by platform. */
export const SIGNING_SECRET_NAMES = {
  windows: [
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_TS_ACCOUNT",
    "AZURE_TS_PROFILE",
    "AZURE_TS_ENDPOINT",
  ],
  ios: [
    "APPLE_TEAM_ID",
    "APPLE_CERT_P12_BASE64",
    "APPLE_CERT_P12_PASSWORD",
    "APPLE_PROVISIONING_PROFILE_B64",
    "APPLE_PROVISIONING_PROFILE_NAME",
    "APPLE_KEYCHAIN_PASSWORD",
    "APPSTORE_API_KEY_ID",
    "APPSTORE_API_ISSUER_ID",
    "APPSTORE_API_KEY_P8_BASE64",
  ],
  android: [
    "ANDROID_KEYSTORE_BASE64",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
    "PLAY_SERVICE_ACCOUNT_JSON",
  ],
} as const;
