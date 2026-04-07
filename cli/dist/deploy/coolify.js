import { join } from "node:path";
import chalk from "chalk";
import { execStream } from "../utils/exec.js";
import { getConfig } from "../config.js";
/** Run the Coolify setup script for the project. */
export async function runCoolifySetup(config, repoRoot) {
    const coolifyConfig = getConfig().providers.coolify;
    const envFile = join(repoRoot, "stacks", `${config.name}.env`);
    console.log(chalk.bold("\n  ── Coolify Setup ─────────────────────────────────────────\n"));
    const env = {};
    if (coolifyConfig?.token) {
        env.COOLIFY_TOKEN = coolifyConfig.token;
    }
    const exitCode = await execStream(join(repoRoot, "scripts", "setup-coolify-stack.sh"), ["--config", envFile], { cwd: repoRoot, env });
    if (exitCode !== 0) {
        throw new Error("Coolify setup failed");
    }
    console.log(chalk.green("\n  ✓ Coolify app stack created"));
}
//# sourceMappingURL=coolify.js.map