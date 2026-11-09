/*
 * The extras registry: pieces of a fleet hatchkit never made.
 *
 * A bot on its own box, a dashboard on the laptop, a notes vault, the
 * stores a game ships to. hatchkit cannot discover these, so the
 * operator keeps them in one YAML (or JSON) file outside any repo and
 * `hatchkit map` merges it into what it read live. Everything here is
 * tier `outside` unless the entry says otherwise.
 *
 * Location, first hit wins: `--extras <path>`, `$HATCHKIT_MAP_EXTRAS`,
 * `~/.config/hatchkit/map-extras.yaml`, `~/.config/hatchkit/map-extras.json`.
 * No file is fine: the map then shows only what hatchkit can read.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Health, NodeKind, Tier, Zone } from "./model.js";

export interface ExtrasComponent {
  label: string;
  /** `none` draws no marker and is not counted. Default `outside`. */
  tier?: Tier | "none";
  gap?: boolean;
  note?: string;
  items?: string[];
}

export interface ExtrasNode {
  /** Merges into the live node with this id or name (servers by name,
   *  `github`, `cloudflare`, `apis`, `local`, tailnet devices by their
   *  MagicDNS label). A new id adds a node. */
  id: string;
  name?: string;
  subtitle?: string;
  kind?: NodeKind;
  zone?: Zone;
  components?: ExtrasComponent[];
}

export interface ExtrasEdge {
  from: string;
  to: string;
  label: string;
  manual?: boolean;
  both?: boolean;
}

export interface ExtrasProject {
  name: string;
  group?: string;
  blurb?: string;
  ships?: string[];
  domains?: string[];
  server?: string;
  /** Other names the same project has in hatchkit's records: a ledger,
   *  a Coolify project, a Worker's repo. */
  aliases?: string[];
  tier?: Tier;
}

export interface ExtrasJob {
  name: string;
  node: string;
  where?: string;
  when: string;
  what?: string;
  tier?: Tier;
  health?: Health;
}

export interface MapExtras {
  title?: string;
  /** Display name for the machine running the command. */
  localName?: string;
  /** launchd label prefixes to list as jobs (hatchkit's own `com.hatchkit.`
   *  is always included). */
  launchdPrefixes?: string[];
  /** Folders whose git repos give projects a last-commit date and a
   *  manifest. One level deep. */
  projectRoots?: string[];
  /** GitHub owners whose repos are counted. Default: the `gh` user. */
  githubOwners?: string[];
  /** Node ids to leave off the map (e.g. a friend's shared device). */
  hide?: string[];
  /** Project group order. Groups not listed follow in first-seen order. */
  groups?: string[];
  nodes?: ExtrasNode[];
  edges?: ExtrasEdge[];
  projects?: ExtrasProject[];
  jobs?: ExtrasJob[];
  looseEnds?: Array<{ title: string; detail?: string }>;
  stats?: Array<{ value: string; label: string }>;
}

export const EXTRAS_ENV = "HATCHKIT_MAP_EXTRAS";

export function defaultExtrasPaths(home = homedir()): string[] {
  const dir = join(home, ".config", "hatchkit");
  return [join(dir, "map-extras.yaml"), join(dir, "map-extras.yml"), join(dir, "map-extras.json")];
}

export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return resolve(path);
}

/** The extras file to read, or null when none exists. An explicit path
 *  (flag or env) that does not exist is an error, not a silent skip. */
export function resolveExtrasPath(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string | null {
  const explicit = flag ?? env[EXTRAS_ENV];
  if (explicit) {
    const path = expandHome(explicit, home);
    if (!existsSync(path)) throw new Error(`map extras file not found: ${path}`);
    return path;
  }
  return defaultExtrasPaths(home).find((p) => existsSync(p)) ?? null;
}

export function loadExtras(path: string | null): MapExtras {
  if (!path) return {};
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`map extras ${path}: ${(err as Error).message.split("\n")[0]}`);
  }
  return validateExtras(raw ?? {}, path);
}

// ---------------------------------------------------------------------------
// Validation (hand-rolled: zod is a dev dependency only)
// ---------------------------------------------------------------------------

const TIER_VALUES = ["listed", "made", "outside"];
const KIND_VALUES = ["platform", "world", "server", "device"];
const ZONE_VALUES = ["public", "tailnet"];
const HEALTH_VALUES = ["ok", "warn", "fail"];

class ExtrasError extends Error {}

function fail(where: string, msg: string): never {
  throw new ExtrasError(`${where}: ${msg}`);
}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(where, "must be a mapping");
  return v as Record<string, unknown>;
}

function str(v: unknown, where: string, required = false): string | undefined {
  if (v === undefined || v === null) {
    if (required) fail(where, "is required");
    return undefined;
  }
  if (typeof v === "number") return String(v);
  if (typeof v !== "string" || (required && !v.trim())) fail(where, "must be text");
  return v as string;
}

function bool(v: unknown, where: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") fail(where, "must be true or false");
  return v as boolean;
}

