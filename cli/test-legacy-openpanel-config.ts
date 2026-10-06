/**
 * Configs written before OpenPanel support was removed still load.
 *
 * Older hatchkit versions stored a `providers.openpanel` block in the
 * CLI config and root client credentials in the keychain. Hatchkit no
 * longer reads either, but a user upgrading must not hit an error: the
 * config loads, status and doctor-style views ignore the legacy block,
 * and `config reset` still clears the leftover keychain entries.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const confDir = process.env.HATCHKIT_CONF_DIR ?? mkdtempSync(join(tmpdir(), "legacy-op-conf-"));
process.env.HATCHKIT_CONF_DIR = confDir;
mkdirSync(confDir, { recursive: true });

// Seed the on-disk config BEFORE config.js instantiates the store.
writeFileSync(
  join(confDir, "config.json"),
  JSON.stringify({
    version: 1,
    providers: {
      github: { status: "configured" },
      s3: {},
      gpu: {},
      glitchtip: {
        status: "configured",
        url: "https://glitchtip.example.com",
        lastVerified: "2026-01-01T00:00:00.000Z",
      },
      openpanel: {
        status: "configured",
        url: "https://analytics.example.com",
        apiUrl: "https://api.analytics.example.com",
        organizationSlug: "acme",
        lastVerified: "2026-01-01T00:00:00.000Z",
      },
    },
    mlServices: {},
    usedPorts: [],
  }),
);

const { getConfig, resetConfig } = await import("./src/config.js");
const { getSecret, setSecret } = await import("./src/utils/secrets.js");
const { collectStatus } = await import("./src/status.js");

// 1. The store loads the legacy file intact instead of resetting it.
const config = getConfig() as unknown as {
  providers: Record<string, { status?: string } | undefined>;
};
assert.equal(config.providers.glitchtip?.status, "configured", "other providers survive");
assert.equal(config.providers.openpanel?.status, "configured", "legacy block is tolerated");

// 2. Status ignores the legacy provider and keeps reporting the rest.
const projectDir = mkdtempSync(join(tmpdir(), "legacy-op-project-"));
const snapshot = collectStatus(projectDir);
const keys = snapshot.providers.map((p) => p.key);
assert.ok(keys.includes("glitchtip"), "status still lists GlitchTip");
assert.ok(!keys.includes("openpanel"), "status no longer lists OpenPanel");
assert.ok(
  !JSON.stringify(snapshot).toLowerCase().includes("openpanel"),
  "no OpenPanel suggestion or provider row in status",
);

// 3. `config reset` still clears leftover OpenPanel keychain entries.
await setSecret("openpanel:root-client-id", "legacy-id");
await setSecret("openpanel:root-client-secret", "legacy-secret");
await resetConfig();
assert.equal(await getSecret("openpanel:root-client-id"), null);
assert.equal(await getSecret("openpanel:root-client-secret"), null);

console.log("  ✓ legacy OpenPanel config loads, is ignored, and resets cleanly");
