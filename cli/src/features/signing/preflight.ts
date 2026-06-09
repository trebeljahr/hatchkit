/*
 * cli/src/features/signing/preflight.ts — Read-only checks run BEFORE
 * any mutation. If anything fails, runSigningSetup aborts with the full
 * list of remediation hints so the user fixes it once instead of
 * watching a half-state roll through.
 *
 * Network-cheap. Hits:
 *   · `gh auth status` + admin perms on target repo
 *   · `keytool -version`
 *   · `xcodebuild -version` (only when ios platform requested + macOS)
 *   · org.yaml apple/google/azure plus their referenced files
 *   · `az account show` (Azure) — optional, surfaces as a warning if
 *     `az` itself is missing rather than a hard fail
 *   · Existing workflow files (.github/workflows/build-{ios,android,
 *     windows}.yml) — warns about overwrite when present
 *   · Existing local Android keystore — warns if signing.enabled but
 *     keystore.jks missing
 */

import { existsSync } from "node:fs";
import { platform as nodePlatform } from "node:os";
import { join } from "node:path";
import { exec } from "../../utils/exec.js";
import { hasOrgConfigFor, validateOrgPlatform } from "./org-config.js";
import { readSigningProjectConfig } from "./project-config.js";
import type { SigningPlatform } from "./types.js";

export interface PreflightCheck {
  name: string;
  ok: boolean;
  /** Hard-fail when severity === "error"; soft warning otherwise. */
  severity: "error" | "warning";
  detail?: string;
}

export interface PreflightResult {
  ok: boolean;
  errors: PreflightCheck[];
  warnings: PreflightCheck[];
  all: PreflightCheck[];
}

export interface PreflightOptions {
  projectDir: string;
  platforms: SigningPlatform[];
  /** Repo slug `owner/repo` — if missing, the gh-auth check downgrades
   *  to a warning. */
  ghRepoSlug?: string;
}

export async function runPreflight(opts: PreflightOptions): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];

  // gh auth.
  checks.push(await checkGhAuth(opts.ghRepoSlug));

  // keytool — needed for Android keystore gen.
  if (opts.platforms.includes("android")) {
    checks.push(await checkKeytool());
  }

  // xcodebuild — needed for iOS (only on macOS).
  if (opts.platforms.includes("ios")) {
    checks.push(checkMacOs());
    checks.push(await checkXcodebuild());
  }

  // Per-platform org config.
  for (const p of opts.platforms) {
    if (!hasOrgConfigFor(p)) {
      checks.push({
        name: `${p}: org config`,
        ok: false,
        severity: "error",
        detail: `No org-level signing config for ${p}. Run \`hatchkit signing org-init\` first.`,
      });
      continue;
    }
    const v = validateOrgPlatform(p);
    if (!v.ok) {
      for (const reason of v.reasons) {
        checks.push({
          name: `${p}: org config`,
          ok: false,
          severity: "error",
          detail: reason,
        });
      }
    } else {
      checks.push({
        name: `${p}: org config`,
        ok: true,
        severity: "error",
      });
    }
  }

  // Azure CLI presence — soft check.
  if (opts.platforms.includes("windows")) {
    checks.push(await checkAzCli());
  }

  // Existing workflow files — soft warn if any of the 3 already exist.
  for (const p of opts.platforms) {
    const path = join(opts.projectDir, ".github", "workflows", workflowFilename(p));
    if (existsSync(path)) {
      checks.push({
        name: `${p}: workflow file`,
        ok: false,
        severity: "warning",
        detail: `Will overwrite existing ${path}. Hatchkit only rewrites tokens it owns; user-added steps survive only if you've kept the upstream template shape.`,
      });
    }
  }

  // Android keystore present-but-missing detection.
  if (opts.platforms.includes("android")) {
    const sig = readSigningProjectConfig(opts.projectDir);
    if (sig?.androidKeystoreLocalPath && !existsSync(sig.androidKeystoreLocalPath)) {
      checks.push({
        name: "android: local keystore",
        ok: false,
        severity: "error",
        detail: `Manifest references keystore at ${sig.androidKeystoreLocalPath} but file is missing. Restore from backup before re-running — regenerating would break Play uploads.`,
      });
    }
  }

  const errors = checks.filter((c) => !c.ok && c.severity === "error");
  const warnings = checks.filter((c) => !c.ok && c.severity === "warning");
  return { ok: errors.length === 0, errors, warnings, all: checks };
}

