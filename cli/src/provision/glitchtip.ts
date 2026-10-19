/*
 * GlitchTip provisioning — creates a project inside an existing
 * self-hosted GlitchTip org and returns the public DSN.
 *
 * GlitchTip exposes a Sentry-compatible API:
 *   GET  /api/0/organizations/{org}/projects/   -> list projects (paginated)
 *   POST /api/0/teams/{org}/{team}/projects/    -> create project
 *   GET  /api/0/projects/{org}/{project}/keys/  -> list client keys (DSN)
 *
 * Auth is a personal auth token in `Authorization: Bearer`.
 *
 * Note on existence checks: `/keys/` answers `200 []` for a slug that
 * does not exist — it does not 404. Nothing here may infer existence
 * from its status code; the org listing is the only honest source, and
 * `project-lookup.ts` is the one place that asks.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GlitchtipConfig } from "../config.js";
import { ensureGlitchtip } from "../config.js";
import { ERROR_REPORTING_DSN_VAR } from "../features/error-reporting/render.js";
import type { RemoteProject } from "./project-lookup.js";

export interface GlitchtipClient {
  projectSlug: string;
  dsn: string;
}

/** The server env var hatchkit's starter reads its DSN from
 *  (`packages/server/src/config/env.ts`, `instrument.ts`). */
export const SENTRY_DSN_KEY = "SENTRY_DSN";

/** The client build variable (a repo VARIABLE, see
 *  `features/error-reporting/render.ts`). */
export const CLIENT_DSN_VAR = ERROR_REPORTING_DSN_VAR;

/** Every name a DSN is written under, per side. The `GLITCHTIP_*` names
 *  are the original ones, still read by projects scaffolded from the
 *  legacy templates and by `hatchkit add`'s "already added" check; the
 *  Sentry names are what the starter reads. Writing only the first pair
 *  produced a DSN no scaffolded app ever read (2026-10-19). */
export const GLITCHTIP_SERVER_ENV_KEYS = ["GLITCHTIP_DSN", SENTRY_DSN_KEY] as const;
export const GLITCHTIP_CLIENT_ENV_KEYS = ["PUBLIC_GLITCHTIP_DSN", CLIENT_DSN_VAR] as const;

