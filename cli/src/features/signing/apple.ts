/*
 * cli/src/features/signing/apple.ts — App Store Connect API client.
 *
 * JWT auth (ES256 over the .p8 key). Idempotent operations:
 *   · Bundle ID  : GET /v1/bundleIds?filter[identifier]= → POST if absent
 *   · App record : GET /v1/apps?filter[bundleId]= → POST if absent
 *   · Profile    : GET /v1/profiles?filter[name]= → POST if absent
 *   · Profile content (.mobileprovision base64) for the GH secret.
 *
 * Re-runs that already have IDs in the project manifest GET-validate
 * them before re-creating; a 404 falls through to the create branch
 * (e.g. someone deleted the Bundle ID by hand in the portal).
 */

import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveUserPath } from "./render.js";
import type { OrgApple, SigningProjectConfig } from "./types.js";

const ASC_API_ROOT = "https://api.appstoreconnect.apple.com";

interface JwtSession {
  token: string;
  expiresAt: number;
}

const sessionCache = new Map<string, JwtSession>();

/** Build (and cache) an ES256 JWT for the given API key. Apple caps
 *  exp at iat+1200s. Cache buffer of 60s prevents reusing a token
 *  about to expire mid-request. */
export function getAscJwt(opts: OrgApple): string {
  const cacheKey = `${opts.apiIssuerId}:${opts.apiKeyId}:${opts.apiKeyP8Path}`;
  const now = Math.floor(Date.now() / 1000);
  const hit = sessionCache.get(cacheKey);
  if (hit && hit.expiresAt - 60 > now) return hit.token;

  const header = { alg: "ES256", kid: opts.apiKeyId, typ: "JWT" };
  const payload = {
    iss: opts.apiIssuerId,
    iat: now,
    exp: now + 1200,
    aud: "appstoreconnect-v1",
  };
  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const p8Pem = readFileSync(resolveUserPath(opts.apiKeyP8Path), "utf-8");
  const key = createPrivateKey({ key: p8Pem, format: "pem" });
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const derSig = signer.sign({ key, dsaEncoding: "ieee-p1363" });
  const sigB64Url = derSig.toString("base64url");
  const token = `${signingInput}.${sigB64Url}`;
  sessionCache.set(cacheKey, { token, expiresAt: now + 1200 });
  return token;
}

function base64UrlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

export interface AscClientOpts {
  apple: OrgApple;
  /** Override fetch — used by tests to mock HTTP. */
  fetchImpl?: typeof fetch;
}

interface AscBundleIdAttrs {
  identifier: string;
  name: string;
  platform?: string;
  seedId?: string;
}

interface AscProfileAttrs {
  name: string;
  profileType: string;
  profileContent?: string;
  uuid?: string;
}

interface AscAppAttrs {
  bundleId: string;
  name: string;
  primaryLocale: string;
  sku: string;
}

interface AscData<TAttrs, TRels = unknown> {
  type: string;
  id: string;
  attributes: TAttrs;
  relationships?: TRels;
}

interface AscResponse<TAttrs, TRels = unknown> {
  data: AscData<TAttrs, TRels>;
}

interface AscList<TAttrs, TRels = unknown> {
  data: Array<AscData<TAttrs, TRels>>;
}

export class AscClient {
  private readonly apple: OrgApple;
  private readonly fetch: typeof fetch;

  constructor(opts: AscClientOpts) {
    this.apple = opts.apple;
    this.fetch = opts.fetchImpl ?? fetch;
  }

  /** Find or create a Bundle ID record. Idempotent: returns the
   *  existing record id when the identifier is already registered for
   *  this team. */
  async ensureBundleId(input: { identifier: string; name: string }): Promise<{
    id: string;
    created: boolean;
  }> {
    const existing = await this.findBundleId(input.identifier);
    if (existing) return { id: existing.id, created: false };
    const body = {
      data: {
        type: "bundleIds",
        attributes: {
          identifier: input.identifier,
          name: input.name,
          platform: "UNIVERSAL",
        },
      },
    };
    const res = await this.req<AscResponse<AscBundleIdAttrs>>("POST", "/v1/bundleIds", body);
    return { id: res.data.id, created: true };
  }

