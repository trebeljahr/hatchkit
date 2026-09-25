/*
 * cli/src/features/env-agreement/origin-agreement.ts — does every place
 * that carries the default API origin carry the SAME one?
 *
 * The list of places lives in ./sites.ts; this file only compares them
 * against the origin the project is actually deployed at
 * (`defaultApiOrigin`, from ../operational-context.ts — the same
 * function the client build args and the post-deploy gate derive their
 * URLs from, so the check cannot disagree with the generator).
 *
 * Pure over an injected reader on purpose. `hatchkit doctor` passes a
 * reader rooted at the project and the LIVE environment fields it just
 * fetched from the platform; the tests pass a map of strings. Neither
 * path has a branch the other does not exercise.
 */

import type { OperationalProject } from "../operational-context.js";
import { defaultApiOrigin } from "../operational-context.js";
import type { OriginSite, OriginSiteId } from "./sites.js";
import { ORIGIN_SITES, isTripwireOrigin, normalizeOrigin, siteLocation } from "./sites.js";

/**
 * What a single place turned out to hold.
 *
 * Three of these look similar and are not, and keeping them apart is
 * most of what this check is for:
 *
 *   · `absent` — the project has no such surface. A project with no
 *     mobile half has no mobile release workflow, and that is correct
 *     and silent.
 *   · `missing` — the project HAS the surface and its file sets no
 *     origin at all. This is the empty-build-arg failure waiting to
 *     happen: nothing fails, and an empty value ships.
 *   · `enforced` — the file carries no usable literal ON PURPOSE, and
 *     something refuses to build without the real value: a secret the
 *     release plan gates on, or a reserved `.invalid` host that cannot
 *     resolve. That is a considered refusal to guess, not a hole, and
 *     reporting it red would train people to ignore the check. It is
 *     not a finding; the value is still a step a person owes, and the
 *     apply wrapper says so in its notes.
 */
export type SiteStatus = "agrees" | "differs" | "missing" | "absent" | "unreadable" | "enforced";

export interface SiteResult {
  id: OriginSiteId;
  label: string;
  /** Where the value lives: a path relative to the project root, or the
   *  name of the platform environment field. */
  path: string;
  /** The value found, when there was one. */
  found?: string;
  status: SiteStatus;
  /** Present on `enforced`: what refuses to build without the real
   *  value, in one line. */
  detail?: string;
}

/** Reads a path relative to the project root.
 *
 *  Returns null when there is no such file. THROWS when the file exists
 *  and cannot be read — the two cases get different statuses, because
 *  "you have no mobile app" and "I could not open your mobile release
 *  workflow" are not the same news. */
export type ProjectFileReader = (relPath: string) => string | null;

export interface ApiOriginAgreementInput {
  project: OperationalProject;
  readFile: ProjectFileReader;
  /** The deployed application's environment fields, when the caller has
   *  them. Left out (rather than empty) means "I did not fetch them":
   *  the platform-held sites then report `unreadable` instead of
   *  claiming the field is unset. */
  platformEnv?: Record<string, string>;
  /** Override the list of places. Only tests and the document renderer
   *  pass this; every real caller wants {@link ORIGIN_SITES}. */
  sites?: readonly OriginSite[];
}

export interface ApiOriginAgreementResult {
  /** True when nothing that could be read disagrees.
   *
   *  `unreadable` sites do NOT make this false: a doctor run without
   *  platform credentials still wants to compare the places it CAN see,
   *  and reporting a red because a value was not fetched trains people
   *  to ignore the check. The report says the run was incomplete.
   *
   *  Neither do `enforced` sites. A workflow that refuses to build
   *  without the real value is the failure already prevented, and
   *  colouring it red would be reporting the fix. */
  ok: boolean;
  /** The origin every site is compared against. */
  expected: string;
  sites: SiteResult[];
}

/** Compare every place that carries the default API origin.
 *
 *  The expected value is derived, never read from one of the sites: if
 *  the check took the server's value as the truth, a project whose
 *  server is the wrong one would report full agreement. */
export function checkApiOriginAgreement(input: ApiOriginAgreementInput): ApiOriginAgreementResult {
  const { project, readFile, platformEnv } = input;
  const sites = input.sites ?? ORIGIN_SITES;
  const expected = normalizeOrigin(defaultApiOrigin(project.domain, project.topology));

  const results = sites.map((site) => inspectSite(site, project, readFile, platformEnv, expected));
  const ok = !results.some((r) => r.status === "differs" || r.status === "missing");
  return { ok, expected, sites: results };
}

