/*
 * The reverse-proxy config for the self-host stack — the one file that
 * decides which half of the app answers a request.
 *
 * ---------------------------------------------------------------------
 * Two rules, both of which are how this breaks in practice
 * ---------------------------------------------------------------------
 *
 * 1. **A socket route must not strip its prefix.** The server compares
 *    the upgrade path LITERALLY against the path it listens on and
 *    destroys the socket on anything else. A rule that stripped the
 *    prefix therefore produces a connection that dies with no error the
 *    browser can explain — the app works, nothing updates live, and the
 *    proxy logs a 502 with no hint that a rewrite caused it. In Caddy
 *    that means `handle`, never `handle_path`.
 *
 * 2. **A static catch-all must never swallow the API.** A catch-all that
 *    answers the session endpoint returns the app shell with a 200. That
 *    reaches the browser as a bizarre auth failure — a sign-in form that
 *    posts successfully and stays signed out — rather than as the routing
 *    bug it is. Caddy sorts `handle` blocks by path specificity, not by
 *    file order, so the bare `handle` always runs last whatever its
 *    position. Another proxy may evaluate rules in file order, and then
 *    the API rules MUST come first — which is why {@link proxyRoutes}
 *    returns them most-specific-first and the renderer keeps that order.
 *
 * The build-info file is served with `no-cache` on top of that. The
 * deploy-recovery feature asks the DEPLOYED artefact what it is by
 * fetching it, and owns the client side; this file owns the proxy side.
 * A cached copy would let a rolled-back deploy keep reporting the commit
 * it no longer serves.
 */

import type { OperationalProject } from "../operational-context.js";
import { hasServerHalf } from "../operational-context.js";
import {
  PROXY_CONFIG_REL,
  type SelfHostOptions,
  ownedFileHeader,
  selfHostPlan,
} from "./compose.js";

export { PROXY_CONFIG_REL };

/** What a route is for. The tests key off this rather than off the path
 *  string, so a project that mounts its API elsewhere keeps the same
 *  invariants. */
export type ProxyRouteKind = "buildinfo" | "socket" | "api" | "catchall";

export interface ProxyRoute {
  kind: ProxyRouteKind;
  /** Match expression, in the proxy's own syntax. */
  path: string;
  /** Which half answers. */
  target: "server" | "client";
  /** `service:port` on the compose network. */
  upstream: string;
  /** Always false. The matched prefix has to survive to the upstream —
   *  rule 1 in the module header. */
  stripPrefix: boolean;
  /** Response headers the proxy sets on this route. */
  headers: ReadonlyArray<readonly [string, string]>;
  /** Comment lines emitted above the rule, without the leading `#`. */
  comment: readonly string[];
}

/** The path the build-info file is served at. Fixed, because the deploy
 *  pipeline writes it there and polls it there. */
export const BUILD_INFO_PATH = "/version.json";

/**
 * Every route, most specific first.
 *
 * Order is part of the contract, not a rendering detail: a proxy that
 * evaluates rules in file order gets the API before the catch-all, and a
 * proxy that sorts by specificity gets the same answer anyway.
 *
 * Shape handling:
 *   · no `websocket` feature → no socket route at all;
 *   · a `backend` project has no client half, so every route targets the
 *     server and the build-info route is absent (there is no static
 *     export to stamp);
 *   · a `static` project has no server half and gets no routes — the
 *     whole feature is skipped for it upstream.
 */
