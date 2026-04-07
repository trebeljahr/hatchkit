import { execa } from "execa";
import ora from "ora";
/** Run a shell command with a spinner. */
export async function exec(command, args, options) {
    const spinner = options?.spinner ? ora(options.spinner).start() : null;
    try {
        const result = await execa(command, args, {
            cwd: options?.cwd,
            env: { ...process.env, ...options?.env },
            reject: false,
        });
        if (result.exitCode !== 0) {
            spinner?.fail();
            if (!options?.silent) {
                console.error(result.stderr || result.stdout);
            }
        }
        else {
            spinner?.succeed();
        }
        return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode ?? 1,
        };
    }
    catch (error) {
        spinner?.fail();
        throw error;
    }
}
/** Run a shell command and return true if exit code is 0. */
export async function execOk(command, args, options) {
    const result = await exec(command, args, { ...options, silent: true });
    return result.exitCode === 0;
}
/** Run a shell command, stream output to terminal. */
export async function execStream(command, args, options) {
    const result = await execa(command, args, {
        cwd: options?.cwd,
        env: { ...process.env, ...options?.env },
        stdio: "inherit",
        reject: false,
    });
    return result.exitCode ?? 1;
}
//# sourceMappingURL=exec.js.map