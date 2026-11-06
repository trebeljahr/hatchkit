/**
 * The base-refresh workflow template (templates/base-refresh/base-refresh.yml)
 * is what the backup host's image-rebuilds runner dispatches. The host trusts
 * it to keep a contract it cannot check from outside, so the contract is
 * pinned here:
 *
 *   · it rebuilds the LIVE commit, never the dispatching ref's HEAD;
 *   · with a re-pulled base image and no layer cache;
 *   · under a new tag, never rewriting `:<sha>` or `:main`;
 *   · tests run before any image is built or promoted;
 *   · the previous `:live` digests are recorded before promotion and
 *     restored on failure, and a restore always fails the run;
 *   · it never restores on cancellation (a push that supersedes it promotes
 *     its own images) and it never cancels a running deploy.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

type Step = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};
type Job = { needs?: string[]; steps: Step[]; permissions?: Record<string, string> };

const text = readFileSync(
  new URL("./src/templates/base-refresh/base-refresh.yml", import.meta.url),
  "utf8",
);
const wf = parse(text) as {
  on: Record<string, unknown>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};

// Only a dispatch starts it; it joins the push pipeline's group without cancelling it.
assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"]);
assert.equal(wf.concurrency.group, "main-deploy");
assert.equal(wf.concurrency["cancel-in-progress"], false);
assert.deepEqual(wf.permissions, { contents: "read" });

const { live, test, build, deploy } = wf.jobs;
assert.ok(live && test && build && deploy);
assert.deepEqual(test.needs, ["live"]);
assert.deepEqual(build.needs, ["live", "test"]);
assert.deepEqual(deploy.needs, ["live", "build"]);

// Every checkout is the live commit.
for (const job of [test, build]) {
  const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout"))!;
  assert.equal(checkout.with?.ref, "${{ needs.live.outputs.sha }}");
}
assert.match(live.steps[0].run!, /\/api\/health/);
assert.match(live.steps[0].run!, /\^\[0-9a-f\]\{40\}\$/);

// Fresh base, no cache, a new tag only.
const push = build.steps.find((s) => s.uses?.startsWith("docker/build-push-action"))!;
assert.equal(push.with?.pull, true);
assert.equal(push.with?.["no-cache"], true);
assert.match(String(push.with?.["build-args"]), /BUILD_ID=\$\{\{ github\.run_id \}\}/);
const tags = String(push.with?.tags).trim().split("\n");
assert.equal(tags.length, 1);
assert.match(tags[0], /:\$\{\{ needs\.live\.outputs\.sha \}\}-base-\$\{\{ github\.run_id \}\}$/);
assert.doesNotMatch(text, /-server:main|:\$\{\{ github\.sha \}\}/);

// Record, promote, deploy, verify, restore — in that order.
const names = deploy.steps.map((s) => s.name);
const at = (name: string): number => {
  const index = names.indexOf(name);
  assert.ok(index >= 0, name);
  return index;
};
const record = at("Record the images :live points at now");
const promote = at("Promote the rebuilt images to :live");
const verify = at("Verify the rebuilt images serve");
const restore = at("Restore the previous images");
assert.ok(record < promote && promote < verify && verify < restore);
assert.equal(deploy.steps[record].id, "previous");
assert.match(deploy.steps[record].run!, /no rollback target, so nothing is promoted/);
assert.equal(deploy.steps[restore].if, "failure() && steps.previous.outcome == 'success'");
assert.match(
  deploy.steps[restore].run!,
  /imagetools create --tag "\$image:live" "\$image@\$digest"/,
);
assert.match(deploy.steps[restore].run!, /exit 1\s*$/);
assert.match(deploy.steps[verify].run!, /wait_for_server new/);
assert.doesNotMatch(text, /cancelled\(\)|always\(\)/);

// No Coolify API token anywhere: signed per-app webhooks only.
assert.doesNotMatch(text, /COOLIFY_API_TOKEN/);
assert.match(text, /X-Hub-Signature-256/);

console.log("Base-refresh workflow contract passed.");