  async findBundleId(identifier: string): Promise<AscData<AscBundleIdAttrs> | null> {
    const url = `/v1/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=1`;
    const res = await this.req<AscList<AscBundleIdAttrs>>("GET", url);
    return res.data[0] ?? null;
  }

  /** Find or create the App record. Apple requires a primaryLocale +
   *  SKU; both can be re-derived later, only the bundleIdResourceId is
   *  unique. */
  async ensureAppRecord(input: {
    bundleId: string;
    bundleIdResourceId: string;
    name: string;
    sku: string;
    primaryLocale?: string;
  }): Promise<{ id: string; created: boolean }> {
    const existing = await this.findAppByBundleId(input.bundleId);
    if (existing) return { id: existing.id, created: false };
    const body = {
      data: {
        type: "apps",
        attributes: {
          bundleId: input.bundleId,
          name: input.name,
          sku: input.sku,
          primaryLocale: input.primaryLocale ?? "en-US",
        },
        relationships: {
          bundleId: {
            data: { type: "bundleIds", id: input.bundleIdResourceId },
          },
        },
      },
    };
    const res = await this.req<AscResponse<AscAppAttrs>>("POST", "/v1/apps", body);
    return { id: res.data.id, created: true };
  }

  async findAppByBundleId(bundleId: string): Promise<AscData<AscAppAttrs> | null> {
    const url = `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`;
    const res = await this.req<AscList<AscAppAttrs>>("GET", url);
    return res.data[0] ?? null;
  }

  /** Resolve the Apple Distribution cert ID for this team. ASC's
   *  certificates endpoint returns the team's certificates; we pick
   *  the first one with `certificateType` matching DISTRIBUTION. */
  async findDistributionCertificateId(): Promise<string | null> {
    const url = "/v1/certificates?filter[certificateType]=DISTRIBUTION&limit=200";
    const res = await this.req<AscList<{ certificateType: string }>>("GET", url);
    return res.data[0]?.id ?? null;
  }

  /** Find or create an App Store distribution profile bound to the
   *  given Bundle ID + distribution cert. Returns the profile id +
   *  name; the .mobileprovision payload is fetched separately. */
  async ensureProfile(input: {
    profileName: string;
    bundleIdResourceId: string;
    certificateId: string;
  }): Promise<{ id: string; name: string; created: boolean }> {
    const existing = await this.findProfileByName(input.profileName);
    if (existing) {
      return { id: existing.id, name: existing.attributes.name, created: false };
    }
    const body = {
      data: {
        type: "profiles",
        attributes: {
          name: input.profileName,
          profileType: "IOS_APP_STORE",
        },
        relationships: {
          bundleId: {
            data: { type: "bundleIds", id: input.bundleIdResourceId },
          },
          certificates: {
            data: [{ type: "certificates", id: input.certificateId }],
          },
        },
      },
    };
    const res = await this.req<AscResponse<AscProfileAttrs>>("POST", "/v1/profiles", body);
    return { id: res.data.id, name: res.data.attributes.name, created: true };
  }

  async findProfileByName(name: string): Promise<AscData<AscProfileAttrs> | null> {
    const url = `/v1/profiles?filter[name]=${encodeURIComponent(name)}&limit=1`;
    const res = await this.req<AscList<AscProfileAttrs>>("GET", url);
    return res.data[0] ?? null;
  }

  /** Download the profile contents (.mobileprovision) as base64.
   *  Apple returns the content already base64-encoded under
   *  `attributes.profileContent`. */
  async getProfileBase64(profileId: string): Promise<string> {
    const url = `/v1/profiles/${profileId}?fields[profiles]=profileContent,name,uuid`;
    const res = await this.req<AscResponse<AscProfileAttrs>>("GET", url);
    const content = res.data.attributes.profileContent;
    if (!content) {
      throw new Error(`Profile ${profileId} returned no profileContent.`);
    }
    return content;
  }

