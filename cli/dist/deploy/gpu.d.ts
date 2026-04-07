import type { MlService, GpuPlatform } from "../prompts.js";
/** Deploy ML services that don't exist in the registry. */
export declare function deployMlServices(services: MlService[], platform: GpuPlatform, repoRoot: string, customHfModelId?: string): Promise<Record<string, string>>;
//# sourceMappingURL=gpu.d.ts.map