/*
 * cli/src/features/signing/azure.ts — Trusted Signing preflight.
 *
 * No per-app work — every Hatchkit project that ships Windows reuses the
 * org's Trusted Signing account + certificate profile. This module:
 *   1. Validates the org config has all required fields.
 *   2. Optionally verifies the service principal can read the cert
 *      profile via `az signing trusted certificate-profile show` (gated
 *      on `az` CLI being installed; otherwise we trust the user).
 *   3. Returns the env-var values that will be pushed as repo secrets.
 */

import { exec } from "../../utils/exec.js";
import { getAzureSecret } from "./org-config.js";
import type { OrgAzure } from "./types.js";

export interface AzureSigningValues {
  AZURE_TENANT_ID: string;
  AZURE_CLIENT_ID: string;
  AZURE_CLIENT_SECRET: string;
  AZURE_TS_ACCOUNT: string;
  AZURE_TS_PROFILE: string;
  AZURE_TS_ENDPOINT: string;
}

export async function resolveAzureValues(azure: OrgAzure): Promise<AzureSigningValues> {
  const secret = await getAzureSecret(azure.clientSecretKeychainAccount);
  if (!secret) {
    throw new Error(
      `Azure service principal secret not found in keychain (account: ${azure.clientSecretKeychainAccount}). Re-run \`hatchkit signing org-init\`.`,
    );
  }
  return {
    AZURE_TENANT_ID: azure.tenantId,
    AZURE_CLIENT_ID: azure.clientId,
    AZURE_CLIENT_SECRET: secret,
    AZURE_TS_ACCOUNT: azure.trustedSigningAccount,
    AZURE_TS_PROFILE: azure.certificateProfile,
    AZURE_TS_ENDPOINT: azure.endpoint,
  };
}

/** Best-effort verification that the SP can actually reach the cert
 *  profile. Skips silently when `az` CLI is missing — the workflow run
 *  will catch a wrong SP at sign time anyway, no point blocking
 *  scaffold on a CLI the user may not have. */
export async function verifyAzureCanList(
  azure: OrgAzure,
): Promise<{ ok: boolean; reason?: string }> {
  const azProbe = await exec("az", ["--version"], { silent: true });
  if (azProbe.exitCode !== 0) {
    return { ok: true, reason: "az CLI not installed — skipping live verification." };
  }
  // The Trusted Signing extension is opt-in. Don't try to invoke it —
  // a missing extension would surface as a non-actionable error. List
  // the cert profile via REST instead.
  const tokenRes = await exec(
    "az",
    [
      "account",
      "get-access-token",
      "--resource",
      "https://codesigning.azure.net",
      "--query",
      "accessToken",
      "-o",
      "tsv",
    ],
    { silent: true },
  );
  if (tokenRes.exitCode !== 0) {
    return {
      ok: false,
      reason: "`az account get-access-token` failed — `az login` first or check Azure CLI auth.",
    };
  }
  const token = tokenRes.stdout.trim();
  if (!token) return { ok: false, reason: "Empty access token from az." };
  const url = `${azure.endpoint.replace(/\/$/, "")}/codeSigningAccounts/${azure.trustedSigningAccount}/certificateProfiles/${azure.certificateProfile}?api-version=2024-09-30-preview`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      return {
        ok: false,
        reason: `Trusted Signing profile probe → ${r.status} ${r.statusText}. Service principal may lack the Signer role.`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Trusted Signing probe failed: ${(err as Error).message}` };
  }
}
