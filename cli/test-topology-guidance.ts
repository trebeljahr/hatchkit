/**
 * Topology guidance — the four facts about splitting a deployment
 * across two applications, and the checks that keep them true.
 *
 * Each property below encodes a production failure that shipped green:
 *
 *  1. **The wildcard trap.** A wildcard certificate covers exactly ONE
 *     label below its zone, so `api.app.example.com` under
 *     `example.com` fails the TLS handshake before any HTTP happens.
 *     The label arithmetic must count real shapes correctly, and the
 *     multi-part public suffixes (`example.co.uk`) must not be cut in
 *     half by the "last two labels" heuristic — that would report a
 *     perfectly fine host as the trap and send someone off to buy a
 *     certificate they do not need.
 *  2. **A path in a domain value.** It is what makes the platform emit
 *     a prefix-stripping route, and the stripped prefix is the mount
 *     the API serves its routes at, so every request arrives one
 *     segment short and 404s.
 *  3. **Two applications claiming one host.** The proxy merges
 *     same-host site blocks and the winner swallows the other's
 *     traffic — the realistic way in is an alias naming the API host,
 *     which belongs to the server application.
 *  4. **A routing entry naming a service the compose does not
 *     declare.** The platform accepts it with a success response, emits
 *     no proxy labels at all, and the site answers a gateway error.
 *  5. **Findings a project cannot act on.** A single-origin project has
 *     no API host and must never hear about certificates for one; a
 *     split project must never be told its single application couples
 *     restarts. Noise is what teaches people to skip the output.
 *  6. **The generated document carries the project's own hosts.** A
 *     document with someone else's domain in it is a document nobody
 *     checks their values against.
 *  7. **The CLAUDE.md retrofit is idempotent and anchored.** Running it
 *     twice must not duplicate the block, and a memory file with no
 *     deployment section is left UNCHANGED rather than appended to.
 *  8. **The two ledger invariants.** A second apply must record nothing
 *     as written — `update` re-applies the whole operational layer on
 *     every run, so a module that is not idempotent corrupts a project
 *     a little more each time. And a dry run must leave the disk
 *     exactly as it found it while still reporting `would-write` for
 *     every file it would have touched.
 *
 * No network, no user config: everything here is pure except the
 * write-through cases, which run against real ledgers in temp
 * directories.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeatureLedger, type FileAction } from "./src/features/contract.js";
import type { OperationalContext, OperationalProject } from "./src/features/operational-context.js";
import {
  CLAUDE_MD_BEGIN,
  TOPOLOGY_DOC_REL,
  applyTopologyGuidance,
  inferZone,
  labelsBelowZone,
  pathInDomain,
  recommendedDomainLayout,
  renderClaudeMdSection,
  renderTopologyDoc,
  serviceNameFindings,
  topologyAdvice,
  upsertClaudeMdSection,
} from "./src/features/topology-guidance/index.js";

const failures: string[] = [];
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
  }
}

function project(overrides: Partial<OperationalProject> = {}): OperationalProject {
  return {
    name: "acme",
    domain: "example.dev",
    topology: "split",
    surfaces: "fullstack",
    features: [],
    ...overrides,
  };
}

/** A context around a real ledger, so the write-through tests exercise
 *  the same primitives the CLI does — including the dry run, which is
 *  decided in the ledger and nowhere else. */
function contextFor(
  ledger: FeatureLedger,
  overrides: Partial<OperationalProject> = {},
): OperationalContext {
  return {
    projectDir: ledger.projectDir,
    project: project(overrides),
    mode: "create",
    ledger,
    log: () => undefined,
  };
}

/** Every action the ledger recorded against one project-relative path. */
function actionsFor(ledger: FeatureLedger, file: string): FileAction[] {
  return ledger.entries.filter((e) => e.file === file).map((e) => e.action);
}

const codes = (input: Parameters<typeof topologyAdvice>[0]): string[] =>
  topologyAdvice(input).findings.map((f) => f.code);

// ---------------------------------------------------------------------------
// 1. Label arithmetic on real shapes
// ---------------------------------------------------------------------------

check("api.example.dev is one label below example.dev — the wildcard covers it", () => {
  assert.equal(labelsBelowZone("api.example.dev", "example.dev"), 1);
});

