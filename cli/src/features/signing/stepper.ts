/*
 * cli/src/features/signing/stepper.ts — Interactive stepper for
 * collecting per-project signing config.
 *
 * The minimum question set:
 *   1. Bundle ID (default: `<org.packagePrefix>.<projectKebab>`)
 *   2. App name (default: project name from package.json)
 *   3. Platforms (multi-select; defaults detected from project layout)
 *   4. Apple SKU (default: kebab project name)
 *   5. Per-platform skip toggles (escape hatch — e.g. "no LLC yet, skip Apple")
 *
 * Everything else (cert paths, API keys, team IDs) comes from
 * `~/.hatchkit/...` via getSigningOrgConfig(). That's the whole point
 * of this feature — eliminate per-project credential friction.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { confirm, input } from "@inquirer/prompts";
import { multiselect } from "../../utils/multiselect.js";
import { getSigningOrgConfig } from "./org-config.js";
import { projectKebab, suggestBundleId, validateBundleId } from "./project-config.js";
import type { SigningPlatform, SigningProjectConfig } from "./types.js";

export interface SigningStepperInput {
  projectDir: string;
  projectName: string;
  /** When provided, the stepper uses these as defaults / pre-fills
   *  instead of asking. */
  prefill?: Partial<SigningProjectConfig>;
}

export interface SigningStepperResult {
  /** Set when the user opted out entirely. */
  skipped?: string;
  config?: SigningProjectConfig;
}

export async function runSigningStepper(args: SigningStepperInput): Promise<SigningStepperResult> {
  const org = getSigningOrgConfig();
  const detected = detectPlatforms(args.projectDir);
  const defaultName = args.prefill?.appName ?? readPackageName(args.projectDir) ?? args.projectName;
  const slug = projectKebab(args.prefill?.appSlug ?? args.projectName);
  const defaultBundleId =
    args.prefill?.bundleId ?? suggestBundleId(org.google?.packagePrefix, args.projectName);

  const enabled = await confirm({
    message: "Wire signing pipelines (build-{windows,ios,android}.yml + push secrets)?",
    default: args.prefill?.enabled !== false,
  });
  if (!enabled) {
    return { skipped: "user-declined" };
  }

  const bundleId = await input({
    message: "Bundle ID (lowercase, ≥2 segments, no hyphens-in-segment):",
    default: defaultBundleId,
    validate: (raw) => {
      try {
        validateBundleId(raw);
        return true;
      } catch (err) {
        return (err as Error).message;
      }
    },
  });

  const appName = await input({
    message: "App display name:",
    default: defaultName,
    validate: (raw) => (raw.trim().length > 0 ? true : "App name is required."),
  });

  const platforms = await multiselect<SigningPlatform>({
    message: "Platforms:",
    choices: [
      {
        name: `windows — Tauri / MSI + EXE${detected.includes("windows") ? "  (detected: src-tauri/)" : ""}`,
        value: "windows",
        checked: args.prefill?.platforms?.includes("windows") ?? detected.includes("windows"),
      },
      {
        name: `ios — Capacitor → TestFlight${detected.includes("ios") ? "  (detected: ios/)" : ""}`,
        value: "ios",
        checked: args.prefill?.platforms?.includes("ios") ?? detected.includes("ios"),
      },
      {
        name: `android — Capacitor → Play Console${detected.includes("android") ? "  (detected: android/)" : ""}`,
        value: "android",
        checked: args.prefill?.platforms?.includes("android") ?? detected.includes("android"),
      },
    ],
  });

  if (platforms.length === 0) {
    return { skipped: "no-platforms-selected" };
  }

  let appleSku = args.prefill?.appleSku ?? slug;
  if (platforms.includes("ios")) {
    appleSku = await input({
      message: "Apple App Store SKU (unique-per-team string):",
      default: appleSku,
      validate: (raw) => (raw.trim().length > 0 ? true : "SKU is required."),
    });
  }

  return {
    config: {
      enabled: true,
      bundleId: validateBundleId(bundleId),
      appName: appName.trim(),
      appSlug: slug,
      platforms,
      appleSku,
      appleBundleIdResourceId: args.prefill?.appleBundleIdResourceId,
      appleAppRecordId: args.prefill?.appleAppRecordId,
      appleProvisioningProfileId: args.prefill?.appleProvisioningProfileId,
      appleProvisioningProfileName: args.prefill?.appleProvisioningProfileName,
      androidKeystoreLocalPath: args.prefill?.androidKeystoreLocalPath,
      androidKeystoreSecretRef: args.prefill?.androidKeystoreSecretRef,
    },
  };
}

/** Heuristic: a project has the `windows` platform if it has
 *  src-tauri/, `ios` if it has ios/, `android` if it has android/. */
export function detectPlatforms(projectDir: string): SigningPlatform[] {
  const out: SigningPlatform[] = [];
  if (existsSync(join(projectDir, "src-tauri"))) out.push("windows");
  if (existsSync(join(projectDir, "ios"))) out.push("ios");
  if (existsSync(join(projectDir, "android"))) out.push("android");
  return out;
}

function readPackageName(projectDir: string): string | undefined {
  const pkgPath = join(projectDir, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string };
    return pkg.name;
  } catch {
    return undefined;
  }
}
