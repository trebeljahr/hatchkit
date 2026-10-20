/**
 * The deploy record every workflow hatchkit generates leaves when it makes
 * something live: a `record-ship` step (a GitHub Deployment, which
 * launchdeck's Shipped view reads) after the step that makes it live,
 * under that step's own `if:`, in a job allowed to write deployments,
 * with the action itself written into the project.
 *
 * One section per generator outside starter/ (the starter's own workflows
 * are pinned by test-deploy-verification.ts and test-mobile-release.ts):
 *
 *   · cloudflare mode's deploy.yml (create, and `hatchkit cloudflare`)
 *   · migrate-client's deploy-client job, which takes the web record over
 *     from the Coolify deploy job
 *   · adopt's deploy.yml
 *   · the signing workflows (TestFlight, Google Play)
 *
 * plus the template copy of the action against the starter's.
 *
 * Why the gate matters: uploads soft-skip when their secrets are missing.
 * A record step with any other `if:` records a ship that did not happen,
 * or misses one that did.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

process.env.HATCHKIT_CONF_DIR ??= mkdtempSync(join(tmpdir(), "record-ship-conf-"));

const { RECORD_SHIP_ACTION_REL_PATH, recordShipActionSource } = await import(
  "./src/scaffold/record-ship.js"
);
const { applyCloudflareMode, renderDeployWorkflow } = await import(
  "./src/scaffold/cloudflare-mode.js"
);
const { moveWebRecordToClient, rewriteWorkflowForWorkerClient } = await import(
  "./src/deploy/client-host-workflow.js"
);
const { scaffoldBuildPipeline } = await import("./src/scaffold/build-pipeline.js");
const { writeSigningWorkflows } = await import("./src/features/signing/workflow-writer.js");

const STARTER = resolve(import.meta.dirname, "..", "starter");
const starterPresent = existsSync(join(STARTER, "package.json"));
const STARTER_WORKFLOW = starterPresent
  ? readFileSync(join(STARTER, ".github/workflows/build-and-deploy.yml"), "utf-8")
  : "";

const results: Record<string, boolean> = {};
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results[name] = true;
    console.log(`  ok   ${name}`);
  } catch (err) {
    results[name] = false;
    console.log(`\n  x ${name}\n    ${(err as Error).message}\n`);
  }
}

const dirs: string[] = [];
function scratch(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `record-ship-${label}-`));
  dirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// Workflow reading
// ---------------------------------------------------------------------------

/** One top-level job, from its key to the next job (or the end). */
function job(yml: string, name: string): string {
  const at = yml.indexOf(`\n  ${name}:\n`);
  assert.ok(at !== -1, `no job "${name}"`);
  const rest = yml.slice(at + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_#-]/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** One step, from its `- name:` to the next step, comment or job. */
function step(body: string, name: string): string {
  const at = body.indexOf(`- name: ${name}\n`);
  assert.ok(at !== -1, `no step "${name}"`);
  const rest = body.slice(at);
  const next = rest.slice(1).search(/\n {6}[-#]|\n {0,4}\S/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** A step's own `if:`; undefined when it has none. */
const gate = (s: string): string | undefined => s.match(/\n {8}if: (.+)\n/)?.[1];

/** The record step's contract, in the job that makes something live. */
function assertRecords(
  yml: string,
  o: {
    job: string;
    /** The step that makes the thing live: the record shares its gate. */
    live: string;
    /** Checks the record must wait for. */
    after?: string[];
    record: string;
    environment: string;
    branch?: string;
    url?: string;
    /** Scopes the job had before it needed deployments: write. */
    keeps?: string[];
  },
): void {
  const body = job(yml, o.job);
  const live = step(body, o.live);
  const rec = step(body, o.record);
  assert.ok(rec.includes("uses: ./.github/actions/record-ship\n"), "calls record-ship");
  assert.ok(rec.includes(`environment: ${o.environment}\n`), `records ${o.environment}`);
  if (o.branch) assert.ok(rec.includes(`branch: ${o.branch}\n`), `branch ${o.branch}`);
  if (o.url) assert.ok(rec.includes(`url: ${o.url}\n`), `url ${o.url}`);
  assert.equal(gate(rec), gate(live), `"${o.record}" has the if: of "${o.live}"`);
  // A step's `if:` sees only its own env block, so the gate's variables
  // must be declared on the record step itself.
  for (const [, name] of (gate(rec) ?? "").matchAll(/\benv\.([A-Za-z_]\w*)/g)) {
    assert.match(rec, new RegExp(`\\n {10}${name}: `), `record step declares ${name}`);
  }
  for (const before of [o.live, ...(o.after ?? [])]) {
    assert.ok(body.indexOf(rec) > body.indexOf(step(body, before)), `after "${before}"`);
  }
  for (const scope of ["contents: read", "deployments: write", ...(o.keeps ?? [])]) {
    assert.match(body, new RegExp(`^ {4}permissions:\\n(?: {6}.+\\n)* {6}${scope}$`, "m"), scope);
  }
  // A local action needs the repository in this job, fetched under the
  // same gate (a sparse checkout that ran when the record did not is
  // harmless, one that skipped while the record ran is not).
  const checkoutAt = body.search(/^ {6}(?:- | {2})uses: actions\/checkout@/m);
  assert.ok(checkoutAt !== -1 && checkoutAt < body.indexOf(rec), "a checkout runs before it");
  const sparse = body.match(
    /- name: (.+)\n(?: {8}.+\n)*? {8}uses: actions\/checkout@v\d\n {8}with:\n {10}sparse-checkout: \.github\/actions\/record-ship\n/,
  );
  if (sparse) assert.equal(gate(step(body, sparse[1])), gate(rec), "sparse checkout gate");
}

/** actionlint over a project directory, local action included (it reads
 *  the action's inputs only inside a git repository). */
function actionlint(dir: string): void {
  if (spawnSync("actionlint", ["-version"]).status !== 0) {
    console.log("    (actionlint not installed — skipped)");
    return;
  }
  if (!existsSync(join(dir, ".git"))) spawnSync("git", ["init", "-q", dir]);
  const lint = spawnSync("actionlint", ["-shellcheck="], { cwd: dir, encoding: "utf8" });
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
}

function writeFile(dir: string, rel: string, body: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

const action = (dir: string): string | undefined =>
  existsSync(join(dir, RECORD_SHIP_ACTION_REL_PATH))
    ? readFileSync(join(dir, RECORD_SHIP_ACTION_REL_PATH), "utf-8")
    : undefined;

// ---------------------------------------------------------------------------
// The action itself
// ---------------------------------------------------------------------------

await test("the template copy of the action is the starter's, byte for byte", () => {
  if (!starterPresent) return console.log("    (starter not populated — skipped)");
  assert.equal(
    recordShipActionSource(),
    readFileSync(join(STARTER, RECORD_SHIP_ACTION_REL_PATH), "utf-8"),
  );
});

// ---------------------------------------------------------------------------
// Cloudflare mode
// ---------------------------------------------------------------------------

const SITE = "https://site.example.com";

await test("cloudflare: the web deploy is recorded after the activation", () => {
  assertRecords(renderDeployWorkflow("main", SITE), {
    job: "deploy",
    live: "Activate the version",
    record: "Record the web deploy",
    environment: "web",
    url: "${{ env.SITE_URL }}",
  });
});

await test("cloudflare: the workflow comes with the action, and passes actionlint", () => {
  const dir = scratch("cf");
  const mods: string[] = [];
  applyCloudflareMode(dir, { workerName: "site", siteUrl: SITE }, mods);
  assert.equal(action(dir), recordShipActionSource());
  assert.ok(mods.includes(`cloudflare: wrote ${RECORD_SHIP_ACTION_REL_PATH}`), mods.join("\n"));
  actionlint(dir);
});

await test("cloudflare: a workflow from before the record is replaced; a hand-written one is not", () => {
  const current = renderDeployWorkflow("main", SITE);
  const before = current
    .replace("    permissions:\n      contents: read\n      deployments: write\n", "")
    .replace(/\n\n {6}# Leave a GitHub Deployment[\s\S]*$/, "\n");
  assert.ok(!before.includes("record-ship") && !before.includes("deployments"), "fixture");
  const dir = scratch("cf-upgrade");
  writeFile(dir, ".github/workflows/deploy.yml", before);
  applyCloudflareMode(dir, { workerName: "site", siteUrl: SITE }, []);
  assert.equal(readFileSync(join(dir, ".github/workflows/deploy.yml"), "utf-8"), current);
  assert.equal(action(dir), recordShipActionSource());

  const mine = scratch("cf-mine");
  writeFile(mine, ".github/workflows/deploy.yml", "name: mine\n");
  applyCloudflareMode(mine, { workerName: "site", siteUrl: SITE }, []);
  assert.equal(readFileSync(join(mine, ".github/workflows/deploy.yml"), "utf-8"), "name: mine\n");
  assert.equal(action(mine), undefined, "no action for a workflow that does not call it");
});

// ---------------------------------------------------------------------------
// migrate-client
// ---------------------------------------------------------------------------

const wfInput = {
  worker: "mood-client",
  siteUrl: "https://mood.example.com",
  apiUrl: "https://mood.example.com",
  buildCommands: ["pnpm --filter @mood/client run build"],
  exportDir: "packages/client/out",
  nodeVersionFile: ".nvmrc",
};

await test("migrate-client: deploy-client records web once the Worker serves the commit", () => {
  if (!starterPresent) return console.log("    (starter not populated — skipped)");
  const { text } = rewriteWorkflowForWorkerClient(STARTER_WORKFLOW, wfInput);
  assertRecords(text, {
    job: "deploy-client",
    live: "Switch the client to this commit's Worker version",
    after: ["Verify the client is live"],
    record: "Record the web deploy",
    environment: "web",
    url: "${{ env.SITE_URL }}",
  });
  // Once: the Coolify deploy no longer makes the site live.
  assert.equal(text.split("uses: ./.github/actions/record-ship").length - 1, 1);
  const deploy = job(text, "deploy");
  assert.ok(!deploy.includes("record-ship"), "deploy job still records");
  assert.ok(!deploy.includes("deployments: write"), "deploy job keeps a scope it no longer uses");
  assert.match(deploy, /^ {6}packages: write$/m, "deploy job keeps packages: write");
  assert.match(job(text, "deploy-client"), /^ {4}if: needs\.deploy\.outputs\.server_deployed/m);
});

await test("migrate-client: an earlier rewrite moves the record to deploy-client", () => {
  if (!starterPresent) return console.log("    (starter not populated — skipped)");
  const now = rewriteWorkflowForWorkerClient(STARTER_WORKFLOW, wfInput).text;
  // Rewritten before deploy-client recorded anything.
  const noRecord = now
    .replace(/\n\n {6}# Leave a GitHub Deployment[\s\S]*?url: \$\{\{ env\.SITE_URL \}\}\n/, "\n")
    .replace(
      "    if: needs.deploy.outputs.server_deployed == 'true'\n    permissions:\n      contents: read\n      deployments: write\n",
      "    if: needs.deploy.outputs.server_deployed == 'true'\n",
    );
  assert.ok(!noRecord.includes("record-ship"), "fixture: no record");
  // Rewritten from a starter whose deploy job records the Coolify deploy
  // (2026-10-20, before this fix): that record stays in `deploy`, with
  // the web URL the rewrite blanks.
  const starterRecord = STARTER_WORKFLOW.slice(
    STARTER_WORKFLOW.indexOf("\n      # Leave a GitHub Deployment"),
  )
    .replace(/HATCHKIT_WEB_URL: .*/, 'HATCHKIT_WEB_URL: "" # client: checked by deploy-client')
    .replace(/\n+$/, "");
  const coolifyRecord = noRecord
    .replace(
      "      packages: write\n    steps:",
      "      packages: write\n      deployments: write\n    steps:",
    )
    .replace(
      "\n\n      - name: Record that the server half was deployed",
      `${starterRecord}\n\n      - name: Record that the server half was deployed`,
    );
  assert.equal(coolifyRecord.split("uses: ./.github/actions/record-ship").length - 1, 1, "fixture");
  for (const earlier of [noRecord, coolifyRecord]) {
    const { text, notes } = rewriteWorkflowForWorkerClient(earlier, wfInput);
    assert.equal(text, now, notes.join("; "));
    assert.ok(notes.includes("deploy-client: records the web deploy after the switch"));
  }
  assert.equal(rewriteWorkflowForWorkerClient(now, wfInput).text, now, "not idempotent");
});

await test("migrate-client: a workflow with no deploy-client keeps its own record", () => {
  if (!starterPresent) return console.log("    (starter not populated — skipped)");
  // A hand-made Workers deploy job (trackyourtime's) is not this rewrite's.
  assert.equal(moveWebRecordToClient(STARTER_WORKFLOW), STARTER_WORKFLOW);
});

await test("migrate-client: the rewrite passes actionlint with the action", () => {
  if (!starterPresent) return console.log("    (starter not populated — skipped)");
  const dir = scratch("mc");
  writeFile(
    dir,
    ".github/workflows/build-and-deploy.yml",
    rewriteWorkflowForWorkerClient(STARTER_WORKFLOW, wfInput).text,
  );
  writeFile(dir, RECORD_SHIP_ACTION_REL_PATH, recordShipActionSource());
  actionlint(dir);
});

// ---------------------------------------------------------------------------
// adopt
// ---------------------------------------------------------------------------

function adopt(dir: string): ReturnType<typeof scaffoldBuildPipeline> {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
  return scaffoldBuildPipeline({
    projectDir: dir,
    projectName: "demo",
    ghOwner: "acme",
    entrypoint: "dist/index.js",
    port: 3000,
    surfaces: "fullstack",
    domain: "demo.example.com",
    defaultBranch: "main",
  });
}

await test("adopt: the web deploy is recorded after the deploy is proven live", () => {
  const dir = scratch("adopt");
  const result = adopt(dir);
  const wf = readFileSync(join(dir, ".github/workflows/deploy.yml"), "utf-8");
  assertRecords(wf, {
    job: "deploy",
    live: "Deploy via signed Coolify webhook",
    after: ["Promote this commit's images to :live", "Verify the deployment is actually live"],
    record: "Record the web deploy",
    environment: "web",
    url: "${{ env.HATCHKIT_WEB_URL }}",
    // The promote step pushes the :live tag with this job's token.
    keeps: ["packages: write"],
  });
  // The link follows the literal the probe reads.
  assert.match(
    step(job(wf, "deploy"), "Record the web deploy"),
    /HATCHKIT_WEB_URL: https:\/\/demo\.example\.com\n/,
  );
  assert.equal(action(dir), recordShipActionSource());
  assert.ok(result.createdAbs.includes(join(dir, RECORD_SHIP_ACTION_REL_PATH)), "undo removes it");
  actionlint(dir);
});

await test("adopt: an action the repo already has is left alone", () => {
  const dir = scratch("adopt-own");
  writeFile(dir, RECORD_SHIP_ACTION_REL_PATH, "# mine\n");
  const result = adopt(dir);
  assert.equal(action(dir), "# mine\n");
  assert.ok(!result.written.includes(RECORD_SHIP_ACTION_REL_PATH));
});

// ---------------------------------------------------------------------------
// Signing workflows
// ---------------------------------------------------------------------------

function signing(platforms: Array<"windows" | "ios" | "android">): {
  dir: string;
  result: ReturnType<typeof writeSigningWorkflows>;
} {
  const dir = scratch("signing");
  const result = writeSigningWorkflows({
    projectDir: dir,
    platforms,
    bundleId: "com.example.tiao",
    appName: "Tiao",
    appSlug: "tiao",
    pnpmVersion: "10.33.2",
    nodeVersion: "24",
  });
  return { dir, result };
}

await test("signing: TestFlight and Google Play uploads are recorded under the upload's gate", () => {
  const { dir, result } = signing(["ios", "android"]);
  const read = (name: string): string =>
    readFileSync(join(dir, ".github/workflows", name), "utf-8");
  assertRecords(read("build-ios.yml"), {
    job: "build",
    live: "Upload to TestFlight",
    record: "Record the TestFlight upload",
    environment: "testflight",
  });
  assertRecords(read("build-android.yml"), {
    job: "build",
    live: "Upload to Play Console",
    record: "Record the Google Play upload",
    environment: "google-play",
    // The track the upload went to.
    branch: "${{ github.event.inputs.track || 'internal' }}",
  });
  assert.ok(
    read("build-android.yml").includes("track: ${{ github.event.inputs.track || 'internal' }}\n"),
    "the record's branch is the upload's track",
  );
  assert.ok(result.written.includes(RECORD_SHIP_ACTION_REL_PATH));
  assert.equal(action(dir), recordShipActionSource());
  actionlint(dir);
});

await test("signing: Windows alone writes no action", () => {
  const { dir, result } = signing(["windows"]);
  assert.equal(action(dir), undefined);
  assert.ok(!result.written.includes(RECORD_SHIP_ACTION_REL_PATH));
  assert.ok(!result.unchanged.includes(RECORD_SHIP_ACTION_REL_PATH));
});

for (const d of dirs) rmSync(d, { recursive: true, force: true });

const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  `\nrecord-ship: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`,
);
if (failed.length) process.exit(1);
