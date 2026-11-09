/*
 * Facts + extras → the plate. Pure: no I/O, no clock, no environment.
 *
 * Tier rule, per component:
 *  · `listed`  when `hatchkit overview` reads that provider's resources
 *              (Coolify apps/projects/databases, Cloudflare zones, R2 and
 *              S3 buckets, GlitchTip, Stripe)
 *  · `made`    when hatchkit created it or keeps the record that it did
 *              (Workers with a hatchkit deploy token, Coolify services,
 *              Terraform workspaces, backup hosts, host timers, its own
 *              launchd job, the mac-runner)
 *  · `outside` for discovery that is not hatchkit's (launchd jobs, the
 *              tailnet) and everything from the extras registry
 */

import type { MapExtras } from "./extras.js";
import {
  type FleetFacts,
  type FleetMap,
  type Health,
  type MapComponent,
  type MapEdge,
  type MapFinding,
  type MapItem,
  type MapJob,
  type MapNode,
  type MapProject,
  type MapStat,
  type NodeKind,
  type ProjectRelation,
  RELATION_ORDER,
  type Tier,
  type Zone,
  countTiers,
} from "./model.js";
import { humanizeCron } from "./schedule.js";

export const LOCAL_ID = "local";
export const GITHUB_ID = "github";
export const CLOUDFLARE_ID = "cloudflare";
export const APIS_ID = "apis";

/** hatchkit's own launchd label prefix. */
export const HATCHKIT_LAUNCHD_PREFIX = "com.hatchkit.";

const SERVICE_NAMES: Record<string, string> = {
  glitchtip: "GlitchTip",
  plausible: "Plausible",
  "uptime-kuma": "Uptime Kuma",
  listmonk: "Listmonk",
  umami: "Umami",
  openpanel: "OpenPanel",
};

/** Coolify services `hatchkit overview` lists through their own provider. */
const SERVICE_LISTED_BY: Record<string, string> = { glitchtip: "glitchtip" };

/** Outside APIs a configured provider stands for, with its tier. */
const API_PROVIDERS: Array<{ key: string; label: string; tier: Tier }> = [
  { key: "stripe", label: "Stripe", tier: "listed" },
  { key: "ses", label: "AWS SES", tier: "made" },
  { key: "resend", label: "Resend", tier: "made" },
  { key: "googleSearchConsole", label: "Google Search Console", tier: "made" },
];

const DB_NAMES: Record<string, string> = {
  "standalone-mongodb": "MongoDB",
  "standalone-postgresql": "PostgreSQL",
  "standalone-redis": "Redis",
  "standalone-mysql": "MySQL",
  "standalone-mariadb": "MariaDB",
  "standalone-keydb": "KeyDB",
  "standalone-dragonfly": "Dragonfly",
  "standalone-clickhouse": "ClickHouse",
};

const lc = (s: string) => s.toLowerCase();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Coolify status `running:healthy` → ok, `exited`, `degraded` → warn/fail. */
export function coolifyHealth(status: string | undefined): Health | undefined {
  if (!status) return undefined;
  if (/^running(:healthy|:unknown)?$/.test(status)) return "ok";
  if (/^(exited|stopped)/.test(status)) return "fail";
  return "warn";
}

/** `foo-server`, `foo-client`, `foo-docs` → `foo`. */
export function projectStem(name: string): string {
  return name.replace(/-(server|client|backend|frontend|web|api|site|docs|play|worker)$/, "");
}

class NodeSet {
  readonly byId = new Map<string, MapNode>();
  readonly order: string[] = [];

  find(ref: string): MapNode | undefined {
    const direct = this.byId.get(ref);
    if (direct) return direct;
    const want = lc(ref);
    for (const node of this.byId.values()) {
      if (lc(node.id) === want || lc(node.name) === want) return node;
    }
    return undefined;
  }

  ensure(id: string, init: () => Omit<MapNode, "id" | "components">): MapNode {
    const found = this.find(id);
    if (found) return found;
    const node: MapNode = { id, components: [], ...init() };
    this.byId.set(id, node);
    this.order.push(id);
    return node;
  }

  add(nodeId: string, component: MapComponent): void {
    const node = this.find(nodeId);
    if (node) node.components.push(component);
  }
}

