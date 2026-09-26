/**
 * The shared feature-authoring mechanism (cli/src/features/contract.ts
 * and templates.ts).
 *
 * What this guards — the four failures `docs/feature-authoring.md` is
 * written to prevent:
 *   1. Idempotency. Applying twice writes nothing the second time.
 *   2. Dry run. Nothing reaches the disk, and the ledger still describes
 *      the whole change.
 *   3. User edits survive. A managed block replaces only itself; a
 *      customised package.json script is reported, not reverted.
 *   4. No unrendered tokens, and an unknown token is left in place so a
 *      partial render is greppable instead of silently holed.
 * Plus prerequisite closure and a deterministic apply order.
 *
 * Run: pnpm --filter hatchkit test:feature-contract
 */

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FeatureLedger,
  applyFeatures,
  expandFeatureSelection,
  inferCommentPrefix,
  registerFeature,
  resetFeatureRegistryForTests,
} from "./src/features/contract.js";
import {
  findUnrenderedTokens,
  getFeatureTemplateDir,
  identifierTemplateTokens,
  listFeatureTemplates,
  renderFeatureTemplate,
  renderTemplateString,
} from "./src/features/templates.js";
import { resolveIdentifiers } from "./src/scaffold/identifiers.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function tmpProject(tag: string): string {
  return mkdtempSync(join(tmpdir(), `feature-contract-${tag}-`));
}

