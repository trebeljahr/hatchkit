/*
 * Local discovery for `hatchkit map`: launchd jobs, Terraform state,
 * the tailnet as `tailscale status` sees it, git repos and GitHub repo
 * counts. Every reader runs a read-only command or reads a file; the
 * parsers are pure and exported for tests.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { execa } from "execa";
import type {
  GithubFacts,
  LaunchdJob,
  RepoFacts,
  TailnetPeer,
  TailscaleFacts,
  TerraformFacts,
} from "./model.js";
import { humanizeLaunchd } from "./schedule.js";

async function run(cmd: string, args: string[], timeout = 20_000) {
  const r = await execa(cmd, args, { reject: false, timeout });
  return { ok: r.exitCode === 0, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

// ---------------------------------------------------------------------------
// launchd
// ---------------------------------------------------------------------------

/** `launchctl list`: `PID\tStatus\tLabel` per line, `-` for no PID. */
export function parseLaunchctlList(text: string): Map<string, { pid?: number; status?: number }> {
  const out = new Map<string, { pid?: number; status?: number }>();
  for (const line of text.split("\n")) {
    const m = /^(-|\d+)\s+(-?\d+|-)\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    out.set(m[3], {
      pid: m[1] === "-" ? undefined : Number(m[1]),
      status: m[2] === "-" ? undefined : Number(m[2]),
    });
  }
  return out;
}

/** The script a job runs, as a bare file name (never a full command line). */
export function launchdProgram(plist: Record<string, unknown>): string | undefined {
  const args = Array.isArray(plist.ProgramArguments)
    ? (plist.ProgramArguments as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  const program = typeof plist.Program === "string" ? plist.Program : undefined;
  const tokens = [...args, ...(program ? [program] : [])].flatMap((a) => a.split(/\s+/));
  const script = tokens.reverse().find((t) => /\.(sh|py|mjs|cjs|js|ts|rb|pl)$/.test(t));
  if (script) return basename(script);
  const path = tokens.find((t) => t.includes("/") && !/^\/(bin|usr\/bin)\/(ba|z)?sh$/.test(t));
  return path ? basename(path) : undefined;
}

export function launchdJob(
  label: string,
  plist: Record<string, unknown>,
  status: { pid?: number; status?: number } | undefined,
): LaunchdJob {
  return {
    label,
    when: humanizeLaunchd(plist),
    program: launchdProgram(plist),
    running: status?.pid !== undefined,
    lastExit: status?.status,
    loaded: status !== undefined,
  };
}

/** Jobs in ~/Library/LaunchAgents whose label starts with one of `prefixes`. */
export async function discoverLaunchd(
  prefixes: readonly string[],
  dir = join(homedir(), "Library", "LaunchAgents"),
): Promise<LaunchdJob[]> {
  if (process.platform !== "darwin" || !existsSync(dir)) return [];
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".plist") && prefixes.some((p) => f.startsWith(p)),
  );
  const list = await run("launchctl", ["list"]);
  const status = parseLaunchctlList(list.stdout);
  const jobs = await Promise.all(
    files.map(async (file) => {
      const r = await run("plutil", ["-convert", "json", "-o", "-", join(dir, file)]);
      let plist: Record<string, unknown> = {};
      try {
        plist = JSON.parse(r.stdout) as Record<string, unknown>;
      } catch {
        // A plist with a data blob does not convert; the label still counts.
      }
      const label = typeof plist.Label === "string" ? plist.Label : file.replace(/\.plist$/, "");
      return launchdJob(label, plist, status.get(label));
    }),
  );
  return jobs.sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Terraform state
// ---------------------------------------------------------------------------

