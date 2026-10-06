/*
 * Moving a tag inside a container registry, without Docker.
 *
 * Deploys choose their image in the registry: every Coolify app pulls
 * `<image>:live`, and "deploy commit X" means "point `:live` at the
 * manifest `:X` points at, then signal the app" (see
 * deploy/coolify-deploy-hook.ts). Re-tagging is two calls of the OCI
 * distribution API — read the manifest by its source reference, write
 * the same bytes under the new tag — so the operator's machine and CI
 * can both do it with a plain `fetch` and a registry credential:
 *
 *   · CI: the job's own GITHUB_TOKEN (`packages: write`), which can only
 *     write this repository's packages.
 *   · hatchkit, seeding `:live` during a migration: the operator's `gh`
 *     token, which carries `write:packages`.
 *
 * The bytes are copied verbatim, never re-serialised: the digest of a
 * manifest is the sha256 of its exact bytes, and a re-encoded body would
 * name a different (and non-existent) image.
 */

import { createHash } from "node:crypto";

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Every manifest shape a multi-arch build or a plain build can push. */
export const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export interface ImageName {
  registry: string;
  repository: string;
}

/** `ghcr.io/owner/name[:tag]` → registry + repository. A reference
 *  without a registry host is Docker Hub, which hatchkit never deploys
 *  from, so it is refused rather than guessed. */
export function parseImageName(image: string): ImageName {
  const withoutTag = image.replace(/@sha256:[0-9a-f]{64}$/, "").replace(/:[\w][\w.-]*$/, "");
  const slash = withoutTag.indexOf("/");
  const host = slash === -1 ? "" : withoutTag.slice(0, slash);
  if (!host.includes(".") && !host.includes(":") && host !== "localhost") {
    throw new Error(`"${image}" names no registry host (expected e.g. ghcr.io/owner/name).`);
  }
  return { registry: host, repository: withoutTag.slice(slash + 1).toLowerCase() };
}

export interface RegistryAuth {
  username: string;
  password: string;
}

/** Parse a `WWW-Authenticate: Bearer realm="…",service="…"` challenge. */
export function parseBearerChallenge(
  header: string | null,
): { realm: string; service?: string } | null {
  if (!header || !/^Bearer\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) params[m[1].toLowerCase()] = m[2];
  return params.realm ? { realm: params.realm, service: params.service } : null;
}

/** A bearer token for pull (and optionally push) on one repository. */
export async function registryToken(
  fetchImpl: FetchLike,
  name: ImageName,
  auth: RegistryAuth,
  push: boolean,
): Promise<string> {
  const probe = await fetchImpl(`https://${name.registry}/v2/`, { method: "GET" });
  const challenge = parseBearerChallenge(probe.headers.get("www-authenticate"));
  if (!challenge) {
    throw new Error(`${name.registry} did not offer bearer authentication (HTTP ${probe.status}).`);
  }
  const url = new URL(challenge.realm);
  if (challenge.service) url.searchParams.set("service", challenge.service);
  url.searchParams.set("scope", `repository:${name.repository}:${push ? "pull,push" : "pull"}`);
  const basic = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
  const res = await fetchImpl(url.toString(), { headers: { Authorization: `Basic ${basic}` } });
  if (!res.ok) throw new Error(`${name.registry} refused a token (HTTP ${res.status}).`);
  const body = JSON.parse(await res.text()) as { token?: string; access_token?: string };
  const token = body.token ?? body.access_token;
  if (!token) throw new Error(`${name.registry} answered without a token.`);
  return token;
}

export interface Manifest {
  mediaType: string;
  body: string;
  digest: string;
}

/** The manifest a tag (or digest) names, or null when it does not exist. */
export async function readManifest(
  fetchImpl: FetchLike,
  name: ImageName,
  reference: string,
  token: string,
): Promise<Manifest | null> {
  const res = await fetchImpl(
    `https://${name.registry}/v2/${name.repository}/manifests/${reference}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT } },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`reading ${name.repository}:${reference} failed (HTTP ${res.status}).`);
  }
  const body = await res.text();
  const mediaType =
    res.headers.get("content-type")?.split(";")[0].trim() ||
    (JSON.parse(body) as { mediaType?: string }).mediaType ||
    "";
  const digest =
    res.headers.get("docker-content-digest") ??
    `sha256:${createHash("sha256").update(body).digest("hex")}`;
  return { mediaType, body, digest };
}

/** Point `to` at the manifest `from` names. Returns that manifest's
 *  digest, read back from the new tag: a registry that answered 201 and
 *  kept the old manifest would otherwise go unnoticed. */
export async function promoteTag(
  fetchImpl: FetchLike,
  input: { image: string; from: string; to: string; auth: RegistryAuth },
): Promise<{ digest: string }> {
  const name = parseImageName(input.image);
  const token = await registryToken(fetchImpl, name, input.auth, true);
  const source = await readManifest(fetchImpl, name, input.from, token);
  if (!source) {
    const ref = input.from.startsWith("sha256:") ? `@${input.from}` : `:${input.from}`;
    throw new Error(`${name.registry}/${name.repository}${ref} does not exist.`);
  }
  const put = await fetchImpl(
    `https://${name.registry}/v2/${name.repository}/manifests/${input.to}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": source.mediaType },
      body: source.body,
    },
  );
  if (!put.ok) {
    throw new Error(`writing ${name.repository}:${input.to} failed (HTTP ${put.status}).`);
  }
  const after = await readManifest(fetchImpl, name, input.to, token);
  if (!after || after.digest !== source.digest) {
    throw new Error(
      `${name.repository}:${input.to} does not point at ${input.from} after the update.`,
    );
  }
  return { digest: source.digest };
}
