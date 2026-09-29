/**
 * Project isolation: no project holds a credential that reaches another.
 *
 * The properties, each one a way the old setup let one repo reach every
 * project on the Coolify host:
 *
 *   1. A deploy is signed per APPLICATION. The payload names the app's
 *      repository and branch and the sentinel watch path; the answer
 *      counts only when THIS app queued a deploy, and a failure never
 *      names another app (a public repo's log is public).
 *   2. The per-app hook is minted from random bytes, kept in the store
 *      first, never reused across apps, and re-minted when Coolify and
 *      the store disagree. The other providers' webhook slots are locked
 *      too: a null secret there accepts an empty-key signature.
 *   3. Every generated or adopted workflow shape is converted to promote
 *      + signed deploy, keeps no reference to the token, and converting
 *      twice changes nothing. The shell step's HMAC matches hatchkit's.
 *   4. `:live` promotion copies manifest bytes verbatim and reads the tag
 *      back.
 *   5. The audit finds a provisioner value in an env map, the token's
 *      secret names on a repo and the workflows that read them — and
 *      reports key names only.
 *
 * No test touches the network, the keychain, Coolify or GitHub.
 *
 * Run: `pnpm exec tsx test-project-isolation.ts`
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "isolation-conf-"));

const {
  DEPLOY_HOOK_WATCH_PATH,
  deployHookSecretNames,
  deployWebhookQueued,
  ensureDeployHook,
  hookRepositoryOf,
  liveImageRefs,
  renderDeployWebhookBody,
  signDeployWebhook,
  withLiveTag,
} = await import("./src/deploy/coolify-deploy-hook.js");
const { upgradeWorkflowToSignedDeploy, WORKFLOW_SIGNED_DEPLOY_STEP, workflowsPromotingLive } =
  await import("./src/scaffold/signed-deploy.js");
const { parseBearerChallenge, parseImageName, promoteTag } = await import(
  "./src/utils/oci-registry.js"
);
const { findProvisionerSecretNames, findProvisionerValuesInEnv, findWorkflowTokenReads } =
  await import("./src/secrets/isolation.js");
const { workflowsReading } = await import("./src/deploy/gh-actions-secrets.js");
const { composeImageVarsToSwitch } = await import("./src/secrets/isolate.js");

const failures: string[] = [];
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

const SHA = "c".repeat(40);

// ── 1. The signed payload and the answer ──────────────────────────────

console.log("\nsigned deploy webhook\n");

await check("the payload names the branch, the repo, the commit and the sentinel", () => {
  const body = JSON.parse(
    renderDeployWebhookBody({ repository: "acme/app", branch: "main", sha: SHA }),
  );
  assert.equal(body.ref, "refs/heads/main");
  assert.equal(body.after, SHA);
  assert.equal(body.repository.full_name, "acme/app");
  assert.deepEqual(body.commits[0].modified, [DEPLOY_HOOK_WATCH_PATH]);
});

await check("the signature is HMAC-SHA256 over the exact body", () => {
  const body = renderDeployWebhookBody({ repository: "acme/app", branch: "main", sha: SHA });
  assert.equal(signDeployWebhook("k", body), createHmac("sha256", "k").update(body).digest("hex"));
});

await check("only this app's success (or a skip) counts as queued", () => {
  const answer = (entries: unknown[]) => JSON.stringify(entries);
  assert.equal(
    deployWebhookQueued(answer([{ status: "success", application_uuid: "mine" }]), "mine").ok,
    true,
  );
  assert.equal(
    deployWebhookQueued(answer([{ status: "success", application_uuid: "theirs" }]), "mine").ok,
    false,
    "another app's success is not ours",
  );
  assert.equal(deployWebhookQueued(answer([{ status: "skipped", message: "x" }]), "mine").ok, true);
  const disabled = deployWebhookQueued(
    answer([{ status: "failed", message: "Deployments disabled.", application: "mine-app" }]),
    "mine",
  );
  assert.equal(disabled.ok, false);
  assert.match(disabled.detail, /Deployments disabled/);
  assert.equal(deployWebhookQueued("Nothing to do. No applications found.", "mine").ok, false);
});

await check("a failure never names the other apps on the repo", () => {
  const verdict = deployWebhookQueued(
    JSON.stringify([
      {
        application: "someone-elses-secret-project",
        status: "failed",
        message: "Invalid signature.",
      },
    ]),
    "mine",
  );
  assert.equal(verdict.ok, false);
  assert.ok(!verdict.detail.includes("someone-elses-secret-project"));
  assert.match(verdict.detail, /deploy secret is stale/);
});

await check("secret names: unprefixed for one app, CLIENT_/SERVER_ for a split", () => {
  assert.deepEqual(deployHookSecretNames(), {
    uuid: "COOLIFY_RESOURCE_UUID",
    secret: "COOLIFY_DEPLOY_SECRET",
    repository: "COOLIFY_DEPLOY_REPOSITORY",
    branch: "COOLIFY_DEPLOY_BRANCH",
  });
  assert.equal(deployHookSecretNames("server").secret, "COOLIFY_SERVER_DEPLOY_SECRET");
});

await check("the hook repository is read from every shape Coolify stores", () => {
  assert.equal(hookRepositoryOf("trebeljahr/gamedev"), "trebeljahr/gamedev");
  assert.equal(hookRepositoryOf("https://github.com/trebeljahr/gamedev.git"), "trebeljahr/gamedev");
  assert.equal(hookRepositoryOf("git@github.com:trebeljahr/gamedev.git"), "trebeljahr/gamedev");
  // A Docker Image app keeps Coolify's placeholder; the payload must name it.
  assert.equal(hookRepositoryOf("coollabsio/coolify"), "coollabsio/coolify");
  assert.equal(hookRepositoryOf(undefined), undefined);
});

// ── 2. Minting a hook ─────────────────────────────────────────────────

console.log("\nper-app deploy hooks\n");

function fakeCoolify(initial: {
  github?: string | null;
  locked?: boolean;
  watch?: string | null;
}) {
  const app = {
    github: initial.github ?? null,
    locked: initial.locked ?? false,
    watch: initial.watch ?? null,
    autoDeploy: undefined as boolean | undefined,
    patches: 0,
  };
  return {
    app,
    api: {
      getDeployHookState: async () => ({
        githubSecret: app.github,
        otherSlotsLocked: app.locked,
        watchPaths: app.watch,
        gitRepository: "trebeljahr/demo",
        gitBranch: "main",
        buildPack: "dockerimage",
      }),
      updateDeployHook: async (
        _uuid: string,
        fields: {
          webhookSecrets?: Record<string, string | undefined>;
          watchPaths?: string;
          autoDeploy?: boolean;
        },
      ) => {
        app.patches += 1;
        if (fields.webhookSecrets?.github) app.github = fields.webhookSecrets.github;
        if (fields.webhookSecrets?.gitea) app.locked = true;
        if (fields.watchPaths !== undefined) app.watch = fields.watchPaths;
        if (fields.autoDeploy !== undefined) app.autoDeploy = fields.autoDeploy;
      },
    },
  };
}

function memoryStore(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  const writes: string[] = [];
  return {
    map,
    writes,
    store: {
      get: async (k: string) => map.get(k) ?? null,
      set: async (k: string, v: string) => {
        writes.push(k);
        map.set(k, v);
      },
    },
  };
}

await check(
  "an unconfigured app gets a secret, locked slots, the watch path and auto-deploy",
  async () => {
    const { app, api } = fakeCoolify({});
    const mem = memoryStore();
    const { hook, changes } = await ensureDeployHook(api, "u1", { store: mem.store });
    assert.match(hook.secret, /^[0-9a-f]{64}$/);
    assert.equal(app.github, hook.secret);
    assert.equal(mem.map.get("coolify:deploy-webhook:u1"), hook.secret, "kept in the store");
    assert.equal(app.locked, true);
    assert.equal(app.watch, DEPLOY_HOOK_WATCH_PATH);
    assert.equal(app.autoDeploy, true, "the manual webhook refuses to deploy without it");
    assert.equal(hook.repository, "trebeljahr/demo");
    assert.ok(changes.includes("set deploy secret"));
  },
);

await check(
  "an app already in sync keeps its secret — sync must not break the repo's copy",
  async () => {
    const { app, api } = fakeCoolify({
      github: "a".repeat(64),
      locked: true,
      watch: DEPLOY_HOOK_WATCH_PATH,
    });
    const mem = memoryStore({ "coolify:deploy-webhook:u1": "a".repeat(64) });
    const { hook, changes } = await ensureDeployHook(api, "u1", { store: mem.store });
    assert.equal(hook.secret, "a".repeat(64));
    assert.equal(app.github, "a".repeat(64));
    assert.deepEqual(changes, []);
    assert.deepEqual(mem.writes, []);
  },
);

await check(
  "a secret the store doesn't match is re-minted (the store is what CI was given)",
  async () => {
    const { app, api } = fakeCoolify({
      github: "b".repeat(64),
      locked: true,
      watch: DEPLOY_HOOK_WATCH_PATH,
    });
    const mem = memoryStore({ "coolify:deploy-webhook:u1": "a".repeat(64) });
    const { hook } = await ensureDeployHook(api, "u1", { store: mem.store });
    assert.notEqual(hook.secret, "a".repeat(64));
    assert.notEqual(hook.secret, "b".repeat(64));
    assert.equal(app.github, hook.secret);
  },
);

await check("--rotate always mints, and two apps never share a secret", async () => {
  const one = fakeCoolify({ github: "a".repeat(64), locked: true, watch: DEPLOY_HOOK_WATCH_PATH });
  const two = fakeCoolify({});
  const mem = memoryStore({ "coolify:deploy-webhook:u1": "a".repeat(64) });
  const a = await ensureDeployHook(one.api, "u1", { store: mem.store, rotate: true });
  const b = await ensureDeployHook(two.api, "u2", { store: mem.store });
  assert.notEqual(a.hook.secret, "a".repeat(64));
  assert.notEqual(a.hook.secret, b.hook.secret);
});

await check("--dry-run reports and writes nothing", async () => {
  const { app, api } = fakeCoolify({});
  const mem = memoryStore();
  const { changes } = await ensureDeployHook(api, "u1", { store: mem.store, dryRun: true });
  assert.ok(changes.length > 0);
  assert.equal(app.patches, 0);
  assert.deepEqual(mem.writes, []);
});

await check(
  "an app whose other slots are open gets them locked without a new GitHub secret",
  async () => {
    const { app, api } = fakeCoolify({
      github: "a".repeat(64),
      locked: false,
      watch: DEPLOY_HOOK_WATCH_PATH,
    });
    const mem = memoryStore({ "coolify:deploy-webhook:u1": "a".repeat(64) });
    const { hook, changes } = await ensureDeployHook(api, "u1", { store: mem.store });
    assert.equal(hook.secret, "a".repeat(64));
    assert.equal(app.locked, true);
    assert.ok(changes.includes("locked the other webhook slots"));
  },
);

// ── 3. Workflows ──────────────────────────────────────────────────────

console.log("\nworkflow conversion\n");

/** The three shapes of deploy step the repos on this machine carried. */
const LEGACY_TRIGGER = `name: deploy
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Trigger Coolify deploy
        env:
          COOLIFY_WEBHOOK_URL: \${{ secrets.COOLIFY_WEBHOOK_URL }}
          COOLIFY_TOKEN: \${{ secrets.COOLIFY_TOKEN }}
        run: |
          curl -fsSL -X GET "$COOLIFY_WEBHOOK_URL" \\
            -H "Authorization: Bearer $COOLIFY_TOKEN"
`;

