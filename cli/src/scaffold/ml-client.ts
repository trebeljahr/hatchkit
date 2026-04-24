import chalk from "chalk";
import { type MlServiceEntry, getMlServices } from "../config.js";
import type { GpuPlatform, MlService, ProjectConfig } from "../prompts.js";

/** Resolve ML services — reuse existing or mark for deployment.
 *  Services in config.forceRedeployMl bypass the registry and always
 *  go to the deploy list, which recovers from stale registry entries. */
export async function resolveMlServices(config: ProjectConfig): Promise<{
  reuse: Array<{ service: MlService; entry: MlServiceEntry }>;
  deploy: MlService[];
}> {
  const registry = getMlServices();
  const forceSet = new Set(config.forceRedeployMl ?? []);
  const reuse: Array<{ service: MlService; entry: MlServiceEntry }> = [];
  const deploy: MlService[] = [];

  for (const service of config.mlServices) {
    if (registry[service] && !forceSet.has(service)) {
      reuse.push({ service, entry: registry[service] });
    } else {
      deploy.push(service);
    }
  }

  return { reuse, deploy };
}

/** Get the env var name for an ML service's *active* endpoint — what
 *  the runtime client reads after picking `ML_BACKEND`. Kept stable
 *  for back-compat with starter code that already references
 *  `ML_<SERVICE>_ENDPOINT`. */
export function mlEnvVarName(service: MlService): string {
  const name = service.replace(/-/g, "_").toUpperCase();
  return `ML_${name}_ENDPOINT`;
}

/** Per-platform URL env (`ML_<SERVICE>_<PLATFORM>_URL`) — set by the
 *  deploy step so the runtime can flip backends via `ML_BACKEND`
 *  without redeploying the ML pipelines themselves. */
export function mlPlatformUrlEnv(service: MlService, platform: GpuPlatform): string {
  const svc = service.replace(/-/g, "_").toUpperCase();
  return `ML_${svc}_${platform.toUpperCase()}_URL`;
}

/** Print ML service resolution summary. */
export function printMlSummary(
  reuse: Array<{ service: MlService; entry: MlServiceEntry }>,
  deploy: MlService[],
): void {
  if (reuse.length > 0) {
    console.log(chalk.dim("\n  Reusing existing ML services:"));
    for (const { service, entry } of reuse) {
      console.log(chalk.dim(`    ${service} → ${entry.endpoint}`));
    }
  }
  if (deploy.length > 0) {
    console.log(chalk.yellow(`\n  New ML services to deploy: ${deploy.join(", ")}`));
  }
}
