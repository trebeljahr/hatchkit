/*
 * cli/src/features/env-agreement/sites.ts — every place that carries the
 * DEFAULT API origin, written down once, as data.
 *
 * ---------------------------------------------------------------------
 * The gap this closes
 * ---------------------------------------------------------------------
 *
 * A deployed project does not hold its API origin in one place. It holds
 * it in as many places as it has clients, and each of those clients
 * carries its own copy, baked in at a different moment:
 *
 *   · the server signs cookies for the origin it thinks it is mounted at
 *   · the web image inlines the origin at IMAGE BUILD time
 *   · a store binary inlines it at RELEASE time and then sits in a store
 *     for weeks
 *   · an extension carries it in a manifest that only a new review can
 *     change
 *
 * Because they are baked at different moments, they drift apart silently.
 * Nothing fails at the moment of the mistake: the image builds green, the
 * release signs, the container starts healthy. The failure arrives later,
 * to someone else, as "sign-in does nothing" or "the app spins forever".
 * That is the whole reason this is a check rather than a paragraph in a
 * README — a paragraph cannot tell you that the store binary you shipped
 * in March points at the host you retired in May.
 *
 * The concrete history (tracktime, 2026-09): the project moved its API to
 * its own host. The server's own base URL and the client build arg were
 * updated; the mobile release workflow and the extension manifest were
 * not. Both kept building and shipping, both pointed at a host that had
 * stopped answering, and the only symptom was users reporting that
 * sign-in "hangs".
 *
 * ---------------------------------------------------------------------
 * Why a list rather than prose
 * ---------------------------------------------------------------------
 *
 * The check and the generated documentation read the SAME list. A site
 * added here appears in `hatchkit doctor` and in the project's
 * `docs/env-sources.md` at once, so the two can never disagree about how
 * many places there are — which is the failure mode of every hand-kept
 * list of this kind.
 */

import type { OperationalProject } from "../operational-context.js";
import { hasClientHalf, hasServerHalf } from "../operational-context.js";

/** The variable — or, for the mobile workflow, the secret — that every
 *  native release workflow carries the origin in. One definition, read
 *  by both native site entries and by their enforcement probes, so a
 *  rename cannot half-land. */
export const NATIVE_API_URL_KEY = "NEXT_PUBLIC_API_URL";

/** Stable identifiers. They appear in doctor output and in this
 *  module's tests, so renaming one is a breaking change; adding one is
 *  not. */
export type OriginSiteId =
  | "server-base-url"
  | "client-build-arg"
  | "deploy-gate-probe"
  | "mobile-release"
  | "desktop-release"
  | "browser-extension";

interface OriginSiteBase {
  id: OriginSiteId;
  /** Short human label, used in reports and in the generated doc. */
  label: string;
  /** Does this project have this surface at all? A project with no
   *  mobile half has no mobile release workflow, and its absence is
   *  correct rather than a finding. */
  required: (project: OperationalProject) => boolean;
  /** One line describing what a WRONG value here looks like from
   *  outside — the symptom a user reports, not the rule that was
   *  broken. Reports print this instead of "two strings differ",
   *  because the symptom is what makes someone act. */
  symptom: string;
  /**
   * The one-time human step that fills this site, for a site whose
   * value hatchkit deliberately does not write.
   *
   * Only a person can create a repository secret or variable, so this
   * is what the apply wrapper puts in its notes and what the generated
   * document prints under the site. A site hatchkit fills itself has no
   * `manualStep`: a note nobody has to act on is what teaches people to
   * stop reading notes.
   */
  manualStep?: (expected: string) => string;
}

/** A value the platform holds, not the repository. There is no file to
 *  read: the caller passes the application's environment fields in. */
export interface PlatformEnvSite extends OriginSiteBase {
  source: "platform-env";
  /** The environment variable name on the deployed application. */
  key: string;
}

/** A value that lives in a file in the repository. */
export interface FileSite extends OriginSiteBase {
  source: "file";
  /** Path relative to the project root. */
  path: string;
  /** Pull the origin out of the file, or return null when the file
   *  carries no literal origin — an unset build arg, or a value that
   *  defers entirely to a CI secret this check cannot read. Null is
   *  deliberately not an error: it is the "missing" case, and missing
   *  is exactly how the empty-build-arg failure looked. */
  find: (content: string) => string | null;
  /**
   * Recognise a file that carries no usable literal ON PURPOSE, and say
   * why in one line.
   *
   * Two shapes of deliberate refusal ship in the starter today, and
   * neither is the empty-build-arg failure this module was written to
   * catch:
   *
   *   · `mobile-release.yml` reads `${{ secrets.NEXT_PUBLIC_API_URL }}`
   *     and its plan job fails the run when that secret is empty, so
   *     nothing can be built against a missing origin.
   *   · `desktop-release.yml` reads `${{ vars.NEXT_PUBLIC_API_URL }}`
   *     and a step before the build fails the job when that variable is
   *     empty, so no installer is built against a missing origin.
   *
   * Returning a reason turns the site's status into `enforced` rather
   * than `missing`. Returning null means the absence is just an
   * absence — which is still a finding.
   */
  enforces?: (content: string) => string | null;
}

