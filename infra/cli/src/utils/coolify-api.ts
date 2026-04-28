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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
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

    return res.json() as Promise<T>;
  }

  /** Test connection and get Coolify version. */
  async getVersion(): Promise<string> {
    const data = await this.request<{ version: string }>("GET", "/version");
    return data.version;
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
}

/** Verify Coolify connection. Returns version string or throws. */
export async function verifyCoolify(
  url: string,
  token: string,
): Promise<string> {
  const api = new CoolifyApi({ url, token });
  return api.getVersion();
}
