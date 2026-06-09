/*
 * cli/src/features/signing/org-init.ts — Interactive walkthrough for
 * populating `~/.hatchkit/<conf>/signing.{apple,google,azure}`.
 *
 * Run once per dev machine + per org. Hatchkit never tries to enroll
 * Apple Developer Program or create the Trusted Signing account — it
 * collects the references to artifacts the user already produced
 * (paths to .p12 / .p8 / SA JSON, IDs, endpoint URLs) and stashes the
 * one true secret per provider (P12 password, Azure SP secret) in the
 * keychain.
 */

import { existsSync } from "node:fs";
import { confirm, input, password } from "@inquirer/prompts";
import chalk from "chalk";
import {
  getSigningOrgConfig,
  persistApplePassword,
  persistAzureSecret,
  setSigningOrgConfig,
} from "./org-config.js";
import { resolveUserPath } from "./render.js";
import type { OrgApple, OrgAzure, OrgGoogle } from "./types.js";

export interface OrgInitOptions {
  /** Limit to a subset of providers. Defaults to all three. */
  only?: Array<"apple" | "google" | "azure">;
}

export async function runSigningOrgInit(opts: OrgInitOptions = {}): Promise<void> {
  const targets = opts.only ?? ["apple", "google", "azure"];
  const existing = getSigningOrgConfig();

  console.log(chalk.bold("\nhatchkit signing org-init"));
  console.log(
    chalk.dim(
      `\nThese are per-org one-time credentials reused across every project that ships through Hatchkit.\nNothing per-project is asked here — that's collected by \`hatchkit create\` / \`hatchkit add signing\`.\n`,
    ),
  );

  if (targets.includes("apple")) {
    const wantApple = await confirm({
      message: "Configure Apple App Store signing now?",
      default: !existing.apple,
    });
    if (wantApple) {
      const apple = await collectApple(existing.apple);
      setSigningOrgConfig({ apple });
      console.log(chalk.green("  ✓ Apple org config saved."));
    }
  }

  if (targets.includes("google")) {
    const wantGoogle = await confirm({
      message: "Configure Google Play signing now?",
      default: !existing.google,
    });
    if (wantGoogle) {
      const google = await collectGoogle(existing.google);
      setSigningOrgConfig({ google });
      console.log(chalk.green("  ✓ Google org config saved."));
    }
  }

  if (targets.includes("azure")) {
    const wantAzure = await confirm({
      message: "Configure Azure Trusted Signing (Windows) now?",
      default: !existing.azure,
    });
    if (wantAzure) {
      const azure = await collectAzure(existing.azure);
      setSigningOrgConfig({ azure });
      console.log(chalk.green("  ✓ Azure org config saved."));
    }
  }

  console.log(
    chalk.dim(
      `\nNext: \`hatchkit add <project> signing\` (existing project) or \`hatchkit create\` (new) to wire per-app secrets + workflows.`,
    ),
  );
}

async function collectApple(existing?: OrgApple): Promise<OrgApple> {
  console.log(
    chalk.dim(
      `\n  Need: Apple Distribution .p12 export, App Store Connect API key (.p8) +\n  Key ID + Issuer ID + 10-char Team ID. See DISTRIBUTION.md for the\n  one-time steps if you don't have these yet.\n`,
    ),
  );
  const teamId = await input({
    message: "Apple Team ID (10 chars from developer.apple.com):",
    default: existing?.teamId,
    validate: (raw) =>
      /^[A-Z0-9]{10}$/.test(raw.trim()) ? true : "Expected 10-char alphanumeric Team ID.",
  });
  const p12Path = await input({
    message: "Path to Apple Distribution .p12:",
    default: existing?.distributionP12Path ?? "~/secrets/apple/Distribution.p12",
    validate: (raw) =>
      existsSync(resolveUserPath(raw.trim()))
        ? true
        : `File not found at ${raw}. Re-export the cert and try again.`,
  });
  const p12Password = await password({
    message: "Password for the .p12 (stored in keychain only):",
    mask: "*",
  });
  const keychainAccount = await persistApplePassword(p12Password);

  const apiKeyId = await input({
    message: "App Store Connect API Key ID (10 chars):",
    default: existing?.apiKeyId,
    validate: (raw) => (raw.trim().length > 0 ? true : "Required."),
  });
  const apiIssuerId = await input({
    message: "App Store Connect Issuer ID (UUID):",
    default: existing?.apiIssuerId,
    validate: (raw) => (/^[0-9a-fA-F-]{36}$/.test(raw.trim()) ? true : "Expected a 36-char UUID."),
  });
  const apiKeyP8Path = await input({
    message: "Path to AuthKey_<KEY_ID>.p8:",
    default: existing?.apiKeyP8Path ?? `~/secrets/apple/AuthKey_${apiKeyId}.p8`,
    validate: (raw) =>
      existsSync(resolveUserPath(raw.trim()))
        ? true
        : `File not found at ${raw}. Re-download from App Store Connect → Users and Access → Keys.`,
  });
  return {
    teamId: teamId.trim(),
    distributionP12Path: p12Path.trim(),
    distributionP12PasswordKeychainAccount: keychainAccount,
    apiKeyId: apiKeyId.trim(),
    apiIssuerId: apiIssuerId.trim(),
    apiKeyP8Path: apiKeyP8Path.trim(),
  };
}