const LEGACY_API = `name: build-and-deploy
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy via Coolify API
        env:
          COOLIFY_BASE_URL: \${{ secrets.COOLIFY_BASE_URL }}
          COOLIFY_RESOURCE_UUID: \${{ secrets.COOLIFY_RESOURCE_UUID }}
          COOLIFY_API_TOKEN: \${{ secrets.COOLIFY_API_TOKEN }}
        if: env.COOLIFY_BASE_URL != '' && env.COOLIFY_RESOURCE_UUID != ''
        run: |
          curl -fsSL -X POST \\
            "$COOLIFY_BASE_URL/api/v1/deploy?uuid=$COOLIFY_RESOURCE_UUID&force=true" \\
            -H "Authorization: Bearer $COOLIFY_API_TOKEN"

      - name: Deploy via webhook (fallback)
        env:
          COOLIFY_BASE_URL: \${{ secrets.COOLIFY_BASE_URL }}
          COOLIFY_WEBHOOK_URL: \${{ secrets.COOLIFY_WEBHOOK_URL }}
        if: env.COOLIFY_BASE_URL == '' && env.COOLIFY_WEBHOOK_URL != ''
        run: curl -fsSL "$COOLIFY_WEBHOOK_URL"
`;

const LEGACY_PIN_SINGLE = `name: build-and-deploy
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Pin the image tag to this commit
        env:
          COOLIFY_API_TOKEN: \${{ secrets.COOLIFY_API_TOKEN }}
        run: |
          APP_IMAGE="ghcr.io/\${{ github.repository }}:\${{ github.sha }}"
          curl -X PATCH -H "Authorization: Bearer $COOLIFY_API_TOKEN" "$COOLIFY_BASE_URL/api/v1/applications/x/envs"

      - name: Deploy via Coolify API
        env:
          COOLIFY_API_TOKEN: \${{ secrets.COOLIFY_API_TOKEN }}
        run: curl -X POST -H "Authorization: Bearer $COOLIFY_API_TOKEN" "$COOLIFY_BASE_URL/api/v1/deploy"
`;

