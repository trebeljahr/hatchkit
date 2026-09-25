/*
 * Deploy verification — make the pipeline assert that the thing running
 * is the thing it just built.
 *
 * ---------------------------------------------------------------------
 * The gap this closes
 * ---------------------------------------------------------------------
 *
 * The generated pipeline used to end like this:
 *
 *     curl -fsSL -X POST "$COOLIFY_BASE_URL/api/v1/deploy?uuid=…"
 *
 * That is an assertion about Coolify's INBOX. It does not wait for the
 * deployment (the POST returns as soon as the work is queued) and it
 * never looks at what ends up running. Neither generated artefact knew
 * its own version, so "is the deployed thing the thing I built?" could
 * not be answered at all — not from CI, not from ghcr, not from the
 * Coolify dashboard.
 *
 * Three real failures shipped green through that gap (tracktime,
 * 2026-09-08):
 *
 *   1. Stale container. The compose files reference a MUTABLE tag
 *      (`:main`) and Docker keeps the image it already has for one, so
 *      Coolify started the PREVIOUS build. A client that had been
 *      migrated to a new API host kept calling the old one for hours
 *      while every status surface reported the new commit.
 *   2. Empty build arg. The workflow read an unset repo variable, so
 *      every client image for months was built with an empty API URL.
 *      NEXT_PUBLIC_* is inlined by Next at build time, so the image
 *      built perfectly and started healthy.
 *   3. Crash-looping server behind a proxy. Coolify reported
 *      `running:healthy` while the container restarted repeatedly and
 *      the proxy answered 503. (Diagnosed separately — see
 *      deploy/coolify-db-network.ts.)
 *
 * ---------------------------------------------------------------------
 * The five pieces
 * ---------------------------------------------------------------------
 *
 *   1. Both images carry their commit (`COMMIT_SHA` build arg).
 *   2. Both artefacts expose it — the server on `/api/health` as
 *      `version`, the client as a static `/version.json` carrying
 *      `{commit, apiUrl}`.
 *   3. The client build FAILS when the inlined API URL never reached
 *      the browser bundle.
 *   4. The deploy job pins the immutable `:<sha>` image tag on the
 *      Coolify app(s) before deploying.
 *   5. A post-deploy gate polls both artefacts until they report the
 *      pushed sha, asserts the client's baked `apiUrl`, and asserts a
 *      CORS preflight — then fails the run if any of it is wrong.
 *
 * ---------------------------------------------------------------------
 * Why the blocks live here as constants
 * ---------------------------------------------------------------------
 *
 * The starter (`hatchkit create`) ships these pieces in its own files;
 * this module carries byte-identical copies so `hatchkit update` /
 * `hatchkit regen-infra` can retrofit a project scaffolded before they
 * existed. Two copies of anything drift, so the test suite asserts the
 * starter's files literally contain every constant below
 * (test-deploy-verification.ts). Editing one without the other fails
 * the suite rather than shipping two subtly different gates.
 *
 * Every transform here is idempotent and returns its input unchanged
 * when the anchor is missing — a hand-rolled workflow or Dockerfile is
 * safer left alone than half-rewritten.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Topology } from "../deploy/routing.js";
import { clientBuildArgUrls } from "./client-build-args.js";
import { nativeClientOrigins } from "./native-origins.js";

/** Project shape, as recorded in the manifest's `surfaces`. Decides
 *  which halves of the gate can run at all. */
export type VerifySurfaces = "fullstack" | "split" | "backend" | "static";

/** Public URLs the post-deploy gate probes.
 *
 *  An empty string means "this project has no such half", and the
 *  generated script skips that half rather than failing on it:
 *  a `backend` project has no web URL, a `static` one has no API.
 *  When the two are equal the project is single-origin and the CORS
 *  check is skipped — there is no cross-origin request to make. */
export interface DeployVerifyUrls {
  webUrl: string;
  apiUrl: string;
}

/** Derive the gate's probe URLs from the same two manifest fields the
 *  client build args come from, so the URL the client is BUILT against
 *  and the URL the gate CHECKS can never disagree. */
export function deployVerifyUrls(
  domain: string,
  topology: Topology = "single-origin",
  surfaces: VerifySurfaces = "fullstack",
): DeployVerifyUrls {
  const { apiUrl } = clientBuildArgUrls(domain, topology);
  return {
    webUrl: surfaces === "backend" ? "" : `https://${domain}`,
    apiUrl: surfaces === "static" ? "" : apiUrl,
  };
}

// ---------------------------------------------------------------------------
// Canonical blocks — mirrored byte-for-byte in starter/. See module header.
// ---------------------------------------------------------------------------

/** `pull_policy: always` plus the explanation of which failure it
 *  prevents. Indented for a compose service body. */
export const COMPOSE_PULL_POLICY_BLOCK = `    # Always re-pull the tag before starting. Without this, Docker keeps
    # the image it already has for a mutable tag like \`:main\` and a deploy
    # silently runs the PREVIOUS build: the container comes up healthy,
    # Coolify reports the new commit, ghcr's \`main\` points at the new
    # digest, and the served code is still the old one. The deploy job
    # also pins SERVER_IMAGE/CLIENT_IMAGE to the commit sha, which removes
    # the ambiguity entirely — this covers the \`:main\` default that a
    # hand-run \`docker compose up\` still uses.
    pull_policy: always
`;