export function buildFleetMap(facts: FleetFacts, extras: MapExtras = {}): FleetMap {
  const nodes = new NodeSet();
  const edges: MapEdge[] = [];
  const jobs: MapJob[] = [];
  const findings: MapFinding[] = [];
  const localName = extras.localName ?? facts.local.name;
  const providers = new Set(facts.providers);
  const listedByOverview = new Set(facts.overview?.present ?? []);

  // -------------------------------------------------------------- nodes
  const platform =
    (name: string, kind: NodeKind = "platform") =>
    () => ({
      name,
      kind,
      zone: "public" as Zone,
    });
  const coolifyApps = facts.coolify?.apps ?? [];
  const githubRepos = new Set<string>();
  for (const t of facts.deployTokens) githubRepos.add(t.repo);
  for (const a of coolifyApps) if (a.repo) githubRepos.add(a.repo);
  if (facts.github || githubRepos.size > 0 || providers.has("github")) {
    nodes.ensure(GITHUB_ID, platform("GitHub"));
  }
  if (facts.cloudflare || providers.has("cloudflare") || providers.has("dns")) {
    nodes.ensure(CLOUDFLARE_ID, platform("Cloudflare"));
  }
  // Stripe keys live per project since 2026-11; a ledger's webhook step
  // is then the only local record that hatchkit wired Stripe.
  const stripeWebhooks = facts.ledgers.some((l) => l.kinds.includes("stripeWebhook"));
  const apiProviders = API_PROVIDERS.filter(
    (p) => providers.has(p.key) || (p.key === "stripe" && stripeWebhooks),
  ).map((p) =>
    p.tier === "listed" && !listedByOverview.has(p.key) ? { ...p, tier: "made" as Tier } : p,
  );
  if (apiProviders.length > 0) nodes.ensure(APIS_ID, platform("Outside APIs", "world"));

  nodes.ensure(LOCAL_ID, () => ({
    name: localName,
    subtitle: `${facts.local.os} · runs hatchkit`,
    kind: "device",
    zone: "tailnet",
  }));

  // Servers: union of every source that names one.
  const serverName = (name: string) => {
    const coolify = facts.coolify?.servers.find((s) => s.name === name);
    return coolify?.hetznerName ?? name;
  };
  const hetzner = new Map((facts.hetzner?.servers ?? []).map((s) => [lc(s.name), s]));
  const coolifyByNode = new Map<string, NonNullable<FleetFacts["coolify"]>["servers"][number]>();
  const serverIds: string[] = [];
  const addServer = (name: string) => {
    if (!serverIds.some((s) => lc(s) === lc(name))) serverIds.push(name);
  };
  for (const s of facts.coolify?.servers ?? []) {
    const id = s.hetznerName ?? s.name;
    addServer(id);
    coolifyByNode.set(lc(id), s);
  }
  for (const s of facts.hetzner?.servers ?? []) addServer(s.name);
  for (const w of facts.terraform?.workspaces ?? []) if (w.server) addServer(w.server);
  for (const h of facts.backups?.hosts ?? []) addServer(h.server ? serverName(h.server) : h.name);
  // The Coolify host first: it is what everything else hangs off.
  serverIds.sort((a, b) => {
    const ca = coolifyByNode.get(lc(a))?.coolifyHost ? 0 : 1;
    const cb = coolifyByNode.get(lc(b))?.coolifyHost ? 0 : 1;
    return ca - cb;
  });

  const peers = facts.tailscale?.peers ?? [];
  const peerFor = (name: string) =>
    peers.find((p) => lc(p.id) === lc(name) || lc(p.hostName) === lc(name));

  for (const id of serverIds) {
    const h = hetzner.get(lc(id));
    const c = coolifyByNode.get(lc(id));
    const peer = peerFor(id);
    const sub = [
      h?.type ? h.type.toUpperCase() : undefined,
      c?.coolifyHost ? "Coolify host" : c ? "Coolify server" : undefined,
      h?.role,
      peer?.tags.length ? peer.tags.join(" ") : undefined,
    ].filter(Boolean);
    nodes.ensure(id, () => ({
      name: id,
      subtitle: sub.join(" · ") || undefined,
      kind: "server",
      zone: "tailnet",
    }));
  }

  // Tailnet devices that are not servers and not this machine.
  const hidden = new Set((extras.hide ?? []).map(lc));
  for (const p of peers) {
    if (serverIds.some((s) => lc(s) === lc(p.id) || lc(s) === lc(p.hostName))) continue;
    if (hidden.has(lc(p.id)) || hidden.has(lc(p.hostName))) continue;
    nodes.ensure(p.id, () => ({
      name: p.hostName,
      subtitle: [p.os, p.online ? undefined : "offline", ...p.tags].filter(Boolean).join(" · "),
      kind: "device",
      zone: "tailnet",
    }));
  }

  // ------------------------------------------------------------- GitHub
  if (facts.github) {
    const g = facts.github;
    nodes.add(GITHUB_ID, {
      id: "repos",
      label: `${g.repos} repos · ${g.private} private`,
      tier: "outside",
      note: [g.owners.join(" + "), g.archived ? `${g.archived} archived` : ""]
        .filter(Boolean)
        .join(" · "),
      source: "github",
    });
  }
  if (githubRepos.size > 0) {
    nodes.add(GITHUB_ID, {
      id: "deploys",
      label: `Actions deploys · ${plural(githubRepos.size, "repo")}`,
      tier: "made",
      note: "deploy on push with hatchkit's tokens and hooks",
      items: [...githubRepos].sort().map((name) => ({ name })),
      source: "hatchkit-config",
    });
  }
  const imageApps = coolifyApps.filter((a) => a.buildPack === "dockerimage");
  if (providers.has("ghcr") && imageApps.length > 0) {
    nodes.add(GITHUB_ID, {
      id: "ghcr",
      label: `GHCR images · ${plural(imageApps.length, "app")}`,
      tier: "made",
      items: imageApps.map((a) => ({ name: a.name })),
      source: "coolify",
    });
  }

  // --------------------------------------------------------- Cloudflare
  const tokenWorkers = new Map(facts.deployTokens.map((t) => [t.worker, t.repo]));
  const workerTier = (w: { name: string; deployedFrom?: string }): Tier =>
    tokenWorkers.has(w.name) || w.name.startsWith("hatchkit-") || w.deployedFrom === "terraform"
      ? "made"
      : "outside";
  if (facts.cloudflare) {
    const cf = facts.cloudflare;
    nodes.add(CLOUDFLARE_ID, {
      id: "zones",
      label: plural(cf.zones.length, "zone"),
      tier: "listed",
      items: cf.zones.map((name) => ({ name })),
      source: "cloudflare",
    });
    if (cf.workers.length > 0) {
      const made = cf.workers.filter((w) => workerTier(w) === "made").length;
      const cron = cf.workers.filter((w) => w.crons.length > 0).length;
      nodes.add(CLOUDFLARE_ID, {
        id: "workers",
        label: plural(cf.workers.length, "Worker"),
        tier: made > 0 ? "made" : "outside",
        note: [`${made} through hatchkit`, cron ? `${cron} on cron` : ""]
          .filter(Boolean)
          .join(" · "),
        items: cf.workers.map((w) => ({
          name: w.name,
          tier: workerTier(w),
          note: [w.hasAssets ? "assets" : "script", w.crons.length ? "cron" : "", ...w.hosts]
            .filter(Boolean)
            .join(" · "),
        })),
        source: "cloudflare",
      });
    }
    nodes.add(CLOUDFLARE_ID, {
      id: "r2",
      label: plural(cf.buckets.length, "R2 bucket"),
      tier: "listed",
      items: cf.buckets.map((name) => ({ name })),
      source: "cloudflare",
    });
  }

  // ------------------------------------------------------- Outside APIs
  for (const p of apiProviders) {
    nodes.add(APIS_ID, { id: p.key, label: p.label, tier: p.tier, source: "hatchkit-config" });
  }

  // ------------------------------------------------------------ servers
  const tfByServer = new Map(
    (facts.terraform?.workspaces ?? [])
      .filter((w) => w.server)
      .map((w) => [lc(w.server as string), w]),
  );
  const backupByServer = new Map(
    (facts.backups?.hosts ?? []).map((h) => [lc(h.server ? serverName(h.server) : h.name), h]),
  );
  const nodeOfCoolifyServer = (name: string | undefined) => (name ? serverName(name) : undefined);

  for (const id of serverIds) {
    const c = coolifyByNode.get(lc(id));
    if (c?.coolifyHost) {
      nodes.add(id, {
        id: "coolify",
        label: `Coolify${facts.coolify?.version ? ` ${facts.coolify.version}` : ""} + Traefik`,
        tier: "listed",
        source: "coolify",
      });
    }
    if (c) {
      const apps = coolifyApps.filter((a) => lc(nodeOfCoolifyServer(a.server) ?? "") === lc(id));
      if (apps.length) {
        const sick = apps.filter((a) => coolifyHealth(a.status) !== "ok").length;
        nodes.add(id, {
          id: "apps",
          label: `${plural(apps.length, "app")} on Coolify`,
          tier: "listed",
          note: sick ? `${sick} not healthy` : undefined,
          items: apps.map((a) => ({
            name: a.name,
            note: a.status,
            health: coolifyHealth(a.status),
          })),
          source: "coolify",
        });
      }
      const dbs = (facts.coolify?.databases ?? []).filter(
        (d) => lc(nodeOfCoolifyServer(d.server) ?? "") === lc(id),
      );
      if (dbs.length) {
        const byType = new Map<string, number>();
        for (const d of dbs) {
          const t = DB_NAMES[d.type] ?? d.type.replace(/^standalone-/, "");
          byType.set(t, (byType.get(t) ?? 0) + 1);
        }
        nodes.add(id, {
          id: "databases",
          label: plural(dbs.length, "database"),
          tier: "listed",
          note: [...byType].map(([t, n]) => `${n} ${t}`).join(" · "),
          items: dbs.map((d) => ({
            name: d.name,
            note: d.status,
            health: coolifyHealth(d.status),
          })),
          source: "coolify",
        });
      }
      for (const s of (facts.coolify?.services ?? []).filter(
        (s) => lc(nodeOfCoolifyServer(s.server) ?? "") === lc(id),
      )) {
        const lister = SERVICE_LISTED_BY[s.name];
        const health = coolifyHealth(s.status);
        nodes.add(id, {
          id: `service:${s.name}`,
          label: `${SERVICE_NAMES[s.name] ?? s.name}${s.versions[0] ? ` ${s.versions[0]}` : ""}`,
          tier: lister && listedByOverview.has(lister) ? "listed" : "made",
          note: health === "ok" ? undefined : s.status,
          items: [{ name: s.name, note: s.status, health }],
          source: "coolify",
        });
      }
    }
    const tf = tfByServer.get(lc(id));
    if (tf) {
      nodes.add(id, {
        id: "terraform",
        label: "Terraform + hardening",
        tier: "made",
        note: `${tf.stack} workspace ${tf.name}`,
        source: "terraform",
      });
    }
    const backup = backupByServer.get(lc(id));
    if (backup) {
      nodes.add(id, {
        id: "backups",
        label: `restic backups ${backup.schedule ?? "16:00"} UTC`,
        tier: "made",
        note: facts.backups?.target === "r2" ? "to R2" : undefined,
        source: "backups",
      });
      const timers = facts.hostTimers?.[backup.name];
      if (timers && "timers" in timers) {
        const failed = timers.timers.filter((t) => t.failed).length;
        nodes.add(id, {
          id: "timers",
          label: `${plural(timers.timers.length, "hatchkit timer")}`,
          tier: "made",
          note: failed ? `${failed} failed` : "integrity, update watch, image scan, …",
          items: timers.timers.map((t) => ({
            name: t.unit,
            note: t.when,
            health: t.failed ? "fail" : t.active ? "ok" : "warn",
          })),
          source: "host-timers",
        });
        if (timers.timers.some((t) => t.unit === "hatchkit-tailnet-dns-check.timer")) {
          nodes.add(id, {
            id: "tailnet-dns",
            label: "tailnet-dns · split DNS",
            tier: "made",
            source: "host-timers",
          });
        }
      } else if (timers && "error" in timers) {
        nodes.add(id, {
          id: "timers",
          label: "hatchkit timers",
          tier: "made",
          note: `not read: ${timers.error}`,
          source: "host-timers",
        });
      }
    }
    const peer = peerFor(id);
    if (peer?.exitNode) {
      nodes.add(id, {
        id: "exit-node",
        label: "Tailscale exit node",
        tier: "outside",
        source: "tailscale",
      });
    }
    const isHetzner = hetzner.has(lc(id));
    if (isHetzner && facts.terraform && !tf) {
      nodes.add(id, {
        id: "gap:terraform",
        label: "not in Terraform",
        gap: true,
        source: "terraform",
      });
      findings.push({
        severity: "info",
        title: `${id} sits outside Terraform.`,
        detail: `No workspace of the hardened-vps stack holds it, so hatchkit cannot rebuild or plan it.`,
        source: "terraform",
      });
    }
    if (isHetzner && facts.backups && !backup) {
      nodes.add(id, {
        id: "gap:backups",
        label: "no hatchkit backups",
        gap: true,
        source: "backups",
      });
      findings.push({
        severity: "warn",
        title: `${id} has no hatchkit backups.`,
        detail: "No backup host is configured on it (`hatchkit backup hosts`).",
        source: "backups",
      });
    }
  }

  // --------------------------------------------------------- local node
  const launchd = facts.launchd ?? [];
  const launchdHealth = (j: (typeof launchd)[number]): Health =>
    !j.loaded ? "warn" : j.running || j.lastExit === undefined || j.lastExit === 0 ? "ok" : "fail";
  const prettyLabel = (label: string) => label.replace(/^(com|dev|org|net|io)\.[^.]+\./, "");
  for (const j of launchd.filter((j) => j.label.startsWith(HATCHKIT_LAUNCHD_PREFIX))) {
    nodes.add(LOCAL_ID, {
      id: `launchd:${j.label}`,
      label: prettyLabel(j.label),
      tier: "made",
      note: `launchd · ${j.when}`,
      items: [{ name: j.label, note: j.when, health: launchdHealth(j) }],
      source: "launchd",
    });
  }
  const userJobs = launchd.filter((j) => !j.label.startsWith(HATCHKIT_LAUNCHD_PREFIX));
  if (userJobs.length) {
    const failing = userJobs.filter((j) => launchdHealth(j) !== "ok").length;
    nodes.add(LOCAL_ID, {
      id: "launchd",
      label: `${plural(userJobs.length, "launchd job")}`,
      tier: "outside",
      note: failing ? `${failing} failing` : undefined,
      items: userJobs.map((j) => ({ name: j.label, note: j.when, health: launchdHealth(j) })),
      source: "launchd",
    });
  }
  if (facts.macRunner) {
    nodes.add(LOCAL_ID, {
      id: "mac-runner",
      label: "mac-runner · Apple CI on demand",
      tier: "made",
      source: "mac-runner",
    });
  }
  const workspaces = facts.terraform?.workspaces ?? [];
  if (workspaces.length) {
    const servers = workspaces.filter((w) => w.server).map((w) => w.name);
    nodes.add(LOCAL_ID, {
      id: "terraform-state",
      label: `Terraform state · ${plural(workspaces.length, "workspace")}`,
      tier: "made",
      note: servers.length ? `servers: ${servers.join(", ")}` : undefined,
      items: workspaces.map((w) => ({
        name: `${w.stack}/${w.name}`,
        note: w.server ? `server ${w.server}` : plural(w.resources, "resource"),
      })),
      source: "terraform",
    });
  }
  if (facts.providers.length) {
    nodes.add(LOCAL_ID, {
      id: "config",
      label: `hatchkit config + keychain · ${plural(facts.providers.length, "provider")}`,
      tier: "made",
      note: [
        facts.deployTokens.length ? plural(facts.deployTokens.length, "Worker token") : "",
        facts.ledgers.length ? plural(facts.ledgers.length, "run ledger") : "",
        facts.backups ? plural(facts.backups.hosts.length, "backup host") : "",
      ]
        .filter(Boolean)
        .join(" · "),
      items: facts.providers.map((name) => ({ name })),
      source: "hatchkit-config",
    });
  }
  if (facts.repos?.length) {
    const manifests = facts.repos.filter((r) => r.manifest).length;
    nodes.add(LOCAL_ID, {
      id: "repos",
      label: `${plural(facts.repos.length, "local repo")}`,
      tier: "outside",
      note: manifests ? `${manifests} with a hatchkit manifest` : undefined,
      items: facts.repos.map((r) => ({
        name: r.name,
        note: [r.manifest ? "manifest" : "", r.lastCommit ?? ""].filter(Boolean).join(" · "),
      })),
      source: "repos",
    });
  }

  // -------------------------------------------------------------- edges
  const edge = (e: MapEdge) => {
    if (!nodes.find(e.from) || !nodes.find(e.to)) return;
    const from = nodes.find(e.from)?.id as string;
    const to = nodes.find(e.to)?.id as string;
    if (from === to) return;
    if (edges.some((x) => x.from === from && x.to === to && x.label === e.label)) return;
    edges.push({ ...e, from, to });
  };
  if (facts.repos?.length || facts.github) {
    edge({ from: LOCAL_ID, to: GITHUB_ID, label: "git push", manual: true, source: "repos" });
  }
  const tokenCount = facts.deployTokens.length;
  if (tokenCount > 0) {
    edge({
      from: GITHUB_ID,
      to: CLOUDFLARE_ID,
      label: `${plural(tokenCount, "Worker")} deploy on push`,
      source: "hatchkit-config",
    });
  }
  const zoneSet = new Set((facts.cloudflare?.zones ?? []).map(lc));
  const inZone = (host: string) => {
    const parts = lc(host).split(".");
    for (let i = 0; i < parts.length - 1; i++)
      if (zoneSet.has(parts.slice(i).join("."))) return true;
    return false;
  };
  for (const id of serverIds) {
    const c = coolifyByNode.get(lc(id));
    if (!c) continue;
    const apps = coolifyApps.filter((a) => lc(nodeOfCoolifyServer(a.server) ?? "") === lc(id));
    const services = (facts.coolify?.services ?? []).filter(
      (s) => lc(nodeOfCoolifyServer(s.server) ?? "") === lc(id),
    );
    const hosts = apps.flatMap((a) => a.domains).filter((d) => !/\.sslip\.io$/i.test(d));
    if (hosts.some(inZone) || (services.length > 0 && zoneSet.size > 0)) {
      edge({ from: CLOUDFLARE_ID, to: id, label: "proxied public traffic", source: "coolify" });
    }
    if (apps.some((a) => a.buildPack === "dockerimage") && providers.has("ghcr")) {
      edge({ from: GITHUB_ID, to: id, label: "GHCR images · deploy hooks", source: "coolify" });
    }
  }
  const coolifyHost = serverIds.find((id) => coolifyByNode.get(lc(id))?.coolifyHost);
  if (coolifyHost) {
    for (const id of serverIds) {
      if (id !== coolifyHost && coolifyByNode.has(lc(id))) {
        edge({ from: coolifyHost, to: id, label: "Coolify over SSH", source: "coolify" });
      }
    }
  }
  for (const h of facts.backups?.hosts ?? []) {
    const id = h.server ? serverName(h.server) : h.name;
    if (facts.backups?.target === "r2") {
      edge({ from: id, to: CLOUDFLARE_ID, label: "restic → R2", source: "backups" });
    }
    edge({
      from: LOCAL_ID,
      to: id,
      label: "hatchkit over tailscale ssh",
      manual: true,
      source: "backups",
    });
  }
  for (const g of facts.tailscale?.grants ?? []) {
    const ends = (sel: string[]) =>
      sel.flatMap((s) => {
        const tag = s.startsWith("tag:") ? s : undefined;
        const matches = peers.filter((p) => (tag ? p.tags.includes(tag) : lc(p.id) === lc(s)));
        return matches.map((p) => nodes.find(p.id) ?? nodes.find(p.hostName)).filter(Boolean);
      }) as MapNode[];
    for (const from of ends(g.src)) {
      for (const to of ends(g.dst)) {
        edge({
          from: from.id,
          to: to.id,
          label: g.ports.length ? `tailnet ${g.ports.join(", ")}` : "tailnet",
          source: "tailscale",
        });
      }
    }
  }

  // --------------------------------------------------------------- jobs
  for (const j of launchd) {
    const health = launchdHealth(j);
    jobs.push({
      name: prettyLabel(j.label),
      node: LOCAL_ID,
      where: `${localName} · launchd`,
      when: j.when,
      what: j.program,
      tier: j.label.startsWith(HATCHKIT_LAUNCHD_PREFIX) ? "made" : "outside",
      health,
      detail: !j.loaded
        ? "plist present, not loaded"
        : health === "fail"
          ? `last exit ${j.lastExit}`
          : undefined,
      source: "launchd",
    });
    if (health !== "ok") {
      findings.push({
        severity: "warn",
        title: `launchd job ${j.label} ${j.loaded ? "is failing" : "is not loaded"}.`,
        detail: j.loaded
          ? `launchd shows last exit ${j.lastExit}. Logs: the plist's StandardErrorPath, or \`log show --predicate 'subsystem == "com.apple.xpc.launchd"' --last 1h | grep ${j.label}\`.`
          : `The plist is in ~/Library/LaunchAgents but \`launchctl list\` does not show it.`,
        source: "launchd",
      });
    }
  }
  if (facts.hostTimers) {
    const byUnit = new Map<
      string,
      { hosts: string[]; whens: Set<string>; what?: string; failedOn: string[] }
    >();
    // Host order from the config, not from whichever ssh answered first.
    const hostOrder = (facts.backups?.hosts ?? []).map((h) => h.name);
    const rank = (h: string) => (hostOrder.includes(h) ? hostOrder.indexOf(h) : hostOrder.length);
    const entries = Object.entries(facts.hostTimers).sort(
      ([a], [b]) => rank(a) - rank(b) || a.localeCompare(b),
    );
    for (const [host, res] of entries) {
      if (!("timers" in res)) continue;
      for (const t of res.timers) {
        const e = byUnit.get(t.unit) ?? {
          hosts: [],
          whens: new Set(),
          what: t.description,
          failedOn: [],
        };
        e.hosts.push(host);
        e.whens.add(t.when);
        if (t.failed) e.failedOn.push(host);
        byUnit.set(t.unit, e);
      }
    }
    const nodeOfHost = (h: string) => {
      const b = facts.backups?.hosts.find((x) => x.name === h);
      return b?.server ? serverName(b.server) : h;
    };
    for (const [unit, e] of byUnit) {
      const hostNodes = e.hosts.map(nodeOfHost);
      const failedNodes = e.failedOn.map(nodeOfHost);
      jobs.push({
        name: unit.replace(/^hatchkit-/, "").replace(/\.timer$/, ""),
        node: hostNodes[0],
        where: `${hostNodes.join(" + ")} · hatchkit timers`,
        when: [...e.whens].join(" / "),
        what: e.what,
        tier: "made",
        health: failedNodes.length ? "fail" : "ok",
        detail: failedNodes.length ? `failed on ${failedNodes.join(", ")}` : undefined,
        source: "host-timers",
      });
      if (failedNodes.length) {
        findings.push({
          severity: "warn",
          title: `Host timer ${unit} failed on ${failedNodes.join(", ")}.`,
          detail: `systemd reports its last run as failed. Logs: tailscale ssh <host> journalctl -u ${unit.replace(/\.timer$/, ".service")} -n 50`,
          source: "host-timers",
        });
      }
    }
  }
  for (const w of facts.cloudflare?.workers ?? []) {
    if (!w.crons.length) continue;
    jobs.push({
      name: w.name,
      node: CLOUDFLARE_ID,
      where: "Cloudflare · cron Workers",
      when: w.crons.map(humanizeCron).join(", "),
      tier: workerTier(w),
      source: "cloudflare",
    });
  }

  // -------------------------------------------------------- findings
  for (const a of coolifyApps) {
    if (coolifyHealth(a.status) !== "ok" && a.status) {
      findings.push({
        severity: "warn",
        title: `Coolify app ${a.name} is ${a.status}.`,
        detail: `On ${nodeOfCoolifyServer(a.server) ?? "?"}. Stop or remove it if it is dead; otherwise check its logs in Coolify.`,
        source: "coolify",
      });
    }
  }
  for (const s of facts.coolify?.services ?? []) {
    if (coolifyHealth(s.status) !== "ok" && s.status) {
      findings.push({
        severity: "warn",
        title: `Coolify service ${s.name} is ${s.status}.`,
        detail: `On ${nodeOfCoolifyServer(s.server) ?? "?"}. One of its containers is not healthy.`,
        source: "coolify",
      });
    }
  }
  const outsideWorkers = (facts.cloudflare?.workers ?? []).filter(
    (w) => workerTier(w) === "outside",
  );
  if (outsideWorkers.length) {
    findings.push({
      severity: "info",
      title: `${plural(outsideWorkers.length, "Worker")} deploy without a hatchkit token.`,
      detail: `${outsideWorkers.map((w) => w.name).join(", ")}. hatchkit has no record of who deploys them; \`hatchkit cloudflare token\` in the repo gives one a per-Worker token.`,
      source: "cloudflare",
    });
  }
  for (const x of facts.overview?.crossReferenceWarnings ?? []) {
    findings.push({
      severity: "warn",
      title: `${x.headline} (${x.subjects.length}).`,
      detail: `${x.subjects.join(", ")}. From \`hatchkit overview\`.`,
      source: "overview",
    });
  }

  // ----------------------------------------------------------- extras
  for (const n of extras.nodes ?? []) {
    const node = nodes.ensure(n.id, () => ({
      name: n.name ?? n.id,
      kind: n.kind ?? "world",
      zone: n.zone ?? (n.kind === "server" || n.kind === "device" ? "tailnet" : "public"),
    }));
    if (n.name) node.name = n.name;
    if (n.subtitle) node.subtitle = n.subtitle;
    if (n.kind) node.kind = n.kind;
    if (n.zone) node.zone = n.zone;
    for (const [i, c] of (n.components ?? []).entries()) {
      node.components.push({
        id: `extras:${i}`,
        label: c.label,
        tier: c.gap ? undefined : c.tier === "none" ? undefined : (c.tier ?? "outside"),
        gap: c.gap,
        note: c.note,
        items: c.items?.map((name): MapItem => ({ name })),
        source: "extras",
      });
    }
  }
  for (const e of extras.edges ?? []) {
    const ok = nodes.find(e.from) && nodes.find(e.to);
    if (!ok) {
      findings.push({
        severity: "info",
        title: `Extras edge ${e.from} → ${e.to} names an unknown node.`,
        detail:
          "Check the ids in the extras registry against the node ids in `hatchkit map --json`.",
        source: "extras",
      });
      continue;
    }
    edge({ ...e, source: "extras" });
  }
  for (const j of extras.jobs ?? []) {
    const node = nodes.find(j.node);
    jobs.push({
      name: j.name,
      node: node?.id ?? j.node,
      where: j.where ?? `${node?.name ?? j.node}`,
      when: j.when,
      what: j.what,
      tier: j.tier ?? "outside",
      health: j.health,
      source: "extras",
    });
  }
  for (const l of extras.looseEnds ?? []) {
    findings.push({ severity: "warn", title: l.title, detail: l.detail ?? "", source: "extras" });
  }
  for (const s of facts.sources) {
    if (s.status === "error") {
      findings.push({
        severity: "info",
        title: `Not read: ${s.label}.`,
        detail: s.detail ?? "",
        source: s.key,
      });
    }
  }

  // Hidden nodes go last, after extras could have added them.
  for (const id of [...nodes.order]) {
    if (hidden.has(lc(id))) {
      nodes.byId.delete(id);
      nodes.order.splice(nodes.order.indexOf(id), 1);
    }
  }
  const finalNodes = nodes.order.map((id) => nodes.byId.get(id) as MapNode);
  const finalEdges = edges.filter((e) => nodes.byId.has(e.from) && nodes.byId.has(e.to));

  // ----------------------------------------------------------- projects
  const { projects, groups } = buildProjects(facts, extras, serverName);

  const tiers = countTiers(finalNodes);
  const stats: MapStat[] = [{ value: String(projects.length), label: "projects" }];
  if (facts.hetzner) {
    stats.push({ value: `${facts.hetzner.servers.length} + 1`, label: `servers + ${localName}` });
  }
  if (facts.cloudflare) {
    stats.push({ value: String(facts.cloudflare.workers.length), label: "Cloudflare Workers" });
    stats.push({ value: String(facts.cloudflare.zones.length), label: "domains (zones)" });
  }
  if (facts.coolify) stats.push({ value: String(coolifyApps.length), label: "apps on Coolify" });
  if (facts.github) {
    stats.push({
      value: String(facts.github.repos),
      label: `GitHub repos, ${facts.github.private} private`,
    });
  }
  stats.push({ value: String(jobs.length), label: "background jobs" });
  stats.push(...(extras.stats ?? []));

  return {
    title: extras.title ?? "Fleet map",
    generatedAt: facts.generatedAt,
    cliVersion: facts.cliVersion,
    stats,
    tiers,
    nodes: finalNodes,
    edges: finalEdges,
    projects,
    projectGroups: groups,
    jobs,
    findings,
    sources: facts.sources,
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const UNGROUPED = "Not grouped";

function strongest(a: ProjectRelation | undefined, b: ProjectRelation | undefined) {
  if (!a) return b;
  if (!b) return a;
  return RELATION_ORDER.indexOf(a) <= RELATION_ORDER.indexOf(b) ? a : b;
}

export function relationFromLedger(kinds: readonly string[]): ProjectRelation {
  if (kinds.includes("scaffold") || kinds.includes("scaffoldedFile")) return "starter";
  if (kinds.includes("manifest")) return "adopted";
  return "provisioned";
}

function buildProjects(
  facts: FleetFacts,
  extras: MapExtras,
  serverName: (n: string) => string,
): { projects: MapProject[]; groups: string[] } {
  const rows = new Map<string, MapProject & { order: number }>();
  const alias = new Map<string, string>();
  let order = 0;
  for (const p of extras.projects ?? []) {
    alias.set(lc(p.name), p.name);
    for (const a of p.aliases ?? []) alias.set(lc(a), p.name);
  }
  const canonical = (name: string) =>
    alias.get(lc(name)) ?? alias.get(lc(projectStem(name))) ?? name;
  const known = (name: string) =>
    rows.get(lc(canonical(name))) ?? rows.get(lc(canonical(projectStem(name))));
  const row = (name: string): MapProject & { order: number } => {
    const key = lc(canonical(name));
    let r = rows.get(key);
    if (!r) {
      r = {
        name: canonical(name),
        group: UNGROUPED,
        ships: [],
        domains: [],
        servers: [],
        tier: "outside",
        order: order++,
      };
      rows.set(key, r);
    }
    return r;
  };
  const push = (list: string[], ...values: Array<string | undefined>) => {
    for (const v of values) if (v && !list.includes(v)) list.push(v);
  };

  for (const p of extras.projects ?? []) {
    const r = row(p.name);
    if (p.group) r.group = p.group;
    if (p.blurb) r.blurb = p.blurb;
    push(r.ships, ...(p.ships ?? []));
    push(r.domains, ...(p.domains ?? []));
    push(r.servers, p.server);
    if (p.tier) r.tier = p.tier;
  }
  for (const l of facts.ledgers) {
    const r = row(l.name);
    r.hatchkit = strongest(r.hatchkit, relationFromLedger(l.kinds));
  }
  for (const t of facts.deployTokens) {
    const repoName = t.repo.split("/").pop() ?? t.repo;
    const r = known(repoName) ?? known(t.worker) ?? row(repoName);
    r.hatchkit = strongest(r.hatchkit, "worker");
    push(r.ships, "Workers");
  }
  for (const a of facts.coolify?.apps ?? []) {
    const r =
      (a.project ? known(a.project) : undefined) ??
      known(a.name) ??
      row(a.project ?? projectStem(a.name));
    r.hatchkit = strongest(r.hatchkit, "coolify");
    push(r.ships, "Coolify");
    if (a.server) push(r.servers, serverName(a.server));
    push(r.domains, ...a.domains.filter((d) => !/\.sslip\.io$/i.test(d)));
  }
  const repoOfWorker = new Map(
    facts.deployTokens.map((t) => [t.worker, t.repo.split("/").pop() ?? t.repo]),
  );
  for (const w of facts.cloudflare?.workers ?? []) {
    const repo = repoOfWorker.get(w.name);
    const r = (repo ? known(repo) : undefined) ?? known(w.name) ?? row(projectStem(w.name));
    push(r.ships, "Workers");
    push(r.domains, ...w.hosts);
  }
  for (const repo of facts.repos ?? []) {
    const m = repo.manifest;
    const r = known(repo.name) ?? (m ? known(m.name) : undefined) ?? (m ? row(m.name) : undefined);
    if (!r) continue;
    if (m) {
      r.hatchkit = strongest(r.hatchkit, "manifest");
      push(r.domains, m.domain, ...(m.aliases ?? []));
    }
    r.lastCommit ??= repo.lastCommit;
    r.blurb ??= m?.description ?? repo.description;
  }
  const self = rows.get("hatchkit");
  if (self) self.hatchkit = "itself";

  for (const r of rows.values()) {
    if (r.ships.includes("Coolify")) r.tier = "listed";
    else if (r.hatchkit && r.tier === "outside") r.tier = "made";
  }

  const groups: string[] = [...(extras.groups ?? [])];
  for (const r of [...rows.values()].sort((a, b) => a.order - b.order)) {
    if (!groups.includes(r.group)) groups.push(r.group);
  }
  // Ungrouped rows go last.
  if (groups.includes(UNGROUPED)) groups.push(groups.splice(groups.indexOf(UNGROUPED), 1)[0]);
  const extrasOrder = new Map((extras.projects ?? []).map((p, i) => [lc(p.name), i]));
  const projects = [...rows.values()]
    .sort((a, b) => {
      const g = groups.indexOf(a.group) - groups.indexOf(b.group);
      if (g) return g;
      const ea = extrasOrder.get(lc(a.name)) ?? Number.MAX_SAFE_INTEGER;
      const eb = extrasOrder.get(lc(b.name)) ?? Number.MAX_SAFE_INTEGER;
      return ea - eb || a.name.localeCompare(b.name);
    })
    .map(({ order: _o, ...p }) => p);
  return { projects, groups: groups.filter((g) => projects.some((p) => p.group === g)) };
}