/** Managed resource count and the Hetzner server name of one state file. */
export function readStateSummary(state: string): { resources: number; server?: string } {
  let parsed: {
    resources?: Array<{
      mode?: string;
      type?: string;
      instances?: Array<{ attributes?: { name?: unknown } }>;
    }>;
  };
  try {
    parsed = JSON.parse(state);
  } catch {
    return { resources: 0 };
  }
  const managed = (parsed.resources ?? []).filter((r) => r.mode === "managed");
  const server = managed
    .filter((r) => r.type === "hcloud_server")
    .flatMap((r) => r.instances ?? [])
    .map((i) => i.attributes?.name)
    .find((n): n is string => typeof n === "string");
  return {
    resources: managed.reduce((n, r) => n + (r.instances?.length ?? 0), 0),
    server,
  };
}

/** Every workspace state (plus a non-empty default state) under `stacksDir`. */
export function readTerraformState(stacksDir: string): TerraformFacts {
  const workspaces: TerraformFacts["workspaces"] = [];
  if (!existsSync(stacksDir)) return { workspaces };
  for (const stack of readdirSync(stacksDir).sort()) {
    const dir = join(stacksDir, stack);
    if (!statSync(dir).isDirectory()) continue;
    const states: Array<[string, string]> = [];
    const def = join(dir, "terraform.tfstate");
    if (existsSync(def)) states.push(["default", def]);
    const wsDir = join(dir, "terraform.tfstate.d");
    if (existsSync(wsDir)) {
      for (const ws of readdirSync(wsDir).sort()) {
        const file = join(wsDir, ws, "terraform.tfstate");
        if (existsSync(file)) states.push([ws, file]);
      }
    }
    for (const [name, file] of states) {
      const summary = readStateSummary(readFileSync(file, "utf8"));
      if (summary.resources === 0) continue;
      workspaces.push({ stack, name, ...summary });
    }
  }
  return { workspaces };
}

// ---------------------------------------------------------------------------
// Tailscale
// ---------------------------------------------------------------------------

interface TsNode {
  HostName?: string;
  DNSName?: string;
  OS?: string;
  Online?: boolean;
  Tags?: string[] | null;
  ExitNodeOption?: boolean;
}

const peerId = (n: TsNode) => (n.DNSName?.split(".")[0] || n.HostName || "device").toLowerCase();