/** Runtime-stage `COMMIT_SHA` for the server image. */
export const SERVER_DOCKERFILE_COMMIT_SHA_BLOCK = `# The git commit this image was built from, surfaced by /api/health so
# "is the deployed thing the thing I built?" is one HTTP request rather
# than an archaeology session. The deploy job polls that field until it
# matches the commit it just pushed — without it, a deploy that silently
# kept the previous container reported success on every status surface.
#
# Runtime env is enough here (unlike the client's NEXT_PUBLIC_*, which
# must be inlined at build time), so it lives in the runtime stage and
# costs no rebuild. Empty outside a CI image build, which is correct —
# a local \`pnpm dev\` has no commit it was built from.
ARG COMMIT_SHA
ENV COMMIT_SHA=$COMMIT_SHA
`;

/** Build-stage `COMMIT_SHA` for the client image. */
export const CLIENT_DOCKERFILE_COMMIT_SHA_BLOCK = `# The git commit this image was built from. Written next to the export as
# version.json (below) so the deployed artefact can be asked what it is —
# the deploy job polls it until it reports the commit CI just pushed.
ARG COMMIT_SHA
ENV COMMIT_SHA=$COMMIT_SHA
`;

/** Post-`next build` assertion that the inlined API URL actually
 *  reached the browser bundle. Separate from the stamp below because
 *  the static prune drops it: a project with no server half has no API
 *  URL to inline, so the guard would fail every image build. See
 *  {@link stripClientDockerfileApiUrlAssertion}. */
export const CLIENT_DOCKERFILE_API_URL_ASSERTION_BLOCK = `# Prove the API URL actually reached the browser bundle, and fail the
# image if it did not.
#
# next.config.ts already refuses to build when NEXT_PUBLIC_API_URL is
# unset (HATCHKIT_IMAGE_BUILD=1 turns that guard on), which catches a
# missing build arg. This catches the case that guard cannot see: a value
# that IS set and still never gets inlined — a renamed variable, a
# reference that only exists in server code, an accidental runtime
# \`process.env\` lookup. Next.js inlines NEXT_PUBLIC_* at build time, so
# an image built that way builds perfectly, starts healthy, and talks to
# the wrong API — or to nothing at all.
RUN test -n "$NEXT_PUBLIC_API_URL" \\
      || (echo "NEXT_PUBLIC_API_URL build arg is empty" >&2; exit 1); \\
    grep -rqF "$NEXT_PUBLIC_API_URL" packages/client/.next/static \\
      || (echo "NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL never made it into the browser bundle" >&2; exit 1)
`;

/** Post-`next build` `version.json` stamp. Applies to every project
 *  shape — the commit is what the gate polls for, and a static
 *  project stamps an empty `apiUrl`, which is the truth about it. */
export const CLIENT_DOCKERFILE_VERSION_STAMP_BLOCK = `# Stamp the commit and the baked API origin next to the export. \`public/\`
# is copied into the runtime stage verbatim, so Next serves this as
# /version.json like any other static file. Two facts, because a correct
# commit can still carry the wrong API URL: the pipeline asserts both.
RUN printf '{"commit":"%s","apiUrl":"%s"}\\n' "$COMMIT_SHA" "$NEXT_PUBLIC_API_URL" \\
      > packages/client/public/version.json
`;

/** Deploy-job step that pins the immutable image tag on the Coolify
 *  app(s) before the deploy POST. */