function strList(v: unknown, where: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return [v];
  if (!Array.isArray(v)) fail(where, "must be a list");
  return (v as unknown[]).map((x, i) => str(x, `${where}[${i}]`, true) as string);
}

function oneOf<T extends string>(v: unknown, allowed: string[], where: string): T | undefined {
  const s = str(v, where);
  if (s === undefined) return undefined;
  if (!allowed.includes(s)) fail(where, `must be ${allowed.join(", ")}`);
  return s as T;
}

function list<T>(v: unknown, where: string, each: (x: unknown, w: string) => T): T[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) fail(where, "must be a list");
  return (v as unknown[]).map((x, i) => each(x, `${where}[${i}]`));
}

const KNOWN_KEYS = new Set([
  "title",
  "localName",
  "launchdPrefixes",
  "projectRoots",
  "githubOwners",
  "hide",
  "groups",
  "nodes",
  "edges",
  "projects",
  "jobs",
  "looseEnds",
  "stats",
]);

export function validateExtras(raw: unknown, file = "map extras"): MapExtras {
  try {
    const o = obj(raw, file);
    for (const key of Object.keys(o)) {
      if (!KNOWN_KEYS.has(key)) fail(`${file}.${key}`, "is not a known key");
    }
    const out: MapExtras = {
      title: str(o.title, `${file}.title`),
      localName: str(o.localName, `${file}.localName`),
      launchdPrefixes: strList(o.launchdPrefixes, `${file}.launchdPrefixes`),
      projectRoots: strList(o.projectRoots, `${file}.projectRoots`),
      githubOwners: strList(o.githubOwners, `${file}.githubOwners`),
      hide: strList(o.hide, `${file}.hide`),
      groups: strList(o.groups, `${file}.groups`),
      nodes: list(o.nodes, `${file}.nodes`, (x, w) => {
        const n = obj(x, w);
        return {
          id: str(n.id, `${w}.id`, true) as string,
          name: str(n.name, `${w}.name`),
          subtitle: str(n.subtitle, `${w}.subtitle`),
          kind: oneOf<NodeKind>(n.kind, KIND_VALUES, `${w}.kind`),
          zone: oneOf<Zone>(n.zone, ZONE_VALUES, `${w}.zone`),
          components: list(n.components, `${w}.components`, (cx, cw) => {
            if (typeof cx === "string") return { label: cx };
            const c = obj(cx, cw);
            return {
              label: str(c.label, `${cw}.label`, true) as string,
              tier: oneOf<Tier | "none">(c.tier, [...TIER_VALUES, "none"], `${cw}.tier`),
              gap: bool(c.gap, `${cw}.gap`),
              note: str(c.note, `${cw}.note`),
              items: strList(c.items, `${cw}.items`),
            };
          }),
        };
      }),
      edges: list(o.edges, `${file}.edges`, (x, w) => {
        const e = obj(x, w);
        return {
          from: str(e.from, `${w}.from`, true) as string,
          to: str(e.to, `${w}.to`, true) as string,
          label: str(e.label, `${w}.label`) ?? "",
          manual: bool(e.manual, `${w}.manual`),
          both: bool(e.both, `${w}.both`),
        };
      }),
      projects: list(o.projects, `${file}.projects`, (x, w) => {
        const p = obj(x, w);
        return {
          name: str(p.name, `${w}.name`, true) as string,
          group: str(p.group, `${w}.group`),
          blurb: str(p.blurb, `${w}.blurb`),
          ships: strList(p.ships, `${w}.ships`),
          domains: strList(p.domains ?? p.domain, `${w}.domains`),
          server: str(p.server, `${w}.server`),
          aliases: strList(p.aliases, `${w}.aliases`),
          tier: oneOf<Tier>(p.tier, TIER_VALUES, `${w}.tier`),
        };
      }),
      jobs: list(o.jobs, `${file}.jobs`, (x, w) => {
        const j = obj(x, w);
        return {
          name: str(j.name, `${w}.name`, true) as string,
          node: str(j.node, `${w}.node`, true) as string,
          where: str(j.where, `${w}.where`),
          when: str(j.when, `${w}.when`) ?? "",
          what: str(j.what, `${w}.what`),
          tier: oneOf<Tier>(j.tier, TIER_VALUES, `${w}.tier`),
          health: oneOf<Health>(j.health, HEALTH_VALUES, `${w}.health`),
        };
      }),
      looseEnds: list(o.looseEnds, `${file}.looseEnds`, (x, w) => {
        if (typeof x === "string") return { title: x };
        const l = obj(x, w);
        return {
          title: str(l.title, `${w}.title`, true) as string,
          detail: str(l.detail, `${w}.detail`),
        };
      }),
      stats: list(o.stats, `${file}.stats`, (x, w) => {
        const s = obj(x, w);
        return {
          value: str(s.value, `${w}.value`, true) as string,
          label: str(s.label, `${w}.label`, true) as string,
        };
      }),
    };
    return out;
  } catch (err) {
    if (err instanceof ExtrasError) throw new Error(`map extras: ${err.message}`);
    throw err;
  }
}
