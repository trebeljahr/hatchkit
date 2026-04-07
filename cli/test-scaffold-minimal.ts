/**
 * Test: minimal project (no addons, no ML) — verify base-only scaffolding.
 * Run: npx tsx test-scaffold-minimal.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldApp } from "./src/scaffold/app.js";
import type { ProjectConfig } from "./src/prompts.js";

const tmpDir = mkdtempSync(join(tmpdir(), "devops-cli-test-min-"));
console.log(`\nScaffolding minimal project to: ${tmpDir}\n`);

const config: ProjectConfig = {
  name: "minimal-app",
  domain: "minimal.ricos.site",
  baseDomain: "ricos.site",
  subdomain: "minimal",
  deployTarget: "existing",
  serverId: 1,
  serverIp: "49.12.0.1",
  features: [],
  s3Provider: "none",
  mlServices: [],
  scaffoldRepo: true,
  createGithubRepo: false,
  runDeployment: false,
  dryRun: false,
};

try {
  const files = scaffoldApp(config, tmpDir);
  console.log(`Generated ${files.length} files:\n`);
  for (const f of files) {
    console.log(`  ${f.path}`);
  }

  const indexTs = readFileSync(join(tmpDir, "src/index.ts"), "utf-8");
  const pkgJson = JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf-8"));

  const checks = [
    ["No WebSocket import", !indexTs.includes("setupWebSocket")],
    ["No Stripe import", !indexTs.includes("stripeWebhookRouter")],
    ["No Sentry import", !indexTs.includes("initSentry")],
    ["Has better-auth", indexTs.includes("authRouter")],
    ["Has health route", indexTs.includes("healthRouter")],
    ["No ws dep", !pkgJson.dependencies.ws],
    ["No ioredis dep", !pkgJson.dependencies.ioredis],
    ["No stripe dep", !pkgJson.dependencies.stripe],
    ["No sentry dep", !pkgJson.dependencies["@sentry/node"]],
    ["Has mongoose", !!pkgJson.dependencies.mongoose],
    ["Has better-auth dep", !!pkgJson.dependencies["better-auth"]],
    ["Only base files (13)", files.length === 13],
  ];

  console.log("\nChecks:");
  let allPassed = true;
  for (const [name, passed] of checks) {
    console.log(`  ${passed ? "✓" : "✗"} ${name}`);
    if (!passed) allPassed = false;
  }

  console.log(`\n${allPassed ? "ALL CHECKS PASSED ✓" : "SOME CHECKS FAILED ✗"}\n`);
  rmSync(tmpDir, { recursive: true });
  process.exit(allPassed ? 0 : 1);
} catch (error) {
  console.error("Error:", error);
  rmSync(tmpDir, { recursive: true });
  process.exit(1);
}
