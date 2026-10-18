import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { type BackupProviderMeta, getConfig, getStore, validateS3KeyPair } from "../config.js";
import { SECRET_KEYS, getSecret, setSecret } from "../utils/secrets.js";

export interface BackupCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  password: string;
}

export function validateBackupProvider(value: BackupProviderMeta): BackupProviderMeta {
  if (!value.repositoryBase?.startsWith("s3:https://"))
    throw new Error("Use an HTTPS R2 repository URL.");
  const url = new URL(value.repositoryBase.slice(3));
  if (
    !url.hostname.endsWith(".r2.cloudflarestorage.com") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/[a-z0-9][a-z0-9-]+$/.test(url.pathname)
  ) {
    throw new Error(
      "Use an R2 endpoint and one private backup bucket, without embedded credentials.",
    );
  }
  if (
    value.host?.transport !== "tailscale" ||
    !/^root@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value.host.target) ||
    !value.host.serverUuid
  ) {
    throw new Error("Configure a root@hostname Tailscale target and its Coolify server UUID.");
  }
  return {
    status: "configured",
    repositoryBase: value.repositoryBase,
    host: value.host,
    autoRegister: value.autoRegister === true,
  };
}

export async function configureBackupProvider(
  input: BackupProviderMeta & { credentialsFile: string; passwordFile: string },
) {
  const metadata = validateBackupProvider(input);
  for (const path of [input.credentialsFile, input.passwordFile]) {
    if (statSync(path).mode & 0o077)
      throw new Error("Credential input files must be readable only by their owner.");
  }
  const keys = JSON.parse(readFileSync(input.credentialsFile, "utf8"));
  const problem = validateS3KeyPair("r2", keys.accessKeyId ?? "", keys.secretAccessKey ?? "");
  if (problem) throw new Error(problem);
  const password = readFileSync(input.passwordFile, "utf8").trim();
  if (password.length < 20)
    throw new Error("Use the existing restic recovery password (at least 20 characters).");
  const credentials: BackupCredentials = {
    accessKeyId: keys.accessKeyId,
    secretAccessKey: keys.secretAccessKey,
    password,
  };
  const serialized = JSON.stringify(credentials);
  const existing = await getSecret(SECRET_KEYS.backupCredentials);
  if (existing && JSON.parse(existing).password !== password)
    throw new Error(
      "Recovery password differs from Keychain. Keep the existing password so retained backups remain recoverable.",
    );
  await setSecret(SECRET_KEYS.backupCredentials, serialized);
  if ((await getSecret(SECRET_KEYS.backupCredentials)) !== serialized)
    throw new Error("Backup credential verification failed; provider metadata was not updated.");
  getStore().set("providers.backups", metadata);
  return { configured: true, credentialStore: "OS keychain", provider: metadata };
}

export function backupProvider(): BackupProviderMeta {
  const value = getConfig().providers.backups;
  if (!value || value.status !== "configured")
    throw new Error("Run hatchkit backup configure with your backup provider config first.");
  return validateBackupProvider(value);
}

export async function backupCredentials(): Promise<BackupCredentials> {
  const value = await getSecret(SECRET_KEYS.backupCredentials);
  if (!value)
    throw new Error(
      "Backup credentials are missing from the OS keychain. Run hatchkit backup configure.",
    );
  const parsed = JSON.parse(value) as BackupCredentials;
  if (validateS3KeyPair("r2", parsed.accessKeyId, parsed.secretAccessKey) || !parsed.password)
    throw new Error("Invalid backup credentials in the OS keychain.");
  return parsed;
}

/** Process groups of host commands still running (see backupHostExec). */
const liveGroups = new Set<number>();
const PARENT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function killGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: every process of the group has exited.
  }
}

function killLiveGroups() {
  for (const pgid of liveGroups) killGroup(pgid, "SIGKILL");
  liveGroups.clear();
}

function watchParent(on: boolean) {
  for (const signal of PARENT_SIGNALS) {
    if (on) process.on(signal, onParentSignal);
    else process.removeListener(signal, onParentSignal);
  }
  if (on) process.on("exit", killLiveGroups);
  else process.removeListener("exit", killLiveGroups);
}

/** A command in its own process group no longer gets the terminal's
 *  Ctrl+C. Take it down with us, then die of the signal as Node would. */
function onParentSignal(signal: NodeJS.Signals) {
  killLiveGroups();
  watchParent(false);
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

/**
 * Always use Tailscale's authenticated SSH transport. No public SSH fallback.
 *
 * Settles within `timeoutMs` plus a few seconds, whatever the child does.
 * `tailscale` on macOS is a shell wrapper that runs the app binary, which
 * execs ssh, so ssh is a grandchild. Signalling the child stopped only the
 * wrapper, the orphaned ssh kept the stdio pipes open, "close" never came,
 * and `migrate-client --cleanup` hung for good (broadcastdock, 2026-10-19).
 * So the child leads its own process group, the timeout stops the whole
 * group, and the call settles on "exit" when something else keeps the
 * pipes open.
 */
export function backupHostExec(
  command: string,
  input?: string,
  timeoutMs = 120_000,
): Promise<string> {
  const provider = backupProvider();
  return new Promise((resolve, reject) => {
    const child = spawn("tailscale", ["ssh", provider.host.target, command], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const pgid = child.pid;
    if (pgid) {
      if (liveGroups.size === 0) watchParent(true);
      liveGroups.add(pgid);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const failure = (code: number | null) => {
      const auth = stderr.match(/https:\/\/login\.tailscale\.com\/a\/[a-zA-Z0-9]+/)?.[0];
      // The host scripts print only sanitized BackupError text as
      // {"ok": false, "error": …}; anything else stays generic.
      const hostError = (() => {
        try {
          const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "");
          return parsed?.ok === false && typeof parsed.error === "string" ? parsed.error : null;
        } catch {
          return null;
        }
      })();
      return new Error(
        auth
          ? `Complete the Tailscale SSH check: ${auth}`
          : hostError
            ? `Backup host: ${hostError}`
            : timedOut
              ? `Backup host command timed out after ${timeoutMs / 1000} s and was stopped. Check \`tailscale ssh ${provider.host.target}\` and the host journal.`
              : `Backup host command failed (exit ${code ?? "signal"}). Check Tailscale and the host journal.`,
      );
    };
    /** `stop`: something may still run in the group, and it belongs to
     *  this command. A clean "close" means every pipe holder is gone. */
    const finish = (code: number | null, stop: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      if (pgid) {
        if (stop) killGroup(pgid, "SIGKILL");
        if (liveGroups.delete(pgid) && liveGroups.size === 0) watchParent(false);
      }
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
      if (error) reject(error);
      else if (code === 0 && !timedOut) resolve(stdout);
      else reject(failure(code));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (pgid) killGroup(pgid, "SIGTERM");
      // What ignores SIGTERM gets SIGKILL from finish().
      drain = setTimeout(() => finish(null, true), 2_000);
    }, timeoutMs);
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => finish(null, true, error));
    // "close" waits for every process holding the pipes. After "exit",
    // read what is already buffered, then stop waiting for the rest.
    child.on("exit", (code) => {
      clearTimeout(drain);
      drain = setTimeout(() => finish(code, true), 1_000);
    });
    child.on("close", (code) => finish(code, false));
    child.stdin.end(input);
  });
}
