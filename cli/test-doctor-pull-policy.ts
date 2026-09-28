/**
 * `hatchkit doctor` — Coolify compose apps that can serve a stale build.
 *
 * The incident these encode, 2026-09-28: two Coolify apps (hatchkit docs
 * `n1nqwwrfjx584w2hd4gv6fan`, sprite-tools `q34yd19p0ap7t5ywbuhiuxz4`)
 * kept serving May 2026 builds after green deploys. Their repo compose
 * files ran `image: ghcr.io/trebeljahr/<x>:latest` without
 * `pull_policy: always`, so Coolify's `docker compose up` reused the
 * cached image while reporting the deployment `finished` and the app
 * `running:healthy`.
 *
 * The properties that keep that from coming back:
 *   1. Every ghcr service on a mutable tag without `pull_policy: always`
 *      is reported — including one wrapped in `${VAR:-…}`, the
 *      ricos-labs shape. Pinned tags and non-ghcr images are not.
 *   2. The doctor check and the `hatchkit update` retrofit share one
 *      scoping rule: after the retrofit, doctor has nothing left to say
 *      about a service that declared no pull_policy.
 *   3. It WARNS. It never makes doctor exit non-zero, including when
 *      Coolify can't be read.
 *   4. It never prints an env value. `docker_compose` carries
 *      interpolated secrets; only `docker_compose_raw` is read.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCoolifyComposePullPolicy } from "./src/doctor.js";
import {
  composeStalePullRisks,
  ghcrComposeServices,
  hasMutableTag,
  upgradeComposePullPolicy,
} from "./src/scaffold/deploy-verification.js";
import { CoolifyApi, type CoolifyComposeSource } from "./src/utils/coolify-api.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const failures: string[] = [];

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

const compose = (...lines: string[]) => `${lines.join("\n")}\n`;
const flagged = (content: string) => composeStalePullRisks(content).map((r) => r.service);

/** The incident's shape: one ghcr service on `:latest`, nothing else. */
const DOCS_COMPOSE = compose(
  "services:",
  "  docs:",
  "    image: ghcr.io/trebeljahr/hatchkit-docs:latest",
  "    restart: unless-stopped",
);

/** ricos-labs-web: the same gap behind a pin variable's default. */
const RICOS_LABS_COMPOSE = compose(
  "services:",
  "  client:",
  "    image: ${CLIENT_IMAGE:-ghcr.io/trebeljahr/ricos-labs:latest}",
  "    environment:",
  "      PORT: 3000",
);

// ---------------------------------------------------------------------------
// Scoping — which services are at risk
// ---------------------------------------------------------------------------

await check("the incident's compose is reported, and the fix clears it", () => {
  assert.deepEqual(flagged(DOCS_COMPOSE), ["docs"]);
  const fixed = DOCS_COMPOSE.replace("    restart:", "    pull_policy: always\n    restart:");
  assert.deepEqual(flagged(fixed), []);
});

await check("an image behind ${VAR:-default} is judged by its default", () => {
  const [risk] = composeStalePullRisks(RICOS_LABS_COMPOSE);
  assert.equal(risk.service, "client");
  assert.equal(risk.image, "ghcr.io/trebeljahr/ricos-labs:latest");
  assert.equal(risk.ref, "${CLIENT_IMAGE:-ghcr.io/trebeljahr/ricos-labs:latest}");
  assert.equal(risk.pullPolicy, undefined);
});

await check("non-ghcr images are out of scope, even on :latest", () => {
  const c = compose(
    "services:",
    "  mongo:",
    "    image: mongo:7",
    "  redis:",
    "    image: redis:7-alpine",
    "  kuma:",
    "    image: louislam/uptime-kuma:latest",
  );
  assert.deepEqual(ghcrComposeServices(c), []);
  assert.deepEqual(flagged(c), []);
});

await check("mutable vs pinned tags", () => {
  for (const moving of [
    "ghcr.io/o/r:latest",
    "ghcr.io/o/r:main",
    "ghcr.io/o/r",
    "ghcr.io/o/r:1",
    "ghcr.io/o/r:1.4",
    "ghcr.io/o/r:${TAG:-main}",
  ]) {
    assert.ok(hasMutableTag(moving), `${moving} should be mutable`);
  }
  for (const pinned of [
    "ghcr.io/o/r@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "ghcr.io/o/r:3e3a282",
    "ghcr.io/o/r:3e3a2821b6f0c9d2a4e5f60718293a4b5c6d7e8f",
    "ghcr.io/o/r:sha-3e3a282",
    "ghcr.io/o/r:1.4.2",
    "ghcr.io/o/r:v1.4.2-rc.1",
    // Set by the deploy environment; the file can't say what it is.
    "ghcr.io/o/r:${TAG}",
  ]) {
    assert.ok(!hasMutableTag(pinned), `${pinned} should be pinned`);
  }
});

