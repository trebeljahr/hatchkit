/**
 * The shared "does this project already exist?" resolver.
 *
 * Regression origin: `hatchkit add` and `hatchkit inventory` each had
 * their own answer and they disagreed. `add`'s preflight probed
 * GlitchTip's `/api/0/projects/{org}/{slug}/keys/` and read "not a 404"
 * as "exists" — but that endpoint answers `200 []` for a slug that does
 * not exist, so the probe returned true for every name ever passed to
 * it. `add` refused to run ("Refusing to add services because these
 * resources already exist: GlitchTip project tracktime") while
 * `inventory`, which listed the org and matched names, reported the very
 * same project missing. Between them there was no route to the DSN at
 * all, so SENTRY_DSN stayed at its CHANGE_ME_ placeholder.
 *
 * A keychain-cached credential has the same flaw: it proves hatchkit
 * once created a project, not that the project is still there.
 *
 * Both callers now go through `matchRemoteProjects`, so existence is
 * decided by what the provider's own listing contains. These cases pin
 * the matching rules; the endpoint quirk itself is pinned by the
 * `nextPageUrl` cases, which is the only status/header parsing left in
 * the path.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The resolver pulls in config.js transitively, which instantiates the
// Conf-backed store at import time. Point it at a throwaway directory so
// a test run never reads or writes the real user config.
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "hatchkit-lookup-test-"));

const { nextPageUrl } = await import("./src/provision/glitchtip.js");
const { matchProjectsForBaseName, matchRemoteProjects, projectNameCandidates } = await import(
  "./src/provision/project-lookup.js"
);

const failures: string[] = [];

function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

/** A GlitchTip org that looks like a real one: unrelated projects, a
 *  name reused across several slugs, and nothing called `tracktime`. */
const otherProjects = [
  { name: "broadcastdock", slug: "broadcastdock" },
  { name: "extinction-protocol", slug: "extinction-protocol" },
  { name: "extinction-protocol", slug: "extinction-protocol-2" },
  { name: "playtiao.com", slug: "tiao" },
  { name: "raptor-runner", slug: "raptor-runner" },
];

// ── candidate list ────────────────────────────────────────────────

check("candidates are the base name plus the four surface suffixes", () => {
  assert.deepEqual(projectNameCandidates("tracktime"), [
    "tracktime",
    "tracktime-server",
    "tracktime-client",
    "tracktime-web",
    "tracktime-api",
  ]);
});

// ── exact name ────────────────────────────────────────────────────

check("exact name match", () => {
  const matches = matchProjectsForBaseName(
    [...otherProjects, { name: "tracktime", slug: "tracktime" }],
    "tracktime",
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].identity, "tracktime");
  assert.equal(matches[0].matchedAs, "tracktime");
});

// ── the -server / -client / -web / -api variants ──────────────────

for (const suffix of ["server", "client", "web", "api"] as const) {
  check(`\`<name>-${suffix}\` variant matches`, () => {
    const slug = `tracktime-${suffix}`;
    const matches = matchProjectsForBaseName([...otherProjects, { name: slug, slug }], "tracktime");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].identity, slug);
    assert.equal(matches[0].matchedAs, slug);
  });
}

check("a split project matches both of its surface projects", () => {
  const matches = matchProjectsForBaseName(
    [
      ...otherProjects,
      { name: "tracktime-server", slug: "tracktime-server" },
      { name: "tracktime-client", slug: "tracktime-client" },
    ],
    "tracktime",
  );
  assert.deepEqual(
    matches.map((m) => m.identity),
    ["tracktime-server", "tracktime-client"],
  );
});

// ── nothing matching ──────────────────────────────────────────────

check("an org full of other projects yields no match", () => {
  // The live case the bug was reported against: 12 projects in the org,
  // none of them this one. The old probe said "exists" here.
  assert.deepEqual(matchProjectsForBaseName(otherProjects, "tracktime"), []);
});

check("a near-miss name does not match", () => {
  // Substring and prefix-of-a-longer-name must both stay misses —
  // `tracktimer` is somebody else's project.
  const projects = [
    { name: "tracktimer", slug: "tracktimer" },
    { name: "my-tracktime", slug: "my-tracktime" },
    { name: "tracktime-server-old", slug: "tracktime-server-old" },
  ];
  assert.deepEqual(matchProjectsForBaseName(projects, "tracktime"), []);
});

