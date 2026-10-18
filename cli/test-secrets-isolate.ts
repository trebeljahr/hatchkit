/**
 * `hatchkit secrets isolate` on repos that are not one plain Coolify app.
 *
 * Three gaps a hand-wired repo (a Worker client + a Coolify image app for
 * the API, 2026-10-19) found, pinned here:
 *
 *   1. A repo with a Worker client still gets its Coolify hooks when
 *      `--app` names them or the manifest says `clientHost: "cloudflare"`.
 *      A workflow that signs a hook in a step of its own is never
 *      rewritten, and a run whose secret set no workflow reads stops
 *      before writing, naming the `--app <uuid>:<role>` that matches.
 *   2. A Docker Image app holds Coolify's placeholder repository, which no
 *      signed payload matches: hatchkit writes the signing repo's
 *      `owner/repo` there — after the watch path is read back — or
 *      refuses with the fix.
 *   3. The dry run names the secrets the real run sets and deletes: split
 *      iff an app has a role, so ONE `--app <uuid>:server` sets the
 *      SERVER_ set and deletes the unprefixed one.
 *
 * No test touches the network, the OS keychain, Coolify or GitHub.
 *
 * Run: `node scripts/test.mjs test-secrets-isolate.ts`
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  COOLIFY_PLACEHOLDER_REPOSITORY,
  DEPLOY_HOOK_WATCH_PATH,
  deployHookSecretNames,
  ensureDeployHook,
  planHookRepository,
} = await import("./src/deploy/coolify-deploy-hook.js");
const { PROVISIONER_SECRETS, computeCoolifyDeploySecrets, planCoolifyDeploySecretNames } =
  await import("./src/deploy/gh-actions-secrets.js");
const { WORKFLOW_SIGNED_DEPLOY_STEP, signsDeployHookItself, upgradeWorkflowToSignedDeploy } =
  await import("./src/scaffold/signed-deploy.js");
const {
  coolifyAppsBesideWorker,
  deploysCoolifyBesideWorker,
  dryRunSecretChanges,
  hookSetMismatch,
  isolateProject,
  planWorkflowConversion,
  workerRepoName,
} = await import("./src/secrets/isolate.js");
const { getStore } = await import("./src/config.js");
const { SECRET_KEYS, setSecret } = await import("./src/utils/secrets.js");
type CoolifyDeployApp = import("./src/deploy/gh-actions-secrets.js").CoolifyDeployApp;

const failures: string[] = [];
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

const names = (role?: "client" | "server") => Object.values(deployHookSecretNames(role));

/** A deploy job that signs the server's hook itself and reads only the
 *  SERVER_ set — and, below it, a token step a rewrite would replace with
 *  hatchkit's step, which deploys the unprefixed set too. */
const HAND_SIGNED = `name: build-and-deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      COOLIFY_BASE_URL: \${{ secrets.COOLIFY_BASE_URL }}
      COOLIFY_SERVER_RESOURCE_UUID: \${{ secrets.COOLIFY_SERVER_RESOURCE_UUID }}
      COOLIFY_SERVER_DEPLOY_SECRET: \${{ secrets.COOLIFY_SERVER_DEPLOY_SECRET }}
      COOLIFY_SERVER_DEPLOY_REPOSITORY: \${{ secrets.COOLIFY_SERVER_DEPLOY_REPOSITORY }}
      COOLIFY_SERVER_DEPLOY_BRANCH: \${{ secrets.COOLIFY_SERVER_DEPLOY_BRANCH }}
    steps:
      - name: Deploy the server via its signed Coolify webhook
        run: |
          curl -fsS -X POST "$COOLIFY_BASE_URL/webhooks/source/github/events/manual" --data-binary "$body"

      - name: Trigger Coolify deploy
        env:
          COOLIFY_WEBHOOK_URL: \${{ secrets.COOLIFY_WEBHOOK_URL }}
          COOLIFY_TOKEN: \${{ secrets.COOLIFY_TOKEN }}
        run: curl -fsSL "$COOLIFY_WEBHOOK_URL" -H "Authorization: Bearer $COOLIFY_TOKEN"
`;

const WORKER_UPLOAD = `name: client
jobs:
  upload:
    runs-on: ubuntu-latest
    steps:
      - uses: cloudflare/wrangler-action@v4
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
`;

/** A repo on disk: wrangler.jsonc, workflows, optional manifest, and a
 *  GitHub `origin`. */
function repo(opts: {
  workflows: Record<string, string>;
  manifest?: Record<string, unknown>;
  worker?: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "isolate-repo-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  for (const [file, text] of Object.entries(opts.workflows)) {
    writeFileSync(join(dir, ".github/workflows", file), text);
  }
  if (opts.worker) {
    writeFileSync(join(dir, "wrangler.jsonc"), `{\n  "name": "${opts.worker}",\n}\n`);
  }
  if (opts.manifest) {
    writeFileSync(join(dir, ".hatchkit.json"), JSON.stringify({ version: 4, ...opts.manifest }));
  }
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/chess.git"]);
  return dir;
}