/** Every file in a tree, path → contents, for byte-comparing a dry run. */
function snapshot(root: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, snapshot(root, rel));
    else out[rel] = readFileSync(join(root, rel), "utf-8");
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. writeIfChanged — idempotency
// ---------------------------------------------------------------------------
console.log("\nwriteIfChanged:");
{
  const root = tmpProject("write");
  try {
    const l = new FeatureLedger(root, false);
    assert(l.writeIfChanged("a/b.yml", "hello\n") === "written", "first write");
    assert(l.writeIfChanged("a/b.yml", "hello\n") === "unchanged", "identical re-write is a no-op");
    assert(l.writeIfChanged("a/b.yml", "bye\n") === "written", "different content writes");
    assert(readFileSync(join(root, "a/b.yml"), "utf-8") === "bye\n", "content landed");
    assert(l.touched, "ledger reports the run as touching");
    assert(l.summary().written.length === 2, "summary counts only real writes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. Dry run — the single choke point
// ---------------------------------------------------------------------------
console.log("\ncopyIfAbsent:");
{
  const root = tmpProject("copy");
  const src = tmpProject("copy-src");
  try {
    // A binary payload and an executable script — the two kinds of file
    // `writeIfChanged` cannot carry. A PNG round-tripped through a UTF-8
    // string loses bytes; a shell script written with writeFileSync loses
    // its +x bit and fails with EACCES at the call site.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
    writeFileSync(join(src, "icon.png"), png);
    writeFileSync(join(src, "run.sh"), "#!/bin/sh\necho hi\n", "utf-8");
    chmodSync(join(src, "run.sh"), 0o755);

    const l = new FeatureLedger(root, false);
    assert(l.copyIfAbsent("res/icon.png", join(src, "icon.png")) === "written", "binary copied");
    assert(
      Buffer.compare(readFileSync(join(root, "res/icon.png")), png) === 0,
      "byte for byte — a UTF-8 round trip would corrupt it",
    );
    assert(l.copyIfAbsent("run.sh", join(src, "run.sh")) === "written", "script copied");
    assert(
      (statSync(join(root, "run.sh")).mode & 0o111) !== 0,
      "the executable bit survives — writeFileSync would create it 0644",
    );

    // Copy-IF-ABSENT: the destination is source the user then edits, so a
    // second apply must not take it back.
    writeFileSync(join(root, "run.sh"), "# mine\n", "utf-8");
    assert(l.copyIfAbsent("run.sh", join(src, "run.sh")) === "unchanged", "present is unchanged");
    assert(
      readFileSync(join(root, "run.sh"), "utf-8") === "# mine\n",
      "a user edit is never overwritten",
    );

    // A missing SOURCE is not an error: the path list is shared with the
    // create-time strip, and some paths only exist after a generator run.
    assert(l.copyIfAbsent("nope.txt", join(src, "nope.txt")) === "absent", "missing source");

    const dry = new FeatureLedger(root, true);
    assert(
      dry.copyIfAbsent("res/splash.png", join(src, "icon.png")) === "would-write",
      "a dry run describes the copy",
    );
    assert(snapshot(root)["res/splash.png"] === undefined, "and writes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
console.log("\ndry run:");
{
  const root = tmpProject("dry");
  try {
    writeFileSync(join(root, "package.json"), `{\n  "name": "x"\n}\n`, "utf-8");
    writeFileSync(join(root, ".gitignore"), "node_modules\n", "utf-8");
    const before = snapshot(root);

    const l = new FeatureLedger(root, true);
    assert(l.writeIfChanged("new.yml", "x\n") === "would-write", "write is described, not done");
    assert(l.remove("package.json") === "would-remove", "remove is described, not done");
    assert(l.ensureLine(".gitignore", "dist") === "would-write", "line append is described");
    assert(
      l.ensureManagedBlock(".gitignore", "b", "release/") === "would-write",
      "managed block is described",
    );
    assert(
      l.mergePackageJson("package.json", { scripts: { build: "tsc" } }) === "would-write",
      "package.json merge is described",
    );

    assert(
      JSON.stringify(snapshot(root)) === JSON.stringify(before),
      "a dry run leaves the tree byte-identical",
    );
    // The ledger still describes the whole change, so one code path
    // renders both modes.
    assert(l.summary()["would-write"].length === 4, "would-write entries recorded");
    assert(l.summary()["would-remove"].length === 1, "would-remove entry recorded");
    assert(l.touched, "a dry run still reports that something would change");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3. Managed blocks — user edits outside the markers survive
// ---------------------------------------------------------------------------
console.log("\nmanaged blocks:");
{
  const root = tmpProject("block");
  try {
    const l = new FeatureLedger(root, false);
    writeFileSync(join(root, ".gitignore"), "node_modules\n", "utf-8");

    assert(l.ensureManagedBlock(".gitignore", "desktop", "release/") === "written", "block added");
    assert(
      l.ensureManagedBlock(".gitignore", "desktop", "release/") === "unchanged",
      "identical block re-applies as a no-op",
    );

    // The user edits around the block, and adds a second of their own.
    const edited = `${readFileSync(join(root, ".gitignore"), "utf-8")}my-own-thing/\n`;
    writeFileSync(join(root, ".gitignore"), `# mine\n${edited}`, "utf-8");

    // A later CLI version changes what the feature contributes. The
    // block is replaced; everything outside it is untouched.
    assert(
      l.ensureManagedBlock(".gitignore", "desktop", "release/\nout-desktop/") === "written",
      "block content can change",
    );
    const after = readFileSync(join(root, ".gitignore"), "utf-8");
    assert(after.startsWith("# mine\n"), "user's leading line survives");
    assert(after.includes("node_modules\n"), "pre-existing content survives");
    assert(after.includes("my-own-thing/\n"), "user's trailing line survives");
    assert(after.includes("out-desktop/"), "new block content present");
    assert(
      (after.match(/hatchkit:begin desktop/g) || []).length === 1,
      "exactly one block, not two",
    );
    assert(after.includes("Managed by hatchkit"), "the block states that it is overwritten");

    // Two features can own two blocks in one file.
    assert(l.ensureManagedBlock(".gitignore", "mobile", "ios/build/") === "written", "second block");
    const two = readFileSync(join(root, ".gitignore"), "utf-8");
    assert(two.includes("hatchkit:begin desktop") && two.includes("hatchkit:begin mobile"), "both");
    assert(two.includes("my-own-thing/"), "user's line still there after a second block");

    // A half-deleted marker pair is a conflict, not a guess: repairing
    // it would mean deciding which user lines belonged inside.
    writeFileSync(join(root, "broken.yml"), "# hatchkit:begin x\nstuff\n", "utf-8");
    assert(
      l.ensureManagedBlock("broken.yml", "x", "y") === "conflict",
      "an orphaned marker is reported",
    );
    assert(
      readFileSync(join(root, "broken.yml"), "utf-8") === "# hatchkit:begin x\nstuff\n",
      "a conflict changes nothing",
    );

    // A feature editing someone else's file no-ops when that file is
    // absent, so it does not have to know whether the other feature is on.
    assert(l.ensureManagedBlock("nope.yml", "x", "y") === "absent", "absent file is not an error");
    assert(l.ensureManagedBlock("nope.yml", "x", "y", { create: true }) === "written", "create: true");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("\ncomment prefixes:");
{
  assert(inferCommentPrefix("a/b.ts") === "//", "ts");
  assert(inferCommentPrefix("app/build.gradle") === "//", "gradle");
  assert(inferCommentPrefix(".gitignore") === "#", "ignore files");
  assert(inferCommentPrefix("compose.yml") === "#", "yaml");
  assert(inferCommentPrefix("schema.sql") === "--", "sql");
}

// ---------------------------------------------------------------------------
// 4. ensureLine + edit
// ---------------------------------------------------------------------------
console.log("\nensureLine / edit:");
{
  const root = tmpProject("line");
  try {
    const l = new FeatureLedger(root, false);
    writeFileSync(join(root, ".gitignore"), "node_modules", "utf-8");
    assert(l.ensureLine(".gitignore", "dist") === "written", "line appended");
    assert(
      readFileSync(join(root, ".gitignore"), "utf-8") === "node_modules\ndist\n",
      "missing trailing newline handled",
    );
    assert(l.ensureLine(".gitignore", "dist") === "unchanged", "already-present line is a no-op");
    assert(l.ensureLine(".gitignore", "  dist  ") === "unchanged", "whitespace does not fool it");

    writeFileSync(join(root, "f.ts"), "const a = 1;\n", "utf-8");
    // A fixed-point transform: it checks for what it PRODUCES, not for
    // the insertion point, so a second run adds nothing.
    const addImport = (c: string) => (c.includes('import "x";') ? c : `import "x";\n${c}`);
    assert(l.edit("f.ts", addImport) === "written", "first edit");
    assert(l.edit("f.ts", addImport) === "unchanged", "fixed-point edit re-runs cleanly");
    assert(l.edit("missing.ts", addImport) === "absent", "missing file is not an error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5. mergePackageJson — never revert a user's script
// ---------------------------------------------------------------------------
console.log("\nmergePackageJson:");
{
  const root = tmpProject("pkg");
  try {
    const l = new FeatureLedger(root, false);
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "x", scripts: { build: "tsc" } }, null, 2)}\n`,
      "utf-8",
    );

    assert(
      l.mergePackageJson("package.json", {
        scripts: { "build:desktop": "electron-builder" },
        devDependencies: { electron: "^42.0.0" },
      }) === "written",
      "additions land",
    );
    assert(
      l.mergePackageJson("package.json", {
        scripts: { "build:desktop": "electron-builder" },
        devDependencies: { electron: "^42.0.0" },
      }) === "unchanged",
      "identical merge is a no-op",
    );

    // The user customises the script the feature added. The next update
    // must report it and leave it alone — silently reverting their work
    // without ever failing is the worst version of this bug.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    pkg.scripts["build:desktop"] = "electron-builder --publish never";
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");

    const res = l.mergePackageJson("package.json", {
      scripts: { "build:desktop": "electron-builder" },
    });
    assert(res === "conflict", `customised script reported as conflict (got ${res})`);
    const after = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    assert(
      after.scripts["build:desktop"] === "electron-builder --publish never",
      "the user's script is NOT reverted",
    );
    assert(after.scripts.build === "tsc", "unrelated scripts untouched");
    assert(l.conflicts().length === 1, "the conflict is surfaced on the ledger");

    // force is for values that are genuinely hatchkit's to set.
    assert(
      l.mergePackageJson(
        "package.json",
        { scripts: { "build:desktop": "electron-builder" } },
        { force: true },
      ) === "written",
      "force overwrites",
    );
    assert(l.mergePackageJson("absent.json", { scripts: {} }) === "absent", "missing file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 6. Prerequisites and apply order
// ---------------------------------------------------------------------------
console.log("\nselection:");
{
  resetFeatureRegistryForTests();
  const applied: string[] = [];
  const stub = (id: string, requires?: string[], extra: Record<string, unknown> = {}) =>
    registerFeature({
      // The registry is keyed by the real Feature union; these ids stand
      // in for it so the test does not depend on today's feature set.
      id: id as never,
      title: id,
      summary: id,
      requires: requires as never,
      addableAfterScaffold: true,
      apply: () => {
        applied.push(id);
      },
      ...extra,
    });

  stub("websocket");
  stub("s3", ["websocket"]);
  stub("analytics", ["s3"]);
  stub("desktop", undefined, { addableAfterScaffold: false });
  stub("mobile", undefined, { conflictsWith: ["stripe"] as never });
  stub("stripe");

  const sel = expandFeatureSelection(["analytics" as never]);
  assert(sel.errors.length === 0, `no errors: ${sel.errors.join("; ")}`);
  assert(
    sel.ordered.join(",") === "websocket,s3,analytics",
    `prerequisites pulled in and ordered first: ${sel.ordered.join(",")}`,
  );
  assert(
    sel.implied.sort().join(",") === "s3,websocket",
    `implied names what the user did not ask for: ${sel.implied.join(",")}`,
  );

  // Deterministic: registration order is the tie-break, so the same
  // selection always produces the same sequence.
  const a = expandFeatureSelection(["analytics", "desktop", "stripe"] as never[]);
  const b = expandFeatureSelection(["stripe", "desktop", "analytics"] as never[]);
  assert(a.ordered.join(",") === b.ordered.join(","), "order does not depend on input order");

  assert(
    expandFeatureSelection(["mobile", "stripe"] as never[]).errors.length === 1,
    "a declared conflict is a selection error",
  );
  assert(
    expandFeatureSelection(["nope" as never]).errors[0]?.includes("Unknown feature"),
    "an unknown id is reported, not thrown",
  );

  // A cycle is reported rather than hanging or silently dropping work.
  resetFeatureRegistryForTests();
  stub("websocket", ["s3"]);
  stub("s3", ["websocket"]);
  const cyc = expandFeatureSelection(["websocket" as never]);
  assert(cyc.errors.some((e) => e.includes("Circular")), "a dependency cycle is reported");
}

console.log("\napplyFeatures:");
{
  resetFeatureRegistryForTests();
  const applied: string[] = [];
  const root = tmpProject("apply");
  try {
    for (const [id, requires, addable] of [
      ["websocket", undefined, true],
      ["s3", ["websocket"], true],
      ["desktop", undefined, false],
    ] as const) {
      registerFeature({
        id: id as never,
        title: id,
        summary: id,
        requires: requires as never,
        addableAfterScaffold: addable,
        apply: (c) => {
          applied.push(id);
          c.ledger.writeIfChanged(`${id}.txt`, "x\n");
        },
      });
    }

    const ledger = new FeatureLedger(root, false);
    const logs: string[] = [];
    const ctx = {
      projectDir: root,
      manifestDir: root,
      manifest: { name: "t" } as never,
      identifiers: resolveIdentifiers({ name: "t" }),
      mode: "update" as const,
      ledger,
      log: (m: string) => logs.push(m),
    };
    const sel = expandFeatureSelection(["s3", "desktop"] as never[]);
    await applyFeatures(sel.ordered, ctx);

    assert(applied.join(",") === "websocket,s3", `prerequisite ran first: ${applied.join(",")}`);
    assert(!applied.includes("desktop"), "a non-addable feature is skipped on update");
    assert(
      logs.some((l) => l.includes("cannot be added to an existing project")),
      "and the skip is explained",
    );
    // Entries are attributed, so a combined run reports per feature.
    assert(
      ledger.entries.find((e) => e.file === "s3.txt")?.feature === "s3",
      "ledger entries carry their feature",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 7. Templates — tokens, survival, and the shipped set
// ---------------------------------------------------------------------------
console.log("\ntemplates:");
{
  const rendered = renderTemplateString(
    "id=__HATCHKIT_BUNDLE_ID__ secret=${{ secrets.FOO }} ci=__APPLE_TEAM_ID__ miss=__HATCHKIT_NOPE__",
    { BUNDLE_ID: "com.acme.app" },
  );
  assert(rendered.includes("id=com.acme.app"), "known token substituted");
  assert(rendered.includes("${{ secrets.FOO }}"), "a workflow expression survives");
  assert(rendered.includes("__APPLE_TEAM_ID__"), "a CI-time placeholder survives");
  // An unknown token is left in place so a partial render is greppable
  // rather than shipping a plausible file with a hole in it.
  assert(rendered.includes("__HATCHKIT_NOPE__"), "unknown token left verbatim");
  assert(findUnrenderedTokens(rendered).join(",") === "__HATCHKIT_NOPE__", "and is detectable");

  // A value containing regex metacharacters must land literally.
  assert(
    renderTemplateString("x=__HATCHKIT_A__", { A: "$&\\1" }).endsWith("x=$&\\1"),
    "substitution is literal, not a regex replacement",
  );

  const ids = resolveIdentifiers({ name: "acme-app", shortName: "Acme", orgDomain: "acme.com" });
  const tokens = identifierTemplateTokens(ids);
  assert(tokens.BUNDLE_ID === "com.acme.acmeapp", "identifier tokens come from the frozen set");
  assert(tokens.APP_NAME === ids.shortName, "APP_NAME alias is the launcher label");
  assert(tokens.DESKTOP_ORIGIN === "app://-", "desktop origin is a full origin");

  // Every template the signing feature actually ships must render with
  // no leftovers when given the identifier token set plus its own two.
  const shipped = listFeatureTemplates("signing");
  assert(shipped.length > 0, `signing templates found in ${getFeatureTemplateDir("signing")}`);
  for (const rel of shipped) {
    const out = renderFeatureTemplate("signing", rel, {
      ...tokens,
      PNPM_VERSION: "10.33.2",
      NODE_VERSION: "24",
    });
    assert(findUnrenderedTokens(out).length === 0, `${rel} leaves ${findUnrenderedTokens(out)}`);
  }

  let threw = false;
  try {
    renderFeatureTemplate("signing", "does/not/exist.yml", {});
  } catch (err) {
    threw = (err as Error).message.includes("cli/src/templates/");
  }
  assert(threw, "a missing template names the directory it must live in");
}

if (failed === 0) {
  console.log("\ntest-feature-contract: ok");
  process.exit(0);
} else {
  console.error(`\ntest-feature-contract: ${failed} assertion(s) failed`);
  process.exit(1);
}