async function collectGoogle(existing?: OrgGoogle): Promise<OrgGoogle> {
  console.log(
    chalk.dim(
      `\n  Need: Google Cloud service account JSON with Play Console "Release manager"\n  on the target apps. Generate at console.cloud.google.com → IAM → Service Accounts.\n`,
    ),
  );
  const serviceAccountJsonPath = await input({
    message: "Path to Google Cloud service account JSON:",
    default: existing?.serviceAccountJsonPath ?? "~/secrets/google/play-sa.json",
    validate: (raw) =>
      existsSync(resolveUserPath(raw.trim())) ? true : `File not found at ${raw}.`,
  });
  const packagePrefix = await input({
    message:
      "Default package prefix for new apps (e.g. com.mesozoicprotocol). Leave blank to skip.",
    default: existing?.packagePrefix ?? "",
  });
  return {
    serviceAccountJsonPath: serviceAccountJsonPath.trim(),
    packagePrefix: packagePrefix.trim() || undefined,
  };
}

async function collectAzure(existing?: OrgAzure): Promise<OrgAzure> {
  console.log(
    chalk.dim(
      `\n  Need: Azure Trusted Signing account + certificate profile + service principal.\n  See DISTRIBUTION.md Azure section for the \`az ad sp create-for-rbac\` recipe.\n`,
    ),
  );
  const tenantId = await input({
    message: "Azure tenant ID:",
    default: existing?.tenantId,
    validate: (raw) => (raw.trim().length > 0 ? true : "Required."),
  });
  const clientId = await input({
    message: "Azure service principal client (app) ID:",
    default: existing?.clientId,
    validate: (raw) => (raw.trim().length > 0 ? true : "Required."),
  });
  const clientSecret = await password({
    message: "Azure service principal secret (stored in keychain only):",
    mask: "*",
  });
  const keychainAccount = await persistAzureSecret(clientSecret);
  const trustedSigningAccount = await input({
    message: "Trusted Signing account name (Microsoft.CodeSigning resource):",
    default: existing?.trustedSigningAccount,
    validate: (raw) => (raw.trim().length > 0 ? true : "Required."),
  });
  const certificateProfile = await input({
    message: "Certificate profile name (Public Trust if eligible, else Private Trust):",
    default: existing?.certificateProfile,
    validate: (raw) => (raw.trim().length > 0 ? true : "Required."),
  });
  const endpoint = await input({
    message: "Trusted Signing endpoint URL (e.g. https://wus2.codesigning.azure.net):",
    default: existing?.endpoint,
    validate: (raw) =>
      /^https:\/\/[a-z0-9-]+\.codesigning\.azure\.net\/?$/.test(raw.trim())
        ? true
        : "Expected https://<region>.codesigning.azure.net format.",
  });
  return {
    tenantId: tenantId.trim(),
    clientId: clientId.trim(),
    clientSecretKeychainAccount: keychainAccount,
    trustedSigningAccount: trustedSigningAccount.trim(),
    certificateProfile: certificateProfile.trim(),
    endpoint: endpoint.trim(),
  };
}
