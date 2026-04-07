export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
/** Run a shell command with a spinner. */
export declare function exec(command: string, args: string[], options?: {
    cwd?: string;
    env?: Record<string, string>;
    spinner?: string;
    silent?: boolean;
}): Promise<ExecResult>;
/** Run a shell command and return true if exit code is 0. */
export declare function execOk(command: string, args: string[], options?: {
    cwd?: string;
    env?: Record<string, string>;
}): Promise<boolean>;
/** Run a shell command, stream output to terminal. */
export declare function execStream(command: string, args: string[], options?: {
    cwd?: string;
    env?: Record<string, string>;
}): Promise<number>;
//# sourceMappingURL=exec.d.ts.map