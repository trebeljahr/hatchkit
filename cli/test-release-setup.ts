/**
 * The `release` feature applied through the feature contract: what lands
 * in a project, what a dry run does, what a re-run does, and what
 * happens to a file the user has edited.
 *
 * Everything here goes through a real `FeatureLedger` and the real
 * `apply`, because the contract's two invariants are the things most
 * worth pinning and a helper that wrote files itself would pass while
 * the shipped path was broken:
 *
 *   Additive     the feature writes its own files and merges into
 *                package.json add-only. A script the user changed is
 *                reported as a conflict, never replaced.
 *   Idempotent   a second apply on an unchanged project writes nothing.
 *                `update` re-applies every selected feature on every
 *                run, so a feature that fails this corrupts a project a
 *                little more each time.
 *
 * It also checks the generated YAML parses, the generated docs say what
 * the scope requires them to say, and a project with only a web deploy
 * still gets a small useful version of all of it.
 *
 * Run: pnpm --filter hatchkit test:release-setup
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FeatureLedger } from "./src/features/contract.js";
import {
  buildReleaseConfig,
  configFor,
  derivationInputFromProject,
  releaseAudit,
  releaseFeature,
  renderCredentialsDoc,
  renderReleasingDoc,
} from "./src/features/release/index.js";
import { RELEASE_CONFIG_FILENAME } from "./src/features/release/types.js";
import { legacyIdentifiers } from "./src/scaffold/identifiers.js";
import type { ProjectManifest } from "./src/scaffold/manifest.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
function section(name: string): void {
  console.log(`\n${name}`);
}

interface Facts {
  name: string;
  features: string[];
  surfaces?: ProjectManifest["surfaces"];
  deploymentMode?: ProjectManifest["deploymentMode"];
  signing?: { enabled: boolean; platforms: string[] };
}

/** Apply the feature the way `hatchkit update` does: one ledger, one
 *  context, one `apply`. */
async function apply(projectDir: string, facts: Facts, opts: { dryRun?: boolean } = {}) {
  const ledger = new FeatureLedger(projectDir, opts.dryRun ?? false);
  ledger.scopeTo("release");
  const ctx = {
    projectDir,
    manifestDir: projectDir,
    manifest: {
      name: facts.name,
      features: facts.features,
      surfaces: facts.surfaces,
      deploymentMode: facts.deploymentMode,
      signing: facts.signing,
    } as unknown as ProjectManifest,
    identifiers: legacyIdentifiers(facts.name),
    mode: "update" as const,
    ledger,
    log: () => {},
  };
  await releaseFeature.apply(ctx);
  return { audit: releaseAudit(ctx, configFor(ctx)), ledger, ctx };
}

const root = mkdtempSync(join(tmpdir(), "hatchkit-release-"));
const write = (relative: string, contents: string) => {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf-8");
};
const read = (relative: string) => readFileSync(join(root, relative), "utf-8");
const exists = (relative: string) => {
  try {
    statSync(join(root, relative));
    return true;
  } catch {
    return false;
  }
};

const OWNED = [
  RELEASE_CONFIG_FILENAME,
  "scripts/release.mjs",
  "scripts/release-status.mjs",
  "scripts/release-policy-check.mjs",
  "scripts/release-version-sync.test.mjs",
  "scripts/lib/release-config.mjs",
  "scripts/lib/release-plan.mjs",
  "scripts/lib/release-policy.mjs",
  "scripts/lib/release-status.mjs",
  ".github/workflows/release-summary.yml",
  "docs/releasing.md",
  "docs/release-credentials.md",
];

