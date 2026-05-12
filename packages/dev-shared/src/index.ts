/*
 * @hatchkit/dev-shared — runtime utilities for the hatchkit local-dev
 * integration. Used by the `hatchkit` CLI and the
 * `@hatchkit/dev-plugin-{vite,next}` adapters to keep Caddy fragments,
 * tailscale probes, and path constants in lockstep across processes.
 *
 * Architecture: a host-wide Caddy instance terminates TLS for
 * `*.local.ricoslabs.com` (real Cloudflare DNS-01 wildcard cert).
 * Each project drops a fragment in `~/.config/dev/projects/<slug>.caddy`
 * pointing Caddy at the project's dev port. Tailscale serve passes
 * raw TCP=443 traffic from the tailnet to Caddy. Phones get
 * `https://<slug>.local.ricoslabs.com/` with no per-project config.
 *
 * This package holds only the bits the runtime (dev server plugin)
 * needs at startup. The init/orchestration logic (writing the
 * Caddyfile, registering tailscale serve, generating the launchd
 * plist) lives in the CLI.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LOCAL_DEV_DOMAIN = "local.ricoslabs.com";
export const LOCAL_DEV_DOMAIN_WILDCARD = `*.${LOCAL_DEV_DOMAIN}`;

/** Root of the host-wide local-dev config. Tests + sandboxed runs
 *  override via `HATCHKIT_DEV_CONFIG_DIR` to keep fragments + Caddyfile
 *  writes off the real `~/.config/dev/`. The env var is consulted once
 *  at module load so a child process can pre-set it and have every
 *  derived path (Caddyfile, projects dir) follow along. */
export const DEV_CONFIG_DIR =
  process.env.HATCHKIT_DEV_CONFIG_DIR && process.env.HATCHKIT_DEV_CONFIG_DIR.length > 0
    ? process.env.HATCHKIT_DEV_CONFIG_DIR
    : join(homedir(), ".config", "dev");
export const CADDYFILE_PATH = join(DEV_CONFIG_DIR, "Caddyfile");
export const PROJECTS_DIR = join(DEV_CONFIG_DIR, "projects");

/** Sentinel that marks a Caddyfile as hatchkit-managed. Doctor + the
 *  plugin both gate on this so users with hand-rolled Caddy setups
 *  aren't disturbed until they explicitly opt in via
 *  `hatchkit dev-setup init`. */
export const MANAGED_MARKER = "# Managed by hatchkit dev-setup";

/** Has the user run `hatchkit dev-setup init`? Plugins should treat a
 *  negative result as "stay quiet" — the user hasn't asked for the
 *  Tailscale URL flow. */
export function isLocalDevActive(): boolean {
  if (!existsSync(CADDYFILE_PATH)) return false;
  try {
    return readFileSync(CADDYFILE_PATH, "utf-8").includes(MANAGED_MARKER);
  } catch {
    return false;
  }
}

/** Recover the Caddy listening port from the Caddyfile. Returns null
 *  when the file is missing or its `https_port` line is hand-edited
 *  beyond regex match. */
