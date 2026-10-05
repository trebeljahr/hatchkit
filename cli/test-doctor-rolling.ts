/** Coolify omitting settings must not produce a false rolling-deploy green. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProjectRollingDeployState } from "./src/doctor.js";
import { CoolifyApi } from "./src/utils/coolify-api.js";

const dir = mkdtempSync(join(tmpdir(), "hatchkit-doctor-rolling-"));
const originalFetch = globalThis.fetch;
const base = {
  uuid: "app",
  name: "site",
  build_pack: "dockerimage",
  health_check_enabled: true,
  health_check_path: "/",
  health_check_interval: 2,
  health_check_timeout: 5,
  health_check_retries: 5,
  health_check_start_period: 15,
};
let raw: Record<string, unknown> = { ...base };
globalThis.fetch = async () => new Response(JSON.stringify(raw), { status: 200 });
const api = new CoolifyApi({ url: "https://coolify.invalid", token: "fixture" });
try {
  writeFileSync(
    join(dir, ".hatchkit.json"),
    JSON.stringify({
      version: 4,
      name: "site",
      domain: "site.example",
      surfaces: "static",
      topology: "single-origin",
      coolifyRuntime: "image",
      deploymentMode: "coolify",
      features: [],
    }),
  );
  for (const [settings, expected] of [
    [null, { isConsistentContainerNameEnabled: undefined, customInternalName: undefined }],
    [
      { is_consistent_container_name_enabled: false, custom_internal_name: null },
      { isConsistentContainerNameEnabled: false, customInternalName: null },
    ],
    [
      { is_consistent_container_name_enabled: 1, custom_internal_name: "fixed" },
      { isConsistentContainerNameEnabled: true, customInternalName: "fixed" },
    ],
  ] as const) {
    raw = { ...base, settings };
    const app = await api.getApplication("app");
    assert.equal(app.isConsistentContainerNameEnabled, expected.isConsistentContainerNameEnabled);
    assert.equal(app.customInternalName, expected.customInternalName);
    const results = await checkProjectRollingDeployState(dir, {
      api: {
        async listApplications() {
          return [{ uuid: "app", name: "site" }];
        },
        async getApplication() {
          return app;
        },
      },
    });
    assert.equal(results.length, 1);
    assert.equal(
      results[0].status,
      settings && !expected.isConsistentContainerNameEnabled ? "ok" : "warn",
    );
    if (settings === null) assert.match(results[0].detail, /unverified/);
  }
  raw = { ...base, is_consistent_container_name_enabled: "0", custom_internal_name: "" };
  const topLevel = await api.getApplication("app");
  assert.equal(topLevel.isConsistentContainerNameEnabled, false);
  assert.equal(topLevel.customInternalName, "");
  // Auto-deploy lives on application_settings; beta.469 sends `settings: null`.
  for (const [shape, expected] of [
    [{ settings: null }, undefined],
    [{ settings: { is_auto_deploy_enabled: 1 } }, true],
    [{ settings: { is_auto_deploy_enabled: false } }, false],
    [{ is_auto_deploy_enabled: true }, true],
  ] as const) {
    raw = { ...base, ...shape };
    assert.equal((await api.getApplication("app")).isAutoDeployEnabled, expected);
  }
  raw = {
    ...base,
    settings: { is_consistent_container_name_enabled: false, custom_internal_name: "custom" },
  };
  const named = await api.getApplication("app");
  const results = await checkProjectRollingDeployState(dir, {
    api: {
      async listApplications() {
        return [{ uuid: "app", name: "site" }];
      },
      async getApplication() {
        return named;
      },
    },
  });
  assert.equal(results[0].status, "warn");
  assert.match(results[0].detail, /custom internal/);
  console.log("✓ Coolify name-setting mappings and doctor rolling-deployment qualification");
} finally {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
}