export type OriginSite = PlatformEnvSite | FileSite;

/** Where a site's value lives, as one string for a report column. */
export function siteLocation(site: OriginSite): string {
  return site.source === "file" ? site.path : site.key;
}

// ---------------------------------------------------------------------------
// Value extraction
// ---------------------------------------------------------------------------

/** Compare origins after stripping trailing slashes and nothing else.
 *
 *  Deliberately NOT a URL parse that reduces to scheme+host: a value
 *  with a path on the end (`https://api.example.com/api`) is one of the
 *  most common versions of this bug — every client appends its own path,
 *  so the mount ends up doubled — and normalising the path away would
 *  hide it behind a green check. */
export function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** The first literal origin in a raw configuration value.
 *
 *  Handles the three shapes these values take in practice:
 *
 *    `https://api.example.com`                      a plain literal
 *    `"https://api.example.com"`                    quoted
 *    `${{ vars.X || 'https://api.example.com' }}`   a CI expression with
 *                                                   a literal fallback
 *
 *  An expression with NO literal in it (`${{ secrets.X }}`) returns null:
 *  the repository then carries no default at all, the value is whatever
 *  a secret happens to hold, and an unset secret bakes an empty origin
 *  into a shipped binary without failing anything. */
export function extractOriginLiteral(raw: string): string | null {
  const match = raw.match(/https?:\/\/[^\s"'`}\\)]+/);
  if (!match) return null;
  return normalizeOrigin(match[0]);
}

/** Is this origin a deliberate tripwire rather than a real host?
 *
 *  RFC 2606 reserves `.invalid` for names guaranteed never to resolve,
 *  so a value under it is never somebody's server and never a typo for
 *  one. A workflow that falls back to one does so on purpose: a build
 *  with no value set fails at the first request rather than shipping an
 *  installer that quietly calls a plausible-looking host. Reporting it
 *  as a disagreement would be reporting the safety net as the accident. */
export function isTripwireOrigin(value: string): boolean {
  return /^https?:\/\/[^/]*\.invalid(?::\d+)?(?:\/|$)/i.test(value);
}

/** Read `KEY=value` (the Docker build-arg shape) out of a workflow. */
function findBuildArg(key: string) {
  const pattern = new RegExp(`^[ \\t]*${key}=(.*)$`, "m");
  return (content: string): string | null => {
    const m = content.match(pattern);
    return m ? extractOriginLiteral(m[1]) : null;
  };
}

/** Read `KEY: value` (the YAML env shape) out of a workflow.
 *
 *  The native release workflows write that value as a CI expression
 *  rather than a bare string — `${{ vars.KEY }}` in the desktop
 *  workflow, `${{ secrets.KEY }}` in the mobile one — so the literal,
 *  where there is one at all (`${{ vars.KEY || 'https://…' }}`), has to
 *  come out of the expression. That is what {@link extractOriginLiteral}
 *  exists for.
 *
 *  The FIRST entry in the file wins. A workflow-level `env:` block is
 *  the value every job inherits, and a step-level entry that overrides
 *  it is exactly the case a reader has to go and look at rather than
 *  one this check can summarise in a line. */
function findYamlEnv(key: string) {
  const pattern = new RegExp(`^[ \\t]*${key}:[ \\t]*(.*)$`, "m");
  return (content: string): string | null => {
    const m = content.match(pattern);
    return m ? extractOriginLiteral(m[1]) : null;
  };
}

/** Read an `apiUrl: "…"` property out of a TypeScript/JavaScript config.
 *  Extra client surfaces (a browser extension's manifest config, a
 *  launcher extension's preferences) all express their default server
 *  this way. */
function findApiUrlProperty(content: string): string | null {
  const m = content.match(/apiUrl\s*[:=]\s*(["'`][^"'`]*["'`])/);
  return m ? extractOriginLiteral(m[1]) : null;
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** Every place that carries the default API origin.
 *
 *  Order matters only for reading: the server's own idea of where it is
 *  comes first, because every other entry is a client that has to agree
 *  with it.
 *
 *  Each entry is a DEFAULT. A person running a store build can point it
 *  at another server from its own settings screen — which is precisely
 *  why these drift unnoticed: the people who would notice are the ones
 *  who changed the value by hand, and everybody else silently gets the
 *  broken default. */
export const ORIGIN_SITES: readonly OriginSite[] = [
  {
    id: "server-base-url",
    label: "the server's own base URL",
    source: "platform-env",
    key: "BETTER_AUTH_URL",
    required: (p) => hasServerHalf(p.surfaces),
    symptom:
      "the auth layer mounts and signs cookies for a host nobody visits, so sign-in appears to " +
      "succeed and the next request is anonymous again",
  },
  {
    id: "client-build-arg",
    label: "the client image's build argument",
    source: "file",
    path: ".github/workflows/build-and-deploy.yml",
    find: findBuildArg("NEXT_PUBLIC_API_URL"),
    required: (p) => hasServerHalf(p.surfaces) && hasClientHalf(p.surfaces),
    symptom:
      "the framework inlines this at image build time, so a wrong value builds green and the " +
      "deployed site calls a dead API — runtime environment on the container cannot change it, " +
      "only rebuilding the image can",
  },
  {
    id: "deploy-gate-probe",
    label: "the post-deploy gate's probe URL",
    source: "file",
    path: ".github/workflows/build-and-deploy.yml",
    find: findYamlEnv("HATCHKIT_API_URL"),
    required: (p) => hasServerHalf(p.surfaces),
    symptom:
      "the gate probes a host the deployment does not serve, so it either fails every green " +
      "deploy or passes against something else entirely",
  },
  {
    id: "mobile-release",
    label: "the mobile release workflow's baked default",
    source: "file",
    path: ".github/workflows/mobile-release.yml",
    find: findYamlEnv(NATIVE_API_URL_KEY),
    // The workflow's plan job lists this secret among the ones it probes
    // and refuses the run when it is empty. Matching the probe rather
    // than the consuming step is deliberate: the probe is the gate, and
    // a workflow that reads the secret without gating on it is back to
    // baking an empty origin into a store binary.
    enforces: (content) =>
      new RegExp(
        `${NATIVE_API_URL_KEY}:\\s*\\$\\{\\{\\s*secrets\\.${NATIVE_API_URL_KEY}\\s*!=`,
      ).test(content)
        ? "the plan job refuses the run when the secret is empty, so no build ships without one"
        : null,
    manualStep: (expected) =>
      `Set the ${NATIVE_API_URL_KEY} repository SECRET to ${expected} — the mobile release ` +
      "workflow refuses to build without it, and the value is baked into a store binary " +
      `(gh secret set ${NATIVE_API_URL_KEY} --body ${expected})`,
    required: (p) => hasServerHalf(p.surfaces) && p.features.includes("mobile"),
    symptom:
      "the value is baked into a store binary, so moving it needs a new build and a new review " +
      "— every install already out there keeps pointing at the old host",
  },
  {
    id: "desktop-release",
    label: "the desktop release workflow's baked default",
    source: "file",
    path: ".github/workflows/desktop-release.yml",
    find: findYamlEnv(NATIVE_API_URL_KEY),
    // The workflow reads the variable with no fallback, and its "Check
    // the API origin" step fails the job when the value is empty. Both
    // halves are required: reading the variable without that guard is
    // back to baking an empty origin into an installer.
    enforces: (content) =>
      content.includes(`vars.${NATIVE_API_URL_KEY}`) &&
      new RegExp(`-z\\s+"\\$\\{${NATIVE_API_URL_KEY}:-\\}"`).test(content)
        ? `the build refuses to run when the ${NATIVE_API_URL_KEY} variable is empty, so no ` +
          "installer ships without one"
        : null,
    manualStep: (expected) =>
      `Set the ${NATIVE_API_URL_KEY} repository VARIABLE to ${expected} — the desktop release ` +
      "workflow refuses to build without it, and the value is baked into the installer " +
      `(gh variable set ${NATIVE_API_URL_KEY} --body ${expected})`,
    required: (p) => hasServerHalf(p.surfaces) && p.features.includes("desktop"),
    symptom:
      "the value is baked into a signed desktop build, so an installed copy keeps calling the " +
      "old host until the user takes an update",
  },
  {
    id: "browser-extension",
    label: "the browser extension's default server",
    source: "file",
    path: "packages/extension/manifest.config.ts",
    // Never required: hatchkit does not scaffold an extension, so this
    // site only reports when a project has grown one by hand. An absent
    // file is the normal case and says nothing.
    required: () => false,
    find: findApiUrlProperty,
    symptom:
      "a published extension can only change this in a new review, and it makes cross-origin " +
      "requests, so a stale value fails CORS rather than merely 404ing",
  },
];
