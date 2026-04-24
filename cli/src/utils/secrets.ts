/*
 * Secrets store backed by the OS keychain (macOS Keychain / Windows
 * Credential Vault / GNOME libsecret) via `keytar`.
 *
 * Everything sensitive (tokens, passwords, access keys) goes here. The
 * Conf-backed JSON store in config.ts keeps only metadata (URLs, cached
 * server lists, `lastVerified` timestamps, status flags).
 *
 * Naming:
 *   service = "devops-cli"
 *   account = stable slug, e.g. "coolify:token", "s3:hetzner:secret-key"
 */

import keytar from "keytar";

// Tests set DEVOPS_CLI_KEYTAR_SERVICE to a throwaway value so they
// don't pollute the real user's keychain with scaffold-test artifacts.
// In normal runs this is unset and everything lives under "devops-cli".
const SERVICE = process.env.DEVOPS_CLI_KEYTAR_SERVICE ?? "devops-cli";

/** Well-known secret keys used across the CLI. New secrets should add
 *  their key here so `clearAllSecrets` can reach them on reset. */
export const SECRET_KEYS = {
  coolifyToken: "coolify:token",
  hetznerToken: "hetzner:token",
  dnsInwxPassword: "dns:inwx:password",
  dnsCloudflareToken: "dns:cloudflare:token",
  s3AccessKey: (provider: string) => `s3:${provider}:access-key`,
  s3SecretKey: (provider: string) => `s3:${provider}:secret-key`,
  gpuApiKey: (platform: string) => `gpu:${platform}:api-key`,
  glitchtipToken: "glitchtip:auth-token",
  openpanelToken: "openpanel:personal-access-token",
  openpanelClientSecret: (name: string) => `openpanel:${name}:client-secret`,
  resendApiKey: "resend:api-key",
  /** Per-scaffolded-project dotenvx private key for .env.production.
   *  Stored in the OS keychain so the CLI's on-disk state never holds
   *  decryption material for the starter's encrypted env. */
  dotenvxPrivateKey: (projectName: string) => `dotenvx:${projectName}:production-private-key`,
} as const;

export async function getSecret(key: string): Promise<string | null> {
  return keytar.getPassword(SERVICE, key);
}

export async function setSecret(key: string, value: string): Promise<void> {
  await keytar.setPassword(SERVICE, key, value);
}

export async function deleteSecret(key: string): Promise<boolean> {
  return keytar.deletePassword(SERVICE, key);
}

/** Wipe every secret belonging to this CLI from the keychain. */
export async function clearAllSecrets(): Promise<void> {
  const entries = await keytar.findCredentials(SERVICE);
  await Promise.all(entries.map((e) => keytar.deletePassword(SERVICE, e.account)));
}
