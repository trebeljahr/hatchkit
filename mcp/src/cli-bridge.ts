import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function runHatchkit(
  args: string[],
  options: { bin?: string; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<RunResult> {
  const bin = options.bin ?? process.env.HATCHKIT_BIN ?? "hatchkit";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const deadline = setTimeout(
      () => fail(new Error(`hatchkit timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    deadline.unref();

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref();
      reject(error);
    }

    function append(chunk: Buffer, stream: "stdout" | "stderr"): void {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        fail(new Error(`hatchkit output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      if (stream === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    }

    child.stdout.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    child.on("error", (error) => {
      const message =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `Could not find \`${bin}\` on PATH. Install hatchkit or set HATCHKIT_BIN.`
          : error.message;
      fail(new Error(message));
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

/** Read the final JSON payload even when older CLI versions print notices. */
export function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  for (const match of trimmed.matchAll(/(?:^|\n)(?=[ \t]*[\[{])/g)) {
    const candidate = trimmed
      .slice(match.index + (trimmed[match.index] === "\n" ? 1 : 0))
      .trimStart();
    try {
      return JSON.parse(candidate);
    } catch {
      // A preceding notice may contain braces; try the next line.
    }
  }
  throw new Error("hatchkit produced no JSON");
}

/** CLI diagnostics may contain provider responses or echoed configuration. */
export function scrubCliDiagnostic(
  text: string,
  env: Record<string, string | undefined> = process.env,
): string {
  let safe = stripVTControlCharacters(text);
  // Replace known secret values before clipping, including values without a
  // recognizable prefix. Never read the keychain to populate this list.
  for (const [name, value] of Object.entries(env)) {
    if (
      value &&
      value.length >= 4 &&
      /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY)/i.test(name)
    ) {
      safe = safe.split(value).join("[redacted]");
    }
  }
  safe = safe
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[redacted private key]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, "$1 [redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(
      /([?&](?:token|key|secret|password|signature|access_token|api_key)=)[^&#\s]*/gi,
      "$1[redacted]",
    )
    .replace(
      /(["']?\b(?:[\w-]*(?:token|secret|password|private[_-]?key|access[_-]?key)[\w-]*|key)["']?[ \t]*(?:[:=][ \t]*|[ \t]+))(?:(?:"[^"\r\n]*")|(?:'[^'\r\n]*')|[^\s,;}]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk_[A-Za-z0-9_-]+|AKIA[A-Z0-9]{16})\b/g,
      "[redacted]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted]");
  const limit = 4_000;
  return safe.length > limit ? `${safe.slice(0, limit)}\n[diagnostic truncated]` : safe.trim();
}

/** Nonzero status can carry valid doctor/key-lookup JSON; preserve that payload. */
export function parseHatchkitResult(result: RunResult): unknown {
  try {
    return parseJsonOutput(result.stdout);
  } catch {
    const diagnostic = scrubCliDiagnostic(result.stderr.trim() || result.stdout);
    throw new Error(
      `hatchkit exited with status ${result.code} without a JSON response.` +
        (diagnostic ? `\n${diagnostic}` : " Check the CLI installation and HATCHKIT_BIN."),
    );
  }
}
