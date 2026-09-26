/**
 * Composition tests for the three server platform features.
 *
 * Each feature has its own test that applies it to a bare project. None of
 * those can see the thing that actually broke: what happens when all three
 * land on the SAME project. Two of them own a file a third patches —
 * `models/registry.ts` is shipped by `server-migrations` and appended to by
 * both siblings, and `services/scheduler/index.ts` is shipped by `scheduler`
 * and appended to by `public-api`. Diffing an extension point against its
 * pristine template reported a conflict on every later `hatchkit update`, and
 * `ScheduledJob` never reached the registry at all, so the unique index the
 * whole job claim rests on was checked by neither the boot nor `admin doctor`.
 *
 * So this file asserts the seam, against the REAL starter rather than a
 * fixture — a starter that drifts out from under the patch anchors should
 * fail here rather than in someone's scaffold.
 *
 * Run: pnpm --filter hatchkit test:server-platform
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SERVER_FEATURE_IDS, applyServerFeatures } from "./src/features/server-platform/index.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${msg}`);
}

const STARTER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "starter");

/** A project shaped like a real scaffold: the starter's own server package,
 *  its root package.json and its CLAUDE.md. */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "server-platform-"));
  mkdirSync(join(root, "packages"), { recursive: true });
  cpSync(join(STARTER_ROOT, "packages", "server"), join(root, "packages", "server"), {
    recursive: true,
  });
  cpSync(join(STARTER_ROOT, "package.json"), join(root, "package.json"));
  cpSync(join(STARTER_ROOT, "CLAUDE.md"), join(root, "CLAUDE.md"));
  return root;
}

const root = makeProject();
try {
  // Deliberately reversed: applyServerFeatures must impose registry order, so
  // whether public-api sees the registry depends on the registry and not on
  // the order a multiselect happened to return.
  const first = applyServerFeatures(["public-api", "scheduler", "server-migrations"], {
    projectDir: root,
    projectName: "combo-app",
  });

  assert(
    first.map((r) => r.id).join(",") === SERVER_FEATURE_IDS.join(","),
    "features apply in registry order regardless of the order asked for",
  );
  for (const result of first) {
    assert(!result.skipped, `${result.id} applied (not skipped)`);
    assert(result.written.length > 0, `${result.id} wrote files`);
    assert(
      result.conflicted.length === 0,
      `${result.id} reported no conflicts on a fresh project (got ${result.conflicted.join(", ")})`,
    );
  }

  // ── every reported path resolves from the repo root ────────────────
  // A conflict line the user cannot open is worse than no line. The three
  // features write through different base dirs, so this is the only place
  // the disagreement shows up.
  for (const result of first) {
    for (const path of [...result.written, ...result.patched]) {
      assert(
        existsSync(join(root, path)),
        `${result.id}: reported path ${path} resolves from the repo root`,
      );
    }
  }

  // ── the extension points carry every sibling's registration ────────
  const registry = readFileSync(join(root, "packages/server/src/models/registry.ts"), "utf-8");
  for (const model of [
    "Item",
    "Profile",
    "ScheduledJob",
    "ApiToken",
    "ApiMember",
    "WebhookSubscription",
    "WebhookDelivery",
  ]) {
    assert(
      registry.includes(`import "./${model}.js";`),
      `the model registry imports ${model} — a model missing from it gets no index check at boot and no mention from \`admin doctor\``,
    );
  }

  const schedulerIndex = readFileSync(
    join(root, "packages/server/src/services/scheduler/index.ts"),
    "utf-8",
  );
  assert(
    schedulerIndex.includes("registerWebhookSweepJob"),
    "public-api registered its sweeper with the scheduler rather than running a second loop",
  );

  // ── each feature's agent memory landed exactly once ────────────────
  const claudeMd = readFileSync(join(root, "CLAUDE.md"), "utf-8");
  for (const heading of [
    "### Migrations and indexes at boot",
    "### Background jobs (scheduler)",
    "### Public REST API and webhooks",
  ]) {
    assert(claudeMd.split(heading).length === 2, `CLAUDE.md carries ${heading} exactly once`);
  }

  // ── the boot sequence is ordered, not merely present ───────────────
  const bootSource = readFileSync(join(root, "packages/server/src/index.ts"), "utf-8");
  // Match on the opening paren, never `name()` — `startScheduler` is called
  // with an options object, and an indexOf that silently returns -1 orders
  // every later assertion against a call site that is not there.
  const at = (needle: string) => {
    const found = bootSource.indexOf(needle);
    assert(found !== -1, `src/index.ts calls ${needle}…)`);
    return found;
  };
  assert(
    at("await connectToDB();") < at("prepareDatabase("),
    "migrations run after the database connects",
  );
  assert(
    at("prepareDatabase(") < at("connectRedis("),
    "migrations run before Redis — a build that must not read this schema finds out first",
  );
  assert(
    at("prepareDatabase(") < at("startScheduler("),
    "the scheduler starts only after the schema has been prepared",
  );
  assert(
    at("startScheduler(") < at("server.listen("),
    "jobs are registered before the server accepts traffic",
  );

  // ── a second update changes nothing ────────────────────────────────
  const second = applyServerFeatures([...SERVER_FEATURE_IDS], {
    projectDir: root,
    projectName: "combo-app",
  });
  for (const result of second) {
    assert(result.written.length === 0, `${result.id}: second run wrote nothing`);
    assert(result.patched.length === 0, `${result.id}: second run patched nothing`);
    assert(
      result.conflicted.length === 0,
      `${result.id}: second run reported no conflict (got ${result.conflicted.join(", ")}) — ` +
        "an extension point a sibling appended to is doing its job, not drifting",
    );
  }

  // ── a project with no server declines all three ────────────────────
  const staticRoot = mkdtempSync(join(tmpdir(), "server-platform-static-"));
  try {
    for (const result of applyServerFeatures([...SERVER_FEATURE_IDS], {
      projectDir: staticRoot,
      projectName: "static-app",
    })) {
      assert(!!result.skipped, `${result.id} skips a project with no server package`);
      assert(result.written.length === 0, `${result.id} wrote nothing into a static project`);
    }
  } finally {
    rmSync(staticRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(
  failed > 0 ? `test-server-platform: ${failed} assertion(s) failed` : "test-server-platform: ok",
);
process.exit(failed > 0 ? 1 : 0);
