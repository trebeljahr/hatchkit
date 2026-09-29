import {
  type HealthCheckSpec,
  type ImageRef,
  type LiveHealthCheck,
  healthCheckPayload,
} from "../deploy/image-runtime.js";
import { collapseComposeDomains, splitDomainString } from "../deploy/routing.js";

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

// ---------------------------------------------------------------------------
// Known PATCH limits of Coolify's application endpoint
// ---------------------------------------------------------------------------
//
// `PATCH /applications/{uuid}` validates against a per-build allow-list
// and fails the WHOLE request on the first key outside it:
//
//   422 {"message":"Validation failed.",
//        "errors":{"<field>":["This field is not allowed."]}}
//
// Verified against Coolify 4.0.0-beta.469 (coolify.trebeljahr.com), and
// the reason `hatchkit sync` once reported "✓ Synced 2 app(s)" over an
// error block while both apps sat there with no domain:
//
//   · `is_stripprefix_enabled` — REJECTED on this build. Write-only
//     even where accepted (absent from GET), and inert unless some
//     route carries a non-`/` path, so it is best-effort: drop it and
//     keep the domains.
//   · `docker_compose_raw`     — REJECTED on this build, and
//     `docker_compose_domains` cannot be stored without it. An app that
//     has never deployed successfully has `docker_compose_raw: null`
//     (Coolify fills it from the repo at deploy time), and therefore
//     CANNOT be given a domain over the API at all. Deploy once, then
//     re-run sync.
//   · `source_id` / `source_type` — REJECTED on this build, though both
//     come back on GET. Source is chosen at creation time; hatchkit
//     re-points a repo via `git_repository` / `github_app_uuid`.
//   · `connect_to_docker_network` — ACCEPTED on PATCH, and WRITE-ONLY:
//     it never comes back on GET, and the `settings` relation it lives
//     in serializes as `null`. Do not try to read it back — see the
//     block below.
//
// ---------------------------------------------------------------------------
// `connect_to_docker_network`, and the crash loop it prevents
// ---------------------------------------------------------------------------
//
// A `dockercompose` application is deployed onto a Docker network named
// after its OWN uuid — Coolify appends this to the generated compose:
//
//   networks:
//     <app-uuid>:
//       name: <app-uuid>
//       external: true
//
// Coolify-MANAGED databases (anything created through `/databases/*`,
// which is every datastore `hatchkit add` provisions) live on the shared
// `coolify` network instead. The two are isolated, so an app cannot
// resolve its own database by the container hostname Coolify itself
// handed us in `internal_db_url`. "Connect to Predefined Network" —
// `connect_to_docker_network` — is what joins the app to `coolify`.
//
// Without it, the app crash-loops from its very first deploy:
//
//   [server] Failed to start: MongooseServerSelectionError:
//     getaddrinfo ENOTFOUND x3rnoe4qdk846u4q3wjw2fw0
//
// Two things kept that undiagnosed on tracktime for months, and are the
// reason doctor now has a check for it (2026-09-08):
//
//   1. Coolify reports `status: "running:healthy"` for a crash-looping
//      app. The only signal in the record is `restart_count` climbing
//      with `last_restart_type: "crash"` — visible only by diffing the
//      app against a working sibling.
//   2. The proxy makes it read as a routing bug. caddy-docker-proxy
//      registers no site for a container that keeps dying, so the public
//      symptom is `503 no available server` — byte-identical to the
//      response for a hostname nobody has ever configured. Hours went
//      into Traefik/Caddy label ordering before anyone read the
//      container log.
//
// Because the field is write-only, hatchkit CANNOT verify it by reading
// the record back, and no code here should try: a GET round-trip will
// report `undefined` on a correctly-configured app and there is no way
// to tell that apart from "never set". Verify by EFFECT instead —
// `restart_count` / `last_restart_type` on the next deploy — which is
// exactly what `checkProjectCoolifyAppHealthState` in doctor.ts does.

/** Fields hatchkit will silently drop and retry without when Coolify
 *  rejects them. Everything NOT listed here is essential: rejecting one
 *  of those means the caller's intent can't be carried out, and a
 *  thrown error is the honest answer. */
const BEST_EFFORT_PATCH_FIELDS = new Set(["is_stripprefix_enabled"]);

/** How many drop-and-retry passes one `updateApplication` call may make.
 *  Two is enough for every rejection combination seen, and bounds the
 *  loop against a Coolify that answers 422 for some other reason. */
const MAX_FIELD_DROP_RETRIES = 2;

/** Field names Coolify named as "not allowed" in a 422 validation body.
 *  Reads the `errors` map out of the JSON tail of the message
 *  {@link CoolifyApi.request} builds, and falls back to a regex when
 *  the body isn't parseable. Returns `[]` for any error that isn't a
 *  field-rejection — callers must not treat that as "nothing wrong". */
export function parseRejectedFields(message: string): string[] {
  const jsonStart = message.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as {
        errors?: Record<string, unknown>;
      };
      if (parsed.errors && typeof parsed.errors === "object") {
        return Object.entries(parsed.errors)
          .filter(([, msgs]) =>
            (Array.isArray(msgs) ? msgs : [msgs]).some(
              (m) => typeof m === "string" && /not allowed/i.test(m),
            ),
          )
          .map(([field]) => field);
      }
    } catch {
      // Not JSON (or a truncated body) — fall through to the regex.
    }
  }
  const out: string[] = [];
  const re = /"([a-z0-9_]+)"\s*:\s*\[\s*"[^"]*not allowed[^"]*"/gi;
  for (let m = re.exec(message); m; m = re.exec(message)) out.push(m[1]);
  return out;
}

/** A user-facing explanation for a Coolify field rejection hatchkit
 *  already understands, or `undefined` when the field is new to us and
 *  the raw 422 is the most honest thing to show.
 *
 *  Exists so a known API limit reads as a limit with a way forward,
 *  rather than as a validation error the user has to go decode. */
