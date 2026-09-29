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
 *   4. The collection-of-beauty run (beauty.trebeljahr.com →
 *      collectionofbeauty.com, 2026-09-13), which found four bugs:
 *      prepare dropped the old origin from bucket CORS; the SES cutover
 *      claimed the from-address moved but left SES_FROM_EMAIL /
 *      LISTMONK_FROM on the old identity; cleanup was unreachable once
 *      cutover had moved every recorded field; and a refused keychain
 *      read surfaced as a bare "An unknown error occurred.".
 *
 *   5. The tracktime sender move (mail.tracktime.trebeljahr.com →
 *      mail.trackyourtime.dev, 2026-09-29), which found two gaps. The
 *      Listmonk step rewrote the GLOBAL `app.from_email` of a Listmonk
 *      every project shares (it named chemistry-sketcher at the time),
 *      under the slug "tracktime". And the new SES identity never got
 *      the old one's Bounce/Complaint SNS topics, so its bounces would
 *      never have reached Listmonk. Both executors sit behind ports, so
 *      these run against in-memory fakes.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as dotenvxParse, set as dotenvxSet } from "@dotenvx/dotenvx";
import keytar from "keytar";
import {
  type ProviderConfigReaders,
  detectConfigured,
  followUpDeferral,
  migrateCommand,
} from "./src/migrate/index.js";
import {
  MIGRATION_PROVIDERS,
  type MigrationPlanInput,
  PHASE_ORDER,
  inferOldDomain,
  planDomainMigration,
  selectActions,
} from "./src/migrate/plan.js";
import {
  envEntryIsEncrypted,
  readSesFromEnv,
  rewriteFromAddress,
  rewriteSesFromEnv,
} from "./src/migrate/ses-env.js";
import {
  type ListmonkSenderPort,
  carrySesFeedback,
  executorFor,
  moveListmonkDefaultSender,
  previousIdentities,
  transitionalCorsOrigins,
} from "./src/migrate/steps.js";
import { buildDesiredCors, resolveCorsExtras } from "./src/provision/s3-buckets.js";
import {
  type IdentityNotificationTopics,
  SES_FEEDBACK_TOPIC_NAME,
  type SesFeedbackAws,
  type SesFeedbackListmonk,
  type SesFeedbackType,
  type SnsSubscription,
} from "./src/provision/ses-feedback.js";
import type { ProjectManifest } from "./src/scaffold/manifest.js";
import { describeKeychainError, getSecret } from "./src/utils/secrets.js";

const failures: string[] = [];

