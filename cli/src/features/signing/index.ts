/*
 * cli/src/features/signing/index.ts — Top-level entrypoint for the
 * signing feature. ALL three command paths (`hatchkit create`,
 * `hatchkit adopt`, `hatchkit add signing`) route through
 * {@link runSigningSetup} so the stepper + preflight + API calls have a
 * single home — no copy-paste in the command handlers.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { ownerFromRemote, repoSlugFromRemote } from "../../deploy/gh-actions-secrets.js";
import { exec } from "../../utils/exec.js";
import { provisionAppleForProject } from "./apple.js";
import { resolveAzureValues, verifyAzureCanList } from "./azure.js";
import { writePostSigningChecklist } from "./checklist.js";
import { SIGNING_SECRET_NAMES, pushSigningSecrets } from "./github.js";
import {
  ensureLocalSigningDir,
  generateAndroidKeystore,
  generateKeystorePassword,
  readPlayServiceAccount,
} from "./google.js";
import { rewriteNativeConfigs } from "./native-rewriter.js";
import { getApplePassword, getSigningOrgConfig } from "./org-config.js";
import { runPreflight } from "./preflight.js";
import { readSigningProjectConfig, writeSigningProjectConfig } from "./project-config.js";
import { resolveUserPath } from "./render.js";
import { runSigningStepper } from "./stepper.js";
import type { RunSigningSetupOptions, SigningPlatform, SigningSetupAudit } from "./types.js";
import { writeSigningWorkflows } from "./workflow-writer.js";

export * from "./types.js";
export { runSigningOrgInit } from "./org-init.js";
export { detectPlatforms } from "./stepper.js";

const DEFAULT_PNPM_VERSION = "10.33.2";
const DEFAULT_NODE_VERSION = "24";

/** Top-level orchestrator. Idempotent across re-runs. Never throws on
 *  user-recoverable preflight failures — surfaces them in the audit and
 *  returns ok=false so the caller can decide what to do next.
 *
 *  Hard errors (network failures mid-create, ASC API 5xx, etc.)
 *  propagate so a higher-level rollback ledger can mop up. */