/** `tailscale status --json`, without addresses or keys. */
export function parseTailscaleStatus(json: string): TailscaleFacts {
  const d = JSON.parse(json) as { Self?: TsNode; Peer?: Record<string, TsNode> };
  const peers: TailnetPeer[] = Object.values(d.Peer ?? {}).map((p) => ({
    id: peerId(p),
    hostName: p.HostName ?? peerId(p),
    os: p.OS || undefined,
    online: p.Online === true,
    tags: p.Tags ?? [],
    exitNode: p.ExitNodeOption === true,
  }));
  return {
    self: d.Self
      ? { id: peerId(d.Self), hostName: d.Self.HostName ?? "this machine", os: d.Self.OS }
      : undefined,
    peers: peers.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** The tailnet policy's `grants` (and legacy `acls`) as src/dst/ports. */
export function parseTailnetPolicy(policy: unknown): NonNullable<TailscaleFacts["grants"]> {
  const out: NonNullable<TailscaleFacts["grants"]> = [];
  const p = (policy ?? {}) as {
    grants?: Array<{ src?: string[]; dst?: string[]; ip?: string[] }>;
    acls?: Array<{ action?: string; src?: string[]; dst?: string[] }>;
  };
  for (const g of p.grants ?? []) {
    out.push({ src: g.src ?? [], dst: g.dst ?? [], ports: g.ip ?? [] });
  }
  for (const a of p.acls ?? []) {
    if (a.action && a.action !== "accept") continue;
    const dst: string[] = [];
    const ports: string[] = [];
    for (const d of a.dst ?? []) {
      const i = d.lastIndexOf(":");
      dst.push(i > 0 ? d.slice(0, i) : d);
      if (i > 0 && d.slice(i + 1) !== "*") ports.push(d.slice(i + 1));
    }
    out.push({ src: a.src ?? [], dst, ports: [...new Set(ports)] });
  }
  return out;
}

export async function discoverTailscale(
  token: string | undefined,
): Promise<{ facts?: TailscaleFacts; error?: string }> {
  const r = await run("tailscale", ["status", "--json"]).catch((err: Error) => ({
    ok: false,
    stdout: "",
    stderr: err.message,
  }));
  if (!r.ok) return { error: (r.stderr.split("\n")[0] || "tailscale status failed").trim() };
  let facts: TailscaleFacts;
  try {
    facts = parseTailscaleStatus(r.stdout);
  } catch (err) {
    return { error: `tailscale status: ${(err as Error).message}` };
  }
  if (token) {
    try {
      const res = await fetch("https://api.tailscale.com/api/v2/tailnet/-/acl", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      facts.grants = parseTailnetPolicy(await res.json());
    } catch (err) {
      return { facts, error: `tailnet policy not read: ${(err as Error).message}` };
    }
  }
  return { facts };
}

// ---------------------------------------------------------------------------
// git repos
// ---------------------------------------------------------------------------

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The manifest fields the map shows; a quiet read, no migration notes. */
export function manifestSummary(raw: Record<string, unknown> | undefined): RepoFacts["manifest"] {
  if (!raw || typeof raw.name !== "string") return undefined;
  const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    name: raw.name,
    domain: s(raw.domain),
    aliases: Array.isArray(raw.aliases)
      ? raw.aliases.filter((a): a is string => typeof a === "string")
      : undefined,
    description: s(raw.description),
    deploymentMode: s(raw.deploymentMode),
  };
}

/** A repo's own `.git` directory; a worktree's or submodule's `.git` is a
 *  file pointing elsewhere, and the same repo would count twice. */
export function isMainCheckout(dotGit: string): boolean {
  try {
    return statSync(dotGit).isDirectory();
  } catch {
    return false;
  }
}

/** Git repos one level under each root (worktrees skipped). */
export async function discoverRepos(roots: readonly string[]): Promise<RepoFacts[]> {
  const dirs: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root).sort()) {
      if (entry.startsWith(".")) continue;
      const dir = join(root, entry);
      try {
        if (statSync(dir).isDirectory() && isMainCheckout(join(dir, ".git"))) dirs.push(dir);
      } catch {
        // A dangling symlink; skip it.
      }
    }
  }
  return Promise.all(
    dirs.map(async (dir) => {
      const log = await run("git", ["-C", dir, "log", "-1", "--format=%cs"], 10_000);
      const pkg = readJson(join(dir, "package.json"));
      return {
        name: basename(dir),
        lastCommit: log.ok && log.stdout.trim() ? log.stdout.trim() : undefined,
        manifest: manifestSummary(readJson(join(dir, ".hatchkit.json"))),
        description:
          typeof pkg?.description === "string" && pkg.description ? pkg.description : undefined,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// GitHub (through `gh`, read-only)
// ---------------------------------------------------------------------------

export function countRepos(rows: Array<{ visibility?: string; isArchived?: boolean }>) {
  return {
    repos: rows.length,
    private: rows.filter((r) => r.visibility && r.visibility.toUpperCase() !== "PUBLIC").length,
    archived: rows.filter((r) => r.isArchived).length,
  };
}

export async function discoverGithub(
  owners: readonly string[] | undefined,
): Promise<{ facts?: GithubFacts; error?: string }> {
  let list = owners ? [...owners] : [];
  if (list.length === 0) {
    const me = await run("gh", ["api", "user", "--jq", ".login"]).catch(() => null);
    if (!me?.ok) return { error: "gh is not signed in" };
    list = [me.stdout.trim()];
  }
  const rows: Array<{ visibility?: string; isArchived?: boolean }> = [];
  for (const owner of list) {
    const r = await run(
      "gh",
      ["repo", "list", owner, "--limit", "1000", "--json", "visibility,isArchived"],
      60_000,
    );
    if (!r.ok) return { error: `gh repo list ${owner}: ${r.stderr.split("\n")[0]}` };
    rows.push(...(JSON.parse(r.stdout) as typeof rows));
  }
  return { facts: { owners: list, ...countRepos(rows) } };
}
