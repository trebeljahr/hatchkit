/*
 * `hatchkit map` data model.
 *
 * Two layers:
 *
 *  - `FleetFacts`: what the collectors read, already stripped of
 *    addresses, account ids and resource UUIDs. Collectors join on those
 *    internally (a Coolify server to its Hetzner server by IPv4, a
 *    Terraform workspace to its server by id) and keep only names.
 *  - `FleetMap`: the plate. Nodes (places), components (the pieces
 *    marked on each place, each with a hatchkit tier), edges, projects,
 *    jobs and findings. `buildFleetMap` turns facts plus the operator's
 *    extras registry into this, without I/O, so tests can drive it.
 */

/**
 *  · `listed`  — `hatchkit overview` lists it
 *  · `made`    — hatchkit set it up (or keeps a record of it), but no
 *                hatchkit command lists it
 *  · `outside` — hatchkit neither made nor lists it; it comes from the
 *                extras registry or from discovery (launchd, tailnet)
 */
export type Tier = "listed" | "made" | "outside";
export const TIERS: readonly Tier[] = ["listed", "made", "outside"];

/** `public`: the internet side (GitHub, Cloudflare, outside APIs).
 *  `tailnet`: servers and devices behind the tailnet. */
export type Zone = "public" | "tailnet";

/** `platform` runs your code (GitHub, Cloudflare, Vercel); `world` is a
 *  third party you only talk to (APIs, stores, readers). */
export type NodeKind = "platform" | "world" | "server" | "device";

export type Health = "ok" | "warn" | "fail";

export interface MapItem {
  name: string;
  note?: string;
  tier?: Tier;
  health?: Health;
}

export interface MapComponent {
  /** Stable within its node, e.g. `coolify-apps`, `service:plausible`. */
  id: string;
  label: string;
  /** No tier: drawn without a marker and not counted (e.g. "readers"). */
  tier?: Tier;
  /** A known gap: drawn amber, not counted as a piece. */
  gap?: boolean;
  /** Muted line under the label. */
  note?: string;
  items?: MapItem[];
  /** Which collector (or `extras`) produced it. */
  source: string;
}

export interface MapNode {
  id: string;
  name: string;
  subtitle?: string;
  kind: NodeKind;
  zone: Zone;
  components: MapComponent[];
}

export interface MapEdge {
  from: string;
  to: string;
  label: string;
  /** Waits for a person: a push, a tag, a runner someone starts. Dashed. */
  manual?: boolean;
  /** Traffic goes both ways. */
  both?: boolean;
  source: string;
}

/** How hatchkit knows a project, strongest first. */
export type ProjectRelation =
  | "itself"
  | "starter" // `hatchkit create` scaffolded it (ledger has a scaffold step)
  | "adopted" // `hatchkit adopt` wrote its manifest
  | "manifest" // a .hatchkit.json in the repo, no ledger
  | "provisioned" // a ledger with provider steps only
  | "worker" // only a per-Worker deploy token
  | "coolify"; // only a Coolify project

export const RELATION_ORDER: readonly ProjectRelation[] = [
  "itself",
  "starter",
  "adopted",
  "manifest",
  "provisioned",
  "worker",
  "coolify",
];

export interface MapProject {
  name: string;
  group: string;
  blurb?: string;
  /** Where it ships: "Workers", "Coolify", "R2", plus extras' chips. */
  ships: string[];
  domains: string[];
  servers: string[];
  hatchkit?: ProjectRelation;
  lastCommit?: string;
  tier: Tier;
}

export interface MapJob {
  name: string;
  /** Node id it runs on. */
  node: string;
  /** Group heading, e.g. "This Mac · launchd". */
  where: string;
  when: string;
  what?: string;
  tier: Tier;
  health?: Health;
  detail?: string;
  source: string;
}

export interface MapFinding {
  title: string;
  detail: string;
  severity: "warn" | "info";
  source: string;
}

export interface MapSource {
  key: string;
  label: string;
  status: "ok" | "skip" | "error";
  detail?: string;
}

export interface MapStat {
  value: string;
  label: string;
}

export interface TierCounts {
  listed: number;
  made: number;
  outside: number;
  gaps: number;
}