await check("only `always` counts; an explicit weaker policy is reported with its value", () => {
  const c = compose(
    "services:",
    "  a:",
    "    image: ghcr.io/o/a:main",
    "    pull_policy: missing",
    "  b:",
    "    image: ghcr.io/o/b:main",
    '    pull_policy: "always" # quoted',
  );
  const risks = composeStalePullRisks(c);
  assert.deepEqual(
    risks.map((r) => [r.service, r.pullPolicy]),
    [["a", "missing"]],
  );
});

await check("a pull_policy declared above image: still counts", () => {
  const c = compose(
    "services:",
    "  server:",
    "    pull_policy: always",
    "    environment:",
    "      A: 1",
    "    image: ghcr.io/o/r-server:main",
  );
  assert.deepEqual(flagged(c), []);
  // And the retrofit must not add a second key — compose refuses a
  // duplicate `pull_policy` outright.
  assert.equal(upgradeComposePullPolicy(c), c);
});

await check("quotes, trailing comments and column-0 comments are read correctly", () => {
  const c = compose(
    "services:",
    "  web: # the site",
    '    image: "ghcr.io/o/web:main" # pushed by CI',
    "# a note between keys",
    "    restart: unless-stopped",
    "  'api':",
    "    image: '${API_IMAGE:-ghcr.io/o/api:main}'",
  );
  const services = ghcrComposeServices(c);
  assert.deepEqual(
    services.map((s) => [s.service, s.image]),
    [
      ["web", "ghcr.io/o/web:main"],
      ["api", "ghcr.io/o/api:main"],
    ],
  );
});

await check("a service that builds its image is not a pull risk", () => {
  const c = compose("services:", "  app:", "    build: .", "    image: ghcr.io/o/app:latest");
  assert.deepEqual(flagged(c), []);
});

// ---------------------------------------------------------------------------
// The retrofit and the check agree
// ---------------------------------------------------------------------------

await check("after `hatchkit update`'s retrofit, only explicit weaker policies remain", () => {
  const c = compose(
    "services:",
    "  server:",
    "    image: ${SERVER_IMAGE:-ghcr.io/o/r-server:main}",
    "  client:",
    '    image: "ghcr.io/o/r-client:latest"',
    "  worker:",
    "    image: ghcr.io/o/r-worker:main",
    "    pull_policy: if_not_present",
    "  mongo:",
    "    image: mongo:7",
  );
  assert.deepEqual(flagged(c), ["server", "client", "worker"]);
  const upgraded = upgradeComposePullPolicy(c);
  assert.deepEqual(flagged(upgraded), ["worker"]);
  assert.equal(upgradeComposePullPolicy(upgraded), upgraded, "not idempotent");
});

await check("the starter's own compose passes the check it will be held to", () => {
  const starter = readFileSync(join(HERE, "..", "starter", "docker-compose.yml"), "utf-8");
  assert.ok(ghcrComposeServices(starter).length >= 2, "starter has no ghcr services to check");
  assert.deepEqual(flagged(starter), []);
});

// ---------------------------------------------------------------------------
// The doctor check
// ---------------------------------------------------------------------------

function app(over: Partial<CoolifyComposeSource>): CoolifyComposeSource {
  return {
    uuid: "ica6zmwn4k122ovusx7j7l68",
    name: "ricos-labs-web",
    buildPack: "dockercompose",
    gitRepository: "trebeljahr/ricos-labs",
    gitBranch: "main",
    baseDirectory: "/",
    dockerComposeLocation: "/docker-compose.yml",
    dockerComposeRaw: RICOS_LABS_COMPOSE,
    ...over,
  };
}

const stub = (apps: CoolifyComposeSource[]) => ({
  api: { listComposeSources: async () => apps },
});

await check("an at-risk app WARNS and the hint names the app, repo and file", async () => {
  const results = await checkCoolifyComposePullPolicy(stub([app({})]));
  assert.equal(results.length, 1);
  const [r] = results;
  assert.equal(r.status, "warn");
  assert.match(r.name, /ricos-labs-web/);
  assert.match(r.detail ?? "", /client/);
  assert.match(r.detail ?? "", /ghcr\.io\/trebeljahr\/ricos-labs:latest/);
  const hint = (r.hint ?? []).join("\n");
  assert.match(hint, /ica6zmwn4k122ovusx7j7l68/);
  assert.match(hint, /trebeljahr\/ricos-labs/);
  assert.match(hint, /docker-compose\.yml/);
  assert.match(hint, /pull_policy: always/);
  assert.match(hint, /hatchkit update/);
  assert.match(hint, /hatchkit regen-infra/);
});

