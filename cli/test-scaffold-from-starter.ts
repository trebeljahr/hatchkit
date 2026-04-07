/**
 * Test: scaffold from starter submodule (not Handlebars templates).
 * Verifies the copy + customize flow works.
 * Run: npx tsx test-scaffold-from-starter.ts
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldApp } from "./src/scaffold/app.js";
import type { ProjectConfig } from "./src/prompts.js";

const tmpDir = mkdtempSync(join(tmpdir(), "devops-cli-starter-test-"));
console.log(`\nScaffolding from starter to: ${tmpDir}\n`);

// Full config with all features + ML services
const config: ProjectConfig = {
  name: "test-project",
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
  const modifications = scaffoldApp(config, tmpDir);
  console.log(`\nModifications: ${modifications.length}\n`);
  for (const m of modifications) {
    console.log(`  - ${m}`);
  }

  const checks = [
    // Core structure exists
    ["packages/server/src/app.ts exists", existsSync(join(tmpDir, "packages/server/src/app.ts"))],
    ["packages/client/src/app exists", existsSync(join(tmpDir, "packages/client/src/app"))],
    ["packages/shared/src/types.ts exists", existsSync(join(tmpDir, "packages/shared/src/types.ts"))],
    ["pnpm-workspace.yaml exists", existsSync(join(tmpDir, "pnpm-workspace.yaml"))],

    // ML playground pages for selected services
    ["playground/background-removal exists", existsSync(join(tmpDir, "packages/client/src/app/(protected)/playground/background-removal"))],
    ["playground/3d-extraction exists", existsSync(join(tmpDir, "packages/client/src/app/(protected)/playground/3d-extraction"))],

    // ML playground pages for unselected services are removed
    ["playground/subtitles removed", !existsSync(join(tmpDir, "packages/client/src/app/(protected)/playground/subtitles"))],
    ["playground/image-recognition removed", !existsSync(join(tmpDir, "packages/client/src/app/(protected)/playground/image-recognition"))],

    // ML infrastructure exists
    ["ml router exists", existsSync(join(tmpDir, "packages/server/src/trpc/routers/ml.ts"))],
    ["ml service exists", existsSync(join(tmpDir, "packages/server/src/services/ml.ts"))],
    ["ml-types exists", existsSync(join(tmpDir, "packages/shared/src/ml-types.ts"))],
    ["ml components exist", existsSync(join(tmpDir, "packages/client/src/components/ml"))],

    // .git is NOT copied
    [".git not copied", !existsSync(join(tmpDir, ".git"))],

    // node_modules not copied
    ["node_modules not copied", !existsSync(join(tmpDir, "node_modules"))],

    // Project name replaced
    ["package.json has project name", readFileSync(join(tmpDir, "package.json"), "utf-8").includes("test-project")],
  ];

  console.log("\nChecks:");
  let allPassed = true;
  for (const [name, passed] of checks) {
    console.log(`  ${passed ? "✓" : "✗"} ${name}`);
    if (!passed) allPassed = false;
  }

  console.log(`\n${allPassed ? "ALL CHECKS PASSED ✓" : "SOME CHECKS FAILED ✗"}\n`);
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(allPassed ? 0 : 1);
} catch (error) {
  console.error("Error:", error);
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
}
