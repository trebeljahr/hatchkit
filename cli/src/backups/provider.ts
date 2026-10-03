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

/** Always use Tailscale's authenticated SSH transport. No public SSH fallback. */
export function backupHostExec(
  command: string,
  input?: string,
  timeoutMs = 120_000,
): Promise<string> {
  const provider = backupProvider();
  return new Promise((resolve, reject) => {
    const child = spawn("tailscale", ["ssh", provider.host.target, command], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else {
        const auth = stderr.match(/https:\/\/login\.tailscale\.com\/a\/[a-zA-Z0-9]+/)?.[0];
        reject(
          new Error(
            auth
              ? `Complete the Tailscale SSH check: ${auth}`
              : `Backup host command failed (exit ${code ?? "timeout"}). Check Tailscale and the host journal.`,
          ),
        );
      }
    });
    child.stdin.end(input);
  });
}
