/*
 * Traefik's own health check on an image app's containers, so a stopping
 * container leaves Traefik within seconds without Docker probing every
 * container every few seconds for its whole life.
 *
 * ---------------------------------------------------------------------
 * Why
 * ---------------------------------------------------------------------
 *
 * The drain (see "The last second" in image-runtime.ts) needs Traefik to
 * stop routing to the old container before it closes. Docker's health
 * check can do that, but Docker runs it on a fixed schedule for the
 * container's whole life, one `docker exec` per probe: a schedule fast
 * enough to drain inside `docker stop` costs an exec every few seconds
 * per container, all day, for a handoff that happens during a deploy.
 *
 * Traefik's load-balancer health check is a plain HTTP request from
 * Traefik to each container. One failed check takes the container out of
 * the pool; one passing check puts it back. So the images answer it —
 * a 200 normally, a 503 while draining — and Docker's check can slow
 * down to what Coolify's rolling update needs from it: telling the new
 * container is ready.
 *
 * ---------------------------------------------------------------------
 * How the labels get there
 * ---------------------------------------------------------------------
 *
 * Coolify has no setting for it, and `custom_docker_run_options` ignores
 * `--label`. What it has is `custom_labels`: the app's WHOLE Traefik
 * label set, which Coolify generates and every deploy uses verbatim.
 * hatchkit rewrites that set (verified against 4.0.0-beta.469 and main
 * at 2026-10-14).
 *
 * Two Traefik rules shape the rewrite:
 *
 *   · Traefik merges containers that define the same service into one
 *     pool — that is how old and new share traffic during a rolling
 *     update — and DELETES a service that two containers define
 *     differently, along with every router on it: a 404 for the whole
 *     site. Old and new run side by side on every deploy, so the deploy
 *     that adds the check (old without, new with) would 404 until the
 *     old container exits. So would the deploy after Coolify regenerates
 *     its labels, which it does on a domain change or a save in its UI.
 *   · A router whose servers are all failing the check answers 503; it
 *     does not fall through to another router.
 *
 * So the rewrite RENAMES Coolify's routers and services (`https-0-<uuid>`
 * → `hk-https-0-<uuid>`) — a set Traefik never has to merge with
 * Coolify's — and gives each renamed router a priority ONE BELOW its
 * Coolify twin (Traefik's default is the rule's length). When old and
 * new disagree, the Coolify-named side wins:
 *
 *   · Turning the check on: the old container's Coolify routers carry
 *     all traffic until it leaves on its own Docker-health drain; then
 *     the new container's renamed routers take over.
 *   · Coolify regenerating the labels: the new container's Coolify
 *     routers carry all traffic at once. That one deploy has no Traefik
 *     check; `hatchkit doctor` reports it and `hatchkit sync` restores it.
 *   · `hatchkit sync --no-traefik-drain` writes Coolify's set back on
 *     purpose ({@link coolifyLabelsFrom}); the handover is the same.
 *
 * Everything else in the set — rules, entry points, TLS, middlewares,
 * Caddy labels — is Coolify's text, unchanged.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TRAEFIK_HEALTH } from "./image-runtime.js";

/** The prefix on every router and service hatchkit renamed. */
export const HATCHKIT_LABEL_PREFIX = "hk-";

/** The header Traefik's check sends, which the images answer (drain.cjs,
 *  nginx.conf, the starter server's drain.ts). Only a request WITHOUT
 *  X-Forwarded-For counts: Traefik adds that to every request it
 *  forwards, so a visitor can't pose as the check. */
export const DRAIN_PROBE_HEADER = "X-Hatchkit-Drain";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Coolify's router/service names for this app: `http-<i>-<uuid>` and
 *  `https-<i>-<uuid>` (`fqdnLabelsForTraefik`). Middleware names derived
 *  from them (`https-0-<uuid>-stripprefix`) match too, so they are
 *  renamed along with what references them. */
function coolifyNamePattern(uuid: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_-])(https?-\\d+-${escapeRegExp(uuid)})`, "g");
}

function renamedNamePattern(uuid: string): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9_-])${escapeRegExp(HATCHKIT_LABEL_PREFIX)}(https?-\\d+-${escapeRegExp(uuid)})`,
    "g",
  );
}

