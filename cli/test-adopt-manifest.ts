/**
 * `hatchkit adopt --resume` must MERGE over the existing manifest, not
 * rebuild it from the adopt plan.
 *
 * The regression this guards: `writeAdoptManifest` constructed a fresh
 * `ProjectManifest` from the plan alone. Running `adopt --resume` on a
 * project that `hatchkit create` had scaffolded therefore silently
 * destroyed real state — every assertion below failed before the fix:
 *
 *   · `ports` overwritten with a hardcoded {server:3000, client:3001},
 *     losing tracktime's {5159, 6477, 7130} — the ports its Dockerfiles
 *     EXPOSE, its compose pins, and its local-dev bridge routes to.
 *   · the whole `ses` block dropped: identity, MAIL FROM domain, and
 *     the record-by-record list of DNS rows hatchkit manages. Without
 *     it `email ses-mail-from remove` can't tell hatchkit's rows from
 *     the user's any more.
 *   · `localDev` dropped, orphaning the project's Caddy fragment.
 *   · `s3Provider` flipped "r2" → "existing", because adopt infers it
 *     from feature flags and can't see the provisioned R2 buckets.
 *
 * The fixture is a faithful copy of tracktime's real .hatchkit.json.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AdoptPlan, type DetectedState, buildAdoptManifest } from "./src/adopt.js";
import { MANIFEST_VERSION, type ProjectManifest } from "./src/scaffold/manifest.js";

const failures: string[] = [];

function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

/** tracktime's real manifest, as `hatchkit create` wrote it. */
const CREATE_SCAFFOLDED: ProjectManifest = {
  version: MANIFEST_VERSION,
  cliVersion: "0.2.17",
  scaffoldedAt: "2026-08-21T08:54:14.553Z",
  name: "tracktime",
  description: "A simple time tracker application",
  domain: "tracktime.trebeljahr.com",
  features: ["websocket", "s3", "analytics", "desktop", "mobile"],
  mlServices: [],
  s3Provider: "r2",
  deployTarget: "existing",
  deploymentMode: "coolify",
  surfaces: "fullstack",
  publicService: "client",
  topology: "single-origin",
  ports: { server: 5159, client: 6477, nativeHmr: 7130 },
  localDev: { slug: "tracktime", domain: "local.trebeljahr.com" },
  email: { transactional: "listmonk-ses", mailingList: "listmonk-ses" },
  ses: {
    identity: "mail.tracktime.trebeljahr.com",
    mailFromDomain: "bounce.mail.tracktime.trebeljahr.com",
    mailFromLabel: "bounce",
    mailFromBehaviorOnMxFailure: "UseDefaultValue",
    mailFromManagedDnsRecords: [
      {
        type: "MX",
        name: "bounce.mail.tracktime.trebeljahr.com",
        value: "feedback-smtp.eu-west-1.amazonses.com",
        priority: 10,
      },
      {
        type: "TXT",
        name: "bounce.mail.tracktime.trebeljahr.com",
        value: "v=spf1 include:amazonses.com ~all",
      },
    ],
  },
  s3Buckets: {
    assets: { name: "tracktime-assets", publicUrl: "https://assets.example.com" },
    accountId: "acct-123",
  },
};

/** What adopt's stepper produces for that project. Note the fields that
 *  differ from the manifest — those are the ones adopt legitimately
 *  owns and must win on. */
const PLAN: AdoptPlan = {
  name: "tracktime",
  domain: "tracktime.trebeljahr.com",
  description: "A simple time tracker application",
  features: ["websocket", "s3", "analytics", "desktop", "mobile"],
  surfaces: "fullstack",
  deploymentMode: "coolify",
  bootstrapDotenvx: true,
  setupGitHub: false,
  wireCoolify: true,
  isPrivate: true,
  appPort: "3000",
  scaffoldBuildPipeline: true,
  email: { transactional: "listmonk-ses", mailingList: "listmonk-ses" },
} as AdoptPlan;

