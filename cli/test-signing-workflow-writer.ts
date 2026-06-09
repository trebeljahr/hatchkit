/**
 * Workflow + ExportOptions plist render tests.
 *
 * Verifies that:
 *   1. All __HATCHKIT_*__ tokens get substituted with the requested
 *      values across the 4 templates (3 workflows + plist).
 *   2. CI-time tokens (__APPLE_TEAM_ID__, __APPLE_PROVISIONING_PROFILE_NAME__)
 *      survive verbatim — they're substituted at workflow runtime by sed,
 *      not Hatchkit-time.
 *   3. YAML `${{ secrets.X }}` placeholders survive verbatim.
 *   4. Idempotent re-runs: same input twice → second pass writes 0 files.
 *
 * Run: pnpm --filter hatchkit test:signing-workflow-writer
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeSigningWorkflows } from "./src/features/signing/workflow-writer.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "signing-wf-"));
try {
  const args = {
    projectDir: root,
    platforms: ["windows", "ios", "android"] as ("windows" | "ios" | "android")[],
    bundleId: "com.example.tiao",
    appName: "Tiao",
    appSlug: "tiao",
    pnpmVersion: "10.33.2",
    nodeVersion: "24",
  };

  const first = writeSigningWorkflows(args);
  const expectedWritten = [
    ".github/workflows/build-windows.yml",
    ".github/workflows/build-ios.yml",
    ".github/workflows/build-android.yml",
    "scripts/ios-ExportOptions.plist.template",
  ];
  for (const f of expectedWritten) {
    assert(first.written.includes(f), `first run wrote ${f}`);
  }

  // build-android.yml: packageName line should have the bundle ID.
  const android = readFileSync(join(root, ".github/workflows/build-android.yml"), "utf-8");
  assert(
    android.includes("packageName: com.example.tiao"),
    `build-android packageName substituted`,
  );
  assert(
    android.includes("keytool -genkey -v -keystore tiao.keystore"),
    `build-android keystore stem substituted`,
  );
  // Survival of YAML ${{ secrets.X }} expressions.
  assert(
    android.includes("${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}"),
    `build-android secrets expression preserved`,
  );
  assert(
    android.includes("pnpm/action-setup@v4") &&
      android.includes("version: 10.33.2"),
    `build-android pnpm version substituted`,
  );

  // build-ios.yml: __APPLE_TEAM_ID__ survives (CI-time sed token).
  const ios = readFileSync(join(root, ".github/workflows/build-ios.yml"), "utf-8");
  assert(
    ios.includes("s/__APPLE_TEAM_ID__/${APPLE_TEAM_ID}/g"),
    `build-ios preserves __APPLE_TEAM_ID__ for sed`,
  );
  assert(ios.includes("Identifiers → register com.example.tiao"), `build-ios comment substituted`);

  // build-windows.yml: secrets all carry through.
  const win = readFileSync(join(root, ".github/workflows/build-windows.yml"), "utf-8");
  assert(win.includes("${{ secrets.AZURE_TENANT_ID }}"), `build-windows secret expr ok`);

  // ExportOptions.plist.template: bundle ID inserted as key, but
  // __APPLE_TEAM_ID__ + __APPLE_PROVISIONING_PROFILE_NAME__ preserved.
  const plist = readFileSync(join(root, "scripts/ios-ExportOptions.plist.template"), "utf-8");
  assert(plist.includes("<key>com.example.tiao</key>"), `plist bundle-id key`);
  assert(plist.includes("<string>__APPLE_TEAM_ID__</string>"), `plist preserves team id placeholder`);
  assert(
    plist.includes("<string>__APPLE_PROVISIONING_PROFILE_NAME__</string>"),
    `plist preserves profile name placeholder`,
  );

  // Idempotent re-run.
  const second = writeSigningWorkflows(args);
  assert(second.written.length === 0, `re-run wrote ${second.written.length} (expected 0)`);
  assert(second.unchanged.length === 4, `re-run reported ${second.unchanged.length} unchanged`);

  if (failed === 0) {
    console.log("test-signing-workflow-writer: ok");
    process.exit(0);
  } else {
    console.error(`test-signing-workflow-writer: ${failed} assertion(s) failed`);
    process.exit(1);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
