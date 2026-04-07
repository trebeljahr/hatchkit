import { type MlServiceEntry } from "../config.js";
import type { ProjectConfig, MlService } from "../prompts.js";
/** Resolve ML services — reuse existing or mark for deployment. */
export declare function resolveMlServices(config: ProjectConfig): Promise<{
    reuse: Array<{
        service: MlService;
        entry: MlServiceEntry;
    }>;
    deploy: MlService[];
}>;
/** Get the env var name for an ML service endpoint. */
export declare function mlEnvVarName(service: MlService): string;
/** Print ML service resolution summary. */
export declare function printMlSummary(reuse: Array<{
    service: MlService;
    entry: MlServiceEntry;
}>, deploy: MlService[]): void;
//# sourceMappingURL=ml-client.d.ts.map