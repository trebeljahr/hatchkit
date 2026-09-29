// Cloudflare REST API client.
//
// Used by:
//   · `hatchkit dns link-to-cloudflare` — verifies a token and lists
//     zones so we can cross-reference them against domains registered
//     at INWX (standalone migration / reconciliation).
//   · `hatchkit gh-pages` — upserts apex A records (or a subdomain
//     CNAME) for a GitHub Pages site, with proxied=false because the
//     orange cloud breaks Pages' Let's Encrypt cert issuance.
//
// During a normal `hatchkit create` flow the DNS records themselves
// go through Terraform (modules/cloudflare-dns) — this client is for
// command-line paths that don't run a full Terraform stack.

export interface CloudflareZone {
  id: string;
  name: string;
  name_servers: string[];
  status: string;
  account?: { id: string; name?: string };
}

/** DNS record types hatchkit knows how to upsert. The original code only
 *  supported A/AAAA/CNAME; MX and TXT were added for the email feature
 *  (MX servers for Cloudflare Email Routing + SPF/DMARC/DKIM TXT). */
export type CfDnsRecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT";

export interface CfDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  priority?: number;
  ttl?: number;
}

/** A single record in Cloudflare's "recommended DNS for Email Routing"
 *  response (`GET /zones/{id}/email/routing/dns`). MX entries carry a
 *  priority; TXT entries don't. */
export interface CfEmailRoutingDnsRecord {
  type: "MX" | "TXT";
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
}

export interface CfEmailRoutingSettings {
  /** Email Routing enabled on this zone. */
  enabled: boolean;
  /** Routing service hostname assigned by Cloudflare. */
  name?: string;
  /** "ready" | "unconfigured" | "misconfigured" | "locked" (CF docs). */
  status?: string;
  skip_wizard?: boolean;
  tag?: string;
}

export interface CfEmailDestination {
  id: string;
  /** Destination email address. */
  email: string;
  /** "pending" until the user clicks the verify link, "active" after. */
  verified?: string | null;
  created?: string;
  modified?: string;
}

export interface CfEmailRoutingMatcher {
  type: "literal" | "all";
  field?: "to";
  value?: string;
}

export interface CfEmailRoutingAction {
  type: "forward" | "worker" | "drop";
  value?: string[];
}

export interface CfEmailRoutingRule {
  id?: string;
  tag?: string;
  name?: string;
  enabled?: boolean;
  priority?: number;
  matchers: CfEmailRoutingMatcher[];
  actions: CfEmailRoutingAction[];
}

/** A single Cloudflare R2 CORS rule. Mirrors the shape Cloudflare's
 *  PUT/GET `/r2/buckets/<bucket>/cors` endpoint accepts and returns —
 *  only the fields hatchkit actually sets are listed. The bucket policy
 *  is single-rule (Cloudflare doesn't support per-prefix rules). */
export interface R2CorsRule {
  allowed: {
    origins: string[];
    methods: string[];
    headers?: string[];
  };
  exposeHeaders?: string[];
  maxAgeSeconds?: number;
}

/** A hostname bound to a Worker as a Custom Domain. Cloudflare creates
 *  the proxied DNS record and the certificate for it, which is why it
 *  refuses to attach one over a hostname that already has records
 *  (error 100117). */
export interface CfWorkerCustomDomain {
  id: string;
  hostname: string;
  zone_id: string;
  zone_name: string;
  service: string;
  environment: string;
}

/** Outcome of probing one Cloudflare API-token permission. `ok` means
 *  the probe call succeeded; `detail` explains a failure in terms the
 *  user can act on. */
/** One policy of an API token, as `GET …/tokens/{id}` returns it. */
export interface CfTokenPolicy {
  effect: string;
  permission_groups: Array<{ id: string; name?: string }>;
  resources: Record<string, unknown>;
}

export interface CfPermissionProbe {
  /** Permission as it is spelled in the token editor UI. */
  permission: string;
  ok: boolean;
  detail?: string;
}

export interface CloudflareApiOptions {
  token: string;
  /** Optional: filter to one account. Useful if the token spans multiple. */
  accountId?: string;
}

interface CfResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: unknown[];
  result: T;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    total_count: number;
  };
}

const API_BASE = "https://api.cloudflare.com/client/v4";
const CF_API_TIMEOUT_MS = 30_000;

/** Cloudflare REST API client. */
export class CloudflareApi {
  private token: string;
  private accountId?: string;