await check("the retrofit is only suggested where it would apply", async () => {
  const [explicit] = await checkCoolifyComposePullPolicy(
    stub([
      app({
        dockerComposeRaw: compose(
          "services:",
          "  client:",
          "    image: ghcr.io/o/r:main",
          "    pull_policy: missing",
        ),
      }),
    ]),
  );
  const explicitHint = (explicit.hint ?? []).join("\n");
  assert.match(explicitHint, /`client` declares `pull_policy: missing` — change it to `always`/);
  // The retrofit leaves an existing pull_policy alone, so it can't fix this.
  assert.doesNotMatch(explicitHint, /hatchkit update/);

  const [custom] = await checkCoolifyComposePullPolicy(
    stub([
      app({ dockerComposeLocation: "/docker-compose-prod.yaml", dockerComposeRaw: DOCS_COMPOSE }),
    ]),
  );
  const customHint = (custom.hint ?? []).join("\n");
  assert.match(customHint, /docker-compose-prod\.yaml/);
  assert.doesNotMatch(customHint, /hatchkit update/, "the retrofit doesn't touch that file");
});

await check("clean, never-deployed and non-compose apps", async () => {
  const fixed = RICOS_LABS_COMPOSE.replace(
    "    environment:",
    "    pull_policy: always\n    environment:",
  );
  const results = await checkCoolifyComposePullPolicy(
    stub([
      app({ dockerComposeRaw: fixed }),
      app({ name: "streaks", dockerComposeRaw: null }),
      app({ name: "tiao-frontend", buildPack: "dockerimage", dockerComposeRaw: null }),
    ]),
  );
  assert.deepEqual(
    results.map((r) => r.status),
    ["ok"],
  );
  assert.match(results[0].detail ?? "", /1 compose app\(s\) checked/);
  assert.match(results[0].detail ?? "", /1 never deployed/);

  assert.deepEqual(await checkCoolifyComposePullPolicy(stub([])), []);
});

await check("Coolify unreadable → skip, never fail", async () => {
  const [down] = await checkCoolifyComposePullPolicy({
    api: {
      listComposeSources: async () => {
        throw new Error("Coolify API GET /applications failed: HTTP 401 Unauthenticated");
      },
    },
  });
  assert.equal(down.status, "skip");
  assert.match(down.detail ?? "", /HTTP 401/);

  const [hidden] = await checkCoolifyComposePullPolicy(
    stub([app({ dockerComposeRaw: undefined })]),
  );
  assert.equal(hidden.status, "skip");
});

// ---------------------------------------------------------------------------
// Secrets never leave the API layer
// ---------------------------------------------------------------------------

await check(
  "docker_compose (interpolated secrets) is dropped; nothing prints a value",
  async () => {
    const SECRET = "d0tenvx-pr1vate-key-that-must-not-print";
    const body = [
      {
        uuid: "ica6zmwn4k122ovusx7j7l68",
        name: "ricos-labs-web",
        build_pack: "dockercompose",
        git_repository: "trebeljahr/ricos-labs",
        git_branch: "main",
        base_directory: "/",
        docker_compose_location: "/docker-compose.yml",
        docker_compose_raw: RICOS_LABS_COMPOSE,
        // What Coolify actually returns next to the raw file: the rendered
        // compose with the app's env inlined.
        docker_compose: compose(
          "services:",
          "  client:",
          "    image: ghcr.io/trebeljahr/ricos-labs:latest",
          "    environment:",
          `      DOTENV_PRIVATE_KEY_PRODUCTION: ${SECRET}`,
        ),
      },
    ];
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const api = new CoolifyApi({ url: "https://coolify.example", token: "t" });
      const sources = await api.listComposeSources();
      assert.equal(sources.length, 1);
      assert.ok(!("docker_compose" in sources[0]), "rendered compose leaked into the result");
      assert.ok(!JSON.stringify(sources).includes(SECRET));

      const results = await checkCoolifyComposePullPolicy({ api });
      assert.equal(results[0]?.status, "warn");
      assert.ok(!JSON.stringify(results).includes(SECRET), "a secret reached doctor output");
    } finally {
      globalThis.fetch = original;
    }
  },
);

if (failures.length > 0) {
  console.log("\nDoctor pull-policy test failures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}

console.log("\nAll doctor pull-policy cases passed.");
