/**
 * Scaffold a project into a directory for CI's build smoke test.
 *
 * Usage: tsx scaffold-fixture.ts <outputDir> [surface]
 *
 * Exists so CI can prove a freshly-scaffolded project actually builds.
 * Two blockers shipped that a single `pnpm build` would have caught: a
 * `@plugin` directive Tailwind couldn't resolve, and a next.config that
 * still referenced the pruned server. The scaffold matrix asserts on
 * file contents; this asserts the toolchain accepts them.
 *
 * Imports `scaffoldApp` directly rather than driving the CLI, so it
 * stays independent of the interactive prompt/flag surface.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.HATCHKIT_CONF_DIR ??= mkdtempSync(join(tmpdir(), "fixture-conf-"));
process.env.HATCHKIT_KEYTAR_SERVICE ??= `hatchkit-fixture-${process.pid}`;
process.env.HATCHKIT_DEV_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), "fixture-dev-"));

const { scaffoldApp } = await import("./src/scaffold/app.js");
type ProjectConfig = import("./src/prompts.js").ProjectConfig;
type Surface = import("./src/prompts.js").Surface;

const outputDir = resolve(process.argv[2] ?? "");
const surface = (process.argv[3] ?? "static") as Surface;
if (!process.argv[2]) {
  console.error("usage: tsx scaffold-fixture.ts <outputDir> [surface]");
  process.exit(1);
}

const config: ProjectConfig = {
  name: "fixture-app",
  domain: "fixture-app.example.com",
  baseDomain: "example.com",
  subdomain: "fixture-app",
  surfaces: surface,
  deploymentMode: "coolify",
  deployTarget: "existing",
  serverId: 1,
  serverIp: "1.2.3.4",
  features: [],
  provisionServices: [],
  s3Provider: "none",
  mongodbProvider: "external",
  mlServices: [],
  forceRedeployMl: [],
  scaffoldRepo: true,
  createGithubRepo: false,
  installDeps: false,
  runDeployment: false,
  dryRun: false,
} as ProjectConfig;

const result = await scaffoldApp(config, outputDir);
console.log(`Scaffolded ${surface} fixture at ${outputDir} (${result.modifications.length} modifications)`);