export const WORKFLOW_PIN_STEP = `      # Pin each app to the IMMUTABLE tag before deploying it.
      #
      # The compose files default to \`:main\`, and Docker keeps whatever
      # image it already has for a mutable tag. That means Coolify can
      # start the PREVIOUS build while ghcr's \`main\`, the Coolify
      # dashboard and this workflow all report the new commit — a client
      # migrated to a new API host keeps calling the old one, and every
      # status surface says the deploy succeeded. \`pull_policy: always\`
      # in the compose files covers the \`:main\` default; pinning the sha
      # tag here removes the ambiguity entirely, and makes rollback "set
      # this variable to an older sha".
      #
      # POST *and* PATCH, in that order: Coolify's env API only UPDATES
      # an existing variable — a PATCH for a key that does not exist is
      # accepted with a 200 and silently does nothing. POST creates it
      # and fails once it exists. Neither alone is enough, so both run
      # and the right one wins. (\`is_build_time\` is rejected on POST with
      # "This field is not allowed"; key/value/is_preview is accepted.)
      # hatchkit creates both variables when it provisions the apps, so
      # in practice the PATCH is the one that does the work.
      #
      # Which uuid secrets are set follows the project's topology — see
      # the deploy-step comments below. A single-origin app runs one
      # compose declaring both services, so it carries both variables.
      - name: Pin image tags to this commit
        env:
          COOLIFY_BASE_URL: \${{ secrets.COOLIFY_BASE_URL }}
          COOLIFY_API_TOKEN: \${{ secrets.COOLIFY_API_TOKEN }}
          COOLIFY_RESOURCE_UUID: \${{ secrets.COOLIFY_RESOURCE_UUID }}
          COOLIFY_SERVER_RESOURCE_UUID: \${{ secrets.COOLIFY_SERVER_RESOURCE_UUID }}
          COOLIFY_CLIENT_RESOURCE_UUID: \${{ secrets.COOLIFY_CLIENT_RESOURCE_UUID }}
        if: env.COOLIFY_BASE_URL != ''
        run: |
          set -euo pipefail
          SERVER_IMAGE="ghcr.io/\${{ github.repository }}-server:\${{ github.sha }}"
          CLIENT_IMAGE="ghcr.io/\${{ github.repository }}-client:\${{ github.sha }}"

          pin() { # uuid key value
            body="{\\"key\\":\\"$2\\",\\"value\\":\\"$3\\",\\"is_preview\\":false}"
            curl -fsS -o /dev/null -X POST \\
              "$COOLIFY_BASE_URL/api/v1/applications/$1/envs" \\
              -H "Authorization: Bearer $COOLIFY_API_TOKEN" \\
              -H 'Content-Type: application/json' -d "$body" || true
            curl -fsSL -o /dev/null -X PATCH \\
              "$COOLIFY_BASE_URL/api/v1/applications/$1/envs" \\
              -H "Authorization: Bearer $COOLIFY_API_TOKEN" \\
              -H 'Content-Type: application/json' -d "$body"
            echo "pinned $2 on $1"
          }

          if [ -n "\${COOLIFY_RESOURCE_UUID:-}" ]; then
            pin "$COOLIFY_RESOURCE_UUID" SERVER_IMAGE "$SERVER_IMAGE"
            pin "$COOLIFY_RESOURCE_UUID" CLIENT_IMAGE "$CLIENT_IMAGE"
          fi
          if [ -n "\${COOLIFY_SERVER_RESOURCE_UUID:-}" ]; then
            pin "$COOLIFY_SERVER_RESOURCE_UUID" SERVER_IMAGE "$SERVER_IMAGE"
          fi
          if [ -n "\${COOLIFY_CLIENT_RESOURCE_UUID:-}" ]; then
            pin "$COOLIFY_CLIENT_RESOURCE_UUID" CLIENT_IMAGE "$CLIENT_IMAGE"
          fi
`;

/** Deploy-job step that proves the deployed artefacts are this run's
 *  build. Always the last step of the deploy job. */
