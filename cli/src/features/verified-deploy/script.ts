/*
 * cli/src/features/verified-deploy/script.ts — rendering the project's
 * own deploy script.
 *
 * ---------------------------------------------------------------------
 * Why a script at all, when the gate is already a workflow step
 * ---------------------------------------------------------------------
 *
 * `scaffold/deploy-verification.ts` generates the gate as shell inside
 * the workflow. That was enough while the only outcome was pass or fail.
 * A deploy that can UNDO itself needs state across steps — the image
 * commits served before promoting, the migration registries of two commits,
 * which halves were restored — and shell inside YAML has no way to be
 * tested, so every rule it holds is only ever exercised by a real
 * deploy against real infrastructure.
 *
 * So the logic is written to a file the project owns, split in two:
 *
 *   · `scripts/lib/hatchkit-deploy.mjs` — the whole sequence, with
 *     EVERY dependency injected: a fetch function, a sleep, a log, and
 *     a reader that returns a commit's migration registry. Nothing in
 *     it touches the network, the clock or git.
 *   · `scripts/hatchkit-deploy.mjs` — the entry, which is the only
 *     place that reads argv, reads environment variables, runs git and
 *     calls the real `fetch`.
 *
 * That split is the whole reason the reference implementation this is
 * generalized from can be trusted: its test imports the lib and runs a
 * complete deploy — success, gate failure with rollback, missing
 * rollback target, failed rollback, migration-blocked rollback —
 * against a fake platform, with no network and no clock. This
 * generator's own test does the same to the file it writes, so a change
 * here that breaks the sequence fails in CI rather than in production.
 *
 * ---------------------------------------------------------------------
 * A note on the generated source
 * ---------------------------------------------------------------------
 *
 * The generated JavaScript deliberately concatenates strings rather than
 * using template literals. It is emitted from inside a TypeScript
 * template literal, and every backtick and interpolation in the output
 * would need escaping — which is exactly the kind of quoting that turns
 * a readable generator into one nobody edits. Only the constants at the
 * top of each generated file are interpolated.
 */

import {
  COOLIFY_MANUAL_WEBHOOK_PATH,
  DEPLOY_HOOK_WATCH_PATH,
  LIVE_TAG,
} from "../../deploy/coolify-deploy-hook.js";
import { MANIFEST_ACCEPT } from "../../utils/oci-registry.js";
import { GATE_CHECK_ORDER, type VerifiedDeployPlan } from "./types.js";

/** Project-relative path of the generated logic module. */
export const DEPLOY_LIB_REL_PATH = "scripts/lib/hatchkit-deploy.mjs";

/** Project-relative path of the generated entry script. */
export const DEPLOY_ENTRY_REL_PATH = "scripts/hatchkit-deploy.mjs";