for (const [label, input] of [
  ["older adopt workflow (Trigger Coolify deploy)", LEGACY_TRIGGER],
  ["API deploy + webhook fallback", LEGACY_API],
  ["single-image pin + API deploy", LEGACY_PIN_SINGLE],
] as const) {
  await check(`${label}: converted, token-free, idempotent`, () => {
    const out = upgradeWorkflowToSignedDeploy(input);
    assert.notEqual(out, input);
    for (const name of ["COOLIFY_API_TOKEN", "COOLIFY_TOKEN", "COOLIFY_WEBHOOK_URL", "/api/v1/"]) {
      assert.ok(!out.includes(name), `${name} survived`);
    }
    assert.equal(out.split("- name: Deploy via signed Coolify webhook").length - 1, 1);
    assert.equal(upgradeWorkflowToSignedDeploy(out), out, "not idempotent");
  });
}

await check("token env at job level goes with the step, and an emptied env block with it", () => {
  const input = `jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      COOLIFY_API_TOKEN: \${{ secrets.COOLIFY_API_TOKEN }}
      COOLIFY_WEBHOOK_URL: \${{ secrets.COOLIFY_WEBHOOK_URL }}
    steps:
      - name: Trigger Coolify deployment
        run: curl -H "Authorization: Bearer $COOLIFY_API_TOKEN" -X POST "$COOLIFY_WEBHOOK_URL"
`;
  const out = upgradeWorkflowToSignedDeploy(input);
  assert.ok(!out.includes("COOLIFY_API_TOKEN"));
  assert.ok(!/^ {4}env:\s*$/m.test(out), "an empty job-level env block survived");
  // A file that still uses the token keeps its env entries.
  const handRolled = `${input}      - name: My own step\n        run: echo "$COOLIFY_API_TOKEN" | wc -c\n`;
  assert.ok(upgradeWorkflowToSignedDeploy(handRolled).includes("COOLIFY_API_TOKEN: ${{"));
});

