/*
 * cli/src/features/selfhost/index.ts — everything a stranger needs to run
 * the project on their own machine, and the CI workflow that proves a
 * fresh install boots and serves.
 *
 * Seven files, each of which exists because of a specific way this breaks:
 *
 *   · the self-host compose file — one domain, a proxy in front, only the
 *     proxy publishing ports, pulled images with NO `build:` section so a
 *     bad tag fails at the registry instead of turning into an OOM-killed
 *     build;
 *   · the proxy config — the API prefix and the socket path to the server,
 *     everything else to the web app, the socket route keeping its prefix
 *     and the build-info file served uncached;
 *   · the build override — the opt-in that builds from a clone, and the
 *     only place an image is built with the EMPTY API URL that lets one
 *     published image work behind anybody's domain;
 *   · the CI override — the same stack with the images this run built;
 *   · the env example — the five values that have to be filled in, and
 *     nothing that is not needed to boot;
 *   · the derived client Dockerfile — the project's own, minus the guard
 *     that fails a build with no API URL;
 *   · the smoke workflow — so none of the above can rot unnoticed.
 *
 * Generic by construction. Service names, ports, image references, the
 * datastore set and the socket path all come from
 * {@link OperationalProject} and the project's features: a project with no
 * websocket feature gets no socket route, a `backend` project gets no web
 * service and the proxy sends everything to the server, and a `static`
 * project — which has no server half at all — is skipped with a reason
 * rather than handed a stack with nothing in it.
 *
 * ---------------------------------------------------------------------
 * Owned files, and why that is the right call here
 * ---------------------------------------------------------------------
 *
 * Every one of the seven is GENERATED: hatchkit derives it from the
 * project and regenerates it, and there is no part of any of them a
 * person is expected to maintain. So each is written with
 * `ledger.writeIfChanged`, which replaces a drifted copy and reports
 * `unchanged` when there is nothing to do.
 *
 * That is a deliberate change from the first version of this module,
 * which refused to touch any file that already existed. Refusing made the
 * second run a no-op even when the stack had genuinely moved on — a new
 * datastore, a renamed trust key, a fixed proxy rule — so a project
 * scaffolded once kept the first version of the stack for ever and the
 * smoke workflow went on testing it. An owned file that says, in its own
 * header, that it is regenerated is the better trade: the person who
 * wants to change something copies it under a name hatchkit does not
 * write. {@link ownedFileHeader} is that header, and every renderer
 * emits it.
 *
 * The values that cannot be regenerated — a domain, a session secret —
 * live in `.env`, which this module never writes. Only the EXAMPLE is
 * owned.
 *
 * Every decision lives in a pure function the tests drive directly
 * (`selfHostServices`, `proxyRoutes`, `storeClientOrigins`,
 * `selfHostEnvKeys`) while this module only reads and writes files —
 * and it does both through the ledger, so `--dry-run` needs no flag of
 * its own here.
 */

import {
  type OperationalContext,
  type OperationalOutcome,
  applied,
  hasServerHalf,
  skipped,
} from "../operational-context.js";
import {
  PROXY_CONFIG_REL,
  SELFHOST_BUILD_OVERRIDE_REL,
  SELFHOST_CI_OVERRIDE_REL,
  SELFHOST_CLIENT_DOCKERFILE_REL,
  SELFHOST_COMPOSE_REL,
  renderSelfHostBuildOverride,
  renderSelfHostCiOverride,
  renderSelfHostCompose,
  selfHostClientDockerfile,
  selfHostPlan,
} from "./compose.js";
import { SELFHOST_ENV_EXAMPLE_REL, renderSelfHostEnvExample } from "./env-example.js";
import { renderProxyConfig } from "./proxy.js";
import { SELFHOST_SMOKE_WORKFLOW_REL, renderSmokeWorkflow } from "./smoke-workflow.js";
import {
  SERVER_TRUST_CONFIG_REL,
  STORE_CLIENT_ORIGINS_KEY,
  TRUST_EXTENSION_ORIGINS_KEY,
  TRUST_STORE_APPS_KEY,
  storeClientOrigins,
  trustComposeLines,
} from "./trust.js";

export * from "./compose.js";
export * from "./env-example.js";
export * from "./proxy.js";
export * from "./smoke-workflow.js";
export * from "./trust.js";

/** The optional, mail-and-reporting tail of the server's environment
 *  block. Kept out of {@link selfHostServices} because it is the one part
 *  of the stack that is genuinely optional — the app is complete without
 *  any of it. */