// ── 1. A Worker client beside Coolify apps ────────────────────────────

console.log("\na Worker client with its API on Coolify\n");

await check(
  "a manifest-less Worker repo takes the Coolify path too once --app names an app",
  () => {
    const dir = repo({ workflows: { "client.yml": WORKER_UPLOAD }, worker: "chess-client" });
    assert.equal(workerRepoName(dir, null), "chess-client");
    assert.equal(deploysCoolifyBesideWorker(null, []), false, "no --app: Worker only, as before");
    assert.equal(deploysCoolifyBesideWorker(null, undefined), false);
    assert.equal(deploysCoolifyBesideWorker(null, [{ uuid: "u1", role: "server" }]), true);
  },
);

await check('a clientHost "cloudflare" manifest has a Worker AND Coolify apps', () => {
  const manifest = {
    name: "mood",
    domain: "mood.example",
    deploymentMode: "coolify" as const,
    clientHost: "cloudflare" as const,
    surfaces: "fullstack" as const,
    topology: "single-origin" as const,
  };
  const dir = repo({ workflows: {}, manifest });
  assert.equal(workerRepoName(dir, manifest), "mood-client", "default <name>-client");
  assert.equal(workerRepoName(dir, { ...manifest, clientWorker: "mood-web" }), "mood-web");
  assert.equal(deploysCoolifyBesideWorker(manifest, undefined), true);
  assert.equal(deploysCoolifyBesideWorker({ deploymentMode: "coolify" }, undefined), false);
  // The legacy compose app (`mood`) and the Coolify client app
  // migrate-client leaves running get no hook; the server gets role server.
  assert.deepEqual(
    coolifyAppsBesideWorker(manifest, [
      { uuid: "u-legacy", name: "mood" },
      { uuid: "u-client", name: "mood-client" },
      { uuid: "u-server", name: "mood-server" },
    ]),
    [{ uuid: "u-server", role: "server" }],
  );
});

await check("a workflow that signs its own hook is never rewritten, token step and all", () => {
  assert.equal(signsDeployHookItself(HAND_SIGNED), true);
  assert.equal(upgradeWorkflowToSignedDeploy(HAND_SIGNED), HAND_SIGNED);
  // hatchkit's own signed step is not "its own": it still converges.
  assert.equal(signsDeployHookItself(WORKFLOW_SIGNED_DEPLOY_STEP), false);
  const dir = repo({ workflows: { "deploy.yml": HAND_SIGNED } });
  const [plan] = planWorkflowConversion(dir);
  assert.equal(plan.after, plan.before);
  assert.equal(plan.signsItself, true);
});

await check("a run whose secret set no workflow reads is refused with the matching --app", () => {
  const workflows = [{ file: ".github/workflows/deploy.yml", after: HAND_SIGNED }];
  const refusal = hookSetMismatch(workflows, [{ uuid: "ej88" }]);
  assert.ok(refusal, "an unroled app would set COOLIFY_* and delete COOLIFY_SERVER_*");
  assert.match(refusal, /reads COOLIFY_SERVER_\*/);
  assert.match(refusal, /--app ej88:server/);
  assert.equal(hookSetMismatch(workflows, [{ uuid: "ej88", role: "server" }]), null);
  // The other way round: a single-app job and a roled app.
  const single = [{ file: "a.yml", after: "x: ${{ secrets.COOLIFY_RESOURCE_UUID }}" }];
  assert.match(hookSetMismatch(single, [{ uuid: "u", role: "server" }]) ?? "", /--app u\./);
  // hatchkit's step reads every set; a workflow reading none can't be judged.
  const generic = [{ file: "b.yml", after: WORKFLOW_SIGNED_DEPLOY_STEP }];
  assert.equal(hookSetMismatch(generic, [{ uuid: "u" }]), null);
  assert.equal(hookSetMismatch(generic, [{ uuid: "u", role: "server" }]), null);
  assert.equal(hookSetMismatch([{ file: "c.yml", after: WORKER_UPLOAD }], [{ uuid: "u" }]), null);
});

