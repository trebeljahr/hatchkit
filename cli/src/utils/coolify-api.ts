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

  /** Create a MongoDB database. Coolify will auto-generate root creds
   *  if they're not supplied; the returned `internal_db_url` is the
   *  full connection string usable from inside Coolify's Docker network
   *  (which is where the app container runs). */
  async createMongodbDatabase(params: {
    serverUuid: string;
    projectUuid: string;
    environmentName?: string;
    environmentUuid?: string;
    /** Defaults to `default` (the standard Coolify env). */
    name: string;
    initdbDatabase?: string;
    initdbRootUsername?: string;
    /** Coolify auto-generates one if omitted. */
    initdbRootPassword?: string;
    /** Start the container immediately on creation. */
    instantDeploy?: boolean;
  }): Promise<{ uuid: string; internal_db_url: string }> {
    const body: Record<string, unknown> = {
      server_uuid: params.serverUuid,
      project_uuid: params.projectUuid,
      environment_name: params.environmentName ?? "production",
      name: params.name,
      instant_deploy: params.instantDeploy ?? true,
    };
    if (params.environmentUuid) body.environment_uuid = params.environmentUuid;
    if (params.initdbDatabase) body.mongo_initdb_database = params.initdbDatabase;
    if (params.initdbRootUsername) body.mongo_initdb_root_username = params.initdbRootUsername;
    if (params.initdbRootPassword) body.mongo_initdb_root_password = params.initdbRootPassword;
    return this.request("POST", "/databases/mongodb", body);
  }

  /** Get a database (any engine) by uuid. We use this to read the
   *  `internal_db_url` post-creation when the create response didn't
   *  include it (older Coolify builds). */
  async getDatabase(uuid: string): Promise<{ uuid: string; internal_db_url?: string }> {
    return this.request("GET", `/databases/${uuid}`);
  }

  /** Delete an application by uuid. Idempotent: 404 → no-op. Used by
   *  the rollback flow when `hatchkit create` fails partway through. */
  async deleteApplication(uuid: string): Promise<"deleted" | "not-found"> {
    return this.delete(`/applications/${uuid}`);
  }

  /** Delete a database by uuid. Idempotent: 404 → no-op. */
  async deleteDatabase(uuid: string): Promise<"deleted" | "not-found"> {
    return this.delete(`/databases/${uuid}`);
  }

  /** Delete a project by uuid. Idempotent: 404 → no-op. Coolify rejects
   *  this if the project still has resources, so call after deleting
   *  apps + databases. */
  async deleteProject(uuid: string): Promise<"deleted" | "not-found"> {
    return this.delete(`/projects/${uuid}`);
  }

  /** Raw DELETE that handles both 404 (already gone) and empty bodies
   *  (Coolify returns 200 with no body for some delete endpoints). */
  private async delete(path: string): Promise<"deleted" | "not-found"> {
    const res = await fetch(`${this.url}/api/v1${path}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
      },
    });
    if (res.status === 404) return "not-found";
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Coolify API DELETE ${path} failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
      );
    }
    return "deleted";
  }

  /** Find a project by exact name. Returns null if none matches. */
  async findProjectByName(name: string): Promise<{ uuid: string; name: string } | null> {
    const projects = (await this.request("GET", "/projects")) as Array<{
      uuid?: string;
      id?: number;
      name: string;
    }>;
    const match = projects.find((p) => p.name === name);
    if (!match || !match.uuid) return null;
    return { uuid: match.uuid, name: match.name };
  }

  /** Find a server by exact name OR exact IP — the script-driven
   *  Coolify setup typically targets the first server, but Hetzner
   *  deploys are keyed by IP. Returns null if nothing matches. */
  async findServer(query: {
    name?: string;
    ip?: string;
  }): Promise<{ uuid: string; name: string; ip: string } | null> {
    const servers = (await this.request("GET", "/servers")) as Array<{
      uuid?: string;
      name: string;
      ip: string;
    }>;
    const match = servers.find(
      (s) => (query.name && s.name === query.name) || (query.ip && s.ip === query.ip),
    );
    if (!match?.uuid) return null;
    return { uuid: match.uuid, name: match.name, ip: match.ip };
  }
}

/** Verify Coolify connection. Returns version string or throws. */
export async function verifyCoolify(url: string, token: string): Promise<string> {
  const api = new CoolifyApi({ url, token });
  return api.getVersion();
}
