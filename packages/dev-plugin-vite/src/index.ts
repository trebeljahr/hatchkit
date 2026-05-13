/*
 * @hatchkit/dev-plugin-vite — Vite integration for hatchkit's
 * Tailscale-served dev URL flow.
 *
 * Usage:
 *
 *   // vite.config.ts
 *   import { defineConfig } from "vite";
 *   import react from "@vitejs/plugin-react";
 *   import { localDev } from "@hatchkit/dev-plugin-vite";
 *
 *   export default defineConfig({
 *     plugins: [react(), localDev({ slug: "raptor-runner" })],
 *   });
 *
 * What it does on `vite` (dev server) startup:
 *
 *   1. Resolves the project's slug from (in order): the explicit
 *      `slug` option → `.hatchkit.json` (walking up from cwd) →
 *      package.json `name`.
 *   2. Reads the live dev port from the running server's
 *      `httpServer.address()` — so `--port` overrides are respected.
 *   3. Writes ~/.config/dev/projects/<slug>.caddy with a
 *      `reverse_proxy 127.0.0.1:<port>` directive. Caddy's --watch
 *      picks the change up without a restart.
 *   4. Probes `tailscale serve status` for the TCP=443 bridge that
 *      `hatchkit dev-setup init` registers once per machine.
 *   5. Replaces Vite's default `Local / Network` URL banner with
 *      `Local / Tailscale`. Network-IP entries are dropped — the
 *      Tailscale URL covers every device that matters.
 *
 * Failure modes surface inline with actionable hints (see the banner
 * cases in initLocalDev). The plugin never throws — a broken local-dev
 * pipeline should not break the dev server.
 *
 * Opt out entirely with `HATCHKIT_LOCAL_DEV=0`. Production builds
 * (`apply: "serve"`) are pass-through.
 */

import {
  isLocalDevActive,
  localDevUrl,
  readCaddyPort,
  resolveSlug,
  type ResolvedSlug,
  tailscaleIdentity,
  tailscaleServeTcpTarget,
  writeProjectFragment,
} from "@hatchkit/dev-shared";
import type { Plugin } from "vite";

export interface LocalDevOptions {
  slug?: string;
  /** Override local-dev host suffix. Defaults to `local.<project base domain>`
   *  when `.hatchkit.json` has a domain, else Hatchkit's legacy shared
   *  domain. */
  localDevDomain?: string;
  /** Suppress all stdout output (Caddy fragment + tailscale probe
   *  still run, just no banner). */
  silent?: boolean;
}

export function localDev(options: LocalDevOptions = {}): Plugin {
  return {
    name: "@hatchkit/dev-plugin-vite",
    apply: "serve",
    configureServer(server) {
      if (process.env.HATCHKIT_LOCAL_DEV === "0") return;

      const originalPrintUrls = server.printUrls.bind(server);
      server.printUrls = () => {
        const info = server.config.logger.info;
        const resolved = server.resolvedUrls;
        // resolvedUrls is null when the host check rejected every binding;
        // fall back to Vite's own printer so the user still sees something.
        if (!resolved) {
          originalPrintUrls();
          return;
        }
        for (const url of resolved.local) {
          info(`  \x1b[32m➜\x1b[0m  \x1b[1mLocal\x1b[0m:   \x1b[36m${url}\x1b[0m`);
        }

        const addr = server.httpServer?.address();
        const port = typeof addr === "object" && addr ? addr.port : null;
        if (port === null) return;

        // Tailscale state is async; fire-and-forget so the banner
        // appends after Local. Vite's logger handles ordering fine
        // even when we trail behind by a few hundred ms.
        void appendTailscaleBanner({ port, options, info });
      };
    },
  };
}

interface AppendBannerInput {
  port: number;
  options: LocalDevOptions;
  info: (msg: string) => void;
}

async function appendTailscaleBanner({ port, options, info }: AppendBannerInput): Promise<void> {
  const label = (text: string) => `\x1b[1mTailscale\x1b[0m: ${text}`;
  const greenArrow = "\x1b[32m➜\x1b[0m";
  const yellowArrow = "\x1b[33m➜\x1b[0m";
  const dimArrow = "\x1b[2m➜\x1b[0m";

  const resolved = resolveSlug({ explicit: options.slug, localDevDomain: options.localDevDomain });
  if (!resolved) {
    info(
      `  ${yellowArrow}  ${label("local-dev disabled (no slug — set { slug } or add a package.json name).")}`,
    );
    return;
  }

  let fragmentResult: "created" | "updated" | "unchanged" | "error" = "unchanged";
  try {
    fragmentResult = writeProjectFragment(resolved.slug, port, resolved.localDevDomain);
  } catch (err) {
    info(
      `  ${yellowArrow}  ${label(`Caddy fragment write failed: ${(err as Error).message}`)}`,
    );
    return;
  }
  if (fragmentResult === "created" || fragmentResult === "updated") {
    info(`  ${dimArrow}  ${label(`rewriting Caddy fragment for port ${port}…`)}`);
  }

  if (!isLocalDevActive()) {
    info(`  ${yellowArrow}  ${label("host bridge not configured.")}`);
    info("        Run once: `hatchkit dev-setup init` (sets up Caddy + tailscale serve).");
    return;
  }

  const caddyPort = readCaddyPort();
  if (caddyPort === null) {
    info(
      `  ${yellowArrow}  ${label("Caddyfile has no https_port directive — re-run `hatchkit dev-setup init`.")}`,
    );
    return;
  }

  const tsId = await tailscaleIdentity();
  if (!tsId) {
    // Tailscale offline / not installed — silent no-op, the user simply
    // isn't on the tailnet today. The Caddy fragment is still in place
    // for when they come back.
    return;
  }

  const tcpTarget = await tailscaleServeTcpTarget();
  if (tcpTarget === null) {
    info(`  ${yellowArrow}  ${label("no port-443 bridge configured.")}`);
    info(`        Run once: \x1b[2mtailscale serve --bg --tcp=443 tcp://localhost:${caddyPort}\x1b[0m`);
    return;
  }
  if (tcpTarget !== caddyPort) {
    info(
      `  ${yellowArrow}  ${label(`bridge points at localhost:${tcpTarget} but Caddy listens on ${caddyPort}.`)}`,
    );
    info("        Run: `hatchkit dev-setup init` to reconcile.");
    return;
  }

  if (options.silent) return;
  const url = localDevUrl(resolved.slug, resolved.localDevDomain);
  const where = describeSource(resolved);
  info(`  ${greenArrow}  ${label(`\x1b[36m${url}\x1b[0m  \x1b[2m(slug: ${where})\x1b[0m`)}`);
}

function describeSource(resolved: ResolvedSlug): string {
  switch (resolved.source) {
    case "explicit":
      return "option";
    case "manifest":
      return ".hatchkit.json";
    case "package-json":
      return "package.json";
  }
}