export const WORKFLOW_VERIFY_STEP = `      # Everything above only proves Coolify ACCEPTED a request. This
      # proves the deployed artefacts are the ones this run built.
      #
      # Until this existed, the pipeline's final assertion was an HTTP 200
      # from a POST. A deploy that kept the old container, an image built
      # with an empty API URL, a container crash-looping behind a proxy
      # that answers 503 — all three shipped green, and none of them was
      # visible from CI, from ghcr, or from the Coolify dashboard.
      #
      # Deliberately polls: a Coolify deploy is asynchronous, the POST
      # returns as soon as the deployment is QUEUED.
      #
      # Guarded on a deploy having been TRIGGERED, not on the URLs being
      # set. A per-URL \`if:\` would let this step skip while the deploy
      # steps above ran — a job that reports green having verified
      # nothing, which is the exact failure mode this step exists to
      # remove. When a deploy fired and there is no URL to check, the
      # script fails and says so.
      #
      # HATCHKIT_WEB_URL / HATCHKIT_API_URL are written here as literals
      # by hatchkit from the manifest's domain + topology (and kept
      # current by \`hatchkit rename-domain\` / \`hatchkit regen-infra\`).
      # The \`vars.\` reference is the fallback for a hand-managed repo.
      # Leave one empty to skip that half: a backend-only project has no
      # web URL, a static one has no API. When the two are equal the
      # project is single-origin and the CORS check is skipped, because
      # there is no cross-origin request to make.
      - name: Verify the deployment is actually live
        env:
          COOLIFY_BASE_URL: \${{ secrets.COOLIFY_BASE_URL }}
          COOLIFY_WEBHOOK_URL: \${{ secrets.COOLIFY_WEBHOOK_URL }}
          HATCHKIT_WEB_URL: \${{ vars.HATCHKIT_WEB_URL }}
          HATCHKIT_API_URL: \${{ vars.HATCHKIT_API_URL }}
        if: env.COOLIFY_BASE_URL != '' || env.COOLIFY_WEBHOOK_URL != ''
        run: |
          set -uo pipefail
          SHA='\${{ github.sha }}'
          # \`:-\` so a workflow whose env block was edited fails with the
          # gate's own message rather than a bare "unbound variable".
          WEB="\${HATCHKIT_WEB_URL:-}"
          API="\${HATCHKIT_API_URL:-}"
          WEB="\${WEB%/}"
          API="\${API%/}"
          checked=0

          # \`?hatchkit_cb=\` on every request: the point is what the ORIGIN
          # now serves, and a CDN hit would answer with exactly the stale
          # copy being tested for.
          poll() { # label url jq-expression
            got=""
            for i in $(seq 1 40); do
              got=$(curl -fsSL --max-time 10 "$2?hatchkit_cb=$i$RANDOM" 2>/dev/null \\
                      | jq -r "$3" 2>/dev/null || true)
              if [ "$got" = "$SHA" ]; then echo "✓ $1 reports $SHA"; return 0; fi
              echo "  $1: \${got:-<no response>} — waiting ($i/40)"
              sleep 15
            done
            echo "::error::$1 never reported $SHA — the deploy did not land."
            echo "::error::last seen: \${got:-<no response>}"
            echo "::error::an empty/null reading on the first run after upgrading means the"
            echo "::error::artefact does not report a version yet: the server needs"
            echo "::error::\\\`version: env.COMMIT_SHA\\\` on /api/health, the client needs"
            echo "::error::version.json written by its Dockerfile. Both come from COMMIT_SHA."
            return 1
          }

          if [ -n "$API" ]; then
            poll "api $API/api/health" "$API/api/health" '.version' || exit 1
            checked=$((checked + 1))
          fi

          if [ -n "$WEB" ]; then
            poll "web $WEB/version.json" "$WEB/version.json" '.commit' || exit 1
            checked=$((checked + 1))

            # The client bakes its API origin in at build time, so a
            # correct commit can still carry the wrong URL. Assert the
            # pairing — this is the check that catches an image built
            # against an unset repo variable.
            if [ -n "$API" ]; then
              baked=$(curl -fsSL --max-time 10 "$WEB/version.json?hatchkit_cb=$RANDOM" | jq -r '.apiUrl')
              if [ "$baked" != "$API" ]; then
                echo "::error::client was built against '\${baked:-<empty>}', expected '$API'"
                exit 1
              fi
              echo "✓ client is built against $baked"
            fi
          fi

          # Cross-origin only. Under single-origin the API is same-origin
          # with the web app, so CORS never enters the picture; under
          # split it is load-bearing and nothing else exercises it — the
          # e2e suite runs both halves on localhost.
          if [ -n "$WEB" ] && [ -n "$API" ] && [ "$WEB" != "$API" ]; then
            allow=$(curl -fsS --max-time 10 -o /dev/null -D - -X OPTIONS \\
                      -H "Origin: $WEB" \\
                      -H 'Access-Control-Request-Method: POST' \\
                      -H 'Access-Control-Request-Headers: content-type' \\
                      "$API/api/health" \\
                    | tr -d '\\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')
            if [ "$allow" != "$WEB" ]; then
              echo "::error::CORS preflight returned '\${allow:-<none>}', expected '$WEB'"
              echo "::error::the server's FRONTEND_URL / TRUSTED_ORIGINS do not cover the web origin"
              exit 1
            fi
            echo "✓ CORS allows $WEB"
            checked=$((checked + 1))
          fi

          if [ "$checked" -eq 0 ]; then
            echo "::error::a deploy was triggered and nothing was verified."
            echo "::error::set HATCHKIT_WEB_URL / HATCHKIT_API_URL in this workflow"
            echo "::error::(or as repo variables), or run \\\`hatchkit regen-infra\\\`."
            exit 1
          fi
`;

/** Deploy-job step that proves each native shell's origin is trusted by
 *  the deployed server. Runs after {@link WORKFLOW_VERIFY_STEP}, once the
 *  new build is known to be live. */
