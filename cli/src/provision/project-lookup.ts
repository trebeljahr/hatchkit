/*
 * One resolver for "does this project already exist on the provider?".
 *
 * There used to be two answers to that question and they disagreed:
 * `hatchkit add`'s preflight probed a per-project endpoint and read
 * "not a 404" as "exists", while `hatchkit inventory` listed the org
 * and matched names. GlitchTip's `/api/0/projects/{org}/{slug}/keys/`
 * answers `200 []` for a slug that does not exist, so the probe said
 * yes for every name ever passed to it — `add` refused to run while
 * `inventory` reported the same resource missing, and there was no
 * route to the DSN from either side.
 *
 * Both callers now go through here: list the provider's projects, match
 * by name/slug/id. Existence is decided by what the org actually
 * contains, never by a status code from a per-resource endpoint, and
 * never by a locally cached credential (a keychain entry proves hatchkit
 * once created something, not that it is still there).
 */

import type { GlitchtipConfig } from "../config.js";
import { listGlitchtipProjects } from "./glitchtip.js";

/** A project as the provider reports it. Providers fill different
 *  subsets: GlitchTip has name+slug. */
export interface RemoteProject {
  name?: string;
  slug?: string;
  id?: string;
  platform?: string;
}

export interface ProjectMatch extends RemoteProject {
  /** How to address this project in the provider's API paths —
   *  GlitchTip routes by slug. Falls back to the
   *  display name when the provider reports neither. */
  identity: string;
  /** Which candidate name matched, so callers can say *why* something
   *  is considered this project's. */
  matchedAs: string;
}

/** Every name one hatchkit project may wear on a provider: the base
 *  name plus the per-surface suffixes the split layouts create. Order
 *  is significant — it is what the "no project matching …" message
 *  lists, and the first match wins when several candidates hit. */
export function projectNameCandidates(baseName: string): string[] {
  return [
    baseName,
    `${baseName}-server`,
    `${baseName}-client`,
    `${baseName}-web`,
    `${baseName}-api`,
  ];
}

function normalize(value: string | undefined): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

/** Match a provider's project list against a candidate name list.
 *  A project matches when *any* of its identifiers (name, slug, id)
 *  equals a candidate, case-insensitively.
 *
 *  Matching on the display name as well as the slug is deliberate:
 *  GlitchTip lets two projects share a name and disambiguates the slug
 *  (`foo`, `foo-2`, `foo-3`), so a name-only collision is still a
 *  collision — creating through it silently mints a duplicate. */
export function matchRemoteProjects(
  projects: RemoteProject[],
  candidates: string[],
): ProjectMatch[] {
  const wanted = new Map<string, string>();
  for (const candidate of candidates) {
    const key = normalize(candidate);
    if (key && !wanted.has(key)) wanted.set(key, candidate);
  }

  const matches: ProjectMatch[] = [];
  for (const project of projects) {
    // Candidate order decides `matchedAs`, so scan the candidates
    // rather than the identifiers: a project whose slug is `foo-api`
    // and whose name is `foo` reports the earlier candidate.
    for (const [key, candidate] of wanted) {
      if (
        normalize(project.name) === key ||
        normalize(project.slug) === key ||
        normalize(project.id) === key
      ) {
        matches.push({
          ...project,
          identity: project.slug ?? project.id ?? project.name ?? candidate,
          matchedAs: candidate,
        });
        break;
      }
    }
  }
  return matches;
}

/** The alias-based question `inventory` asks: "is anything on this
 *  provider this project's?" */
export function matchProjectsForBaseName(
  projects: RemoteProject[],
  baseName: string,
): ProjectMatch[] {
  return matchRemoteProjects(projects, projectNameCandidates(baseName));
}

export async function resolveGlitchtipProjects(
  cfg: GlitchtipConfig,
  candidates: string[],
): Promise<{ projects: RemoteProject[]; matches: ProjectMatch[] }> {
  const projects = await listGlitchtipProjects(cfg);
  return { projects, matches: matchRemoteProjects(projects, candidates) };
}