function stateWith(existing: ProjectManifest | undefined, projectDir: string): DetectedState {
  return { projectDir, existingManifest: existing } as DetectedState;
}

// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "hatchkit-adopt-manifest-"));
try {
  // A compose file so topology inference has something to read.
  writeFileSync(
    join(dir, "docker-compose.yml"),
    "services:\n  server:\n    image: a\n  client:\n    image: b\n  mongo:\n    image: mongo:7\n",
    "utf-8",
  );

  const merged = buildAdoptManifest(PLAN, stateWith(CREATE_SCAFFOLDED, dir), "0.2.19");

  check("preserves ports (was clobbered with a hardcoded 3000/3001)", () => {
    assert.deepEqual(merged.ports, { server: 5159, client: 6477, nativeHmr: 7130 });
  });

  check("preserves the entire ses block including managed DNS records", () => {
    assert.deepEqual(merged.ses, CREATE_SCAFFOLDED.ses);
  });

  check("preserves localDev", () => {
    assert.deepEqual(merged.localDev, { slug: "tracktime", domain: "local.trebeljahr.com" });
  });

  check('preserves s3Provider "r2" (was downgraded to "existing")', () => {
    assert.equal(merged.s3Provider, "r2");
  });

  check("preserves s3Buckets, deploymentMode and publicService", () => {
    assert.deepEqual(merged.s3Buckets, CREATE_SCAFFOLDED.s3Buckets);
    assert.equal(merged.deploymentMode, "coolify");
    assert.equal(merged.publicService, "client");
  });

  check("preserves topology and the original scaffoldedAt", () => {
    assert.equal(merged.topology, "single-origin");
    assert.equal(merged.scaffoldedAt, "2026-08-21T08:54:14.553Z");
  });

  check("adopt still owns name / domain / surfaces / features / cliVersion", () => {
    const renamed = buildAdoptManifest(
      { ...PLAN, domain: "new.example.com", surfaces: "backend", features: ["websocket"] },
      stateWith(CREATE_SCAFFOLDED, dir),
      "0.2.19",
    );
    assert.equal(renamed.domain, "new.example.com");
    assert.equal(renamed.surfaces, "backend");
    assert.deepEqual(renamed.features, ["websocket"]);
    assert.equal(renamed.cliVersion, "0.2.19");
    assert.equal(renamed.version, MANIFEST_VERSION);
  });

  check("an empty stepper description doesn't blank out an existing one", () => {
    const noDesc = buildAdoptManifest(
      { ...PLAN, description: "" },
      stateWith(CREATE_SCAFFOLDED, dir),
      "0.2.19",
    );
    assert.equal(noDesc.description, "A simple time tracker application");
  });

  check("a first-time adopt (no existing manifest) still gets sane defaults", () => {
    const fresh = buildAdoptManifest(PLAN, stateWith(undefined, dir), "0.2.19");
    assert.deepEqual(fresh.ports, { server: 3000, client: 3001 });
    assert.equal(fresh.s3Provider, "existing", "s3 feature is on, but no provider is known");
    assert.equal(fresh.topology, "single-origin");
    assert.equal(fresh.ses, undefined, "absent stays absent rather than becoming null");
    assert.equal(fresh.localDev, undefined);
    assert.ok(fresh.scaffoldedAt, "a fresh adopt stamps a timestamp");
  });

  check("no field is silently dropped relative to the input manifest", () => {
    // Catches the general shape of the bug rather than the specific
    // fields: any key present on the existing manifest must still be
    // present after the merge, unless adopt deliberately owns it.
    const adoptOwned = new Set(["cliVersion"]);
    for (const key of Object.keys(CREATE_SCAFFOLDED) as Array<keyof ProjectManifest>) {
      if (adoptOwned.has(key)) continue;
      assert.notEqual(
        merged[key],
        undefined,
        `"${key}" was present before the merge and is missing after it`,
      );
    }
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log("\nAdopt manifest merge test failures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}

console.log("\nAll adopt manifest merge cases passed.");
