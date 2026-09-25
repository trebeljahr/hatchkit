/*
 * The smoke workflow — proof that a fresh self-host boots and serves.
 *
 * ---------------------------------------------------------------------
 * Why this is not optional
 * ---------------------------------------------------------------------
 *
 * Nothing else in CI reads the self-host files. The unit and E2E suites
 * run the halves directly, and the owner's deploy uses its own compose
 * files, so a self-host stack that stopped booting would be discovered by
 * the first stranger who tried to install it — weeks after the commit
 * that broke it, by somebody with no way to tell a broken release from
 * their own mistake.
 *
 * ---------------------------------------------------------------------
 * What a pass means
 * ---------------------------------------------------------------------
 *
 *   · the images build from this commit;
 *   · every service reaches `healthy` under the base file's OWN
 *     healthchecks — waited for, never slept on, because a sleep long
 *     enough to be reliable is long enough to hide a service that takes
 *     twice as long as it should;
 *   · the site answers through the proxy, over TLS;
 *   · the API answers through the proxy, so `/api/*` routing is exercised
 *     and not just the server container;
 *   · the build-info file comes back uncached;
 *   · the socket upgrade survives the proxy — the failure that produces
 *     an app which works and never updates.
 *
 * On failure every service's log is dumped, grouped by service. A smoke
 * test whose failure output is "exit code 1" costs more than it saves:
 * the person reading it has no stack to poke at, so the run has to hand
 * them everything it saw.
 *
 * Nothing is pushed or published, and the session secret is generated per
 * run and masked.
 */

import type { OperationalProject } from "../operational-context.js";
import { hasServerHalf } from "../operational-context.js";
import {
  PROXY_CONFIG_REL,
  SELFHOST_BUILD_OVERRIDE_REL,
  SELFHOST_CI_OVERRIDE_REL,
  SELFHOST_CLIENT_DOCKERFILE_REL,
  SELFHOST_COMPOSE_REL,
  type SelfHostOptions,
  ciImageTag,
  ownedFileHeader,
  selfHostPlan,
} from "./compose.js";
import { SELFHOST_ENV_EXAMPLE_REL } from "./env-example.js";
import { BUILD_INFO_PATH } from "./proxy.js";

export const SELFHOST_SMOKE_WORKFLOW_REL = ".github/workflows/selfhost-smoke.yml";

/** The paths whose changes must re-run the smoke test. Everything the
 *  stack is made of, plus the workflow itself — a pull request that
 *  edits the proxy config and does not re-run this has no proof left. */
export function smokeWorkflowPaths(
  project: OperationalProject,
  opts: SelfHostOptions = {},
): string[] {
  const plan = selfHostPlan(project, opts);
  const paths = [
    SELFHOST_COMPOSE_REL,
    SELFHOST_CI_OVERRIDE_REL,
    SELFHOST_BUILD_OVERRIDE_REL,
    PROXY_CONFIG_REL,
    SELFHOST_ENV_EXAMPLE_REL,
    plan.serverDockerfile,
  ];
  if (plan.hasClient) paths.push(SELFHOST_CLIENT_DOCKERFILE_REL);
  paths.push(SELFHOST_SMOKE_WORKFLOW_REL);
  return paths;
}