export const WORKFLOW_NATIVE_ORIGIN_STEP = `      # Native shells (Capacitor, Electron) load the client from their
      # own document origin, and better-auth rejects an origin missing from
      # TRUSTED_ORIGINS with 403 INVALID_ORIGIN before it checks the
      # password. The web-origin CORS check above cannot see that.
      #
      # Two details decide whether this probe can fail at all:
      #   · \`Sec-Fetch-Mode: cors\`. better-auth only force-validates Origin
      #     on a cookieless sign-in when Sec-Fetch-* headers are present,
      #     which every browser and WebView sends and curl does not.
      #   · A body that PASSES schema validation. better-call validates the
      #     body before the sign-in route's origin check runs, so \`{}\`
      #     answers 400 for a trusted and an untrusted origin alike.
      # With both, an untrusted origin gets 403 INVALID_ORIGIN and a trusted
      # one reaches the credential check and gets 401 for an address that
      # cannot exist (\`.invalid\` is reserved). Nothing ever signs in.
      #
      # Sign-in is rate-limited (3 per 10s per IP in production), hence the
      # spacing and the retry on 429.
      #
      # HATCHKIT_NATIVE_ORIGINS is written here as a literal by hatchkit from
      # the manifest's features (mobile / desktop) and kept
      # current by \`hatchkit update\` / \`hatchkit regen-infra\`. Empty means
      # the project ships no native client and there is nothing to check.
      - name: Verify native clients can sign in
        env:
          COOLIFY_BASE_URL: \${{ secrets.COOLIFY_BASE_URL }}
          COOLIFY_WEBHOOK_URL: \${{ secrets.COOLIFY_WEBHOOK_URL }}
          HATCHKIT_API_URL: \${{ vars.HATCHKIT_API_URL }}
          HATCHKIT_NATIVE_ORIGINS: \${{ vars.HATCHKIT_NATIVE_ORIGINS }}
        if: env.COOLIFY_BASE_URL != '' || env.COOLIFY_WEBHOOK_URL != ''
        run: |
          set -uo pipefail
          API="\${HATCHKIT_API_URL:-}"
          API="\${API%/}"
          NATIVE="\${HATCHKIT_NATIVE_ORIGINS:-}"
          if [ -z "$NATIVE" ]; then
            echo "· no native clients in this project — nothing to check"
            exit 0
          fi
          if [ -z "$API" ]; then
            echo "::error::HATCHKIT_NATIVE_ORIGINS is set but HATCHKIT_API_URL is empty — nothing to probe."
            exit 1
          fi
          out=$(mktemp)
          failed=0
          for origin in $(printf '%s' "$NATIVE" | tr ',' ' '); do
            for attempt in 1 2 3; do
              status=$(curl -sS --max-time 10 -o "$out" -w '%{http_code}' \\
                         -X POST "$API/api/auth/sign-in/email" \\
                         -H "Origin: $origin" \\
                         -H 'Sec-Fetch-Mode: cors' \\
                         -H 'content-type: application/json' \\
                         --data '{"email":"hatchkit-origin-probe@example.invalid","password":"hatchkit-origin-probe"}')
              [ "$status" = "429" ] || break
              echo "  $origin: rate-limited, retrying ($attempt/3)"
              sleep 11
            done
            body=$(head -c 300 "$out" 2>/dev/null || true)
            if [ "$status" = "403" ] || printf '%s' "$body" | grep -q INVALID_ORIGIN; then
              echo "::error::$origin is NOT trusted: sign-in answered $status $body"
              echo "::error::add it to TRUSTED_ORIGINS on the server app (\\\`hatchkit sync --deploy\\\`)"
              failed=1
            elif [ "$status" = "401" ]; then
              echo "✓ $origin is trusted (sign-in reached the credential check: 401)"
            else
              echo "::error::$origin: expected 401 from the credential check, got \${status:-<none>} $body"
              failed=1
            fi
            sleep 4
          done
          exit "$failed"
`;

// ---------------------------------------------------------------------------
// Pure content transforms
// ---------------------------------------------------------------------------

/** Add `pull_policy: always` to every compose service running an image
 *  THIS pipeline pushes.
 *
 *  Scoped to `ghcr.io/...` refs on purpose. Those carry a mutable
 *  `:main`-style tag that moves under the running container, which is
 *  the whole failure. A pinned upstream tag (`mongo:7`,
 *  `redis:7-alpine`) does not move, so forcing a registry round-trip on
 *  it every restart would be cost with no cover. */
export function upgradeComposePullPolicy(content: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = lines[i].match(/^([ \t]+)image:[ \t]*(?:\$\{[A-Za-z0-9_]+:-)?ghcr\.io\//);
    if (!m) continue;
    const indent = m[1].length;
    // Scan the rest of this service's body for an existing declaration.
    // The body is every following line indented at least as far as the
    // `image:` key; the first line indented less starts a sibling
    // service (or leaves `services:` entirely).
    let already = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      const lead = lines[j].length - lines[j].trimStart().length;
      if (lead < indent) break;
      if (lead === indent && /^[ \t]*pull_policy[ \t]*:/.test(lines[j])) {
        already = true;
        break;
      }
    }
    if (already) continue;
    out.push(...COMPOSE_PULL_POLICY_BLOCK.replace(/\n$/, "").split("\n"));
  }
  return out.join("\n");
}

/** Bake `COMMIT_SHA` into the server image's RUNTIME stage.
 *
 *  Anchored on the LAST `ENV PORT=` line, which is the runtime stage in
 *  every layout the scaffolder produces. Runtime env is enough for the
 *  server (unlike the client's build-time inlining), so putting it here
 *  costs no rebuild of the dependency layers. */
export function upgradeServerDockerfileCommitSha(content: string): string {
  if (content.includes("ARG COMMIT_SHA")) return content;
  const matches = [...content.matchAll(/^ENV PORT=.*$/gm)];
  const last = matches[matches.length - 1];
  if (!last || last.index === undefined) return content;
  const at = last.index + last[0].length;
  return `${content.slice(0, at)}\n\n${SERVER_DOCKERFILE_COMMIT_SHA_BLOCK.replace(/\n$/, "")}${content.slice(at)}`;
}

/** Bake `COMMIT_SHA` into the client image's BUILD stage and stamp
 *  `version.json` next to the export, with the bundle assertion in
 *  between.
 *
 *  Anchored on the client package's `RUN pnpm --filter … run build`
 *  lines: the ARG goes before the first one (it must be set when
 *  `next build` runs), the assertion + stamp after the last. Returns
 *  the content unchanged for a Dockerfile that does not use the
 *  `packages/client` layout — the assertion greps a path that would not
 *  exist there, and a guard that cannot fail is worse than none. */
