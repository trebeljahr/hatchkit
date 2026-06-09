/*
 * cli/src/features/signing/workflow-writer.ts — Write the three
 * signing workflow files + the iOS ExportOptions plist template into
 * the user's project, with __HATCHKIT_*__ token substitution.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type RenderTokens, renderSigningTemplate } from "./render.js";
import type { SigningPlatform } from "./types.js";

export interface WriteWorkflowsInput {
  projectDir: string;
  platforms: SigningPlatform[];
  bundleId: string;
  appName: string;
  appSlug: string;
  pnpmVersion: string;
  nodeVersion: string;
}

export interface WriteWorkflowsResult {
  written: string[];
  /** Files whose on-disk contents already matched the rendered
   *  template — counted toward idempotency, NOT toward `written`. */
  unchanged: string[];
}

const WORKFLOW_TEMPLATES: Record<SigningPlatform, string> = {
  windows: "workflows/build-windows.yml",
  ios: "workflows/build-ios.yml",
  android: "workflows/build-android.yml",
};

const WORKFLOW_DEST: Record<SigningPlatform, string> = {
  windows: ".github/workflows/build-windows.yml",
  ios: ".github/workflows/build-ios.yml",
  android: ".github/workflows/build-android.yml",
};

export function writeSigningWorkflows(input: WriteWorkflowsInput): WriteWorkflowsResult {
  const tokens: RenderTokens = {
    BUNDLE_ID: input.bundleId,
    APP_NAME: input.appName,
    APP_SLUG: input.appSlug,
    PNPM_VERSION: input.pnpmVersion,
    NODE_VERSION: input.nodeVersion,
  };

  const written: string[] = [];
  const unchanged: string[] = [];

  for (const p of input.platforms) {
    const rendered = renderSigningTemplate(WORKFLOW_TEMPLATES[p], tokens);
    const dest = join(input.projectDir, WORKFLOW_DEST[p]);
    const result = writeIfChanged(dest, rendered);
    if (result === "written") written.push(WORKFLOW_DEST[p]);
    else unchanged.push(WORKFLOW_DEST[p]);
  }

  // iOS only: also write the ExportOptions plist template.
  if (input.platforms.includes("ios")) {
    const rendered = renderSigningTemplate("ios/ExportOptions.plist.template", tokens);
    const dest = join(input.projectDir, "scripts/ios-ExportOptions.plist.template");
    const result = writeIfChanged(dest, rendered);
    if (result === "written") written.push("scripts/ios-ExportOptions.plist.template");
    else unchanged.push("scripts/ios-ExportOptions.plist.template");
  }

  return { written, unchanged };
}

function writeIfChanged(absPath: string, content: string): "written" | "unchanged" {
  if (existsSync(absPath)) {
    const cur = readFileSync(absPath, "utf-8");
    if (cur === content) return "unchanged";
  }
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf-8");
  return "written";
}