await check("a pin step becomes a promote step; no pin means no promote", () => {
  const pinned = upgradeWorkflowToSignedDeploy(LEGACY_PIN_SINGLE);
  assert.ok(pinned.includes("- name: Promote this commit's images to :live"));
  assert.ok(pinned.includes('image="ghcr.io/${{ github.repository }}"'), "single-image promote");
  assert.ok(
    pinned.indexOf("Promote this commit") < pinned.indexOf("Deploy via signed Coolify webhook"),
  );
  // Apps of a workflow that never pinned pull a moving tag the build
  // pushes; a promote without repointing them would change nothing.
  assert.ok(!upgradeWorkflowToSignedDeploy(LEGACY_TRIGGER).includes("Promote this commit"));
});

await check("a hand-rolled workflow is left alone", () => {
  const custom = "jobs:\n  deploy:\n    steps:\n      - run: ./my-deploy.sh\n";
  assert.equal(upgradeWorkflowToSignedDeploy(custom), custom);
});

await check("the shell step signs exactly what hatchkit signs", () => {
  const script = WORKFLOW_SIGNED_DEPLOY_STEP.match(/node -e \\\n\s+'([^']+)'/)?.[1];
  assert.ok(script, "signing one-liner not found");
  const body = renderDeployWebhookBody({ repository: "acme/app", branch: "main", sha: SHA });
  const shell = execFileSync("node", ["-e", script as string], {
    input: body,
    env: { ...process.env, HOOK_SECRET: "k" },
    encoding: "utf8",
  });
  assert.equal(shell, signDeployWebhook("k", body));
  // The watch path and endpoint in the shell step are hatchkit's.
  assert.ok(WORKFLOW_SIGNED_DEPLOY_STEP.includes(`modified: ["${DEPLOY_HOOK_WATCH_PATH}"]`));
  assert.ok(WORKFLOW_SIGNED_DEPLOY_STEP.includes("/webhooks/source/github/events/manual"));
});

