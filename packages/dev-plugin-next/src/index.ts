/*
 * @hatchkit/dev-plugin-next — Next.js integration for hatchkit's
 * Tailscale-served dev URL flow.
 *
 * Usage:
 *
 *   // next.config.ts
 *   import { withLocalDev } from "@hatchkit/dev-plugin-next";
 *
 *   export default withLocalDev({
 *     reactStrictMode: true,
 *     // ...your normal Next config
 *   }, {
 *     slug: "raptor-runner", // optional override
 *   });
 *
 * What it does on `next dev` startup (only — `next build` / `next start`
 * are pass-through no-ops):
 *
 *   1. Resolves the project's slug from (in order): the explicit
 *      `slug` option → `.hatchkit.json` (walking up from cwd) →
 *      package.json `name`.
 *   2. Sniffs the dev port from `process.env.PORT` or `--port` argv
 *      (Next's own resolution path).
 *   3. Writes ~/.config/dev/projects/<slug>.caddy with a
 *      `reverse_proxy 127.0.0.1:<port>` directive. Caddy's --watch
 *      picks the change up without a restart.
 *   4. Probes `tailscale serve status` for the TCP=443 bridge that
 *      `hatchkit dev-setup init` registers once per machine.
 *   5. Prints a one-line `Tailscale: https://<slug>.<local-dev-domain>/`
 *      banner alongside Next's own startup output.
 *
 * Failure modes (no caddy fragment, no TCP bridge, tailscale offline)
 * surface as inline hints. The plugin never throws — a broken local-dev
 * pipeline should not break the dev server.
 *
 * Opt out entirely with `HATCHKIT_LOCAL_DEV=0`.
 *
 * The plugin does NOT touch Next's `basePath` / `assetPrefix` /
 * routing. Caddy proxies verbatim and Next serves at `/` — HMR/WS
 * paths stay unchanged. During `next dev`, the wrapper adds the
 * project's local-dev host to `allowedDevOrigins` so
 * Next's dev-resource origin guard allows font and HMR requests.
 */

import {
  isLocalDevActive,
  localDevUrl,
  projectFragmentPath,
  readCaddyPort,
  resolveSlug,
  type ResolvedSlug,
  tailscaleIdentity,
  tailscaleServeTcpTarget,
  writeProjectFragment,
} from "@hatchkit/dev-shared";

export interface LocalDevOptions {
  /** Override slug resolution. Useful when the package.json name doesn't
   *  match the desired subdomain (e.g. scoped packages, monorepo
   *  workspaces). When unset, the plugin walks up from cwd looking for
   *  `.hatchkit.json` (preferred) then package.json. */
  slug?: string;
  /** Override local-dev host suffix. Defaults to `local.<project base domain>`
   *  when `.hatchkit.json` has a domain, else Hatchkit's legacy shared
   *  domain. */
  localDevDomain?: string;
  /** Default port to assume when the dev server hasn't told us yet.
   *  Next.js defaults to 3000; hatchkit's scaffold pins a random 3xxx
   *  per project, so callers usually override this. */
  defaultPort?: number;
  /** Disable banner output. Side effects (Caddy fragment write,
   *  tailscale probe) still run. */
  silent?: boolean;
}

/** Wrap a Next.js config with hatchkit's local-dev integration. */
export function withLocalDev<TConfig>(nextConfig: TConfig, options: LocalDevOptions = {}): TConfig {
  // Only fire side effects in `next dev`. Production builds + `next start`
  // get the bare config back; same behaviour as if the plugin weren't there.
  if (isDevCommand() && process.env.HATCHKIT_LOCAL_DEV !== "0") {
    const resolved = resolveSlug({ explicit: options.slug, localDevDomain: options.localDevDomain });
    // Schedule async so we don't block Next's config loader. The Promise
    // resolves into stdout — Next's logger has already cleared by the
    // time we print, so our banner shows up below Next's "Ready" line.
    void initLocalDev(options, resolved);
    if (resolved) return withAllowedDevOrigin(nextConfig, localDevHost(resolved));
  }
  return nextConfig;
}

function isDevCommand(): boolean {
  // Next sets NODE_ENV="development" during `next dev`. The argv check
  // is the belt-and-braces fallback for harnesses (turbo, custom
  // servers) that load the config without setting NODE_ENV first.
  if (process.env.NODE_ENV === "development") return true;
  const argv = process.argv.slice(2);
  return argv.includes("dev") || argv.includes("--dev");
}

