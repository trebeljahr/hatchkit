/*
 * cli/src/features/env-agreement/index.ts — entry point for the
 * env-agreement module of the operational layer.
 *
 * Two questions, one module, because they are the same question asked
 * of two halves of a deployment:
 *
 *   · does every place that carries the default API origin carry the
 *     SAME one? (./origin-agreement.ts, over ./sites.ts)
 *   · does production environment actually reach the running container?
 *     (./runtime-env.ts)
 *
 * ---------------------------------------------------------------------
 * Why this module writes almost nothing
 * ---------------------------------------------------------------------
 *
 * An earlier version of it rewrote the native release workflows, so that
 * each one carried a literal origin hatchkit had stamped in. That was
 * the wrong answer to the right problem, and the starter now carries a
 * better one:
 *
 *   · `mobile-release.yml` reads `${{ secrets.NEXT_PUBLIC_API_URL }}`,
 *     and its plan job FAILS THE RUN when that secret is empty. Nothing
 *     is built against an origin nobody set.
 *   · `desktop-release.yml` falls back to a name under `.invalid`, which
 *     RFC 2606 guarantees can never resolve. A build with no repository
 *     variable set fails at its first request instead of shipping an
 *     installer that calls a plausible-looking host.
 *
 * Both refuse to guess, at the one moment guessing is expensive: the
 * value is baked into an artifact that a redeploy cannot correct. A
 * literal hatchkit wrote is a guess — a correct one on the day of the
 * scaffold, and a stale one from the first domain change onwards.
 *
 * So this module only reads those files, and the CHECK understands what
 * it is looking at: a deliberate refusal is `enforced`, not `missing`
 * (see SiteStatus in ./origin-agreement.ts). What it still catches is a
 * value that is present and WRONG — a literal naming a host that is not
 * this project's API origin.
 *
 * The one file written is `docs/env-sources.md`, generated from
 * {@link ORIGIN_SITES} so the page and the check can never disagree
 * about how many places there are. Everything else a person owes — a
 * secret, a repository variable, an environment field on the platform —
 * lands in the outcome's notes, because only a person can do it.
 *
 * Both checks are exported for `hatchkit doctor`, are pure over an
 * injected reader, and write nothing: a diagnosis that mutates the
 * project it is diagnosing is not a diagnosis.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OperationalContext, OperationalOutcome } from "../operational-context.js";
import { applied, defaultApiOrigin, hasServerHalf, skipped } from "../operational-context.js";
import { ENV_SOURCES_DOC_REL_PATH, renderEnvSourcesDoc } from "./doc.js";
import type { ProjectFileReader } from "./origin-agreement.js";
import { checkApiOriginAgreement } from "./origin-agreement.js";
import { ORIGIN_SITES } from "./sites.js";

export type {
  ApiOriginAgreementInput,
  ApiOriginAgreementResult,
  ProjectFileReader,
  SiteResult,
  SiteStatus,
} from "./origin-agreement.js";
export { checkApiOriginAgreement, renderApiOriginAgreement } from "./origin-agreement.js";
export type {
  ComposeFileInput,
  EnvFileFacts,
  RuntimeEnvFinding,
  RuntimeEnvFindingCode,
  RuntimeEnvSourceInput,
  RuntimeEnvSourceResult,
} from "./runtime-env.js";
export {
  checkRuntimeEnvSource,
  collectComposeVariables,
  isGitIgnored,
  renderRuntimeEnvSource,
  runtimeStageCopies,
} from "./runtime-env.js";
export type { FileSite, OriginSite, OriginSiteId, PlatformEnvSite } from "./sites.js";
export {
  NATIVE_API_URL_KEY,
  ORIGIN_SITES,
  extractOriginLiteral,
  isTripwireOrigin,
  normalizeOrigin,
  siteLocation,
} from "./sites.js";
export { ENV_SOURCES_DOC_REL_PATH, renderEnvSourcesDoc } from "./doc.js";

/** A reader for {@link checkApiOriginAgreement} rooted at a project.
 *
 *  Returns null for a file that is not there and lets a genuine read
 *  error propagate, which is the contract the check distinguishes on:
 *  "you have no mobile app" and "I could not open your mobile release
 *  workflow" must not collapse into one answer.
 *
 *  `hatchkit doctor` uses this; {@link applyEnvAgreement} reads through
 *  the ledger instead, so that one object sees every file the run
 *  touched. */
export function projectFileReader(projectDir: string): ProjectFileReader {
  return (relPath: string) => {
    const path = join(projectDir, relPath);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  };
}

/** Write the project's `docs/env-sources.md` and report what the
 *  repository's own copies of the API origin currently say.
 *
 *  The document is owned and regenerated: `writeIfChanged` is right for
 *  it because it is derived entirely from {@link ORIGIN_SITES} and the
 *  manifest, and a hand-edit that survived would be a page claiming a
 *  different set of places than the check compares. A second apply
 *  writes nothing, because the rendered page is a pure function of its
 *  inputs.
 *
 *  Nothing else is written. The notes carry only what a person has to
 *  do: a repository secret, a repository variable, an environment field
 *  on the deployed application. The ledger reports the file. */
export function applyEnvAgreement(ctx: OperationalContext): OperationalOutcome {
  const project = ctx.project;

  // Both rules are about a server: an origin its clients have to agree
  // on, and production environment reaching its container. A static
  // project has neither, and a page explaining rules it cannot break is
  // the kind of generated document people learn to skip.
  if (!hasServerHalf(project.surfaces)) {
    return skipped("this project has no server half, so nothing carries an API origin");
  }

  ctx.ledger.writeIfChanged(ENV_SOURCES_DOC_REL_PATH, renderEnvSourcesDoc(project));

  const expected = defaultApiOrigin(project.domain, project.topology);
  const notes: string[] = [
    `Set BETTER_AUTH_URL=${expected} in the deployed application's environment fields — ` +
      "production environment lives there, not in a file in the repository",
  ];

  // Report what the repository already holds. No platform env is passed:
  // this runs at scaffold/update time, with no credentials in hand, so
  // the platform-held sites come back unreadable and are left alone.
  const agreement = checkApiOriginAgreement({
    project,
    readFile: (relPath) => ctx.ledger.read(relPath) ?? null,
    sites: ORIGIN_SITES,
  });
  const byId = new Map(ORIGIN_SITES.map((s) => [s.id, s]));

  for (const site of agreement.sites) {
    if (site.status === "differs") {
      notes.push(
        `${site.label} (${site.path}) holds ${site.found}, not ${agreement.expected} — ` +
          "run `hatchkit doctor` for the consequence",
      );
    } else if (site.status === "missing") {
      notes.push(
        `${site.label} (${site.path}) carries no API origin — it should be ${agreement.expected}`,
      );
    } else if (site.status === "enforced") {
      // Not a finding — the workflow already refuses to build without
      // the value — but the value itself is a one-time step only a
      // person can take, which is exactly what a note is for.
      const manual = byId.get(site.id)?.manualStep?.(agreement.expected);
      if (manual) notes.push(manual);
    }
  }

  return applied(notes);
}