/** One label per line, as Coolify stores them. */
function splitLabels(text: string): string[] {
  return text
    .split(/\r\n|\n|\r/)
    .map((l) => l.trimEnd())
    .filter((l) => l !== "");
}

function labelKey(line: string): string {
  const eq = line.indexOf("=");
  return eq === -1 ? line : line.slice(0, eq);
}

function labelValue(line: string): string {
  const eq = line.indexOf("=");
  return eq === -1 ? "" : line.slice(eq + 1);
}

/** Lines only hatchkit writes: the renamed routers' priorities and the
 *  renamed services' health checks. */
function isHatchkitOnlyLine(line: string): boolean {
  const key = labelKey(line);
  const p = escapeRegExp(HATCHKIT_LABEL_PREFIX);
  return (
    new RegExp(`^traefik\\.http\\.routers\\.${p}[^.]+\\.priority$`, "i").test(key) ||
    new RegExp(`^traefik\\.http\\.services\\.${p}[^.]+\\.loadbalancer\\.healthcheck\\.`, "i").test(
      key,
    )
  );
}

export type DrainLabelState =
  /** No Traefik router for this app in the set — nothing to rewrite. */
  | "none"
  /** Coolify's own labels: no Traefik check. */
  | "coolify"
  /** hatchkit's rewrite. */
  | "hatchkit";

/** Which shape an app's label set is in. */
export function drainLabelState(labels: string, uuid: string): DrainLabelState {
  const routerKeys = splitLabels(labels)
    .map(labelKey)
    .filter((k) => /^traefik\.http\.routers\./i.test(k));
  if (routerKeys.some((k) => new RegExp(renamedNamePattern(uuid).source).test(k))) {
    return "hatchkit";
  }
  if (routerKeys.some((k) => new RegExp(coolifyNamePattern(uuid).source).test(k))) {
    return "coolify";
  }
  return "none";
}

/** Coolify's label set back from hatchkit's rewrite. Idempotent; a set
 *  that was never rewritten comes back unchanged. */
export function coolifyLabelsFrom(labels: string, uuid: string): string {
  return splitLabels(labels)
    .filter((l) => !isHatchkitOnlyLine(l))
    .map((l) => l.replace(renamedNamePattern(uuid), "$1"))
    .join("\n");
}

export interface DrainLabelOptions {
  /** The app's Coolify uuid — the one in its generated label names. */
  uuid: string;
  /** Path Traefik's check requests: the app's Docker health path, which
   *  every image already answers 200 on. An image that doesn't know the
   *  probe header answers it like any request, so the check passes and
   *  the deploy drains the old way — never an outage. */
  healthPath: string;
}

/** hatchkit's rewrite of an app's label set (see the top of this file).
 *  Accepts Coolify's set or an earlier rewrite; the result for both is
 *  the same, so comparing it with the stored set says whether a PATCH is
 *  needed. */
export function withTraefikDrain(labels: string, opts: DrainLabelOptions): string {
  const base = splitLabels(coolifyLabelsFrom(labels, opts.uuid));
  const renamed = base.map((l) =>
    l.replace(coolifyNamePattern(opts.uuid), `${HATCHKIT_LABEL_PREFIX}$1`),
  );

  const routerKey = /^traefik\.http\.routers\.([^.]+)\.(.+)$/i;
  const routers = new Map<string, { rule?: string; service?: string; middlewares: string[] }>();
  const ours = (name: string) =>
    name.startsWith(HATCHKIT_LABEL_PREFIX) &&
    new RegExp(
      `^${escapeRegExp(HATCHKIT_LABEL_PREFIX)}https?-\\d+-${escapeRegExp(opts.uuid)}$`,
    ).test(name);
  for (const line of renamed) {
    const m = labelKey(line).match(routerKey);
    if (!m || !ours(m[1])) continue;
    const r = routers.get(m[1]) ?? { middlewares: [] };
    const field = m[2].toLowerCase();
    if (field === "rule") r.rule = labelValue(line);
    if (field === "service") r.service = labelValue(line);
    if (field === "middlewares")
      r.middlewares = labelValue(line)
        .split(",")
        .map((s) => s.trim());
    routers.set(m[1], r);
  }

  const added: string[] = [];
  const checked = new Set<string>();
  for (const [name, r] of routers) {
    // Traefik's default priority is the rule's length; one below loses
    // every tie with the Coolify-named router for the same rule, and
    // still beats a rule two or more characters shorter on the same host
    // (hatchkit's `/` app under its `/api` app differ by three).
    if (r.rule) added.push(`traefik.http.routers.${name}.priority=${r.rule.length - 1}`);
    // A router that only redirects to https never reaches its service.
    if (!r.service || r.middlewares.includes("redirect-to-https")) continue;
    if (checked.has(r.service)) continue;
    checked.add(r.service);
    const svc = `traefik.http.services.${r.service}.loadbalancer.healthcheck`;
    added.push(
      `${svc}.path=${opts.healthPath}`,
      `${svc}.interval=${TRAEFIK_HEALTH.intervalSeconds}s`,
      `${svc}.timeout=${TRAEFIK_HEALTH.timeoutSeconds}s`,
      `${svc}.headers.${DRAIN_PROBE_HEADER}=1`,
    );
  }

  // Coolify sorts its labels; keep the rewrite sorted too, so a stored
  // set compares equal to a fresh rewrite of itself.
  return [...renamed, ...added].sort().join("\n");
}

