/*
 * `hatchkit migrate-runtime` — the plan.
 *
 * PURE: reads a snapshot of one live Coolify `dockercompose` app (its
 * stored compose file, per-service domains and env rows) and returns the
 * Docker Image app(s) that would replace it, or the reasons it can't be
 * moved. No network, no fs, so `--dry-run` and the real run compute the
 * same thing and the whole decision table is testable.
 *
 * Why a compose app is replaced rather than converted in place: see
 * deploy/image-runtime.ts for why only image apps get rolling updates,
 * and deploy/migrate-runtime.ts for the side-by-side cutover.
 *
 * ---------------------------------------------------------------------
 * What the replacement has to reproduce
 * ---------------------------------------------------------------------
 *
 * Everything a compose service got from Coolify, now without a compose
 * file to carry it:
 *
 *   · image — the service's `image:` after interpolation against the
 *     app's env. For `${CLIENT_IMAGE:-ghcr.io/…:main}` that resolves to
 *     the sha the deploy job last pinned, so the replacement starts on
 *     exactly the build that is live. The `:-default`'s tag is kept as
 *     the STEADY tag the app is left on afterwards — a repo whose
 *     workflow predates the image runtime still pins an env var the
 *     image app never reads, and on a steady `:main` its next deploy
 *     still pulls the fresh build instead of re-running this one.
 *   · env — Coolify injects every app env var into every compose
 *     service (`env_file: .env`, parsers.php) and the service's own
 *     `environment:` wins over it. So: all production rows, then the
 *     service's entries resolved against them.
 *   · port — the port the process binds, which becomes `ports_exposes`
 *     and therefore the port Traefik forwards to. A compose app never
 *     needed that to be right (Coolify reads it off the compose); an
 *     image app does.
 *   · hostnames — the service's `docker_compose_domains` entry PLUS any
 *     `Host(…)` in hand-written Traefik labels. collection-of-beauty
 *     serves three hosts and names one in its Coolify domains; dropping
 *     the other two would be a silent outage on them.
 *
 * ---------------------------------------------------------------------
 * What blocks a move
 * ---------------------------------------------------------------------
 *
 *   · a datastore service (mongo, postgres, redis, …) or any volume: its
 *     data lives in THIS compose app's Docker volume and would not
 *     follow a replacement app. Move it to a Coolify-managed database
 *     first (`hatchkit add`), then migrate.
 *   · host port mappings, `build:`, `command:`/`entrypoint:`: an image
 *     app can't express them.
 *   · a service with no hostname, or one service addressing another by
 *     its compose name (`http://server:3000`): that hostname only exists
 *     on the compose network, which the split removes.
 */

import { parse } from "yaml";
import {
  type HealthCheckSpec,
  type ImageRef,
  healthCheckFor,
  parseImageRef,
} from "./image-runtime.js";
import { splitDomainString } from "./routing.js";

/** One env row as Coolify stores it. Values are production secrets —
 *  nothing in this module prints one. */
export interface EnvRow {
  key: string;
  value: string | undefined;
  isPreview: boolean;
  isLiteral: boolean;
  isMultiline: boolean;
}

export interface LiveComposeApp {
  uuid: string;
  name: string;
  buildPack?: string;
  /** `docker_compose_raw` — null when the app never deployed. */
  composeRaw: string | null;
  /** Parsed `docker_compose_domains`, one entry per FQDN. */
  composeDomains?: Array<{ name: string; domain: string }>;
}

export interface PlannedImageApp {
  service: string;
  appName: string;
  role: "app" | "client" | "server";
  /** Tag the replacement is created with — the build that is live. */
  image: ImageRef;
  /** Tag the app is left on once the cutover is done. */
  steadyTag: string;
  port: number;
  portSource: string;
  /** `https://host[/path]` routes, primary first. */
  domains: string[];
  healthCheck: HealthCheckSpec;
  /** Full env for the replacement. Secret values. */
  env: Array<{ key: string; value: string; isLiteral: boolean; isMultiline: boolean }>;
}

export interface RuntimeMigrationPlan {
  source: { uuid: string; name: string };
  /** Name the compose app is renamed to so the replacement can take
   *  its name. */
  legacyName: string;
  apps: PlannedImageApp[];
  blockers: string[];
  warnings: string[];
}

