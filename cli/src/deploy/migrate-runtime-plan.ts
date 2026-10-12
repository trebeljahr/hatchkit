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
 *     The one exception is asked for by name: `--carry-volume
 *     <service>=<volume>` mounts the SAME Docker volume on the
 *     replacement (see "Carrying a named volume" below).
 *   · host port mappings, `build:`, `command:`/`entrypoint:`: an image
 *     app can't express them.
 *   · a service with no hostname, or one service addressing another by
 *     its compose name (`http://server:3000`): that hostname only exists
 *     on the compose network, which the split removes.
 *
 * ---------------------------------------------------------------------
 * Carrying a named volume
 * ---------------------------------------------------------------------
 *
 * An app that keeps its state in a file (SQLite) has no managed database
 * to move to. Its volume can follow the replacement because Coolify
 * mounts an image app's storage by NAME: a storage row named after an
 * existing Docker volume mounts that volume (`ApplicationDeploymentJob::
 * generate_local_persistent_volumes`, `host_path ?? name`). No data is
 * copied.
 *
 * Coolify names a compose app's volume `<app uuid>_<slug of the compose
 * name>` (`parsers.php`, `applicationParser`) and records it as a storage
 * of that app. The plan derives the name the same way and then requires
 * Coolify's own record to agree — a wrong name would not fail, it would
 * mount a new, empty volume.
 *
 * The cost is stated in the plan, not hidden: from the first deploy of
 * the replacement until the compose app stops, and again for the overlap
 * of every later rolling deploy, TWO containers have the volume mounted
 * read-write. That is only safe for an app built for it.
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
  /** The volumes Coolify recorded for this app (`GET …/storages`). Only
   *  read when a volume is carried, and then required: it is what
   *  confirms the derived Docker volume name. */
  persistentStorages?: Array<{ name: string; mountPath: string }>;
}

/** A compose named volume the replacement mounts by its Docker name. */
export interface CarriedVolume {
  /** Name in the compose file (`auth-data`). */
  volume: string;
  /** Name on the Docker host (`<compose app uuid>_auth-data`). */
  dockerVolume: string;
  mountPath: string;
}

/** One `--same-json` comparison: this field of this public URL must have
 *  the same value on the replacement before any traffic moves. */
export interface SameJsonCheck {
  path: string;
  /** Dot-separated path into the JSON body (`databaseId`, `db.id`). */
  field: string;
  publicUrl: string;
}

export interface PlannedImageApp {
  service: string;
  appName: string;
  role: "app" | "client" | "server";
  /** Tag the replacement is created with — the build that is live. */
  image: ImageRef;
  /** Original Compose image when an explicit replacement digest is requested. */
  sourceImage?: ImageRef;
  /** Tag the app is left on once the cutover is done. */
  steadyTag: string;
  port: number;
  portSource: string;
  /** `https://host[/path]` routes, primary first. */
  domains: string[];
  healthCheck: HealthCheckSpec;
  /** Coolify `custom_docker_run_options` that carry the service's
   *  container hardening (only `--cap-drop=…` today). */
  dockerRunOptions?: string;
  /** Compose volumes mounted on the replacement by Docker volume name. */
  carriedVolumes?: CarriedVolume[];
  sameJson?: SameJsonCheck[];
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
 *  `${VAR-default}`, `${VAR:?error}`, `${VAR?error}`, `${VAR:+value}`,
 *  `${VAR+value}`, `$VAR`, `$$` → `$`. Unset with no default → "".
 *  Returns the names it could not resolve so a caller can tell a real
 *  empty value from a missing one, and separately the `:?`/`?` names
 *  compose itself would have refused to start without.
 *
 *  `:?` is not optional to support: left unmatched, the text
 *  `${SECRET:?must be set}` would be copied to the replacement as the
 *  secret's VALUE. */