export async function runSigningSetup(opts: RunSigningSetupOptions): Promise<SigningSetupAudit> {
  const audit: SigningSetupAudit = {
    ok: false,
    mode: opts.mode,
    platforms: [],
    workflowFiles: [],
    pushedSecrets: [],
    rewrittenFiles: [],
    manualResidue: [],
    skipReasons: {},
  };

  if (opts.skip) {
    audit.ok = true;
    audit.manualResidue.push(
      "Signing skipped via --no-signing. Re-run `hatchkit add <project> signing` when ready.",
    );
    return audit;
  }

  // 1. Collect / reuse project config.
  const existingProject = readSigningProjectConfig(opts.projectDir);
  const stepper = await runSigningStepper({
    projectDir: opts.projectDir,
    projectName: opts.projectName,
    prefill: {
      ...existingProject,
      bundleId: opts.bundleId ?? existingProject?.bundleId,
      appName: opts.appName ?? existingProject?.appName,
      platforms: opts.platforms ?? existingProject?.platforms,
    },
  });
  if (stepper.skipped) {
    audit.ok = true;
    audit.manualResidue.push(`Signing skipped: ${stepper.skipped}.`);
    return audit;
  }
  const project = stepper.config!;
  audit.bundleId = project.bundleId;
  audit.appName = project.appName;
  audit.platforms = project.platforms;

  // 2. Resolve GitHub repo slug.
  const ghRepoSlug = opts.ghRepoSlug ?? (await detectGhRepoSlug(opts.projectDir));

  // 3. Preflight — read-only.
  const pre = await runPreflight({
    projectDir: opts.projectDir,
    platforms: project.platforms,
    ghRepoSlug,
  });
  if (pre.warnings.length > 0) {
    for (const w of pre.warnings) {
      console.log(chalk.yellow(`  ⚠ ${w.name}: ${w.detail ?? ""}`));
    }
  }
  if (!pre.ok) {
    for (const e of pre.errors) {
      console.log(chalk.red(`  ✗ ${e.name}: ${e.detail ?? ""}`));
    }
    audit.ok = false;
    audit.manualResidue.push(
      "Preflight failed. Resolve the errors above and re-run the same command.",
    );
    return audit;
  }

  if (opts.dryRun) {
    audit.ok = true;
    audit.manualResidue.push(
      `Dry run: would write workflows + push ${countPlannedSecrets(project.platforms)} secrets + rewrite native configs for ${project.platforms.join(", ")}.`,
    );
    return audit;
  }

  // 4. Persist the user's choices to the manifest BEFORE doing any
  //    network calls — so a SIGKILL mid-API call leaves a project that
  //    re-runs idempotently.
  let stored = writeSigningProjectConfig(opts.projectDir, project);
  if (!stored) {
    audit.manualResidue.push(
      "No .hatchkit.json found — Hatchkit will skip persisting signing IDs into the manifest. Run `hatchkit adopt` or `hatchkit create` first.",
    );
  }

  // 5. Native config rewrites — runs in-place against the user's
  //    already-scaffolded tauri/capacitor/android/ios files.
  const rewrite = rewriteNativeConfigs({
    projectDir: opts.projectDir,
    bundleId: project.bundleId,
    appName: project.appName,
  });
  audit.rewrittenFiles = rewrite.rewritten;

  // 6. Write the workflows + ExportOptions plist template.
  const pnpmVersion =
    opts.pnpmVersion ??
    readPackageJsonField(opts.projectDir, "packageManager")?.split("@")[1] ??
    DEFAULT_PNPM_VERSION;
  const nodeVersion =
    opts.nodeVersion ??
    readPackageJsonField(opts.projectDir, "engines.node")?.replace(/[^0-9.]/g, "") ??
    DEFAULT_NODE_VERSION;
  const wf = writeSigningWorkflows({
    projectDir: opts.projectDir,
    platforms: project.platforms,
    bundleId: project.bundleId,
    appName: project.appName,
    appSlug: project.appSlug,
    pnpmVersion,
    nodeVersion,
  });
  audit.workflowFiles = wf.written;
  if (opts.ledger) {
    for (const path of wf.written) {
      opts.ledger.record({ kind: "signingWorkflowFile", path: join(opts.projectDir, path) });
    }
  }

  // 7. Per-platform provisioning + secret push.
  const secrets: Record<string, string> = {};
  const ledgerNotes: string[] = [];

  if (project.platforms.includes("ios")) {
    const apple = getSigningOrgConfig().apple;
    if (!apple) {
      audit.skipReasons.ios = "missing org apple config";
    } else {
      const spinner = ora("iOS: provisioning App Store Connect resources").start();
      try {
        const result = await provisionAppleForProject({
          apple,
          project: {
            bundleId: project.bundleId,
            appName: project.appName,
            appSlug: project.appSlug,
            appleSku: project.appleSku,
          },
          reuse: {
            appleBundleIdResourceId: stored?.appleBundleIdResourceId,
            appleAppRecordId: stored?.appleAppRecordId,
            appleProvisioningProfileId: stored?.appleProvisioningProfileId,
            appleProvisioningProfileName: stored?.appleProvisioningProfileName,
          },
        });
        stored = writeSigningProjectConfig(opts.projectDir, {
          appleBundleIdResourceId: result.bundleIdResourceId,
          appleAppRecordId: result.appRecordId,
          appleProvisioningProfileId: result.profileId,
          appleProvisioningProfileName: result.profileName,
        });
        audit.appleBundleIdResourceId = result.bundleIdResourceId;
        audit.appleAppRecordId = result.appRecordId;
        audit.appleProvisioningProfileId = result.profileId;
        audit.appleProvisioningProfileName = result.profileName;
        if (opts.ledger) {
          if (result.createdBundleId) {
            opts.ledger.record({
              kind: "appleBundleId",
              resourceId: result.bundleIdResourceId,
              identifier: project.bundleId,
            });
          }
          if (result.createdAppRecord) {
            opts.ledger.record({
              kind: "appleAppRecord",
              resourceId: result.appRecordId,
              bundleId: project.bundleId,
            });
          }
          if (result.createdProfile) {
            opts.ledger.record({
              kind: "appleProvisioningProfile",
              resourceId: result.profileId,
              name: result.profileName,
            });
          }
        }

        const p12Password = await getApplePassword(apple.distributionP12PasswordKeychainAccount);
        if (!p12Password) {
          throw new Error(
            `Apple .p12 password missing from keychain (account: ${apple.distributionP12PasswordKeychainAccount}). Re-run \`hatchkit signing org-init\`.`,
          );
        }
        const p12B64 = readFileSync(resolveUserPath(apple.distributionP12Path)).toString("base64");
        const p8B64 = readFileSync(resolveUserPath(apple.apiKeyP8Path)).toString("base64");

        secrets.APPLE_TEAM_ID = apple.teamId;
        secrets.APPLE_CERT_P12_BASE64 = p12B64;
        secrets.APPLE_CERT_P12_PASSWORD = p12Password;
        secrets.APPLE_PROVISIONING_PROFILE_B64 = result.profileBase64;
        secrets.APPLE_PROVISIONING_PROFILE_NAME = result.profileName;
        secrets.APPLE_KEYCHAIN_PASSWORD = generateKeystorePassword();
        secrets.APPSTORE_API_KEY_ID = apple.apiKeyId;
        secrets.APPSTORE_API_ISSUER_ID = apple.apiIssuerId;
        secrets.APPSTORE_API_KEY_P8_BASE64 = p8B64;
        spinner.succeed("iOS: App Store Connect resources resolved.");
      } catch (err) {
        spinner.fail("iOS: provisioning failed.");
        audit.skipReasons.ios = (err as Error).message;
      }
    }
  }

  if (project.platforms.includes("android")) {
    const google = getSigningOrgConfig().google;
    if (!google) {
      audit.skipReasons.android = "missing org google config";
    } else {
      try {
        // Validate the SA JSON now — bad JSON should not corrupt the
        // workflow secret.
        const sa = readPlayServiceAccount(google);

        // Generate or reuse keystore.
        const localDir = ensureLocalSigningDir(opts.projectDir);
        let keystoreInfo: {
          keystorePath: string;
          base64: string;
          storePassword: string;
          keyPassword: string;
          alias: string;
        };
        if (stored?.androidKeystoreLocalPath && existsSync(stored.androidKeystoreLocalPath)) {
          // Reuse — but we don't have the passwords in memory; require
          // a manual --rotate path. For now: skip pushing keystore
          // secrets when reusing.
          keystoreInfo = {
            keystorePath: stored.androidKeystoreLocalPath,
            base64: readFileSync(stored.androidKeystoreLocalPath).toString("base64"),
            storePassword: "",
            keyPassword: "",
            alias: "upload",
          };
          ledgerNotes.push(
            "Android: reused existing keystore — passwords NOT re-pushed. Run `hatchkit signing rotate-keystore <project>` if you need to rotate.",
          );
        } else {
          const storePass = generateKeystorePassword();
          const keyPass = generateKeystorePassword();
          const result = await generateAndroidKeystore({
            outputDir: localDir,
            fileStem: project.appSlug,
            appName: project.appName,
            storePassword: storePass,
            keyPassword: keyPass,
          });
          stored = writeSigningProjectConfig(opts.projectDir, {
            androidKeystoreLocalPath: result.keystorePath,
            androidKeystoreSecretRef: "github://ANDROID_KEYSTORE_BASE64",
          });
          keystoreInfo = result;
          opts.ledger?.record({
            kind: "androidKeystoreLocal",
            path: result.keystorePath,
          });
        }

        audit.androidKeystoreLocalPath = keystoreInfo.keystorePath;
        audit.androidKeystoreSecretRef = "github://ANDROID_KEYSTORE_BASE64";

        secrets.ANDROID_KEYSTORE_BASE64 = keystoreInfo.base64;
        if (keystoreInfo.storePassword) {
          secrets.ANDROID_KEYSTORE_PASSWORD = keystoreInfo.storePassword;
          secrets.ANDROID_KEY_PASSWORD = keystoreInfo.keyPassword;
        }
        secrets.ANDROID_KEY_ALIAS = keystoreInfo.alias;
        secrets.PLAY_SERVICE_ACCOUNT_JSON = sa.raw;
      } catch (err) {
        audit.skipReasons.android = (err as Error).message;
      }
    }
  }

  if (project.platforms.includes("windows")) {
    const azure = getSigningOrgConfig().azure;
    if (!azure) {
      audit.skipReasons.windows = "missing org azure config";
    } else {
      try {
        const verify = await verifyAzureCanList(azure);
        if (!verify.ok) {
          audit.manualResidue.push(`Azure preflight: ${verify.reason}`);
        } else if (verify.reason) {
          ledgerNotes.push(`Azure: ${verify.reason}`);
        }
        const values = await resolveAzureValues(azure);
        Object.assign(secrets, values);
      } catch (err) {
        audit.skipReasons.windows = (err as Error).message;
      }
    }
  }

  // 8. Push secrets.
  if (Object.keys(secrets).length > 0) {
    if (!ghRepoSlug) {
      audit.manualResidue.push(
        "No GitHub repo slug — secrets were NOT pushed. Run `gh secret set` manually or set the repo remote and re-run.",
      );
    } else {
      const push = await pushSigningSecrets({
        projectDir: opts.projectDir,
        repoSlug: ghRepoSlug,
        secrets,
      });
      audit.pushedSecrets = push.pushed;
      if (opts.ledger) {
        for (const name of push.pushed) {
          opts.ledger.record({ kind: "ghSigningSecret", repo: ghRepoSlug, name });
        }
      }
      if (push.failed.length > 0) {
        for (const f of push.failed) {
          audit.manualResidue.push(`gh secret set ${f.name} failed: ${f.error}`);
        }
      }
    }
  }

  // 9. Write the post-signing checklist.
  const check = writePostSigningChecklist({
    projectDir: opts.projectDir,
    bundleId: project.bundleId,
    appName: project.appName,
    platforms: project.platforms,
    ghRepoSlug,
  });
  audit.postSigningChecklistPath = check.path;
  audit.manualResidue.push(...check.items);

  // 10. Print human summary.
  audit.ok = true;
  console.log(chalk.bold("\nSigning setup complete."));
  console.log(`  Bundle ID:      ${project.bundleId}`);
  console.log(`  App name:       ${project.appName}`);
  console.log(`  Platforms:      ${project.platforms.join(", ")}`);
  if (audit.workflowFiles.length > 0) {
    console.log(`  Workflows:      ${audit.workflowFiles.join(", ")}`);
  }
  if (audit.rewrittenFiles.length > 0) {
    console.log(`  Rewrote:        ${audit.rewrittenFiles.join(", ")}`);
  }
  if (audit.pushedSecrets.length > 0) {
    console.log(`  Pushed secrets: ${audit.pushedSecrets.join(", ")}`);
  }
  if (Object.keys(audit.skipReasons).length > 0) {
    for (const [p, reason] of Object.entries(audit.skipReasons)) {
      console.log(chalk.yellow(`  Skipped ${p}: ${reason}`));
    }
  }
  console.log(chalk.dim(`  Checklist:      ${audit.postSigningChecklistPath}`));
  for (const note of ledgerNotes) console.log(chalk.dim(`  · ${note}`));
  console.log("");
  return audit;
}

function countPlannedSecrets(platforms: SigningPlatform[]): number {
  let total = 0;
  for (const p of platforms) total += SIGNING_SECRET_NAMES[p].length;
  return total;
}

async function detectGhRepoSlug(projectDir: string): Promise<string | undefined> {
  const res = await exec("git", ["-C", projectDir, "remote", "get-url", "origin"], {
    silent: true,
  });
  if (res.exitCode !== 0) return undefined;
  return repoSlugFromRemote(res.stdout.trim());
}

function readPackageJsonField(projectDir: string, dotted: string): string | undefined {
  const path = join(projectDir, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const parts = dotted.split(".");
    let cur: unknown = raw;
    for (const seg of parts) {
      if (cur && typeof cur === "object") {
        cur = (cur as Record<string, unknown>)[seg];
      } else {
        return undefined;
      }
    }
    return typeof cur === "string" ? cur : undefined;
  } catch {
    return undefined;
  }
}

void ownerFromRemote; // re-exported below for caller convenience
export { ownerFromRemote };