await check("the shell step accepts exactly the answers hatchkit accepts (jq)", () => {
  let jq = true;
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
  } catch {
    jq = false;
  }
  if (!jq) return; // CI images have jq; a laptop without it skips.
  const filter = WORKFLOW_SIGNED_DEPLOY_STEP.match(
    /jq -e --arg uuid "\$uuid" \\\n\s+'([^']+)'/,
  )?.[1];
  assert.ok(filter, "acceptance filter not found");
  for (const answer of [
    [{ status: "success", application_uuid: "u" }],
    [{ status: "success", application_uuid: "other" }],
    [{ status: "skipped", message: "already queued" }],
    [{ status: "failed", message: "Deployments disabled.", application: "x" }],
    [{ status: "failed", message: "Invalid signature.", application: "y" }],
    [],
  ]) {
    const text = JSON.stringify(answer);
    let shellOk = true;
    try {
      execFileSync("jq", ["-e", "--arg", "uuid", "u", filter as string], {
        input: text,
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch {
      shellOk = false;
    }
    assert.equal(shellOk, deployWebhookQueued(text, "u").ok, text);
  }
});

await check("workflow scans: who reads the token, who promotes :live", () => {
  const dir = mkdtempSync(join(tmpdir(), "isolation-wf-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/old.yml"), LEGACY_API);
  writeFileSync(
    join(dir, ".github/workflows/new.yml"),
    upgradeWorkflowToSignedDeploy(LEGACY_PIN_SINGLE),
  );
  assert.deepEqual(workflowsReading(dir, ["COOLIFY_API_TOKEN"]), [".github/workflows/old.yml"]);
  assert.deepEqual(workflowsPromotingLive(dir), [".github/workflows/new.yml"]);
  const reads = findWorkflowTokenReads(dir);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].where, ".github/workflows/old.yml");
});

await check("the :live switch reads only production image variables", () => {
  // A preview copy of the same key, left on an old image name, came after
  // the production row and used to decide both the tag seeded and the
  // value written to the production variable.
  const rows = [
    { key: "CLIENT_IMAGE", value: `ghcr.io/acme/app-client:${SHA}`, isPreview: false },
    { key: "CLIENT_IMAGE", value: "ghcr.io/acme/old-client:1234", isPreview: true },
    { key: "SERVER_IMAGE", value: undefined, isPreview: false },
    { key: "APP_IMAGE", value: "ghcr.io/acme/app:live", isPreview: false },
    { key: "MONGODB_URI", value: "mongodb://user:pass@db/app", isPreview: false },
    { key: "OTHER_IMAGE", value: "not an image ref", isPreview: false },
  ];
  assert.deepEqual(composeImageVarsToSwitch(rows), {
    CLIENT_IMAGE: `ghcr.io/acme/app-client:${SHA}`,
  });
  assert.deepEqual(composeImageVarsToSwitch([...rows].reverse()), {
    CLIENT_IMAGE: `ghcr.io/acme/app-client:${SHA}`,
  });
});

// ── 4. The registry ───────────────────────────────────────────────────

console.log("\nregistry promotion\n");