check("api.app.example.com is two labels below example.com — the trap", () => {
  assert.equal(labelsBelowZone("api.app.example.com", "example.com"), 2);
});

check("a multi-part suffix does not inflate the depth", () => {
  assert.equal(labelsBelowZone("api.example.co.uk", "example.co.uk"), 1);
});

check("the apex is zero labels below its own zone", () => {
  assert.equal(labelsBelowZone("example.dev", "example.dev"), 0);
});

check("a host outside the zone reports -1 rather than a depth", () => {
  assert.equal(labelsBelowZone("api.other.com", "example.com"), -1);
});

check("hosts are normalized before they are counted", () => {
  assert.equal(labelsBelowZone("https://API.Example.dev./", "example.dev"), 1);
});

check("inferZone takes the last two labels by default", () => {
  assert.equal(inferZone("api.app.example.com"), "example.com");
  assert.equal(inferZone("example.dev"), "example.dev");
});

check("inferZone keeps a multi-part public suffix whole", () => {
  assert.equal(inferZone("example.co.uk"), "example.co.uk");
  assert.equal(inferZone("api.example.co.uk"), "example.co.uk");
  assert.equal(inferZone("shop.example.com.au"), "example.com.au");
});

check("an explicit zone always beats the heuristic", () => {
  assert.equal(
    inferZone("api.internal.example.com", { zone: "internal.example.com" }),
    "internal.example.com",
  );
});

// ---------------------------------------------------------------------------
// 2. The wildcard trap as a finding
// ---------------------------------------------------------------------------

check("a split API host two labels below its zone is an error", () => {
  const advice = topologyAdvice({
    domain: "app.example.com",
    topology: "split",
    surfaces: "fullstack",
  });
  const trap = advice.findings.find((f) => f.code === "api-host-beyond-wildcard");
  assert.ok(trap, `expected the trap, got ${advice.findings.map((f) => f.code).join(", ")}`);
  assert.equal(trap.severity, "error");
  assert.equal(advice.ok, false);
  assert.match(trap.message, /api\.app\.example\.com/);
  assert.match(trap.fix, /apex|certificate/i);
});

check("a split API host one label below its zone is not a finding", () => {
  assert.ok(
    !codes({ domain: "example.dev", topology: "split", surfaces: "fullstack" }).includes(
      "api-host-beyond-wildcard",
    ),
  );
});

check("a multi-part suffix zone does not manufacture the trap", () => {
  assert.ok(
    !codes({ domain: "example.co.uk", topology: "split", surfaces: "fullstack" }).includes(
      "api-host-beyond-wildcard",
    ),
  );
});

// ---------------------------------------------------------------------------
// 3. A path in a domain value
// ---------------------------------------------------------------------------

check("pathInDomain sees a path through a scheme, and none on a bare host", () => {
  assert.equal(pathInDomain("https://example.dev/api"), "/api");
  assert.equal(pathInDomain("example.dev/api"), "/api");
  assert.equal(pathInDomain("example.dev"), "/");
  assert.equal(pathInDomain("https://example.dev"), "/");
});

check("a path in the domain is an error naming the stripped prefix", () => {
  const advice = topologyAdvice({
    domain: "https://example.dev/api",
    topology: "single-origin",
    surfaces: "fullstack",
  });
  const finding = advice.findings.find((f) => f.code === "domain-carries-path");
  assert.ok(finding, "expected domain-carries-path");
  assert.equal(finding.severity, "error");
  assert.match(finding.message, /\/api/);
  assert.match(finding.fix, /example\.dev/);
});

check("a path on an alias is caught too", () => {
  assert.ok(
    codes({
      domain: "example.dev",
      aliases: ["www.example.dev/app"],
      topology: "single-origin",
      surfaces: "fullstack",
    }).includes("domain-carries-path"),
  );
});

// ---------------------------------------------------------------------------
// 4. Two applications claiming one host
// ---------------------------------------------------------------------------

check("an alias naming the split API host collides with the server application", () => {
  const advice = topologyAdvice({
    domain: "example.dev",
    aliases: ["api.example.dev"],
    topology: "split",
    surfaces: "fullstack",
  });
  const collide = advice.findings.find((f) => f.code === "hosts-collide");
  assert.ok(collide, "expected hosts-collide");
  assert.equal(collide.severity, "error");
  assert.match(collide.fix, /alias/i);
});