async function initLocalDev(options: LocalDevOptions, resolved: ResolvedSlug | null): Promise<void> {
  // Wait one tick so Next's own banner ("▲ Next.js …", "Ready in …ms")
  // has flushed before we tack our line on. Picking a fixed delay is
  // unavoidable here — Next 14/15 don't expose a "server-listening"
  // hook to a config consumer. 1.5s is the empirically reliable point
  // across Next 14, 15, and Turbopack on a typical laptop; if the dev
  // server takes longer to come up our banner still prints, just mixed
  // in with later HMR logs (harmless).
  await sleep(1500);

  if (!resolved) {
    log("[hatchkit] local-dev disabled: no slug found (set { slug } in withLocalDev or add a name to package.json).");
    return;
  }

  const port = detectDevPort(options.defaultPort);
  if (port === null) {
    log("[hatchkit] local-dev disabled: couldn't detect dev port from PORT env or argv.");
    return;
  }

  // Write/update the fragment first so Caddy reload picks up the right port
  // before we probe for the bridge — saves the user one re-run when the
  // port changed.
  let fragmentResult: "created" | "updated" | "unchanged" | "error" = "unchanged";
  try {
    fragmentResult = writeProjectFragment(resolved.slug, port, resolved.localDevDomain);
  } catch (err) {
    log(
      `[hatchkit] local-dev: failed to write Caddy fragment (${(err as Error).message}). Banner suppressed.`,
    );
    return;
  }

  // Probe the host-wide bridge. Three outcomes drive the banner shape:
  //   1. host-feature not active (no Caddyfile marker) → silent encouragement
  //   2. active but no TCP=443 → red hint with one-liner fix
  //   3. active + TCP=443 → green banner with the public URL
  if (!isLocalDevActive()) {
    log(
      `[hatchkit] local-dev: ${resolved.slug}.caddy ${fragmentResult}, but host bridge not configured.`,
    );
    log("            Run `hatchkit dev-setup init` once to enable Tailscale URLs.");
    return;
  }

  const caddyPort = readCaddyPort();
  if (caddyPort === null) {
    log(
      "[hatchkit] local-dev: Caddyfile is hatchkit-managed but has no https_port. Re-run `hatchkit dev-setup init`.",
    );
    return;
  }

  const tsId = await tailscaleIdentity();
  if (!tsId) {
    // Tailscale offline / not installed — local-dev only matters when
    // the user wants peers to reach this machine. Treat as silent no-op.
    return;
  }

  const tcpTarget = await tailscaleServeTcpTarget();
  if (tcpTarget === null) {
    log(`[hatchkit] local-dev: no port-443 bridge configured.`);
    log(`            Run once: tailscale serve --bg --tcp=443 tcp://localhost:${caddyPort}`);
    return;
  }
  if (tcpTarget !== caddyPort) {
    log(
      `[hatchkit] local-dev: tailscale serve points at localhost:${tcpTarget} but Caddy listens on ${caddyPort}.`,
    );
    log("            Run: `hatchkit dev-setup init` to reconcile.");
    return;
  }

  if (!options.silent) {
    log(
      `[hatchkit] Tailscale: ${localDevUrl(resolved.slug, resolved.localDevDomain)}  (slug from ${describeSource(resolved)})`,
    );
  }
}

function localDevHost(resolved: ResolvedSlug): string {
  return `${resolved.slug}.${resolved.localDevDomain}`;
}

function withAllowedDevOrigin<TConfig>(nextConfig: TConfig, host: string): TConfig {
  if (typeof nextConfig === "function") {
    const original = nextConfig as (this: unknown, ...args: unknown[]) => unknown;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args);
      if (isPromiseLike(result)) {
        return result.then((config) => appendAllowedDevOrigin(config, host));
      }
      return appendAllowedDevOrigin(result, host);
    };
    return wrapped as TConfig;
  }
  return appendAllowedDevOrigin(nextConfig, host);
}

function appendAllowedDevOrigin<TConfig>(nextConfig: TConfig, host: string): TConfig {
  if (!isConfigObject(nextConfig)) return nextConfig;

  const current = nextConfig.allowedDevOrigins;
  if (current === undefined) {
    return { ...nextConfig, allowedDevOrigins: [host] };
  }
  if (Array.isArray(current)) {
    if (current.includes(host)) return nextConfig;
    return { ...nextConfig, allowedDevOrigins: [...current, host] };
  }
  return nextConfig;
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return isConfigObject(value) && typeof value.then === "function";
}

function detectDevPort(fallback?: number): number | null {
  // Order matches Next's own resolution: explicit env var, then -p / --port
  // argv, then the framework's default.
  const fromEnv = numericEnv(process.env.PORT);
  if (fromEnv !== null) return fromEnv;
  const fromArgv = numericPortArgv(process.argv);
  if (fromArgv !== null) return fromArgv;
  if (fallback !== undefined) return fallback;
  return 3000;
}

function numericEnv(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function numericPortArgv(argv: string[]): number | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--port") {
      const next = argv[i + 1];
      const n = next ? Number(next) : Number.NaN;
      if (Number.isFinite(n) && n > 0) return n;
    } else if (a?.startsWith("--port=")) {
      const n = Number(a.slice("--port=".length));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function describeSource(resolved: ResolvedSlug): string {
  switch (resolved.source) {
    case "explicit":
      return "withLocalDev option";
    case "manifest":
      return ".hatchkit.json";
    case "package-json":
      return "package.json";
  }
  return "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(line: string): void {
  // stderr so HMR/output paths stay on stdout and tools that pipe Next's
  // output (e.g. concurrently, mprocs) don't merge our banner into their
  // stdout buffer in surprising ways.
  process.stderr.write(`${line}\n`);
}
