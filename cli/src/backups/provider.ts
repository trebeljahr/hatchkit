import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import {
  type BackupHostMeta,
  type BackupProviderMeta,
  getConfig,
  getStore,
  validateS3KeyPair,
} from "../config.js";
import { SECRET_KEYS, getSecret, setSecret } from "../utils/secrets.js";

export interface BackupCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  password: string;
}

/** A configured backup host and its name in `providers.backups.hosts`. */
export interface BackupHost extends BackupHostMeta {
  name: string;
}

/** The provider as written by `configure`: `hosts`, or the single `host`
 *  every config had before multi-host support. */
export type BackupProviderInput = Omit<BackupProviderMeta, "hosts"> & {
  hosts?: Record<string, BackupHostMeta>;
};

export const DEFAULT_BACKUP_SCHEDULE = "16:00";
const HOST_NAME = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const SCHEDULE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A legacy single host is named after its Tailscale hostname. */
export function legacyBackupHostName(target: string): string {
  return target.slice(target.indexOf("@") + 1).toLowerCase();
}

export function validateBackupHost(name: string, value: BackupHostMeta): BackupHostMeta {
  if (!HOST_NAME.test(name))
    throw new Error(
      `Backup host names use lowercase letters, digits, "." and "-" (got "${name}").`,
    );
  if (
    value?.transport !== "tailscale" ||
    !/^root@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value.target) ||
    !value.serverUuid
  ) {
    throw new Error(
      `Configure a root@hostname Tailscale target and its Coolify server UUID for backup host ${name}.`,
    );
  }
  if (value.schedule !== undefined && !SCHEDULE.test(value.schedule))
    throw new Error(`Backup schedules are a daily UTC time as HH:MM (got "${value.schedule}").`);
  return {
    transport: "tailscale",
    target: value.target,
    serverUuid: value.serverUuid,
    ...(value.schedule ? { schedule: value.schedule } : {}),
  };
}

export function validateBackupProvider(value: BackupProviderInput): BackupProviderMeta {
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
  if (value.hosts && value.host)
    throw new Error("providers.backups has both host and hosts; keep hosts.");
  const input =
    value.hosts ??
    (value.host?.target ? { [legacyBackupHostName(value.host.target)]: value.host } : {});
  const hosts: Record<string, BackupHostMeta> = {};
  for (const [name, host] of Object.entries(input)) hosts[name] = validateBackupHost(name, host);
  const list = Object.values(hosts);
  if (list.length === 0)
    throw new Error("Configure a root@hostname Tailscale target and its Coolify server UUID.");
  for (const key of ["target", "serverUuid"] as const) {
    if (new Set(list.map((host) => host[key])).size !== list.length)
      throw new Error(`Two backup hosts share one ${key}; each host needs its own.`);
  }
  return {
    status: "configured",
    repositoryBase: value.repositoryBase,
    hosts,
    autoRegister: value.autoRegister === true,
  };
}

export async function configureBackupProvider(
  input: BackupProviderInput & { credentialsFile: string; passwordFile: string },
) {
  const given = validateBackupProvider(input);
  // Hosts the input does not name stay configured: re-running configure
  // with an old single-host file must not drop a second host.
  let kept: Record<string, BackupHostMeta> = {};
  try {
    kept = backupProvider().hosts;
  } catch {
    // Not configured yet, or unreadable: configure is how that is fixed.
  }
  const metadata = validateBackupProvider({ ...given, hosts: { ...kept, ...given.hosts } });
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
  const existingSecret = await getSecret(SECRET_KEYS.backupCredentials);
  if (existingSecret && JSON.parse(existingSecret).password !== password)
    throw new Error(
      "Recovery password differs from Keychain. Keep the existing password so retained backups remain recoverable.",
    );
  await setSecret(SECRET_KEYS.backupCredentials, serialized);
  if ((await getSecret(SECRET_KEYS.backupCredentials)) !== serialized)
    throw new Error("Backup credential verification failed; provider metadata was not updated.");
  getStore().set("providers.backups", metadata);
  return { configured: true, credentialStore: "OS keychain", provider: metadata };
}

/** The provider with `hosts`, whichever shape the config file holds.
 *  Reading never rewrites the file; the next host change stores `hosts`. */
export function backupProvider(): BackupProviderMeta {
  const value = getConfig().providers.backups;
  if (!value || value.status !== "configured")
    throw new Error("Run hatchkit backup configure with your backup provider config first.");
  return validateBackupProvider(value);
}

export function backupHosts(): BackupHost[] {
  return Object.entries(backupProvider().hosts).map(([name, host]) => ({ name, ...host }));
}

/** The named host, or the only one. Several hosts and no name: refuse
 *  rather than guess which machine a command should touch. */
export function backupHost(name?: string): BackupHost {
  const hosts = backupHosts();
  const names = hosts.map((host) => host.name).join(", ");
  if (name) {
    const host = hosts.find((h) => h.name === name);
    if (!host) throw new Error(`No backup host named ${name}. Configured: ${names}.`);
    return host;
  }
  if (hosts.length === 1) return hosts[0];
  throw new Error(`Several backup hosts are configured (${names}). Pass --host <name>.`);
}

export function backupHostForServer(serverUuid: string): BackupHost | undefined {
  return backupHosts().find((host) => host.serverUuid === serverUuid);
}

/** `backup add-host`: one more host for the same bucket and credentials.
 *  Local config only; `backup install --host <name>` sets the host up. */
export function addBackupHost(input: {
  name: string;
  target: string;
  serverUuid: string;
  schedule?: string;
  dryRun: boolean;
}) {
  const provider = backupProvider();
  if (provider.hosts[input.name])
    throw new Error(`Backup host ${input.name} is already configured.`);
  const host = validateBackupHost(input.name, {
    transport: "tailscale",
    target: input.target,
    serverUuid: input.serverUuid,
    ...(input.schedule ? { schedule: input.schedule } : {}),
  });
  const next = validateBackupProvider({
    ...provider,
    hosts: { ...provider.hosts, [input.name]: host },
  });
  if (!input.dryRun) getStore().set("providers.backups", next);
  return {
    host: { name: input.name, ...host, schedule: host.schedule ?? DEFAULT_BACKUP_SCHEDULE },
    hosts: Object.keys(next.hosts),
    applied: !input.dryRun,
    nextStep: `hatchkit backup install --host ${input.name} --dry-run`,
  };
}

/** Drops a host from the local config. The caller checks that its policy
 *  holds no project first. */
export function forgetBackupHost(name: string) {
  const provider = backupProvider();
  const { [name]: _removed, ...hosts } = provider.hosts;
  getStore().set("providers.backups", validateBackupProvider({ ...provider, hosts }));
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
  host: BackupHost,
  command: string,
  input?: string,
  timeoutMs = 120_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("tailscale", ["ssh", host.target, command], {
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
            ? `Backup host ${host.name}: ${hostError}`
            : timedOut
              ? `Backup host ${host.name} command timed out after ${timeoutMs / 1000} s and was stopped. Check \`tailscale ssh ${host.target}\` and the host journal.`
              : `Backup host ${host.name} command failed (exit ${code ?? "signal"}). Check Tailscale and the host journal.`,
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