  constructor(options: CloudflareApiOptions) {
    this.token = options.token;
    this.accountId = options.accountId;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(CF_API_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Cloudflare ${method} ${path} failed: ${(err as Error).message}`);
    }

    const json = (await res.json().catch(() => null)) as CfResponse<T> | null;
    if (!res.ok || !json || !json.success) {
      const errMsg =
        json?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? res.statusText;
      // The status rides along as a property: several endpoints answer a
      // missing resource with a message that never says "not found".
      throw Object.assign(new Error(`Cloudflare ${method} ${path} failed: ${errMsg}`), {
        status: res.status,
      });
    }
    return json.result;
  }

  /** Verify the token. "active" means it works. */
  async verifyToken(): Promise<string> {
    const data = await this.request<{ status: string; id: string }>("GET", "/user/tokens/verify");
    return data.status;
  }

  /**
   * List all zones accessible with this token, optionally filtered to one
   * account. Paginates through the whole result set (CF caps per_page at
   * 50). Safety valve: hard stop at 20 pages (= 1000 zones) to avoid
   * runaway loops if the API misbehaves.
   */
  async listZones(): Promise<CloudflareZone[]> {
    const all: CloudflareZone[] = [];
    let page = 1;
    while (page <= 20) {
      const query = new URLSearchParams({ per_page: "50", page: String(page) });
      if (this.accountId) query.set("account.id", this.accountId);
      const path = `/zones?${query.toString()}`;
      let res: Response;
      try {
        res = await fetch(`${API_BASE}${path}`, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(CF_API_TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(`Cloudflare GET /zones failed: ${(err as Error).message}`);
      }
      const json = (await res.json().catch(() => null)) as CfResponse<CloudflareZone[]> | null;
      if (!res.ok || !json || !json.success) {
        const errMsg =
          json?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? res.statusText;
        throw new Error(`Cloudflare GET /zones failed: ${errMsg}`);
      }
      all.push(...json.result);
      const totalPages = json.result_info?.total_pages ?? 1;
      if (page >= totalPages) break;
      page += 1;
    }
    return all;
  }

  /** Look up a single zone by name. Returns null if not found. */
  async getZoneByName(name: string): Promise<CloudflareZone | null> {
    const query = new URLSearchParams({ name });
    if (this.accountId) query.set("account.id", this.accountId);
    const data = await this.request<CloudflareZone[]>("GET", `/zones?${query.toString()}`);
    return data[0] ?? null;
  }

  /** Find the closest Cloudflare zone that can manage a hostname.
   *  Tries the hostname itself first, then parent suffixes. For
   *  `connection.example.com`, this returns `connection.example.com`
   *  when delegated as its own zone, otherwise `example.com`. */
  async resolveZoneForName(name: string): Promise<CloudflareZone | null> {
    const labels = name
      .trim()
      .toLowerCase()
      .replace(/^\*\./, "")
      .replace(/\.$/, "")
      .split(".")
      .filter(Boolean);
    for (let i = 0; i < labels.length - 1; i++) {
      const zone = await this.getZoneByName(labels.slice(i).join("."));
      if (zone) return zone;
    }
    return null;
  }

  /** Find an exact name+type DNS record in a zone, or null. MX/TXT
   *  records are uniquely identified by (name, type, content) — multiple
   *  TXT records can coexist at the same name (e.g. SPF + DMARC siblings)
   *  and a host can have several MX records at different priorities.
   *  Pass `content` for those types so we resolve the right one. */
  async findRecord(
    zoneId: string,
    name: string,
    type: CfDnsRecordType,
    content?: string,
  ): Promise<CfDnsRecord | null> {
    const query = new URLSearchParams({ name, type });
    if (content && (type === "TXT" || type === "MX")) query.set("content", content);
    const data = await this.request<CfDnsRecord[]>(
      "GET",
      `/zones/${zoneId}/dns_records?${query.toString()}`,
    );
    return data[0] ?? null;
  }

  /** List every DNS record at a name (optionally filtered by type).
   *  Distinct from {@link findRecord} because apex Pages setups create
   *  four A records sharing the same name — `findRecord` only returns one. */
  async findRecordsByName(
    zoneId: string,
    name: string,
    type?: CfDnsRecordType,
  ): Promise<CfDnsRecord[]> {
    const query = new URLSearchParams({ name });
    if (type) query.set("type", type);
    return this.request<CfDnsRecord[]>("GET", `/zones/${zoneId}/dns_records?${query.toString()}`);
  }

  /** Upsert a DNS record by name+type (+content for TXT/MX). Idempotent —
   *  re-runs on the same inputs return without changes if the record
   *  already matches. `proxied: true` enables the orange-cloud Cloudflare
   *  proxy (only valid for A/AAAA/CNAME; ignored for MX/TXT).
   *
   *  TXT/MX semantics: TXT and MX records are identified by (name, type,
   *  content) — the caller may want SPF and DMARC TXT siblings at the
   *  same name without one overwriting the other, and MX records use
   *  priority + mail-host content as their identity. We pass `content`
   *  to `findRecord` so each upsert targets the right sibling. */
  async upsertRecord(
    zoneId: string,
    params: {
      type: CfDnsRecordType;
      name: string;
      content: string;
      proxied?: boolean;
      ttl?: number;
      /** Required for MX. Ignored for other types. */
      priority?: number;
      /** Classify only — performs the read + comparison but never
       *  POSTs/PATCHes. `created`/`updated` report what a real run
       *  WOULD do; `id` is empty for would-create records. */
      dryRun?: boolean;
    },
  ): Promise<{ id: string; created: boolean; updated: boolean }> {
    const isMx = params.type === "MX";
    const isTxt = params.type === "TXT";
    // For MX/TXT, identify the existing record by name+type+content so
    // sibling records (multiple MX hosts, SPF vs DMARC TXT) don't clobber
    // each other. For A/AAAA/CNAME, identity is just name+type.
    const existing = await this.findRecord(
      zoneId,
      params.name,
      params.type,
      isMx || isTxt ? params.content : undefined,
    );
    const body: Record<string, unknown> = {
      type: params.type,
      name: params.name,
      content: params.content,
      ttl: params.ttl ?? 1,
    };
    // proxied only applies to A/AAAA/CNAME. MX/TXT have no proxy concept.
    if (!isMx && !isTxt) body.proxied = params.proxied ?? true;
    if (isMx) {
      if (params.priority === undefined) {
        throw new Error("MX records require a `priority` value.");
      }
      body.priority = params.priority;
    }
    if (!existing) {
      if (params.dryRun) return { id: "", created: true, updated: false };
      const created = await this.request<{ id: string }>(
        "POST",
        `/zones/${zoneId}/dns_records`,
        body,
      );
      return { id: created.id, created: true, updated: false };
    }
    const proxiedSame =
      isMx || isTxt ? true : (existing.proxied ?? false) === (params.proxied ?? true);
    const prioritySame = isMx ? (existing.priority ?? null) === params.priority : true;
    const same =
      existing.content === params.content &&
      existing.type === params.type &&
      proxiedSame &&
      prioritySame;
    if (same) return { id: existing.id, created: false, updated: false };
    if (params.dryRun) return { id: existing.id, created: false, updated: true };
    const updated = await this.request<{ id: string }>(
      "PATCH",
      `/zones/${zoneId}/dns_records/${existing.id}`,
      body,
    );
    return { id: updated.id, created: false, updated: true };
  }

  /** Delete a DNS record by id. Returns "not-found" on 404 so the
   *  caller can treat already-gone records as success during rollback. */
  async deleteRecord(zoneId: string, recordId: string): Promise<"deleted" | "not-found"> {
    try {
      await this.request<unknown>("DELETE", `/zones/${zoneId}/dns_records/${recordId}`);
      return "deleted";
    } catch (err) {
      const msg = (err as Error).message;
      if (/81044|not\s*found|404/i.test(msg)) return "not-found";
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Zone-level settings (edge hardening)
  // ---------------------------------------------------------------------
  //
  // Cloudflare exposes per-zone toggles under `/zones/{id}/settings/{name}`.
  // We use a curated subset to give every hatchkit-deployed site sane edge
  // defaults — see `enableEdgeHardening`. The full setting catalog lives at
  // https://developers.cloudflare.com/api/operations/zone-settings-get-all-zone-settings.
  //
  // Naming-convention note: Cloudflare returns each setting wrapped in
  // `{ id, value, modified_on, editable }`. We GET the value first so we
  // can skip a no-op PATCH (and so we don't blindly overwrite when the
  // user has set something stricter — e.g. they'd already enabled
  // `min_tls_version: "1.3"` and we shouldn't pull it back to 1.2).

  /** Read a single zone setting's current value. Used by
   *  `enableEdgeHardening` to skip no-op PATCHes (and avoid downgrading
   *  user-set stricter values). Returns the raw `value` field — typed
   *  loosely because each setting has its own value shape. */
  async getZoneSetting(zoneId: string, settingId: string): Promise<unknown> {
    const data = await this.request<{ id: string; value: unknown }>(
      "GET",
      `/zones/${zoneId}/settings/${settingId}`,
    );
    return data.value;
  }

  /** Patch a single zone setting. Returns the new value. */
  async setZoneSetting(zoneId: string, settingId: string, value: unknown): Promise<unknown> {
    const data = await this.request<{ id: string; value: unknown }>(
      "PATCH",
      `/zones/${zoneId}/settings/${settingId}`,
      { value },
    );
    return data.value;
  }

  /** Apply hatchkit's curated edge-hardening defaults idempotently.
   *  Only changes settings that are currently weaker than the target —
   *  stricter user-set values are left alone (e.g. if the user has TLS
   *  1.3 enforced, we don't pull it back to 1.2).
   *
   *  Settings (and why):
   *    · `always_use_https = on` — 301s plain `http://` to `https://`
   *      at the edge so users who type the bare URL aren't left wondering
   *      why nothing loads. Default off, has to be opted in.
   *    · `ssl = full` — Cloudflare → origin uses HTTPS, but accepts
   *      self-signed certs. Coolify auto-issues Let's Encrypt at the
   *      origin but the cert can be a few seconds late on a cold deploy;
   *      `full` (vs `full (strict)`) means we don't 526 the user during
   *      that window. Bump to `strict` once the deploy is stable.
   *    · `min_tls_version = 1.2` — drops legacy TLS 1.0/1.1 with no
   *      practical compat cost in 2026.
   *    · `automatic_https_rewrites = on` — Cloudflare rewrites any
   *      remaining `http://` references in HTML responses, killing the
   *      mixed-content warnings that bite static-export apps.
   *
   *  Returns a per-setting summary for the caller to log. */
  // ---------------------------------------------------------------------
  // R2 admin (account-level) — bucket create + public-domain wiring
  // ---------------------------------------------------------------------
  //
  // The S3-compatible API used at runtime (PutObject etc.) takes
  // access-key / secret-key auth against `<account>.r2.cloudflarestorage.com`.
  // The admin endpoints used here are different: they take the same
  // Bearer token used elsewhere on this client, but the token must
  // carry the `Workers R2 Storage:Edit` permission scoped to the
  // account. A token that only has Zone:DNS:Edit (the typical
  // hatchkit DNS token) will 403 here. Callers should surface that
  // as a clear "add R2 perm to your token" hint.
  //
  // Idempotency:
  //   · createR2Bucket → 409 on duplicate; we treat as success.
  //   · enableR2ManagedDomain → PUT, idempotent by definition.
  //   · addR2CustomDomain → 409 on duplicate hostname; treat as success
  //     and re-fetch the existing config.

  /** Create a bucket. Returns the metadata. If the bucket already
   *  exists (409), returns `{ existed: true }` plus a fresh GET. */
  async createR2Bucket(
    accountId: string,
    name: string,
    opts: {
      locationHint?: string;
      storageClass?: "Standard" | "InfrequentAccess";
    } = {},
  ): Promise<{
    name: string;
    location?: string;
    creation_date?: string;
    storage_class?: string;
    existed: boolean;
  }> {
    const body: Record<string, unknown> = { name };
    if (opts.locationHint) body.locationHint = opts.locationHint;
    if (opts.storageClass) body.storageClass = opts.storageClass;
    try {
      const res = await this.request<{
        name: string;
        location?: string;
        creation_date?: string;
        storage_class?: string;
      }>("POST", `/accounts/${accountId}/r2/buckets`, body);
      return { ...res, existed: false };
    } catch (err) {
      const msg = (err as Error).message;
      // CF returns 10004 ("The bucket you tried to create already exists")
      // for dupes. Match on either the code or "already exists".
      if (/10004|already exists|409/i.test(msg)) {
        const existing = await this.getR2Bucket(accountId, name);
        return { ...(existing ?? { name }), existed: true };
      }
      throw err;
    }
  }

  /** List every R2 bucket on the account. Used by `hatchkit overview`
   *  to show a fleet-level inventory without iterating naming-convention
   *  candidates. */
  async listR2Buckets(accountId: string): Promise<
    Array<{
      name: string;
      location?: string;
      creation_date?: string;
      storage_class?: string;
    }>
  > {
    type Resp = {
      buckets?: Array<{
        name: string;
        location?: string;
        creation_date?: string;
        storage_class?: string;
      }>;
    };
    const res = await this.request<Resp>("GET", `/accounts/${accountId}/r2/buckets`);
    return res.buckets ?? [];
  }

  /** Get bucket metadata. Returns null on 404. */
  async getR2Bucket(
    accountId: string,
    name: string,
  ): Promise<{
    name: string;
    location?: string;
    creation_date?: string;
    storage_class?: string;
  } | null> {
    try {
      return await this.request("GET", `/accounts/${accountId}/r2/buckets/${name}`);
    } catch (err) {
      if (/404|not\s*found|10006/i.test((err as Error).message)) return null;
      throw err;
    }
  }

  /** Delete a bucket. Idempotent: 404 → "not-found".
   *
   *  Cloudflare refuses to delete a bucket that still has objects in
   *  it (returns 10039 / "bucket is not empty"); the caller should
   *  surface that as a `RollbackSkip` with a recipe for the user to
   *  empty manually rather than silently destroying their data.
   *  We don't auto-empty here — that's a destructive choice that
   *  belongs at the rollback layer, not the API client.
   */
  async deleteR2Bucket(
    accountId: string,
    name: string,
  ): Promise<"deleted" | "not-found" | "not-empty"> {
    try {
      await this.request<unknown>("DELETE", `/accounts/${accountId}/r2/buckets/${name}`);
      return "deleted";
    } catch (err) {
      const msg = (err as Error).message;
      if (/404|not\s*found|10006/i.test(msg)) return "not-found";
      if (/10039|not\s*empty|bucket\s*is\s*not\s*empty/i.test(msg)) return "not-empty";
      throw err;
    }
  }

  /** Enable (or disable) the managed `pub-<hash>.r2.dev` public URL on
   *  a bucket. Returns the assigned `pub-<hash>.r2.dev` hostname. */
  async enableR2ManagedDomain(
    accountId: string,
    bucket: string,
    enabled = true,
  ): Promise<{ bucketId: string; domain: string; enabled: boolean }> {
    return this.request("PUT", `/accounts/${accountId}/r2/buckets/${bucket}/domains/managed`, {
      enabled,
    });
  }

  /** List custom domains attached to a bucket — used to short-circuit
   *  re-runs that already added the domain. */
  async listR2CustomDomains(
    accountId: string,
    bucket: string,
  ): Promise<
    Array<{
      domain: string;
      enabled: boolean;
      status?: { ownership?: string; ssl?: string };
    }>
  > {
    type Resp = {
      domains?: Array<{
        domain: string;
        enabled: boolean;
        status?: { ownership?: string; ssl?: string };
      }>;
    };
    const res = await this.request<Resp>(
      "GET",
      `/accounts/${accountId}/r2/buckets/${bucket}/domains/custom`,
    );
    return res.domains ?? [];
  }

  /** Mint a per-bucket-scoped R2 API token. Returns the token's S3
   *  access/secret derivation alongside the raw token id+value (the
   *  caller can store the access/secret pair as the project's S3
   *  credentials, or hold the token value to use as a Bearer for R2
   *  admin calls scoped to those buckets).
   *
   *  The token resource scope follows Cloudflare's R2 format:
   *    `com.cloudflare.edge.r2.bucket.<accountId>_<jurisdiction>_<bucketName>`
   *  with jurisdiction = "default" for buckets created without an
   *  explicit jurisdiction (which is what `createR2Bucket` does today).
   *
   *  Permission groups are looked up dynamically by name — Cloudflare
   *  doesn't publish stable IDs, only stable names. We cache the result
   *  on the instance so subsequent calls in the same process re-use it.
   *
   *  Note on the calling token: this hits `POST /user/tokens` which
   *  requires the calling token to have `User > API Tokens > Edit`.
   *  An R2-only admin token will 403 here. The caller should surface
   *  that as a "add API Tokens:Edit to your admin token" hint. */
  async createR2ApiToken(params: {
    accountId: string;
    /** Display name for the token in the CF dashboard. Project name is
     *  the natural choice. */
    name: string;
    /** Bucket names to scope the token to. Token can only access these. */
    bucketNames: string[];
    /** Bucket jurisdiction. Defaults to "default" — matches how
     *  `createR2Bucket` creates buckets without explicit jurisdiction. */
    jurisdiction?: "default" | "eu" | "fedramp";
    /** Permissions scope for the resulting S3 keys. Default: read+write. */
    permissions?: "read" | "read-write";
  }): Promise<{
    /** API token id — the same thing as the S3 Access Key ID. */
    tokenId: string;
    /** API token value (raw bearer). Sensitive. */
    tokenValue: string;
    /** S3 Access Key ID, derived per Cloudflare's docs (same as tokenId). */
    accessKeyId: string;
    /** S3 Secret Access Key — sha256(tokenValue), hex. */
    secretAccessKey: string;
  }> {
    const jurisdiction = params.jurisdiction ?? "default";
    const permissions = params.permissions ?? "read-write";

    // Resolve permission groups by name. Cached on the instance so
    // multi-bucket runs only pay the lookup once.
    const wanted: string[] =
      permissions === "read"
        ? ["Workers R2 Storage Bucket Item Read"]
        : ["Workers R2 Storage Bucket Item Read", "Workers R2 Storage Bucket Item Write"];
    const groups = await this.getPermissionGroups();
    const groupIds: string[] = [];
    for (const name of wanted) {
      const found = groups.find((g) => g.name === name);
      if (!found) {
        throw new Error(
          `Permission group "${name}" not found in /user/tokens/permission_groups. The Cloudflare API may have renamed it; verify at https://dash.cloudflare.com/profile/api-tokens.`,
        );
      }
      groupIds.push(found.id);
    }

    // Build the resources map: one entry per bucket, format per docs.
    const resources: Record<string, "*"> = {};
    for (const bucket of params.bucketNames) {
      const key = `com.cloudflare.edge.r2.bucket.${params.accountId}_${jurisdiction}_${bucket}`;
      resources[key] = "*";
    }

    const body = {
      name: params.name,
      policies: [
        {
          effect: "allow" as const,
          permission_groups: groupIds.map((id) => ({ id })),
          resources,
        },
      ],
    };
    const res = await this.request<{ id: string; value: string }>("POST", "/user/tokens", body);
    const { createHash } = await import("node:crypto");
    const secretAccessKey = createHash("sha256").update(res.value).digest("hex");
    return {
      tokenId: res.id,
      tokenValue: res.value,
      accessKeyId: res.id,
      secretAccessKey,
    };
  }

  /** Mint a per-bucket-scoped R2 **Account** API token via
   *  `POST /accounts/{accountId}/tokens`. Same resource policy shape as
   *  `createR2ApiToken`, but the token is account-scoped (visible in
   *  `R2 → Manage R2 API Tokens` in the dashboard, and tied to the
   *  account rather than the user — survives any one user being
   *  removed from the account).
   *
   *  Why this exists alongside `createR2ApiToken`: the user-token
   *  variant predates this, requires `User > API Tokens > Edit` on
   *  the calling token, and tucks the result into a list users
   *  rarely visit (`Profile > API Tokens`). New code paths use this
   *  one; the user-token flavour stays for legacy migration only
   *  (revoking old user-tokens during provision).
   *
   *  The calling token needs `Account Settings > Edit` (which lets it
   *  create account tokens). An R2-only admin token won't have that
   *  by default — the caller surfaces a hint when the 403 comes back.
   */
  async createR2AccountToken(params: {
    accountId: string;
    name: string;
    bucketNames: string[];
    jurisdiction?: "default" | "eu" | "fedramp";
    permissions?: "read" | "read-write";
  }): Promise<{
    tokenId: string;
    tokenValue: string;
    accessKeyId: string;
    secretAccessKey: string;
  }> {
    const jurisdiction = params.jurisdiction ?? "default";
    const permissions = params.permissions ?? "read-write";

    const wanted: string[] =
      permissions === "read"
        ? ["Workers R2 Storage Bucket Item Read"]
        : ["Workers R2 Storage Bucket Item Read", "Workers R2 Storage Bucket Item Write"];
    const groups = await this.getPermissionGroups(params.accountId);
    const groupIds: string[] = [];
    for (const name of wanted) {
      const found = groups.find((g) => g.name === name);
      if (!found) {
        throw new Error(
          `Permission group "${name}" not found in /accounts/${params.accountId}/tokens/permission_groups. The Cloudflare API may have renamed it.`,
        );
      }
      groupIds.push(found.id);
    }

    const resources: Record<string, "*"> = {};
    for (const bucket of params.bucketNames) {
      const key = `com.cloudflare.edge.r2.bucket.${params.accountId}_${jurisdiction}_${bucket}`;
      resources[key] = "*";
    }

    const body = {
      name: params.name,
      policies: [
        {
          effect: "allow" as const,
          permission_groups: groupIds.map((id) => ({ id })),
          resources,
        },
      ],
    };
    const res = await this.request<{ id: string; value: string }>(
      "POST",
      `/accounts/${params.accountId}/tokens`,
      body,
    );
    const { createHash } = await import("node:crypto");
    const secretAccessKey = createHash("sha256").update(res.value).digest("hex");
    return {
      tokenId: res.id,
      tokenValue: res.value,
      accessKeyId: res.id,
      secretAccessKey,
    };
  }

  /** GET /accounts/{accountId}/tokens/{tokenId} — used to verify a
   *  recorded token still exists (and isn't disabled/expired) before
   *  we trust the encrypted credentials in the project's
   *  .env.production. Returns null on 404.
   *
   *  `policies` carries the token's resource scope; `hatchkit secrets
   *  rotate` reads it to mint a replacement with the same buckets and
   *  permissions. The response never includes the token value. */
  async getAccountToken(
    accountId: string,
    tokenId: string,
  ): Promise<{
    id: string;
    status: string;
    name: string;
    policies?: CfTokenPolicy[];
  } | null> {
    try {
      return await this.request<{
        id: string;
        status: string;
        name: string;
        policies?: CfTokenPolicy[];
      }>("GET", `/accounts/${accountId}/tokens/${tokenId}`);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  /** DELETE /accounts/{accountId}/tokens/{tokenId} — used by the
   *  destroy / rollback flow to take the per-bucket token down with
   *  its bucket(s). Idempotent: 404 → "not-found". */
  async deleteAccountToken(accountId: string, tokenId: string): Promise<"deleted" | "not-found"> {
    try {
      await this.request<unknown>("DELETE", `/accounts/${accountId}/tokens/${tokenId}`);
      return "deleted";
    } catch (err) {
      if ((err as { status?: number }).status === 404) return "not-found";
      throw err;
    }
  }

  /** Cached lookup of permission groups. Pass `accountId` to use the
   *  per-account endpoint (preferred — works with R2 admin tokens that
   *  don't have `User > API Tokens > Read`). When `accountId` is
   *  omitted, falls back to `/user/tokens/permission_groups` for the
   *  legacy `createR2ApiToken` (user-token) path. Both return the same
   *  permission group catalog.
   *
   *  Cache is keyed on `accountId ?? ""` so user-token + account-token
   *  flows can coexist in one process without crosstalk. */
  private permissionGroupsCache: Map<string, Array<{ id: string; name: string }>> = new Map();
  private async getPermissionGroups(
    accountId?: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const key = accountId ?? "";
    const cached = this.permissionGroupsCache.get(key);
    if (cached) return cached;
    const base = accountId
      ? `/accounts/${accountId}/tokens/permission_groups`
      : "/user/tokens/permission_groups";
    const all: Array<{ id: string; name: string }> = [];
    let page = 1;
    while (page <= 20) {
      const data = await this.request<Array<{ id: string; name: string }>>(
        "GET",
        `${base}?per_page=200&page=${page}`,
      );
      all.push(...data);
      if (data.length < 200) break;
      page += 1;
    }
    this.permissionGroupsCache.set(key, all);
    return all;
  }

  /** Permission-group ids for `names`, from the account catalog. Throws
   *  naming the first one Cloudflare no longer lists. */
  async permissionGroupIds(accountId: string, names: readonly string[]): Promise<string[]> {
    const groups = await this.getPermissionGroups(accountId);
    return names.map((name) => {
      const found = groups.find((g) => g.name === name);
      if (!found) {
        throw new Error(
          `Permission group "${name}" not found in /accounts/${accountId}/tokens/permission_groups. The Cloudflare API may have renamed it.`,
        );
      }
      return found.id;
    });
  }

  /** Mint an account API token with the given policies. Returns the value
   *  once; Cloudflare never shows it again. */
  async createAccountToken(params: {
    accountId: string;
    name: string;
    policies: Array<{
      effect: "allow";
      permission_groups: Array<{ id: string }>;
      resources: Record<string, unknown>;
    }>;
  }): Promise<{ id: string; value: string }> {
    return this.request<{ id: string; value: string }>(
      "POST",
      `/accounts/${params.accountId}/tokens`,
      { name: params.name, policies: params.policies },
    );
  }

  /** The Worker named `name`, or null when the account has none by that
   *  name. `id` is the Worker's immutable tag, which is what a per-Worker
   *  token policy names. A token without Workers access gets a 403 here,
   *  which is thrown, not read as "absent". */
  async getWorker(accountId: string, name: string): Promise<{ id: string; name: string } | null> {
    try {
      return await this.request<{ id: string; name: string }>(
        "GET",
        `/accounts/${accountId}/workers/workers/${encodeURIComponent(name)}`,
      );
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  /** Create an empty Worker (no version, nothing served). A per-Worker
   *  role can only name a Worker that exists, so a new project's Worker
   *  is created here before its deploy token is minted; the first CI
   *  deploy uploads the site. */
  async createWorker(accountId: string, name: string): Promise<{ id: string; name: string }> {
    return this.request<{ id: string; name: string }>(
      "POST",
      `/accounts/${accountId}/workers/workers`,
      { name },
    );
  }

  /** Delete a USER-scoped API token by id (`DELETE /user/tokens/{id}`).
   *  Distinct from `deleteAccountToken` — this is used during
   *  migration to clean up the legacy user-tokens hatchkit minted
   *  before we switched provisioning to account tokens. Idempotent. */
  async deleteApiToken(tokenId: string): Promise<"deleted" | "not-found"> {
    try {
      await this.request<unknown>("DELETE", `/user/tokens/${tokenId}`);
      return "deleted";
    } catch (err) {
      if ((err as { status?: number }).status === 404) return "not-found";
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // R2 bucket CORS
  // ---------------------------------------------------------------------
  //
  // CORS is global to the bucket (not per-prefix). Browser code paths
  // that use fetch() / XHR / `crossOrigin="anonymous"` (WebGL TextureLoader,
  // createImageBitmap, audio/video tags with crossOrigin, service-worker
  // ETag flows) require an Access-Control-Allow-Origin header even on
  // GETs that work fine for plain `<img>`. Without a CORS rule the
  // browser blocks the response.
  //
  // Same `Workers R2 Storage:Edit` perm as bucket create. A token that
  // got far enough to create the bucket but trips here is missing the
  // CORS-specific privilege on a token that's been narrowed since —
  // surface that hint at the call site.
  //
  // Idempotency: GET first, only PUT if the rules differ. Cloudflare
  // doesn't expose a per-rule etag, so the caller compares rule shape.

  /** Read the bucket's CORS rules. Returns null on 404 (no policy set). */
  async getR2BucketCors(accountId: string, bucket: string): Promise<R2CorsRule[] | null> {
    try {
      const res = await this.request<{ rules?: R2CorsRule[] }>(
        "GET",
        `/accounts/${accountId}/r2/buckets/${bucket}/cors`,
      );
      return res.rules ?? [];
    } catch (err) {
      const msg = (err as Error).message;
      // CF returns either a 404 or a "no CORS configuration found" body
      // when the bucket has no policy yet — both should resolve to null.
      if (/404|not\s*found|10059|no\s*cors/i.test(msg)) return null;
      throw err;
    }
  }

  /** Replace the bucket's CORS rules (PUT semantics — overwrites the
   *  whole policy). */
  async putR2BucketCors(
    accountId: string,
    bucket: string,
    rules: R2CorsRule[],
  ): Promise<R2CorsRule[]> {
    const res = await this.request<{ rules?: R2CorsRule[] }>(
      "PUT",
      `/accounts/${accountId}/r2/buckets/${bucket}/cors`,
      { rules },
    );
    return res.rules ?? rules;
  }

  /** Remove every CORS rule on the bucket. Idempotent: 404 → "not-found". */
  async deleteR2BucketCors(accountId: string, bucket: string): Promise<"deleted" | "not-found"> {
    try {
      await this.request<unknown>("DELETE", `/accounts/${accountId}/r2/buckets/${bucket}/cors`);
      return "deleted";
    } catch (err) {
      const msg = (err as Error).message;
      if (/404|not\s*found|10059|no\s*cors/i.test(msg)) return "not-found";
      throw err;
    }
  }

  /** Attach a custom domain (a hostname on a Cloudflare zone you own)
   *  to an R2 bucket. Idempotent — duplicates short-circuit via list. */
  async addR2CustomDomain(
    accountId: string,
    bucket: string,
    params: {
      domain: string;
      zoneId: string;
      minTLS?: "1.0" | "1.1" | "1.2" | "1.3";
    },
  ): Promise<{
    domain: string;
    enabled: boolean;
    zoneId: string;
    existed: boolean;
  }> {
    const existing = await this.listR2CustomDomains(accountId, bucket);
    const match = existing.find((d) => d.domain === params.domain);
    if (match) {
      return {
        domain: match.domain,
        enabled: match.enabled,
        zoneId: params.zoneId,
        existed: true,
      };
    }
    const body: Record<string, unknown> = {
      domain: params.domain,
      enabled: true,
      zoneId: params.zoneId,
    };
    if (params.minTLS) body.minTLS = params.minTLS;
    const res = await this.request<{
      domain: string;
      enabled: boolean;
      zoneId: string;
    }>("POST", `/accounts/${accountId}/r2/buckets/${bucket}/domains/custom`, body);
    return { ...res, existed: false };
  }

  /** Detach a custom domain from an R2 bucket.
   *
   *  The counterpart of {@link addR2CustomDomain}, needed by the
   *  cleanup phase of `hatchkit migrate-domain`: a bucket can carry the
   *  old and the new hostname at once, which is what lets a migration
   *  be additive, but the old one has to come off eventually.
   *
   *  404-tolerant like the other delete helpers here — re-running a
   *  cleanup that already succeeded is a no-op, not an error.
   *
   *  Note the resource path takes the DOMAIN, not a record id: R2
   *  addresses custom domains by hostname. Cloudflare also removes the
   *  proxied CNAME it created in the zone as part of this call, so
   *  there is no second DNS delete to issue afterwards. */
  async deleteR2CustomDomain(
    accountId: string,
    bucket: string,
    domain: string,
  ): Promise<"deleted" | "not-found"> {
    try {
      await this.request(
        "DELETE",
        `/accounts/${accountId}/r2/buckets/${bucket}/domains/custom/${encodeURIComponent(domain)}`,
      );
      return "deleted";
    } catch (err) {
      const msg = (err as Error).message;
      if (/404|not\s*found|10006/i.test(msg)) return "not-found";
      throw err;
    }
  }

  async enableEdgeHardening(zoneId: string): Promise<{
    changed: Array<{ id: string; from: unknown; to: unknown }>;
    kept: string[];
    failed: Array<{ id: string; error: string }>;
  }> {
    // Each entry: id, target value, "is current value at-or-stricter than target?"
    // The third arg gates whether we skip the change (preserve stricter user choice).
    type Setting = {
      id: string;
      target: string;
      atLeastAsStrict: (current: unknown) => boolean;
    };
    const settings: Setting[] = [
      { id: "always_use_https", target: "on", atLeastAsStrict: (c) => c === "on" },
      // SSL strictness ladder: off < flexible < full < strict. We aim for
      // `full`; treat `strict` as already stronger.
      {
        id: "ssl",
        target: "full",
        atLeastAsStrict: (c) => c === "full" || c === "strict",
      },
      {
        id: "min_tls_version",
        target: "1.2",
        atLeastAsStrict: (c) => typeof c === "string" && c >= "1.2",
      },
      {
        id: "automatic_https_rewrites",
        target: "on",
        atLeastAsStrict: (c) => c === "on",
      },
    ];

    const changed: Array<{ id: string; from: unknown; to: unknown }> = [];
    const kept: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const s of settings) {
      try {
        const current = await this.getZoneSetting(zoneId, s.id);
        if (s.atLeastAsStrict(current)) {
          kept.push(s.id);
          continue;
        }
        await this.setZoneSetting(zoneId, s.id, s.target);
        changed.push({ id: s.id, from: current, to: s.target });
      } catch (err) {
        // One setting failing shouldn't sink the rest — Cloudflare zone
        // plans differ (some toggles are Pro-only) and we'd rather light
        // up the ones that work than refuse them all.
        failed.push({ id: s.id, error: (err as Error).message });
      }
    }
    return { changed, kept, failed };
  }

  // ---------------------------------------------------------------------
  // Email Routing
  // ---------------------------------------------------------------------
  //
  // Cloudflare Email Routing is zone-scoped for rules + MX records and
  // account-scoped for destinations (a "destination" = a verified inbox
  // anywhere on the public internet that receives forwarded mail).
  //
  // Token permission requirements (all on the same Bearer):
  //   · `Zone > Email Routing Rules > Edit` (rules + zone enable/disable)
  //   · `Zone > Email Routing Addresses > Read`
  //   · `Account > Email Routing Addresses > Edit` (destinations create + verify)
  //   · `Zone > DNS > Edit`  (already required for the rest of hatchkit)
  //
  // Enable order (matters):
  //   1. POST /zones/{id}/email/routing/enable      (creates the service)
  //   2. POST /zones/{id}/email/routing/dns         (have CF write its MX/SPF —
  //      idempotent; we instead upsert via the generic dns_records API so
  //      hatchkit owns the records consistently)
  //   3. POST /accounts/{aid}/email/routing/addresses { email }
  //      (sends verification email — destination won't accept forwards
  //      until the user clicks the link in their inbox)
  //   4. POST /zones/{id}/email/routing/rules        (forwarding rules)
  //
  // Idempotency: all creates short-circuit on "already exists" by listing
  // first. Verification status is reported back to the caller — we never
  // re-send a verify email unless the user explicitly asks.

  /** Read the zone's Email Routing status (enabled, name, status). */
  async getEmailRouting(zoneId: string): Promise<CfEmailRoutingSettings | null> {
    try {
      return await this.request<CfEmailRoutingSettings>("GET", `/zones/${zoneId}/email/routing`);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  /** Enable Email Routing on a zone. Idempotent — CF returns the current
   *  settings on re-enable. Does NOT add MX records itself (we use the
   *  generic dns_records API so all hatchkit-managed records flow through
   *  one code path). */
  async enableEmailRouting(zoneId: string): Promise<CfEmailRoutingSettings> {
    return this.request<CfEmailRoutingSettings>(
      "POST",
      `/zones/${zoneId}/email/routing/enable`,
      {},
    );
  }

  /** Cloudflare's recommendation for the MX + SPF records that should
   *  exist on the zone for Email Routing to receive mail. We don't blindly
   *  apply these — the email module merges them with any Resend SPF
   *  includes before writing — but we still call this to surface the
   *  canonical MX hostnames (which change every few years). */
  async getEmailRoutingDnsRecords(zoneId: string): Promise<CfEmailRoutingDnsRecord[]> {
    type Resp = { resp?: CfEmailRoutingDnsRecord[] } | CfEmailRoutingDnsRecord[];
    const data = await this.request<Resp>("GET", `/zones/${zoneId}/email/routing/dns`);
    return Array.isArray(data) ? data : (data.resp ?? []);
  }

  /** List Email Routing destinations on an account. */
  async listEmailDestinations(accountId: string): Promise<CfEmailDestination[]> {
    return this.request<CfEmailDestination[]>(
      "GET",
      `/accounts/${accountId}/email/routing/addresses`,
    );
  }

  /** Create a destination address. CF sends a verification email to the
   *  address. If the destination already exists (any verification state),
   *  returns the existing record with `existed: true` instead of erroring. */
  async addEmailDestination(
    accountId: string,
    email: string,
  ): Promise<CfEmailDestination & { existed: boolean }> {
    try {
      const created = await this.request<CfEmailDestination>(
        "POST",
        `/accounts/${accountId}/email/routing/addresses`,
        { email },
      );
      return { ...created, existed: false };
    } catch (err) {
      const msg = (err as Error).message;
      // CF code 1004 / "already exists" — look it up in the list and
      // return that instead of bubbling.
      if (/already\s*exists|1004|duplicate/i.test(msg)) {
        const all = await this.listEmailDestinations(accountId);
        const match = all.find((d) => d.email.toLowerCase() === email.toLowerCase());
        if (match) return { ...match, existed: true };
      }
      throw err;
    }
  }

  /** Delete a destination by id. Idempotent: 404 → "not-found". */
  async deleteEmailDestination(
    accountId: string,
    destinationId: string,
  ): Promise<"deleted" | "not-found"> {
    try {
      await this.request<unknown>(
        "DELETE",
        `/accounts/${accountId}/email/routing/addresses/${destinationId}`,
      );
      return "deleted";
    } catch (err) {
      if ((err as { status?: number }).status === 404) return "not-found";
      throw err;
    }
  }

  /** List forwarding rules on a zone (excluding the catch-all, which has
   *  its own endpoint). */
  async listEmailRoutingRules(zoneId: string): Promise<CfEmailRoutingRule[]> {
    return this.request<CfEmailRoutingRule[]>("GET", `/zones/${zoneId}/email/routing/rules`);
  }

  /** Upsert a forwarding rule keyed on the rule's literal `to` matcher.
   *  If a rule already targets the same `localPart@zone` address, its
   *  forward destination is patched to the new value (no-op if equal);
   *  otherwise a fresh rule is created. */
  async upsertEmailRoutingRule(
    zoneId: string,
    params: {
      /** Full email address on this zone, e.g. "hello@example.com". */
      address: string;
      /** One or more verified destination addresses to forward to. */
      forwardTo: string[];
      /** Human-readable label shown in the dashboard. */
      name?: string;
      enabled?: boolean;
      priority?: number;
    },
  ): Promise<{ id: string; created: boolean; updated: boolean }> {
    const existing = await this.listEmailRoutingRules(zoneId);
    const match = existing.find((r) =>
      r.matchers?.some(
        (m) => m.type === "literal" && m.field === "to" && m.value === params.address,
      ),
    );
    const body: CfEmailRoutingRule = {
      name: params.name ?? `Forward ${params.address}`,
      enabled: params.enabled ?? true,
      priority: params.priority,
      matchers: [{ type: "literal", field: "to", value: params.address }],
      actions: [{ type: "forward", value: params.forwardTo }],
    };
    if (!match) {
      const created = await this.request<{ id: string; tag?: string }>(
        "POST",
        `/zones/${zoneId}/email/routing/rules`,
        body,
      );
      return { id: created.id ?? created.tag ?? "", created: true, updated: false };
    }
    const sameForward = (match.actions?.[0]?.value ?? []).join(",") === params.forwardTo.join(",");
    const sameEnabled = (match.enabled ?? true) === (params.enabled ?? true);
    if (sameForward && sameEnabled) {
      return { id: match.id ?? match.tag ?? "", created: false, updated: false };
    }
    const ruleId = match.id ?? match.tag;
    if (!ruleId) {
      throw new Error("Existing Email Routing rule has no id — cannot update.");
    }
    const updated = await this.request<{ id: string; tag?: string }>(
      "PUT",
      `/zones/${zoneId}/email/routing/rules/${ruleId}`,
      body,
    );
    return { id: updated.id ?? updated.tag ?? ruleId, created: false, updated: true };
  }

  /** Delete a rule by id. Idempotent: 404 → "not-found". */
  async deleteEmailRoutingRule(zoneId: string, ruleId: string): Promise<"deleted" | "not-found"> {
    try {
      await this.request<unknown>("DELETE", `/zones/${zoneId}/email/routing/rules/${ruleId}`);
      return "deleted";
    } catch (err) {
      if ((err as { status?: number }).status === 404) return "not-found";
      throw err;
    }
  }

  /** Read the catch-all rule for a zone. Returns null if Email Routing
   *  isn't enabled (404). The catch-all is a singleton; the GET always
   *  returns the same record (matchers `[{type:"all"}]`), but the action
   *  forward list and `enabled` flag reflect whether it's actually
   *  forwarding mail. */
  async getEmailCatchAll(zoneId: string): Promise<CfEmailRoutingRule | null> {
    try {
      return await this.request<CfEmailRoutingRule>(
        "GET",
        `/zones/${zoneId}/email/routing/rules/catch_all`,
      );
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  /** Set the catch-all rule for a zone. CF allows exactly one catch-all
   *  per zone (PUT semantics). Pass `enabled: false` to disable without
   *  removing it. */
  async setEmailCatchAll(
    zoneId: string,
    params: { forwardTo: string[]; enabled?: boolean; name?: string },
  ): Promise<{ enabled: boolean }> {
    return this.request<{ enabled: boolean }>(
      "PUT",
      `/zones/${zoneId}/email/routing/rules/catch_all`,
      {
        name: params.name ?? "Catch-all",
        enabled: params.enabled ?? true,
        matchers: [{ type: "all" }],
        actions: [{ type: "forward", value: params.forwardTo }],
      },
    );
  }

  // ── Workers (static assets) ──────────────────────────────────────────

  /** The account's `*.workers.dev` subdomain (the `<sub>` in
   *  `<worker>.<sub>.workers.dev`). Returns null when the account has
   *  never claimed one — the first `wrangler deploy` claims it. */
  async getWorkersSubdomain(accountId: string): Promise<string | null> {
    try {
      const data = await this.request<{ subdomain?: string }>(
        "GET",
        `/accounts/${accountId}/workers/subdomain`,
      );
      return data?.subdomain ?? null;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  /** Custom domains currently bound to Workers in this account. */
  async listWorkerCustomDomains(accountId: string): Promise<CfWorkerCustomDomain[]> {
    return this.request<CfWorkerCustomDomain[]>("GET", `/accounts/${accountId}/workers/domains`);
  }

  /** Bind `hostname` to `service` as a Worker Custom Domain.
   *
   *  Cloudflare manages the DNS record and certificate itself, so it
   *  refuses when the hostname already resolves through records it
   *  didn't create — `code: 100117`. The caller must delete those
   *  records first, and the host is down in the gap, so this is only
   *  safe to automate for a hostname with no existing records.
   *  `attachWorkerCustomDomain` does not delete anything.
   */
  async attachWorkerCustomDomain(params: {
    accountId: string;
    zoneId: string;
    hostname: string;
    service: string;
    environment?: string;
  }): Promise<CfWorkerCustomDomain> {
    return this.request<CfWorkerCustomDomain>(
      "PUT",
      `/accounts/${params.accountId}/workers/domains`,
      {
        zone_id: params.zoneId,
        hostname: params.hostname,
        service: params.service,
        environment: params.environment ?? "production",
      },
    );
  }

  /** Detach a Worker Custom Domain. Used by rollback. */
  async deleteWorkerCustomDomain(
    accountId: string,
    domainId: string,
  ): Promise<"deleted" | "not-found"> {
    try {
      await this.request<unknown>("DELETE", `/accounts/${accountId}/workers/domains/${domainId}`);
      return "deleted";
    } catch (err) {
      if ((err as { status?: number }).status === 404) return "not-found";
      throw err;
    }
  }

  /** Probe the grants the Cloudflare PROVISIONER needs, each with the
   *  cheapest read-only call that the permission gates:
   *
   *    Account API Tokens:Edit — mint each Worker repo its own token.
   *    Workers Admin           — look up a Worker's id, create a new
   *                              project's Worker.
   *    Workers Routes:Edit     — attach a custom domain (zone).
   *    DNS:Edit                — read the hostname's records first; the
   *                              attach is only automated on an empty one.
   *
   *  None of these ever reach CI: the per-Worker token hatchkit mints
   *  carries Individual Workers Editor on one Worker and nothing else.
   *
   *  Workers is probed through the account's workers.dev subdomain, NOT
   *  the script list: since per-Worker roles (2026-09-15) the list
   *  answers 200 with an empty array to a token with no Workers grant at
   *  all, so a list probe passes every token.
   *
   *  Read-only throughout: Edit implies Read, and a token with neither
   *  fails the read. `zoneId` is optional; the zone probes are skipped
   *  without one. */
  async probeProvisionerPermissions(params: {
    accountId: string;
    zoneId?: string;
  }): Promise<CfPermissionProbe[]> {
    const out: CfPermissionProbe[] = [];

    out.push(
      await this.probe("Account → Account API Tokens → Edit", () =>
        this.request<unknown>("GET", `/accounts/${params.accountId}/tokens?per_page=1`),
      ),
    );
    out.push(
      await this.probe("Account → Workers → Admin (read preflight)", () =>
        this.request<unknown>("GET", `/accounts/${params.accountId}/workers/subdomain`),
      ),
    );

    if (!params.zoneId) return out;

    out.push(
      await this.probe("Zone → Workers Routes → Edit", () =>
        this.request<unknown>("GET", `/zones/${params.zoneId}/workers/routes`),
      ),
    );
    out.push(
      await this.probe("Zone → DNS → Edit", () =>
        this.request<unknown>("GET", `/zones/${params.zoneId}/dns_records?per_page=1`),
      ),
    );
    return out;
  }

  /** The calls `wrangler deploy` makes against an existing Worker before
   *  it uploads, run with THIS client's token. A read preflight only; a live canary deployment is still
   *  required to verify writes. Works for Workers with no version yet. */
  async workerDeployRefusals(accountId: string, name: string): Promise<string[]> {
    const refused: string[] = [];
    const worker = encodeURIComponent(name);
    for (const path of [`/accounts/${accountId}/workers/workers/${worker}`]) {
      try {
        await this.request<unknown>("GET", path);
      } catch (err) {
        refused.push(
          `GET ${path.replace(accountId, "<account>")}: ${(err as Error).message.replace(/^.*failed: /, "")}`,
        );
      }
    }
    return refused;
  }

  /** Run one permission probe.
   *
   *  A 404 counts as a PASS: an account that never claimed a workers.dev
   *  subdomain answers 404 to a token that may read it. Only an
   *  authorization failure means a grant is actually missing; Cloudflare signals those as code 9109
   *  ("Unauthorized to access requested resource") or 10000
   *  ("Authentication error"). Anything else (network, 5xx) is
   *  reported as a failure with the raw message so the user can see
   *  what happened rather than getting a false all-clear. */
  private async probe(permission: string, fn: () => Promise<unknown>): Promise<CfPermissionProbe> {
    try {
      await fn();
      return { permission, ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403 || /\b(9109|10000)\b|\bHTTP (401|403)\b/.test(msg)) {
        return { permission, ok: false, detail: msg };
      }
      if (status === 404 || /\b404\b|not\s*found/i.test(msg)) return { permission, ok: true };
      return { permission, ok: false, detail: msg };
    }
  }
}