check("an ordinary alias is not a collision", () => {
  assert.ok(
    !codes({
      domain: "example.dev",
      aliases: ["www.example.dev"],
      topology: "split",
      surfaces: "fullstack",
    }).includes("hosts-collide"),
  );
});

// ---------------------------------------------------------------------------
// 5. Service-name mismatch
// ---------------------------------------------------------------------------

check("a routed service the compose does not declare is an error", () => {
  const findings = serviceNameFindings({
    composeServices: ["client", "server", "mongo"],
    routedServices: ["client", "app"],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "routed-service-not-declared");
  assert.equal(findings[0].severity, "error");
  assert.match(findings[0].message, /"app"/);
  assert.match(findings[0].message, /client, server, mongo/);
});

check("matching service names produce nothing", () => {
  assert.deepEqual(
    serviceNameFindings({
      composeServices: ["client", "server"],
      routedServices: ["client", "server"],
    }),
    [],
  );
});

check("an unreadable compose (no services) never accuses a correct project", () => {
  assert.deepEqual(serviceNameFindings({ composeServices: [], routedServices: ["server"] }), []);
});

// ---------------------------------------------------------------------------
// 6. Only findings the project can act on
// ---------------------------------------------------------------------------

check("a single-origin project hears nothing about the API host or its DNS record", () => {
  const found = codes({
    domain: "app.example.com",
    topology: "single-origin",
    surfaces: "fullstack",
  });
  assert.ok(!found.includes("api-host-beyond-wildcard"), found.join(", "));
  assert.ok(!found.includes("split-needs-api-record"), found.join(", "));
  assert.ok(found.includes("single-origin-shares-restarts"), found.join(", "));
});

check("a split project is never told its one application couples restarts", () => {
  const found = codes({ domain: "example.dev", topology: "split", surfaces: "fullstack" });
  assert.ok(!found.includes("single-origin-shares-restarts"), found.join(", "));
  assert.ok(found.includes("split-needs-api-record"), found.join(", "));
});

check("a static split project has no server half, so no API findings at all", () => {
  const found = codes({ domain: "app.example.com", topology: "split", surfaces: "static" });
  assert.deepEqual(found, []);
});

check("a backend-only single-origin project is not told about client restarts", () => {
  const found = codes({ domain: "example.dev", topology: "single-origin", surfaces: "backend" });
  assert.ok(!found.includes("single-origin-shares-restarts"), found.join(", "));
});

check("informational findings do not fail the advice", () => {
  const advice = topologyAdvice({
    domain: "example.dev",
    topology: "single-origin",
    surfaces: "fullstack",
  });
  assert.equal(advice.ok, true);
});

// ---------------------------------------------------------------------------
// 7. The recommended layout
// ---------------------------------------------------------------------------

check("a split layout gives each application a host of its own", () => {
  const layout = recommendedDomainLayout({ domain: "example.dev", topology: "split" });
  assert.deepEqual(
    layout.apps.map((a) => a.hosts),
    [["example.dev"], ["api.example.dev"]],
  );
  assert.deepEqual(layout.dnsHosts, ["example.dev", "api.example.dev"]);
  assert.equal(layout.wildcardTrap, false);
  assert.deepEqual(layout.alternatives, []);
});

check("a single-origin layout is one application on one host", () => {
  const layout = recommendedDomainLayout({ domain: "example.dev", topology: "single-origin" });
  assert.equal(layout.apps.length, 1);
  assert.equal(layout.apps[0].role, "compose");
  assert.deepEqual(layout.apps[0].hosts, ["example.dev"]);
});

check(
  "the trap offers a fresh apex first, and says the proxy-off option exposes the origin",
  () => {
    const layout = recommendedDomainLayout({ domain: "app.example.com", topology: "split" });
    assert.equal(layout.wildcardTrap, true);
    assert.equal(layout.alternatives.length, 3);
    assert.match(layout.alternatives[0].title, /apex/i);
    assert.match(layout.alternatives[2].cost, /origin IP is public|origin/i);
  },
);

// ---------------------------------------------------------------------------
// 8. The generated document
// ---------------------------------------------------------------------------

const splitDoc = renderTopologyDoc(project({ name: "acme", domain: "example.dev" }));

check("the document states fact 1 — two applications so restarts do not couple", () => {
  assert.match(splitDoc, /unit of deployment is the application/i);
  assert.match(splitDoc, /restart independently/i);
});

check("the document states fact 2 — the service name is load-bearing", () => {
  assert.match(splitDoc, /keys its domain routing by compose service name/i);
  assert.match(splitDoc, /success response.*no proxy labels|no proxy labels/is);
});

check("the document states fact 3 — merged site blocks and a stripped prefix", () => {
  assert.match(splitDoc, /merges site blocks for the same host/i);
  assert.match(splitDoc, /matched path prefix is stripped/i);
  assert.match(splitDoc, /never put a path in an application's domain field/i);
});

check("the document states fact 4 — a wildcard covers one label", () => {
  assert.match(splitDoc, /covers exactly ONE label below its zone/);
  assert.match(splitDoc, /handshake/i);
});

check("the document carries the failure-symptom table, all four rows", () => {
  assert.match(splitDoc, /\| Symptom \| Cause \| Where to look \|/);
  assert.match(splitDoc, /404 from the API host/);
  assert.match(splitDoc, /own 404 page from the API host/);
  assert.match(splitDoc, /gateway error/);
  assert.match(splitDoc, /TLS handshake failure/);
});

check("the document carries this project's hosts, not the reference project's", () => {
  assert.match(splitDoc, /https:\/\/api\.example\.dev\/api\/health/);
  assert.match(splitDoc, /acme-server/);
  assert.match(splitDoc, /acme-client/);
  assert.ok(!/trackyourtime|trebeljahr|playtiao/i.test(splitDoc), "leaked a reference hostname");
});

check("a project on another domain gets that domain everywhere", () => {
  const other = renderTopologyDoc(project({ name: "widget", domain: "widget.io" }));
  assert.match(other, /api\.widget\.io/);
  assert.ok(!other.includes("example.dev"), "leaked the other project's domain");
});

check("a single-origin document still states all four facts, and names one application", () => {
  const doc = renderTopologyDoc(project({ topology: "single-origin" }));
  assert.match(doc, /unit of deployment is the application/i);
  assert.match(doc, /keys its domain routing by compose service name/i);
  assert.match(doc, /matched path prefix is stripped/i);
  assert.match(doc, /covers exactly ONE label below its zone/);
  assert.match(doc, /runs \*\*one\*\* application today/i);
  assert.ok(!doc.includes("api.example.dev"), "single-origin has no API host to name");
});

check("a static project's verification block has no API request in it", () => {
  const doc = renderTopologyDoc(project({ surfaces: "static" }));
  assert.ok(!doc.includes("/api/health"), "a static project has no API to probe");
  assert.match(doc, /curl -sSI https:\/\/example\.dev/);
});

// ---------------------------------------------------------------------------
// 9. The CLAUDE.md retrofit
// ---------------------------------------------------------------------------

const ANCHORED = [
  "# Acme",
  "",
  "## Deployment",
  "",
  "Some existing prose.",
  "",
  "## Code Style",
  "",
  "Two spaces.",
  "",
].join("\n");

check("the section is inserted before the next heading of the same level", () => {
  const out = upsertClaudeMdSection(ANCHORED, renderClaudeMdSection(project()));
  assert.ok(out.includes(CLAUDE_MD_BEGIN));
  assert.ok(out.indexOf(CLAUDE_MD_BEGIN) > out.indexOf("Some existing prose."));
  assert.ok(out.indexOf(CLAUDE_MD_BEGIN) < out.indexOf("## Code Style"));
  assert.ok(out.includes("Two spaces."), "the rest of the file survived");
});

check("running the retrofit twice changes nothing the second time", () => {
  const once = upsertClaudeMdSection(ANCHORED, renderClaudeMdSection(project()));
  const twice = upsertClaudeMdSection(once, renderClaudeMdSection(project()));
  assert.equal(twice, once);
  assert.equal(twice.split(CLAUDE_MD_BEGIN).length - 1, 1, "the block was duplicated");
});

check("a changed project replaces the block in place rather than appending one", () => {
  const once = upsertClaudeMdSection(ANCHORED, renderClaudeMdSection(project()));
  const moved = upsertClaudeMdSection(
    once,
    renderClaudeMdSection(project({ domain: "widget.io" })),
  );
  assert.equal(moved.split(CLAUDE_MD_BEGIN).length - 1, 1);
  assert.match(moved, /api\.widget\.io/);
  assert.ok(!moved.includes("api.example.dev"), "the old hosts survived the replacement");
});

check("a memory file with no deployment section is returned unchanged", () => {
  const hand = "# Acme\n\nSome prose a person wrote.\n\n## Code Style\n\nTwo spaces.\n";
  assert.equal(upsertClaudeMdSection(hand, renderClaudeMdSection(project())), hand);
});

check("the compact section leads with the reason, not the rule", () => {
  const section = renderClaudeMdSection(project());
  assert.match(section, /so a site deploy cannot restart the server/i);
  assert.match(section, /load-bearing/);
  assert.match(section, /docs\/deploy-topology\.md/);
});

// ---------------------------------------------------------------------------
// 10. The write-through, over the ledger
// ---------------------------------------------------------------------------

check("apply writes the document and retrofits an anchored CLAUDE.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "topology-guidance-"));
  try {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), ANCHORED, "utf8");

    const ledger = new FeatureLedger(dir, false);
    applyTopologyGuidance(contextFor(ledger));

    assert.deepEqual(actionsFor(ledger, TOPOLOGY_DOC_REL), ["written"]);
    assert.deepEqual(actionsFor(ledger, "CLAUDE.md"), ["written"]);
    assert.match(readFileSync(join(dir, TOPOLOGY_DOC_REL), "utf8"), /api\.example\.dev/);
    assert.ok(readFileSync(join(dir, "CLAUDE.md"), "utf8").includes(CLAUDE_MD_BEGIN));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("the generated document says it is owned, in the document", () => {
  // `writeIfChanged` overwrites. Somebody who edits this file loses the
  // edit on the next update, and the header is the only warning they
  // get before it happens.
  const dir = mkdtempSync(join(tmpdir(), "topology-guidance-owned-"));
  try {
    const ledger = new FeatureLedger(dir, false);
    applyTopologyGuidance(contextFor(ledger));
    const doc = readFileSync(join(dir, TOPOLOGY_DOC_REL), "utf8");
    assert.match(doc.split("\n")[0] ?? "", /Generated by hatchkit/);
    assert.match(doc.split("\n")[0] ?? "", /Rewritten on every/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a second apply records nothing as written — the idempotency invariant", () => {
  const dir = mkdtempSync(join(tmpdir(), "topology-guidance-idem-"));
  try {
    writeFileSync(join(dir, "CLAUDE.md"), ANCHORED, "utf8");
    applyTopologyGuidance(contextFor(new FeatureLedger(dir, false)));

    const second = new FeatureLedger(dir, false);
    applyTopologyGuidance(contextFor(second));
    const unexpected = second.entries.filter(
      (e) => e.action !== "unchanged" && e.action !== "absent",
    );
    assert.deepEqual(
      unexpected,
      [],
      `second apply touched ${unexpected.map((e) => `${e.file}:${e.action}`).join(", ")}`,
    );
    assert.equal(second.touched, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a dry run touches nothing and reports what it would have written", () => {
  const dir = mkdtempSync(join(tmpdir(), "topology-guidance-dry-"));
  try {
    writeFileSync(join(dir, "CLAUDE.md"), ANCHORED, "utf8");
    const before = readFileSync(join(dir, "CLAUDE.md"), "utf8");

    const ledger = new FeatureLedger(dir, true);
    applyTopologyGuidance(contextFor(ledger));

    assert.deepEqual(actionsFor(ledger, TOPOLOGY_DOC_REL), ["would-write"]);
    assert.deepEqual(actionsFor(ledger, "CLAUDE.md"), ["would-write"]);
    assert.equal(
      existsSync(join(dir, TOPOLOGY_DOC_REL)),
      false,
      "the dry run created the document",
    );
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a hand-edited owned document is regenerated rather than left stale", () => {
  // The old contract refused to overwrite any existing file, which meant
  // a document written by an older CLI never picked up a later fact.
  // The document is hatchkit's; the ledger's rule is the finer one.
  const dir = mkdtempSync(join(tmpdir(), "topology-guidance-regen-"));
  try {
    applyTopologyGuidance(contextFor(new FeatureLedger(dir, false)));
    writeFileSync(join(dir, TOPOLOGY_DOC_REL), "hand written\n", "utf8");

    const ledger = new FeatureLedger(dir, false);
    applyTopologyGuidance(contextFor(ledger));
    assert.deepEqual(actionsFor(ledger, TOPOLOGY_DOC_REL), ["written"]);
    assert.match(readFileSync(join(dir, TOPOLOGY_DOC_REL), "utf8"), /api\.example\.dev/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("prose a person wrote outside the markers survives a re-apply", () => {
  const dir = mkdtempSync(join(tmpdir(), "topology-guidance-useredit-"));
  try {
    writeFileSync(join(dir, "CLAUDE.md"), ANCHORED, "utf8");
    applyTopologyGuidance(contextFor(new FeatureLedger(dir, false)));

    const edited = `${readFileSync(join(dir, "CLAUDE.md"), "utf8")}\n## Notes\n\nMine.\n`;
    writeFileSync(join(dir, "CLAUDE.md"), edited, "utf8");

    applyTopologyGuidance(contextFor(new FeatureLedger(dir, false), { domain: "widget.io" }));
    const after = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    assert.ok(after.includes("Mine."), "the user's own section was dropped");
    assert.equal(after.split(CLAUDE_MD_BEGIN).length - 1, 1);
    assert.match(after, /api\.widget\.io/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("apply notes the actionable findings and stays quiet about the informational one", () => {
  const dir = mkdtempSync(join(tmpdir(), "topology-guidance-notes-"));
  try {
    const trapped = applyTopologyGuidance(
      contextFor(new FeatureLedger(dir, false), { domain: "app.example.com" }),
    );
    assert.ok(
      trapped.notes.some((n) => /wildcard certificate covers one/i.test(n)),
      trapped.notes.join(" | "),
    );
    assert.ok(
      trapped.notes.some((n) => /apex/i.test(n)),
      trapped.notes.join(" | "),
    );

    const quiet = applyTopologyGuidance(
      contextFor(new FeatureLedger(dir, false), { topology: "single-origin" }),
    );
    assert.deepEqual(quiet.notes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a project with no CLAUDE.md is an absent ledger entry, not a note", () => {
  // The ledger reports what did not happen to a file. A note is for what
  // a person still has to do, and nobody has to create a CLAUDE.md.
  const dir = mkdtempSync(join(tmpdir(), "topology-guidance-nomemory-"));
  try {
    const ledger = new FeatureLedger(dir, false);
    const result = applyTopologyGuidance(contextFor(ledger));
    assert.deepEqual(actionsFor(ledger, TOPOLOGY_DOC_REL), ["written"]);
    assert.deepEqual(actionsFor(ledger, "CLAUDE.md"), ["absent"]);
    assert.ok(!result.notes.some((n) => /CLAUDE\.md/.test(n)), result.notes.join(" | "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("a CLAUDE.md with no deployment heading is left alone, with a note saying why", () => {
  const dir = mkdtempSync(join(tmpdir(), "topology-guidance-noanchor-"));
  try {
    const hand = "# Acme\n\nSome prose a person wrote.\n\n## Code Style\n\nTwo spaces.\n";
    writeFileSync(join(dir, "CLAUDE.md"), hand, "utf8");

    const ledger = new FeatureLedger(dir, false);
    const result = applyTopologyGuidance(contextFor(ledger));
    assert.deepEqual(actionsFor(ledger, "CLAUDE.md"), ["unchanged"]);
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), hand);
    assert.ok(
      result.notes.some((n) => /no deployment section/i.test(n)),
      result.notes.join(" | "),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("the ways out of the trap name a host the project really has", () => {
  // A first cut rendered the alternatives from a synthetic `deep.<zone>`
  // host, so every untrapped project's document told its reader to buy a
  // certificate for a hostname that exists nowhere.
  assert.ok(!splitDoc.includes("deep."), "a fabricated hostname reached the document");
  assert.match(splitDoc, /naming api\.example\.dev explicitly/);

  const trapped = renderTopologyDoc(project({ domain: "app.example.com" }));
  assert.match(trapped, /api\.app\.example\.com/);
  assert.match(trapped, /is more than one label below/);
});

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(f);
  process.exit(1);
}

console.log("\n  all topology-guidance checks passed\n");