try {
  write(
    "package.json",
    `${JSON.stringify(
      { name: "demo", version: "1.2.3", private: true, scripts: { "test:unit": "node --test" } },
      null,
      2,
    )}\n`,
  );
  write("pnpm-lock.yaml", "");
  write("Dockerfile", "FROM node:24\n");
  write("docker-compose.yml", "services:\n  server:\n    image: x\n");

  const FACTS: Facts = { name: "demo", features: ["desktop"], surfaces: "fullstack" };

  // ───────────────────────────────────────────────────────────────────
  section("A dry run describes the change and touches nothing");
  // ───────────────────────────────────────────────────────────────────

  const dry = await apply(root, FACTS, { dryRun: true });
  assert(
    dry.ledger.summary()["would-write"].length > 0,
    "a dry run reports what it would write",
  );
  assert(dry.ledger.summary().written.length === 0, "a dry run writes nothing");
  for (const owned of OWNED) {
    assert(!exists(owned), `a dry run did not create ${owned}`);
  }
  assert(
    JSON.parse(read("package.json")).scripts.release === undefined,
    "a dry run adds no package.json script",
  );

  // ───────────────────────────────────────────────────────────────────
  section("The first real run");
  // ───────────────────────────────────────────────────────────────────

  const first = await apply(root, FACTS);
  assert(first.audit.ok, "the first run records no conflict");
  assert(first.audit.channels.length > 0, "the run reports the channels it derived");
  for (const owned of OWNED) {
    assert(exists(owned), `the run installs ${owned}`);
  }

  const pkg = JSON.parse(read("package.json"));
  assert(pkg.scripts.release === "node scripts/release.mjs", "the cut command is a package script");
  assert(
    pkg.scripts["release:status"] === "node scripts/release-status.mjs",
    "the status command is a package script",
  );
  assert(
    pkg.scripts["test:version-sync"]?.includes("release-version-sync.test.mjs"),
    "the version-sync test is a package script",
  );
  assert(
    pkg.scripts["test:unit"] === "node --test",
    "the project's own test script is left exactly as the user wrote it",
  );
  assert(
    read("scripts/release.mjs").includes("release-version-sync.test.mjs"),
    "the cut command runs the version-sync test itself, since nothing rewrote the user's test script",
  );

  assert(
    OWNED.filter((owned) => owned.startsWith("docs/")).every((owned) =>
      /generated/i.test(read(owned).split("\n").slice(0, 8).join("\n")),
    ),
    "every generated document says it is generated, before a reader starts editing it",
  );

  // ───────────────────────────────────────────────────────────────────
  section("The emitted scripts parse");
  // ───────────────────────────────────────────────────────────────────

  for (const script of OWNED.filter((owned) => owned.endsWith(".mjs"))) {
    let ok = true;
    try {
      execFileSync(process.execPath, ["--check", join(root, script)], { stdio: "pipe" });
    } catch {
      ok = false;
    }
    assert(ok, `${script} is syntactically valid JavaScript`);
  }

  // ───────────────────────────────────────────────────────────────────
  section("The version-sync test runs, and fails on a drifted copy");
  // ───────────────────────────────────────────────────────────────────

  const runVersionSync = (): { code: number; output: string } => {
    try {
      const output = execFileSync(
        process.execPath,
        ["--test", "scripts/release-version-sync.test.mjs"],
        { cwd: root, encoding: "utf-8", stdio: "pipe" },
      );
      return { code: 0, output };
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  const clean = runVersionSync();
  assert(clean.code === 0, `an in-sync project passes version-sync\n${clean.output.slice(0, 600)}`);

  write("android/app/build.gradle", 'android {\n  versionCode 7\n  versionName "1.2.2"\n}\n');
  await apply(root, { ...FACTS, features: ["desktop", "mobile"] });
  const drifted = runVersionSync();
  assert(drifted.code !== 0, "a drifted version copy fails version-sync");
  assert(/build\.gradle/.test(drifted.output), "the failure names the file that drifted");

  write("android/app/build.gradle", 'android {\n  versionCode 7\n  versionName "1.2.3"\n}\n');
  assert(runVersionSync().code === 0, "fixing the copy makes version-sync pass again");

  // ───────────────────────────────────────────────────────────────────
  section("Adding a surface adds its rows");
  // ───────────────────────────────────────────────────────────────────

  const withMobile = JSON.parse(read(RELEASE_CONFIG_FILENAME));
  assert(
    withMobile.channels.some((channel: { id: string }) => channel.id === "mobile"),
    "adding the mobile feature adds a mobile channel to the config",
  );
  assert(
    read(".github/workflows/release-summary.yml").includes("Mobile Release"),
    "the summary workflow now watches the mobile workflow",
  );

  // ───────────────────────────────────────────────────────────────────
  section("Idempotent: an unchanged re-run writes nothing");
  // ───────────────────────────────────────────────────────────────────

  const again = await apply(root, { ...FACTS, features: ["desktop", "mobile"] });
  const wrote = again.ledger.summary().written;
  assert(wrote.length === 0, `an unchanged re-run writes nothing (wrote: ${wrote.join(", ")})`);
  assert(again.ledger.summary().unchanged.length > 0, "it reports what it left alone");
  assert(!again.ledger.touched, "an unchanged re-run reports the project as untouched");

  // ───────────────────────────────────────────────────────────────────
  section("Additive: a script the user changed is reported, not replaced");
  // ───────────────────────────────────────────────────────────────────

  const customised = JSON.parse(read("package.json"));
  customised.scripts.release = "node scripts/release.mjs --skip-tests";
  write("package.json", `${JSON.stringify(customised, null, 2)}\n`);

  const afterEdit = await apply(root, { ...FACTS, features: ["desktop", "mobile"] });
  assert(
    JSON.parse(read("package.json")).scripts.release === "node scripts/release.mjs --skip-tests",
    "a package script the user changed keeps their value",
  );
  assert(!afterEdit.audit.ok, "the run reports that something was not applied");
  assert(
    afterEdit.audit.conflicts.some((conflict) => conflict.includes("package.json")),
    "the conflict names package.json so the user can decide",
  );

  // An owned file is regenerated on purpose; its own header says so.
  write("docs/releasing.md", `${read("docs/releasing.md")}\n\nOur team posts in #releases.\n`);
  await apply(root, { ...FACTS, features: ["desktop", "mobile"] });
  assert(
    !read("docs/releasing.md").includes("#releases"),
    "a generated document is regenerated — it is hatchkit's file, not a merge target",
  );
  assert(
    /lost|overwritten|regenerated/i.test(read("docs/releasing.md").split("\n").slice(0, 8).join(" ")),
    "and it warned about exactly that, at the top, before anyone edited it",
  );

  // ───────────────────────────────────────────────────────────────────
  section("The generated workflows are valid YAML");
  // ───────────────────────────────────────────────────────────────────

  for (const workflow of [".github/workflows/release-summary.yml", ".github/workflows/compat.yml"]) {
    if (!exists(workflow)) continue;
    const text = read(workflow);
    assert(!text.includes("\t"), `${workflow} has no tab characters`);
    assert(!/[ \t]+$/m.test(text.replace(/\n$/, "")), `${workflow} has no trailing whitespace`);
    assert(/^name:\s*\S/m.test(text), `${workflow} declares a name`);
    assert(/^on:/m.test(text), `${workflow} declares a trigger`);
    assert(/^jobs:/m.test(text), `${workflow} declares jobs`);
    for (const line of text.split("\n")) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      const indent = line.length - line.trimStart().length;
      assert(
        indent % 2 === 0,
        `${workflow}: indentation is a multiple of two (${JSON.stringify(line.slice(0, 40))})`,
      );
    }
  }

  // A compat workflow that calls a script nothing installs fails on its
  // first run.
  if (exists(".github/workflows/compat.yml")) {
    const compatYaml = read(".github/workflows/compat.yml");
    for (const script of new Set(
      [...compatYaml.matchAll(/(scripts\/[\w.-]+\.sh)/g)].map((match) => match[1]),
    )) {
      assert(exists(script), `the compat workflow's ${script} is installed alongside it`);
      // Invoked through `bash`, so a fresh clone runs it whether or not
      // the exec bit survived. The ledger writes files, not modes.
      assert(
        new RegExp(`bash\\s+${script}`).test(compatYaml),
        `${script} is invoked through bash, so no exec bit is needed`,
      );
    }
  }

  const summary = read(".github/workflows/release-summary.yml");
  assert(summary.includes("workflow_run"), "the summary workflow is started by other workflows");
  const permissionBlock =
    summary
      .split(/^permissions:$/m)[1]
      ?.split(/^\S/m)[0]
      ?.split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")) ?? [];
  assert(permissionBlock.length > 0, "the summary workflow declares its permissions");
  assert(
    permissionBlock.every((line) => line.endsWith(": read")),
    `the summary workflow takes only read permissions (${permissionBlock.join(", ")})`,
  );
  assert(
    !/\$\{\{\s*secrets\./.test(summary),
    "the summary workflow references no repo secret — it reads public run metadata",
  );
  assert(
    summary.includes("release-status.mjs"),
    "the summary workflow runs the same status script a person runs locally",
  );

  // ───────────────────────────────────────────────────────────────────
  section("The generated documentation says what the scope requires");
  // ───────────────────────────────────────────────────────────────────

  const config = buildReleaseConfig(
    derivationInputFromProject(root, {
      name: "demo",
      identifiers: legacyIdentifiers("demo"),
      features: ["desktop", "mobile"],
      surfaces: "fullstack",
    }),
    { cliVersion: "0.0.0-test", generatedAt: "2026-01-01T00:00:00.000Z" },
  );
  const credentialsDoc = renderCredentialsDoc(config);
  const releasingDoc = renderReleasingDoc(config);

  for (const group of config.credentials) {
    for (const secret of group.secrets) {
      assert(credentialsDoc.includes(secret.name), `the credentials doc lists ${secret.name}`);
    }
    assert(
      credentialsDoc.includes(group.absentNote.split(".")[0]),
      `the credentials doc says what happens without ${group.label}'s secrets`,
    );
    for (const step of group.manualSteps) {
      assert(
        credentialsDoc.includes(step),
        `the credentials doc lists the manual step: ${step.slice(0, 40)}`,
      );
    }
  }
  for (const channel of config.channels) {
    assert(releasingDoc.includes(channel.label), `the releasing doc lists ${channel.label}`);
  }
  assert(
    config.policy.rules.every(
      (rule) => releasingDoc.includes(rule.id) || releasingDoc.includes(rule.message.slice(0, 30)),
    ),
    "the releasing doc explains every policy rule in force",
  );

  for (const doc of [credentialsDoc, releasingDoc]) {
    for (const word of [
      "seamless",
      "powerful",
      "effortless",
      "revolutionary",
      "game-changing",
      "supercharge",
      "designed to",
      "the future of",
    ]) {
      assert(!new RegExp(word, "i").test(doc), `the generated docs avoid "${word}"`);
    }
  }

  // ───────────────────────────────────────────────────────────────────
  section("A web-only project still gets a useful version of this");
  // ───────────────────────────────────────────────────────────────────

  const small = mkdtempSync(join(tmpdir(), "hatchkit-release-small-"));
  try {
    writeFileSync(
      join(small, "package.json"),
      `${JSON.stringify({ name: "small", version: "0.1.0", private: true }, null, 2)}\n`,
    );
    const smallRun = await apply(small, {
      name: "small",
      features: [],
      surfaces: "static",
      deploymentMode: "gh-pages",
    });
    assert(smallRun.audit.ok, "a web-only project applies without a conflict");
    assert(
      smallRun.audit.written.includes("docs/releasing.md"),
      "a web-only project still gets a releasing doc",
    );
    const smallCredentials = readFileSync(join(small, "docs/release-credentials.md"), "utf-8");
    assert(
      smallCredentials.split("\n").filter((line) => line.startsWith("#")).length <= 4,
      "a project needing no credentials gets a short doc, not an empty skeleton",
    );
    const smallConfig = JSON.parse(readFileSync(join(small, RELEASE_CONFIG_FILENAME), "utf-8"));
    assert(smallConfig.compat === null, "a web-only project gets no compat workflow");
    assert(
      !readFileSync(join(small, ".github/workflows/release-summary.yml"), "utf-8").includes(
        "Desktop",
      ),
      "a web-only project's summary workflow mentions no surface it does not have",
    );
  } finally {
    rmSync(small, { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\n✓ release setup");