/** Whether a stored label set already is the rewrite for these options. */
export function hasTraefikDrain(labels: string, opts: DrainLabelOptions): boolean {
  return (
    drainLabelState(labels, opts.uuid) === "hatchkit" &&
    splitLabels(labels).sort().join("\n") === withTraefikDrain(labels, opts)
  );
}

/** Where an image app's code lives in its repo, for {@link imageAnswersDrainProbe}. */
function buildDirsFor(role: "app" | "client" | "server", projectSubdir?: string): string[] {
  const sub = projectSubdir?.replace(/^\.?\/+|\/+$/g, "") ?? "";
  const packages =
    role === "server"
      ? ["packages/server"]
      : role === "client"
        ? ["packages/client"]
        : ["packages/client", "packages/server"];
  return [...new Set([sub, ...packages])];
}

/** Whether the repo's image for this app answers Traefik's drain probe:
 *  its Dockerfile, the drain files hatchkit writes, or a file the
 *  Dockerfile copies in names the probe header. Read from the working
 *  tree, so it says what the NEXT deploy builds — the image that will
 *  be drained the deploy after.
 *
 *  An image that doesn't answer it is never harmed by the check (it
 *  passes like any request), but it drains on Docker's check alone, so
 *  sync keeps Docker's fast timing for it and adds no labels. */
export function imageAnswersDrainProbe(
  projectDir: string,
  role: "app" | "client" | "server",
  projectSubdir?: string,
): boolean {
  const mentions = (rel: string): boolean => {
    const abs = join(projectDir, rel);
    try {
      if (!existsSync(abs) || !statSync(abs).isFile() || statSync(abs).size > 512 * 1024) {
        return false;
      }
      // nginx spells the header `$http_x_hatchkit_drain`.
      return /x[-_]hatchkit[-_]drain/i.test(readFileSync(abs, "utf-8"));
    } catch {
      return false;
    }
  };
  for (const dir of buildDirsFor(role, projectSubdir)) {
    const at = (f: string) => (dir ? `${dir}/${f}` : f);
    if (["Dockerfile", "nginx.conf", "drain.cjs", "src/drain.ts"].some((f) => mentions(at(f)))) {
      return true;
    }
    let dockerfile = "";
    try {
      dockerfile = readFileSync(join(projectDir, at("Dockerfile")), "utf-8");
    } catch {
      continue;
    }
    // `COPY [--flags] <src>... <dest>`: the sources are relative to the
    // build context, which is the repo root or this directory.
    for (const m of dockerfile.matchAll(/^\s*COPY\s+((?:--\S+\s+)*)(.+)$/gim)) {
      if (/--from=/i.test(m[1])) continue;
      const parts = m[2].trim().split(/\s+/);
      for (const src of parts.slice(0, -1)) {
        if (src.startsWith("<<") || src.includes("*")) continue;
        if (mentions(src) || (dir && mentions(at(src)))) return true;
      }
    }
  }
  return false;
}