export function interpolate(
  text: string,
  env: ReadonlyMap<string, string>,
): { value: string; missing: string[]; required: string[] } {
  const missing: string[] = [];
  const required: string[] = [];
  const value = text.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
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
      // The colon forms treat an empty value as unset.
      const set = op?.startsWith(":") ? has && current !== "" : has;
      if (op === ":-" || op === "-") return set ? current : (def ?? "");
      if (op === ":+" || op === "+") return set ? (def ?? "") : "";
      if (op === ":?" || op === "?") {
        if (!set) required.push(name);
        return set ? current : "";
      }
      if (!has) missing.push(name);
      return current;
    },
  );
  return { value, missing, required };
}

/** Laravel's `Str::slug($name, '-')`, which Coolify applies to a compose
 *  volume name before prefixing the app uuid: `_` becomes `-`, anything
 *  that is not a letter, digit, `-` or whitespace is dropped. */
export function coolifyVolumeSlug(name: string): string {
  return name
    .replace(/_+/g, "-")
    .replace(/@/g, "-at-")
    .toLowerCase()
    .replace(/[^-\p{L}\p{N}\s]+/gu, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The Docker volume Coolify created for a compose app's named volume. */
export function composeDockerVolumeName(appUuid: string, volume: string): string {
  return `${appUuid}_${coolifyVolumeSlug(volume)}`;
}

const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

interface ServiceMount {
  /** Set only for a plain named volume — the one shape that can be carried. */
  named?: string;
  target?: string;
  readOnly: boolean;
}

/** A service's `volumes:` in either compose syntax. Anything that is not
 *  a plain named volume (a bind mount, an anonymous volume, a mount with
 *  `volume:`/`bind:` options) comes back without `named`. */
function serviceMounts(raw: unknown): ServiceMount[] {
  if (!Array.isArray(raw)) return [{ readOnly: false }];
  return raw.map((entry): ServiceMount => {
    if (typeof entry === "string") {
      const [source, target, mode] = entry.split(":");
      if (target === undefined || !VOLUME_NAME.test(source)) return { readOnly: false };
      return { named: source, target, readOnly: (mode ?? "").split(",").includes("ro") };
    }
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      const plain = Object.keys(e).every((k) =>
        ["type", "source", "target", "read_only"].includes(k),
      );
      if (
        plain &&
        e.type === "volume" &&
        typeof e.source === "string" &&
        VOLUME_NAME.test(e.source) &&
        typeof e.target === "string"
      ) {
        return { named: e.source, target: e.target, readOnly: e.read_only === true };
      }
    }
    return { readOnly: false };
  });
}

const trimPath = (path: string): string => path.replace(/\/+$/, "") || "/";

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

/** Parse a reviewed replacement without accepting a moving tag or credentials. */
export function parseMigrationImageOverride(value: string): ImageRef {
  if (
    !/^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]+)?\/(?:[a-z0-9]+(?:[._-]+[a-z0-9]+)*\/)*[a-z0-9]+(?:[._-]+[a-z0-9]+)*)@sha256:[a-f0-9]{64}$/.test(
      value,
    )
  ) {
    throw new Error(
      "Migration image override must be a registry repository pinned by a lowercase sha256 digest.",
    );
  }
  return parseImageRef(value);
}

