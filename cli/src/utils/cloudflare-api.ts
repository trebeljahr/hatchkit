// Cloudflare REST API client.
//
// Minimal wrapper used by the `hatchkit dns link-to-cloudflare` command
// to verify a token and list the zones in an account so we can
// cross-reference them against domains registered at INWX. The DNS record
// creation itself goes through Terraform (modules/cloudflare-dns) during
// a normal `hatchkit create` flow — this client is for the standalone
// migration / reconciliation command.
//
// NB: `hatchkit gh-pages` has its own inline Cloudflare DNS helper for
// record CRUD. That path is separate and doesn't share this class.

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
}
