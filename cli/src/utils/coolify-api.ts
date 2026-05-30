export interface CoolifyServer {
  id: number;
  /** Coolify's UUID — stable handle across renames/IP changes. Newer
   *  Coolify builds always return this; older ones may not, in which
   *  case it's undefined and callers fall back to `id` + `ip`. */
  uuid?: string;
  name: string;
  ip: string;
  description?: string;
  /** SSH user Coolify uses to connect to this server (default `root`). */
  user?: string;
  /** SSH port Coolify uses (default 22). */
  port?: number;
  /** True for the box Coolify itself runs on — that's the box that
   *  pulls runtime images for `instant_deploy` apps. */
  isCoolifyHost?: boolean;
  /** True for build-only worker nodes that push images. */
  isBuildServer?: boolean;
  /** Coolify's last reachability probe result. */
  isReachable?: boolean;
  /** True when the server has finished Coolify's bootstrap and is
   *  accepting work. */
  isUsable?: boolean;
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

  /** List all servers. Surface the SSH + role fields the GHCR-on-host
   *  flow needs (uuid, user, port, is_coolify_host, is_build_server,
   *  is_reachable, is_usable) — older callers only used id/name/ip
   *  and ignore the extras. */
  async listServers(): Promise<CoolifyServer[]> {
    const data = await this.request<
      Array<{
        id: number;
        uuid?: string;
        name: string;
        ip: string;
        description?: string;
        user?: string;
        port?: number;
        is_coolify_host?: boolean;
        is_build_server?: boolean;
        is_reachable?: boolean;
        is_usable?: boolean;
      }>
    >("GET", "/servers");

    return data.map((s) => ({
      id: s.id,
      uuid: s.uuid,
      name: s.name,
      ip: s.ip,
      description: s.description,
      user: s.user,
      port: s.port,
      isCoolifyHost: s.is_coolify_host,
      isBuildServer: s.is_build_server,
      isReachable: s.is_reachable,
      isUsable: s.is_usable,
    }));
  }

  /** List all projects. */
  async listProjects(): Promise<Array<{ id: number; name: string }>> {
    return this.request("GET", "/projects");
  }

  /** Create a new project. Coolify v4 returns `uuid` (string) on the
   *  POST response — this is the field used by every downstream API
   *  call. Older builds may include a numeric `id` too; we accept both
   *  but prefer uuid. */
  async createProject(
    name: string,
    description?: string,
  ): Promise<{ uuid: string; name: string; id?: number }> {
    return this.request("POST", "/projects", { name, description });
  }

  /** List Coolify apps/services so callers can resolve a UUID by name. */
  async listApplications(): Promise<Array<{ uuid: string; name: string; description?: string }>> {
    return this.request("GET", "/applications");
  }

  /** List Coolify databases. Used by `hatchkit overview` for a
   *  fleet-level summary — the response shape differs by db type
   *  (postgres, mysql, mongodb, …), so we accept the loose union and
   *  return just `uuid`, `name`, and `type` (when present). */
  async listDatabases(): Promise<Array<{ uuid: string; name: string; type?: string }>> {
    const raw = await this.request<unknown>("GET", "/databases");
    if (!Array.isArray(raw)) return [];
    const out: Array<{ uuid: string; name: string; type?: string }> = [];
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const e = r as Record<string, unknown>;
      const uuid = typeof e.uuid === "string" ? e.uuid : null;
      const name = typeof e.name === "string" ? e.name : null;
      if (!uuid || !name) continue;
      const entry: { uuid: string; name: string; type?: string } = { uuid, name };
      if (typeof e.type === "string") entry.type = e.type;
      else if (typeof e.database_type === "string") entry.type = e.database_type;
      out.push(entry);
    }
    return out;
  }

  /** Find an existing application by exact name. Coolify doesn't
   *  enforce name uniqueness across projects, but within a single
   *  hatchkit-managed setup names ARE unique enough — first match
   *  wins. Used by `hatchkit adopt --resume` so re-runs reuse the app
   *  Coolify already created instead of minting a duplicate. */
  async findApplicationByName(name: string): Promise<{ uuid: string; name: string } | null> {
    const apps = await this.listApplications();
    const match = apps.find((a) => a.name === name);
    if (!match) return null;
    return { uuid: match.uuid, name: match.name };
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

  /** Create a PostgreSQL database. Coolify auto-generates a password if
   *  `postgresPassword` is omitted; the returned `internal_db_url` is
   *  the full `postgres://…` connection string usable from inside
   *  Coolify's Docker network (which is where the app container runs). */
  async createPostgresqlDatabase(params: {
    serverUuid: string;
    projectUuid: string;
    environmentName?: string;
    environmentUuid?: string;
    name: string;
    postgresUser?: string;
    postgresPassword?: string;
    postgresDb?: string;
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
    if (params.postgresUser) body.postgres_user = params.postgresUser;
    if (params.postgresPassword) body.postgres_password = params.postgresPassword;
    if (params.postgresDb) body.postgres_db = params.postgresDb;
    return this.request("POST", "/databases/postgresql", body);
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

  // ---------------------------------------------------------------------
  // Private registries — NOT exposed by Coolify v4
  // ---------------------------------------------------------------------
  //
  // Coolify v4 does not expose a /private-registries surface (verified
  // against openapi.yaml v4.x and against a live v4.0.0-beta.469 server:
  // GET /api/v1/private-registries returns 404 `{"message":"Not found."}`
  // ). The canonical workflow per the Coolify docs is to SSH into each
  // managed host and `docker login` — `~/.docker/config.json` then
  // satisfies every subsequent `docker pull`. See
  // `cli/src/utils/coolify-ssh.ts` for the helpers, and
  // `cli/src/deploy/ghcr.ts:registerGhcrCredsWithCoolify` for the flow
  // that uses them.
  //
  // When upstream ships a private-registries endpoint (tracked at
  // https://github.com/coollabsio/coolify/issues/2499) hatchkit can
  // pivot back to API-based registration here.

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

  // ---------------------------------------------------------------------
  // Application creation
  // ---------------------------------------------------------------------
  //
  // Coolify exposes one endpoint per source kind. We support the two the
  // typical hatchkit project hits:
  //   · POST /applications/public            — public GitHub repo
  //   · POST /applications/private-github-app — private repo via a
  //     Coolify-installed GitHub App. The user must have set up the
  //     GitHub App in Coolify once; we list those via /sources/github
  //     so the caller can pick.
  // Other source flavours (deploy keys, Dockerfile, docker-compose) are
  // out of scope for the current `hatchkit adopt` flow.

  /** GitHub source connections registered in Coolify. Used to resolve
   *  a `github_app_uuid` for private-repo application creation. Coolify
   *  currently exposes these at `/github-apps`; older builds exposed a
   *  broader `/sources` list, so we try both shapes. */
  async listGithubSources(): Promise<Array<{ uuid: string; name: string; html_url?: string }>> {
    try {
      const apps = (await this.request("GET", "/github-apps")) as Array<{
        uuid?: string;
        name?: string;
        html_url?: string;
        api_url?: string;
        organization?: string;
        is_public?: boolean;
        type?: string;
      }>;
      return apps
        .filter((app) => typeof app.uuid === "string")
        .map((app) => ({
          uuid: app.uuid as string,
          name: app.name || (app.organization ? `GitHub App (${app.organization})` : "GitHub App"),
          html_url: app.html_url || app.api_url,
        }));
    } catch {
      // Fall through to the legacy source endpoint.
    }

    // Legacy Coolify builds exposed /sources with a `type` discriminator.
    try {
      const sources = (await this.request("GET", "/sources")) as Array<{
        uuid: string;
        name: string;
        type?: string;
        html_url?: string;
      }>;
      return sources.filter((s) => !s.type || s.type === "github_app");
    } catch {
      // Unknown/older builds: return [] so callers can raise a clear
      // "install a GitHub App source" error before app creation.
      return [];
    }
  }

  /** Common request body shape across both public + private-github-app
   *  endpoints. Coolify mostly mirrors the docker-compose convention:
   *  `ports_exposes` is the comma-separated container port(s). */
  private buildAppCreateBody(input: ApplicationCreateInput): Record<string, unknown> {
    const buildPack = input.buildPack ?? "nixpacks";
    const body: Record<string, unknown> = {
      project_uuid: input.projectUuid,
      server_uuid: input.serverUuid,
      environment_name: input.environmentName ?? "production",
      git_repository: input.gitRepository,
      git_branch: input.gitBranch ?? "main",
      ports_exposes: input.portsExposes ?? "3000",
      build_pack: buildPack,
      name: input.name,
      description: input.description,
      instant_deploy: input.instantDeploy ?? true,
    };
    // dockercompose build pack reads docker-compose.yml from the repo;
    // tell Coolify where to find it. Default works when the file is
    // at the repo root (the canonical hatchkit layout). Coolify rejects
    // the regular `domains` field for dockercompose apps; domains must be
    // attached to individual compose services instead.
    if (buildPack === "dockercompose") {
      body.docker_compose_location = input.dockerComposeLocation ?? "/docker-compose.yml";
      const dockerComposeDomains =
        input.dockerComposeDomains ??
        input.domains?.map((domain) => ({
          name: input.dockerComposeDomainServiceName ?? "app",
          domain,
        }));
      if (dockerComposeDomains && dockerComposeDomains.length > 0) {
        body.docker_compose_domains = dockerComposeDomains;
      }
    } else if (input.domains && input.domains.length > 0) {
      body.domains = input.domains.join(",");
    }
    return body;
  }

  async createApplicationFromPublicRepo(
    input: ApplicationCreateInput,
  ): Promise<{ uuid: string; fqdn?: string }> {
    return this.request("POST", "/applications/public", this.buildAppCreateBody(input));
  }

  async createApplicationFromPrivateGithubApp(
    input: ApplicationCreateInput & { githubAppUuid: string },
  ): Promise<{ uuid: string; fqdn?: string }> {
    return this.request("POST", "/applications/private-github-app", {
      ...this.buildAppCreateBody(input),
      github_app_uuid: input.githubAppUuid,
    });
  }

  /** Patch fields on an existing Coolify application. Used by adopt's
   *  "found by name, reconcile config" path so a build_pack mismatch
   *  on an app created by an earlier run (e.g. `static` baked in by
   *  Coolify's New-App wizard, or by an older hatchkit default) gets
   *  corrected to `dockercompose` on `--resume`, and by `hatchkit sync`
   *  to push the manifest's domain onto an app that was created without
   *  it. Only fields the caller passes are sent — Coolify treats omitted
   *  keys as "leave as-is".
   *
   *  Domain handling mirrors the create path:
   *    · non-dockercompose → `domains` (comma-joined string)
   *    · dockercompose     → `docker_compose_domains` (per-service)
   *  Coolify rejects the flat `domains` field on dockercompose apps with
   *  422 ("Use docker_compose_domains instead"), so the caller is
   *  responsible for picking the right field — this method does no
   *  auto-translation, unlike `buildAppCreateBody`. */
  async updateApplication(
    uuid: string,
    fields: {
      buildPack?: "nixpacks" | "static" | "dockerfile" | "dockercompose";
      portsExposes?: string;
      dockerComposeLocation?: string;
      gitBranch?: string;
      gitRepository?: string;
      githubAppUuid?: string;
      description?: string;
      /** FQDNs for non-dockercompose build packs. Comma-joined when
       *  sent. Pass `[]` to clear all domains. */
      domains?: string[];
      /** Per-service domains for dockercompose apps. Pass `[]` to clear
       *  every routing entry. */
      dockerComposeDomains?: Array<{ name: string; domain: string }>;
    },
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (fields.buildPack !== undefined) body.build_pack = fields.buildPack;
    if (fields.portsExposes !== undefined) body.ports_exposes = fields.portsExposes;
    if (fields.dockerComposeLocation !== undefined) {
      body.docker_compose_location = fields.dockerComposeLocation;
    }
    if (fields.gitBranch !== undefined) body.git_branch = fields.gitBranch;
    if (fields.gitRepository !== undefined) body.git_repository = fields.gitRepository;
    if (fields.githubAppUuid !== undefined) body.github_app_uuid = fields.githubAppUuid;
    if (fields.description !== undefined) body.description = fields.description;
    if (fields.domains !== undefined) body.domains = fields.domains.join(",");
    if (fields.dockerComposeDomains !== undefined) {
      body.docker_compose_domains = fields.dockerComposeDomains;
    }
    if (Object.keys(body).length === 0) return;
    await this.request("PATCH", `/applications/${uuid}`, body);
  }

  /** Patch fields on an existing Coolify project. Used by adopt's
   *  reconcile path so a description change in `--resume` reaches
   *  the project page in the dashboard. */
  async updateProject(
    uuid: string,
    fields: { name?: string; description?: string },
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (fields.name !== undefined) body.name = fields.name;
    if (fields.description !== undefined) body.description = fields.description;
    if (Object.keys(body).length === 0) return;
    await this.request("PATCH", `/projects/${uuid}`, body);
  }

  /** Read the full state of a Coolify application by uuid. Used by
   *  `hatchkit sync` to render a before/after diff and skip the PATCH
   *  when the desired state already matches what Coolify reports.
   *
   *  Coolify's response shape varies by version: `fqdn` on older
   *  builds is a comma-joined string for non-dockercompose apps, or
   *  null for dockercompose; `docker_compose_domains` on newer builds
   *  is an array of `{ name, domain }` entries. We accept both and
   *  return them unchanged for the caller to interpret per build pack. */
  async getApplication(uuid: string): Promise<CoolifyApplication> {
    const raw = (await this.request("GET", `/applications/${uuid}`)) as Record<string, unknown>;
    const buildPack = (raw.build_pack as CoolifyApplication["buildPack"]) ?? undefined;
    const fqdn = typeof raw.fqdn === "string" ? raw.fqdn : null;
    // docker_compose_domains arrives as either a JSON-encoded string,
    // a parsed array, or null depending on the Coolify version. Normalize
    // to `Array<{ name, domain }>` (or undefined when absent).
    let dockerComposeDomains: Array<{ name: string; domain: string }> | undefined;
    const rawDomains = raw.docker_compose_domains;
    if (Array.isArray(rawDomains)) {
      dockerComposeDomains = rawDomains
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const e = entry as Record<string, unknown>;
          const name = typeof e.name === "string" ? e.name : null;
          const domain = typeof e.domain === "string" ? e.domain : null;
          return name && domain ? { name, domain } : null;
        })
        .filter((entry): entry is { name: string; domain: string } => entry !== null);
    } else if (typeof rawDomains === "string" && rawDomains.trim()) {
      try {
        const parsed = JSON.parse(rawDomains);
        if (Array.isArray(parsed)) {
          dockerComposeDomains = parsed.filter(
            (e): e is { name: string; domain: string } =>
              !!e &&
              typeof e === "object" &&
              typeof e.name === "string" &&
              typeof e.domain === "string",
          );
        }
      } catch {
        // Coolify wrote something we can't parse — surface as undefined.
      }
    }
    return {
      uuid: typeof raw.uuid === "string" ? raw.uuid : uuid,
      name: typeof raw.name === "string" ? raw.name : "",
      buildPack,
      fqdn,
      dockerComposeDomains,
      portsExposes: typeof raw.ports_exposes === "string" ? raw.ports_exposes : undefined,
      gitRepository: typeof raw.git_repository === "string" ? raw.git_repository : undefined,
      gitBranch: typeof raw.git_branch === "string" ? raw.git_branch : undefined,
      serverUuid: extractServerUuid(raw),
    };
  }

  /** Trigger a deploy of an existing application. Useful after we've
   *  set env vars post-creation. */
  async deployApplication(uuid: string): Promise<void> {
    await this.request("POST", `/applications/${uuid}/start`);
  }

  /** GET /servers/{uuid}/domains — returns one entry per running
   *  domain on this server, keyed by the IP it resolves to. For a
   *  localhost-Coolify server this falls back to the instance's
   *  configured public_ipv4 / public_ipv6, which is exactly the data
   *  we need to write A / AAAA records pointing at the box.
   *
   *  The server-side type is loose; it can return either an array
   *  directly or `{ data: [...] }`, so we accept both. */
  async getServerDomains(uuid: string): Promise<Array<{ ip?: string; domain?: string }>> {
    const raw = (await this.request("GET", `/servers/${uuid}/domains`)) as
      | Array<{ ip?: string; domain?: string }>
      | { data?: Array<{ ip?: string; domain?: string }> };
    if (Array.isArray(raw)) return raw;
    return raw?.data ?? [];
  }
}