await check("isolateProject goes on to Coolify after the Worker when --app is given", async () => {
  const dir = repo({
    workflows: { "deploy.yml": HAND_SIGNED, "client.yml": WORKER_UPLOAD },
    worker: "chess-client",
  });
  // No Cloudflare provisioner and no Coolify in this config: each path
  // reports itself without reaching a network.
  const workerOnly = await isolateProject(dir, { dryRun: true, rotate: false, apps: [] });
  assert.equal(workerOnly.cloudflare?.workerName, "chess-client");
  assert.equal(workerOnly.errors.length, 1, workerOnly.errors.join("; "));
  assert.match(workerOnly.errors[0], /Cloudflare provisioner/);

  const both = await isolateProject(dir, {
    dryRun: true,
    rotate: false,
    apps: [{ uuid: "ej88" }],
  });
  assert.equal(both.cloudflare?.workerName, "chess-client", "the Worker check still ran");
  assert.ok(
    both.errors.some((e) => /Coolify is not configured/.test(e)),
    `--app was dropped: ${both.errors.join("; ")}`,
  );

  // With Coolify configured, the mismatch stops the run before any
  // Coolify or GitHub call.
  getStore().set("providers.coolify", { status: "configured", url: "https://coolify.test" });
  await setSecret(SECRET_KEYS.coolifyToken, "coolify-token-test");
  const refused = await isolateProject(dir, {
    dryRun: true,
    rotate: false,
    apps: [{ uuid: "ej88" }],
  });
  assert.ok(
    refused.errors.some((e) => e.includes("--app ej88:server")),
    refused.errors.join("; "),
  );
  assert.deepEqual(refused.workflowsSigned, [".github/workflows/deploy.yml"]);
  assert.deepEqual(refused.apps, [], "no hook was touched");
  assert.equal(readFileSync(join(dir, ".github/workflows/deploy.yml"), "utf8"), HAND_SIGNED);
  getStore().delete("providers.coolify");
});

// ── 2. The placeholder repository of a Docker Image app ───────────────

console.log("\nthe repository a Docker Image app's webhook matches on\n");

await check("Coolify's placeholder is replaced by the signing repo, a real repo is kept", () => {
  assert.deepEqual(
    planHookRepository({
      uuid: "u",
      gitRepository: COOLIFY_PLACEHOLDER_REPOSITORY,
      buildPack: "dockerimage",
      repoSlug: "acme/chess",
    }),
    { repository: "acme/chess", write: "acme/chess" },
  );
  assert.deepEqual(
    planHookRepository({ uuid: "u", buildPack: "dockerimage", repoSlug: "acme/chess" }),
    { repository: "acme/chess", write: "acme/chess" },
    "no git_repository at all",
  );
  assert.deepEqual(
    planHookRepository({
      uuid: "u",
      gitRepository: "acme/other",
      buildPack: "dockerimage",
      repoSlug: "acme/chess",
    }),
    { repository: "acme/other" },
    "set on purpose; the payload can name it",
  );
  // A git app's repository is what Coolify builds: never written.
  assert.deepEqual(
    planHookRepository({
      uuid: "u",
      gitRepository: "https://github.com/acme/app.git",
      buildPack: "dockercompose",
      repoSlug: "acme/chess",
    }),
    { repository: "acme/app" },
  );
  assert.throws(
    () => planHookRepository({ uuid: "u", buildPack: "dockercompose" }),
    /no git_repository hatchkit can read/,
  );
});

await check("without the signing repo the placeholder is refused with the fix", () => {
  assert.throws(
    () =>
      planHookRepository({
        uuid: "u9",
        gitRepository: COOLIFY_PLACEHOLDER_REPOSITORY,
        buildPack: "dockerimage",
      }),
    (err: Error) =>
      /no signed webhook matches/.test(err.message) &&
      err.message.includes("--app u9") &&
      err.message.includes('{"git_repository":"<owner>/<repo>"}'),
  );
});

function imageApp(initial: { watch?: string | null; keepWatch?: boolean } = {}) {
  const app = {
    github: null as string | null,
    locked: false,
    watch: initial.watch ?? null,
    gitRepository: COOLIFY_PLACEHOLDER_REPOSITORY,
    patches: [] as Array<Record<string, unknown>>,
  };
  return {
    app,
    api: {
      getDeployHookState: async () => ({
        githubSecret: app.github,
        otherSlotsLocked: app.locked,
        watchPaths: app.watch,
        gitRepository: app.gitRepository,
        gitBranch: "main",
        buildPack: "dockerimage",
      }),
      updateDeployHook: async (
        _uuid: string,
        fields: {
          webhookSecrets?: Record<string, string | undefined>;
          watchPaths?: string;
          autoDeploy?: boolean;
          gitRepository?: string;
        },
      ) => {
        app.patches.push({ ...fields });
        if (fields.webhookSecrets?.github) app.github = fields.webhookSecrets.github;
        if (fields.webhookSecrets?.gitea) app.locked = true;
        if (fields.watchPaths !== undefined && initial.keepWatch !== false) {
          app.watch = fields.watchPaths;
        }
        if (fields.gitRepository !== undefined) app.gitRepository = fields.gitRepository;
      },
    },
  };
}

function memoryStore() {
  const map = new Map<string, string>();
  return {
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => void map.set(k, v),
  };
}

