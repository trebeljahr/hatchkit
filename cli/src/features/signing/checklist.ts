/*
 * cli/src/features/signing/checklist.ts — Write `.hatchkit/post-signing.md`
 * with the Tier-3 vendor-locked manual items the user still has to
 * complete before installers / TestFlight / Play actually ship.
 *
 * The list is platform-aware so a Windows-only project doesn't get a
 * Play Console checkbox.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SigningPlatform } from "./types.js";

export interface ChecklistInput {
  projectDir: string;
  bundleId: string;
  appName: string;
  platforms: SigningPlatform[];
  ghRepoSlug?: string;
}

export interface ChecklistResult {
  path: string;
  /** Plain-text lines suitable for both the markdown file and a final
   *  terminal print. */
  items: string[];
}

export function writePostSigningChecklist(input: ChecklistInput): ChecklistResult {
  const lines: string[] = [];
  const items: string[] = [];

  function add(item: string) {
    lines.push(`- [ ] ${item}`);
    items.push(item);
  }

  if (input.platforms.includes("ios")) {
    add(
      `Apple identity validation — confirm via developer.apple.com (hours-to-days). Until approved, TestFlight uploads succeed but distribution stalls.`,
    );
    add(
      `App Store Connect → My Apps → ${input.appName} — fill listing copy + screenshots + age rating before promoting from TestFlight to public.`,
    );
  }

  if (input.platforms.includes("android")) {
    add(
      `Google Play Console → Create app for ${input.bundleId} (https://play.google.com/console). The Edits API can't create the initial record.`,
    );
    add(
      `Google Play Console → upload first signed AAB manually. Path: android/app/build/outputs/bundle/release/app-release.aab. Google blocks API uploads until you accept the distribution agreement once.`,
    );
    add(
      `Google Play Console → Setup → API access → grant the service account "Release manager" on this app. Workflow uploads fail with 403 until granted.`,
    );
  }

  if (input.platforms.includes("windows")) {
    add(
      `Azure Trusted Signing identity validation — if the cert profile is still Private Trust pending Public Trust review, expect SmartScreen warnings until the org clears the 3-year verifiable-business bar.`,
    );
  }

  if (input.ghRepoSlug) {
    add(
      `Verify the workflows ran at least once after the first git push. Tag a release (\`git tag v0.0.1 && git push --tags\`) to trigger build-{windows,ios,android}.yml.`,
    );
  }

  const header = [
    `# Post-signing checklist`,
    ``,
    `Hatchkit set up everything it could automatically:`,
    ``,
    `- Bundle ID: \`${input.bundleId}\``,
    `- App name: \`${input.appName}\``,
    `- Platforms: ${input.platforms.join(", ")}`,
    `${input.ghRepoSlug ? `- GitHub repo: \`${input.ghRepoSlug}\`` : ""}`,
    ``,
    `The following items are vendor-locked — you have to click through them yourself.`,
    `Tick them off here as you finish each.`,
    ``,
  ]
    .filter((l) => l !== null && l !== undefined)
    .join("\n");

  const body = lines.join("\n");
  const path = join(input.projectDir, ".hatchkit", "post-signing.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${header}${body}\n`, "utf-8");
  return { path, items };
}
