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

/** Cloudflare REST API client. */
export class CloudflareApi {
  private token: string;
  private accountId?: string;

  constructor(options: CloudflareApiOptions) {
    this.token = options.token;
    this.accountId = options.accountId;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = (await res.json().catch(() => null)) as CfResponse<T> | null;
    if (!res.ok || !json || !json.success) {
      const errMsg =
        json?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? res.statusText;
      throw new Error(`Cloudflare ${method} ${path} failed: ${errMsg}`);
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
      const res = await fetch(`${API_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
        },
      });
      const json = (await res.json()) as CfResponse<CloudflareZone[]>;
      if (!res.ok || !json.success) {
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

  /** Find an exact name+type DNS record in a zone, or null. */
  async findRecord(
    zoneId: string,
    name: string,
    type: "A" | "AAAA" | "CNAME",
  ): Promise<{ id: string; name: string; type: string; content: string; proxied: boolean } | null> {
    const query = new URLSearchParams({ name, type });
    const data = await this.request<
      Array<{ id: string; name: string; type: string; content: string; proxied: boolean }>
    >("GET", `/zones/${zoneId}/dns_records?${query.toString()}`);
    return data[0] ?? null;
  }

  /** Upsert a DNS record by name+type. Idempotent — re-runs on the same
   *  inputs return without changes if the record already matches.
   *  `proxied: true` enables the orange-cloud Cloudflare proxy for the
   *  record (TLS termination + DDoS, recommended for a webapp). */
  async upsertRecord(
    zoneId: string,
    params: {
      type: "A" | "AAAA" | "CNAME";
      name: string;
      content: string;
      proxied?: boolean;
      ttl?: number;
    },
  ): Promise<{ id: string; created: boolean; updated: boolean }> {
    const existing = await this.findRecord(zoneId, params.name, params.type);
    const body = {
      type: params.type,
      name: params.name,
      content: params.content,
      proxied: params.proxied ?? true,
      ttl: params.ttl ?? 1, // 1 = automatic
    };
    if (!existing) {
      const created = await this.request<{ id: string }>(
        "POST",
        `/zones/${zoneId}/dns_records`,
        body,
      );
      return { id: created.id, created: true, updated: false };
    }
    const same =
      existing.content === params.content &&
      (existing.proxied ?? false) === (params.proxied ?? true) &&
      existing.type === params.type;
    if (same) return { id: existing.id, created: false, updated: false };
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
    opts: { locationHint?: string; storageClass?: "Standard" | "InfrequentAccess" } = {},
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
    Array<{ domain: string; enabled: boolean; status?: { ownership?: string; ssl?: string } }>
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

  /** Attach a custom domain (a hostname on a Cloudflare zone you own)
   *  to an R2 bucket. Idempotent — duplicates short-circuit via list. */
  async addR2CustomDomain(
    accountId: string,
    bucket: string,
    params: { domain: string; zoneId: string; minTLS?: "1.0" | "1.1" | "1.2" | "1.3" },
  ): Promise<{ domain: string; enabled: boolean; zoneId: string; existed: boolean }> {
    const existing = await this.listR2CustomDomains(accountId, bucket);
    const match = existing.find((d) => d.domain === params.domain);
    if (match) {
      return { domain: match.domain, enabled: match.enabled, zoneId: params.zoneId, existed: true };
    }
    const body: Record<string, unknown> = {
      domain: params.domain,
      enabled: true,
      zoneId: params.zoneId,
    };
    if (params.minTLS) body.minTLS = params.minTLS;
    const res = await this.request<{ domain: string; enabled: boolean; zoneId: string }>(
      "POST",
      `/accounts/${accountId}/r2/buckets/${bucket}/domains/custom`,
      body,
    );
    return { ...res, existed: false };
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
}