export function upgradeClientDockerfileVersionStamp(content: string): string {
  if (content.includes("packages/client/public/version.json")) return content;
  if (!content.includes("packages/client")) return content;
  const builds = [...content.matchAll(/^RUN pnpm --filter \S+ run build(?=\r?$)/gm)];
  const first = builds[0];
  const last = builds[builds.length - 1];
  if (!first || first.index === undefined || last?.index === undefined) return content;

  const afterLast = last.index + last[0].length;
  const tail = `${CLIENT_DOCKERFILE_API_URL_ASSERTION_BLOCK}\n${CLIENT_DOCKERFILE_VERSION_STAMP_BLOCK}`;
  let out = `${content.slice(0, afterLast)}\n\n${tail.replace(/\n$/, "")}${content.slice(afterLast)}`;
  if (!out.includes("ARG COMMIT_SHA")) {
    out = `${out.slice(0, first.index)}${CLIENT_DOCKERFILE_COMMIT_SHA_BLOCK}\n${out.slice(first.index)}`;
  }
  return out;
}

/** The build arg that carries the commit into an image. */
const COMMIT_SHA_BUILD_ARG = "COMMIT_SHA=${{ github.sha }}";

/** Pass `COMMIT_SHA` to one `docker/build-push-action` step, adding a
 *  `build-args:` block when the step has none.
 *
 *  Without this the two Dockerfile ARGs above are declared and never
 *  supplied, which produces exactly the silent failure the whole gate
 *  exists to remove: an image that builds fine and reports no version. */
export function addWorkflowCommitShaBuildArg(content: string, dockerfilePath: string): string {
  const lines = content.split(/\r?\n/);
  const fileIdx = lines.findIndex((l) => l.trim() === `file: ${dockerfilePath}`);
  if (fileIdx === -1) return content;
  const fileIndent = lines[fileIdx].length - lines[fileIdx].trimStart().length;

  // Bound the edit to THIS step. `file:` sits two levels inside the step
  // (`- uses:` → `with:` → `file:`), so the step ends at the first
  // following line indented no further than the `- uses:` line. A repo
  // with several build steps must not have this one's arg land in
  // another's block.
  const stepIndent = Math.max(0, fileIndent - 4);
  let endIdx = lines.length;
  for (let i = fileIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (lines[i].length - lines[i].trimStart().length <= stepIndent) {
      endIdx = i;
      break;
    }
  }
  const step = lines.slice(fileIdx, endIdx);
  if (step.some((l) => l.includes(COMMIT_SHA_BUILD_ARG))) return content;

  const pad = " ".repeat(fileIndent);
  const argsRel = step.findIndex((l) => /^[ \t]*build-args:[ \t]*\|[ \t]*$/.test(l));
  if (argsRel !== -1) {
    // Append to the existing block, matching the indent of its entries.
    const argsIndent = step[argsRel].length - step[argsRel].trimStart().length;
    let insertRel = argsRel + 1;
    let bodyPad = `${" ".repeat(argsIndent)}  `;
    while (insertRel < step.length) {
      const line = step[insertRel];
      if (!line.trim()) break;
      const lead = line.length - line.trimStart().length;
      if (lead <= argsIndent) break;
      bodyPad = " ".repeat(lead);
      insertRel++;
    }
    lines.splice(fileIdx + insertRel, 0, `${bodyPad}${COMMIT_SHA_BUILD_ARG}`);
    return lines.join("\n");
  }

  // After `push: true` when the step has one, so the new block reads in
  // the same place the scaffolded workflow puts it — a retrofit that
  // produced a differently-ordered file would make the two copies
  // impossible to diff.
  const pushRel = step.findIndex((l) => /^[ \t]*push:[ \t]*true[ \t]*$/.test(l));
  const insertAt = fileIdx + (pushRel === -1 ? 1 : pushRel + 1);
  lines.splice(
    insertAt,
    0,
    `${pad}# Bakes the commit into the image so /api/health can report it.`,
    `${pad}# The deploy job polls that field until it matches this sha —`,
    `${pad}# an HTTP 200 from the deploy POST only proves Coolify accepted`,
    `${pad}# the request, not that the new image is what ends up running.`,
    `${pad}build-args: |`,
    `${pad}  ${COMMIT_SHA_BUILD_ARG}`,
  );
  return lines.join("\n");
}

/** Point the gate at this project's public URLs. Anchors on the
 *  `HATCHKIT_WEB_URL:` / `HATCHKIT_API_URL:` env lines the verify step
 *  declares, so nothing else in the workflow can match. No-op when the
 *  step is absent — use {@link upgradeWorkflowDeployVerification} to
 *  insert it first. */
export function setWorkflowDeployVerifyUrls(
  content: string,
  domain: string,
  topology: Topology = "single-origin",
  surfaces: VerifySurfaces = "fullstack",
): string {
  return setWorkflowVerifyUrlValues(content, deployVerifyUrls(domain, topology, surfaces));
}

/** Same, for callers that know the URLs directly rather than deriving
 *  them from a manifest. `hatchkit adopt` uses this: it knows the
 *  project's public domain but not where — or whether — the app serves
 *  an API, so it sets the web URL and leaves the API one empty rather
 *  than guessing a path the gate would then fail on forever. */
export function setWorkflowVerifyUrlValues(content: string, urls: DeployVerifyUrls): string {
  return content
    .replace(/^(\s*HATCHKIT_WEB_URL:).*$/m, `$1 ${urls.webUrl || '""'}`)
    .replace(/^(\s*HATCHKIT_API_URL:).*$/m, `$1 ${urls.apiUrl || '""'}`);
}