export function proxyRoutes(project: OperationalProject, opts: SelfHostOptions = {}): ProxyRoute[] {
  if (!hasServerHalf(project.surfaces)) return [];
  const plan = selfHostPlan(project, opts);
  const server = `server:${plan.ports.server}`;
  const client = `client:${plan.ports.client}`;
  const routes: ProxyRoute[] = [];

  if (plan.hasClient) {
    routes.push({
      kind: "buildinfo",
      path: BUILD_INFO_PATH,
      target: "client",
      upstream: client,
      stripPrefix: false,
      headers: [["Cache-Control", "no-cache"]],
      comment: [
        "── The build info ───────────────────────────────────────────────",
        'Served with no-cache because it is the answer to "what is actually',
        'deployed right now". A cached copy would let a rolled-back deploy',
        "keep reporting the commit it no longer serves, which is precisely",
        "the failure this file exists to make visible.",
      ],
    });
  }

  if (plan.hasSocket) {
    routes.push({
      kind: "socket",
      path: plan.socketPath,
      target: "server",
      upstream: server,
      stripPrefix: false,
      headers: [],
      comment: [
        "── The socket ───────────────────────────────────────────────────",
        "`handle`, NEVER `handle_path`: the server compares the upgrade",
        `path literally against "${plan.socketPath}" and destroys the socket on`,
        "anything else, so a rule that stripped the prefix would produce a",
        "connection that dies with no error the browser can explain. If you",
        "put another proxy or a CDN in front of this one, check it too.",
        "",
        "The upgrade is proxied natively, and Cookie and",
        "Sec-WebSocket-Protocol pass through — the first is how the web app",
        "authenticates, the second is how a token-carrying client does.",
      ],
    });
  }

  routes.push({
    kind: "api",
    path: `${plan.apiPrefix}/*`,
    target: "server",
    upstream: server,
    stripPrefix: false,
    headers: [],
    comment: [
      "── The API ──────────────────────────────────────────────────────",
      "This must win over the catch-all below. Caddy sorts `handle` blocks",
      "by path specificity, not file order, so it does wherever it is",
      "written — but keep the order in mind when porting to a proxy that",
      "matches in file order. A static handler that swallows",
      `${plan.apiPrefix}/auth/get-session answers it with the app shell and a 200,`,
      "which reaches the browser as a bizarre auth failure rather than as",
      "the routing bug it is.",
      "",
      "The prefix is NOT stripped. The server mounts its routes under",
      `${plan.apiPrefix}, so a stripping rule would deliver ${plan.apiPrefix}/health to it as`,
      "/health and every API call would 404.",
      "",
      "reverse_proxy sets X-Forwarded-For / -Proto / -Host by default.",
      "Without those headers the auth layer cannot determine a client IP",
      "and silently disables its own rate limiting on sign-in and password",
      "reset, announcing it in one easily-missed log line.",
    ],
  });

  routes.push(
    plan.hasClient
      ? {
          kind: "catchall",
          path: "/*",
          target: "client",
          upstream: client,
          stripPrefix: false,
          headers: [],
          comment: [
            "── The web app ──────────────────────────────────────────────────",
            "Least specific, so it runs only when no rule above matched.",
          ],
        }
      : {
          kind: "catchall",
          path: "/*",
          target: "server",
          upstream: server,
          stripPrefix: false,
          headers: [],
          comment: [
            "── Everything else ──────────────────────────────────────────────",
            "This project has no web half, so the server answers the whole",
            "domain and not only its API prefix.",
          ],
        },
  );

  return routes;
}

/** Render the routes as a Caddyfile.
 *
 *  `handle` throughout, never `handle_path` — see rule 1 in the module
 *  header. The catch-all is emitted as a bare `handle` with no matcher,
 *  which is Caddy's way of saying "whatever is left". */
export function renderProxyConfig(project: OperationalProject, opts: SelfHostOptions = {}): string {
  const routes = proxyRoutes(project, opts);
  const lines: string[] = [
    ...ownedFileHeader(),
    "# Reverse proxy for the SELF-HOST stack — see docker-compose.selfhost.yml.",
    "#",
    "# ONE domain, routed by path:",
    "#",
    ...routes.map(
      (r) =>
        `#   https://{$APP_DOMAIN}${r.path === "/*" ? "/*" : r.path}${" ".repeat(Math.max(1, 24 - r.path.length))}->  ${r.upstream}`,
    ),
    "#",
    "# Everything the browser loads and everything it calls therefore share",
    "# one origin. That is what lets the web image be built with an EMPTY API",
    "# URL and still work on anybody's domain: with no URL compiled in, the",
    "# bundle calls relative paths and derives its socket URL from the page's",
    "# own origin. The alternative — a second api.<domain> and a URL compiled",
    "# into the bundle — makes the image domain-specific and adds a DNS",
    "# record, a second certificate and a CORS/cookie surface to get wrong.",
    "#",
    "# This file is NOT part of the owner's production deploy, where the",
    "# platform's own proxy does the routing.",
    "",
    "{$APP_DOMAIN} {",
    "\t# Automatic HTTPS. Caddy provisions and renews a certificate for",
    "\t# {$APP_DOMAIN} on first request, which needs the A/AAAA record to",
    "\t# point here and ports 80 and 443 to be reachable from the internet —",
    "\t# port 80 is not decoration, the ACME HTTP challenge is answered on it.",
    "\t#",
    "\t# A local trial: APP_DOMAIN=localhost with no APP_URL serves HTTPS on",
    "\t# Caddy's internal certificate. APP_DOMAIN=http://localhost with",
    "\t# APP_URL=http://localhost serves plain HTTP. Do not mix the two — a",
    "\t# bare `localhost` site redirects http:// to https://, so an http://",
    "\t# APP_URL would name an origin the browser never ends up on, and the",
    "\t# literal origin comparison would refuse every sign-in.",
    "",
    "\tencode zstd gzip",
  ];

  for (const route of routes) {
    lines.push("");
    for (const line of route.comment) lines.push(line ? `\t# ${line}` : "\t#");
    const matcher = route.kind === "catchall" ? "handle" : `handle ${route.path}`;
    lines.push(`\t${matcher} {`);
    for (const [name, value] of route.headers) {
      lines.push(`\t\theader ${name} "${value}"`);
    }
    lines.push(`\t\treverse_proxy ${route.upstream}`);
    lines.push("\t}");
  }

  lines.push("}", "");
  return lines.join("\n");
}