function workflowFilename(p: SigningPlatform): string {
  switch (p) {
    case "windows":
      return "build-windows.yml";
    case "ios":
      return "build-ios.yml";
    case "android":
      return "build-android.yml";
  }
}

async function checkGhAuth(repoSlug?: string): Promise<PreflightCheck> {
  const res = await exec("gh", ["auth", "status"], { silent: true });
  if (res.exitCode !== 0) {
    return {
      name: "gh auth",
      ok: false,
      severity: "error",
      detail: "`gh auth status` failed — run `gh auth login` and retry.",
    };
  }
  if (repoSlug) {
    const probe = await exec("gh", ["repo", "view", repoSlug, "--json", "viewerPermission"], {
      silent: true,
    });
    if (probe.exitCode !== 0) {
      return {
        name: "gh repo access",
        ok: false,
        severity: "error",
        detail: `Cannot view ${repoSlug} with current GitHub auth — re-run \`gh auth login\` with admin scope.`,
      };
    }
    // viewerPermission is one of "ADMIN" | "MAINTAIN" | "WRITE" | "TRIAGE" | "READ".
    if (!/ADMIN|MAINTAIN/.test(probe.stdout)) {
      return {
        name: "gh repo access",
        ok: false,
        severity: "error",
        detail: `Need admin/maintain on ${repoSlug} to push Actions secrets (current: ${probe.stdout.trim()}).`,
      };
    }
  }
  return { name: "gh auth", ok: true, severity: "error" };
}

async function checkKeytool(): Promise<PreflightCheck> {
  const res = await exec("keytool", ["-help"], { silent: true });
  if (res.exitCode !== 0) {
    return {
      name: "keytool",
      ok: false,
      severity: "error",
      detail:
        "`keytool` not found. Install a JDK (17+) — e.g. `brew install temurin@17` on macOS — and retry.",
    };
  }
  return { name: "keytool", ok: true, severity: "error" };
}

function checkMacOs(): PreflightCheck {
  if (nodePlatform() !== "darwin") {
    return {
      name: "macOS host",
      ok: false,
      severity: "error",
      detail:
        "iOS signing requires macOS for xcodebuild + keychain APIs. Skip iOS with `--platforms windows,android` or run from a Mac.",
    };
  }
  return { name: "macOS host", ok: true, severity: "error" };
}

async function checkXcodebuild(): Promise<PreflightCheck> {
  if (nodePlatform() !== "darwin") {
    return { name: "xcodebuild", ok: true, severity: "error" };
  }
  const res = await exec("xcodebuild", ["-version"], { silent: true });
  if (res.exitCode !== 0) {
    return {
      name: "xcodebuild",
      ok: false,
      severity: "error",
      detail:
        "`xcodebuild` not found. Install Xcode + Command Line Tools (`xcode-select --install`).",
    };
  }
  return { name: "xcodebuild", ok: true, severity: "error" };
}

async function checkAzCli(): Promise<PreflightCheck> {
  const res = await exec("az", ["account", "show"], { silent: true });
  if (res.exitCode !== 0) {
    return {
      name: "az cli",
      ok: false,
      severity: "warning",
      detail:
        "`az account show` failed — install Azure CLI + `az login` to enable Trusted Signing verification at preflight time. Workflow will still run if the SP secret in repo is valid.",
    };
  }
  return { name: "az cli", ok: true, severity: "warning" };
}