/** Render `.github/workflows/selfhost-smoke.yml`. */
export function renderSmokeWorkflow(
  project: OperationalProject,
  opts: SelfHostOptions = {},
): string {
  if (!hasServerHalf(project.surfaces)) return "";
  const plan = selfHostPlan(project, opts);
  const compose = `docker compose -f ${SELFHOST_COMPOSE_REL} -f ${SELFHOST_CI_OVERRIDE_REL}`;
  const lines: string[] = [
    ...ownedFileHeader(),
    `# Boots the ${project.name} self-host stack from this checkout and proves it serves.`,
    "#",
    "# Nothing else in CI reads the self-host files, so a stack that stopped",
    "# booting would otherwise be found by the first person who tried to",
    "# install it. What a pass means:",
    "#",
    "#   - the images build from this commit;",
    "#   - every service reaches `healthy` under the base file's own",
    "#     healthchecks — waited for, never slept on;",
    "#   - the site and the API both answer THROUGH the proxy, over TLS, so",
    "#     the routing is exercised and not just the containers.",
    "#",
    "# On failure every service's log is dumped, grouped by service: a smoke",
    "# test whose failure output is `exit code 1` leaves the reader with",
    "# nothing to act on.",
    "#",
    "# Nothing is pushed or published. The session secret is generated per",
    "# run and the stack is torn down at the end.",
    "",
    "name: selfhost-smoke",
    "",
    "on:",
    "  pull_request:",
    "    paths:",
    ...smokeWorkflowPaths(project, opts).map((p) => `      - ${p}`),
    "  # Weekly, because this path rots from the outside too: a base image",
    "  # that changed, a registry that moved, a published release whose",
    "  # images were never pushed.",
    "  schedule:",
    '    - cron: "27 5 * * 1"',
    "  workflow_dispatch:",
    "",
    "concurrency:",
    "  group: selfhost-smoke-${{ github.event.pull_request.number || github.ref }}",
    "  cancel-in-progress: true",
    "",
    "permissions:",
    "  contents: read",
    "",
    "env:",
    `  COMPOSE: ${compose}`,
    "  # The proxy serves `localhost` from its internal CA, so the run needs",
    "  # no DNS, no public IP and no ACME rate limit to hit. curl trusts it",
    "  # with -k.",
    "  APP_DOMAIN: localhost",
    "",
    "jobs:",
    "  smoke:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 30",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "",
    "      - uses: docker/setup-buildx-action@v3",
    "",
    "      # `load: true` puts the image in the runner's Docker under the tag",
    "      # the CI override pins, so the stack runs THIS commit. Without it",
    "      # the base file's image keys would pull the last published release",
    "      # and the run would prove that an old image boots.",
    "      - name: Build the server image",
    "        uses: docker/build-push-action@v6",
    "        with:",
    "          context: .",
    `          file: ${plan.serverDockerfile}`,
    "          load: true",
    "          push: false",
    `          tags: ${ciImageTag(project, "server")}`,
    "          cache-from: type=gha,scope=selfhost-smoke-server",
    "          cache-to: type=gha,mode=max,scope=selfhost-smoke-server",
    "          # Ignored by a Dockerfile that mounts no such secret.",
    "          secrets: |",
    "            dotenvx_private_key=${{ secrets.DOTENV_PRIVATE_KEY_PRODUCTION }}",
  ];

  if (plan.hasClient) {
    lines.push(
      "",
      "      - name: Build the self-host web image",
      "        uses: docker/build-push-action@v6",
      "        with:",
      "          context: .",
      `          file: ${SELFHOST_CLIENT_DOCKERFILE_REL}`,
      "          load: true",
      "          push: false",
      `          tags: ${ciImageTag(project, "client")}`,
      "          # EMPTY on purpose, and asserted by the feature's tests: the",
      "          # self-host bundle calls its own origin, which is what lets one",
      "          # published image work behind anybody's domain. A value here",
      "          # would bind the image to one host for ever.",
      "          build-args: |",
      "            NEXT_PUBLIC_API_URL=",
      "            NEXT_PUBLIC_WS_URL=",
      "          cache-from: type=gha,scope=selfhost-smoke-client",
      "          cache-to: type=gha,mode=max,scope=selfhost-smoke-client",
      "          secrets: |",
      "            dotenvx_private_key=${{ secrets.DOTENV_PRIVATE_KEY_PRODUCTION }}",
    );
  }

  lines.push(
    "",
    "      - name: Generate a session secret",
    "        run: |",
    '          secret="$(openssl rand -base64 32)"',
    '          echo "::add-mask::$secret"',
    '          echo "BETTER_AUTH_SECRET=$secret" >> "$GITHUB_ENV"',
    "",
    "      # Catches an interpolation or merge error before anything starts,",
    "      # where the message still names the file and the line.",
    "      - name: Validate the merged compose file",
    "        run: $COMPOSE config --quiet",
    "",
    "      # `--wait` blocks until every healthcheck passes, which is the",
    "      # assertion: a sleep long enough to be reliable is long enough to",
    "      # hide a service that takes twice as long as it should.",
    "      - name: Boot the stack and wait for every healthcheck",
    "        run: $COMPOSE up -d --no-build --wait --wait-timeout 300",
    "",
    `      - name: The API answers through the proxy`,
    "        run: |",
    "          set -euo pipefail",
    "          # -k: the certificate comes from the proxy's internal CA, which",
    "          # the runner does not trust. That is the point of using it.",
    "          status=\"$(curl -sk -o health.json -w '%{http_code}' \\",
    `            \"https://$APP_DOMAIN${plan.apiPrefix}/health\")\"`,
    "          cat health.json; echo",
    '          if [ "$status" != "200" ]; then',
    `            echo "::error::${plan.apiPrefix}/health answered HTTP $status through the proxy"`,
    "            exit 1",
    "          fi",
  );

  if (plan.hasClient) {
    lines.push(
      "",
      "      - name: The site answers through the proxy",
      "        run: |",
      "          set -euo pipefail",
      '          status="$(curl -sk -o page.html -w \'%{http_code}\' "https://$APP_DOMAIN/")"',
      '          if [ "$status" != "200" ]; then',
      "            head -c 2000 page.html; echo",
      '            echo "::error::the site answered HTTP $status through the proxy"',
      "            exit 1",
      "          fi",
      "          # A zero-length 200 is a proxy that answered instead of the app.",
      '          [ -s page.html ] || { echo "::error::the site served an empty body"; exit 1; }',
      "",
      `      - name: ${BUILD_INFO_PATH} is served uncached`,
      "        run: |",
      "          set -euo pipefail",
      "          # The deploy-recovery check asks the DEPLOYED artefact what it",
      "          # is by fetching this file. A cached copy would let a rolled",
      "          # back deploy keep reporting the commit it no longer serves.",
      "          curl -sk -D info.headers -o info.json \\",
      `            \"https://$APP_DOMAIN${BUILD_INFO_PATH}\"`,
      "          cat info.json; echo",
      "          grep -i '^cache-control:.*no-cache' info.headers > /dev/null \\",
      `            || { cat info.headers; echo "::error::${BUILD_INFO_PATH} is not served no-cache"; exit 1; }`,
    );
  }

  if (plan.hasSocket) {
    lines.push(
      "",
      "      - name: The socket upgrade survives the proxy",
      "        run: |",
      "          set -euo pipefail",
      "          # The server compares the upgrade path literally, so a proxy",
      "          # rule that stripped the prefix would answer with a 502 and",
      "          # the app would work with nothing ever updating live. curl",
      "          # holds the connection open after the 101, hence --max-time.",
      "          curl -sk --http1.1 --max-time 10 -o /dev/null -D ws.headers \\",
      "            -H 'Connection: Upgrade' -H 'Upgrade: websocket' \\",
      "            -H 'Sec-WebSocket-Version: 13' \\",
      // Exactly 16 bytes base64-encoded, as the protocol requires — a
      // shorter key is rejected before the route is ever exercised.
      "            -H 'Sec-WebSocket-Key: c2VsZmhvc3RzbW9rZTEyMw==' \\",
      `            \"https://$APP_DOMAIN${plan.socketPath}\" || true`,
      "          grep -qi '^HTTP/1.1 101' ws.headers \\",
      "            || { cat ws.headers; \\",
      `                 echo \"::error::${plan.socketPath} did not upgrade through the proxy\"; exit 1; }`,
    );
  }

  lines.push(
    "",
    "      # Grouped per service: one merged log with five services in it is",
    "      # how a smoke failure becomes somebody else's afternoon.",
    "      - name: Service state and logs",
    "        if: failure()",
    "        run: |",
    "          $COMPOSE ps",
    "          for service in $($COMPOSE config --services); do",
    '            echo "::group::logs $service"',
    '            $COMPOSE logs --no-color --timestamps --tail 300 "$service" || true',
    '            echo "::endgroup::"',
    "          done",
    "",
    "      - name: Tear down",
    "        if: always()",
    "        run: $COMPOSE down -v --remove-orphans",
  );

  return `${lines.join("\n")}\n`;
}