/** Subset of an application's state that hatchkit cares about. Used
 *  by `hatchkit sync` to diff the desired manifest against what
 *  Coolify reports. Coolify returns many more fields; we only surface
 *  the ones a sync/diff would act on. */
export interface CoolifyApplication {
  uuid: string;
  name: string;
  buildPack?: "nixpacks" | "static" | "dockerfile" | "dockercompose";
  /** Comma-joined FQDN string Coolify exposes for non-dockercompose
   *  apps (and as a denormalized cache for dockercompose apps on some
   *  builds). Null when no domains are attached. */
  fqdn: string | null;
  /** Per-service routing for dockercompose apps. Undefined when the
   *  app isn't dockercompose or no per-service domains are set. */
  dockerComposeDomains?: Array<{ name: string; domain: string }>;
  /** `ports_exposes` as Coolify stores it (comma-separated). */
  portsExposes?: string;
  /** Linked git source — surfaced for read-only inventory/drift checks
   *  that need to compare what Coolify thinks the app deploys from
   *  against the local `git remote`. Both fields are best-effort; old
   *  Coolify builds may not set them, and self-hosted setups may store
   *  the URL in a non-standard shape. */
  gitRepository?: string;
  gitBranch?: string;
  /** UUID of the linked Coolify server (the box this app deploys to).
   *  Lets inventory resolve the server's IP via `getServerDomains` and
   *  compare against the DNS A record for `fqdn`. */
  serverUuid?: string;
}