async function expect(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
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
    tokenId: "00000000000000000000000000000000",
    accountId: "fixture-account",
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

await expect("manifest.domain wins when it still differs from the target", () => {
  const m = { domain: "old.example.com" } as ProjectManifest;
  assert.deepEqual(inferOldDomain(m, "new.example.com"), {
    domain: "old.example.com",
    source: "manifest.domain",
  });
});

await expect("recovers the old domain from ses.identity after a bare rename-domain", () => {
  // The tracktime case: rename-domain already rewrote the manifest, so
  // manifest.domain IS the target and only the SES identity remembers.
  assert.deepEqual(inferOldDomain(TRACKTIME, "trackyourtime.dev"), {
    domain: "tracktime.trebeljahr.com",
    source: "manifest.ses.identity",
  });
});

await expect("falls through to the assets publicUrl when there is no SES identity", () => {
  const m = {
    domain: "new.example.com",
    s3Buckets: { assets: { name: "a", publicUrl: "https://assets.old.example.com" } },
  } as unknown as ProjectManifest;
  assert.deepEqual(inferOldDomain(m, "new.example.com"), {
    domain: "old.example.com",
    source: "manifest.s3Buckets.assets.publicUrl",
  });
});

await expect("ignores a managed r2.dev URL — it carries no project domain", () => {
  const m = {
    domain: "new.example.com",
    s3Buckets: { assets: { name: "a", publicUrl: "https://pub-abc123.r2.dev" } },
  } as unknown as ProjectManifest;
  assert.equal(inferOldDomain(m, "new.example.com"), null);
});

await expect("returns null once every recorded identity agrees with the target", () => {
  const m = {
    domain: "new.example.com",
    ses: { identity: "mail.new.example.com" },
    s3Buckets: { assets: { name: "a", publicUrl: "https://assets.new.example.com" } },
  } as unknown as ProjectManifest;
  assert.equal(inferOldDomain(m, "new.example.com"), null);
});

await expect("is case-insensitive on both sides", () => {
  const m = { domain: "OLD.example.com" } as ProjectManifest;
  assert.deepEqual(inferOldDomain(m, "NEW.example.com"), {
    domain: "old.example.com",
    source: "manifest.domain",
  });
});

// ---------------------------------------------------------------------------

console.log("\ntracktime plan (the worked example):");

const plan = planFor(TRACKTIME, "trackyourtime.dev");

await expect("reports the old domain it recovered, and where from", () => {
  assert.equal(plan.oldDomain, "tracktime.trebeljahr.com");
  assert.equal(plan.oldDomainSource, "manifest.ses.identity");
});

await expect("local files are already rewritten — planned as a no-op, not re-run", () => {
  assert.equal(byId(plan, "files:rewrite")[0].kind, "noop");
});

await expect(
  "SES: create the new identity in prepare, switch in cutover, retire in cleanup",
  () => {
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
  },
);

await expect("R2: attach the new custom domain in prepare, move publicUrl in cutover", () => {
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

await expect("Listmonk's default sender moves only if it still names the old identity", () => {
  const from = byId(plan, "listmonk:from")[0];
  assert.equal(from.phase, "cutover");
  assert.equal(from.kind, "update");
  assert.match(from.summary, /only if it still sends from @mail\.tracktime\.trebeljahr\.com/);
  assert.match(from.summary, /@mail\.trackyourtime\.dev/);
  const detail = (from.detail ?? []).join("\n");
  assert.match(detail, /shared: one Listmonk serves every project/);
  assert.match(detail, /left alone/);
  assert.match(detail, /LISTMONK_FROM/);
  // The old detail claimed the move unconditionally.
  assert.doesNotMatch(detail, /only app\.from_email moves/);
});

await expect("SES prepare says it copies the old identity's notification topics", () => {
  const detail = (byId(plan, "ses:identity")[0].detail ?? []).join("\n");
  assert.match(detail, /copies mail\.tracktime\.trebeljahr\.com's Bounce \+ Complaint SNS topics/);
  assert.match(detail, /ses-feedback-listmonk/);
});

await expect("Plausible is planned (project has the analytics feature)", () => {
  const rename = byId(plan, "plausible:rename")[0];
  assert.equal(rename.kind, "update");
  assert.equal(rename.phase, "cutover");
});

await expect("Stripe is a no-op — tracktime has no stripe feature", () => {
  assert.equal(byId(plan, "stripe:webhook")[0].kind, "noop");
});

await expect("Search Console is a no-op — no property recorded for this project", () => {
  assert.equal(byId(plan, "search-console:create")[0].kind, "noop");
});

await expect("Coolify routing is a cutover step, not a prepare one", () => {
  // Coolify's Domain field is a replace, not an append: the old
  // hostname stops routing the moment it lands. Planning it as prepare
  // would break the site days before the rest of the migration.
  assert.equal(byId(plan, "coolify:sync")[0].phase, "cutover");
});

await expect("DNS publish is additive, so it belongs in prepare", () => {
  assert.equal(byId(plan, "dns:publish")[0].phase, "prepare");
});

// ---------------------------------------------------------------------------

console.log("\nplan invariants:");

await expect("actions are ordered prepare → cutover → cleanup", () => {
  const seen = plan.actions.map((a) => PHASE_ORDER.indexOf(a.phase));
  for (let i = 1; i < seen.length; i++) {
    assert.ok(
      seen[i] >= seen[i - 1],
      `action ${plan.actions[i].id} (${plan.actions[i].phase}) sorts before ${plan.actions[i - 1].id}`,
    );
  }
});

await expect("action ids are unique", () => {
  const ids = plan.actions.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids.join(", ")}`);
});

await expect("every executable action has a registered executor", () => {
  // The failure this prevents: a plan emits an id nothing implements,
  // the orchestrator skips it, and the run reports success while the
  // provider never moved.
  for (const phase of PHASE_ORDER) {
    for (const action of selectActions(plan, { phase })) {
      assert.doesNotThrow(() => executorFor(action.id), `no executor for ${action.id}`);
    }
  }
});

await expect("selectActions drops no-ops and manual items", () => {
  for (const phase of PHASE_ORDER) {
    for (const action of selectActions(plan, { phase })) {
      assert.notEqual(action.kind, "noop");
      assert.notEqual(action.kind, "manual");
      assert.equal(action.phase, phase);
    }
  }
});

await expect("--only narrows to one provider", () => {
  const only = selectActions(plan, { phase: "prepare", only: "ses" });
  assert.deepEqual(
    only.map((a) => a.id),
    ["ses:identity"],
  );
});

await expect("cleanup is planned but never selected by the default phase", () => {
  const prepare = selectActions(plan, { phase: "prepare" });
  assert.ok(
    prepare.every((a) => a.kind !== "retire"),
    "prepare must never retire anything",
  );
});

await expect("every cutover action that can move mail or traffic carries a gate", () => {
  const gated = ["ses:cutover", "r2:publicurl", "listmonk:from"];
  for (const id of gated) {
    assert.ok(byId(plan, id)[0].gate, `${id} must carry a gate`);
  }
});

await expect("the manual checklist names the zone, OAuth and the www rule", () => {
  const manual = plan.actions.filter((a) => a.kind === "manual").map((a) => a.id);
  for (const id of ["manual:zone", "manual:oauth", "manual:code", "manual:www"]) {
    assert.ok(manual.includes(id), `manual checklist is missing ${id}`);
  }
});

// ---------------------------------------------------------------------------

console.log("\ncredential gating:");

await expect("an unconfigured provider downgrades to manual instead of vanishing", () => {
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

const greenfield = planFor(
  { ...TRACKTIME, domain: "tracktime.trebeljahr.com" },
  "trackyourtime.dev",
);

await expect("the file rewrite is planned when the manifest is still on the old domain", () => {
  const files = byId(greenfield, "files:rewrite")[0];
  assert.equal(files.kind, "update");
  assert.equal(files.phase, "prepare");
});

await expect("old domain comes from manifest.domain when it hasn't been rewritten", () => {
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

await expect("a fully-migrated project plans no SES or R2 work", () => {
  assert.equal(byId(settled, "ses:identity")[0].kind, "noop");
  assert.equal(byId(settled, "r2:custom-domain")[0].kind, "noop");
  assert.equal(selectActions(settled, { phase: "prepare", only: "ses" }).length, 0);
  assert.equal(selectActions(settled, { phase: "prepare", only: "r2" }).length, 0);
});

await await expect(
  "...and, without --from, no cleanup either — nothing names the old domain",
  () => {
    assert.equal(settled.oldDomain, "trackyourtime.dev");
    assert.equal(selectActions(settled, { phase: "cleanup" }).length, 0);
  },
);

// ---------------------------------------------------------------------------

console.log("\ncleanup after cutover, with --from (collection-of-beauty bug 3):");

const COB_OLD = "beauty.trebeljahr.com";
const COB_NEW = "collectionofbeauty.com";

/** collection-of-beauty right after cutover: every recorded field is on
 *  the new domain, but prepare kept the old origin as a CORS extra. */
const COB_CUT_OVER = {
  ...TRACKTIME,
  name: "collection-of-beauty",
  domain: COB_NEW,
  aliases: [],
  ses: {
    identity: `mail.${COB_NEW}`,
    mailFromDomain: `bounce.mail.${COB_NEW}`,
    mailFromLabel: "bounce",
    mailFromBehaviorOnMxFailure: "UseDefaultValue",
  },
  s3Buckets: {
    ...TRACKTIME.s3Buckets,
    assets: {
      name: "collection-of-beauty-assets",
      publicUrl: `https://assets.${COB_NEW}`,
      cors: {
        origins: [
          "http://localhost:5159",
          "http://localhost:6477",
          `https://${COB_OLD}`,
          `https://${COB_NEW}`,
        ],
        methods: ["GET", "HEAD"],
        maxAgeSeconds: 86400,
        extraOrigins: [`https://${COB_OLD}`],
      },
    },
  },
} as unknown as ProjectManifest;

await expect("inference gives up once cutover has moved every field", () => {
  assert.equal(inferOldDomain(COB_CUT_OVER, COB_NEW), null);
});

const cobCleanup = planFor(COB_CUT_OVER, COB_NEW, {
  oldDomain: COB_OLD,
  oldDomainSource: "--from",
});

await expect("--from plans the SES, R2 and CORS retirements even though current == desired", () => {
  const ids = selectActions(cobCleanup, { phase: "cleanup" }).map((a) => a.id);
  assert.deepEqual([...ids].sort(), ["r2:cors-retire", "r2:retire", "ses:retire"]);
  assert.match(byId(cobCleanup, "ses:retire")[0].summary, /mail\.beauty\.trebeljahr\.com/);
  assert.match(byId(cobCleanup, "r2:retire")[0].summary, /assets\.beauty\.trebeljahr\.com/);
  assert.match(byId(cobCleanup, "r2:cors-retire")[0].summary, /https:\/\/beauty\.trebeljahr\.com/);
});

await expect("...and still plans nothing new in prepare", () => {
  assert.equal(selectActions(cobCleanup, { phase: "prepare", only: "ses" }).length, 0);
  assert.equal(selectActions(cobCleanup, { phase: "prepare", only: "r2" }).length, 0);
});

await expect("--from re-checks the env from-address in cutover, gated on SES verification", () => {
  const cutover = selectActions(cobCleanup, { phase: "cutover", only: "ses" });
  assert.deepEqual(
    cutover.map((a) => a.id),
    ["ses:cutover"],
  );
  assert.ok(cutover[0].gate, "rewriting the from-address must stay gated");
});

await expect("every action a --from cleanup plan selects has an executor", () => {
  for (const phase of PHASE_ORDER) {
    for (const action of selectActions(cobCleanup, { phase })) {
      assert.doesNotThrow(() => executorFor(action.id), `no executor for ${action.id}`);
    }
  }
});

await expect("CORS retire is a no-op once the recorded rule no longer lists the old origin", () => {
  const cleaned = planFor(
    {
      ...COB_CUT_OVER,
      s3Buckets: {
        ...COB_CUT_OVER.s3Buckets,
        assets: {
          ...COB_CUT_OVER.s3Buckets?.assets,
          name: "collection-of-beauty-assets",
          publicUrl: `https://assets.${COB_NEW}`,
          cors: { origins: [`https://${COB_NEW}`], methods: ["GET"], maxAgeSeconds: 1 },
        },
      },
    } as ProjectManifest,
    COB_NEW,
    { oldDomain: COB_OLD, oldDomainSource: "--from" },
  );
  assert.equal(byId(cleaned, "r2:cors-retire")[0].kind, "noop");
});

await expect("retry and next-phase commands carry --from, so they still work after cutover", () => {
  assert.equal(
    migrateCommand(cobCleanup, "cleanup", "ses"),
    `hatchkit migrate-domain --to ${COB_NEW} --from ${COB_OLD} --phase cleanup --only ses`,
  );
  assert.equal(
    migrateCommand(cobCleanup, "cutover"),
    `hatchkit migrate-domain --to ${COB_NEW} --from ${COB_OLD} --phase cutover`,
  );
});

// ---------------------------------------------------------------------------

console.log("\nbucket CORS keeps the old origin until cleanup (collection-of-beauty bug 1):");

await expect("migrate steps keep https://<old> as a transitional origin", () => {
  assert.deepEqual(transitionalCorsOrigins({ oldDomain: COB_OLD, newDomain: COB_NEW }), [
    `https://${COB_OLD}`,
  ]);
  assert.deepEqual(transitionalCorsOrigins({ oldDomain: COB_NEW, newDomain: COB_NEW }), []);
});

await expect("prepare: after the manifest rewrite, the desired rule has BOTH origins", () => {
  // What rename-domain's reconcile computes during prepare: the
  // manifest already says the new domain, and the migrate step passes
  // the old origin to keep.
  const renamed = { ...COB_CUT_OVER, s3Buckets: { assets: { name: "b" } } } as ProjectManifest;
  const extras = resolveCorsExtras([], {
    add: transitionalCorsOrigins({ oldDomain: COB_OLD, newDomain: COB_NEW }),
  });
  const { origins } = buildDesiredCors({ manifest: renamed, extras });
  assert.ok(origins.includes(`https://${COB_OLD}`), "the old live origin must survive prepare");
  assert.ok(origins.includes(`https://${COB_NEW}`));
  // ...and it is recorded, so a later plain reconcile keeps it too.
  assert.deepEqual(extras, [`https://${COB_OLD}`]);
});

await expect("cleanup: removing the transitional origin leaves user extras alone", () => {
  const recorded = [`https://${COB_OLD}/`, "https://staging.example.com"];
  assert.deepEqual(resolveCorsExtras(recorded, { remove: [`https://${COB_OLD.toUpperCase()}`] }), [
    "https://staging.example.com",
  ]);
});

await expect("adding an origin that is already recorded doesn't duplicate it", () => {
  assert.deepEqual(resolveCorsExtras([`https://${COB_OLD}`], { add: [`https://${COB_OLD}/`] }), [
    `https://${COB_OLD}`,
  ]);
});

// ---------------------------------------------------------------------------

console.log("\nSES from-address in the env files (collection-of-beauty bug 2):");

await expect("rewriteFromAddress swaps only the mail domain", () => {
  assert.equal(
    rewriteFromAddress(`noreply@mail.${COB_OLD}`, `mail.${COB_OLD}`, `mail.${COB_NEW}`),
    `noreply@mail.${COB_NEW}`,
  );
  assert.equal(
    rewriteFromAddress(
      `Collection of Beauty <hello@MAIL.${COB_OLD}>`,
      `mail.${COB_OLD}`,
      `mail.${COB_NEW}`,
    ),
    `Collection of Beauty <hello@mail.${COB_NEW}>`,
  );
});

await expect("rewriteFromAddress leaves values that don't send from the old identity", () => {
  assert.equal(
    rewriteFromAddress(`noreply@mail.${COB_NEW}`, `mail.${COB_OLD}`, `mail.${COB_NEW}`),
    null,
  );
  // A longer hostname that merely starts with the old identity is not it.
  assert.equal(
    rewriteFromAddress(`noreply@mail.${COB_OLD}.example`, `mail.${COB_OLD}`, `mail.${COB_NEW}`),
    null,
  );
});

await expect("envEntryIsEncrypted reads the line, not the value", () => {
  const text = 'SES_FROM_EMAIL="encrypted:BAbc"\nLISTMONK_FROM=plain <a@b.c>\n';
  assert.equal(envEntryIsEncrypted(text, "SES_FROM_EMAIL"), true);
  assert.equal(envEntryIsEncrypted(text, "LISTMONK_FROM"), false);
});

const savedPrivateKey = process.env.DOTENV_PRIVATE_KEY_PRODUCTION;
delete process.env.DOTENV_PRIVATE_KEY_PRODUCTION;
// A name no real keychain has a dotenvx key for, so "unreadable" is
// exercised by removing .env.keys alone.
const ENV_PROJECT = `hatchkit-test-migrate-${process.pid}`;

function seedEnvProject(): { dir: string; serverDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "hatchkit-migrate-env-"));
  const serverDir = join(dir, "packages", "server");
  mkdirSync(serverDir, { recursive: true });
  const prod = join(serverDir, ".env.production");
  writeFileSync(prod, "");
  dotenvxSet("SES_FROM_EMAIL", `noreply@mail.${COB_OLD}`, { path: prod, encrypt: true });
  dotenvxSet("LISTMONK_FROM", `Collection of Beauty <noreply@mail.${COB_OLD}>`, {
    path: prod,
    encrypt: true,
  });
  writeFileSync(
    join(serverDir, ".env.development"),
    `SES_FROM_EMAIL=noreply@mail.${COB_OLD}\nOTHER=untouched\n`,
  );
  return { dir, serverDir };
}

