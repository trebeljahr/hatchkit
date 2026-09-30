/** Offline staging bundle only. Never reads credentials or changes deployments. */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest } from "../scaffold/manifest.js";
import { operatorScope, senderOperatorPolicy } from "./ses-operator-policy.js";
import { SIMULATION_PERMISSION } from "./ses-policy-verification.js";
import { senderPolicy, senderSpec } from "./ses-project-policy.js";

export async function runListmonkIsolationPlan(argv: string[]): Promise<void> {
  let projectDir = "";
  let output = "";
  let account = "";
  let region = "";
  let url = "";
  let dryRun = false;
  let from: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") continue;
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (["--output", "--account", "--region", "--url", "--from"].includes(a)) {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error(`${a} requires a value.`);
      if (a === "--output") output = resolve(value);
      if (a === "--account") account = value;
      if (a === "--region") region = value;
      if (a === "--url") url = value;
      if (a === "--from") from = [value];
    } else if (a.startsWith("-") || projectDir) throw new Error(`Unknown argument: ${a}`);
    else projectDir = resolve(a);
  }
  const manifest = readManifest(projectDir || process.cwd());
  if (!manifest?.name || !manifest.domain)
    throw new Error("A Hatchkit project manifest is required.");
  const spec = senderSpec(manifest.name, manifest.domain, account, region, from);
  const publicUrl = new URL(url);
  if (
    publicUrl.protocol !== "https:" ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.search ||
    publicUrl.hash ||
    !["", "/"].includes(publicUrl.pathname) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(publicUrl.hostname)
  )
    throw new Error("--url must be the new dedicated Listmonk HTTPS origin.");
  // DNS-like slug plus scope hash, with no Compose interpolation or traversal.
  const slug = spec.user;
  const plan = {
    project: spec.project,
    scope: spec,
    publicUrl: publicUrl.origin,
    status: "staging-only; not deployed or verified",
    sourceMigration:
      "reviewed initial import and optional privileged legacy bridge; no automatic subscriber copy",
    services: [
      "dedicated Listmonk v6.2.0",
      "dedicated Postgres volume",
      "loopback ingress proxy with a fixed Listmonk upstream",
      "project SES v2 HTTP messenger",
      "optional legacy confirmation, suppression and signed-feedback bridge",
    ],
    senderPolicy: senderPolicy(spec),
    provisionerPolicy: senderOperatorPolicy(spec.account, spec.region),
    senderBoundaryArn: operatorScope(spec.account, spec.region).boundaryArn,
    simulationPermission: SIMULATION_PERMISSION,
    requiresApproval: [
      "AWS resource/key creation",
      "new deployment and DNS/proxy route",
      "source database capture hooks and scoped bridge role",
      "dedicated SNS feedback route and subscription",
      "subscriber migration",
      "one-recipient delivery test",
      "app cutover",
      "old token retirement",
    ],
    rollback:
      "Before cutover, stop only this new stack without -v. After cutover, pause writes/sends, reconcile new subscriptions and suppression back to the selected source lists, then restore the prior app env/image. If reconciliation is unavailable, keep writes paused. Keep the shared service and old credentials until verified migration; do not revoke them during staging.",
    output: output || null,
  };
  if (!dryRun) {
    if (!output)
      throw new Error("Pass --output <new-directory>, or --dry-run for a no-write plan.");
    if (existsSync(output))
      throw new Error("Output already exists; refusing overwrite or adoption.");
    const template = join(
      dirname(fileURLToPath(import.meta.url)),
      "../templates/listmonk-isolated",
    );
    mkdirSync(dirname(output), { recursive: true });
    mkdirSync(output, { mode: 0o700 });
    cpSync(template, output, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (path) => !["node_modules", ".env", "secrets"].includes(basename(path)),
    });
    const substitutions: Record<string, string> = {
      __PROJECT_SLUG__: slug,
      __PUBLIC_URL__: publicUrl.origin,
      __REGION__: spec.region,
      __IDENTITY_ARN__: spec.identityArn,
      __TENANT__: spec.tenant,
      __CONFIGURATION_SET__: spec.configurationSet,
      __FROM__: spec.from[0],
    };
    const path = join(output, "compose.yml");
    let compose = readFileSync(path, "utf8");
    for (const [key, value] of Object.entries(substitutions))
      compose = compose.replaceAll(key, value);
    writeFileSync(path, compose);
    writeFileSync(join(output, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  }
  console.log(JSON.stringify(plan, null, 2));
}