/** A JSON literal for the generated source. */
function lit(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * The logic module: the whole promote → deploy → poll → gate → restore
 * sequence, with the network, the clock and git taken as parameters.
 *
 * The project's shape is baked into the constants at the top — which
 * halves exist, which variables hold their images, which origins are
 * probed, whether there is a cross-origin preflight to make at all.
 * Everything else is identical for every project, so a fix to the
 * sequence is a fix everywhere.
 */
export function renderDeployLib(plan: VerifiedDeployPlan): string {
  return `/**
 * The verified deploy: point the live tag at this commit's images, deploy, wait
 * for the new commit to actually be serving, run the gate, and put the
 * previous images back when it fails.
 *
 * Generated and OWNED by hatchkit: every 'hatchkit update' regenerates
 * this file from the project manifest, so an edit made here is lost on
 * the next run. Change the generator, or move the code you need into a
 * file of your own and call it from ${DEPLOY_ENTRY_REL_PATH}.
 *
 * Everything that touches the network, git or the clock is INJECTED (see
 * the 'deps' parameter), so this whole sequence can be driven by a test
 * against a fake platform with no network and no clock. Keep that
 * property when you edit the generator: the moment this file calls
 * fetch() or Date.now() directly, the only way left to test a rollback
 * is to break production.
 *
 * The entry that supplies the real dependencies is
 * ${DEPLOY_ENTRY_REL_PATH}.
 */

import { createHash, createHmac } from "node:crypto";

// ── What this project can check ──────────────────────────────────────
//
// Derived from the project's shape when this file was generated. A
// backend-only project has no web origin and no client half; a static
// one has no API; a single-origin project serves both from one host, so
// there is no cross-origin request to make and no preflight to check.

/** The halves this deploy moves, server first: the API is queued before
 *  the client that calls it. */
export const APPS = Object.freeze(${lit(plan.apps)});

/** The platform env variable holding each half's image reference. */
export const IMAGE_ENV = Object.freeze(${lit(plan.imageEnvKeys)});

/** Image references with the tag stripped. The deploy promotes
 *  '<base>:<commit sha>', which is immutable — a moving tag like ':main'
 *  lets the platform start the PREVIOUS build while every status surface
 *  reports the new commit. */
export const IMAGE_BASE = Object.freeze(${lit(plan.imageBase)});

/** Public origins, no trailing slash. An empty one means this project
 *  has no such half, and every check against it is skipped. */
export const ORIGINS = Object.freeze({ web: ${lit(plan.webOrigin)}, api: ${lit(plan.apiOrigin)} });

/** False when the web and API origins are the same: no browser sends a
 *  preflight to its own origin, so checking for one would assert
 *  something production never does. */
export const CROSS_ORIGIN = ${plan.crossOrigin ? "true" : "false"};

/** Paths the gate probes, relative to their origin. */
export const PATHS = Object.freeze({
  health: ${lit(plan.healthPath)},
  buildInfo: ${lit(plan.buildInfoPath)},
  session: ${lit(plan.sessionPath)},
});

/** Where the migration registry lives, and the literal field names a
 *  migration declares itself with. Read out of git at two commits, which
 *  is why the deploy job checks out with fetch-depth: 0. */
export const MIGRATIONS = Object.freeze({
  dir: ${lit(plan.migrationsDir)},
  idField: ${lit(plan.idField)},
  minReaderField: ${lit(plan.minReaderField)},
});

/** Commit polling waits out an asynchronous deploy; the gate retries are
 *  for a database still connecting, and no more. */
export const DEFAULT_TIMING = Object.freeze({
  pollAttempts: ${plan.pollAttempts},
  pollIntervalMs: ${plan.pollIntervalMs},
  gateAttempts: ${plan.gateAttempts},
  gateIntervalMs: ${plan.gateIntervalMs},
});

/** The moving tag every application pulls. Deploying commit X means
 *  pointing it at the image built for X, then telling the application to
 *  redeploy; the old images are never touched, so going back is the same
 *  move with an older commit. */
export const LIVE_TAG = ${lit(LIVE_TAG)};

/** The platform's signed deploy webhook, and the one path its payload
 *  names as changed. The applications are configured to deploy only when
 *  that path changes, so a push that reaches the platform any other way
 *  never deploys a build that has not been pushed yet. */
export const WEBHOOK = Object.freeze({
  path: ${lit(COOLIFY_MANUAL_WEBHOOK_PATH)},
  watchPath: ${lit(DEPLOY_HOOK_WATCH_PATH)},
});

/** Every manifest shape a build can push, for reading one by tag. */
const MANIFEST_ACCEPT = ${lit(MANIFEST_ACCEPT)};

/**
 * Every check the gate can fail, in the order it is evaluated. The order
 * decides which failure a run reports when several are true at once, and
 * the commit checks come first because they are the only ones worth
 * waiting minutes for: until an origin names this run's commit, nothing
 * else it says is about the build under test.
 */
export const GATE_CHECK_ORDER = Object.freeze(${lit([...GATE_CHECK_ORDER])});

const COMMIT_CHECKS = Object.freeze(["api-commit", "web-commit"]);

const messageOf = (caught) => (caught instanceof Error ? caught.message : String(caught));

// ── Rollback targets ─────────────────────────────────────────────────

const FULL_SHA = /^[0-9a-f]{40}$/;

/** Only a full commit sha names one immutable build. */
export const isFullSha = (value) => typeof value === "string" && FULL_SHA.test(value);

/** The commit an image reference is pinned to, or null. Splits on the
 *  last colon so a registry port survives. */
export const shaFromImageRef = (value) => {
  if (typeof value !== "string") return null;
  const colon = value.lastIndexOf(":");
  if (colon === -1) return null;
  const tag = value.slice(colon + 1);
  return isFullSha(tag) ? tag : null;
};

export const imageRef = (base, sha) => String(base) + ":" + sha;

/**
 * What a rollback may restore for one half, or why there is nothing to
 * restore.
 *
 * The target is the commit the half was SERVING before this run moved
 * anything — read from its own health or build-info endpoint, so it is
 * what was actually running rather than what something last asked for —
 * and only when the registry still holds that commit's image, because
 * restoring means pointing the live tag back at it. Each 'none' reason
 * says how to fix it.
 */
export const selectRollbackTarget = (input) => {
  const served = input.served;
  if (served === undefined || served === null || served === "") {
    return {
      kind: "none",
      reason:
        "the " + input.app + " half reported no commit before the deploy: this is a first deploy, or it was not answering",
    };
  }
  if (!isFullSha(served)) {
    return {
      kind: "none",
      reason:
        "the " + input.app + " half reported " + show(served) + ", which is not a full commit sha, so no image tag names it",
    };
  }
  if (input.inRegistry !== true) {
    return {
      kind: "none",
      reason: imageRef(input.base, served) + " is not in the registry, so there is no image to go back to",
    };
  }
  return { kind: "target", value: imageRef(input.base, served), sha: served };
};

// ── The gate ─────────────────────────────────────────────────────────

const show = (value) =>
  value === undefined || value === null || value === "" ? "<none>" : String(value);

/** 'commit' is the current field; 'version' is the same commit under the
 *  name older images report it as, and a rollback target can be such an
 *  image. */
const healthCommit = (health) => (health.commit === undefined ? health.version : health.commit);

/** Which checks apply to one move. An empty origin drops that half's
 *  checks; a null expected sha drops only the commit comparison, which
 *  is how a client-only rollback still gates the server on being up. */
export const applicableChecks = (expected) => {
  const hasApi = expected.apiOrigin !== "";
  const hasWeb = expected.webOrigin !== "";
  const checks = [];
  if (hasApi && expected.serverSha !== null) checks.push("api-commit");
  if (hasWeb && expected.clientSha !== null) checks.push("web-commit");
  if (hasApi) checks.push("api-status", "api-db");
  if (hasWeb && hasApi) checks.push("web-api-url");
  if (hasApi) checks.push("auth-session");
  if (hasApi && hasWeb && expected.crossOrigin) checks.push("cors");
  return checks;
};

const failureOf = (check, probes, expected) => {
  const health = probes.health;
  const buildInfo = probes.buildInfo;
  if (check === "api-commit") {
    if (health === null) {
      return expected.apiOrigin + " gave no answer, expected commit " + expected.serverSha;
    }
    const seen = healthCommit(health);
    return seen === expected.serverSha
      ? null
      : "the server reports commit " + show(seen) + ", expected " + expected.serverSha;
  }
  if (check === "web-commit") {
    if (buildInfo === null) {
      return expected.webOrigin + " gave no build info, expected commit " + expected.clientSha;
    }
    return buildInfo.commit === expected.clientSha
      ? null
      : "the client reports commit " + show(buildInfo.commit) + ", expected " + expected.clientSha;
  }
  if (check === "api-status") {
    if (health === null) return "no health document from " + expected.apiOrigin;
    return health.status === "ok" ? null : "health status is " + show(health.status) + ", expected ok";
  }
  if (check === "api-db") {
    if (health === null) return "no health document from " + expected.apiOrigin;
    return health.db === true ? null : "health db is " + show(health.db) + ", expected true";
  }
  if (check === "web-api-url") {
    if (buildInfo === null) return "no build info from " + expected.webOrigin;
    return buildInfo.apiUrl === expected.apiOrigin
      ? null
      : "the client was built against " + show(buildInfo.apiUrl) + ", expected " + expected.apiOrigin;
  }
  if (check === "auth-session") {
    return probes.sessionStatus === 200
      ? null
      : "the unauthenticated session call answered " + show(probes.sessionStatus) + ", expected 200";
  }
  if (check === "cors") {
    return probes.corsAllowOrigin === expected.webOrigin
      ? null
      : "the preflight from " + expected.webOrigin + " was answered with Access-Control-Allow-Origin " + show(probes.corsAllowOrigin);
  }
  return null;
};

/** The gate over one look at the origins: the first failing check in
 *  GATE_CHECK_ORDER, with the line that names what was seen. Pure. */
export const evaluateGate = (probes, expected) => {
  const checks = applicableChecks(expected);
  for (const check of GATE_CHECK_ORDER) {
    if (!checks.includes(check)) continue;
    const detail = failureOf(check, probes, expected);
    if (detail !== null) return { ok: false, failed: check, detail: detail };
  }
  return { ok: true };
};

/** True when the only thing wrong is 'the deploy has not landed yet'. */
export const isWaiting = (verdict) =>
  verdict.ok !== true && COMMIT_CHECKS.includes(verdict.failed);

// ── The migration guard ──────────────────────────────────────────────

/**
 * Migrations in 'next' that a build from 'previous' cannot read the
 * database after: new to that build, AND requiring a reader above it.
 */
export const breakingMigrations = (previous, next) =>
  next.migrations.filter(
    (migration) =>
      migration.id > previous.schemaVersion && migration.minReader > previous.schemaVersion,
  );

/**
 * May the server be put back? Three outcomes, and only the first is yes:
 * safe, blocked by a migration the older build cannot read, or unknown
 * because a registry could not be read. Unknown is answered NO — the
 * question is whether it is safe, and 'I could not tell' is not 'yes'.
 */
export const canRollBackServer = (question) => {
  const newSha = question.newSha || "the new commit";
  const previousSha = question.previousSha || "the previous commit";
  if (question.newRegistry.ok !== true || question.previousRegistry.ok !== true) {
    const problems = [];
    if (question.newRegistry.ok !== true) problems.push(newSha + ": " + question.newRegistry.error);
    if (question.previousRegistry.ok !== true) {
      problems.push(previousSha + ": " + question.previousRegistry.error);
    }
    return {
      allowed: false,
      reason:
        "the migration registries of " + newSha + " and " + previousSha + " could not be compared (" + problems.join("; ") + "), and an unknown answer is not a safe one — a shallow checkout is the usual cause, so the deploy job needs fetch-depth: 0",
    };
  }
  const previous = question.previousRegistry.registry;
  const next = question.newRegistry.registry;
  const breaking = breakingMigrations(previous, next);
  if (breaking.length === 0) {
    return {
      allowed: true,
      reason:
        "no migration in " + newSha + " raises the minimum reader above the schema version " + previous.schemaVersion + " of " + previousSha,
    };
  }
  const list = breaking
    .map((migration) => migration.id + " (" + migration.file + ", minimum reader " + migration.minReader + ")")
    .join(", ");
  return {
    allowed: false,
    reason:
      newSha + " carries migration " + list + ", above the schema version " + previous.schemaVersion + " of " + previousSha + ", so a server built from " + previousSha + " would refuse to start on that database",
  };
};

const registryAt = async (deps, sha) => {
  if (typeof deps.readRegistry !== "function") {
    return { ok: false, error: "no migration registry reader was supplied" };
  }
  try {
    return await deps.readRegistry(sha);
  } catch (caught) {
    return { ok: false, error: messageOf(caught) };
  }
};

// ── Looking at the origins ───────────────────────────────────────────

const TIMEOUT_MS = 10000;

/** Every probe carries a cache-buster: the question is what the ORIGIN
 *  now serves, and a cached answer is exactly the stale copy under
 *  test. */
const bust = (url, attempt) =>
  url + (url.indexOf("?") === -1 ? "?" : "&") + "hatchkit_cb=" + Date.now() + "-" + attempt;

const readJson = async (deps, url, attempt) => {
  try {
    const response = await deps.fetch(bust(url, attempt), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    return JSON.parse(await response.text());
  } catch (caught) {
    return null;
  }
};

/** One look at everything the gate checks. Never throws: an origin that
 *  cannot be reached is a null in the result, not an exception. */
export const observe = async (deps, config, attempt) => {
  const api = config.apiOrigin;
  const web = config.webOrigin;
  const results = await Promise.all([
    api === "" ? null : readJson(deps, api + PATHS.health, attempt),
    web === "" ? null : readJson(deps, web + PATHS.buildInfo, attempt),
    api === ""
      ? null
      : deps
          .fetch(bust(api + PATHS.session, attempt), { signal: AbortSignal.timeout(TIMEOUT_MS) })
          .then((response) => response.status)
          .catch(() => null),
    api === "" || web === "" || !CROSS_ORIGIN
      ? null
      : deps
          .fetch(api + PATHS.session, {
            method: "OPTIONS",
            headers: {
              Origin: web,
              "Access-Control-Request-Method": "POST",
              "Access-Control-Request-Headers": "content-type",
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          })
          .then((response) => response.headers.get("access-control-allow-origin"))
          .catch(() => null),
  ]);
  return {
    health: results[0],
    buildInfo: results[1],
    sessionStatus: results[2],
    corsAllowOrigin: results[3],
  };
};

/**
 * Wait for the expected commits, then for the gate to pass.
 *
 * Two phases, because they fail differently. A deploy is asynchronous —
 * the platform answers as soon as the work is QUEUED — so the commits
 * are polled for minutes. Once they match, the gate gets a few short
 * retries for a database still connecting, and no more: a server that is
 * up on the right commit and still cannot reach its database is exactly
 * the failure being gated on.
 */
export const waitForHealthy = async (deps, config, expected) => {
  const timing = Object.assign({}, DEFAULT_TIMING, config.timing || {});
  const full = {
    serverSha: expected.serverSha,
    clientSha: expected.clientSha,
    apiOrigin: config.apiOrigin,
    webOrigin: config.webOrigin,
    crossOrigin: CROSS_ORIGIN,
  };

  let verdict = { ok: false, failed: "api-commit", detail: "nothing was observed" };
  for (let attempt = 1; attempt <= timing.pollAttempts; attempt += 1) {
    verdict = evaluateGate(await observe(deps, config, attempt), full);
    if (!isWaiting(verdict)) break;
    deps.log("  waiting (" + attempt + "/" + timing.pollAttempts + "): " + verdict.detail);
    if (attempt === timing.pollAttempts) return verdict;
    await deps.sleep(timing.pollIntervalMs);
  }

  for (let attempt = 1; ; attempt += 1) {
    if (verdict.ok === true) {
      deps.log("✓ gate passed: " + applicableChecks(full).join(", "));
      return verdict;
    }
    if (attempt >= timing.gateAttempts) return verdict;
    deps.log("  gate (" + attempt + "/" + timing.gateAttempts + "): " + verdict.failed + ": " + verdict.detail);
    await deps.sleep(timing.gateIntervalMs);
    verdict = evaluateGate(await observe(deps, config, timing.pollAttempts + attempt), full);
  }
};

// ── Talking to the registry ──────────────────────────────────────────
//
// Deploys pick their image here, not on the platform: every application
// pulls '<image>:live', and moving that tag is two calls of the OCI
// distribution API — read the manifest a tag names, write the same bytes
// under another tag. The credential is the workflow's own GITHUB_TOKEN,
// which can write this repository's packages and nothing else.

const REQUEST_TIMEOUT_MS = 30000;

const imageBaseOf = (config, app) => (config.imageBase || IMAGE_BASE)[app];

const splitImage = (base) => {
  const slash = String(base).indexOf("/");
  return { host: base.slice(0, slash), repository: base.slice(slash + 1).toLowerCase() };
};

const bearerChallenge = (header) => {
  if (!header || !/^Bearer\\s/i.test(header)) return null;
  const params = {};
  for (const match of header.matchAll(/(\\w+)="([^"]*)"/g)) params[match[1].toLowerCase()] = match[2];
  return params.realm ? params : null;
};

const registryTokens = new WeakMap();

/** A pull+push token for one repository, cached per run. */
const registryToken = async (deps, config, name) => {
  let cache = registryTokens.get(config);
  if (!cache) {
    cache = new Map();
    registryTokens.set(config, cache);
  }
  const key = name.host + "/" + name.repository;
  if (cache.has(key)) return cache.get(key);
  const probe = await deps.fetch("https://" + name.host + "/v2/", {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const challenge = bearerChallenge(probe.headers.get("www-authenticate"));
  if (challenge === null) {
    throw new Error(name.host + " did not offer bearer authentication (" + probe.status + ")");
  }
  const url = new URL(challenge.realm);
  if (challenge.service) url.searchParams.set("service", challenge.service);
  url.searchParams.set("scope", "repository:" + name.repository + ":pull,push");
  const auth = config.registryAuth || {};
  const basic = Buffer.from(String(auth.username) + ":" + String(auth.password)).toString("base64");
  const response = await deps.fetch(url.toString(), {
    headers: { Authorization: "Basic " + basic },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(name.host + " refused a registry token (" + response.status + ")");
  const body = JSON.parse(await response.text());
  const token = body.token || body.access_token;
  if (!token) throw new Error(name.host + " answered without a registry token");
  cache.set(key, token);
  return token;
};

/** The manifest '<base>:<reference>' names, or null when there is none. */
export const readManifest = async (deps, config, base, reference) => {
  const name = splitImage(base);
  const token = await registryToken(deps, config, name);
  const response = await deps.fetch(
    "https://" + name.host + "/v2/" + name.repository + "/manifests/" + reference,
    {
      headers: { Authorization: "Bearer " + token, Accept: MANIFEST_ACCEPT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("reading " + imageRef(base, reference) + " failed (" + response.status + ")");
  const body = await response.text();
  const mediaType =
    (response.headers.get("content-type") || "").split(";")[0].trim() || JSON.parse(body).mediaType || "";
  const digest =
    response.headers.get("docker-content-digest") ||
    "sha256:" + createHash("sha256").update(body).digest("hex");
  return { mediaType: mediaType, body: body, digest: digest };
};

/**
 * Point each half's live tag at the image built for its commit, then read
 * the tag back.
 *
 * The bytes are copied verbatim: a manifest's digest is the hash of its
 * exact bytes, and a re-serialised body would name an image that does not
 * exist. The read-back catches a registry that answered and kept the old
 * manifest.
 */
export const promote = async (deps, config, shas) => {
  for (const app of Object.keys(shas)) {
    const base = imageBaseOf(config, app);
    const source = await readManifest(deps, config, base, shas[app]);
    if (source === null) {
      throw new Error(imageRef(base, shas[app]) + " is not in the registry — was it built and pushed?");
    }
    const name = splitImage(base);
    const token = await registryToken(deps, config, name);
    const response = await deps.fetch(
      "https://" + name.host + "/v2/" + name.repository + "/manifests/" + LIVE_TAG,
      {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "Content-Type": source.mediaType },
        body: source.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error("writing " + imageRef(base, LIVE_TAG) + " failed (" + response.status + ")");
    }
    const after = await readManifest(deps, config, base, LIVE_TAG);
    if (after === null || after.digest !== source.digest) {
      throw new Error(imageRef(base, LIVE_TAG) + " does not point at " + shas[app] + " after the update");
    }
    deps.log("promoted " + imageRef(base, shas[app]) + " to :" + LIVE_TAG);
  }
};

// ── Talking to the platform ──────────────────────────────────────────
//
// No platform API token. Each application has its own webhook secret, and
// a push payload signed with it queues a deploy of that one application:
// it can read nothing and reach no other application.

/** The exact body signed and sent for one application. */
export const webhookBody = (hook, sha) =>
  JSON.stringify({
    ref: "refs/heads/" + hook.branch,
    after: sha,
    repository: { full_name: hook.repository },
    commits: [{ id: sha, added: [], removed: [], modified: [WEBHOOK.watchPath] }],
  });

export const signWebhook = (secret, body) => createHmac("sha256", secret).update(body).digest("hex");

/**
 * Whether the platform's answer says THIS application's deploy was
 * queued. Every other application on the same repository answers
 * "Invalid signature."; only an entry for this uuid with status success,
 * or a skipped entry (the same commit is already queued — only an
 * application whose signature matched gets that far), counts. The detail
 * never names other applications: a public repository's log is public.
 */
export const webhookQueued = (text, uuid) => {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (caught) {
    return { ok: false, detail: String(text).slice(0, 200).trim() || "(empty answer)" };
  }
  if (!Array.isArray(parsed)) return { ok: false, detail: JSON.stringify(parsed).slice(0, 200) };
  const entries = parsed.filter((entry) => entry && typeof entry === "object");
  if (entries.some((entry) => entry.application_uuid === uuid && entry.status === "success")) {
    return { ok: true, detail: "deployment queued" };
  }
  const own = entries.filter((entry) => entry.message !== "Invalid signature.");
  if (own.length === 0) {
    return {
      ok: false,
      detail:
        entries.length === 0
          ? "no application matched the repository and branch"
          : "the signature matched no application — the deploy secret is stale or belongs to another application",
    };
  }
  return { ok: false, detail: own.map((entry) => entry.status + ": " + entry.message).join("; ") };
};

/**
 * The rollback target of each half, read BEFORE anything is promoted.
 *
 * This is step one of the deploy for a reason: once the live tag moves,
 * nothing on the platform names the build to go back to.
 */
export const readRollbackTargets = async (deps, config, apps) => {
  const probes = await observe(deps, config, 0);
  const served = {
    server: probes.health ? healthCommit(probes.health) : null,
    client: probes.buildInfo ? probes.buildInfo.commit : null,
  };
  const targets = {};
  for (const app of apps) {
    const base = imageBaseOf(config, app);
    const sha = served[app];
    const inRegistry = isFullSha(sha) ? (await readManifest(deps, config, base, sha)) !== null : false;
    targets[app] = selectRollbackTarget({ app: app, served: sha, base: base, inRegistry: inRegistry });
  }
  return targets;
};

/** Queue a deploy of each half, in APPS order. Applications are
 *  de-duplicated by uuid: a single-origin project runs one application
 *  that pulls both images, so one deploy covers both halves. */
export const trigger = async (deps, config, shas) => {
  const seen = [];
  for (const app of APPS) {
    if (!(app in shas)) continue;
    const hook = config.hooks[app];
    if (seen.includes(hook.uuid)) continue;
    seen.push(hook.uuid);
    const body = webhookBody(hook, shas[app]);
    const response = await deps.fetch(config.baseUrl + WEBHOOK.path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": "sha256=" + signWebhook(hook.secret, body),
      },
      body: body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error("the platform answered " + response.status + " to the " + app + " application's deploy webhook");
    }
    const verdict = webhookQueued(text, hook.uuid);
    if (verdict.ok !== true) {
      throw new Error("the " + app + " application's deploy was not queued: " + verdict.detail);
    }
    deps.log("deploy queued for the " + app + " application");
  }
};

// ── The sequence ─────────────────────────────────────────────────────

/** 'both' (or nothing) means every half this project has. */
export const parseWhich = (which) => {
  if (which === undefined || which === "" || which === "both") return APPS.slice();
  if (APPS.includes(which)) return [which];
  throw new Error("--which must be " + APPS.concat(["both"]).join(", ") + ', not "' + which + '"');
};

/**
 * Which halves a failed deploy can be put back, and why the others
 * cannot. Pure: the migration verdict is decided by the caller and
 * passed in, so this stays a table of reasons.
 */
export const planRollback = (input) => {
  const restore = {};
  const skipped = {};
  for (const app of input.apps) {
    const target = input.targets[app];
    if (!target || target.kind !== "target") {
      skipped[app] = target ? target.reason : "no rollback target was read for " + app;
    } else if (target.sha === input.targetSha) {
      skipped[app] = "the " + app + " half was already serving " + input.targetSha;
    } else if (app === "server" && input.serverGuard && input.serverGuard.allowed !== true) {
      skipped[app] = "not rolled back: " + input.serverGuard.reason;
    } else {
      restore[app] = target;
    }
  }
  return { restore: restore, skipped: skipped };
};

/**
 * Deploy one commit to the given halves, gate it, and put the previous
 * images back when the gate fails.
 *
 * Never loops. Two outcomes end the run immediately instead of trying
 * again:
 *
 *   · No rollback target. A first deploy, a variable still on a moving
 *     tag, or a token that may not read variable values leaves nothing
 *     to go back to. The new images stay live and the run says which
 *     of the three it was.
 *   · A rollback that itself fails — the restored build fails its own
 *     gate, or a platform call fails while restoring. A second automatic
 *     attempt against an unknown state is how an outage grows, so there
 *     is none.
 *
 * A rollback is never a green run either way: the commit on the default
 * branch is still broken.
 */
export const runDeploy = async (deps, config, request) => {
  const targetSha = String(request.targetSha || "").toLowerCase();
  if (!isFullSha(targetSha)) {
    return { ok: false, errors: [show(request.targetSha) + " is not a full 40-character commit sha"] };
  }
  const apps = request.apps && request.apps.length > 0 ? request.apps : APPS.slice();

  const expected = {
    serverSha: apps.includes("server") ? targetSha : null,
    clientSha: apps.includes("client") ? targetSha : null,
    apiOrigin: config.apiOrigin,
    webOrigin: config.webOrigin,
    crossOrigin: CROSS_ORIGIN,
  };
  // A deploy that can verify nothing is the failure this whole file
  // exists to remove, so it is an error rather than a quiet pass.
  if (applicableChecks(expected).length === 0) {
    return {
      ok: false,
      errors: [
        "a deploy was requested and nothing could be verified: this project's web and API origins are both empty",
      ],
    };
  }

  // Step 1: read what a rollback would go back to, BEFORE promoting. Once
  // the new reference is written, the old one is gone.
  let targets;
  try {
    targets = await readRollbackTargets(deps, config, apps);
  } catch (caught) {
    return {
      ok: false,
      errors: [
        "what each half is serving could not be read before promoting (" + messageOf(caught) + "); nothing was changed",
      ],
    };
  }
  for (const app of apps) {
    const target = targets[app];
    deps.log(
      "the " + app + " half before: " + (target.kind === "target" ? target.value : "<no rollback target: " + target.reason + ">"),
    );
  }

  // Deploying an OLDER server by hand asks the same question a rollback
  // does: can that build read the database the current one has migrated?
  // Refuse before anything changes. Only the manual workflow asks — a
  // push deploys a newer build, and an unreadable registry of the build
  // it replaces must not stop that.
  if (request.guardServerDowngrade === true && request.forceServer !== true && apps.includes("server")) {
    const current = targets.server;
    if (current && current.kind === "target" && current.sha !== targetSha) {
      const verdict = canRollBackServer({
        newRegistry: await registryAt(deps, current.sha),
        previousRegistry: await registryAt(deps, targetSha),
        newSha: current.sha,
        previousSha: targetSha,
      });
      if (verdict.allowed !== true) {
        return {
          ok: false,
          errors: [
            "refusing to deploy the server at " + targetSha + ": " + verdict.reason + ". Move only the client, or restore a database dump from before that migration and run again with the force-server option.",
          ],
        };
      }
    }
  }

  // Steps 2, 3 and 4: promote, deploy, poll for the commit, run the gate. A
  // call that fails half way through promoting leaves a live tag
  // the next unrelated deploy would pick up, so it goes through the same
  // restore as a failed gate rather than throwing out of here.
  let verdict;
  try {
    const shas = {};
    for (const app of apps) shas[app] = targetSha;
    await promote(deps, config, shas);
    await trigger(deps, config, shas);
    verdict = await waitForHealthy(deps, config, expected);
  } catch (caught) {
    verdict = { ok: false, failed: "platform", detail: messageOf(caught) };
  }
  if (verdict.ok === true) return { ok: true, errors: [] };

  const failure = verdict.failed + ": " + verdict.detail;
  const headline = (outcome) => targetSha + " failed the deploy gate (" + failure + "); " + outcome;
  if (request.rollback !== true) {
    return { ok: false, errors: [headline("it stays live, since no rollback was requested")] };
  }

  // Step 5: roll back. The server is asked about separately, because a
  // migration the previous build cannot read makes putting it back worse
  // than leaving it on the failed commit.
  let serverGuard = null;
  const serverTarget = targets.server;
  if (apps.includes("server") && serverTarget && serverTarget.kind === "target") {
    serverGuard = canRollBackServer({
      newRegistry: await registryAt(deps, targetSha),
      previousRegistry: await registryAt(deps, serverTarget.sha),
      newSha: targetSha,
      previousSha: serverTarget.sha,
    });
  }

  const plan = planRollback({ apps: apps, targets: targets, targetSha: targetSha, serverGuard: serverGuard });
  const skipped = Object.keys(plan.skipped).map((app) => "  " + app + ": " + plan.skipped[app]);
  const restoreApps = Object.keys(plan.restore);
  if (restoreApps.length === 0) {
    return {
      ok: false,
      errors: [
        headline(
          "nothing was rolled back and " + targetSha + " is still live. Fix forward, or run the manual rollback workflow with a known-good commit",
        ),
      ].concat(skipped),
    };
  }

  const restored = restoreApps.map((app) => app + " " + plan.restore[app].sha).join(", ");
  deps.log("rolling back to " + restored);
  try {
    const shas = {};
    for (const app of restoreApps) shas[app] = plan.restore[app].sha;
    await promote(deps, config, shas);
    await trigger(deps, config, shas);
  } catch (caught) {
    return {
      ok: false,
      errors: [
        headline(
          "the rollback to " + restored + " FAILED while promoting or deploying (" + messageOf(caught) + "); the deployment needs a person now",
        ),
      ].concat(skipped),
    };
  }

  // The gate after a rollback expects each restored half's old commit,
  // and no particular commit from a half that stayed on the new build —
  // which is still checked for being up.
  const after = await waitForHealthy(deps, config, {
    serverSha: plan.restore.server ? plan.restore.server.sha : null,
    clientSha: plan.restore.client ? plan.restore.client.sha : null,
  });
  if (after.ok !== true) {
    return {
      ok: false,
      errors: [
        headline(
          "the rollback to " + restored + " FAILED its own gate (" + after.failed + ": " + after.detail + "); the deployment needs a person now",
        ),
      ].concat(skipped),
    };
  }
  return {
    ok: false,
    errors: [headline("rolled back to " + restored + ", which passed the gate")].concat(skipped),
  };
};

/**
 * The gate alone, for a layout with no image to promote: nothing to
 * restore, but the same checks.
 */
export const runVerify = async (deps, config, targetSha) => {
  const verdict = await waitForHealthy(deps, config, {
    serverSha: ORIGINS.api === "" ? null : targetSha,
    clientSha: ORIGINS.web === "" ? null : targetSha,
  });
  return verdict.ok === true
    ? { ok: true, errors: [] }
    : { ok: false, errors: [targetSha + " failed the deploy gate (" + verdict.failed + ": " + verdict.detail + ")"] };
};
`;
}

/**
 * The entry: argv, environment, git and the real `fetch`.
 *
 * Deliberately the only file in the pair that can fail for a reason that
 * has nothing to do with the deploy. It also carries the rule the
 * reference implementation learned the hard way: with NO platform
 * credentials configured it prints a notice and exits 0, and with HALF
 * of them it fails — half a deploy is worse than none.
 */
export function renderDeployEntry(plan: VerifiedDeployPlan): string {
  return `#!/usr/bin/env node
/**
 * Promote, deploy, gate and — when the gate fails — roll back ${plan.name}.
 *
 *   node ${DEPLOY_ENTRY_REL_PATH} deploy --sha <sha> [--which both|${plan.apps.join("|")}]
 *        [--rollback] [--guard-server-downgrade] [--force-server]
 *   node ${DEPLOY_ENTRY_REL_PATH} verify --sha <sha>
 *
 * The deploy workflow runs 'deploy --rollback' on every push to the
 * default branch. The manual rollback workflow runs 'deploy' with
 * '--guard-server-downgrade', and adds '--rollback' only when the
 * operator asked for the images that were live before the run to be put
 * back — after a manual rollback those are usually the build being
 * escaped, so restoring them would promote it again.
 *
 * Generated and OWNED by hatchkit: every 'hatchkit update' regenerates
 * this file from the project manifest, so an edit made here is lost on
 * the next run.
 *
 * All the logic, and all of its tests, live in
 * ${DEPLOY_LIB_REL_PATH}; this file only supplies the network, the
 * clock and git.
 *
 * The migration guard reads the registry at two commits with git, so the
 * checkout needs the full history (fetch-depth: 0). A shallow checkout
 * is the usual reason a rollback is refused as 'unknown'.
 *
 * Environment: COOLIFY_BASE_URL; per application its uuid, deploy
 * secret, repository and branch (COOLIFY_RESOURCE_UUID,
 * COOLIFY_DEPLOY_SECRET, COOLIFY_DEPLOY_REPOSITORY, COOLIFY_DEPLOY_BRANCH
 * for a single application, or the same names with SERVER_ / CLIENT_
 * after COOLIFY_ for two); GITHUB_TOKEN with packages: write, which moves
 * the live tag; and optionally HATCHKIT_WEB_URL / HATCHKIT_API_URL to
 * override the origins this project was generated with. There is no
 * platform API token: each deploy secret deploys one application.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import {
  APPS,
  IMAGE_BASE,
  MIGRATIONS,
  ORIGINS,
  parseWhich,
  runDeploy,
  runVerify,
} from "./lib/hatchkit-deploy.mjs";

const inActions = process.env.GITHUB_ACTIONS === "true";
const fail = (message) =>
  console.error(inActions ? "::error::" + message.replace(/\\n/g, "%0A") : "ERROR: " + message);
const notice = (message) => console.log(inActions ? "::notice::" + message : message);

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const haveCommit = (sha) => {
  try {
    git("cat-file", "-e", sha + "^{commit}");
    return true;
  } catch (caught) {
    return false;
  }
};

const numericField = (text, field) => {
  const match = new RegExp('\\\\b"?' + field + '"?\\\\s*[:=]\\\\s*(\\\\d+)').exec(text);
  return match ? Number(match[1]) : null;
};

const registries = new Map();

/**
 * The migration registry at a commit, out of git.
 *
 * A directory that is not there is an empty registry — a project with no
 * migrations cannot have one that blocks a rollback. Anything else that
 * cannot be read is an error, which the guard treats as unsafe.
 */
const readRegistry = (sha) => {
  const cached = registries.get(sha);
  if (cached) return cached;
  const read = (() => {
    if (!haveCommit(sha)) {
      try {
        git("fetch", "--no-tags", "--quiet", "origin", sha);
      } catch (caught) {
        // Reported below as a commit missing from the checkout.
      }
      if (!haveCommit(sha)) {
        return { ok: false, error: "commit " + sha + " is not in this checkout (fetch-depth: 0?)" };
      }
    }
    let names;
    try {
      names = git("ls-tree", "--name-only", sha + ":" + MIGRATIONS.dir)
        .split("\\n")
        .filter(Boolean);
    } catch (caught) {
      // git exits non-zero for a path that does not exist at that commit,
      // which is a project without migrations, not an unreadable one.
      return { ok: true, registry: { migrations: [], schemaVersion: 0 } };
    }
    const migrations = [];
    for (const name of names) {
      if (!/\\.(ts|js|mjs|cjs|sql)$/.test(name) || /^index\\./.test(name)) continue;
      let text;
      try {
        text = git("show", sha + ":" + MIGRATIONS.dir + "/" + name);
      } catch (caught) {
        return { ok: false, error: MIGRATIONS.dir + "/" + name + " could not be read at " + sha };
      }
      const id = numericField(text, MIGRATIONS.idField);
      const minReader = numericField(text, MIGRATIONS.minReaderField);
      if (id === null || minReader === null) {
        return {
          ok: false,
          error: MIGRATIONS.dir + "/" + name + " has no literal " + MIGRATIONS.idField + " and " + MIGRATIONS.minReaderField,
        };
      }
      migrations.push({ id: id, file: name, minReader: minReader });
    }
    migrations.sort((a, b) => a.id - b.id);
    return {
      ok: true,
      registry: {
        migrations: migrations,
        schemaVersion: migrations.length === 0 ? 0 : migrations[migrations.length - 1].id,
      },
    };
  })();
  registries.set(sha, read);
  return read;
};

const deps = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
  readRegistry: readRegistry,
};

const env = (name) => (process.env[name] || "").trim();
const trimSlash = (value) => value.replace(/\\/+$/, "");

const main = async () => {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      sha: { type: "string" },
      which: { type: "string", default: "both" },
      rollback: { type: "boolean", default: false },
      "guard-server-downgrade": { type: "boolean", default: false },
      "force-server": { type: "boolean", default: false },
    },
  });
  const command = parsed.positionals[0];
  const sha = (parsed.values.sha || "").trim().toLowerCase();
  if ((command !== "deploy" && command !== "verify") || sha === "") {
    fail("usage: node ${DEPLOY_ENTRY_REL_PATH} deploy|verify --sha <sha> [--which both|" + APPS.join("|") + "] [--rollback]");
    return 2;
  }

  const webOrigin = trimSlash(env("HATCHKIT_WEB_URL") || ORIGINS.web);
  const apiOrigin = trimSlash(env("HATCHKIT_API_URL") || ORIGINS.api);
  if (webOrigin === "" && apiOrigin === "") {
    fail("neither a web nor an API origin is set, so nothing could be verified.");
    return 2;
  }

  if (command === "verify") {
    const result = await runVerify(deps, { webOrigin: webOrigin, apiOrigin: apiOrigin }, sha);
    if (result.ok) return 0;
    fail(result.errors.join("\\n"));
    return 1;
  }

  const apps = parseWhich(parsed.values.which);
  const baseUrl = trimSlash(env("COOLIFY_BASE_URL"));
  // A single application carries the unprefixed names; a split project
  // one set per half. Each half falls back to the unprefixed set, which
  // is how a single-origin project's two halves share one application.
  const hookName = (app, key) =>
    env("COOLIFY_" + app.toUpperCase() + "_" + key) !== ""
      ? "COOLIFY_" + app.toUpperCase() + "_" + key
      : "COOLIFY_" + key;
  const hooks = {};
  const needed = [["COOLIFY_BASE_URL", baseUrl]];
  for (const app of apps) {
    hooks[app] = {};
    for (const [field, key] of [
      ["uuid", "RESOURCE_UUID"],
      ["secret", "DEPLOY_SECRET"],
      ["repository", "DEPLOY_REPOSITORY"],
      ["branch", "DEPLOY_BRANCH"],
    ]) {
      const name = hookName(app, key);
      hooks[app][field] = env(name);
      needed.push([name, hooks[app][field]]);
    }
  }
  const registryPassword = env("GITHUB_TOKEN");
  needed.push(["GITHUB_TOKEN", registryPassword]);

  const unique = needed.filter((pair, index) => needed.findIndex((other) => other[0] === pair[0]) === index);
  const missing = unique.filter((pair) => pair[1] === "").map((pair) => pair[0]);
  // Nothing configured is a project that does not deploy from CI yet.
  // SOME of it configured is a half-built deploy, which is worse than
  // none, so it fails rather than doing part of the work. GITHUB_TOKEN is
  // not counted: it is always there in Actions.
  const platformNames = unique.filter((pair) => pair[0] !== "GITHUB_TOKEN");
  if (platformNames.every((pair) => pair[1] === "")) {
    notice("No platform deploy secrets are set — nothing was deployed.");
    return 0;
  }
  if (missing.length > 0) {
    fail(missing.join(", ") + " not set, while the other deploy secrets are. Set all of them (hatchkit sync) or none.");
    return 1;
  }

  const imageBase = Object.assign({}, IMAGE_BASE);
  const ownerRepo = env("IMAGE_OWNER_REPO");
  for (const app of apps) {
    if (!imageBase[app] && ownerRepo !== "") imageBase[app] = "ghcr.io/" + ownerRepo + "-" + app;
    if (!imageBase[app]) {
      fail("no image reference is known for the " + app + " half: set IMAGE_OWNER_REPO, or run hatchkit regen-infra.");
      return 2;
    }
  }

  const result = await runDeploy(
    deps,
    {
      baseUrl: baseUrl,
      hooks: hooks,
      registryAuth: { username: env("GITHUB_ACTOR") || "x-access-token", password: registryPassword },
      imageBase: imageBase,
      webOrigin: webOrigin,
      apiOrigin: apiOrigin,
    },
    {
      targetSha: sha,
      apps: apps,
      rollback: parsed.values.rollback,
      guardServerDowngrade: parsed.values["guard-server-downgrade"],
      forceServer: parsed.values["force-server"],
    },
  );
  if (result.ok) {
    notice(apps.join(" and ") + " at " + sha + " passed the deploy gate.");
    return 0;
  }
  // One annotation, so the run summary shows the headline — the failed
  // check, the new commit and what was restored — with its details under
  // it.
  fail(result.errors.join("\\n"));
  return 1;
};

main().then(
  (code) => process.exit(code),
  (caught) => {
    fail(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  },
);
`;
}