export interface FleetMap {
  title: string;
  generatedAt: string;
  cliVersion: string;
  stats: MapStat[];
  tiers: TierCounts;
  nodes: MapNode[];
  edges: MapEdge[];
  projects: MapProject[];
  projectGroups: string[];
  jobs: MapJob[];
  findings: MapFinding[];
  sources: MapSource[];
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface CoolifyFacts {
  version?: string;
  servers: Array<{
    name: string;
    /** Hetzner server name when the collector matched it by address. */
    hetznerName?: string;
    coolifyHost: boolean;
    reachable?: boolean;
  }>;
  apps: Array<{
    name: string;
    server?: string;
    project?: string;
    status?: string;
    buildPack?: string;
    domains: string[];
    repo?: string;
  }>;
  databases: Array<{ name: string; type: string; server?: string; status?: string }>;
  services: Array<{ name: string; server?: string; status?: string; versions: string[] }>;
  projects: string[];
}

export interface HetznerFacts {
  servers: Array<{
    name: string;
    type: string;
    location?: string;
    status?: string;
    role?: string;
  }>;
}

export interface TerraformFacts {
  /** One per state file with managed resources; `server` is the Hetzner
   *  server name in it, when it holds one. */
  workspaces: Array<{ stack: string; name: string; server?: string; resources: number }>;
}

export interface CloudflareFacts {
  zones: string[];
  buckets: string[];
  workers: Array<{
    name: string;
    hasAssets: boolean;
    /** Cron expressions, empty when it has no scheduled handler. */
    crons: string[];
    /** `wrangler`, `api`, `terraform`, … as Cloudflare reports it. */
    deployedFrom?: string;
    hosts: string[];
  }>;
}

export interface BackupFacts {
  /** `r2`, `s3` or `other`, from the repository URL. */
  target: string;
  hosts: Array<{ name: string; server?: string; schedule?: string }>;
}

export interface HostTimer {
  unit: string;
  description?: string;
  when: string;
  active: boolean;
  failed?: boolean;
}

export type HostTimerFacts = Record<string, { timers: HostTimer[] } | { error: string }>;

export interface TailnetPeer {
  /** First label of the MagicDNS name; stable id for extras. */
  id: string;
  hostName: string;
  os?: string;
  online: boolean;
  tags: string[];
  exitNode: boolean;
}

export interface TailscaleFacts {
  self?: { id: string; hostName: string; os?: string };
  peers: TailnetPeer[];
  /** From the policy file, only with an API token. Selectors as written. */
  grants?: Array<{ src: string[]; dst: string[]; ports: string[] }>;
}

export interface LaunchdJob {
  label: string;
  when: string;
  program?: string;
  running: boolean;
  /** Last exit status launchd reports; undefined while never run. */
  lastExit?: number;
  loaded: boolean;
}

export interface LedgerFacts {
  name: string;
  kinds: string[];
}

export interface RepoFacts {
  name: string;
  lastCommit?: string;
  manifest?: {
    name: string;
    domain?: string;
    aliases?: string[];
    description?: string;
    deploymentMode?: string;
  };
  description?: string;
}

export interface GithubFacts {
  owners: string[];
  repos: number;
  private: number;
  archived: number;
}

export interface FleetFacts {
  generatedAt: string;
  cliVersion: string;
  local: { name: string; os: string };
  overview?: {
    /** Provider keys overview read successfully (`present` or `empty`). */
    present: string[];
    glitchtipProjects: number;
    crossReferenceWarnings: Array<{ headline: string; subjects: string[] }>;
  };
  /** Providers configured in hatchkit (keys from config, never values). */
  providers: string[];
  coolify?: CoolifyFacts;
  hetzner?: HetznerFacts;
  terraform?: TerraformFacts;
  cloudflare?: CloudflareFacts;
  deployTokens: Array<{ worker: string; repo: string }>;
  backups?: BackupFacts;
  hostTimers?: HostTimerFacts;
  tailscale?: TailscaleFacts;
  launchd?: LaunchdJob[];
  ledgers: LedgerFacts[];
  repos?: RepoFacts[];
  github?: GithubFacts;
  macRunner: boolean;
  sources: MapSource[];
}

export function countTiers(nodes: readonly MapNode[]): TierCounts {
  const out: TierCounts = { listed: 0, made: 0, outside: 0, gaps: 0 };
  for (const node of nodes) {
    for (const c of node.components) {
      if (c.gap) out.gaps++;
      else if (c.tier) out[c.tier]++;
    }
  }
  return out;
}