function optionalServerEnvLines(): string[] {
  return [
    "",
    "# ── Mail (optional) ─────────────────────────────────────────────",
    "# With these empty nothing is sent and every message is written to the",
    "# server log instead — `docker compose -f docker-compose.selfhost.yml",
    "# logs server` is then how you get a password-reset link.",
    "LISTMONK_URL: ${LISTMONK_URL:-}",
    "LISTMONK_API_USER: ${LISTMONK_API_USER:-}",
    "LISTMONK_API_TOKEN: ${LISTMONK_API_TOKEN:-}",
    "LISTMONK_TX_TEMPLATE_ID: ${LISTMONK_TX_TEMPLATE_ID:-}",
    "LISTMONK_FROM_EMAIL: ${LISTMONK_FROM_EMAIL:-}",
    "",
    "# ── Error reporting (optional) ──────────────────────────────────",
    "SENTRY_DSN: ${SENTRY_DSN:-}",
    "",
    "# No encrypted-env private key of any kind. The published image carries",
    "# no encrypted .env file, so that tooling never activates and every",
    "# value above is read as a plain environment variable.",
  ];
}

/**
 * Write the self-host stack into the project.
 *
 * Idempotent by construction rather than by refusing to write: every file
 * is rendered from the project and handed to `writeIfChanged`, so a
 * second run over an untouched project reports `unchanged` for all of
 * them and writes nothing.
 *
 * `ctx.force` is not consulted, and that is not an oversight. It exists
 * for a module that would otherwise leave a user's edits alone; this one
 * owns every file it writes and regenerates each of them, so there is no
 * weaker behaviour for `force` to escalate from.
 *
 * What it returns is only what a person still has to do: publish the
 * images, decide which clients may sign in, point DNS at the machine.
 * Which files changed is the ledger's account, not this one's.
 */
export function applySelfHost(ctx: OperationalContext): OperationalOutcome {
  const { ledger, project } = ctx;

  if (!hasServerHalf(project.surfaces)) {
    return skipped(
      "a static project has no server half, so a self-host stack would have nothing to run",
    );
  }

  const plan = selfHostPlan(project);
  const notes: string[] = [];

  const serverExtras = [...trustComposeLines(project), ...optionalServerEnvLines()];
  ledger.writeIfChanged(SELFHOST_COMPOSE_REL, renderSelfHostCompose(project, {}, serverExtras));
  ledger.writeIfChanged(PROXY_CONFIG_REL, renderProxyConfig(project));
  ledger.writeIfChanged(SELFHOST_BUILD_OVERRIDE_REL, renderSelfHostBuildOverride(project));
  ledger.writeIfChanged(SELFHOST_CI_OVERRIDE_REL, renderSelfHostCiOverride(project));
  ledger.writeIfChanged(SELFHOST_ENV_EXAMPLE_REL, renderSelfHostEnvExample(project));
  ledger.writeIfChanged(SELFHOST_SMOKE_WORKFLOW_REL, renderSmokeWorkflow(project));

  // The self-host web image is the project's own client image minus the
  // guard that fails the build on an empty API URL. Derived rather than
  // written from scratch, so it keeps every other decision the project's
  // Dockerfile already made — which also makes it idempotent: the source
  // is the untouched original, never the file this writes.
  if (plan.hasClient) {
    const base = ledger.read(plan.clientDockerfile);
    if (base === undefined) {
      notes.push(
        `Write ${SELFHOST_CLIENT_DOCKERFILE_REL} by hand: there is no ${plan.clientDockerfile} to derive it from, and it has to build the web bundle with an EMPTY NEXT_PUBLIC_API_URL.`,
      );
    } else {
      const derived = selfHostClientDockerfile(base);
      if (derived === base) {
        notes.push(
          `Check by hand that ${plan.clientDockerfile} builds with an empty NEXT_PUBLIC_API_URL: it carries no build-time guard for hatchkit to remove, so ${SELFHOST_CLIENT_DOCKERFILE_REL} was not derived from it.`,
        );
      } else {
        ledger.writeIfChanged(SELFHOST_CLIENT_DOCKERFILE_REL, derived);
      }
    }
  }

  notes.push(
    `Publish ${plan.imageStem}-server and ${plan.hasClient ? `${plan.imageStem}-client-selfhost ` : ""}for each release tag, or the compose file has nothing to pull.`,
  );
  if (plan.hasClient) {
    notes.push(
      `Build the ...-client-selfhost image with an EMPTY NEXT_PUBLIC_API_URL. A URL baked in binds the image to one host, and every self-hoster would have to build their own before signing in once.`,
    );
  }
  const origins = storeClientOrigins(project);
  notes.push(
    `Decide which clients may sign in. ${TRUST_STORE_APPS_KEY} defaults to true, which trusts ${origins.length > 0 ? origins.join(", ") : "nothing, because this project ships no store client"}; set it to false in .env to accept the web app alone. The server reads it, ${STORE_CLIENT_ORIGINS_KEY} and ${TRUST_EXTENSION_ORIGINS_KEY} in ${SERVER_TRUST_CONFIG_REL}.`,
  );
  notes.push(
    "Self-hosters need an A/AAAA record for their own domain pointing at the machine, and ports 80 and 443 open — port 80 answers the certificate challenge.",
  );
  return applied(notes);
}