/** Write the native-origin probe list into the workflow. Anchors on the
 *  `HATCHKIT_NATIVE_ORIGINS:` env line, so nothing else can match; no-op
 *  when the step is absent. Always quoted: an empty value must not read
 *  as YAML null.
 *
 *  Deliberately NOT part of {@link setWorkflowDeployVerifyUrls}: that one
 *  runs from `hatchkit rename-domain`, and these origins have nothing to
 *  do with the domain — a rename must neither add nor strip them. */
export function setWorkflowNativeOriginsValue(content: string, value: string): string {
  return content.replace(/^(\s*HATCHKIT_NATIVE_ORIGINS:).*$/m, `$1 "${value}"`);
}

/** Bring the native-origin sign-in check in line with a feature set.
 *
 *  Inserts {@link WORKFLOW_NATIVE_ORIGIN_STEP} right after the verify
 *  step when the project has a native client and the workflow predates
 *  the check, then writes the literal origin list. A workflow without
 *  the check is left alone for a project with no native client — adding
 *  a step that can only print "nothing to check" is churn. Returns the
 *  content unchanged when the verify step it anchors on is missing. */
export function upgradeWorkflowNativeOriginCheck(
  content: string,
  features: readonly string[],
): string {
  const origins = nativeClientOrigins(features);
  let out = content;
  if (!out.includes("- name: Verify native clients can sign in")) {
    if (origins.length === 0) return content;
    const at = endOfWorkflowStep(out, "- name: Verify the deployment is actually live");
    if (at === undefined) return content;
    out = `${out.slice(0, at)}\n${WORKFLOW_NATIVE_ORIGIN_STEP}${out.slice(at)}`;
  }
  return setWorkflowNativeOriginsValue(out, origins.join(","));
}

/** Offset just past the last non-blank line of the workflow step whose
 *  `- name:` line contains `marker` — where a following step belongs.
 *  The step ends at the first later line indented no deeper than its
 *  `- name:` (a sibling step, its leading comment, or the next job). */
function endOfWorkflowStep(content: string, marker: string): number | undefined {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.includes(marker));
  if (start === -1) return undefined;
  const indent = lines[start].length - lines[start].trimStart().length;
  let last = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (lines[i].length - lines[i].trimStart().length <= indent) break;
    last = i;
  }
  let offset = 0;
  for (let i = 0; i <= last; i++) offset += lines[i].length + 1;
  return Math.min(offset, content.length);
}

/** Insert the pin + verify steps into a deploy job that predates them,
 *  then point them at this project's URLs.
 *
 *  Anchors are the two steps every generated deploy job has had since
 *  the pipeline existed: the Coolify API deploy (pin goes before it, so
 *  the app is pinned before it is told to deploy) and the webhook
 *  fallback (verify goes after it, so it runs whichever path deployed).
 *  Returns the content unchanged when either is missing. */
export function upgradeWorkflowDeployVerification(
  content: string,
  domain: string,
  topology: Topology = "single-origin",
  surfaces: VerifySurfaces = "fullstack",
): string {
  let out = content;

  if (!out.includes("- name: Pin image tags to this commit")) {
    const anchor = /^[ \t]*- name: Deploy via Coolify API.*$/m;
    const m = out.match(anchor);
    if (!m || m.index === undefined) return content;
    out = `${out.slice(0, m.index)}${WORKFLOW_PIN_STEP}\n${out.slice(m.index)}`;
  }

  if (!out.includes("- name: Verify the deployment is actually live")) {
    const anchor = /^[ \t]*run: curl -fsSL "\$COOLIFY_WEBHOOK_URL"[ \t]*$/m;
    const m = out.match(anchor);
    if (!m || m.index === undefined) return content;
    const at = m.index + m[0].length;
    out = `${out.slice(0, at)}\n\n${WORKFLOW_VERIFY_STEP.replace(/\n+$/, "")}\n${out.slice(at)}`;
  }

  return setWorkflowDeployVerifyUrls(out, domain, topology, surfaces);
}

// ---------------------------------------------------------------------------
// Write-through wrappers
// ---------------------------------------------------------------------------

/** Scaffold-time hook: stamp the native-origin probe list into the
 *  generated workflow. Returns true when written. */
export function applyWorkflowNativeOrigins(
  outputDir: string,
  features: readonly string[],
): boolean {
  const path = join(outputDir, DEPLOY_WORKFLOW_REL_PATH);
  if (!existsSync(path)) return false;
  const before = readFileSync(path, "utf-8");
  const after = upgradeWorkflowNativeOriginCheck(before, features);
  if (after === before) return false;
  writeFileSync(path, after, "utf-8");
  return true;
}

/** Scaffold-time hook: stamp the project's literal probe URLs into the
 *  generated workflow. No-op when the workflow is absent (e.g.
 *  gh-pages-mode scaffolds). Returns true when written. */
