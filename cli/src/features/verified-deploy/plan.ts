/*
 * cli/src/features/verified-deploy/plan.ts — turning a project into the
 * set of things its deploy can actually check.
 *
 * The rest of the feature reads one `VerifiedDeployPlan` rather than a
 * project shape, so the generator never asks "is this a backend?" in two
 * places and gets two answers. Four shapes decide what exists:
 *
 *   · `single-origin` — the web and API origins are the same, so there
 *     is no cross-origin request to make and the preflight check is
 *     dropped. One application declares both services, so it carries
 *     both image variables.
 *   · `split` — two applications, two origins, and the preflight check
 *     is the only thing in the whole pipeline that exercises the pairing.
 *   · `backend` — no web half: no build-info document, no client commit
 *     to wait for, nothing to roll the client back to.
 *   · `static` — no API half: no health, session or preflight check, and
 *     the gate is the client's commit alone.
 *
 * The origins come from the operational layer's `defaultApiOrigin` /
 * `defaultWebOrigin`, and the image bases from the project's own compose
 * defaults (`readImageEnvDefaults`), so the URL the client is BUILT
 * against, the URL the gate CHECKS and the package the pin NAMES all
 * come from one derivation rather than three.
 */

import { readImageEnvDefaults } from "../../scaffold/deploy-verification.js";
import {
  type OperationalContext,
  type OperationalProject,
  defaultApiOrigin,
  defaultWebOrigin,
  hasClientHalf,
  hasServerHalf,
} from "../operational-context.js";
import {
  DEFAULT_ID_FIELD,
  DEFAULT_MIGRATIONS_DIR,
  DEFAULT_MIN_READER_FIELD,
} from "./migration-guard.js";
import type { DeployApp, VerifiedDeployOverrides, VerifiedDeployPlan } from "./types.js";

/** The one workflow concurrency group the push deploy and the manual
 *  rollback share. A constant, because two workflows agreeing on it is
 *  the whole point — see workflow.ts. */
export const DEPLOY_CONCURRENCY_GROUP = "hosted-deploy";

/** Platform env variable holding each half's image reference. Matches
 *  the names `scaffold/deploy-verification.ts` already pins. */
export const IMAGE_ENV_KEYS: Record<DeployApp, string> = {
  server: "SERVER_IMAGE",
  client: "CLIENT_IMAGE",
};

/** Paths the gate probes, relative to their origin. */
export const DEFAULT_HEALTH_PATH = "/api/health";
export const DEFAULT_BUILD_INFO_PATH = "/version.json";
export const DEFAULT_SESSION_PATH = "/api/auth/get-session";

/** Ten minutes of commit polling at fifteen seconds, then a handful of
 *  gate retries ten seconds apart. A deploy that has not landed in ten
 *  minutes is not landing; a gate that still fails after a minute is not
 *  a database finishing its connection. */
export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_POLL_ATTEMPTS = 40;
export const DEFAULT_GATE_INTERVAL_MS = 10_000;
export const DEFAULT_GATE_ATTEMPTS = 6;

/**
 * What planning needs off the context: the directory whose compose files
 * declare the image references, and the project's shape.
 *
 * A `Pick` rather than the whole {@link OperationalContext}, so a caller
 * that only wants a plan — `hatchkit regen-infra`, a test — does not
 * have to build a ledger to get one.
 */
export type VerifiedDeployPlanInput = Pick<OperationalContext, "projectDir" | "project">;

/** Strip the tag off an image reference, keeping a registry port.
 *  `ghcr.io/owner/repo-server:main` → `ghcr.io/owner/repo-server`. */
function withoutTag(reference: string): string {
  const colon = reference.lastIndexOf(":");
  const slash = reference.lastIndexOf("/");
  return colon > slash ? reference.slice(0, colon) : reference;
}

/** The image reference base for each half, preferring what the project's
 *  own compose files declare. Falling back to the repository slug keeps
 *  a project whose compose has not been generated yet from producing a
 *  pin that names nothing. */
function imageBasesFor(
  input: VerifiedDeployPlanInput,
  apps: DeployApp[],
): Partial<Record<DeployApp, string>> {
  const declared = readImageEnvDefaults(input.projectDir);
  const bases: Partial<Record<DeployApp, string>> = {};
  for (const app of apps) {
    const fromCompose = declared[IMAGE_ENV_KEYS[app]];
    if (fromCompose) bases[app] = withoutTag(fromCompose);
    else if (input.project.repoSlug) bases[app] = `ghcr.io/${input.project.repoSlug}-${app}`;
  }
  return bases;
}

/** The halves a project deploys, server first — the order a deploy is
 *  queued in, so the API is up before the client that calls it. */
export function deployAppsFor(project: OperationalProject): DeployApp[] {
  const apps: DeployApp[] = [];
  if (hasServerHalf(project.surfaces)) apps.push("server");
  if (hasClientHalf(project.surfaces)) apps.push("client");
  return apps;
}

/** Everything the generated script and workflows need, derived once. */
export function planVerifiedDeploy(
  input: VerifiedDeployPlanInput,
  overrides: VerifiedDeployOverrides = {},
): VerifiedDeployPlan {
  const project = input.project;
  const apps = overrides.apps ?? deployAppsFor(project);
  const apiOrigin = hasServerHalf(project.surfaces)
    ? defaultApiOrigin(project.domain, project.topology)
    : "";
  const webOrigin = hasClientHalf(project.surfaces) ? defaultWebOrigin(project.domain) : "";

  const plan: VerifiedDeployPlan = {
    name: project.name,
    apps,
    imageEnvKeys: IMAGE_ENV_KEYS,
    imageBase: imageBasesFor(input, apps),
    webOrigin,
    apiOrigin,
    // Equal origins mean the API is same-origin with the web app, so no
    // browser ever sends a preflight and a check for one would assert
    // something production does not do.
    crossOrigin: apiOrigin !== "" && webOrigin !== "" && apiOrigin !== webOrigin,
    healthPath: DEFAULT_HEALTH_PATH,
    buildInfoPath: DEFAULT_BUILD_INFO_PATH,
    sessionPath: DEFAULT_SESSION_PATH,
    migrationsDir: DEFAULT_MIGRATIONS_DIR,
    idField: DEFAULT_ID_FIELD,
    minReaderField: DEFAULT_MIN_READER_FIELD,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    pollAttempts: DEFAULT_POLL_ATTEMPTS,
    gateIntervalMs: DEFAULT_GATE_INTERVAL_MS,
    gateAttempts: DEFAULT_GATE_ATTEMPTS,
    concurrencyGroup: DEPLOY_CONCURRENCY_GROUP,
    repoSlug: project.repoSlug,
  };

  return { ...plan, ...overrides, apps };
}