  /** Validate a previously-stored Bundle ID / profile / app id. Used
   *  by re-runs: a 404 means the ID is stale and the caller should
   *  fall back to ensure*. */
  async validateBundleIdRef(id: string): Promise<boolean> {
    try {
      await this.req("GET", `/v1/bundleIds/${id}`);
      return true;
    } catch (err) {
      if ((err as AscApiError).status === 404) return false;
      throw err;
    }
  }

  private async req<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
    const url = `${ASC_API_ROOT}${urlPath}`;
    const token = getAscJwt(this.apple);
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
    const res = await this.fetch(url, init);
    if (!res.ok) {
      let detail = "";
      try {
        const json = (await res.json()) as { errors?: Array<{ detail?: string }> };
        detail =
          json.errors
            ?.map((e) => e.detail)
            .filter(Boolean)
            .join("; ") ?? "";
      } catch {
        // ignore body parse errors
      }
      const err: AscApiError = new Error(
        `ASC ${method} ${urlPath} → ${res.status}${detail ? ` (${detail})` : ""}`,
      ) as AscApiError;
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as T;
  }
}

export interface AscApiError extends Error {
  status?: number;
}

/** High-level orchestration: take an empty / partial signing-project
 *  config and bring it to "Apple ready" — bundle id resource + app
 *  record + profile + profile base64 contents.
 *
 *  Returns the resolved fields you want to merge back into
 *  manifest.signing + push as GH secrets. */
export async function provisionAppleForProject(input: {
  apple: OrgApple;
  project: Pick<SigningProjectConfig, "bundleId" | "appName" | "appSlug" | "appleSku">;
  reuse?: Pick<
    SigningProjectConfig,
    | "appleBundleIdResourceId"
    | "appleAppRecordId"
    | "appleProvisioningProfileId"
    | "appleProvisioningProfileName"
  >;
  fetchImpl?: typeof fetch;
}): Promise<{
  bundleIdResourceId: string;
  appRecordId: string;
  profileId: string;
  profileName: string;
  profileBase64: string;
  certificateId: string;
  createdBundleId: boolean;
  createdAppRecord: boolean;
  createdProfile: boolean;
}> {
  const client = new AscClient({ apple: input.apple, fetchImpl: input.fetchImpl });

  // Bundle ID — validate reused id; fall through to ensure if stale.
  let bundleIdResourceId = input.reuse?.appleBundleIdResourceId;
  let createdBundleId = false;
  if (bundleIdResourceId) {
    const ok = await client.validateBundleIdRef(bundleIdResourceId);
    if (!ok) bundleIdResourceId = undefined;
  }
  if (!bundleIdResourceId) {
    const r = await client.ensureBundleId({
      identifier: input.project.bundleId,
      name: input.project.appName,
    });
    bundleIdResourceId = r.id;
    createdBundleId = r.created;
  }

  // App record.
  let appRecordId = input.reuse?.appleAppRecordId;
  let createdAppRecord = false;
  if (!appRecordId) {
    const existing = await client.findAppByBundleId(input.project.bundleId);
    if (existing) {
      appRecordId = existing.id;
    } else {
      const r = await client.ensureAppRecord({
        bundleId: input.project.bundleId,
        bundleIdResourceId,
        name: input.project.appName,
        sku: input.project.appleSku ?? input.project.appSlug,
      });
      appRecordId = r.id;
      createdAppRecord = true;
    }
  }

  // Distribution certificate (the org's reusable Apple Distribution).
  const certificateId = await client.findDistributionCertificateId();
  if (!certificateId) {
    throw new Error(
      "No Apple Distribution certificate found in this team. Create one in developer.apple.com → Certificates and retry.",
    );
  }

  // Profile.
  const profileName =
    input.reuse?.appleProvisioningProfileName ?? `${input.project.appName} App Store`;
  const profile = await client.ensureProfile({
    profileName,
    bundleIdResourceId,
    certificateId,
  });
  const profileBase64 = await client.getProfileBase64(profile.id);

  return {
    bundleIdResourceId,
    appRecordId,
    profileId: profile.id,
    profileName: profile.name,
    profileBase64,
    certificateId,
    createdBundleId,
    createdAppRecord,
    createdProfile: profile.created,
  };
}
