import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEV_LAUNCHER_DOCS_SCRIPTS,
  DEV_LAUNCHER_REL_PATH,
  DEV_LAUNCHER_SCRIPTS,
  applyDevLauncher,
  applyDevLauncherNativeOrigins,
  applyDevLauncherPorts,
} from "./src/scaffold/dev-launcher.js";

// A stand-in for the launcher's two rewritable regions. Deliberately carries
// the numbers 3000/5000 in prose as well, so a sweep-for-the-number rewrite
// would be caught here.
const LAUNCHER = `#!/usr/bin/env node
// Pinned so bookmarks keep working. Was 3000/5000 before hatchkit.
const DEV_CLIENT_PORT = 3000;
const DEV_API_PORT = 5000;
const DEV_DOCS_PORT = 4000;

const NATIVE_ORIGINS = [];

console.log(DEV_CLIENT_PORT, DEV_API_PORT, DEV_DOCS_PORT, NATIVE_ORIGINS);
`;

// ── Ports ─────────────────────────────────────────────────────────────

const ported = applyDevLauncherPorts(LAUNCHER, { server: 5412, client: 6733 });
assert.match(ported, /^const DEV_CLIENT_PORT = 6733;$/m);
assert.match(ported, /^const DEV_API_PORT = 5412;$/m);
// The docs port is every project's the same and nothing bakes its URL in.
assert.match(ported, /^const DEV_DOCS_PORT = 4000;$/m);
// Prose that happens to contain the old numbers is left alone.
assert.match(ported, /Was 3000\/5000 before hatchkit\./);

// Idempotent, and re-runnable with the same ports from `hatchkit update`.
assert.equal(applyDevLauncherPorts(ported, { server: 5412, client: 6733 }), ported);

// A native HMR port is not one of the launcher's three — it belongs to the
// desktop/mobile shells — so passing one changes nothing here.
assert.equal(
  applyDevLauncherPorts(LAUNCHER, { server: 5412, client: 6733, nativeHmr: 7100 }),
  ported,
);

// ── Native origins ────────────────────────────────────────────────────

const noNative = applyDevLauncherNativeOrigins(LAUNCHER, ["websocket", "stripe"]);
assert.match(noNative, /^const NATIVE_ORIGINS = \[\];$/m);

const mobile = applyDevLauncherNativeOrigins(LAUNCHER, ["mobile"]);
assert.match(mobile, /const NATIVE_ORIGINS = \[\n {2}"capacitor:\/\/localhost",\n {2}"https:\/\/localhost",\n\];/);

const both = applyDevLauncherNativeOrigins(LAUNCHER, ["desktop", "mobile"]);
// Ordered by feature (mobile, desktop, desktop-tauri), matching the list the
// server's .env.example and Coolify get — the dev server must not trust a
// different set than production.
assert.deepEqual(
  [...both.matchAll(/^ {2}"([^"]+)",$/gm)].map((m) => m[1]),
  ["capacitor://localhost", "https://localhost", "app://-"],
);

// Every origin is a bare scheme://host: better-auth matches verbatim, so a
// trailing slash or a path is a silent 403.
for (const origin of [...both.matchAll(/^ {2}"([^"]+)",$/gm)].map((m) => m[1])) {
  assert.match(origin, /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+$/i, origin);
}

// Re-running with a narrower feature set writes the narrower list back rather
// than appending — the array is replaced whole.
assert.equal(applyDevLauncherNativeOrigins(both, []), noNative);

// ── The file + package.json pass ──────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "hatchkit-dev-launcher-"));
try {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, DEV_LAUNCHER_REL_PATH), LAUNCHER, "utf-8");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }, null, 2), "utf-8");

  applyDevLauncher(dir, { server: 5412, client: 6733 }, ["desktop"]);

  const launcher = readFileSync(join(dir, DEV_LAUNCHER_REL_PATH), "utf-8");
  assert.match(launcher, /^const DEV_API_PORT = 5412;$/m);
  assert.match(launcher, /"app:\/\/-",/);

  const scripts = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")).scripts;
  assert.deepEqual(scripts, { ...DEV_LAUNCHER_SCRIPTS });
  // No docs-site in this fixture, so no command that would start nothing.
  for (const name of Object.keys(DEV_LAUNCHER_DOCS_SCRIPTS)) {
    assert.ok(!(name in scripts), name);
  }
  // Three commands, one launcher: the mode is a flag, never a second file.
  for (const value of Object.values(scripts as Record<string, string>)) {
    assert.match(value, new RegExp(`node ${DEV_LAUNCHER_REL_PATH}`));
  }
  assert.equal(scripts["dev:auto"], `node ${DEV_LAUNCHER_REL_PATH} --auto`);
  assert.equal(scripts["dev:fixed"], `node ${DEV_LAUNCHER_REL_PATH} --fixed`);

  // With a docs site, the two docs commands appear.
  mkdirSync(join(dir, "docs-site"), { recursive: true });
  applyDevLauncher(dir, { server: 5412, client: 6733 }, ["desktop"]);
  const withDocs = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")).scripts;
  assert.deepEqual(withDocs, { ...DEV_LAUNCHER_SCRIPTS, ...DEV_LAUNCHER_DOCS_SCRIPTS });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// A project with no launcher (adopted repo, or one scaffolded before this
// landed) must not throw.
const bare = mkdtempSync(join(tmpdir(), "hatchkit-dev-launcher-bare-"));
try {
  writeFileSync(join(bare, "package.json"), JSON.stringify({ scripts: {} }), "utf-8");
  applyDevLauncher(bare, { server: 5000, client: 6000 }, []);
  assert.ok(!existsSync(join(bare, DEV_LAUNCHER_REL_PATH)));
} finally {
  rmSync(bare, { recursive: true, force: true });
}

console.log("dev launcher wiring checks ok");