export interface ApplicationCreateInput {
  projectUuid: string;
  serverUuid: string;
  environmentName?: string;
  /** Full URL for public repos (`https://github.com/owner/name`) or
   *  the `owner/name` shorthand for private-github-app. Coolify
   *  accepts both for either flavour. */
  gitRepository: string;
  gitBranch?: string;
  /** Comma-separated container ports the app exposes. */
  portsExposes?: string;
  buildPack?: "nixpacks" | "static" | "dockerfile" | "dockercompose";
  name?: string;
  description?: string;
  /** FQDNs Coolify should attach to this app. Leave undefined to let
   *  Coolify pick a sslip.io host; pass `https://<domain>` to bind to
   *  a real one (assumes DNS already points at the server). For
   *  `dockercompose` apps, Coolify rejects this field — the API client
   *  auto-translates entries here onto `dockerComposeDomains` using
   *  `composeServiceName` (default `app`). For per-service routing
   *  (different domains on different services) pass
   *  `dockerComposeDomains` directly. */
  domains?: string[];
  /** Per-service domains for dockercompose apps. Coolify rejects the
   *  top-level `domains` field when `build_pack=dockercompose`. */
  dockerComposeDomains?: Array<{ name: string; domain: string }>;
  /** Fallback service name when callers pass `domains` for a
   *  dockercompose app. Defaults to the hatchkit scaffold's `app`. */
  dockerComposeDomainServiceName?: string;
  instantDeploy?: boolean;
  /** Repo-relative path to the compose file when buildPack is
   *  `dockercompose`. Defaults to `/docker-compose.yml`. */
  dockerComposeLocation?: string;
}

/** Pull the linked server UUID out of an /applications/{uuid} raw
 *  response. Coolify versions differ on where it lands — older builds
 *  nest it under `destination.server`, newer ones under `server`. Both
 *  forms are shallow JSON objects with a `uuid` string. */
function extractServerUuid(raw: Record<string, unknown>): string | undefined {
  const dest = raw.destination;
  if (dest && typeof dest === "object") {
    const server = (dest as { server?: unknown }).server;
    if (server && typeof server === "object") {
      const uuid = (server as { uuid?: unknown }).uuid;
      if (typeof uuid === "string") return uuid;
    }
  }
  const server = raw.server;
  if (server && typeof server === "object") {
    const uuid = (server as { uuid?: unknown }).uuid;
    if (typeof uuid === "string") return uuid;
  }
  return undefined;
}

/** Verify Coolify connection. Returns version string or throws. */
export async function verifyCoolify(url: string, token: string): Promise<string> {
  const api = new CoolifyApi({ url, token });
  return api.getVersion();
}