/** Build the migration plan for one live compose app. */
export function planRuntimeMigration(
  app: LiveComposeApp,
  envRows: EnvRow[],
  opts: {
    /** Override the health-check path per compose service. */
    healthPaths?: Record<string, string>;
    /** Replacement-only digest pins; never changes the legacy Compose image. */
    images?: Record<string, string>;
    /** Per service, the user the replacement image itself runs as
     *  (`uid:gid`), checked by the operator against the image config. A
     *  Docker Image app cannot set `user`; a compose `user` equal to this
     *  is preserved by the image instead. */
    imageUsers?: Record<string, string>;
    /** Services whose `security_opt: [no-new-privileges…]` may be dropped.
     *  Coolify cannot express it for an image app; the operator accepts
     *  the loss (e.g. after removing setuid/setgid files from the image). */
    dropNoNewPrivileges?: string[];
    /** Per service, the compose named volumes the replacement mounts by
     *  their Docker volume name instead of the move being refused. */
    carryVolumes?: Record<string, string[]>;
    /** Per service, JSON fields that must read the same on production and
     *  on the replacement before the cutover. */
    sameJson?: Record<string, Array<{ path: string; field: string }>>;
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

  for (const service of Object.keys(opts.images ?? {})) {
    if (!names.includes(service))
      blockers.push(`Image override names unknown service "${service}".`);
  }
  for (const [flag, services] of [
    ["--carry-volume", Object.keys(opts.carryVolumes ?? {})],
    ["--same-json", Object.keys(opts.sameJson ?? {})],
  ] as const) {
    for (const service of services) {
      if (!names.includes(service)) blockers.push(`${flag} names unknown service "${service}".`);
    }
  }
  const topLevelVolumes = (
    doc.volumes && typeof doc.volumes === "object" && !Array.isArray(doc.volumes) ? doc.volumes : {}
  ) as Record<string, unknown>;

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
    const image = typeof svc.image === "string" ? interpolate(svc.image, envMap).value : "";
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
    const wanted = opts.carryVolumes?.[service] ?? [];
    const carriedVolumes: CarriedVolume[] = [];
    const mounts =
      svc.volumes && (!Array.isArray(svc.volumes) || svc.volumes.length > 0)
        ? serviceMounts(svc.volumes)
        : [];
    const carried = (m: ServiceMount): boolean => m.named !== undefined && wanted.includes(m.named);
    const left = mounts.filter((m) => !carried(m));
    if (left.length > 0) {
      const carriable = [...new Set(left.flatMap((m) => (m.named ? [m.named] : [])))];
      blockers.push(
        `${where} mounts volumes (${JSON.stringify(svc.volumes)}). Whatever it writes there would not follow a replacement app.` +
          (carriable.length > 0
            ? ` If the app is built for two containers writing a volume at once, ${carriable.map((v) => `--carry-volume ${service}=${v}`).join(" ")} mounts the same Docker volume on the replacement.`
            : ""),
      );
    }
    for (const name of wanted) {
      if (!mounts.some((m) => m.named === name)) {
        blockers.push(
          `--carry-volume ${service}=${name}: ${where} mounts no named volume "${name}".`,
        );
      }
    }
    for (const mount of mounts.filter(carried)) {
      const name = mount.named as string;
      const target = mount.target ?? "";
      const dockerVolume = composeDockerVolumeName(app.uuid, name);
      const declared = topLevelVolumes[name];
      if (mount.readOnly) {
        blockers.push(
          `${where}: volume "${name}" is mounted read-only, which a Coolify storage cannot express.`,
        );
      } else if (!/^\/[A-Za-z0-9._/-]*$/.test(target)) {
        blockers.push(
          `${where}: volume "${name}" is mounted at \`${target}\`, not a plain absolute path.`,
        );
      } else if (declared && typeof declared === "object" && Object.keys(declared).length > 0) {
        // `external`, `name`, `driver`, `driver_opts`: the volume is not
        // (only) the one Coolify named after this app.
        blockers.push(
          `${where}: volume "${name}" sets ${Object.keys(declared).join(", ")} in the compose file, so its Docker volume is not simply ${dockerVolume}.`,
        );
      } else if (!app.persistentStorages) {
        blockers.push(
          `${where}: Coolify did not report this app's storages, so ${dockerVolume} cannot be confirmed as the Docker volume behind "${name}". Mounting a wrong name would start the replacement on an empty volume.`,
        );
      } else {
        const recorded = app.persistentStorages.find((s) => s.name === dockerVolume);
        if (!recorded) {
          blockers.push(
            `${where}: Coolify records no volume ${dockerVolume} for this app (it has: ${app.persistentStorages.map((s) => s.name).join(", ") || "none"}). Mounting a wrong name would start the replacement on an empty volume.`,
          );
        } else if (trimPath(recorded.mountPath) !== trimPath(target)) {
          blockers.push(
            `${where}: Coolify records ${dockerVolume} at ${recorded.mountPath}, the compose file mounts "${name}" at ${target}. Deploy the compose app once so both agree.`,
          );
        } else {
          carriedVolumes.push({ volume: name, dockerVolume, mountPath: trimPath(target) });
        }
      }
    }
    for (const v of carriedVolumes) {
      warnings.push(
        `${where}: Docker volume ${v.dockerVolume} (${v.mountPath}) is mounted on the replacement while the Compose container still has it. Two containers write it during verification, until the Compose app stops, and again for the overlap of every later rolling deploy. Carry it only if the app is built for that.`,
      );
    }
    if (carriedVolumes.length > 0 && !opts.sameJson?.[service]?.length) {
      warnings.push(
        `${where}: nothing compares the replacement's data with production's before the cutover. If the app reports an identity for its data, pass --same-json ${service}=/path:field.`,
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

    // These service settings are not copied into the replacement. A
    // healthy root page cannot prove that losing them is harmless.
    for (const field of [
      "configs",
      "secrets",
      "tmpfs",
      "devices",
      "network_mode",
      "networks",
      "extra_hosts",
      "dns",
      "working_dir",
      "stop_signal",
      "cap_add",
      "privileged",
      "links",
    ] as const) {
      const value = svc[field];
      if (
        value !== undefined &&
        value !== null &&
        value !== false &&
        !(Array.isArray(value) && value.length === 0)
      ) {
        blockers.push(
          `${where} uses \`${field}\`, which the replacement cannot preserve automatically.`,
        );
      }
    }
    // Container hardening. A Docker Image app cannot carry `user` or
    // `security_opt`, and dropping `cap_drop` silently would hand the
    // replacement every default capability back.
    if (svc.user !== undefined && svc.user !== null && svc.user !== "") {
      const expected = opts.imageUsers?.[service];
      if (expected === undefined || String(svc.user) !== expected) {
        blockers.push(
          `${where} uses \`user\`, which the replacement cannot preserve automatically. If the image itself runs as ${JSON.stringify(String(svc.user))}, confirm it from the image config and pass --image-user ${service}=${String(svc.user)}.`,
        );
      } else {
        warnings.push(
          `${where}: \`user: ${expected}\` is preserved by the image's own USER, not by Coolify. Check the running container's user after cutover.`,
        );
      }
    }
    const securityOpts = Array.isArray(svc.security_opt)
      ? svc.security_opt.map((o) => String(o))
      : svc.security_opt === undefined || svc.security_opt === null
        ? []
        : [String(svc.security_opt)];
    if (securityOpts.length > 0) {
      const onlyNoNewPrivileges = securityOpts.every((o) =>
        /^no-new-privileges(?::true|=true)?$/.test(o.trim()),
      );
      if (!onlyNoNewPrivileges || !opts.dropNoNewPrivileges?.includes(service)) {
        blockers.push(
          `${where} uses \`security_opt\`, which the replacement cannot preserve automatically.` +
            (onlyNoNewPrivileges
              ? ` Coolify cannot set no-new-privileges on an image app; remove setuid/setgid files from the image, then accept the loss with --drop-no-new-privileges ${service}.`
              : ""),
        );
      } else {
        warnings.push(
          `${where}: \`no-new-privileges\` is dropped (accepted with --drop-no-new-privileges).`,
        );
      }
    }
    let dockerRunOptions: string | undefined;
    if (svc.cap_drop !== undefined && svc.cap_drop !== null) {
      const caps = Array.isArray(svc.cap_drop)
        ? svc.cap_drop.map((c) => String(c))
        : [String(svc.cap_drop)];
      if (caps.length > 0 && caps.every((c) => /^[A-Z][A-Z_]*$/.test(c))) {
        dockerRunOptions = caps.map((c) => `--cap-drop=${c}`).join(" ");
      } else if (caps.length > 0) {
        blockers.push(`${where} uses a \`cap_drop\` value the replacement cannot reproduce.`);
      }
    }
    const envFiles = Array.isArray(svc.env_file)
      ? svc.env_file
      : svc.env_file === undefined
        ? []
        : [svc.env_file];
    if (envFiles.some((file) => file !== ".env")) {
      blockers.push(
        `${where} loads a custom env_file; its values are not available from the Coolify env rows.`,
      );
    }
    for (const label of labelEntries(svc.labels)) {
      if (/^traefik\.http\.routers\.[^.]+\.rule=/.test(label)) {
        const rule = label.slice(label.indexOf("=") + 1);
        // Only a disjunction of bare Host rules is reproduced below.
        // PathPrefix, auth constraints and negation must never widen to
        // an entire hostname during migration.
        if (!/^\s*Host\(`[^`]+`\)(?:\s*\|\|\s*Host\(`[^`]+`\))*\s*$/.test(rule)) {
          blockers.push(
            `${where} has a custom Traefik routing rule that cannot be preserved automatically.`,
          );
        }
      }
      if (/^traefik\.http\.(?:middlewares\.|routers\.[^.]+\.middlewares=)/.test(label)) {
        blockers.push(
          `${where} has custom Traefik middleware; preserve it explicitly before migrating.`,
        );
      }
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
    const sourceImage = parseImageRef(resolvedImage);
    let image = sourceImage;
    const override = opts.images?.[service];
    if (override !== undefined) {
      try {
        image = parseMigrationImageOverride(override);
      } catch {
        blockers.push(`${where}: replacement image must be pinned by a lowercase sha256 digest.`);
        continue;
      }
      if (image.name !== sourceImage.name) {
        blockers.push(`${where}: replacement image must use the existing repository.`);
        continue;
      }
      warnings.push(
        `${where}: replacement differs from the live Compose image. Keep old/new clients compatible and pin the legacy source commit and image before cutover; rollback redeploys that source.`,
      );
    }
    const steady = imageDefault(rawImage);
    const steadyTag =
      override !== undefined ? image.tag : steady ? parseImageRef(steady).tag : image.tag;

    // Env: every app row, then the service's own entries on top.
    const env = new Map<string, { value: string; isLiteral: boolean; isMultiline: boolean }>();
    for (const r of prodRows) {
      if (isComposeOnlyEnv(r.key)) continue;
      env.set(r.key, { value: r.value ?? "", isLiteral: r.isLiteral, isMultiline: r.isMultiline });
    }
    const unresolved = new Set<string>();
    const requiredUnset = new Set<string>();
    for (const [key, raw] of envEntries(svc.environment)) {
      if (raw === null) continue; // pass-through: the .env copy above already has it
      const { value, missing, required } = interpolate(raw, envMap);
      for (const m of missing) unresolved.add(m);
      for (const r of required) requiredUnset.add(r);
      env.set(key, { value, isLiteral: true, isMultiline: value.includes("\n") });
    }
    if (requiredUnset.size > 0) {
      blockers.push(
        `${where}: ${[...requiredUnset].join(", ")} is required by the compose file (\`\${VAR:?…}\`) but not set on the app. Compose would refuse to start it; the replacement would start with an empty value.`,
      );
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
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      blockers.push(`${where}: container port is outside the valid range 1–65535.`);
      continue;
    }
    if (port === undefined) {
      blockers.push(
        `${where}: can't tell which port the container listens on (no PORT env, no \`expose\`, no port in its domain).`,
      );
      continue;
    }

    const sameJson: SameJsonCheck[] = [];
    for (const check of opts.sameJson?.[service] ?? []) {
      const route = routes.find((d) => {
        const prefix = new URL(d).pathname.replace(/\/+$/, "");
        return !prefix || check.path === prefix || check.path.startsWith(`${prefix}/`);
      });
      if (!route) {
        blockers.push(
          `--same-json ${service}=${check.path}:${check.field}: no public route of ${where} covers ${check.path}.`,
        );
        continue;
      }
      sameJson.push({ ...check, publicUrl: `${new URL(route).origin}${check.path}` });
    }

    const role = roleFor(service, appServices.length);
    const healthPath = opts.healthPaths?.[service];
    planned.push({
      service,
      appName: appServices.length === 1 ? app.name : `${app.name}-${service}`,
      role,
      image,
      ...(override !== undefined ? { sourceImage } : {}),
      steadyTag,
      port,
      portSource,
      domains: routes,
      healthCheck: healthCheckFor(role === "server" ? "server" : "app", {
        ...(healthPath ? { path: healthPath } : {}),
      }),
      ...(dockerRunOptions ? { dockerRunOptions } : {}),
      ...(carriedVolumes.length > 0 ? { carriedVolumes } : {}),
      ...(sameJson.length > 0 ? { sameJson } : {}),
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
