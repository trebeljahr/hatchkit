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

import type { GlitchtipConfig } from "../config.js";
import { ensureGlitchtip } from "../config.js";
import type { RemoteProject } from "./project-lookup.js";

export interface GlitchtipClient {
  projectSlug: string;
  dsn: string;
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
  return { projectSlug, dsn };
}

export async function provisionGlitchtipClient(clientName: string): Promise<GlitchtipClient> {
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
      platform: "javascript-node",
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