/** Images and service names that mean "this service holds data". */
const DATASTORE_IMAGE =
  /^(?:[\w.-]+\/)*(mongo|mongodb|postgres|postgresql|postgis|redis|valkey|keydb|mysql|mariadb|memcached|elasticsearch|opensearch|meilisearch|minio|rabbitmq|nats|clickhouse|timescaledb|couchdb|cassandra|neo4j)(?:[:@]|$)/i;
const DATASTORE_NAME =
  /^(mongo|mongodb|postgres|postgresql|db|database|redis|valkey|mysql|mariadb|minio|meilisearch|elasticsearch|rabbitmq|nats)$/i;

/** Env keys that only mean something to a compose app: Coolify's
 *  per-service magic, and the image pins its compose interpolates. */
function isComposeOnlyEnv(key: string): boolean {
  return (
    /^SERVICE_(FQDN|URL|NAME|USER|PASSWORD|PASSWORD64|BASE64)_/.test(key) ||
    /^(SERVER|CLIENT|APP)_IMAGE$/.test(key) ||
    key.startsWith("COOLIFY_")
  );
}

/** Compose-style interpolation: `${VAR}`, `${VAR:-default}`,
 *  `${VAR-default}`, `$VAR`, `$$` → `$`. Unset with no default → "".
 *  Returns the names it could not resolve so a caller can tell a real
 *  empty value from a missing one. */
export function interpolate(
  text: string,
  env: ReadonlyMap<string, string>,
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = text.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (
      match,
      braced: string | undefined,
      op: string | undefined,
      def: string | undefined,
      bare: string | undefined,
    ) => {
      if (match === "$$") return "$";
      const name = braced ?? bare ?? "";
      const has = env.has(name);
      const current = env.get(name) ?? "";
      if (op === ":-") return has && current !== "" ? current : (def ?? "");
      if (op === "-") return has ? current : (def ?? "");
      if (!has) missing.push(name);
      return current;
    },
  );
  return { value, missing };
}

/** The `:-default` of an `image:` like `${CLIENT_IMAGE:-ghcr.io/o/r:main}`,
 *  or the literal image. */
function imageDefault(raw: string): string | undefined {
  const m = raw.match(/^\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]+)\}$/);
  if (m) return m[1].trim();
  return raw.includes("$") ? undefined : raw.trim();
}

/** `environment:` in either compose shape, as `[key, value | null]`.
 *  `null` = pass-through (`- KEY` / `KEY:` with no value). */
function envEntries(raw: unknown): Array<[string, string | null]> {
  if (Array.isArray(raw)) {
    return raw.map((e) => {
      const s = String(e);
      const eq = s.indexOf("=");
      return eq < 0 ? [s.trim(), null] : [s.slice(0, eq).trim(), s.slice(eq + 1)];
    });
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([k, v]) => [
      k,
      v === null || v === undefined ? null : String(v),
    ]);
  }
  return [];
}

function labelEntries(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`);
  }
  return [];
}

/** Every `Host(`…`)` named by a Traefik router rule in the labels. */
export function hostsFromTraefikLabels(labels: string[]): string[] {
  const hosts: string[] = [];
  for (const label of labels) {
    if (!/^traefik\.http\.routers\.[^.]+\.rule=/.test(label)) continue;
    for (const m of label.matchAll(/Host\(`([^`]+)`\)/g)) {
      const h = m[1].trim().toLowerCase();
      if (h && !hosts.includes(h)) hosts.push(h);
    }
  }
  return hosts;
}

function roleFor(service: string, count: number): "app" | "client" | "server" {
  if (count === 1) return /^(server|api|backend)$/i.test(service) ? "server" : "app";
  return /^(server|api|backend)$/i.test(service) ? "server" : "client";
}

