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
  /** @deprecated Account-wide S3 access/secret pair. Used by the
   *  legacy single-project flow where every hatchkit-managed app
   *  shared one credential against all buckets — bad blast radius
   *  on leak. New code path is `s3ProjectAccessKey/secret` below:
   *  per-project credentials minted by hatchkit at provision-time
   *  and scoped to that project's buckets only.
   *
   *  Kept defined so the migration step in handleProvisionS3 can
   *  detect + delete legacy entries. Don't WRITE these from new
   *  code; reads are tolerated until the migration ships. */
  s3AccessKey: (provider: string) => `s3:${provider}:access-key`,
  s3SecretKey: (provider: string) => `s3:${provider}:secret-key`,
  /** Per-project S3 access/secret pair, scoped to that project's
   *  buckets only. Created by hatchkit at provision-time via
   *  CloudflareApi.createR2ApiToken (which calls POST /user/tokens
   *  with bucket-scoped resources, derives access = token id +
   *  secret = sha256(token value)). The user never pastes these. */
  s3ProjectAccessKey: (provider: string, project: string) => `s3:${provider}:${project}:access-key`,
  s3ProjectSecretKey: (provider: string, project: string) => `s3:${provider}:${project}:secret-key`,
  /** API token id of the per-project R2 token. Stored alongside
   *  the access/secret pair so `hatchkit destroy <project>` can
   *  delete the token (DELETE /user/tokens/<id>) instead of
   *  leaving orphaned tokens in the user's CF account. */
  s3ProjectTokenId: (provider: string, project: string) => `s3:${provider}:${project}:token-id`,
  /** Cloudflare API token with `Account > Workers R2 Storage > Edit`
   *  permission. Used by `hatchkit provision s3` to create R2 buckets,
   *  enable the managed `r2.dev` URL, and attach custom domains. Kept
   *  separate from `dns:cloudflare:token` because the DNS token is
   *  typically scoped narrowly to Zone:DNS:Edit + Zone:Zone:Read; the
   *  R2 admin endpoints need account-level perms which most users
   *  prefer not to mix into the DNS token (least-privilege rotation). */
  r2AdminToken: "s3:r2:admin-token",
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