await check("image names parse, and a Docker Hub short name is refused", () => {
  assert.deepEqual(parseImageName("ghcr.io/Acme/App:main"), {
    registry: "ghcr.io",
    repository: "acme/app",
  });
  assert.deepEqual(parseImageName("localhost:5000/app"), {
    registry: "localhost:5000",
    repository: "app",
  });
  assert.throws(() => parseImageName("nginx:latest"));
  assert.equal(withLiveTag("ghcr.io/acme/app:main"), "ghcr.io/acme/app:live");
  assert.equal(withLiveTag("localhost:5000/app"), "localhost:5000/app:live");
  assert.deepEqual(liveImageRefs({ a: "ghcr.io/x/y:1", b: undefined }), {
    a: "ghcr.io/x/y:live",
    b: undefined,
  });
  assert.deepEqual(parseBearerChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io"'), {
    realm: "https://ghcr.io/token",
    service: "ghcr.io",
  });
});

await check("promote copies the manifest bytes verbatim and reads the tag back", async () => {
  const body = '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}';
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const tags: Record<string, string> = { [SHA]: body };
  const calls: string[] = [];
  const fakeFetch = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const res = (status: number, text = "", headers: Record<string, string> = {}) => ({
      status,
      ok: status < 400,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      text: async () => text,
    });
    if (url === "https://ghcr.io/v2/") {
      return res(401, "", {
        "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
      });
    }
    if (url.startsWith("https://ghcr.io/token")) {
      assert.match(url, /scope=repository%3Aacme%2Fapp%3Apull%2Cpush/);
      return res(200, JSON.stringify({ token: "t" }));
    }
    const tag = url.split("/manifests/")[1];
    if (init?.method === "PUT") {
      assert.equal(init.body, body, "bytes were re-serialised");
      tags[tag] = init.body as string;
      return res(201);
    }
    return tags[tag]
      ? res(200, tags[tag], {
          "content-type": "application/vnd.oci.image.index.v1+json",
          "docker-content-digest": digest,
        })
      : res(404);
  };
  const out = await promoteTag(fakeFetch, {
    image: "ghcr.io/acme/app",
    from: SHA,
    to: "live",
    auth: { username: "u", password: "p" },
  });
  assert.equal(out.digest, digest);
  assert.equal(tags.live, body);
  await assert.rejects(
    promoteTag(fakeFetch, {
      image: "ghcr.io/acme/app",
      from: "d".repeat(40),
      to: "live",
      auth: { username: "u", password: "p" },
    }),
    /does not exist/,
  );
});

// ── 5. The audit ──────────────────────────────────────────────────────

console.log("\nthe isolation audit\n");

const provisioners = [
  {
    provider: "coolify" as const,
    label: "hatchkit's Coolify token",
    value: "1|root-token-value-xyz",
    severity: "fail" as const,
  },
  {
    provider: "ses" as const,
    label: "hatchkit's shared SES access key id",
    value: "AKIAEXAMPLEEXAMPLE12",
    severity: "fail" as const,
  },
];

await check("a provisioner value in an env map is found — by key name only", () => {
  const found = findProvisionerValuesInEnv(
    { SOME_TOKEN: "1|root-token-value-xyz", OTHER: "unrelated-value-123456" },
    provisioners,
    ".env.production",
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "fail");
  assert.ok(found[0].what.startsWith("SOME_TOKEN "));
  assert.ok(!JSON.stringify(found).includes("root-token-value"), "a value leaked into a finding");
});

await check("SES SMTP keys are flagged even when they hold an older key", () => {
  const found = findProvisionerValuesInEnv(
    { SES_SMTP_USERNAME: "AKIAOLDOLDOLDOLDOLD1", SES_SMTP_PASSWORD: "x".repeat(44) },
    provisioners,
    "dev env",
  );
  assert.equal(found.filter((f) => f.provider === "ses").length, 2);
});

await check("the token's secret names on a repo are failures; the webhook URL a warning", () => {
  const found = findProvisionerSecretNames(
    ["COOLIFY_API_TOKEN", "COOLIFY_TOKEN", "COOLIFY_WEBHOOK_URL", "COOLIFY_DEPLOY_SECRET"],
    "acme/app",
  );
  assert.deepEqual(
    found.map((f) => [f.severity, f.what.split(" ")[0]]),
    [
      ["fail", "COOLIFY_API_TOKEN"],
      ["fail", "COOLIFY_TOKEN"],
      ["warn", "COOLIFY_WEBHOOK_URL"],
    ],
  );
  assert.deepEqual(findProvisionerSecretNames(["COOLIFY_DEPLOY_SECRET"], "acme/app"), []);
});

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log("\n  all project-isolation checks passed");