check("an empty org yields no match", () => {
  assert.deepEqual(matchProjectsForBaseName([], "tracktime"), []);
});

// ── name vs slug ──────────────────────────────────────────────────

check("a display-name collision counts, even when the slug differs", () => {
  // GlitchTip disambiguates a taken slug rather than reusing it
  // (`foo`, `foo-2`, `foo-3`), so matching on slug alone would miss the
  // collision and silently mint a duplicate project.
  const matches = matchProjectsForBaseName(
    [...otherProjects, { name: "tracktime", slug: "tracktime-2" }],
    "tracktime",
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].matchedAs, "tracktime");
  // Identity is what the provider's API paths take — the slug, not the
  // display name. Adopting by name here would 404.
  assert.equal(matches[0].identity, "tracktime-2");
});

check("matching is case-insensitive", () => {
  const matches = matchProjectsForBaseName([{ name: "TrackTime", slug: "TrackTime" }], "tracktime");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].matchedAs, "tracktime");
});

check("a project reported with only a slug still matches", () => {
  const matches = matchProjectsForBaseName([{ slug: "tracktime-api" }], "tracktime");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].identity, "tracktime-api");
});

// ── id-keyed projects ─────────────────────────────────────────────

check("id-keyed projects match on name and resolve identity to the id", () => {
  const matches = matchProjectsForBaseName(
    [
      { id: "proj_9f2", name: "raptor-runner" },
      { id: "proj_a41", name: "tracktime" },
    ],
    "tracktime",
  );
  assert.equal(matches.length, 1);
  // A provider that addresses projects by id needs that, not the name.
  assert.equal(matches[0].identity, "proj_a41");
  assert.equal(matches[0].id, "proj_a41");
});

check("a project addressed by id alone matches when the id is the name", () => {
  const matches = matchProjectsForBaseName([{ id: "tracktime" }], "tracktime");
  assert.equal(matches.length, 1);
});

// ── the narrower question `add`'s preflight asks ──────────────────

check("preflight candidates stay narrow: a sibling variant is not a collision", () => {
  // The guard passes the exact names the run would create, not the
  // alias set. Refusing to create `tracktime-server` because an
  // unrelated `tracktime-api` exists would be wrong.
  const projects = [{ name: "tracktime-api", slug: "tracktime-api" }];
  assert.deepEqual(matchRemoteProjects(projects, ["tracktime-server", "tracktime-client"]), []);
  assert.equal(matchRemoteProjects(projects, ["tracktime-api"]).length, 1);
});

check("one project is reported once even when two candidates could match it", () => {
  // Guards against a duplicate conflict line for a single resource.
  const matches = matchRemoteProjects(
    [{ name: "tracktime", slug: "tracktime-api" }],
    ["tracktime", "tracktime-api"],
  );
  assert.equal(matches.length, 1);
  // Candidate order decides which one is reported.
  assert.equal(matches[0].matchedAs, "tracktime");
});

// ── GlitchTip pagination ──────────────────────────────────────────

check("`results=false` on rel=next means the listing is complete", () => {
  // Verbatim from a live self-hosted GlitchTip, Python `set` repr and
  // all. Treating this as a next page would loop the listing forever.
  const link =
    `{'<https://gt.example.com/api/0/organizations/org/projects/>; rel="previous"; results="false", ` +
    `<https://gt.example.com/api/0/organizations/org/projects/>; rel="next"; results="false"'}`;
  assert.equal(nextPageUrl(link), undefined);
});

check("`results=true` on rel=next yields the cursor URL", () => {
  const link =
    `<https://gt.example.com/api/0/organizations/org/projects/?cursor=prev>; rel="previous"; results="false", ` +
    `<https://gt.example.com/api/0/organizations/org/projects/?cursor=next>; rel="next"; results="true"`;
  assert.equal(
    nextPageUrl(link),
    "https://gt.example.com/api/0/organizations/org/projects/?cursor=next",
  );
});

check("a missing Link header ends the listing", () => {
  assert.equal(nextPageUrl(null), undefined);
  assert.equal(nextPageUrl(""), undefined);
});

if (failures.length > 0) {
  console.log("\nProject-lookup test failures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}

console.log("\nAll project-lookup cases passed.");