/** `KEY=dsn` lines for one side of a project. */
export function renderGlitchtipEnv(c: GlitchtipClient, forClient: boolean): string[] {
  const keys = forClient ? GLITCHTIP_CLIENT_ENV_KEYS : GLITCHTIP_SERVER_ENV_KEYS;
  return keys.map((key) => `${key}=${c.dsn}`);
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The DSN's host when it is not the host hatchkit reaches GlitchTip at,
 *  else undefined.
 *
 *  GlitchTip builds every DSN from its own `GLITCHTIP_DOMAIN` setting,
 *  not from the address the API was called on. On 2026-10-19 the
 *  shared server ran with the compose default
 *  `GLITCHTIP_DOMAIN=https://glitchtip.example.com`, so every DSN it
 *  handed out sent events to example.com, and nothing noticed. */
export function dsnHostMismatch(
  dsn: string,
  configuredUrl: string,
): { dsnHost: string; configuredHost: string } | undefined {
  const dsnHost = hostOf(dsn);
  const configuredHost = hostOf(configuredUrl);
  if (!dsnHost || !configuredHost || dsnHost === configuredHost) return undefined;
  return { dsnHost, configuredHost };
}

/** Throws when `dsn` points somewhere other than `cfg.url`. Writing it
 *  would wire an app to a host that never receives its events. `next`
 *  finishes the message with how to retry once the server is fixed. */
export function assertDsnHost(cfg: GlitchtipConfig, dsn: string, next: string): void {
  const mismatch = dsnHostMismatch(dsn, cfg.url);
  if (!mismatch) return;
  throw new Error(
    `GlitchTip returned a DSN for ${mismatch.dsnHost}, but hatchkit reaches GlitchTip at ${mismatch.configuredHost}. ` +
      `The server's GLITCHTIP_DOMAIN points at ${mismatch.dsnHost}, so no event sent with this DSN would arrive. ` +
      `Set GLITCHTIP_DOMAIN=${cfg.url.replace(/\/$/, "")} in the GlitchTip service env and redeploy it, then ${next}`,
  );
}

function adoptNext(projectSlug: string): string {
  return `re-run with --adopt (project '${projectSlug}' exists). Nothing was written.`;
}

function requireOrg(cfg: GlitchtipConfig): { base: string; org: string } {
  if (!cfg.organizationSlug) {
    throw new Error(
      "GlitchTip config is missing organization slug. Re-run `hatchkit config add glitchtip`.",
    );
  }
  return { base: cfg.url.replace(/\/$/, ""), org: cfg.organizationSlug };
}

/** Follow GlitchTip's `Link` header to the next page.
 *
 *  The header is a Sentry-style cursor list, and self-hosted GlitchTip
 *  has been seen serving it wrapped in a Python `set` repr
 *  (`{'<url>; rel="next"; results="false"'}`), so parse it tolerantly
 *  rather than with a strict RFC 8288 reader. `results="false"` means
 *  the next page is empty — that's the stop condition, not a missing
 *  header. */
export function nextPageUrl(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(/,\s*(?=<)/)) {
    if (!/rel=["']?next["']?/.test(part)) continue;
    if (/results=["']?false["']?/.test(part)) return undefined;
    const url = part.match(/<([^>]+)>/)?.[1];
    if (url) return url;
  }
  return undefined;
}

/** Every project in the configured org. Paginated: an org with more
 *  than one page used to make any list-based check silently wrong for
 *  the projects past the first page. */
export async function listGlitchtipProjects(cfg: GlitchtipConfig): Promise<RemoteProject[]> {
  const { base, org } = requireOrg(cfg);
  const headers = { Authorization: `Bearer ${cfg.token}` };
  let url: string | undefined = `${base}/api/0/organizations/${org}/projects/`;
  const projects: RemoteProject[] = [];
  // Bounded so a provider that always advertises a next page can't
  // spin here forever.
  for (let page = 0; url && page < 50; page++) {
    const res: Response = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`GlitchTip list projects failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as unknown;
    if (Array.isArray(body)) {
      projects.push(...(body as RemoteProject[]));
    }
    url = nextPageUrl(res.headers.get("link"));
  }
  return projects;
}

/** Public DSN of an existing project, addressed by slug. Returns
 *  `undefined` when the project has no client keys — which is also what
 *  a nonexistent slug looks like, so only call this for a slug the
 *  resolver has already confirmed. */
export async function getGlitchtipDsn(
  cfg: GlitchtipConfig,
  projectSlug: string,
): Promise<string | undefined> {
  const { base, org } = requireOrg(cfg);
  const res = await fetch(`${base}/api/0/projects/${org}/${projectSlug}/keys/`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) {
    throw new Error(`GlitchTip fetch keys failed: HTTP ${res.status} ${await res.text()}`);
  }
  const keys = (await res.json()) as Array<{ dsn?: { public?: string } }>;
  return keys.find((key) => key.dsn?.public)?.dsn?.public;
}

/** Read the DSN of a project that already exists, without creating
 *  anything. `projectSlug` comes from the resolver, because a project
 *  named `foo` may live at slug `foo-2` when the name was taken. */
export async function adoptGlitchtipClient(projectSlug: string): Promise<GlitchtipClient> {
  const cfg = await ensureGlitchtip();
  const dsn = await getGlitchtipDsn(cfg, projectSlug);
  if (!dsn) {
    throw new Error(
      `GlitchTip project '${projectSlug}' exists but has no client keys — create one in the GlitchTip UI (Settings → Client Keys) and re-run.`,
    );
  }
  assertDsnHost(cfg, dsn, adoptNext(projectSlug));
  return { projectSlug, dsn };
}

/** The SDK label a new project gets. GlitchTip uses it for the project
 *  icon and the setup instructions it shows; events work either way.
 *  Every project used to be `javascript-node`, browser-only apps too. */
export type GlitchtipPlatform = "javascript-node" | "javascript-nextjs" | "javascript-browser";

/** Which events the project receives: a server's, a client's, or both
 *  through one shared DSN. */
export type GlitchtipProjectRole = "server" | "client" | "shared";

/** The platform for a project by what reports to it. `javascript-node`
 *  only when a server does (a shared project is mostly the server's);
 *  a client-only project is Next.js or plain browser JavaScript. */
export function glitchtipPlatformFor(
  role: GlitchtipProjectRole,
  clientIsNext: boolean,
): GlitchtipPlatform {
  if (role !== "client") return "javascript-node";
  return clientIsNext ? "javascript-nextjs" : "javascript-browser";
}

/** True when the first `package.json` found in `dirs` depends on `next`. */
export function packageUsesNext(dirs: ReadonlyArray<string | undefined>): boolean {
  for (const dir of dirs) {
    if (!dir) continue;
    const path = join(dir, "package.json");
    if (!existsSync(path)) continue;
    try {
      const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return !!(pkg.dependencies?.next ?? pkg.devDependencies?.next);
    } catch {
      return false;
    }
  }
  return false;
}

export async function provisionGlitchtipClient(
  clientName: string,
  platform: GlitchtipPlatform = "javascript-node",
): Promise<GlitchtipClient> {
  const cfg = await ensureGlitchtip();
  const { base, org } = requireOrg(cfg);
  const { teamSlug, token } = cfg;
  if (!teamSlug) {
    throw new Error(
      "GlitchTip config is missing organization/team slug. Re-run `hatchkit config add glitchtip`.",
    );
  }

  const createRes = await fetch(`${base}/api/0/teams/${org}/${teamSlug}/projects/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: clientName,
      slug: clientName,
      platform,
    }),
  });

  if (!createRes.ok && createRes.status !== 409) {
    throw new Error(
      `GlitchTip create project failed: HTTP ${createRes.status} ${await createRes.text()}`,
    );
  }

  // GlitchTip disambiguates a taken slug rather than reusing it, so the
  // created project is not necessarily at `clientName` — read the slug
  // back off the create response and address the keys by that.
  let slug = clientName;
  if (createRes.ok) {
    const created = (await createRes.json().catch(() => ({}))) as { slug?: string };
    if (typeof created.slug === "string" && created.slug) slug = created.slug;
  }

  const dsn = await getGlitchtipDsn(cfg, slug);
  if (!dsn) throw new Error(`GlitchTip project '${slug}' has no client keys`);
  assertDsnHost(cfg, dsn, adoptNext(slug));
  return { projectSlug: slug, dsn };
}

export type DeleteResult = "deleted" | "not-found";

/** Delete a GlitchTip project. 404 → "not-found" (already gone). */
export async function deleteGlitchtipClient(clientName: string): Promise<DeleteResult> {
  const cfg = await ensureGlitchtip();
  const { base, org } = requireOrg(cfg);

  const res = await fetch(`${base}/api/0/projects/${org}/${clientName}/`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${cfg.token}` },
  });

  if (res.status === 404) return "not-found";
  if (!res.ok) {
    throw new Error(`GlitchTip delete project failed: HTTP ${res.status} ${await res.text()}`);
  }
  return "deleted";
}