function decryptProd(serverDir: string): Record<string, string> {
  const keys = dotenvxParse(readFileSync(join(serverDir, ".env.keys"), "utf-8"), {
    processEnv: {},
  }) as Record<string, string>;
  return dotenvxParse(readFileSync(join(serverDir, ".env.production"), "utf-8"), {
    privateKey: keys.DOTENV_PRIVATE_KEY_PRODUCTION,
    processEnv: {},
  }) as Record<string, string>;
}

await expect(
  "cutover rewrites SES_FROM_EMAIL + LISTMONK_FROM and keeps each file's encryption",
  async () => {
    const { dir, serverDir } = seedEnvProject();
    try {
      const res = await rewriteSesFromEnv({
        projectDir: dir,
        projectName: ENV_PROJECT,
        prevIdentity: `mail.${COB_OLD}`,
        newIdentity: `mail.${COB_NEW}`,
        defaultsWhenUnreadable: false,
      });
      assert.equal(res.rewritten.length, 3, res.detail.join("\n"));

      const prodText = readFileSync(join(serverDir, ".env.production"), "utf-8");
      assert.ok(
        envEntryIsEncrypted(prodText, "SES_FROM_EMAIL"),
        ".env.production must stay encrypted",
      );
      assert.ok(envEntryIsEncrypted(prodText, "LISTMONK_FROM"));
      assert.ok(!prodText.includes(COB_NEW), "no plaintext address may land in .env.production");
      const prod = decryptProd(serverDir);
      assert.equal(prod.SES_FROM_EMAIL, `noreply@mail.${COB_NEW}`);
      assert.equal(prod.LISTMONK_FROM, `Collection of Beauty <noreply@mail.${COB_NEW}>`);

      const devText = readFileSync(join(serverDir, ".env.development"), "utf-8");
      assert.match(
        devText,
        new RegExp(`^SES_FROM_EMAIL="?noreply@mail\\.${COB_NEW.replace(".", "\\.")}"?$`, "m"),
      );
      assert.ok(
        !envEntryIsEncrypted(devText, "SES_FROM_EMAIL"),
        ".env.development must stay plain",
      );
      assert.match(devText, /^OTHER=untouched$/m);

      // Idempotent: a second pass finds nothing on the old identity.
      const again = await rewriteSesFromEnv({
        projectDir: dir,
        projectName: ENV_PROJECT,
        prevIdentity: `mail.${COB_OLD}`,
        newIdentity: `mail.${COB_NEW}`,
        defaultsWhenUnreadable: false,
      });
      assert.equal(again.rewritten.length, 0);
      const stillOld = (await readSesFromEnv(dir, ENV_PROJECT)).filter((e) =>
        e.value?.includes(`@mail.${COB_OLD}`),
      );
      assert.equal(stillOld.length, 0, "cleanup's guard must see nothing left on the old identity");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await expect(
  "without the private key: a re-run leaves ciphertext alone, a first cutover writes the default",
  async () => {
    const { dir, serverDir } = seedEnvProject();
    try {
      const keysPath = join(serverDir, ".env.keys");
      const keys = readFileSync(keysPath, "utf-8");
      rmSync(keysPath);
      const before = readFileSync(join(serverDir, ".env.production"), "utf-8");

      const rerun = await rewriteSesFromEnv({
        projectDir: dir,
        projectName: ENV_PROJECT,
        prevIdentity: `mail.${COB_OLD}`,
        newIdentity: `mail.${COB_NEW}`,
        defaultsWhenUnreadable: false,
      });
      assert.equal(rerun.unreadable.length, 2);
      assert.equal(readFileSync(join(serverDir, ".env.production"), "utf-8"), before);

      await rewriteSesFromEnv({
        projectDir: dir,
        projectName: ENV_PROJECT,
        prevIdentity: `mail.${COB_OLD}`,
        newIdentity: `mail.${COB_NEW}`,
        defaultsWhenUnreadable: true,
      });
      writeFileSync(keysPath, keys);
      const prodText = readFileSync(join(serverDir, ".env.production"), "utf-8");
      assert.ok(envEntryIsEncrypted(prodText, "SES_FROM_EMAIL"));
      const prod = decryptProd(serverDir);
      assert.equal(prod.SES_FROM_EMAIL, `noreply@mail.${COB_NEW}`);
      assert.equal(prod.LISTMONK_FROM, `${ENV_PROJECT} <noreply@mail.${COB_NEW}>`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

if (savedPrivateKey !== undefined) process.env.DOTENV_PRIVATE_KEY_PRODUCTION = savedPrivateKey;

// ---------------------------------------------------------------------------

console.log("\nkeychain failures name the secret (collection-of-beauty bug 4):");

await expect("describeKeychainError names the key and, on macOS, the signing/sandbox cause", () => {
  const err = describeKeychainError(
    "read",
    "s3:r2:admin-token",
    new Error("An unknown error occurred."),
    "darwin",
  );
  assert.match(err.message, /s3:r2:admin-token/);
  assert.match(err.message, /An unknown error occurred\./);
  assert.match(err.message, /ad-hoc/);
  assert.match(err.message, /Homebrew/);
  assert.match(err.message, /sandboxed/);
});

await expect("the macOS hint is not printed on other platforms", () => {
  const err = describeKeychainError("read", "k", new Error("boom"), "linux");
  assert.doesNotMatch(err.message, /Homebrew/);
});

await expect("getSecret wraps a keytar failure instead of rethrowing it bare", async () => {
  const original = keytar.getPassword;
  keytar.getPassword = async () => {
    throw new Error("An unknown error occurred.");
  };
  try {
    await assert.rejects(getSecret("s3:r2:admin-token"), (err: Error) => {
      assert.match(err.message, /Keychain read failed for secret "s3:r2:admin-token"/);
      assert.match(err.message, /An unknown error occurred\./);
      return true;
    });
  } finally {
    keytar.getPassword = original;
  }
});

console.log(
  "\ndetectConfigured resilience (client-only migration must not die on an unrelated credential):",
);

// A reader bag where everything is configured; individual tests override
// one or two entries. `truthy` stands in for "provider is configured".
const truthy = async () => ({}) as unknown;
const allConfigured = (): ProviderConfigReaders => ({
  dns: async () => ({ apiToken: "token" }),
  coolify: truthy,
  ses: truthy,
  listmonk: truthy,
  r2: truthy,
  plausible: truthy,
  searchConsole: truthy,
  stripe: truthy,
});

await expect(
  "a credential read that throws degrades to not-configured instead of aborting the whole plan",
  async () => {
    const readers = allConfigured();
    // The exact failure that used to take migrate-domain down on a
    // client-only project: one unreadable keychain secret, wrapped the
    // way getSecret wraps a native keytar error.
    readers.searchConsole = async () => {
      throw describeKeychainError(
        "read",
        "google-search-console:refresh-token",
        new Error("An unknown error occurred."),
      );
    };
    const configured = await detectConfigured(readers);
    assert.equal(
      configured["search-console"],
      false,
      "the provider whose read threw must read as not-configured",
    );
    // Every other provider is untouched — one failure does not poison the batch.
    assert.equal(configured.dns, true);
    assert.equal(configured.coolify, true);
    assert.equal(configured.ses, true);
    assert.equal(configured.stripe, true);
    assert.equal(configured.files, true);
  },
);

await expect(
  "every reader still throwing yields an all-false detection, never an exception",
  async () => {
    const boom = async (): Promise<never> => {
      throw new Error("An unknown error occurred.");
    };
    const configured = await detectConfigured({
      dns: boom,
      coolify: boom,
      ses: boom,
      listmonk: boom,
      r2: boom,
      plausible: boom,
      searchConsole: boom,
      stripe: boom,
    });
    for (const p of MIGRATION_PROVIDERS) {
      if (p === "files" || p === "manual" || p === "email-routing") continue;
      assert.equal(
        configured[p as keyof typeof configured],
        false,
        `${p} must read as not-configured when its read throws`,
      );
    }
    assert.equal(configured.files, true, "files is always available");
  },
);

await expect("detectConfigured maps each reader's truthiness independently", async () => {
  const yes = async () => ({}) as unknown;
  const no = async () => null;
  const configured = await detectConfigured({
    dns: async () => ({ apiToken: "token" }),
    coolify: no,
    ses: yes,
    listmonk: no,
    r2: yes,
    plausible: no,
    searchConsole: yes,
    stripe: no,
  });
  assert.equal(configured.dns, true);
  assert.equal(configured.coolify, false);
  assert.equal(configured.ses, true);
  assert.equal(configured.listmonk, false);
  assert.equal(configured.r2, true);
  assert.equal(configured.plausible, false);
  assert.equal(configured["search-console"], true);
  assert.equal(configured.stripe, false);
});

await expect("dns needs an apiToken, not merely a truthy config object", async () => {
  const readers = allConfigured();
  readers.dns = async () => ({}); // truthy, but no apiToken
  const configured = await detectConfigured(readers);
  assert.equal(configured.dns, false, "a DNS config without an apiToken is not usable");
});

// ---------------------------------------------------------------------------

console.log("\nListmonk's default sender on a shared instance (tracktime, gap 1):");

const OLD_ID = "mail.tracktime.trebeljahr.com";
const NEW_ID = "mail.trackyourtime.dev";

/** `app.from_email` in memory. `writes` logs every set. */
class FakeSender implements ListmonkSenderPort {
  writes: string[] = [];
  constructor(public value: string | null) {}
  async getFromEmail() {
    return this.value;
  }
  async setFromEmail(value: string) {
    this.writes.push(value);
    this.value = value;
  }
}

function moveSender(sender: FakeSender, verified = true) {
  let checks = 0;
  const outcome = moveListmonkDefaultSender({
    listmonk: sender,
    oldIdentities: [OLD_ID],
    newIdentity: NEW_ID,
    isVerified: async () => {
      checks += 1;
      return verified;
    },
  });
  return outcome.then((o) => ({ outcome: o, checks }));
}

await expect("another project's default sender is left alone, SES not even asked", async () => {
  // The state on 2026-09-29: the shared Listmonk's sender was
  // chemistry-sketcher's.
  const sender = new FakeSender("Chemistry Sketcher <noreply@mail.chemistry-sketcher.com>");
  const { outcome, checks } = await moveSender(sender);
  assert.equal(outcome.status, "skipped");
  assert.match(outcome.message, /not this project's old identity, left alone/);
  assert.deepEqual(sender.writes, [], "no write to the shared setting");
  assert.equal(checks, 0);
});

await expect("a sender on the old identity moves, display name and local part kept", async () => {
  const sender = new FakeSender(`Track Your Time <hello@${OLD_ID}>`);
  const { outcome } = await moveSender(sender);
  assert.equal(outcome.status, "done");
  assert.deepEqual(sender.writes, [`Track Your Time <hello@${NEW_ID}>`]);
  assert.doesNotMatch(sender.value ?? "", /tracktime </, "never the project slug as display name");
});

await expect("the move waits for SES to verify the new identity", async () => {
  const sender = new FakeSender(`Track Your Time <noreply@${OLD_ID}>`);
  const { outcome, checks } = await moveSender(sender, false);
  assert.equal(outcome.status, "gated");
  assert.equal(checks, 1);
  assert.deepEqual(sender.writes, []);
});

await expect("already on the new identity, or unset: nothing to do", async () => {
  const moved = new FakeSender(`Track Your Time <noreply@${NEW_ID}>`);
  assert.equal((await moveSender(moved)).outcome.status, "skipped");
  const unset = new FakeSender(null);
  assert.equal((await moveSender(unset)).outcome.status, "skipped");
  assert.deepEqual([...moved.writes, ...unset.writes], []);
});

await expect("a look-alike domain is not the old identity", async () => {
  const sender = new FakeSender(`x <noreply@${OLD_ID}.example.com>`);
  assert.equal((await moveSender(sender)).outcome.status, "skipped");
  assert.deepEqual(sender.writes, []);
});

await expect(
  "previousIdentities: the recorded identity, then the --from one, never the new",
  () => {
    const ctx = { oldDomain: "tracktime.trebeljahr.com", newDomain: "trackyourtime.dev" };
    assert.deepEqual(previousIdentities(TRACKTIME, ctx), [OLD_ID]);
    // After the SES cutover moved the manifest, only --from names it.
    const cutOver = { ses: { identity: NEW_ID } } as ProjectManifest;
    assert.deepEqual(previousIdentities(cutOver, ctx), [OLD_ID]);
    // A hand-picked identity comes first.
    const custom = { ses: { identity: "mail.custom.example" } } as ProjectManifest;
    assert.deepEqual(previousIdentities(custom, ctx), ["mail.custom.example", OLD_ID]);
    assert.deepEqual(
      previousIdentities(cutOver, {
        oldDomain: "trackyourtime.dev",
        newDomain: "trackyourtime.dev",
      }),
      [],
    );
  },
);

await expect("after the SES cutover, a --from run still plans the Listmonk check", () => {
  // A failed listmonk:from must be retryable once ses:cutover has
  // already moved manifest.ses.identity.
  const cutOver = planFor(
    { ...TRACKTIME, ses: { ...TRACKTIME.ses, identity: NEW_ID } } as ProjectManifest,
    "trackyourtime.dev",
    { oldDomain: "tracktime.trebeljahr.com", oldDomainSource: "--from" },
  );
  const from = byId(cutOver, "listmonk:from")[0];
  assert.equal(from.kind, "update");
  assert.match(from.summary, /@mail\.tracktime\.trebeljahr\.com/);
  // Without --from there is no old identity to look for.
  assert.equal(byId(settled, "listmonk:from")[0].kind, "noop");
});

// ---------------------------------------------------------------------------

console.log("\nSES notification topics follow the identity (tracktime, gap 2):");

const REGION = "eu-west-1";
const SHARED_ARN = `arn:aws:sns:${REGION}:111122223333:${SES_FEEDBACK_TOPIC_NAME}`;
const CUSTOM_ARN = `arn:aws:sns:${REGION}:111122223333:tracktime-bounces`;
const WEBHOOK = "https://listmonk.example.com/webhooks/service/ses";

function deniedError(action: string): Error {
  const err = new Error(`User is not authorized to perform: ${action}`);
  err.name = "AccessDenied";
  return err;
}

/** One AWS account's SES identities + SNS topics. `writes` logs every
 *  mutating call; `denied` names methods that fail on IAM. */
class FakeFeedbackAws implements SesFeedbackAws {
  identities = new Map<string, IdentityNotificationTopics>();
  topics = new Map<string, SnsSubscription[]>();
  suppressed = ["BOUNCE", "COMPLAINT"];
  writes: string[] = [];
  denied = new Set<keyof SesFeedbackAws>();

  constructor() {
    this.topics.set(SHARED_ARN, [
      { subscriptionArn: `${SHARED_ARN}:sub-1`, protocol: "https", endpoint: WEBHOOK },
    ]);
  }
  identity(name: string, bounceTopic: string | null = null, complaintTopic = bounceTopic) {
    this.identities.set(name, { bounceTopic, complaintTopic });
    return this;
  }
  private guard(method: keyof SesFeedbackAws) {
    if (this.denied.has(method)) throw deniedError(method);
  }
  async createTopic(name: string) {
    this.guard("createTopic");
    this.writes.push(`createTopic ${name}`);
    const arn = `arn:aws:sns:${REGION}:111122223333:${name}`;
    if (!this.topics.has(arn)) this.topics.set(arn, []);
    return arn;
  }
  async listSubscriptions(topicArn: string) {
    const subs = this.topics.get(topicArn);
    if (!subs) {
      const err = new Error("Topic does not exist");
      err.name = "NotFound";
      throw err;
    }
    return subs;
  }
  async subscribe(topicArn: string, protocol: "http" | "https", endpoint: string) {
    this.writes.push(`subscribe ${endpoint}`);
    this.topics.get(topicArn)?.push({ subscriptionArn: `${topicArn}:sub-2`, protocol, endpoint });
  }
  async getNotificationTopics(names: string[]) {
    this.guard("getNotificationTopics");
    const out = new Map<string, IdentityNotificationTopics>();
    for (const n of names) {
      const t = this.identities.get(n);
      if (t) out.set(n, { ...t });
    }
    return out;
  }
  async setNotificationTopic(identity: string, type: SesFeedbackType, topicArn: string | null) {
    this.guard("setNotificationTopic");
    this.writes.push(`set ${identity} ${type} ${topicArn}`);
    const t = this.identities.get(identity);
    if (!t) throw new Error(`Identity ${identity} does not exist`);
    if (type === "Bounce") t.bounceTopic = topicArn;
    else t.complaintTopic = topicArn;
  }
  async getSuppressedReasons() {
    return [...this.suppressed];
  }
  async putSuppressedReasons(reasons: string[]) {
    this.writes.push(`suppress ${reasons.join(",")}`);
    this.suppressed = reasons;
  }
  async listVerifiedIdentities() {
    return [...this.identities.keys()];
  }
}

/** A Listmonk with bounce processing already on. */
const healthyListmonk = (): SesFeedbackListmonk => ({
  async getSettings() {
    return { "bounce.enabled": true, "bounce.webhooks_enabled": true, "bounce.ses_enabled": true };
  },
  async putSetting(key) {
    throw new Error(`unexpected Listmonk write ${key}`);
  },
});

function carry(aws: FakeFeedbackAws, opts: { listmonk?: boolean; old?: string | null } = {}) {
  return carrySesFeedback({
    aws,
    region: REGION,
    oldIdentity: opts.old === undefined ? OLD_ID : opts.old,
    newIdentity: NEW_ID,
    listmonk:
      opts.listmonk === false
        ? null
        : { url: "https://listmonk.example.com", port: healthyListmonk() },
    confirmTimeoutMs: 0,
  });
}

const setCommand = (type: SesFeedbackType, arn: string) =>
  `aws ses set-identity-notification-topic --identity ${NEW_ID} --notification-type ${type} --sns-topic ${arn} --region ${REGION}`;

await expect(
  "the new identity gets the old identity's topics; a re-run writes nothing",
  async () => {
    const aws = new FakeFeedbackAws().identity(OLD_ID, SHARED_ARN).identity(NEW_ID);
    const first = await carry(aws);
    assert.deepEqual(aws.identities.get(NEW_ID), {
      bounceTopic: SHARED_ARN,
      complaintTopic: SHARED_ARN,
    });
    assert.deepEqual(aws.writes, [
      `set ${NEW_ID} Bounce ${SHARED_ARN}`,
      `set ${NEW_ID} Complaint ${SHARED_ARN}`,
    ]);
    assert.equal(first.changed, true);
    assert.equal(first.followUp, undefined);
    assert.ok(first.detail.some((d) => d.includes(`copied from ${OLD_ID}`)));

    aws.writes = [];
    const second = await carry(aws);
    assert.deepEqual(aws.writes, [], "healthy re-run: no CreateTopic, no set, no subscribe");
    assert.equal(second.changed, false);
  },
);

await expect("a topic set by hand on the old identity is copied as is", async () => {
  // Old identity: Bounce to a custom topic, Complaint nowhere.
  const aws = new FakeFeedbackAws().identity(OLD_ID, CUSTOM_ARN, null).identity(NEW_ID);
  const r = await carry(aws);
  assert.equal(aws.identities.get(NEW_ID)?.bounceTopic, CUSTOM_ARN, "copied, not replaced");
  assert.equal(
    aws.identities.get(NEW_ID)?.complaintTopic,
    SHARED_ARN,
    "the type the old one didn't route goes to the shared topic",
  );
  assert.equal(r.followUp, undefined);
});

await expect("without Listmonk configured, the copy still happens", async () => {
  const aws = new FakeFeedbackAws().identity(OLD_ID, SHARED_ARN).identity(NEW_ID);
  const r = await carry(aws, { listmonk: false });
  assert.equal(aws.identities.get(NEW_ID)?.complaintTopic, SHARED_ARN);
  assert.ok(!r.detail.some((d) => /Listmonk is not configured/.test(d)), "nothing left unset");

  const bare = new FakeFeedbackAws().identity(OLD_ID).identity(NEW_ID);
  const unrouted = await carry(bare, { listmonk: false });
  assert.ok(
    unrouted.detail.some((d) => /routes no Bounce or Complaint notifications/.test(d)),
    unrouted.detail.join("\n"),
  );
});

await expect("a topic already on the new identity is reported and left alone", async () => {
  const aws = new FakeFeedbackAws().identity(OLD_ID, SHARED_ARN).identity(NEW_ID, CUSTOM_ARN, null);
  const r = await carry(aws, { listmonk: false });
  assert.equal(aws.identities.get(NEW_ID)?.bounceTopic, CUSTOM_ARN);
  assert.equal(aws.identities.get(NEW_ID)?.complaintTopic, SHARED_ARN);
  assert.ok(r.detail.some((d) => d.includes("Left unchanged")));
});

await expect("an old identity SES no longer knows: the shared topic fills both", async () => {
  const aws = new FakeFeedbackAws().identity(NEW_ID);
  const r = await carry(aws);
  assert.deepEqual(aws.identities.get(NEW_ID), {
    bounceTopic: SHARED_ARN,
    complaintTopic: SHARED_ARN,
  });
  assert.ok(r.detail.some((d) => d.includes("no topics to copy")));
});

await expect(
  "IAM refuses the write: the exact aws commands, once per type, as a follow-up",
  async () => {
    const aws = new FakeFeedbackAws().identity(OLD_ID, SHARED_ARN).identity(NEW_ID);
    aws.denied.add("setNotificationTopic");
    const r = await carry(aws);
    assert.ok(r.followUp, "a refused write is a follow-up, not a thrown step");
    // Copy and ensure both wanted these; each command appears once.
    assert.deepEqual(r.followUp.commands, [
      setCommand("Bounce", SHARED_ARN),
      setCommand("Complaint", SHARED_ARN),
    ]);
    assert.match(r.followUp.reason, /ses:SetIdentityNotificationTopic/);
    assert.ok(
      !r.detail.some((d) => d.includes("aws ses set-identity-notification-topic")),
      "the commands are not repeated in the detail lines",
    );
  },
);

await expect("with a hand-set topic, the command carries the old identity's ARN", async () => {
  const aws = new FakeFeedbackAws().identity(OLD_ID, CUSTOM_ARN).identity(NEW_ID);
  aws.denied.add("setNotificationTopic");
  const r = await carry(aws);
  assert.deepEqual(r.followUp?.commands, [
    setCommand("Bounce", CUSTOM_ARN),
    setCommand("Complaint", CUSTOM_ARN),
  ]);
});

await expect("IAM refuses the read too, no Listmonk: read the old topics first", async () => {
  const aws = new FakeFeedbackAws().identity(OLD_ID, SHARED_ARN).identity(NEW_ID);
  aws.denied.add("getNotificationTopics");
  const r = await carry(aws, { listmonk: false });
  assert.deepEqual(r.followUp?.commands, [
    `aws ses get-identity-notification-attributes --identities ${OLD_ID} --region ${REGION}`,
  ]);
  assert.match(r.followUp?.reason ?? "", /same Bounce and Complaint topic ARNs/);
});

await expect("the follow-up is recorded as its own deferral with the commands", () => {
  const action = byId(plan, "ses:identity")[0];
  const step = followUpDeferral(action, plan, {
    reason: "IAM",
    commands: [setCommand("Bounce", SHARED_ARN), setCommand("Complaint", SHARED_ARN)],
  });
  assert.equal(step.key, "migrate:ses:identity:follow-up");
  assert.equal(
    step.command,
    `${setCommand("Bounce", SHARED_ARN)} && ${setCommand("Complaint", SHARED_ARN)}`,
  );
  assert.match(
    (step.hint ?? []).join("\n"),
    /hatchkit migrate-domain --to trackyourtime\.dev --from tracktime\.trebeljahr\.com --phase prepare --only ses/,
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll migrate-domain plan tests passed.");
