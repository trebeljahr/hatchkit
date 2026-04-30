/*
 * Secrets store backed by the OS keychain (macOS Keychain / Windows
 * Credential Vault / GNOME libsecret) via `keytar`.
 *
 * Everything sensitive (tokens, passwords, access keys) goes here. The
 * Conf-backed JSON store in config.ts keeps only metadata (URLs, cached
 * server lists, `lastVerified` timestamps, status flags).
 *
 * Naming:
 *   service = "hatchkit"
 *   account = stable slug, e.g. "coolify:token", "s3:hetzner:secret-key"
 */

import keytar from "keytar";

// Tests set HATCHKIT_KEYTAR_SERVICE to a throwaway value so they
// don't pollute the real user's keychain with scaffold-test artifacts.
// In normal runs this is unset and everything lives under "hatchkit".
const SERVICE = process.env.HATCHKIT_KEYTAR_SERVICE ?? "hatchkit";

/** Well-known secret keys used across the CLI. New secrets should add
 *  their key here so `clearAllSecrets` can reach them on reset. */
export const SECRET_KEYS = {
  coolifyToken: "coolify:token",
  hetznerToken: "hetzner:token",
  dnsInwxPassword: "dns:inwx:password",
  dnsCloudflareToken: "dns:cloudflare:token",
  /** Registrar password when DNS is on Cloudflare but the domain is
   *  registered at INWX. Used by the post-apply NS flip in deploy/terraform
   *  and by `hatchkit dns link-to-cloudflare`. */
  dnsInwxRegistrarPassword: "dns:inwx-registrar:password",
  s3AccessKey: (provider: string) => `s3:${provider}:access-key`,
  s3SecretKey: (provider: string) => `s3:${provider}:secret-key`,
  gpuApiKey: (platform: string) => `gpu:${platform}:api-key`,
  glitchtipToken: "glitchtip:auth-token",
  /** Root-mode OpenPanel client used by the Management API to auto-create
   *  per-project clients. Created once in the OpenPanel dashboard. */
  openpanelRootClientId: "openpanel:root-client-id",
  openpanelRootClientSecret: "openpanel:root-client-secret",
  openpanelClientSecret: (name: string) => `openpanel:${name}:client-secret`,
  resendApiKey: "resend:api-key",
  stripeSecretKey: "stripe:secret-key",
  stripePublishableKey: "stripe:publishable-key",
  /** Per-scaffolded-project dotenvx private key for .env.production.
   *  Stored in the OS keychain so the CLI's on-disk state never holds
   *  decryption material for the starter's encrypted env. */
  dotenvxPrivateKey: (projectName: string) => `dotenvx:${projectName}:production-private-key`,
  /** GitHub PAT (fine-grained, scope `read:packages`) that hatchkit hands
   *  to Coolify so it can pull private GHCR images. Single shared key —
   *  one PAT per machine covers every adopted private repo on the same
   *  Coolify install. Leave unset for public-everything deploys (Path A
   *  flips visibility=public instead of using a token). */
  ghcrPullToken: "ghcr:pull-token",
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
