import type { ProjectConfig } from "../prompts.js";
interface GeneratedFile {
    path: string;
    content: string;
}
/** Scaffold a new Node.js app repo based on project config. */
export declare function scaffoldApp(config: ProjectConfig, outputDir: string): GeneratedFile[];
export {};
//# sourceMappingURL=app.d.ts.map