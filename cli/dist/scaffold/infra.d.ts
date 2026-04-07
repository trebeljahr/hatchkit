import type { ProjectConfig } from "../prompts.js";
/** Generate Terraform tfvars for the project. */
export declare function generateTfvars(config: ProjectConfig): string;
/** Generate Coolify stack .env for the project. */
export declare function generateCoolifyEnv(config: ProjectConfig): string;
/** Write infra config files. */
export declare function scaffoldInfra(config: ProjectConfig, repoRoot: string): void;
//# sourceMappingURL=infra.d.ts.map