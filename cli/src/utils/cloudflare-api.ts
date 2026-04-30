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
