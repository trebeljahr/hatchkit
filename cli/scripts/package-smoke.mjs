#!/usr/bin/env node
/** Exercise packed packages from a clean install, never from workspace links. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { envWithPnpm, resolvePnpm } from "./release-lib.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(join(tmpdir(), "hatchkit-package-smoke-"));
const pnpm = resolvePnpm();
if (!pnpm) throw new Error("pnpm is required for the packed install check.");
const { env: base, cleanup } = envWithPnpm(pnpm);
const env = { ...base, HATCHKIT_KEYCHAIN_ACCESS: "deny", HATCHKIT_CONF_DIR: join(scratch, "conf"),
  NEXT_PUBLIC_API_URL: "https://packed-app.example.invalid",
  HATCHKIT_DEV_CONFIG_DIR: join(scratch, "dev"), HATCHKIT_TEST_KEYCHAIN_DIR: join(scratch, "keychain"),
  NODE_OPTIONS: `${base.NODE_OPTIONS ?? ""} --import=${new URL("../test-support/setup.mjs", import.meta.url).href}`.trim(),
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Package test",
  GIT_AUTHOR_EMAIL: "package-test@example.invalid", GIT_COMMITTER_NAME: "Package test", GIT_COMMITTER_EMAIL: "package-test@example.invalid" };
function run(command, args, cwd, accepted = [0]) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 300_000, maxBuffer: 20 * 1024 * 1024 });
  assert.doesNotMatch(result.stderr ?? "", /Tests cannot run a real/, "smoke commands must use fixture hosts");
  if (!accepted.includes(result.status)) throw new Error(`${command} ${args.join(" ")} failed: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  console.log("Packing CLI, operator MCP and development plugins...");
  const archives = [];
  for (const dir of ["packages/dev-shared", "packages/dev-plugin-next", "packages/dev-plugin-vite", "mcp", "cli"]) {
    const pkg = JSON.parse(readFileSync(join(repo, dir, "package.json"), "utf8"));
    run(pnpm.command, [...pnpm.args, "pack", "--pack-destination", scratch], join(repo, dir));
    archives.push(join(scratch, `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${pkg.version}.tgz`));
  }
  const install = join(scratch, "install");
  mkdirSync(install);
  writeFileSync(join(install, "package.json"), '{"name":"packed-install-test","private":true}');
  // Native keytar is deliberately not built: fixture setup intercepts its
  // import. These checks never access the OS credential store.
  console.log("Installing tarballs in a clean temporary project...");
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...archives], install);
  console.log("Checking installed commands and scaffolding...");
  const binary = join(install, "node_modules/hatchkit/dist/index.js");
  const assets = join(install, "node_modules/hatchkit/dist/bundle");
  assert.ok(existsSync(join(assets, "infra/terraform/stacks/node-realtime/main.tf")));
  assert.ok(existsSync(join(assets, "services/ml/background-removal/MODEL_LICENSE.md")));
  assert.ok(!existsSync(join(assets, "starter/.env.keys")));
  const work = join(scratch, "work");
  mkdirSync(work);
  // No GitHub account or network probe should be consulted by fixture doctor.
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tailscale"), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, "tailscale"), 0o755);
  writeFileSync(join(bin, "gh"), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, "gh"), 0o755);
  env.PATH = `${bin}:${env.PATH}`;
  assert.match(run(process.execPath, [binary, "--version"], work), /\d+\.\d+\.\d+/);
  assert.match(run(process.execPath, [binary, "help"], work), /create/);
  JSON.parse(run(process.execPath, [binary, "status", "--json"], work));
  const doctor = JSON.parse(run(process.execPath, [binary, "doctor", "--json"], work, [0, 1]));
  assert.ok(doctor.summary.unverified > 0, "blocked credential checks stay structured JSON");
  const mcpProbe = join(scratch, "mcp-probe.mjs");
  writeFileSync(mcpProbe, `import assert from "node:assert/strict";
import { Client } from ${JSON.stringify(pathToFileURL(join(install, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")).href)};
import { StdioClientTransport } from ${JSON.stringify(pathToFileURL(join(install, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js")).href)};
const client = new Client({ name: "package-smoke", version: "1.0.0" });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [${JSON.stringify(join(install, "node_modules/@hatchkit/mcp/dist/index.js"))}],
    env: { ...process.env, HATCHKIT_BIN: ${JSON.stringify(binary)} } }));
  const listing = await client.listTools();
  assert.deepEqual(listing.tools.map((t) => t.name).sort(), ["hatchkit_doctor", "hatchkit_explain", "hatchkit_keys_show", "hatchkit_status"]);
  const status = await client.callTool({ name: "hatchkit_status", arguments: {} });
  assert.notEqual(status.isError, true);
  assert.ok(Array.isArray(JSON.parse(status.content[0].text).providers));
} finally { await client.close(); }
`);
  run(process.execPath, [mcpProbe], work);
  const config = { name: "packed-app", domain: "packed-app.example.com", surfaces: "fullstack", deploymentMode: "scaffold-only",
    features: ["client-core", "mcp", "raycast", "mobile"], provisionServices: ["search-console"], s3Provider: "none", dbProvider: "external",
    scaffoldRepo: true, createGithubRepo: false, installDeps: false, runDeployment: false };
  const configFile = join(scratch, "project.json");
  writeFileSync(configFile, JSON.stringify(config));
  // The native backend is still replaced by fixtures; only the synthetic
  // dotenvx key written for this temporary project is accessible here.
  env.HATCHKIT_KEYCHAIN_ACCESS = "allow";
  run(process.execPath, [binary, "create", "--yes", "--config", configFile, "--no-github", "--no-install", "--no-deploy", "--no-local-dev"], work);
  for (const path of [".hatchkit.json", "packages/server/package.json", "packages/client/package.json", "packages/core/package.json", "packages/mcp/package.json", "packages/raycast/package.json"]) {
    assert.ok(existsSync(join(work, "packed-app", path)), `packed scaffold missing ${path}`);
  }
  const manifest = JSON.parse(readFileSync(join(work, "packed-app/.hatchkit.json"), "utf8"));
  assert.ok(manifest.deferred?.some((step) => step.key === "service:search-console" && step.command === "hatchkit add packed-app search-console"), "optional credentials defer without blocking scaffold");
  const probe = join(scratch, "infrastructure.mjs");
  writeFileSync(probe, `import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prepareInfrastructureRoot } from ${JSON.stringify(pathToFileURL(join(install, "node_modules/hatchkit/dist/utils/asset-root.js")).href)};
const cache = ${JSON.stringify(join(scratch, "private-infra"))};
assert.equal(prepareInfrastructureRoot(cache), cache);
assert.ok(existsSync(join(cache, "infra/terraform/stacks/node-realtime/main.tf")));
writeFileSync(join(cache, "infra/local-state.tfvars"), "preserve me");
prepareInfrastructureRoot(cache);
assert.equal(readFileSync(join(cache, "infra/local-state.tfvars"), "utf8"), "preserve me");
`);
  run(process.execPath, [probe], work);
  if (process.argv.includes("--build")) {
    console.log("Building and testing the app scaffolded from the packed CLI...");
    run(pnpm.command, [...pnpm.args, "install", "--no-frozen-lockfile"], join(work, "packed-app"));
    run(pnpm.command, [...pnpm.args, "run", "build"], join(work, "packed-app"));
    run(pnpm.command, [...pnpm.args, "run", "contract:emit"], join(work, "packed-app"));
    run(pnpm.command, [...pnpm.args, "run", "test:unit"], join(work, "packed-app"));
  }
  console.log("Packed CLI and MCP install; JSON checks and multi-feature scaffolding passed without checkout assets or OS credentials.");
} finally {
  cleanup();
  rmSync(scratch, { recursive: true, force: true });
}