export function describeCoolifyPatchLimit(field: string): string | undefined {
  switch (field) {
    case "is_stripprefix_enabled":
      return (
        "This Coolify build rejects `is_stripprefix_enabled` on PATCH. It only matters for " +
        "path-scoped routing (`https://<domain>/api`); toggle it in the app's Configuration → " +
        "Advanced → Strip Prefix if a path route 404s at the backend."
      );
    case "docker_compose_raw":
    case "docker_compose_domains":
      return (
        "This Coolify build won't store `docker_compose_domains` without `docker_compose_raw`, " +
        "and rejects `docker_compose_raw` on PATCH. Coolify fills that field from the repo on a " +
        "successful deploy, so an app that has NEVER deployed cannot be given a domain over the " +
        "API. Deploy the app once (Coolify dashboard → Deploy, or push a commit), then re-run " +
        "`hatchkit sync` to attach the domains."
      );
    case "connect_to_docker_network":
      return (
        "This Coolify build rejects `connect_to_docker_network` on PATCH. A dockercompose app " +
        "runs on a network named after its own uuid, while Coolify-managed databases sit on the " +
        "shared `coolify` network, so without this setting the app cannot resolve its database " +
        "host and crash-loops with ENOTFOUND. Turn it on by hand: the app's Configuration → " +
        'Advanced → "Connect to Predefined Network" → ON, then redeploy.'
      );
    case "source_id":
    case "source_type":
      return (
        "Coolify sets an application's git source at creation time and rejects it on PATCH. " +
        "Re-point the repo with `git_repository` / the GitHub App instead, or recreate the app."
      );
    default:
      return undefined;
  }
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

  /** Every application's compose SOURCE — the file as it sits in the
   *  repo — plus where it came from. Backs doctor's pull-policy check.
   *
   *  Only `docker_compose_raw` is read. `docker_compose` is Coolify's
   *  rendered copy with the app's environment interpolated into it,
   *  DOTENV_PRIVATE_KEY_PRODUCTION included, so it is dropped here and
   *  never leaves this method. */
  async listComposeSources(): Promise<CoolifyComposeSource[]> {
    const raw = await this.request<unknown>("GET", "/applications");
    if (!Array.isArray(raw)) return [];
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const out: CoolifyComposeSource[] = [];
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const e = r as Record<string, unknown>;
      if (typeof e.uuid !== "string") continue;
      out.push({
        uuid: e.uuid,
        name: str(e.name) ?? e.uuid,
        buildPack: str(e.build_pack),
        gitRepository: str(e.git_repository),
        gitBranch: str(e.git_branch),
        baseDirectory: str(e.base_directory),
        dockerComposeLocation: str(e.docker_compose_location),
        dockerComposeRaw:
          typeof e.docker_compose_raw === "string"
            ? e.docker_compose_raw
            : e.docker_compose_raw === null
              ? null
              : undefined,
      });
    }
    return out;
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

  /** Upsert env variables on a Coolify application in one call.
   *
   *  `PATCH /envs/bulk` CREATES a key that doesn't exist and updates one
   *  that does (`create_bulk_envs` in ApplicationsController, verified at
   *  v4.0.0-beta.469 and v4.x). That is not true of the single-key
   *  `PATCH /envs`, which never creates a missing key — the "PATCH
   *  only updates" warnings elsewhere in this repo are about that
   *  endpoint.
   *  A caller that must know the value landed should still read it back:
   *  see deploy/trusted-origins.ts. */
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

  /** Create a Redis database. Needed by the `split` deployment
   *  topology: the two Coolify apps sit on separate Docker networks, so
   *  a redis declared in one half's compose is unreachable from the
   *  other — it has to be a Coolify-managed resource on the shared
   *  network instead. `internal_db_url` is the `redis://…` string
   *  usable from inside that network. */
  async createRedisDatabase(params: {
    serverUuid: string;
    projectUuid: string;
    environmentName?: string;
    environmentUuid?: string;
    name: string;
    /** Coolify auto-generates one if omitted. */
    redisPassword?: string;
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
    if (params.redisPassword) body.redis_password = params.redisPassword;
    return this.request("POST", "/databases/redis", body);
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
        .filter((app) => !isPublicGithubSource(app))
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
        is_public?: boolean;
      }>;
      return sources
        .filter((s) => !s.type || s.type === "github_app")
        .filter((s) => !isPublicGithubSource(s));
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
    // `base_directory` is the repo-relative path Coolify uses as the
    // build context root. Required when the deployable lives in a
    // subfolder of a larger repo (CLI repo with sibling marketing site,
    // monorepo with apps/web). Coolify accepts it for every build pack
    // (nixpacks, dockerfile, dockercompose, static). When unset,
    // Coolify falls back to its built-in default ("/") which is the
    // single-package-at-root layout — that's the back-compat we want
    // for every manifest without a `projectSubdir`.
    if (input.baseDirectory) {
      body.base_directory = normalizeCoolifyBaseDirectory(input.baseDirectory);
    }
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
      // Collapse to one entry per service. Coolify STORES this as a map
      // keyed by service name, so two entries with the same `name` are a
      // silent last-wins drop; several FQDNs for one service have to be
      // comma-joined into a single entry instead (Coolify explodes on
      // commas at both validation and label-generation time).
      if (dockerComposeDomains && dockerComposeDomains.length > 0) {
        body.docker_compose_domains = collapseComposeDomains(dockerComposeDomains);
      }
    } else if (input.domains && input.domains.length > 0) {
      body.domains = input.domains.join(",");
    }
    // Sent on create too, though Coolify strips it before the
    // compose-domain conflict check reads it — see the field's doc on
    // ApplicationCreateInput. Present so the request is correct by the
    // API's own contract, not because it currently rescues a create.
    if (input.forceDomainOverride) {
      body.force_domain_override = true;
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
   *  auto-translation, unlike `buildAppCreateBody`.
   *
   *  `isAutoDeployEnabled` toggles Coolify's git-webhook auto-deploy.
   *  Build-pipeline projects (GHA builds the image + calls the deploy
   *  webhook) want this OFF — otherwise Coolify reacts to every push
   *  by trying to deploy stale-or-absent images before the GHA build
   *  has produced fresh ones, racing the workflow and surfacing as
   *  flaky deploys. Coolify-builds-from-source projects want it ON. */
  async updateApplication(
    uuid: string,
    fields: {
      buildPack?: "nixpacks" | "static" | "dockerfile" | "dockercompose" | "dockerimage";
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
       *  every routing entry. Several FQDNs for one service may be
       *  passed as repeated entries — they're collapsed into the single
       *  comma-joined entry Coolify actually stores. */
      dockerComposeDomains?: Array<{ name: string; domain: string }>;
      /** Toggle Coolify's git-webhook auto-deploy. See method doc above. */
      isAutoDeployEnabled?: boolean;
      /** Coolify's `is_stripprefix_enabled`. MUST be false on any app
       *  whose routing uses a path (e.g. `https://<domain>/api`):
       *  Coolify attaches a Traefik `stripprefix` middleware for every
       *  non-`/` path, so with it on the backend receives `/health`
       *  where the client asked for `/api/health`.
       *
       *  Leave undefined when routing is all-`/` — the setting is inert
       *  there, and some builds reject the field outright (see the
       *  known-PATCH-limits block at the top of this file). It is
       *  BEST-EFFORT: a rejection drops it and retries rather than
       *  failing the domains it travelled with. */
      isStripprefixEnabled?: boolean;
      /** Coolify's `connect_to_docker_network` ("Connect to Predefined
       *  Network"). MUST be true on any app whose env points at a
       *  Coolify-MANAGED database: the app runs on a network named
       *  after its own uuid, the database sits on the shared `coolify`
       *  network, and without this the app cannot resolve the very
       *  hostname Coolify handed us in `internal_db_url`. The symptom
       *  is a crash loop Coolify still reports as `running:healthy`.
       *
       *  WRITE-ONLY on every build tested — it never comes back on GET,
       *  so there is nothing to diff and nothing to assert. Treated as
       *  ESSENTIAL rather than best-effort: dropping it would leave the
       *  app broken in exactly the way that is hard to see, so a
       *  rejection throws and the caller surfaces the manual toggle. */
      connectToDockerNetwork?: boolean;
      /** Coolify rejects a domain already claimed by another resource
       *  (409) or repeated inside one request (422) unless this is set.
       *  Only pass true when the conflicting resource is one hatchkit
       *  is itself replacing. */
      forceDomainOverride?: boolean;
      /** Repo-relative build context root. Pass `""` (empty string) or
       *  `"/"` to reset back to repo root; pass a sub-path like
       *  `"site"` or `"apps/web"` to point Coolify at a sub-folder
       *  build context. Mirrors the manifest's `projectSubdir`. */
      baseDirectory?: string;
      /** Rename the application. Cosmetic to Coolify — container labels
       *  only pick the new name up on the next deploy — but it is how
       *  hatchkit finds apps, so `migrate-runtime` renames the legacy
       *  compose app out of the way before its replacement takes the
       *  canonical name. */
      name?: string;
      /** `docker_registry_image_name` of a `dockerimage` app. */
      dockerRegistryImageName?: string;
      /** `docker_registry_image_tag` of a `dockerimage` app. The deploy
       *  job owns this after creation (it pins each push's sha), so
       *  reconcile paths must NOT send it — they would roll production
       *  back to the mutable branch tag. */
      dockerRegistryImageTag?: string;
      /** Health check for a `dockerimage` app. Without one Coolify's
       *  deploy is not a rolling update in any useful sense — see
       *  deploy/image-runtime.ts. */
      healthCheck?: HealthCheckSpec;
    },
  ): Promise<{ droppedFields: string[] }> {
    const body: Record<string, unknown> = {};
    if (fields.name !== undefined) body.name = fields.name;
    if (fields.dockerRegistryImageName !== undefined) {
      body.docker_registry_image_name = fields.dockerRegistryImageName;
    }
    if (fields.dockerRegistryImageTag !== undefined) {
      body.docker_registry_image_tag = fields.dockerRegistryImageTag;
    }
    if (fields.healthCheck !== undefined)
      Object.assign(body, healthCheckPayload(fields.healthCheck));
    if (fields.buildPack !== undefined) body.build_pack = fields.buildPack;
    if (fields.portsExposes !== undefined) body.ports_exposes = fields.portsExposes;
    if (fields.dockerComposeLocation !== undefined) {
      body.docker_compose_location = fields.dockerComposeLocation;
    }
    if (fields.gitBranch !== undefined) body.git_branch = fields.gitBranch;
    if (fields.gitRepository !== undefined) body.git_repository = fields.gitRepository;
    if (fields.githubAppUuid !== undefined) body.github_app_uuid = fields.githubAppUuid;
    if (fields.description !== undefined) body.description = fields.description;
    if (fields.baseDirectory !== undefined) {
      body.base_directory = normalizeCoolifyBaseDirectory(fields.baseDirectory);
    }
    if (fields.domains !== undefined) body.domains = fields.domains.join(",");
    if (fields.dockerComposeDomains !== undefined) {
      body.docker_compose_domains = collapseComposeDomains(fields.dockerComposeDomains);
    }
    if (fields.isAutoDeployEnabled !== undefined) {
      body.is_auto_deploy_enabled = fields.isAutoDeployEnabled;
    }
    if (fields.isStripprefixEnabled !== undefined) {
      body.is_stripprefix_enabled = fields.isStripprefixEnabled;
    }
    if (fields.connectToDockerNetwork !== undefined) {
      body.connect_to_docker_network = fields.connectToDockerNetwork;
    }
    if (fields.forceDomainOverride) {
      body.force_domain_override = true;
    }
    if (Object.keys(body).length === 0) return { droppedFields: [] };
    return this.patchApplicationDroppingRejectedFields(uuid, body);
  }

  /** PATCH an application, retrying without any BEST-EFFORT field this
   *  Coolify build refuses.
   *
   *  Coolify's allow-list is per-build, and a field outside it fails the
   *  WHOLE request: `422 {"message":"Validation failed.","errors":
   *  {"is_stripprefix_enabled":["This field is not allowed."]}}` — which
   *  is how a routing sync that only wanted to attach two domains ended
   *  up attaching none. The domains are the point; the strip-prefix
   *  toggle is a nicety. So a rejected best-effort field is dropped and
   *  the request retried, while a rejected ESSENTIAL field still throws
   *  (dropping it would report success for a call that changed nothing
   *  the caller asked for).
   *
   *  Bounded to {@link MAX_FIELD_DROP_RETRIES} passes so a build that
   *  rejects several fields converges in one call site rather than
   *  needing one round trip per field, and a Coolify that answers 422
   *  for some other reason can never spin. */
  private async patchApplicationDroppingRejectedFields(
    uuid: string,
    body: Record<string, unknown>,
  ): Promise<{ droppedFields: string[] }> {
    const droppedFields: string[] = [];
    for (let attempt = 0; ; attempt++) {
      try {
        await this.request("PATCH", `/applications/${uuid}`, body);
        return { droppedFields };
      } catch (err) {
        const rejected = parseRejectedFields((err as Error).message).filter((f) => f in body);
        const droppable = rejected.filter((f) => BEST_EFFORT_PATCH_FIELDS.has(f));
        // Nothing droppable: either no field was named, or the field
        // that was named is one the caller actually needs. Either way
        // the caller has to hear about it.
        if (droppable.length === 0 || attempt >= MAX_FIELD_DROP_RETRIES) throw err;
        for (const f of droppable) {
          delete body[f];
          droppedFields.push(f);
        }
        // Every remaining key was a companion of the dropped ones —
        // there is nothing left to ask for, so don't ask.
        if (Object.keys(body).length === 0) return { droppedFields };
      }
    }
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
   *  return them unchanged for the caller to interpret per build pack.
   *
   *  Deliberately absent from the result: `connect_to_docker_network`.
   *  It is write-only (see the known-limits block at the top of this
   *  file) — the API never echoes it and the `settings` relation it
   *  belongs to serializes as `null`. Adding a field for it here would
   *  read `undefined` on a correctly-configured app, which is the same
   *  thing it reads on a broken one. `restartCount` + `lastRestartType`
   *  below are the observable proxy. */
  async getApplication(uuid: string): Promise<CoolifyApplication> {
    const raw = (await this.request("GET", `/applications/${uuid}`)) as Record<string, unknown>;
    const buildPack = (raw.build_pack as CoolifyApplication["buildPack"]) ?? undefined;
    const fqdn = typeof raw.fqdn === "string" ? raw.fqdn : null;
    const dockerComposeDomains = parseDockerComposeDomains(raw.docker_compose_domains);
    return {
      uuid: typeof raw.uuid === "string" ? raw.uuid : uuid,
      name: typeof raw.name === "string" ? raw.name : "",
      buildPack,
      fqdn,
      dockerComposeDomains,
      portsExposes:
        typeof raw.ports_exposes === "string"
          ? raw.ports_exposes
          : typeof raw.ports_exposes === "number"
            ? String(raw.ports_exposes)
            : undefined,
      isStripprefixEnabled:
        typeof raw.is_stripprefix_enabled === "boolean" ? raw.is_stripprefix_enabled : undefined,
      gitRepository: typeof raw.git_repository === "string" ? raw.git_repository : undefined,
      gitBranch: typeof raw.git_branch === "string" ? raw.git_branch : undefined,
      gitCommitSha: typeof raw.git_commit_sha === "string" ? raw.git_commit_sha : undefined,
      dockerComposeLocation:
        typeof raw.docker_compose_location === "string" ? raw.docker_compose_location : undefined,
      serverUuid: extractServerUuid(raw),
      isAutoDeployEnabled:
        typeof raw.is_auto_deploy_enabled === "boolean" ? raw.is_auto_deploy_enabled : undefined,
      baseDirectory: typeof raw.base_directory === "string" ? raw.base_directory : undefined,
      status: typeof raw.status === "string" ? raw.status : undefined,
      restartCount: coerceCount(raw.restart_count),
      lastRestartType:
        typeof raw.last_restart_type === "string" ? raw.last_restart_type : undefined,
      dockerRegistryImageName:
        typeof raw.docker_registry_image_name === "string"
          ? raw.docker_registry_image_name
          : undefined,
      dockerRegistryImageTag:
        typeof raw.docker_registry_image_tag === "string"
          ? raw.docker_registry_image_tag
          : undefined,
      healthCheck: {
        enabled:
          typeof raw.health_check_enabled === "boolean"
            ? raw.health_check_enabled
            : raw.health_check_enabled === 1
              ? true
              : raw.health_check_enabled === 0
                ? false
                : undefined,
        path: typeof raw.health_check_path === "string" ? raw.health_check_path : undefined,
        intervalSeconds: coerceCount(raw.health_check_interval),
        timeoutSeconds: coerceCount(raw.health_check_timeout),
        retries: coerceCount(raw.health_check_retries),
        startPeriodSeconds: coerceCount(raw.health_check_start_period),
      },
      portsMappings: typeof raw.ports_mappings === "string" ? raw.ports_mappings : null,
      customDockerRunOptions:
        typeof raw.custom_docker_run_options === "string" ? raw.custom_docker_run_options : null,
      environmentId: typeof raw.environment_id === "number" ? raw.environment_id : undefined,
    };
  }

  /** The compose file Coolify last loaded for a `dockercompose` app —
   *  the repo's file as committed, NOT the interpolated one. Read by
   *  `migrate-runtime` to learn each service's image, port, env and
   *  routing labels. Null for apps that never deployed.
   *
   *  Deliberately not part of {@link getApplication}: the same GET also
   *  returns `docker_compose` (the INTERPOLATED file, with dotenvx keys
   *  inlined — see the Coolify API memory note), and keeping this read
   *  separate keeps that neighbour out of every other caller's hands. */
  async getApplicationComposeRaw(uuid: string): Promise<string | null> {
    const raw = (await this.request("GET", `/applications/${uuid}`)) as Record<string, unknown>;
    return typeof raw.docker_compose_raw === "string" && raw.docker_compose_raw.trim() !== ""
      ? raw.docker_compose_raw
      : null;
  }

  /** What the signed deploy webhook depends on, for one application
   *  (see deploy/coolify-deploy-hook.ts).
   *
   *  `githubSecret` is a secret VALUE. It is read only so the caller can
   *  compare it with the keychain copy in memory; nothing may print it.
   *  Visible only to a token with `root` or `read:sensitive`, which the
   *  provisioner has. `otherSlotsLocked` is false while any of the
   *  GitLab/Gitea/Bitbucket secrets is null: those endpoints then accept
   *  a signature made with the empty key. */
  async getDeployHookState(uuid: string): Promise<{
    githubSecret: string | null;
    otherSlotsLocked: boolean;
    watchPaths: string | null;
    gitRepository?: string;
    gitBranch?: string;
    buildPack?: string;
  }> {
    const raw = (await this.request("GET", `/applications/${uuid}`)) as Record<string, unknown>;
    const secret = (key: string) =>
      typeof raw[key] === "string" && (raw[key] as string) !== "" ? (raw[key] as string) : null;
    return {
      githubSecret: secret("manual_webhook_secret_github"),
      otherSlotsLocked: ["gitlab", "bitbucket", "gitea"].every(
        (slot) => secret(`manual_webhook_secret_${slot}`) !== null,
      ),
      watchPaths: typeof raw.watch_paths === "string" ? raw.watch_paths : null,
      gitRepository: typeof raw.git_repository === "string" ? raw.git_repository : undefined,
      gitBranch: typeof raw.git_branch === "string" ? raw.git_branch : undefined,
      buildPack: typeof raw.build_pack === "string" ? raw.build_pack : undefined,
    };
  }

  /** Write the settings the signed deploy webhook needs. Every field is
   *  ESSENTIAL: a dropped one would leave the app either undeployable
   *  (auto-deploy off) or deployable by anyone (a null secret). */
  async updateDeployHook(
    uuid: string,
    fields: {
      webhookSecrets?: { github?: string; gitlab?: string; bitbucket?: string; gitea?: string };
      watchPaths?: string;
      autoDeploy?: boolean;
    },
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    for (const [slot, value] of Object.entries(fields.webhookSecrets ?? {})) {
      if (value !== undefined) body[`manual_webhook_secret_${slot}`] = value;
    }
    if (fields.watchPaths !== undefined) body.watch_paths = fields.watchPaths;
    if (fields.autoDeploy !== undefined) body.is_auto_deploy_enabled = fields.autoDeploy;
    if (Object.keys(body).length === 0) return;
    try {
      await this.request("PATCH", `/applications/${uuid}`, body);
    } catch (err) {
      // The error text can echo the request body back; strip anything
      // that looks like one of the secrets before it reaches a terminal.
      const message = (err as Error).message.replace(/[0-9a-f]{64}/g, "<redacted>");
      throw new Error(message);
    }
  }

  /** Create a Coolify **Docker Image** application — the build pack that
   *  gets rolling updates (see deploy/image-runtime.ts).
   *
   *  No git source: the image is built by GitHub Actions and pulled from
   *  GHCR, so there is no clone, no GitHub App grant and no compose file
   *  involved. `force_domain_override` IS honoured here (flat `domains`
   *  are conflict-checked in `validateDataApplications`, before the
   *  field is stripped), which is what lets a replacement app share a
   *  hostname with the app it replaces for the length of a cutover. */
  async createDockerImageApplication(input: {
    projectUuid: string;
    serverUuid: string;
    environmentName?: string;
    environmentUuid?: string;
    name: string;
    description?: string;
    image: ImageRef;
    portsExposes: string;
    domains: string[];
    healthCheck: HealthCheckSpec;
    forceDomainOverride?: boolean;
    instantDeploy?: boolean;
  }): Promise<{ uuid: string; domains?: string }> {
    const body: Record<string, unknown> = {
      project_uuid: input.projectUuid,
      server_uuid: input.serverUuid,
      name: input.name,
      docker_registry_image_name: input.image.name,
      docker_registry_image_tag: input.image.tag,
      ports_exposes: input.portsExposes,
      domains: input.domains.join(","),
      instant_deploy: input.instantDeploy ?? false,
      ...healthCheckPayload(input.healthCheck),
    };
    if (input.environmentUuid) body.environment_uuid = input.environmentUuid;
    else body.environment_name = input.environmentName ?? "production";
    if (input.description) body.description = input.description;
    // Without a domain Coolify would mint an sslip.io one; an app with
    // no public surface (never the case today) should say so explicitly.
    if (input.domains.length === 0) body.autogenerate_domain = false;
    if (input.forceDomainOverride) body.force_domain_override = true;
    return this.request("POST", "/applications/dockerimage", body);
  }

  /** Queue a deploy through `/deploy?uuid=`, the same endpoint the GitHub
   *  Actions job calls. Returns the queued deployment's uuid. */
  async queueDeploy(
    uuid: string,
    opts: { force?: boolean } = {},
  ): Promise<{ deploymentUuid?: string }> {
    const raw = (await this.request(
      "GET",
      `/deploy?uuid=${encodeURIComponent(uuid)}&force=${opts.force ? "true" : "false"}`,
    )) as { deployments?: Array<{ deployment_uuid?: string }> } | undefined;
    const deploymentUuid = raw?.deployments?.find(
      (d) => typeof d.deployment_uuid === "string",
    )?.deployment_uuid;
    return deploymentUuid ? { deploymentUuid } : {};
  }

  /** Most recent deployments of one application, newest first. Unlike
   *  `GET /deployments/{uuid}` this keeps finished deployments, so a
   *  poller can see how one ended. Log bodies are dropped. */
  async listApplicationDeployments(
    uuid: string,
    take = 5,
  ): Promise<Array<{ deploymentUuid: string; status?: string; createdAt?: string }>> {
    const raw = (await this.request(
      "GET",
      `/deployments/applications/${uuid}?skip=0&take=${take}`,
    )) as { deployments?: Array<Record<string, unknown>> } | undefined;
    return (raw?.deployments ?? [])
      .filter((d) => typeof d.deployment_uuid === "string")
      .map((d) => ({
        deploymentUuid: d.deployment_uuid as string,
        status: typeof d.status === "string" ? d.status : undefined,
        createdAt: typeof d.created_at === "string" ? d.created_at : undefined,
      }));
  }

  /** Ask Coolify to stop an application's containers. Asynchronous: the
   *  request is queued, so callers poll `getApplication().status` for
   *  `exited`. `docker_cleanup=false` keeps the images, so starting the
   *  app again (a rollback) doesn't have to re-pull anything. */
  async stopApplication(uuid: string): Promise<void> {
    await this.request("GET", `/applications/${uuid}/stop?docker_cleanup=false`);
  }

  /** Delete an application WITHOUT touching its volumes. Coolify's
   *  DELETE defaults `delete_volumes` to true; an app being retired after
   *  a migration may still hold data somebody wants, so this spells the
   *  safe value out. */
  async deleteApplicationKeepingVolumes(uuid: string): Promise<"deleted" | "not-found"> {
    return this.delete(
      `/applications/${uuid}?delete_volumes=false&delete_connected_networks=false&delete_configurations=true&docker_cleanup=true`,
    );
  }

  /** Every project with its environments. Lets a caller holding only an
   *  application's `environment_id` find the project + environment uuids
   *  a sibling application has to be created in. */
  async listProjectsWithEnvironments(): Promise<
    Array<{
      uuid: string;
      name: string;
      environments: Array<{ id: number; uuid?: string; name: string }>;
    }>
  > {
    const projects = (await this.request("GET", "/projects")) as Array<{
      uuid?: string;
      name: string;
    }>;
    const out: Array<{
      uuid: string;
      name: string;
      environments: Array<{ id: number; uuid?: string; name: string }>;
    }> = [];
    for (const p of projects) {
      if (!p.uuid) continue;
      const detail = (await this.request("GET", `/projects/${p.uuid}`)) as {
        environments?: Array<{ id?: number; uuid?: string; name?: string }>;
      };
      out.push({
        uuid: p.uuid,
        name: p.name,
        environments: (detail.environments ?? [])
          .filter((e) => typeof e.id === "number" && typeof e.name === "string")
          .map((e) => ({ id: e.id as number, uuid: e.uuid, name: e.name as string })),
      });
    }
    return out;
  }

  /** Env rows with the flags a faithful copy needs. Same secrecy rule as
   *  {@link listAppEnvs}: values are production secrets — never print,
   *  log or persist one. */
  async listAppEnvRowsDetailed(uuid: string): Promise<
    Array<{
      key: string;
      value: string | undefined;
      isPreview: boolean;
      isLiteral: boolean;
      isMultiline: boolean;
    }>
  > {
    const raw = await this.request<unknown>("GET", `/applications/${uuid}/envs`);
    const rows = Array.isArray(raw) ? raw : [];
    const out: Array<{
      key: string;
      value: string | undefined;
      isPreview: boolean;
      isLiteral: boolean;
      isMultiline: boolean;
    }> = [];
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      const e = r as Record<string, unknown>;
      if (typeof e.key !== "string") continue;
      out.push({
        key: e.key,
        value: typeof e.value === "string" ? e.value : e.value === null ? "" : undefined,
        isPreview: e.is_preview === true || e.is_preview === 1,
        isLiteral: e.is_literal === true || e.is_literal === 1,
        isMultiline: e.is_multiline === true || e.is_multiline === 1,
      });
    }
    return out;
  }

  /** Upsert production env rows keeping each row's literal/multiline
   *  flags — the copy half of {@link listAppEnvRowsDetailed}. */
  async setAppEnvRows(
    appUuid: string,
    rows: Array<{ key: string; value: string; isLiteral: boolean; isMultiline: boolean }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.request("PATCH", `/applications/${appUuid}/envs/bulk`, {
      data: rows.map((r) => ({
        key: r.key,
        value: r.value,
        is_preview: false,
        is_literal: r.isLiteral,
        is_multiline: r.isMultiline,
      })),
    });
  }

  /** Read an application's environment variables.
   *
   *  Values are PRODUCTION SECRETS. The only in-tree consumer is
   *  `deploy/coolify-db-network.ts`, which answers "does this app point
   *  at a Coolify-managed database?" and returns keys and hostnames
   *  only. Anything else reading this must not print, log or persist a
   *  value. */
  async listAppEnvs(uuid: string): Promise<Array<{ key: string; value: string }>> {
    const rows = await this.listAppEnvRows(uuid);
    return rows.map((r) => ({ key: r.key, value: r.value ?? "" }));
  }

  /** Read an application's environment variables, keeping the two facts
   *  `listAppEnvs` flattens away:
   *
   *    · `isPreview` — GET /envs returns production AND preview rows in
   *      one list, and the same key can appear in both.
   *    · `value: undefined` — Coolify strips `value` from every row when
   *      the token lacks `read:sensitive` (`removeSensitiveData` in
   *      ApplicationsController, verified at v4.0.0-beta.469). That is
   *      NOT an empty value, and a caller that merges into the live value
   *      must refuse to write rather than treat it as one.
   *
   *  Same secrecy rule as `listAppEnvs`: never print a value. */
  async listAppEnvRows(
    uuid: string,
  ): Promise<Array<{ key: string; value: string | undefined; isPreview: boolean }>> {
    const raw = await this.request<unknown>("GET", `/applications/${uuid}/envs`);
    const rows = Array.isArray(raw) ? raw : [];
    const out: Array<{ key: string; value: string | undefined; isPreview: boolean }> = [];
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      const e = r as Record<string, unknown>;
      if (typeof e.key !== "string") continue;
      out.push({
        key: e.key,
        value: typeof e.value === "string" ? e.value : e.value === null ? "" : undefined,
        isPreview: e.is_preview === true || e.is_preview === 1,
      });
    }
    return out;
  }

  /** Names of an application's PRODUCTION env variables. Values are
   *  dropped inside this method: `GET /envs` inlines them, and callers
   *  that only need to know WHICH keys an app holds (secrets rotate's
   *  consumer discovery) must never keep a value around. */
  async listAppEnvKeys(uuid: string): Promise<string[]> {
    const rows = await this.listAppEnvRows(uuid);
    return [...new Set(rows.filter((r) => !r.isPreview).map((r) => r.key))];
  }

  /** Create ONE production env variable. `POST /applications/{uuid}/envs`
   *  creates and answers 409 once the key exists; `setAppEnv`'s bulk
   *  PATCH upserts on every build hatchkit supports. This exists for the
   *  callers that confirm a write by reading it back and must have a
   *  second, explicit way to make a missing key exist. */
  async createAppEnv(uuid: string, key: string, value: string): Promise<void> {
    await this.request("POST", `/applications/${uuid}/envs`, {
      key,
      value,
      is_preview: false,
      is_literal: true,
    });
  }

  /** Trigger a deploy of an existing application. Useful after we've
   *  set env vars post-creation.
   *
   *  Returns the queued deployment's uuid when Coolify reports one.
   *  Worth carrying: the deployment record is the only place that names
   *  the commit the deploy actually cloned, and the trailing git error
   *  in a failed deployment's log is routinely not the cause of the
   *  failure (see deploy/deployed-ref.ts). */
  async deployApplication(uuid: string): Promise<{ deploymentUuid?: string }> {
    const raw = (await this.request("POST", `/applications/${uuid}/start`)) as
      | Record<string, unknown>
      | undefined;
    const deploymentUuid =
      typeof raw?.deployment_uuid === "string"
        ? raw.deployment_uuid
        : typeof raw?.uuid === "string"
          ? raw.uuid
          : undefined;
    return { ...(deploymentUuid ? { deploymentUuid } : {}) };
  }

  /** Read one deployment record. The fields that matter for diagnosis
   *  are `commit` and `commit_message` — what Coolify actually cloned,
   *  as opposed to what the caller assumed it would.
   *
   *  Best-effort by design: this Coolify build's `/deployments` lists
   *  only what is currently running, and a finished deployment can 404,
   *  so callers get `null` rather than an exception. */
  async getDeployment(deploymentUuid: string): Promise<CoolifyDeployment | null> {
    try {
      const raw = (await this.request("GET", `/deployments/${deploymentUuid}`)) as Record<
        string,
        unknown
      >;
      return {
        uuid: typeof raw.deployment_uuid === "string" ? raw.deployment_uuid : deploymentUuid,
        status: typeof raw.status === "string" ? raw.status : undefined,
        commit: typeof raw.commit === "string" ? raw.commit : undefined,
        commitMessage: typeof raw.commit_message === "string" ? raw.commit_message : undefined,
        applicationName:
          typeof raw.application_name === "string" ? raw.application_name : undefined,
      };
    } catch {
      return null;
    }
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
  buildPack?: "nixpacks" | "static" | "dockerfile" | "dockercompose" | "dockerimage";
  /** Comma-joined FQDN string Coolify exposes for non-dockercompose
   *  apps (and as a denormalized cache for dockercompose apps on some
   *  builds). Null when no domains are attached. */
  fqdn: string | null;
  /** Per-service routing for dockercompose apps. Undefined when the
   *  app isn't dockercompose or no per-service domains are set. */
  dockerComposeDomains?: Array<{ name: string; domain: string }>;
  /** `ports_exposes` as Coolify stores it (comma-separated). Coolify
   *  returns this as a number on some builds; normalised to string. */
  portsExposes?: string;
  /** Coolify's `is_stripprefix_enabled` app setting. See the field of
   *  the same name on {@link CoolifyApi.updateApplication}. */
  isStripprefixEnabled?: boolean;
  /** Linked git source — surfaced for read-only inventory/drift checks
   *  that need to compare what Coolify thinks the app deploys from
   *  against the local `git remote`. Both fields are best-effort; old
   *  Coolify builds may not set them, and self-hosted setups may store
   *  the URL in a non-standard shape. */
  gitRepository?: string;
  gitBranch?: string;
  /** Commit the app is pinned to, or the literal `"HEAD"` (Coolify's
   *  way of saying "track the branch tip"). `pinnedCommitOf` in
   *  deploy/deployed-ref.ts turns this into a real sha or `undefined`
   *  — never read it as a commit without that. */
  gitCommitSha?: string;
  /** `docker_compose_location` — the compose file this app builds from,
   *  resolved INSIDE `baseDirectory`. Surfaced so a preflight can check
   *  the value Coolify actually holds rather than the one the manifest
   *  implies; a dashboard edit is exactly how those two diverge. */
  dockerComposeLocation?: string;
  /** UUID of the linked Coolify server (the box this app deploys to).
   *  Lets inventory resolve the server's IP via `getServerDomains` and
   *  compare against the DNS A record for `fqdn`. */
  serverUuid?: string;
  /** Coolify's git-webhook auto-deploy flag. Undefined when the API
   *  doesn't surface it (older Coolify builds). Build-pipeline projects
   *  expect this to be `false` so GHA owns the deploy trigger; doctor's
   *  check surfaces the mismatch. */
  isAutoDeployEnabled?: boolean;
  /** Coolify's `base_directory` for this app — the repo-relative path
   *  Coolify uses as the build context. Reported with a leading slash
   *  (`/site`, `/apps/web`) or `"/"` for the repo-root default. Used
   *  by `hatchkit sync` to diff against the manifest's `projectSubdir`. */
  baseDirectory?: string;
  /** Coolify's own status string, e.g. `running:healthy`,
   *  `exited:unhealthy`. Read it with suspicion: a container that
   *  crash-loops on startup is still reported as `running:healthy`,
   *  which is most of why the missing-docker-network bug survived
   *  months of looking at dashboards. */
  status?: string;
  /** How many times Coolify has restarted this app's container.
   *  Together with `lastRestartType` this is the ONLY signal in the
   *  API record that separates a healthy app from a crash loop. */
  restartCount?: number;
  /** Why the last restart happened — `"crash"` is the one that matters.
   *  A redeploy or a manual restart sets something else, so
   *  `restartCount > 0` on its own is not evidence of a fault. */
  lastRestartType?: string;
  /** `docker_registry_image_name` — set on `dockerimage` apps. */
  dockerRegistryImageName?: string;
  /** `docker_registry_image_tag` — the tag Coolify will pull on the next
   *  deploy. On an image-runtime app the deploy job pins it to the
   *  commit sha, so it doubles as "which build is live". */
  dockerRegistryImageTag?: string;
  /** Whether Coolify runs a health check, where, and how often.
   *  `enabled` decides if a deploy is a rolling update; the timing
   *  decides if the old container can drain — see
   *  deploy/image-runtime.ts `rollingUpdateBlocker`,
   *  `healthCheckToConverge`. */
  healthCheck: LiveHealthCheck;
  /** `ports_mappings` (host:container). Non-empty blocks rolling
   *  updates. */
  portsMappings: string | null;
  /** `custom_docker_run_options`. An `--ip` in here blocks rolling
   *  updates. */
  customDockerRunOptions: string | null;
  /** Coolify's numeric environment id — the only pointer from an
   *  application back to its project on this API. */
  environmentId?: number;
}

/** One application's compose source, as `listComposeSources` reads it. */
export interface CoolifyComposeSource {
  uuid: string;
  name: string;
  /** Raw `build_pack` — includes values `CoolifyApplication` doesn't
   *  model, like `dockerimage`. */
  buildPack?: string;
  gitRepository?: string;
  gitBranch?: string;
  baseDirectory?: string;
  dockerComposeLocation?: string;
  /** The compose file Coolify last loaded from the repo. `null` for an
   *  app that has never deployed (Coolify fills it at deploy time);
   *  `undefined` when the response leaves the field out. */
  dockerComposeRaw?: string | null;
}

/** One Coolify deployment record, trimmed to the fields that answer
 *  "what did this deploy actually build?". */
export interface CoolifyDeployment {
  uuid: string;
  status?: string;
  /** The commit Coolify cloned. */
  commit?: string;
  commitMessage?: string;
  applicationName?: string;
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
  /** Coolify's `force_domain_override`: take the domain even when it is
   *  still claimed by another resource, instead of 409ing.
   *
   *  We send it on create as well as update, but be precise about what
   *  that buys — verified against Coolify 4.0.0-beta.469:
   *
   *    · PATCH `/applications/{uuid}`   — honoured. The conflict checks
   *      run before `removeUnnecessaryFieldsFromRequest`.
   *    · POST create, flat `domains`    — honoured. The check lives in
   *      `validateDataApplications`, also called before the strip.
   *    · POST create, `docker_compose_domains` — IGNORED, upstream bug.
   *      `removeUnnecessaryFieldsFromRequest` unsets the field
   *      (`bootstrap/helpers/api.php`), and the compose-domain conflict
   *      check reads `$request->boolean('force_domain_override')` only
   *      AFTER that call — so it always reads false and 409s anyway,
   *      with an error telling you to pass the flag you just passed.
   *
   *  Every hatchkit app is `dockercompose`, so in practice the create
   *  path always lands in the broken case. We keep sending it because
   *  the field is in Coolify's create `$allowedFields`, the omission
   *  would be wrong the day upstream reorders those two lines, and it
   *  costs one boolean. Callers must NOT tell users that `--force`
   *  rescues a create — see deploy/sync.ts. */
  forceDomainOverride?: boolean;
  /** Repo-relative path to the compose file when buildPack is
   *  `dockercompose`. Defaults to `/docker-compose.yml`. */
  dockerComposeLocation?: string;
  /** Repo-relative build context root Coolify clones the app at. Set
   *  to `"site"` / `"apps/web"` / etc. to point Coolify at a subfolder
   *  of a larger repo (CLI repo with marketing site, monorepo). Leave
   *  unset for the historical single-package-at-root layout. The API
   *  client posix-normalizes the value (forward slashes, leading
   *  slash) before sending. */
  baseDirectory?: string;
}

/** Is this `/github-apps` entry Coolify's built-in anonymous
 *  github.com source rather than a real GitHub App?
 *
 *  Every Coolify install ships a seeded source named "Public GitHub"
 *  with `is_public: true`, `html_url: https://github.com` and no
 *  app_id/installation_id. It exists so the UI can offer public-repo
 *  clones over HTTPS — it cannot clone a private repo, and passing its
 *  uuid to `POST /applications/private-github-app` makes Coolify blow
 *  up with a bare `500 Internal Server Error`. Filtering it out of the
 *  source list turns that 500 into hatchkit's existing "install a
 *  GitHub App" guidance, and stops `doctor` from reporting a usable
 *  App source when there is none.
 *
 *  Deliberately conservative: a real App is only excluded if Coolify
 *  explicitly flags it public or its URL is the bare github.com origin.
 *  Builds that expose neither field keep every source, so the worst
 *  case stays today's behaviour instead of an empty list. */
export function isPublicGithubSource(app: {
  name?: string;
  html_url?: string;
  api_url?: string;
  is_public?: boolean;
}): boolean {
  if (app.is_public === true) return true;
  const url = app.html_url || app.api_url;
  if (!url) return false;
  try {
    // A GitHub App source always carries an `/apps/<slug>` path (on
    // github.com or a GHE host). A bare origin is the seeded source.
    return new URL(url).pathname.replace(/\/+$/, "") === "";
  } catch {
    return false;
  }
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

/** Read a counter Coolify may return as a number or as a numeric
 *  string. Anything that isn't a finite non-negative number becomes
 *  `undefined` — "the API didn't say" has to stay distinguishable from
 *  "it said zero", because only the latter is evidence of health. */
function coerceCount(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return undefined;
}

/** Verify Coolify connection. Returns version string or throws. */
export async function verifyCoolify(url: string, token: string): Promise<string> {
  const api = new CoolifyApi({ url, token });
  return api.getVersion();
}

/** Normalise Coolify's `docker_compose_domains` into the flat
 *  `Array<{ name, domain }>` hatchkit works with.
 *
 *  Coolify's on-the-wire shape has changed across versions and is NOT
 *  the shape it accepts on write:
 *    · a JSON-encoded STRING holding a MAP keyed by service name —
 *      `{"client":{"domain":"https://x"},"server":{"domain":"https://x/api"}}`
 *      — which is what 4.0.0-beta.469 stores and returns;
 *    · the same map already parsed into an object;
 *    · an array of `{ name, domain }` on older builds;
 *    · null / absent when no routing is configured.
 *
 *  The map form is the one that mattered: the previous reader only
 *  understood arrays, so it returned undefined for every real app.
 *  `hatchkit sync` therefore saw "Coolify has no domains", reported
 *  every app as out-of-sync, and its before/after diff was fiction.
 *
 *  A service's value may itself carry several comma-joined FQDNs; those
 *  are split back out into one entry per FQDN so callers can compare
 *  domain-by-domain. `collapseComposeDomains` is the inverse.
 */
export function parseDockerComposeDomains(
  raw: unknown,
): Array<{ name: string; domain: string }> | undefined {
  let value = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;

  const out: Array<{ name: string; domain: string }> = [];
  const push = (name: unknown, domain: unknown): void => {
    if (typeof name !== "string" || typeof domain !== "string") return;
    for (const d of splitDomainString(domain)) out.push({ name, domain: d });
  };

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      push(e.name, e.domain);
    }
  } else {
    for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === "string") {
        push(name, entry);
      } else if (entry && typeof entry === "object") {
        push(name, (entry as Record<string, unknown>).domain);
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Normalize a `base_directory` value for the Coolify API. Coolify
 *  stores the field as a leading-slash posix path (`/site`, `/apps/web`)
 *  or `/` for the repo root. Empty / `.` / `./` inputs all map to `/`
 *  so callers can reset an app back to the root by passing the empty
 *  string. Backslashes (Windows-style inputs) get rewritten to forward
 *  slashes; trailing slashes are stripped. */
export function normalizeCoolifyBaseDirectory(raw: string): string {
  const cleaned = raw
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (cleaned === "" || cleaned === ".") return "/";
  if (cleaned.startsWith("/")) return cleaned;
  return `/${cleaned}`;
}
