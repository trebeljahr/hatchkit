import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dotenvxSet } from "./src/utils/dotenvx-safe.js";
import { scaffoldBuildPipeline } from "./src/scaffold/build-pipeline.js";
const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), "hatchkit-locked-runtime-"));
try {
  const envPath = join(root, ".env.production");
  dotenvxSet("HATCHKIT_RUNTIME_FIXTURE", "synthetic-offline-runtime", { path: envPath, encrypt: true });
  const key = readFileSync(join(root, ".env.keys"), "utf8").match(/^DOTENV_PRIVATE_KEY_PRODUCTION="?([a-f0-9]+)"?$/m)?.[1];
  assert.ok(key, "Synthetic production key was not generated");
  assert.ok(!readFileSync(envPath, "utf8").includes("synthetic-offline-runtime"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "runtime-fixture", engines: { node: ">=24" } }));
  scaffoldBuildPipeline({ projectDir: root, projectName: "runtime-fixture", ghOwner: "fixture", entrypoint: "fixture.cjs", port: 3000, surfaces: "fullstack", defaultBranch: "main" });
  const binary = realpathSync(join(dirname(require.resolve("@dotenvx/dotenvx/package.json")), "src/cli/dotenvx.js"));
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  symlinkSync(binary, join(root, "node_modules/.bin/dotenvx"));
  const bins = join(root, "fixture-bin"); mkdirSync(bins);
  symlinkSync(process.execPath, join(bins, "node"));
  for (const manager of ["npm", "npx", "pnpm"]) {
    writeFileSync(join(bins, manager), '#!/bin/sh\nprintf blocked > "'+join(root, "registry-tool-invoked")+'"\nexit 99\n', { mode: 0o755 });
  }
  const preload = join(root, "deny-network.cjs");
  writeFileSync(preload, `
const deny=()=>{throw Error('NETWORK_DISABLED_FIXTURE');};
for(const name of ['http','https']){const m=require(name);m.request=deny;m.get=deny;}
const net=require('net');net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;
const tls=require('tls');tls.connect=deny;
const dns=require('dns');dns.lookup=deny;dns.resolve=deny;dns.promises.lookup=deny;dns.promises.resolve=deny;
require('dgram').createSocket=deny;globalThis.fetch=deny;globalThis.HATCHKIT_NETWORK_DISABLED=true;
`);
  writeFileSync(join(root, "fixture.cjs"), `
const assert=require('node:assert/strict');
assert.equal(globalThis.HATCHKIT_NETWORK_DISABLED,true);
assert.equal(process.env.HATCHKIT_RUNTIME_FIXTURE,process.env.HATCHKIT_EXPECTED_FIXTURE_VALUE);
console.log(JSON.stringify({ok:true,encryptedEnvironmentDecrypted:true,networkDisabled:true}));
`);
  // Map the container's absolute preload path to the same source in this fixture.
  const drain = join(root, "drain.cjs");
  writeFileSync(drain, readFileSync(new URL("./src/templates/build-pipeline/drain.cjs", import.meta.url)));
  const image = readFileSync(join(root, "Dockerfile"), "utf8");
  const command = JSON.parse(image.split("\n").find((line) => line.startsWith("CMD "))!.slice(4)) as string[];
  assert.deepEqual(command.slice(0, 2), ["sh", "-c"]);
  for (const override of [undefined, "synthetic-operator-override"]) {
  const result = spawnSync("/bin/sh", ["-c", command[2]!.replace("/usr/local/lib/drain.cjs", drain)], {
    cwd: root, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PATH: bins, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${preload}`, DOTENV_PRIVATE_KEY_PRODUCTION: key,
      SHUTDOWN_DRAIN_SECONDS: "0", HATCHKIT_DRAIN_PIDFILE: join(root, "drain.pid"), HATCHKIT_RUNTIME_FIXTURE: override, HATCHKIT_EXPECTED_FIXTURE_VALUE: override ?? "synthetic-offline-runtime" },
  });
  assert.equal(result.status, 0, "Locked startup failed: "+result.stderr);
  assert.ok(result.stdout.includes('"encryptedEnvironmentDecrypted":true'));
  assert.ok(!result.stdout.includes(key) && !result.stderr.includes(key));
  assert.equal(existsSync(join(root, "registry-tool-invoked")), false);
  }
  console.log("PASS: generated startup decrypts synthetic production env without networking or npm/npx/pnpm");
} finally { rmSync(root, { recursive: true, force: true }); }