export function applyWorkflowDeployVerifyUrls(
  outputDir: string,
  domain: string,
  topology: Topology = "single-origin",
  surfaces: VerifySurfaces = "fullstack",
): boolean {
  const path = join(outputDir, ".github/workflows/build-and-deploy.yml");
  if (!existsSync(path)) return false;
  const before = readFileSync(path, "utf-8");
  const after = setWorkflowDeployVerifyUrls(before, domain, topology, surfaces);
  if (after === before) return false;
  writeFileSync(path, after, "utf-8");
  return true;
}

// ---------------------------------------------------------------------------
// Retrofit table
// ---------------------------------------------------------------------------

/** Project-relative path of the generated deploy workflow. */
export const DEPLOY_WORKFLOW_REL_PATH = ".github/workflows/build-and-deploy.yml";

/** Every file transform needed to bring a project scaffolded before the
 *  gate existed up to the current shape, in one table.
 *
 *  Shared by `hatchkit update` and `hatchkit regen-infra` so the two
 *  cannot retrofit different subsets — a project that got the workflow
 *  gate but not the Dockerfile stamps would fail every deploy on a check
 *  its own images cannot satisfy. Each entry is idempotent and no-ops on
 *  a file that already carries the change or does not match the
 *  generated shape; callers skip paths that don't exist. */
export function deployVerificationRetrofits(
  domain: string,
  topology: Topology = "single-origin",
  surfaces: VerifySurfaces = "fullstack",
  /** Manifest features, for the native-origin sign-in check. Omitted
   *  means "unknown" and leaves that check exactly as found — never
   *  stripped for want of an argument. */
  features?: readonly string[],
): Array<[label: string, relPath: string, fn: (c: string) => string]> {
  return [
    ["docker-compose.yml", "docker-compose.yml", upgradeComposePullPolicy],
    ["docker-compose.client.yml", "docker-compose.client.yml", upgradeComposePullPolicy],
    ["docker-compose.server.yml", "docker-compose.server.yml", upgradeComposePullPolicy],
    ["server Dockerfile", "packages/server/Dockerfile", upgradeServerDockerfileCommitSha],
    ["client Dockerfile", "packages/client/Dockerfile", upgradeClientDockerfileVersionStamp],
    [
      "deploy workflow",
      DEPLOY_WORKFLOW_REL_PATH,
      (c) => {
        let out = addWorkflowCommitShaBuildArg(c, "packages/server/Dockerfile");
        out = addWorkflowCommitShaBuildArg(out, "packages/client/Dockerfile");
        out = upgradeWorkflowDeployVerification(out, domain, topology, surfaces);
        return features === undefined ? out : upgradeWorkflowNativeOriginCheck(out, features);
      },
    ],
  ];
}

// ---------------------------------------------------------------------------
// Image-pin variables on the Coolify side
// ---------------------------------------------------------------------------

/** Compose files a hatchkit project can deploy from, in the order a
 *  merge should read them. Single-origin uses the first; split's two
 *  apps use the other two. */
const IMAGE_COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.client.yml",
  "docker-compose.server.yml",
] as const;

/** Pull `${SERVER_IMAGE:-ghcr.io/…}`-style defaults out of a compose
 *  file as `{ SERVER_IMAGE: "ghcr.io/…" }`.
 *
 *  These are the variables the deploy job repoints at the immutable
 *  `:<sha>` tag. They have to EXIST on the Coolify app first: Coolify's
 *  env API only updates an existing variable, and a PATCH naming a key
 *  that isn't there returns 200 and does nothing — the deploy then runs
 *  the compose default (`:main`) and the pin is a no-op nobody notices.
 *  Seeding them at provision time with the compose's own default means
 *  the variable exists from day one and its initial value changes
 *  nothing about what runs. */
export function imageEnvDefaultsFromCompose(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^[ \t]*image:[ \t]*\$\{([A-Z][A-Z0-9_]*_IMAGE):-([^}]+)\}/gm;
  for (const m of content.matchAll(re)) out[m[1]] = m[2].trim();
  return out;
}

/** Merge the image-pin variables declared across a project's compose
 *  files. Later files win, which only matters when a project carries
 *  both the single-origin compose and the split per-half ones — the
 *  split files are the ones its Coolify apps actually build from. */
export function readImageEnvDefaults(projectDir?: string): Record<string, string> {
  if (!projectDir) return {};
  const out: Record<string, string> = {};
  for (const name of IMAGE_COMPOSE_FILES) {
    const path = join(projectDir, name);
    if (!existsSync(path)) continue;
    Object.assign(out, imageEnvDefaultsFromCompose(readFileSync(path, "utf-8")));
  }
  return out;
}

/** Drop the API-URL assertion from a client Dockerfile whose project has
 *  no server half.
 *
 *  `hatchkit create --surfaces static` deletes packages/server and
 *  patches the same guard out of next.config.ts for the same reason: the
 *  project legitimately has no API URL to inline, so a check demanding
 *  one fails every image build. The `version.json` stamp stays — the
 *  commit is what the post-deploy gate polls for, and the empty `apiUrl`
 *  it then records is the truth about a static project.
 *
 *  Idempotent; no-op on a Dockerfile that never carried the block. */
export function stripClientDockerfileApiUrlAssertion(content: string): string {
  return content.replace(`${CLIENT_DOCKERFILE_API_URL_ASSERTION_BLOCK}\n`, "");
}
