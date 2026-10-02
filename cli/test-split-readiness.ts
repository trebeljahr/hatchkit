import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldApp } from "./src/scaffold/app.js";
import type { ProjectConfig } from "./src/prompts.js";

function config(name: string, websocket: boolean): ProjectConfig {
  return {
    name,
    domain: `${name}.example.test`,
    baseDomain: "example.test",
    subdomain: name,
    surfaces: "split",
    topology: "split",
    coolifyRuntime: "image",
    deploymentMode: "scaffold-only",
    deployTarget: "existing",
    serverId: 1,
    serverIp: "127.0.0.1",
    features: websocket ? ["websocket"] : [],
    provisionServices: [],
    s3Provider: "none",
    mlServices: [],
    forceRedeployMl: [],
    scaffoldRepo: true,
    createGithubRepo: false,
    installDeps: false,
    runDeployment: false,
    dryRun: false,
  } as ProjectConfig;
}

for (const websocket of [true, false]) {
  const name = websocket ? "split-ws-check" : "split-http-check";
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  try {
    await scaffoldApp(config(name, websocket), dir);
    const read = (path: string) => readFileSync(join(dir, path), "utf8");
    const manifest = JSON.parse(read(".hatchkit.json"));
    assert.equal(manifest.topology, "split");
    assert.equal(manifest.publicService, "client");
    const clientEnv = read("packages/client/.env.example");
    const serverEnv = read("packages/server/.env.example");
    assert.match(clientEnv, new RegExp(`^NEXT_PUBLIC_API_URL=https://api\\.${name}\\.example\\.test$`, "m"));
    assert.match(clientEnv, new RegExp(`^NEXT_PUBLIC_WS_URL=wss://api\\.${name}\\.example\\.test$`, "m"));
    assert.match(serverEnv, new RegExp(`^FRONTEND_URL=https://${name}\\.example\\.test$`, "m"));
    assert.match(serverEnv, new RegExp(`^BETTER_AUTH_URL=https://api\\.${name}\\.example\\.test$`, "m"));
    assert.match(read("packages/server/Dockerfile"), /deploy --legacy \/prod/);
    const index = read("packages/server/src/index.ts");
    assert.equal(index.includes("roomManager.connectPubSub(redis)"), websocket);
    assert.equal(index.includes("roomManager.disconnectPubSub()"), websocket);
    assert.equal(existsSync(join(dir, "packages/client/src/lib/room-socket.ts")), websocket);
    assert.equal(existsSync(join(dir, "packages/client/src/lib/room-socket.test.ts")), websocket);
    console.log(`split ${websocket ? "WebSocket" : "HTTP"} scaffold passed`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