function inspectSite(
  site: OriginSite,
  project: OperationalProject,
  readFile: ProjectFileReader,
  platformEnv: Record<string, string> | undefined,
  expected: string,
): SiteResult {
  const base = { id: site.id, label: site.label, path: siteLocation(site) };
  const required = site.required(project);

  if (site.source === "platform-env") {
    // No env map at all means the caller never asked the platform, not
    // that the field is empty. Saying "missing" there would send someone
    // to set a field that is probably already correct.
    if (!platformEnv) return { ...base, status: required ? "unreadable" : "absent" };
    const value = platformEnv[site.key];
    if (value === undefined || value.trim() === "") {
      return { ...base, status: required ? "missing" : "absent" };
    }
    return verdict(base, normalizeOrigin(value), expected);
  }

  let content: string | null;
  try {
    content = readFile(site.path);
  } catch {
    // The file is there and could not be read (permissions, a broken
    // symlink, an encoding the reader refused). Nothing can be
    // concluded, so nothing is claimed.
    return { ...base, status: "unreadable" };
  }
  if (content === null) return { ...base, status: required ? "missing" : "absent" };

  const found = site.find(content);

  // A reserved `.invalid` host is never somebody's server, so a literal
  // under it is a tripwire the workflow put there rather than a value
  // that drifted. Checked before the comparison, because comparing it
  // would report the safety net as the accident.
  if (found !== null && isTripwireOrigin(found)) {
    return {
      ...base,
      found,
      status: "enforced",
      detail:
        site.enforces?.(content) ??
        `${found} cannot resolve, so a build with no value set fails rather than calling a ` +
          "plausible-looking host",
    };
  }

  if (found === null) {
    // No literal. Whether that is a hole or a deliberate refusal to
    // guess is the site's own knowledge — see FileSite.enforces.
    const reason = site.enforces?.(content);
    if (reason) return { ...base, status: "enforced", detail: reason };
    return { ...base, status: "missing" };
  }

  return verdict(base, found, expected);
}

function verdict(
  base: { id: OriginSiteId; label: string; path: string },
  found: string,
  expected: string,
): SiteResult {
  return { ...base, found, status: found === expected ? "agrees" : "differs" };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Render the result as lines for doctor-style output.
 *
 *  Every disagreement is reported as its SYMPTOM — what a user would
 *  report, and what it costs to fix — rather than as two strings that
 *  differ. A line that says `"https://a" !== "https://b"` tells a reader
 *  nothing they could not see; a line that says the shipped bundle calls
 *  a dead API and only a rebuild can change it tells them what to do
 *  next. */
export function renderApiOriginAgreement(
  result: ApiOriginAgreementResult,
  sites: readonly OriginSite[] = ORIGIN_SITES,
): string[] {
  const byId = new Map(sites.map((s) => [s.id, s]));
  const lines: string[] = [`Default API origin: ${result.expected}`];

  for (const site of result.sites) {
    if (site.status === "absent") continue;
    const symptom = byId.get(site.id)?.symptom ?? "";
    switch (site.status) {
      case "agrees":
        lines.push(`  ok    ${site.label} (${site.path}) — ${site.found}`);
        break;
      case "differs":
        lines.push(`  FAIL  ${site.label} (${site.path})`);
        lines.push(`        holds ${site.found}, the deployment serves ${result.expected}`);
        lines.push(`        ${symptom}`);
        break;
      case "missing":
        lines.push(`  FAIL  ${site.label} (${site.path}) sets no origin at all`);
        lines.push(`        expected ${result.expected}`);
        lines.push(`        ${symptom}`);
        break;
      case "enforced":
        // Not a finding, but not silence either: the value is still owed
        // by a person, and a reader who sees no line for a native
        // surface concludes the origin is already set there.
        lines.push(`  ok    ${site.label} (${site.path}) carries no default on purpose`);
        lines.push(`        ${site.detail ?? ""}`);
        break;
      case "unreadable":
        lines.push(`  ?     ${site.label} (${site.path}) could not be read — not compared`);
        break;
    }
  }

  if (result.sites.every((s) => s.status === "absent")) {
    lines.push("  this project carries the API origin nowhere — nothing to compare");
  }
  return lines;
}