/** Build the migration plan for one live compose app. */
export function planRuntimeMigration(
  app: LiveComposeApp,
  envRows: EnvRow[],
  opts: {
    /** Override the health-check path per compose service. */
    healthPaths?: Record<string, string>;
  } = {},
): RuntimeMigrationPlan {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const legacyName = `${app.name}-legacy-compose`;
  const plan = (apps: PlannedImageApp[]): RuntimeMigrationPlan => ({
    source: { uuid: app.uuid, name: app.name },
    legacyName,
    apps,
    blockers,
    warnings,
  });

  if (app.buildPack !== "dockercompose") {
    blockers.push(
      `${app.name} is a ${app.buildPack ?? "unknown"} app, not Docker Compose — nothing to migrate.`,
    );
    return plan([]);
  }
  if (!app.composeRaw) {
    blockers.push(
      `${app.name} has never deployed successfully, so Coolify holds no compose file to read. Deploy it once, or recreate it as an image app.`,
    );
    return plan([]);
  }

  let doc: Record<string, unknown>;
  try {
    doc = (parse(app.composeRaw) ?? {}) as Record<string, unknown>;
  } catch (err) {
    blockers.push(`Coolify's stored compose file doesn't parse: ${(err as Error).message}`);
    return plan([]);
  }
  const services = (doc.services ?? {}) as Record<string, Record<string, unknown>>;
  const names = Object.keys(services);
  if (names.length === 0) {
    blockers.push("The compose file declares no services.");
    return plan([]);
  }

  // Production env, and whether we could read it at all.
  const prodRows = envRows.filter((r) => !r.isPreview);
  const unreadable = prodRows.filter((r) => r.value === undefined).map((r) => r.key);
  if (unreadable.length > 0) {
    blockers.push(
      `Coolify returned no value for ${unreadable.length} env var(s) (${unreadable.slice(0, 5).join(", ")}${unreadable.length > 5 ? ", …" : ""}). ` +
        "The API token needs the `read:sensitive` ability to copy them.",
    );
  }
  const envMap = new Map<string, string>();
  for (const r of prodRows) envMap.set(r.key, r.value ?? "");

  // Datastores and state first — they decide whether this is possible.
  const appServices: string[] = [];
  for (const name of names) {
    const svc = services[name];
    const image = typeof svc.image === "string" ? svc.image : "";
    if (DATASTORE_IMAGE.test(image) || DATASTORE_NAME.test(name)) {
      blockers.push(
        `service "${name}" (${image || "no image"}) is a datastore inside this compose app. Its data is in a Docker volume only this app mounts; ` +
          "a replacement app would start without it. Move it to a Coolify-managed database first (`hatchkit add <project> …`), point the app at it, then migrate.",
      );
      continue;
    }
    appServices.push(name);
  }

  const domainsByService = new Map<string, string[]>();
  for (const d of app.composeDomains ?? []) {
    const list = domainsByService.get(d.name) ?? [];
    for (const url of splitDomainString(d.domain)) if (!list.includes(url)) list.push(url);
    domainsByService.set(d.name, list);
  }

  const planned: PlannedImageApp[] = [];
  for (const service of appServices) {
    const svc = services[service];
    const where = `service "${service}"`;
    if (svc.volumes && (!Array.isArray(svc.volumes) || svc.volumes.length > 0)) {
      blockers.push(
        `${where} mounts volumes (${JSON.stringify(svc.volumes)}). Whatever it writes there would not follow a replacement app.`,
      );
    }
    if (svc.ports && (!Array.isArray(svc.ports) || svc.ports.length > 0)) {
      blockers.push(
        `${where} publishes host ports (${JSON.stringify(svc.ports)}). Two containers can't bind one host port, so Coolify never rolls such an app.`,
      );
    }
    if (svc.build !== undefined && typeof svc.image !== "string") {
      blockers.push(`${where} is built from source (\`build:\`), not pulled as an image.`);
    }
    if (svc.command !== undefined || svc.entrypoint !== undefined) {
      blockers.push(
        `${where} overrides the image's command/entrypoint, which a Docker Image app can't carry.`,
      );
    }

    // Image.
    const rawImage = typeof svc.image === "string" ? svc.image : "";
    const resolvedImage = interpolate(rawImage, envMap).value.trim();
    if (!resolvedImage) {
      blockers.push(`${where}: image \`${rawImage}\` resolves to nothing against the app's env.`);
      continue;
    }
    if (/OWNER\/REPO/.test(resolvedImage)) {
      blockers.push(
        `${where}: image \`${resolvedImage}\` still carries the starter's OWNER/REPO placeholder — this app has been running something else, or nothing.`,
      );
      continue;
    }
    const image = parseImageRef(resolvedImage);
    const steady = imageDefault(rawImage);
    const steadyTag = steady ? parseImageRef(steady).tag : image.tag;

    // Env: every app row, then the service's own entries on top.
    const env = new Map<string, { value: string; isLiteral: boolean; isMultiline: boolean }>();
    for (const r of prodRows) {
      if (isComposeOnlyEnv(r.key)) continue;
      env.set(r.key, { value: r.value ?? "", isLiteral: r.isLiteral, isMultiline: r.isMultiline });
    }
    const unresolved = new Set<string>();
    for (const [key, raw] of envEntries(svc.environment)) {
      if (raw === null) continue; // pass-through: the .env copy above already has it
      const { value, missing } = interpolate(raw, envMap);
      for (const m of missing) unresolved.add(m);
      env.set(key, { value, isLiteral: true, isMultiline: value.includes("\n") });
    }
    if (unresolved.size > 0) {
      warnings.push(
        `${where}: ${[...unresolved].join(", ")} referenced but not set on the app — resolved to "" exactly as compose would.`,
      );
    }

    // Port: the process's own PORT wins, then `expose`, then the port in
    // a routed URL, then what Coolify recorded.
    let port: number | undefined;
    let portSource = "";
    const portEnv = env.get("PORT")?.value;
    if (portEnv && /^\d+$/.test(portEnv.trim())) {
      port = Number(portEnv.trim());
      portSource = "the service's PORT env";
    }
    const expose = Array.isArray(svc.expose) ? svc.expose.map((e) => String(e)) : [];
    if (port === undefined && expose.length > 0 && /^\d+/.test(expose[0])) {
      port = Number.parseInt(expose[0], 10);
      portSource = "the service's `expose`";
    }

    // Hostnames: Coolify's routing for the service, then any Host() in
    // hand-written Traefik labels, deduped by host.
    const routes: string[] = [];
    const seenHosts = new Set<string>();
    const add = (url: string): void => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      if (parsed.port && port === undefined) {
        port = Number(parsed.port);
        portSource = "the port in its Coolify domain";
      }
      const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
      const key = `${parsed.hostname}${path}`;
      if (seenHosts.has(key)) return;
      seenHosts.add(key);
      routes.push(`https://${parsed.hostname}${path}`);
    };
    // Coolify keys `docker_compose_domains` by the service name with
    // `-` turned into `_` (`uptime-kuma` is stored as `uptime_kuma`).
    for (const url of domainsByService.get(service) ??
      domainsByService.get(service.replace(/-/g, "_")) ??
      []) {
      add(url);
    }
    const labelHosts = hostsFromTraefikLabels(labelEntries(svc.labels));
    for (const h of labelHosts) add(`https://${h}`);
    if (labelHosts.length > 0) {
      warnings.push(
        `${where} routes by hand-written Traefik labels (${labelHosts.join(", ")}). The replacement gets Coolify-generated routing for the same hosts — https + gzip, but no other custom middleware.`,
      );
    }
    if (routes.length === 0) {
      blockers.push(
        `${where} has no public hostname. A service reached only over the compose network can't be moved on its own.`,
      );
      continue;
    }
    if (port === undefined) {
      blockers.push(
        `${where}: can't tell which port the container listens on (no PORT env, no \`expose\`, no port in its domain).`,
      );
      continue;
    }

    const role = roleFor(service, appServices.length);
    const healthPath = opts.healthPaths?.[service];
    planned.push({
      service,
      appName: appServices.length === 1 ? app.name : `${app.name}-${service}`,
      role,
      image,
      steadyTag,
      port,
      portSource,
      domains: routes,
      healthCheck: healthCheckFor(role === "server" ? "server" : "app", {
        ...(healthPath ? { path: healthPath } : {}),
      }),
      env: [...env].map(([key, v]) => ({ key, ...v })),
    });
  }

  // A service addressing a sibling by compose hostname loses it in the
  // split: each image app is its own container on the shared network.
  if (appServices.length > 1) {
    for (const p of planned) {
      for (const other of appServices) {
        if (other === p.service) continue;
        const hit = p.env.find((e) => new RegExp(`://${other}(?:[:/]|$)`).test(e.value));
        if (hit) {
          blockers.push(
            `service "${p.service}" reaches "${other}" by its compose hostname (${hit.key}). That name only resolves on this app's compose network.`,
          );
        }
      }
    }
  }

  return plan(blockers.length > 0 ? [] : planned);
}

/** Which GitHub Actions secret names the deploy workflow reads this
 *  app's uuid from. A single compose app of a single-origin project is
 *  `COOLIFY_RESOURCE_UUID`; the halves of a split project are
 *  `COOLIFY_{CLIENT,SERVER}_RESOURCE_UUID`, recognised by the same
 *  suffixes routing accepts. */
export function deploySecretNameFor(appName: string): string {
  if (/-(client|frontend|web)$/.test(appName)) return "COOLIFY_CLIENT_RESOURCE_UUID";
  if (/-(server|backend|api)$/.test(appName)) return "COOLIFY_SERVER_RESOURCE_UUID";
  return "COOLIFY_RESOURCE_UUID";
}