export function readCaddyPort(): number | null {
  if (!existsSync(CADDYFILE_PATH)) return null;
  try {
    const text = readFileSync(CADDYFILE_PATH, "utf-8");
    const m = text.match(/https_port\s+(\d+)/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-project Caddy fragment
// ---------------------------------------------------------------------------

export function projectFragmentPath(slug: string): string {
  return join(PROJECTS_DIR, `${slug}.caddy`);
}

export function projectFragmentContents(slug: string, devPort: number): string {
  const host = `${slug}.${LOCAL_DEV_DOMAIN}`;
  return `@${slug} host ${host}
handle @${slug} { reverse_proxy 127.0.0.1:${devPort} }
`;
}

/** Idempotent fragment writer. Returns `"created"` / `"updated"` /
 *  `"unchanged"` so callers can phrase a useful log line. */
export function writeProjectFragment(
  slug: string,
  devPort: number,
): "created" | "updated" | "unchanged" {
  ensureProjectsDir();
  const path = projectFragmentPath(slug);
  const next = projectFragmentContents(slug, devPort);
  if (!existsSync(path)) {
    writeFileSync(path, next);
    return "created";
  }
  const prev = readFileSync(path, "utf-8");
  if (prev === next) return "unchanged";
  writeFileSync(path, next);
  return "updated";
}

export function removeProjectFragment(slug: string): boolean {
  const path = projectFragmentPath(slug);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

function ensureProjectsDir(): void {
  if (!existsSync(PROJECTS_DIR)) mkdirSync(PROJECTS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Tailscale identity + serve-status probes
// ---------------------------------------------------------------------------

export interface TailscaleIdentity {
  shortName: string;
  fullName: string;
  ip: string;
  magicDnsSuffix: string;
}

export async function tailscaleIdentity(): Promise<TailscaleIdentity | null> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], { timeout: 1500 });
    const json = JSON.parse(stdout) as {
      Self?: { DNSName?: string; TailscaleIPs?: string[] };
      CurrentTailnet?: { MagicDNSSuffix?: string };
      MagicDNSSuffix?: string;
    };
    const self = json.Self;
    if (!self?.DNSName || !self.TailscaleIPs?.length) return null;
    const fullName = self.DNSName.replace(/\.$/, "");
    const shortName = fullName.split(".")[0] ?? fullName;
    const ip = self.TailscaleIPs.find((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v)) ?? "";
    if (!ip) return null;
    const magicDnsSuffix = json.CurrentTailnet?.MagicDNSSuffix ?? json.MagicDNSSuffix ?? "";
    return { shortName, fullName, ip, magicDnsSuffix };
  } catch {
    return null;
  }
}

/** Probe `tailscale serve status` for the TCP=443 → localhost:<caddyPort>
 *  bridge our architecture requires. Returns the discovered target port,
 *  or null when no TCP=443 bridge exists at all. */
export async function tailscaleServeTcpTarget(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["serve", "status", "--json"], {
      timeout: 1500,
    });
    const cfg = JSON.parse(stdout) as { TCP?: Record<string, { TCPForward?: string }> };
    const entry = cfg.TCP?.["443"];
    if (!entry?.TCPForward) return null;
    const m = entry.TCPForward.match(/:(\d+)$/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Slug resolution — used by the dev plugins to pick which subdomain this
// project lives at. Order: explicit option → manifest → package.json.
// ---------------------------------------------------------------------------

export interface SlugResolveOptions {
  /** Caller-supplied slug, takes precedence over manifest + package.json. */
  explicit?: string;
  /** Directory to walk up from when looking for `.hatchkit.json`. Defaults
   *  to `process.cwd()`. */
  fromDir?: string;
  /** Walk-up cap so a misplaced cwd doesn't crawl to `/`. Default 8. */
  maxDepth?: number;
}

export interface ResolvedSlug {
  slug: string;
  source: "explicit" | "manifest" | "package-json";
}

/** Resolve the slug for a project at runtime. Returns null when every
 *  candidate source comes up empty. */
export function resolveSlug(opts: SlugResolveOptions = {}): ResolvedSlug | null {
  if (opts.explicit) {
    return { slug: sanitiseSlug(opts.explicit), source: "explicit" };
  }
  const start = opts.fromDir ?? process.cwd();
  const max = opts.maxDepth ?? 8;
  let dir = start;
  for (let i = 0; i < max; i++) {
    const manifest = join(dir, ".hatchkit.json");
    if (existsSync(manifest)) {
      try {
        const m = JSON.parse(readFileSync(manifest, "utf-8")) as {
          localDev?: { slug?: string };
          name?: string;
        };
        // Prefer the dedicated localDev.slug field; fall back to the
        // project name when localDev is unset. (Step 4 of the feature
        // populates localDev.slug at scaffold time; older manifests
        // won't have it.)
        const candidate = m.localDev?.slug ?? m.name;
        if (candidate) return { slug: sanitiseSlug(candidate), source: "manifest" };
      } catch {
        // Corrupt manifest — keep walking, fall through to package.json.
      }
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  dir = start;
  for (let i = 0; i < max; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const j = JSON.parse(readFileSync(pkg, "utf-8")) as { name?: string };
        if (j.name) {
          // Strip scoped-package prefix: `@scope/raptor-runner` → `raptor-runner`.
          const bare = j.name.replace(/^@[^/]+\//, "");
          return { slug: sanitiseSlug(bare), source: "package-json" };
        }
      } catch {
        // Walk up.
      }
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Constrain a slug to a Caddy + DNS-safe shape. We don't try to be
 *  clever here — just lowercase, keep `[a-z0-9-]`, collapse runs of `-`. */
export function sanitiseSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Compose the public dev URL for a slug. */
export function localDevUrl(slug: string): string {
  return `https://${slug}.${LOCAL_DEV_DOMAIN}/`;
}
