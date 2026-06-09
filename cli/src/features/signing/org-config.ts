/*
 * cli/src/features/signing/org-config.ts — Org-level (Tier 1) signing
 * config: Apple/Google/Azure credentials reused across every project
 * that team ships.
 *
 * Storage:
 *   · Non-secret fields (paths, IDs, endpoints) → Conf-backed JSON
 *     under `signing.{apple,google,azure}`, same `getStore()` as the
 *     rest of CliConfig.
 *   · Secret fields (P12 password, Azure SP secret) → OS keychain via
 *     {@link setSecret} / {@link getSecret} under the conventional
 *     `signing:<provider>:<name>` account.
 *
 * Hatchkit refuses to mutate any per-project signing resource until
 * the relevant org block exists. `hatchkit signing org-init` is the
 * one interactive command that populates it.
 */

import { existsSync } from "node:fs";
import { getStore } from "../../config.js";
import { getSecret, setSecret } from "../../utils/secrets.js";
import { resolveUserPath } from "./render.js";
import type { OrgApple, OrgAzure, OrgGoogle, SigningOrgConfig, SigningPlatform } from "./types.js";

const APPLE_P12_PWD_ACCOUNT = "signing:apple:p12-password";
const AZURE_SP_SECRET_ACCOUNT = "signing:azure:sp-secret";

/** Read the org-level signing block. Never reads keychain secrets. */
export function getSigningOrgConfig(): SigningOrgConfig {
  const store = getStore();
  const raw = (store as unknown as { get(k: string): unknown }).get("signing") as
    | SigningOrgConfig
    | undefined;
  return raw ?? {};
}

/** Patch the org-level signing block. Stores plain fields only. */
export function setSigningOrgConfig(patch: Partial<SigningOrgConfig>): void {
  const current = getSigningOrgConfig();
  const next: SigningOrgConfig = { ...current, ...patch };
  const store = getStore() as unknown as { set(k: string, v: unknown): void };
  store.set("signing", next);
}

/** Store the Apple .p12 password in the keychain and return the
 *  account name to record in the org config. */
export async function persistApplePassword(password: string): Promise<string> {
  await setSecret(APPLE_P12_PWD_ACCOUNT, password);
  return APPLE_P12_PWD_ACCOUNT;
}

export async function getApplePassword(account: string): Promise<string | null> {
  return getSecret(account);
}

/** Store the Azure service principal secret in the keychain. */
export async function persistAzureSecret(secret: string): Promise<string> {
  await setSecret(AZURE_SP_SECRET_ACCOUNT, secret);
  return AZURE_SP_SECRET_ACCOUNT;
}

export async function getAzureSecret(account: string): Promise<string | null> {
  return getSecret(account);
}

/** Whether the org config has enough fields to sign for a given
 *  platform. Doesn't validate file existence — see
 *  {@link validateOrgPlatform} for that. */
export function hasOrgConfigFor(platform: SigningPlatform): boolean {
  const org = getSigningOrgConfig();
  switch (platform) {
    case "ios":
      return Boolean(org.apple);
    case "android":
      return Boolean(org.google);
    case "windows":
      return Boolean(org.azure);
  }
}

export interface OrgValidationResult {
  ok: boolean;
  /** Reasons the org config is unusable for this platform. Empty when ok. */
  reasons: string[];
}

/** Validate that the org config + referenced files exist on disk.
 *  Cheap synchronous filesystem check, no network. */
export function validateOrgPlatform(platform: SigningPlatform): OrgValidationResult {
  const org = getSigningOrgConfig();
  const reasons: string[] = [];

  if (platform === "ios") {
    const a = org.apple;
    if (!a) {
      reasons.push(
        "Apple signing not configured — run `hatchkit signing org-init` and select Apple.",
      );
    } else {
      const p12 = resolveUserPath(a.distributionP12Path);
      const p8 = resolveUserPath(a.apiKeyP8Path);
      if (!existsSync(p12))
        reasons.push(
          `Apple Distribution .p12 not readable at ${a.distributionP12Path} — fix the path or re-export the cert.`,
        );
      if (!existsSync(p8))
        reasons.push(
          `App Store Connect API .p8 key not readable at ${a.apiKeyP8Path} — re-download from App Store Connect → Users and Access → Keys.`,
        );
      if (!a.teamId || a.teamId.length !== 10)
        reasons.push(`Apple team ID looks wrong (expected 10 chars, got "${a.teamId ?? ""}").`);
      if (!a.apiKeyId) reasons.push("App Store Connect API Key ID is missing.");
      if (!a.apiIssuerId) reasons.push("App Store Connect Issuer ID is missing.");
    }
  } else if (platform === "android") {
    const g = org.google;
    if (!g) {
      reasons.push(
        "Google Play signing not configured — run `hatchkit signing org-init` and select Google Play.",
      );
    } else {
      const sa = resolveUserPath(g.serviceAccountJsonPath);
      if (!existsSync(sa))
        reasons.push(
          `Play Service Account JSON not readable at ${g.serviceAccountJsonPath} — re-download from Google Cloud Console.`,
        );
    }
  } else if (platform === "windows") {
    const z = org.azure;
    if (!z) {
      reasons.push(
        "Azure Trusted Signing not configured — run `hatchkit signing org-init` and select Azure.",
      );
    } else {
      if (!z.tenantId) reasons.push("Azure tenant ID is missing.");
      if (!z.clientId) reasons.push("Azure client ID is missing.");
      if (!z.trustedSigningAccount) reasons.push("Azure Trusted Signing account name is missing.");
      if (!z.certificateProfile) reasons.push("Azure certificate profile name is missing.");
      if (!z.endpoint) reasons.push("Azure Trusted Signing endpoint URL is missing.");
    }
  }

  return { ok: reasons.length === 0, reasons };
}

export type { OrgApple, OrgGoogle, OrgAzure, SigningOrgConfig };
