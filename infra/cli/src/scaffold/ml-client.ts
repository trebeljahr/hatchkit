import chalk from "chalk";
import { getMlServices, registerMlService, ensureGpuProvider, type MlServiceEntry } from "../config.js";
import type { ProjectConfig, MlService, GpuPlatform } from "../prompts.js";

/** Resolve ML services — reuse existing or mark for deployment. */
export async function resolveMlServices(config: ProjectConfig): Promise<{
  reuse: Array<{ service: MlService; entry: MlServiceEntry }>;
  deploy: MlService[];
}> {
  const registry = getMlServices();
  const reuse: Array<{ service: MlService; entry: MlServiceEntry }> = [];
  const deploy: MlService[] = [];

  for (const service of config.mlServices) {
    if (registry[service]) {
      reuse.push({ service, entry: registry[service] });
    } else {
      deploy.push(service);
    }
  }

  return { reuse, deploy };
}

/** Get the env var name for an ML service endpoint. */
export function mlEnvVarName(service: MlService): string {
  const name = service.replace(/-/g, "_").toUpperCase();
  return `ML_${name}_ENDPOINT`;
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
