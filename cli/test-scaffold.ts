/**
 * Non-interactive test: directly exercises the scaffolder with a mock config.
 * Run: npx tsx test-scaffold.ts
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldApp } from "./src/scaffold/app.js";
import type { ProjectConfig } from "./src/prompts.js";

const tmpDir = mkdtempSync(join(tmpdir(), "devops-cli-test-"));

console.log(`\nScaffolding test project to: ${tmpDir}\n`);

const config: ProjectConfig = {
  name: "test-app",
  domain: "test.ricos.site",
  baseDomain: "ricos.site",
  subdomain: "test",
  deployTarget: "existing",
  serverId: 1,
  serverIp: "49.12.0.1",
  features: ["websocket", "stripe", "analytics", "s3"],
  s3Provider: "hetzner",
  mlServices: ["3d-extraction", "background-removal"],
  gpuPlatform: "modal",
  scaffoldRepo: true,
  createGithubRepo: false,
  runDeployment: false,
  dryRun: false,
};

try {
  const files = scaffoldApp(config, tmpDir);

  console.log(`\nGenerated ${files.length} files:\n`);
  for (const f of files) {
    const content = readFileSync(join(tmpDir, f.path), "utf-8");
    const lines = content.split("\n").length;
    console.log(`  ${f.path} (${lines} lines)`);
  }

  // Verify key files contain expected content
  const indexTs = readFileSync(join(tmpDir, "src/index.ts"), "utf-8");
  const checks = [
    ["WebSocket import", indexTs.includes("setupWebSocket")],
    ["Stripe webhook", indexTs.includes("stripeWebhookRouter")],
    ["Sentry init", indexTs.includes("initSentry")],
    ["SIGTERM handler", indexTs.includes("SIGTERM")],
    ["better-auth", indexTs.includes("authRouter")],
  ];

  console.log("\nContent checks:");
  let allPassed = true;
  for (const [name, passed] of checks) {
    console.log(`  ${passed ? "✓" : "✗"} ${name}`);
    if (!passed) allPassed = false;
  }

  const pkgJson = JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf-8"));
  const depChecks = [
    ["ws", !!pkgJson.dependencies.ws],
    ["ioredis", !!pkgJson.dependencies.ioredis],
    ["stripe", !!pkgJson.dependencies.stripe],
    ["@sentry/node", !!pkgJson.dependencies["@sentry/node"]],
    ["@aws-sdk/client-s3", !!pkgJson.dependencies["@aws-sdk/client-s3"]],
    ["better-auth", !!pkgJson.dependencies["better-auth"]],
  ];

  console.log("\nDependency checks:");
  for (const [name, present] of depChecks) {
    console.log(`  ${present ? "✓" : "✗"} ${name}`);
    if (!present) allPassed = false;
  }

  // Check ML clients exist
  const mlChecks = [
    ["ML: 3d-extraction client", files.some(f => f.path === "src/ml/3d-extraction.ts")],
    ["ML: background-removal client", files.some(f => f.path === "src/ml/background-removal.ts")],
  ];

  console.log("\nML client checks:");
  for (const [name, present] of mlChecks) {
    console.log(`  ${present ? "✓" : "✗"} ${name}`);
    if (!present) allPassed = false;
  }

  console.log(`\n${allPassed ? "ALL CHECKS PASSED ✓" : "SOME CHECKS FAILED ✗"}\n`);

  // Cleanup
  rmSync(tmpDir, { recursive: true });

  process.exit(allPassed ? 0 : 1);
} catch (error) {
  console.error("Error:", error);
  rmSync(tmpDir, { recursive: true });
  process.exit(1);
}
