export interface CoolifyServer {
  id: number;
  name: string;
  ip: string;
  description?: string;
}

export interface CoolifyApiOptions {
  url: string;
  token: string;
}

/** Coolify REST API client. */
export class CoolifyApi {
  private url: string;
  private token: string;

  constructor(options: CoolifyApiOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.token = options.token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Coolify API ${method} ${path} failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
      );
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      const ct = res.headers.get("content-type") ?? "unknown";
      const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
      const hint = text.trimStart().startsWith("<")
        ? " (got HTML — token may be invalid or URL points to a login page)"
        : "";
      throw new Error(
        `Coolify API ${method} ${path}: response is not JSON${hint}\n  content-type: ${ct}\n  body: ${snippet || "(empty)"}`,
      );
    }
  }

  /** Test connection and get Coolify version. The endpoint returns a
   *  plain-text version string on modern Coolify, but older builds
   *  wrap it as `{ version: "..." }` — accept either. */
  async getVersion(): Promise<string> {
    const res = await fetch(`${this.url}/api/v1/version`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json, text/plain;q=0.9",
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Coolify API GET /version failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
      );
    }
    const text = (await res.text()).trim();
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed === "object" && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // Fall through: plain-text version string (e.g. "4.0.0-beta.432")
    }
    return text;
  }

  /** List all servers. */
  async listServers(): Promise<CoolifyServer[]> {
    const data = await this.request<
      Array<{
        id: number;
        name: string;
        ip: string;
        description?: string;
      }>
    >("GET", "/servers");

    return data.map((s) => ({
      id: s.id,
      name: s.name,
      ip: s.ip,
      description: s.description,
    }));
  }

  /** List all projects. */
  async listProjects(): Promise<Array<{ id: number; name: string }>> {
    return this.request("GET", "/projects");
  }

  /** Create a new project. */
  async createProject(name: string): Promise<{ id: number; name: string }> {
    return this.request("POST", "/projects", { name });
  }

  /** List Coolify apps/services so callers can resolve a UUID by name. */
  async listApplications(): Promise<Array<{ uuid: string; name: string; description?: string }>> {
    return this.request("GET", "/applications");
  }

  /** Upsert an env variable on a Coolify application. The Coolify API
   *  accepts multiple envs in one call so this is idempotent. */
  async setAppEnv(
    appUuid: string,
    envs: Record<string, string>,
    options: { isPreview?: boolean } = {},
  ): Promise<void> {
    const body = {
      data: Object.entries(envs).map(([key, value]) => ({
        key,
        value,
        is_preview: options.isPreview ?? false,
        is_build_time: false,
        is_literal: true,
      })),
    };
    await this.request("PATCH", `/applications/${appUuid}/envs/bulk`, body);
  }
}

/** Verify Coolify connection. Returns version string or throws. */
export async function verifyCoolify(url: string, token: string): Promise<string> {
  const api = new CoolifyApi({ url, token });
  return api.getVersion();
}