await check("the repository is written in its own PATCH, after the watch path", async () => {
  const { app, api } = imageApp();
  const { hook, changes } = await ensureDeployHook(api, "u1", {
    repository: "acme/chess",
    store: memoryStore(),
  });
  assert.equal(hook.repository, "acme/chess", "CI's COOLIFY_DEPLOY_REPOSITORY");
  assert.equal(app.gitRepository, "acme/chess");
  assert.ok(changes.includes("git_repository=acme/chess"));
  assert.equal(app.patches.length, 2);
  assert.equal(app.patches[0].watchPaths, DEPLOY_HOOK_WATCH_PATH);
  assert.equal(app.patches[0].gitRepository, undefined, "not together with the watch path");
  assert.deepEqual(app.patches[1], { gitRepository: "acme/chess" });
});

await check("a watch path Coolify did not keep leaves the placeholder alone", async () => {
  const { app, api } = imageApp({ keepWatch: false });
  await assert.rejects(
    ensureDeployHook(api, "u1", { repository: "acme/chess", store: memoryStore() }),
    /did not keep watch_paths/,
  );
  assert.equal(app.gitRepository, COOLIFY_PLACEHOLDER_REPOSITORY);
});

await check("a dry run names the repository write and sends nothing", async () => {
  const { app, api } = imageApp({ watch: DEPLOY_HOOK_WATCH_PATH });
  const { hook, changes } = await ensureDeployHook(api, "u1", {
    repository: "acme/chess",
    dryRun: true,
    store: memoryStore(),
  });
  assert.equal(hook.repository, "acme/chess");
  assert.ok(changes.includes("git_repository=acme/chess"));
  assert.deepEqual(app.patches, []);
});

// ── 3. The dry run's secret plan is the real run's ────────────────────

console.log("\nthe secrets a run sets and deletes\n");

await check("one --app <uuid>:server sets the SERVER_ set and deletes the unprefixed one", () => {
  const plan = planCoolifyDeploySecretNames([{ uuid: "ej88", role: "server" }], {
    keepProvisioner: false,
  });
  assert.deepEqual(plan.set, ["COOLIFY_BASE_URL", ...names("server")]);
  for (const n of names()) assert.ok(plan.remove.includes(n), `${n} survives`);
  for (const n of names("server")) assert.ok(!plan.remove.includes(n));
  for (const n of PROVISIONER_SECRETS) assert.ok(plan.remove.includes(n));
});

await check("the plan's names are exactly what the push computes, for every layout", () => {
  const layouts: CoolifyDeployApp[][] = [
    [{ uuid: "a" }],
    [{ uuid: "s", role: "server" }],
    [{ uuid: "c", role: "client" }],
    [
      { uuid: "c", role: "client" },
      { uuid: "s", role: "server" },
    ],
  ];
  for (const apps of layouts) {
    const pushed = computeCoolifyDeploySecrets({
      hooks: apps.map((a) => ({ ...a, secret: "k", repository: "acme/chess", branch: "main" })),
      coolifyUrl: "https://coolify.test/",
    });
    const plan = planCoolifyDeploySecretNames(apps, { keepProvisioner: false });
    assert.deepEqual(plan.set, Object.keys(pushed.secrets), JSON.stringify(apps));
    assert.deepEqual(plan.remove, pushed.staleToRemove, JSON.stringify(apps));
  }
});

await check("the token stays while a workflow reads it, and only names the repo holds show", () => {
  const apps: CoolifyDeployApp[] = [{ uuid: "ej88", role: "server" }];
  const kept = planCoolifyDeploySecretNames(apps, { keepProvisioner: true });
  assert.deepEqual(kept.keep, [...PROVISIONER_SECRETS]);
  for (const n of PROVISIONER_SECRETS) assert.ok(!kept.remove.includes(n));

  const present = ["COOLIFY_RESOURCE_UUID", "COOLIFY_DEPLOY_SECRET", "COOLIFY_TOKEN", "OTHER"];
  assert.deepEqual(dryRunSecretChanges(apps, { keepProvisioner: false, present }), {
    set: ["COOLIFY_BASE_URL", ...names("server")],
    remove: ["COOLIFY_RESOURCE_UUID", "COOLIFY_DEPLOY_SECRET", "COOLIFY_TOKEN"],
    keep: [],
  });
  assert.deepEqual(dryRunSecretChanges(apps, { keepProvisioner: true, present }).keep, [
    "COOLIFY_TOKEN",
  ]);
  // An unreadable list: every candidate, as the plan has it.
  assert.deepEqual(
    dryRunSecretChanges(apps, { keepProvisioner: false, present: null }),
    planCoolifyDeploySecretNames(apps, { keepProvisioner: false }),
  );
});

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log("\n  all secrets-isolate checks passed");
