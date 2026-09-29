/**
 * Tests for the post-deploy verification gate — the pipeline's answer to
 * "is the thing running the thing I just built?".
 *
 * Covers:
 *   · The anti-drift guard: `starter/` literally contains every block
 *     the retrofit inserts, so the two copies cannot diverge silently.
 *   · Generated output — the starter's compose / Dockerfiles / workflow
 *     carry pull_policy, COMMIT_SHA, version.json and the gate.
 *   · The false-pass guard: the verify step is gated on a deploy having
 *     been TRIGGERED, never on the URLs being set, and fails when it
 *     ends up checking nothing.
 *   · Probe-URL derivation across topology × surfaces, and the
 *     substitution that writes it into the workflow.
 *   · Every retrofit transform: applies, is idempotent, and no-ops on a
 *     file that doesn't match the generated shape.
 *   · Round-trip — stripping the gate out of the starter workflow and
 *     retrofitting it back reproduces the file byte-for-byte.
 *   · The adopt templates and `scaffoldBuildPipeline`'s output.
 *   · The image-pin variables hatchkit seeds on the Coolify app, and
 *     the doctor-side drift classification.
 *
 * Run: `pnpm test`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  classifyDeployedVersions,
  renderDeployedVersion,
  summarizeDeployedVersion,
  versionFromJson,
} from "./src/deploy/deployed-version.js";
import { scaffoldBuildPipeline } from "./src/scaffold/build-pipeline.js";
import {
  CLIENT_DOCKERFILE_API_URL_ASSERTION_BLOCK,
  CLIENT_DOCKERFILE_COMMIT_SHA_BLOCK,
  CLIENT_DOCKERFILE_VERSION_STAMP_BLOCK,
  COMPOSE_PULL_POLICY_BLOCK,
  SERVER_DOCKERFILE_COMMIT_SHA_BLOCK,
  WORKFLOW_NATIVE_ORIGIN_STEP,
  WORKFLOW_PIN_STEP,
  WORKFLOW_VERIFY_STEP,
  addWorkflowCommitShaBuildArg,
  deployVerificationRetrofits,
  deployVerifyUrls,
  imageEnvDefaultsFromCompose,
  readImageEnvDefaults,
  setWorkflowDeployVerifyUrls,
  setWorkflowNativeOriginsValue,
  setWorkflowVerifyUrlValues,
  stripClientDockerfileApiUrlAssertion,
  upgradeClientDockerfileVersionStamp,
  upgradeComposePullPolicy,
  upgradeServerDockerfileCommitSha,
  upgradeWorkflowDeployVerification,
  upgradeWorkflowNativeOriginCheck,
} from "./src/scaffold/deploy-verification.js";

const failures: string[] = [];
function expect(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

console.log("\n  test-deploy-verification\n");

const STARTER = resolve(join(import.meta.dirname, "..", "starter"));
const TEMPLATES = resolve(join(import.meta.dirname, "src", "templates", "build-pipeline"));
const starterPresent = existsSync(join(STARTER, "package.json"));
const read = (rel: string) => readFileSync(join(STARTER, rel), "utf-8");
const template = (name: string) => readFileSync(join(TEMPLATES, name), "utf-8");

const WORKFLOW_REL = ".github/workflows/build-and-deploy.yml";

// ---------------------------------------------------------------------------
// Anti-drift: the constants and the starter are ONE artefact in two files
// ---------------------------------------------------------------------------

if (!starterPresent) {
  console.log("  · starter/ not populated — skipping generated-output assertions\n");
} else {
  expect("starter compose carries the canonical pull_policy block", () => {
    const compose = read("docker-compose.yml");
    assert.ok(compose.includes(COMPOSE_PULL_POLICY_BLOCK), "block not found verbatim");
    // Both halves: a stale client and a stale server are separate bugs.
    assert.equal(compose.split("pull_policy: always").length - 1, 2);
  });

  expect("starter server Dockerfile carries the canonical COMMIT_SHA block", () => {
    assert.ok(read("packages/server/Dockerfile").includes(SERVER_DOCKERFILE_COMMIT_SHA_BLOCK));
  });

  expect("starter client Dockerfile carries the canonical COMMIT_SHA + assertion + stamp", () => {
    const df = read("packages/client/Dockerfile");
    assert.ok(df.includes(CLIENT_DOCKERFILE_COMMIT_SHA_BLOCK), "ARG block missing");
    assert.ok(df.includes(CLIENT_DOCKERFILE_API_URL_ASSERTION_BLOCK), "assertion block missing");
    assert.ok(df.includes(CLIENT_DOCKERFILE_VERSION_STAMP_BLOCK), "stamp block missing");
  });

  expect("the static prune drops the assertion and keeps the stamp", () => {
    // A project with no server half has no API URL to inline, so the
    // assertion would fail every image build — `pruneToClientOnly`
    // patches the same guard out of next.config.ts for the same reason.
    // The stamp stays: the gate polls the commit it records.
    const df = read("packages/client/Dockerfile");
    const pruned = stripClientDockerfileApiUrlAssertion(df);
    assert.ok(!pruned.includes("never made it into the browser bundle"), "assertion survived");
    assert.ok(pruned.includes(CLIENT_DOCKERFILE_VERSION_STAMP_BLOCK), "stamp was dropped too");
    assert.ok(pruned.includes("ARG COMMIT_SHA"), "commit arg was dropped too");
    assert.equal(stripClientDockerfileApiUrlAssertion(pruned), pruned, "not idempotent");
  });

  expect("starter workflow carries the canonical pin + verify steps", () => {
    const wf = read(WORKFLOW_REL);
    assert.ok(wf.includes(WORKFLOW_PIN_STEP.trimEnd()), "pin step missing");
    assert.ok(wf.includes(WORKFLOW_VERIFY_STEP.trimEnd()), "verify step missing");
    // The shipped starter keeps the repo-variable fallback; hatchkit
    // writes the literal per project.
    const shipped = setWorkflowNativeOriginsValue(WORKFLOW_NATIVE_ORIGIN_STEP, "").replace(
      'HATCHKIT_NATIVE_ORIGINS: ""',
      "HATCHKIT_NATIVE_ORIGINS: ${{ vars.HATCHKIT_NATIVE_ORIGINS }}",
    );
    assert.equal(shipped, WORKFLOW_NATIVE_ORIGIN_STEP);
    assert.ok(wf.includes(WORKFLOW_NATIVE_ORIGIN_STEP.trimEnd()), "native-origin step missing");
    assert.ok(
      wf.indexOf("- name: Verify native clients can sign in") >
        wf.indexOf("- name: Verify the deployment is actually live"),
      "native-origin check must run after the deploy is proven live",
    );
  });

  // ------------------------------------------------------------------
  // Generated output
  // ------------------------------------------------------------------

  expect("starter workflow passes COMMIT_SHA to both image builds", () => {
    const wf = read(WORKFLOW_REL);
    assert.equal(wf.split("COMMIT_SHA=${{ github.sha }}").length - 1, 2);
  });

  expect("client build asserts the API URL reached the browser bundle", () => {
    const df = read("packages/client/Dockerfile");
    // Both halves of the guard: a set-but-not-inlined value is the case
    // next.config.ts's own check cannot see.
    assert.ok(df.includes('test -n "$NEXT_PUBLIC_API_URL"'));
    assert.ok(df.includes('grep -rqF "$NEXT_PUBLIC_API_URL" packages/client/.next/static'));
  });

  expect("client stamps version.json with commit AND apiUrl", () => {
    const df = read("packages/client/Dockerfile");
    assert.ok(df.includes('{"commit":"%s","apiUrl":"%s"}'));
    assert.ok(df.includes("packages/client/public/version.json"));
  });

  expect("server reports its build commit on /api/health", () => {
    assert.ok(read("packages/server/src/app.ts").includes("version: env.COMMIT_SHA"));
    assert.ok(
      read("packages/server/src/config/env.ts").includes('COMMIT_SHA: getOptional("COMMIT_SHA")'),
    );
  });

  expect("pin step covers single-origin and both split halves", () => {
    const wf = read(WORKFLOW_REL);
    for (const secret of [
      "COOLIFY_RESOURCE_UUID",
      "COOLIFY_SERVER_RESOURCE_UUID",
      "COOLIFY_CLIENT_RESOURCE_UUID",
    ]) {
      assert.ok(WORKFLOW_PIN_STEP.includes(secret), `${secret} not pinned`);
    }
    // POST before PATCH: a PATCH naming a key Coolify doesn't have is
    // accepted and does nothing, so create-then-update is load-bearing.
    // Measured on the env pin only — the Docker Image branch before it
    // PATCHes the application itself, not an env var.
    const postAt = WORKFLOW_PIN_STEP.search(/-X POST \\\n\s+"[^"]*\/envs"/);
    const patchAt = WORKFLOW_PIN_STEP.search(/-X PATCH \\\n\s+"[^"]*\/envs"/);
    assert.ok(postAt > 0 && patchAt > postAt, "POST must precede PATCH");
    // `is_build_time` is rejected on that POST with "This field is not
    // allowed" — sending it takes the whole request down. Check the
    // request BODY, not the step text: the comment above it names the
    // field precisely so the next reader doesn't re-add it.
    const body = WORKFLOW_PIN_STEP.match(/^\s*body=(.+)$/m)?.[1] ?? "";
    assert.ok(body.includes("is_preview"), `unexpected pin body: ${body}`);
    assert.ok(!body.includes("is_build_time"));
    assert.ok(wf.includes("- name: Pin image tags to this commit"));
  });

  // ------------------------------------------------------------------
  // The false-pass guard
  // ------------------------------------------------------------------

  expect("verify step is gated on a deploy firing, not on the URLs being set", () => {
    // The trap: a per-URL `if:` lets this step skip while the deploy
    // steps above it ran, so the job reports green having verified
    // nothing. The only guard allowed here is "was a deploy triggered".
    const guard = WORKFLOW_VERIFY_STEP.match(/^\s*if: (.+)$/m)?.[1];
    assert.equal(guard, "env.COOLIFY_BASE_URL != '' || env.COOLIFY_WEBHOOK_URL != ''");
    assert.ok(!/if:.*HATCHKIT_(WEB|API)_URL/.test(WORKFLOW_VERIFY_STEP));
  });

  expect("native-origin step is gated on a deploy firing, like the verify step", () => {
    const guard = WORKFLOW_NATIVE_ORIGIN_STEP.match(/^\s*if: (.+)$/m)?.[1];
    assert.equal(guard, "env.COOLIFY_BASE_URL != '' || env.COOLIFY_WEBHOOK_URL != ''");
  });

  expect("native-origin probe takes the path a WebView takes, and can actually fail", () => {
    const step = WORKFLOW_NATIVE_ORIGIN_STEP;
    assert.ok(step.includes('-X POST "$API/api/auth/sign-in/email"'));
    assert.ok(step.includes('-H "Origin: $origin"'));
    // Without Sec-Fetch-*, better-auth never validates Origin on a
    // cookieless sign-in: the probe would pass against a server that
    // rejects every phone.
    assert.ok(step.includes("-H 'Sec-Fetch-Mode: cors'"));
    assert.ok(step.includes("-H 'content-type: application/json'"));
    // better-call validates the body BEFORE the sign-in route's origin
    // check, so `{}` answers 400 for trusted and untrusted origins alike
    // (verified against better-auth 1.6.11 / better-call 1.3.5). The
    // body must be schema-valid so the origin check is reached.
    const data = step.match(/--data '([^']*)'/)?.[1] ?? "";
    assert.notEqual(data, "{}");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    assert.equal(typeof parsed.email, "string");
    assert.equal(typeof parsed.password, "string");
    assert.ok(
      String(parsed.email).endsWith(".invalid"),
      "probe must use an address that cannot exist",
    );
    // 403 / INVALID_ORIGIN fails; only the credential check's 401 passes.
    assert.ok(
      step.includes('[ "$status" = "403" ] || printf \'%s\' "$body" | grep -q INVALID_ORIGIN'),
    );
    assert.ok(step.includes('elif [ "$status" = "401" ]'));
    assert.ok(step.includes('exit "$failed"'));
  });

  expect("verify step fails when it ends up checking nothing", () => {
    assert.ok(WORKFLOW_VERIFY_STEP.includes('if [ "$checked" -eq 0 ]'));
    assert.ok(WORKFLOW_VERIFY_STEP.includes("a deploy was triggered and nothing was verified."));
  });

  expect("every probe is cache-busted", () => {
    // A CDN hit would return exactly the stale copy being tested for,
    // so a probe without a buster can pass on the very artefact it is
    // supposed to catch.
    const urls = WORKFLOW_VERIFY_STEP.match(/curl -fsSL --max-time 10 "[^"]+"/g) ?? [];
    assert.ok(urls.length >= 2, `expected at least two GET probes, saw ${urls.length}`);
    for (const u of urls) assert.ok(u.includes("hatchkit_cb="), `not cache-busted: ${u}`);
  });

  expect("verify step degrades per half and skips same-origin CORS", () => {
    assert.ok(WORKFLOW_VERIFY_STEP.includes('if [ -n "$API" ]'), "API half not optional");
    assert.ok(WORKFLOW_VERIFY_STEP.includes('if [ -n "$WEB" ]'), "web half not optional");
    assert.ok(
      WORKFLOW_VERIFY_STEP.includes('[ -n "$WEB" ] && [ -n "$API" ] && [ "$WEB" != "$API" ]'),
      "CORS not restricted to genuinely cross-origin projects",
    );
  });

  // ------------------------------------------------------------------
  // Round-trip — the retrofit reproduces the starter exactly
  // ------------------------------------------------------------------

  expect("retrofitting a pre-gate workflow reproduces the starter byte-for-byte", () => {
    const current = read(WORKFLOW_REL);
    // Reconstruct what the file looked like before the gate existed.
    const before = current
      .replace(`\n${WORKFLOW_NATIVE_ORIGIN_STEP}`, "")
      .replace(`${WORKFLOW_PIN_STEP}\n`, "")
      .replace(`\n\n${WORKFLOW_VERIFY_STEP.replace(/\n+$/, "")}\n`, "")
      .replace(
        /^ *# Bakes the commit into the image so \/api\/health can report it\.\n(?: *#.*\n)*? *build-args: \|\n *COMMIT_SHA=\$\{\{ github\.sha \}\}\n/m,
        "",
      )
      .replace(/^ *COMMIT_SHA=\$\{\{ github\.sha \}\}\n/m, "");
    assert.notEqual(before, current, "failed to construct a pre-gate fixture");
    assert.ok(!before.includes("Pin image tags"), "pin step not stripped");
    assert.ok(!before.includes("COMMIT_SHA"), "build args not stripped");
    assert.ok(!before.includes("Verify native clients"), "native-origin step not stripped");

    let after = addWorkflowCommitShaBuildArg(before, "packages/server/Dockerfile");
    after = addWorkflowCommitShaBuildArg(after, "packages/client/Dockerfile");
    after = upgradeWorkflowDeployVerification(after, "example.com", "split", "split");
    after = upgradeWorkflowNativeOriginCheck(after, ["mobile"]);
    // Only the literals differ from the shipped starter, which leaves
    // them blank for hatchkit to fill per project.
    const normalized = setWorkflowVerifyUrlValues(after, {
      webUrl: "${{ vars.HATCHKIT_WEB_URL }}",
      apiUrl: "${{ vars.HATCHKIT_API_URL }}",
    }).replace(
      'HATCHKIT_NATIVE_ORIGINS: "capacitor://localhost,https://localhost"',
      "HATCHKIT_NATIVE_ORIGINS: ${{ vars.HATCHKIT_NATIVE_ORIGINS }}",
    );
    assert.equal(normalized, current);
  });

  expect("native-origin literal follows features; rename-domain's URL rewrite leaves it", () => {
    const wf = read(WORKFLOW_REL);
    const desktop = upgradeWorkflowNativeOriginCheck(wf, ["desktop"]);
    assert.ok(desktop.includes('HATCHKIT_NATIVE_ORIGINS: "app://-"'));
    assert.equal(
      upgradeWorkflowNativeOriginCheck(desktop, ["desktop"]),
      desktop,
      "not idempotent",
    );
    const none = upgradeWorkflowNativeOriginCheck(wf, []);
    assert.ok(none.includes('HATCHKIT_NATIVE_ORIGINS: ""'), "empty list must be quoted");
    const renamed = setWorkflowDeployVerifyUrls(desktop, "renamed.example.com", "split", "split");
    assert.ok(renamed.includes('HATCHKIT_NATIVE_ORIGINS: "app://-"'));
  });

  expect("retrofit tables leave the native check alone when features are unknown", () => {
    const wf = upgradeWorkflowNativeOriginCheck(read(WORKFLOW_REL), ["mobile"]);
    const fn = deployVerificationRetrofits("example.com", "split", "split").find(
      ([, rel]) => rel === WORKFLOW_REL,
    )?.[2];
    assert.ok(fn);
    assert.ok(
      fn(wf).includes('HATCHKIT_NATIVE_ORIGINS: "capacitor://localhost,https://localhost"'),
    );
  });

  expect("retrofits are idempotent against the current starter", () => {
    for (const [label, rel, fn] of deployVerificationRetrofits("example.com", "split", "split")) {
      const path = join(STARTER, rel);
      if (!existsSync(path)) continue;
      const before = readFileSync(path, "utf-8");
      // The URL substitution is the one intentional change on a second
      // pass, so compare against a same-domain baseline.
      const once = fn(before);
      assert.equal(fn(once), once, `${label} is not idempotent`);
    }
  });
}

// ---------------------------------------------------------------------------
// Probe-URL derivation
// ---------------------------------------------------------------------------

expect("single-origin puts the API on the bare domain", () => {
  assert.deepEqual(deployVerifyUrls("app.example.com", "single-origin", "fullstack"), {
    webUrl: "https://app.example.com",
    apiUrl: "https://app.example.com",
  });
});

expect("split puts the API on api.<domain>", () => {
  assert.deepEqual(deployVerifyUrls("app.example.com", "split", "split"), {
    webUrl: "https://app.example.com",
    apiUrl: "https://api.app.example.com",
  });
});

expect("backend has no web half, static has no API half", () => {
  assert.equal(deployVerifyUrls("x.example.com", "single-origin", "backend").webUrl, "");
  assert.equal(deployVerifyUrls("x.example.com", "single-origin", "static").apiUrl, "");
  // …and each keeps the half it does have, so the gate still checks
  // something rather than degrading to a no-op.
  assert.notEqual(deployVerifyUrls("x.example.com", "single-origin", "backend").apiUrl, "");
  assert.notEqual(deployVerifyUrls("x.example.com", "single-origin", "static").webUrl, "");
});

expect("URL substitution writes literals and quotes the empty half", () => {
  const src = [
    "        env:",
    "          HATCHKIT_WEB_URL: ${{ vars.HATCHKIT_WEB_URL }}",
    "          HATCHKIT_API_URL: ${{ vars.HATCHKIT_API_URL }}",
  ].join("\n");
  const split = setWorkflowDeployVerifyUrls(src, "app.example.com", "split", "split");
  assert.ok(split.includes("HATCHKIT_WEB_URL: https://app.example.com"));
  assert.ok(split.includes("HATCHKIT_API_URL: https://api.app.example.com"));
  // An empty value must be written as `""` — a bare `key:` is YAML null,
  // which reads back as the string "null" in some shells.
  const backend = setWorkflowDeployVerifyUrls(src, "app.example.com", "split", "backend");
  assert.ok(backend.includes('HATCHKIT_WEB_URL: ""'));
});

// ---------------------------------------------------------------------------
// Retrofit transforms
// ---------------------------------------------------------------------------

expect("pull_policy is added to ghcr services only", () => {
  const compose = [
    "services:",
    "  server:",
    "    image: ${SERVER_IMAGE:-ghcr.io/o/r-server:main}",
    "    restart: unless-stopped",
    "  client:",
    "    image: ghcr.io/o/r-client:main",
    "  mongo:",
    "    image: mongo:7",
    "",
  ].join("\n");
  const out = upgradeComposePullPolicy(compose);
  assert.equal(out.split("pull_policy: always").length - 1, 2);
  // A pinned upstream tag doesn't move, so forcing a registry
  // round-trip on it every restart would be cost with no cover.
  const mongoBlock = out.slice(out.indexOf("  mongo:"));
  assert.ok(!mongoBlock.includes("pull_policy"));
  assert.equal(upgradeComposePullPolicy(out), out, "not idempotent");
});

expect("pull_policy respects an existing declaration", () => {
  const compose = [
    "services:",
    "  server:",
    "    image: ghcr.io/o/r-server:main",
    "    pull_policy: never",
    "",
  ].join("\n");
  assert.equal(upgradeComposePullPolicy(compose), compose);
});

expect("server COMMIT_SHA lands in the runtime stage, not the build stage", () => {
  const df = [
    "FROM node:24 AS build",
    "ENV PORT=3000",
    "RUN pnpm build",
    "",
    "FROM node:24 AS runtime",
    "ENV NODE_ENV=production",
    "ENV PORT=3000",
    "",
    "COPY --from=build /prod/dist ./dist",
    "",
  ].join("\n");
  const out = upgradeServerDockerfileCommitSha(df);
  const argAt = out.indexOf("ARG COMMIT_SHA");
  assert.ok(argAt > out.indexOf("AS runtime"), "landed before the runtime stage");
  assert.ok(argAt < out.indexOf("COPY --from=build"), "landed after the COPYs");
  assert.equal(upgradeServerDockerfileCommitSha(out), out, "not idempotent");
});

expect("client stamp brackets the build: ARG before, assertion + stamp after", () => {
  const df = [
    "FROM node:24 AS build",
    "COPY packages/client packages/client",
    "RUN pnpm --filter @x/shared run build",
    "RUN pnpm --filter @x/client run build",
    "",
    "FROM node:24 AS runtime",
    "",
  ].join("\n");
  const out = upgradeClientDockerfileVersionStamp(df);
  const argAt = out.indexOf("ARG COMMIT_SHA");
  const firstBuild = out.indexOf("RUN pnpm --filter @x/shared run build");
  const lastBuild = out.indexOf("RUN pnpm --filter @x/client run build");
  const stampAt = out.indexOf("packages/client/public/version.json");
  assert.ok(argAt > 0 && argAt < firstBuild, "ARG must be set before next build runs");
  assert.ok(stampAt > lastBuild, "stamp must follow the build it describes");
  assert.ok(out.indexOf("grep -rqF") > lastBuild, "assertion must follow the build");
  assert.equal(upgradeClientDockerfileVersionStamp(out), out, "not idempotent");
});

expect("client stamp no-ops on a Dockerfile that isn't the generated layout", () => {
  // The assertion greps a path that wouldn't exist there, and a guard
  // that cannot fail is worse than no guard.
  const df = "FROM node:24 AS build\nRUN pnpm --filter web run build\n";
  assert.equal(upgradeClientDockerfileVersionStamp(df), df);
});

expect("COMMIT_SHA build arg appends to an existing block", () => {
  const wf = [
    "      - uses: docker/build-push-action@v6",
    "        with:",
    "          file: packages/client/Dockerfile",
    "          push: true",
    "          build-args: |",
    "            NEXT_PUBLIC_API_URL=https://api.example.com",
    "          tags: |",
    "            ghcr.io/o/r-client:main",
    "",
  ].join("\n");
  const out = addWorkflowCommitShaBuildArg(wf, "packages/client/Dockerfile");
  assert.ok(
    out.includes(
      "            NEXT_PUBLIC_API_URL=https://api.example.com\n            COMMIT_SHA=${{ github.sha }}\n",
    ),
  );
  assert.equal(
    addWorkflowCommitShaBuildArg(out, "packages/client/Dockerfile"),
    out,
    "not idempotent",
  );
});

expect("COMMIT_SHA build arg creates a block when the step has none", () => {
  const wf = [
    "      - uses: docker/build-push-action@v6",
    "        with:",
    "          file: packages/server/Dockerfile",
    "          push: true",
    "          tags: |",
    "            ghcr.io/o/r-server:main",
    "",
  ].join("\n");
  const out = addWorkflowCommitShaBuildArg(wf, "packages/server/Dockerfile");
  assert.ok(out.includes("          build-args: |\n            COMMIT_SHA=${{ github.sha }}\n"));
  assert.ok(out.includes("          tags: |"), "clobbered the tags block");
});

expect("COMMIT_SHA build arg stays inside its own step", () => {
  const wf = [
    "      - uses: docker/build-push-action@v6",
    "        with:",
    "          file: packages/server/Dockerfile",
    "          push: true",
    "      - uses: docker/build-push-action@v6",
    "        with:",
    "          file: packages/client/Dockerfile",
    "          push: true",
    "          build-args: |",
    "            NEXT_PUBLIC_API_URL=https://api.example.com",
    "",
  ].join("\n");
  const out = addWorkflowCommitShaBuildArg(wf, "packages/server/Dockerfile");
  const serverAt = out.indexOf("file: packages/server/Dockerfile");
  const clientAt = out.indexOf("file: packages/client/Dockerfile");
  const argAt = out.indexOf("COMMIT_SHA=");
  assert.ok(argAt > serverAt && argAt < clientAt, "arg leaked into the other step");
  // The client step's existing block must be untouched by this call.
  assert.equal(out.split("COMMIT_SHA=").length - 1, 1);
});

expect("workflow gate insertion no-ops without its anchors", () => {
  const wf = "jobs:\n  deploy:\n    steps:\n      - run: echo hand-rolled\n";
  assert.equal(upgradeWorkflowDeployVerification(wf, "example.com"), wf);
});

expect("native-origin check: inserted right after the verify step, before any later step", () => {
  const wf = [
    "jobs:",
    "  deploy:",
    "    steps:",
    "      - name: Verify the deployment is actually live",
    "        run: |",
    "          echo verify",
    "",
    "      # a later step the user added",
    "      - name: Notify",
    "        run: echo done",
    "",
  ].join("\n");
  const out = upgradeWorkflowNativeOriginCheck(wf, ["mobile"]);
  const verifyAt = out.indexOf("echo verify");
  const nativeAt = out.indexOf("- name: Verify native clients can sign in");
  const notifyAt = out.indexOf("# a later step the user added");
  assert.ok(verifyAt < nativeAt && nativeAt < notifyAt, "step landed in the wrong place");
  assert.ok(out.includes('HATCHKIT_NATIVE_ORIGINS: "capacitor://localhost,https://localhost"'));
  assert.equal(upgradeWorkflowNativeOriginCheck(out, ["mobile"]), out, "not idempotent");
});

expect("native-origin check: no-ops without native features or without the verify anchor", () => {
  const pre =
    "jobs:\n  deploy:\n    steps:\n      - name: Verify the deployment is actually live\n        run: echo v\n";
  // An older project with no native client doesn't get a step that can
  // only say "nothing to check".
  assert.equal(upgradeWorkflowNativeOriginCheck(pre, []), pre);
  const handRolled = "jobs:\n  deploy:\n    steps:\n      - run: echo hand-rolled\n";
  assert.equal(upgradeWorkflowNativeOriginCheck(handRolled, ["mobile"]), handRolled);
});

// ---------------------------------------------------------------------------
// Image-pin variables seeded on the Coolify app
// ---------------------------------------------------------------------------

expect("image-pin variables are read from the compose defaults", () => {
  const compose = [
    "services:",
    "  server:",
    "    image: ${SERVER_IMAGE:-ghcr.io/o/r-server:main}",
    "  client:",
    "    image: ${CLIENT_IMAGE:-ghcr.io/o/r-client:main}",
    "  mongo:",
    "    image: mongo:7",
    "",
  ].join("\n");
  assert.deepEqual(imageEnvDefaultsFromCompose(compose), {
    SERVER_IMAGE: "ghcr.io/o/r-server:main",
    CLIENT_IMAGE: "ghcr.io/o/r-client:main",
  });
});

expect("split compose files override the single-origin defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-pin-"));
  try {
    writeFileSync(
      join(dir, "docker-compose.yml"),
      "services:\n  server:\n    image: ${SERVER_IMAGE:-ghcr.io/o/r-server:main}\n",
    );
    writeFileSync(
      join(dir, "docker-compose.server.yml"),
      "services:\n  server:\n    image: ${SERVER_IMAGE:-ghcr.io/o/r-server:split}\n",
    );
    assert.deepEqual(readImageEnvDefaults(dir), { SERVER_IMAGE: "ghcr.io/o/r-server:split" });
    assert.deepEqual(readImageEnvDefaults(undefined), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Adopt templates + scaffoldBuildPipeline
// ---------------------------------------------------------------------------

expect("adopt Dockerfile templates bake COMMIT_SHA and stamp version.json", () => {
  for (const name of ["Dockerfile.server.hbs", "Dockerfile.client.hbs"]) {
    assert.ok(template(name).includes("ARG COMMIT_SHA"), `${name} missing ARG`);
  }
  assert.ok(template("Dockerfile.client.hbs").includes("dist/version.json"));
  assert.ok(template("Dockerfile.nextjs.hbs").includes("public/version.json"));
  const monorepo = template("Dockerfile.nextjs-monorepo.hbs");
  assert.ok(monorepo.includes("{{monorepoPackage}}/public/version.json"));
  // The runtime stage has to actually ship the directory it was written
  // into, or /version.json 404s and the gate never passes.
  assert.ok(monorepo.includes("COPY --from=build /app/{{monorepoPackage}}/public"));
});

expect("adopt workflow template carries the verify gate and one build arg", () => {
  const wf = template("deploy.yml.hbs");
  assert.ok(wf.includes("- name: Verify the deployment is actually live"));
  // ONE build job, because adopt scaffolds ONE Dockerfile. The template
  // used to carry the starter's two (`packages/{server,client}/Dockerfile`)
  // — paths this scaffolder never writes, pushing image names its compose
  // never reads.
  assert.equal(wf.split("COMMIT_SHA=${{ github.sha }}").length - 1, 1);
  assert.ok(!wf.includes("packages/server/Dockerfile"), "references a path adopt never writes");
  assert.ok(!wf.includes("packages/client/Dockerfile"), "references a path adopt never writes");
  assert.equal(wf.split("uses: docker/build-push-action@v6").length - 1, 1);
  assert.ok(wf.includes("    needs: [build]\n"), "deploy job should depend on the one build job");
  // The tags CI pushes have to be the ones the compose default and the
  // pin step name — an un-suffixed `ghcr.io/<repo>`.
  assert.ok(wf.includes("ghcr.io/${{ github.repository }}:__DEFAULT_BRANCH__"));
  assert.ok(wf.includes("ghcr.io/${{ github.repository }}:${{ github.sha }}"));
  assert.ok(!/ghcr\.io\/\$\{\{ github\.repository \}\}-(server|client)/.test(wf));
});

expect("adopt workflow pins APP_IMAGE to the sha before deploying", () => {
  const wf = template("deploy.yml.hbs");
  assert.ok(wf.includes("- name: Pin the image tag to this commit"), "pin step missing");
  // POST then PATCH: Coolify's env API accepts a PATCH for a key it does
  // not have with a 200 and silently does nothing, and POST fails once
  // the key exists — so both run and the right one wins.
  const pin = wf.slice(
    wf.indexOf("- name: Pin the image tag to this commit"),
    wf.indexOf("- name: Deploy via Coolify API"),
  );
  const envPost = pin.search(/-X POST \\\n\s+"[^"]*\/envs"/);
  const envPatch = pin.search(/-X PATCH \\\n\s+"[^"]*\/envs"/);
  assert.ok(envPost > 0 && envPost < envPatch, "POST must precede PATCH");
  assert.ok(pin.includes("/api/v1/applications/$COOLIFY_RESOURCE_UUID/envs"));
  assert.ok(!pin.includes("is_build_time"), "is_build_time is rejected on POST");
  assert.ok(pin.includes('APP_IMAGE="ghcr.io/${{ github.repository }}:${{ github.sha }}"'));
  // Pinning after the deploy fired would pin the NEXT deploy's image.
  assert.ok(
    wf.indexOf("- name: Pin the image tag to this commit") <
      wf.indexOf("- name: Deploy via Coolify API"),
    "pin step must come before the deploy step",
  );
  // The note this step replaced said adopt's compose had no variable to
  // pin. It has one now; the note must not linger and contradict it.
  assert.ok(!wf.includes("no image-pin step here"));
});

expect("adopt compose reads APP_IMAGE, and hatchkit seeds it from that default", () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-appimg-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
    scaffoldBuildPipeline({
      projectDir: dir,
      projectName: "demo",
      ghOwner: "acme",
      ghRepoSlug: "acme/demo-site",
      entrypoint: "dist/index.js",
      port: 3000,
      surfaces: "fullstack",
      domain: "demo.example.com",
      defaultBranch: "main",
    });
    const compose = readFileSync(join(dir, "docker-compose.yml"), "utf-8");
    // The repo slug, not `<owner>/<projectName>` — the workflow tags by
    // `${{ github.repository }}`, so a project whose hatchkit name differs
    // from its repo name would otherwise default to an image nothing pushes.
    assert.ok(compose.includes("image: ${APP_IMAGE:-ghcr.io/acme/demo-site:main}"), compose);
    // Provisioning reads the default straight back out, which is what
    // makes the deploy job's PATCH land on a key that exists.
    assert.deepEqual(readImageEnvDefaults(dir), {
      APP_IMAGE: "ghcr.io/acme/demo-site:main",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

expect("adopt compose falls back to <owner>/<name> without a repo slug", () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-appimg-fb-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
    scaffoldBuildPipeline({
      projectDir: dir,
      projectName: "demo",
      ghOwner: "acme",
      entrypoint: "dist/index.js",
      port: 3000,
      surfaces: "fullstack",
      domain: "demo.example.com",
      defaultBranch: "trunk",
    });
    const compose = readFileSync(join(dir, "docker-compose.yml"), "utf-8");
    // Default tag tracks the branch the workflow triggers on, not `latest`
    // — `latest` was pushed by nothing.
    assert.ok(compose.includes("image: ${APP_IMAGE:-ghcr.io/acme/demo:trunk}"), compose);
    assert.ok(!compose.includes(":latest"), "latest is a tag CI never pushes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

expect("scaffoldBuildPipeline fills in the web URL and leaves the API one blank", () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-bp-"));
  try {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
    scaffoldBuildPipeline({
      projectDir: dir,
      projectName: "demo",
      ghOwner: "o",
      entrypoint: "dist/index.js",
      port: 3000,
      surfaces: "fullstack",
      domain: "demo.example.com",
      defaultBranch: "main",
    });
    const wf = readFileSync(join(dir, ".github/workflows/deploy.yml"), "utf-8");
    assert.ok(wf.includes("HATCHKIT_WEB_URL: https://demo.example.com"));
    // An adopted repo's health endpoint isn't something we can infer,
    // and a gate polling a path that will never exist fails forever.
    assert.ok(wf.includes('HATCHKIT_API_URL: ""'));
    // The compose it writes alongside must re-pull its mutable tag.
    assert.ok(
      readFileSync(join(dir, "docker-compose.yml"), "utf-8").includes("pull_policy: always"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Doctor-side drift classification
// ---------------------------------------------------------------------------

expect("a version field is read tolerantly", () => {
  assert.equal(versionFromJson('{"version":"abc123"}', "version"), "abc123");
  assert.equal(versionFromJson('{"commit":" abc "}', "commit"), "abc");
  // An artefact predating COMMIT_SHA answers 200 with valid JSON that
  // simply has no such field — a finding to report, not a throw.
  assert.equal(versionFromJson('{"status":"ok"}', "version"), undefined);
  assert.equal(versionFromJson('{"version":""}', "version"), undefined);
  assert.equal(versionFromJson("not json", "version"), undefined);
});

expect("no-commit is 'unknown', never 'stale'", () => {
  // "the deployed image is old" and "the deployed image cannot tell us"
  // need different advice; conflating them sends the user hunting a
  // deploy bug that is really a missing build arg.
  const { stale, unknown } = classifyDeployedVersions("aaa", [
    { label: "api", url: "u1", sha: "aaa" },
    { label: "web", url: "u2", sha: "bbb" },
    { label: "old", url: "u3" },
    { label: "down", url: "u4", error: "timeout" },
  ]);
  assert.deepEqual(
    stale.map((p) => p.label),
    ["web"],
  );
  assert.deepEqual(
    unknown.map((p) => p.label),
    ["old", "down"],
  );
});

expect("drift summary names the ref and the hint names the mutable-tag cause", () => {
  const report = {
    ran: true as const,
    remote: "origin",
    branch: "main",
    expected: "a".repeat(40),
    probes: [{ label: "web", url: "https://x/version.json", sha: "b".repeat(40) }],
    stale: [{ label: "web", url: "https://x/version.json", sha: "b".repeat(40) }],
    unknown: [],
  };
  const summary = summarizeDeployedVersion(report);
  assert.ok(summary.includes("origin/main"));
  assert.ok(summary.includes("bbbbbbbb"));
  const hint = renderDeployedVersion(report).join("\n");
  assert.ok(hint.includes("MUTABLE tag"));
  assert.ok(hint.includes("hatchkit regen-infra"));
});

console.log("");
if (failures.length > 0) {
  console.error(`  ${failures.length} test(s) failed:`);
  for (const f of failures) console.error(`    · ${f}`);
  process.exit(1);
} else {
  console.log("  all tests passed");
}
