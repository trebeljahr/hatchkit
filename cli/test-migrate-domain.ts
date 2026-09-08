/**
 * `hatchkit migrate-domain` — plan tests.
 *
 * The executors talk to SES, Cloudflare, Coolify, Google and Stripe, so
 * they are covered by dry-runs against real projects. What is locked
 * down here is the part that decides WHAT to do, which is pure and
 * where every interesting bug lives:
 *
 *   1. `inferOldDomain` — the half-migrated case. A project whose
 *      manifest `domain` has already been rewritten to the target still
 *      has the old domain living inside `ses.identity` and the assets
 *      bucket's `publicUrl`. Getting this wrong means the command
 *      cheerfully reports "nothing to migrate" on exactly the project
 *      that needs migrating.
 *
 *   2. The `tracktime` fixture end to end. Its manifest is the real
 *      one, verbatim: domain already on `trackyourtime.dev`, SES
 *      identity and assets bucket still on `tracktime.trebeljahr.com`.
 *      That shape is the bar the design had to clear, so it is the
 *      shape the tests assert against.
 *
 *   3. Phase ordering, gates, and the plan → executor mapping. A
 *      planned action with no registered executor would make a run
 *      report success while the provider never moved — the single worst
 *      failure mode this command has.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  MIGRATION_PROVIDERS,
  type MigrationPlanInput,
  PHASE_ORDER,
  inferOldDomain,
  planDomainMigration,
  selectActions,
} from "./src/migrate/plan.js";
import { executorFor } from "./src/migrate/steps.js";
import type { ProjectManifest } from "./src/scaffold/manifest.js";

const failures: string[] = [];

function expect(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture — the real tracktime manifest, mid-migration.
// ---------------------------------------------------------------------------

const TRACKTIME = {
  version: 4,
  cliVersion: "0.2.17",
  scaffoldedAt: "2026-08-21T08:54:14.553Z",
  name: "tracktime",
  description: "A simple time tracker application",
  domain: "trackyourtime.dev",
  aliases: ["api.trackyourtime.dev"],
  features: ["websocket", "s3", "analytics", "desktop", "mobile"],
  mlServices: [],
  s3Provider: "r2",
  deployTarget: "existing",
  deploymentMode: "coolify",
  topology: "split",
  surfaces: "fullstack",
  publicService: "client",
  ports: { server: 5159, client: 6477, nativeHmr: 7130 },
  localDev: { slug: "tracktime", domain: "local.trebeljahr.com" },
  email: { transactional: "listmonk-ses", mailingList: "listmonk-ses" },
  ses: {
    identity: "mail.tracktime.trebeljahr.com",
    mailFromDomain: "bounce.mail.tracktime.trebeljahr.com",
    mailFromLabel: "bounce",
    mailFromBehaviorOnMxFailure: "UseDefaultValue",
  },
  s3Buckets: {
    assets: {
      name: "tracktime-assets",
      publicUrl: "https://assets.tracktime.trebeljahr.com",
      cors: {
        origins: ["http://localhost:5159", "http://localhost:6477", "https://trackyourtime.dev"],
        methods: ["GET", "HEAD"],
        maxAgeSeconds: 86400,
      },
    },
    tokenId: "defa5813b8a3798ae0f2882ba8bf684b",
    accountId: "236db6b7957ea3079844334856fc162e",
  },
} as unknown as ProjectManifest;

const ALL_CONFIGURED = Object.fromEntries(MIGRATION_PROVIDERS.map((p) => [p, true]));

function planFor(
  manifest: ProjectManifest,
  newDomain: string,
  overrides: Partial<MigrationPlanInput> = {},
) {
  const inferred = inferOldDomain(manifest, newDomain);
  return planDomainMigration({
    manifest,
    newDomain,
    oldDomain: inferred?.domain ?? manifest.domain,
    oldDomainSource: inferred?.source ?? "manifest.domain",
    configured: ALL_CONFIGURED,
    includeCleanup: true,
    ...overrides,
  });
}

const byId = (plan: ReturnType<typeof planFor>, id: string) => {
  const found = plan.actions.filter((a) => a.id === id);
  assert.ok(found.length > 0, `no action with id "${id}" in the plan`);
  return found;
};

// ---------------------------------------------------------------------------

console.log("inferOldDomain:");

expect("manifest.domain wins when it still differs from the target", () => {
  const m = { domain: "old.example.com" } as ProjectManifest;
  assert.deepEqual(inferOldDomain(m, "new.example.com"), {
    domain: "old.example.com",
    source: "manifest.domain",
  });
});

expect("recovers the old domain from ses.identity after a bare rename-domain", () => {
  // The tracktime case: rename-domain already rewrote the manifest, so
  // manifest.domain IS the target and only the SES identity remembers.
  assert.deepEqual(inferOldDomain(TRACKTIME, "trackyourtime.dev"), {
    domain: "tracktime.trebeljahr.com",
    source: "manifest.ses.identity",
  });
});

expect("falls through to the assets publicUrl when there is no SES identity", () => {
  const m = {
    domain: "new.example.com",
    s3Buckets: { assets: { name: "a", publicUrl: "https://assets.old.example.com" } },
  } as unknown as ProjectManifest;
  assert.deepEqual(inferOldDomain(m, "new.example.com"), {
    domain: "old.example.com",
    source: "manifest.s3Buckets.assets.publicUrl",
  });
});

expect("ignores a managed r2.dev URL — it carries no project domain", () => {
  const m = {
    domain: "new.example.com",
    s3Buckets: { assets: { name: "a", publicUrl: "https://pub-abc123.r2.dev" } },
  } as unknown as ProjectManifest;
  assert.equal(inferOldDomain(m, "new.example.com"), null);
});

expect("returns null once every recorded identity agrees with the target", () => {
  const m = {
    domain: "new.example.com",
    ses: { identity: "mail.new.example.com" },
    s3Buckets: { assets: { name: "a", publicUrl: "https://assets.new.example.com" } },
  } as unknown as ProjectManifest;
  assert.equal(inferOldDomain(m, "new.example.com"), null);
});

expect("is case-insensitive on both sides", () => {
  const m = { domain: "OLD.example.com" } as ProjectManifest;
  assert.deepEqual(inferOldDomain(m, "NEW.example.com"), {
    domain: "old.example.com",
    source: "manifest.domain",
  });
});

// ---------------------------------------------------------------------------

console.log("\ntracktime plan (the worked example):");

const plan = planFor(TRACKTIME, "trackyourtime.dev");

expect("reports the old domain it recovered, and where from", () => {
  assert.equal(plan.oldDomain, "tracktime.trebeljahr.com");
  assert.equal(plan.oldDomainSource, "manifest.ses.identity");
});

expect("local files are already rewritten — planned as a no-op, not re-run", () => {
  assert.equal(byId(plan, "files:rewrite")[0].kind, "noop");
});

expect("SES: create the new identity in prepare, switch in cutover, retire in cleanup", () => {
  const create = byId(plan, "ses:identity")[0];
  assert.equal(create.phase, "prepare");
  assert.equal(create.kind, "create");
  assert.match(create.summary, /mail\.trackyourtime\.dev/);
  assert.match(create.summary, /mail\.tracktime\.trebeljahr\.com/);

  const cutover = byId(plan, "ses:cutover")[0];
  assert.equal(cutover.phase, "cutover");
  assert.ok(cutover.gate, "the SES cutover must be gated on verification");

  const retire = byId(plan, "ses:retire")[0];
  assert.equal(retire.phase, "cleanup");
  assert.equal(retire.kind, "retire");
});

expect("R2: attach the new custom domain in prepare, move publicUrl in cutover", () => {
  const attach = byId(plan, "r2:custom-domain")[0];
  assert.equal(attach.phase, "prepare");
  assert.equal(attach.kind, "create");
  assert.match(attach.summary, /assets\.trackyourtime\.dev/);
  assert.match(attach.summary, /tracktime-assets/);

  const move = byId(plan, "r2:publicurl")[0];
  assert.equal(move.phase, "cutover");
  assert.ok(move.gate, "moving the assets URL must be gated on the certificate");

  assert.equal(byId(plan, "r2:retire")[0].phase, "cleanup");
});

expect("Listmonk from-address moves with the SES identity", () => {
  const from = byId(plan, "listmonk:from")[0];
  assert.equal(from.phase, "cutover");
  assert.equal(from.kind, "update");
  assert.match(from.summary, /noreply@mail\.trackyourtime\.dev/);
});

expect("Plausible is planned (project has the analytics feature)", () => {
  const rename = byId(plan, "plausible:rename")[0];
  assert.equal(rename.kind, "update");
  assert.equal(rename.phase, "cutover");
});

expect("Stripe is a no-op — tracktime has no stripe feature", () => {
  assert.equal(byId(plan, "stripe:webhook")[0].kind, "noop");
});

expect("Search Console is a no-op — no property recorded for this project", () => {
  assert.equal(byId(plan, "search-console:create")[0].kind, "noop");
});

expect("Coolify routing is a cutover step, not a prepare one", () => {
  // Coolify's Domain field is a replace, not an append: the old
  // hostname stops routing the moment it lands. Planning it as prepare
  // would break the site days before the rest of the migration.
  assert.equal(byId(plan, "coolify:sync")[0].phase, "cutover");
});

expect("DNS publish is additive, so it belongs in prepare", () => {
  assert.equal(byId(plan, "dns:publish")[0].phase, "prepare");
});

// ---------------------------------------------------------------------------

console.log("\nplan invariants:");

expect("actions are ordered prepare → cutover → cleanup", () => {
  const seen = plan.actions.map((a) => PHASE_ORDER.indexOf(a.phase));
  for (let i = 1; i < seen.length; i++) {
    assert.ok(
      seen[i] >= seen[i - 1],
      `action ${plan.actions[i].id} (${plan.actions[i].phase}) sorts before ${plan.actions[i - 1].id}`,
    );
  }
});

expect("action ids are unique", () => {
  const ids = plan.actions.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids.join(", ")}`);
});

expect("every executable action has a registered executor", () => {
  // The failure this prevents: a plan emits an id nothing implements,
  // the orchestrator skips it, and the run reports success while the
  // provider never moved.
  for (const phase of PHASE_ORDER) {
    for (const action of selectActions(plan, { phase })) {
      assert.doesNotThrow(() => executorFor(action.id), `no executor for ${action.id}`);
    }
  }
});

expect("selectActions drops no-ops and manual items", () => {
  for (const phase of PHASE_ORDER) {
    for (const action of selectActions(plan, { phase })) {
      assert.notEqual(action.kind, "noop");
      assert.notEqual(action.kind, "manual");
      assert.equal(action.phase, phase);
    }
  }
});

expect("--only narrows to one provider", () => {
  const only = selectActions(plan, { phase: "prepare", only: "ses" });
  assert.deepEqual(
    only.map((a) => a.id),
    ["ses:identity"],
  );
});

expect("cleanup is planned but never selected by the default phase", () => {
  const prepare = selectActions(plan, { phase: "prepare" });
  assert.ok(prepare.every((a) => a.kind !== "retire"), "prepare must never retire anything");
});

expect("every cutover action that can move mail or traffic carries a gate", () => {
  const gated = ["ses:cutover", "r2:publicurl", "listmonk:from"];
  for (const id of gated) {
    assert.ok(byId(plan, id)[0].gate, `${id} must carry a gate`);
  }
});

expect("the manual checklist names the zone, OAuth and the www rule", () => {
  const manual = plan.actions.filter((a) => a.kind === "manual").map((a) => a.id);
  for (const id of ["manual:zone", "manual:oauth", "manual:code", "manual:www"]) {
    assert.ok(manual.includes(id), `manual checklist is missing ${id}`);
  }
});

// ---------------------------------------------------------------------------

console.log("\ncredential gating:");

expect("an unconfigured provider downgrades to manual instead of vanishing", () => {
  const withoutSes = planFor(TRACKTIME, "trackyourtime.dev", {
    configured: { ...ALL_CONFIGURED, ses: false },
  });
  const create = byId(withoutSes, "ses:identity")[0];
  assert.equal(create.kind, "manual", "the row must stay in the plan, marked manual");
  assert.ok(
    (create.detail ?? []).some((d) => d.includes("hatchkit config add ses")),
    "and it must name the command that fixes it",
  );
  // ...and therefore never runs.
  assert.equal(selectActions(withoutSes, { phase: "prepare", only: "ses" }).length, 0);
});

// ---------------------------------------------------------------------------

console.log("\ngreenfield plan (nothing migrated yet):");

const greenfield = planFor({ ...TRACKTIME, domain: "tracktime.trebeljahr.com" }, "trackyourtime.dev");

expect("the file rewrite is planned when the manifest is still on the old domain", () => {
  const files = byId(greenfield, "files:rewrite")[0];
  assert.equal(files.kind, "update");
  assert.equal(files.phase, "prepare");
});

expect("old domain comes from manifest.domain when it hasn't been rewritten", () => {
  assert.equal(greenfield.oldDomainSource, "manifest.domain");
  assert.equal(greenfield.oldDomain, "tracktime.trebeljahr.com");
});

// ---------------------------------------------------------------------------

console.log("\nalready-migrated plan (idempotence):");

const settled = planFor(
  {
    ...TRACKTIME,
    ses: { ...TRACKTIME.ses, identity: "mail.trackyourtime.dev" },
    s3Buckets: {
      ...TRACKTIME.s3Buckets,
      assets: {
        ...TRACKTIME.s3Buckets?.assets,
        name: "tracktime-assets",
        publicUrl: "https://assets.trackyourtime.dev",
      },
    },
  } as ProjectManifest,
  "trackyourtime.dev",
);

expect("a fully-migrated project plans no SES or R2 work", () => {
  assert.equal(byId(settled, "ses:identity")[0].kind, "noop");
  assert.equal(byId(settled, "r2:custom-domain")[0].kind, "noop");
  assert.equal(selectActions(settled, { phase: "prepare", only: "ses" }).length, 0);
  assert.equal(selectActions(settled, { phase: "prepare", only: "r2" }).length, 0);
});

expect("...and neither does its cleanup phase", () => {
  assert.equal(selectActions(settled, { phase: "cleanup" }).length, 0);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll migrate-domain plan tests passed.");
