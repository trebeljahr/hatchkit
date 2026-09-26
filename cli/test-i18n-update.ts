/**
 * `hatchkit update` → add i18n.
 *
 * The feature has to be ADDITIVE: a project that already picked websocket and
 * mobile keeps them, the manifest records the new one, and running update
 * again is a no-op. i18n is also the one addition that copies nothing out of
 * the starter — the starter is single-language — so this is the path where a
 * generator-shaped feature meets a command written for copy-shaped ones.
 *
 * Two failure modes worth pinning:
 *
 *   · The manifest claiming a language the project has no files for. A
 *     refused run must not record the feature, or the next `update` treats it
 *     as present and never writes anything.
 *   · A second run re-writing files. `hatchkit update` is the canonical
 *     retrofit path after a hatchkit upgrade, so it gets run repeatedly on
 *     projects people are working in.
 *
 * Runs entirely offline: `pushNativeOrigins: false` keeps the Coolify check
 * out of it, `enableLocalDev: false` skips the Tailscale opt-in, and the i18n
 * presets answer every prompt.
 *
 * Run: pnpm --filter hatchkit test:i18n-update
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunI18nSetupOptions } from "./src/features/i18n/index.js";
import type { Feature, ProjectConfig } from "./src/prompts.js";
import { readManifest } from "./src/scaffold/manifest.js";
import { runUpdate } from "./src/scaffold/update.js";
import { scaffoldApp } from "./src/scaffold/app.js";
import { KNOWN_FEATURES } from "./src/utils/flags.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

function cfg(name: string, features: Feature[], overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name,
    domain: `${name}.example.com`,
    baseDomain: "example.com",
    subdomain: name,
    surfaces: "fullstack",
    deploymentMode: "coolify",
    deployTarget: "existing",
    serverId: 1,
    serverIp: "1.2.3.4",
    features,
    provisionServices: [],
    s3Provider: "none",
    mlServices: [],
    forceRedeployMl: [],
    scaffoldRepo: true,
    createGithubRepo: false,
    installDeps: false,
    runDeployment: false,
    dryRun: false,
    ...overrides,
  };
}

const I18N_PRESETS: RunI18nSetupOptions["presets"] = {
  sourceLocale: "en",
  targetLocales: ["de"],
  publicPages: true,
  serverCatalogs: true,
  pseudoLocale: true,
  confirm: true,
};

/** Files that prove the generator ran, one per half of the feature. */
const MARKERS = [
  "packages/client/src/i18n/store.ts",
  "packages/client/src/i18n/use-t.ts",
  "packages/client/src/i18n/messages/de/common.ts",
  "packages/client/src/i18n/GLOSSARY.de.md",
  "packages/client/src/app/pre-paint.ts",
  "packages/client/src/app/de/page.tsx",
  "packages/shared/src/locale.ts",
  "packages/server/src/i18n/resolve.ts",
  "docs/i18n.md",
];

// ---------------------------------------------------------------------------
// 0. The feature is offerable at all. `--features i18n` has to parse, or the
//    non-interactive path cannot reach any of this.
// ---------------------------------------------------------------------------
console.log("\n── the feature is wired into the flag surface ───────────────────────────────");
{
  assert(KNOWN_FEATURES.includes("i18n"), "`i18n` is a KNOWN_FEATURES value (so --features i18n parses)");
}

// ---------------------------------------------------------------------------
// 1. Additive on a project that already has features.
// ---------------------------------------------------------------------------
console.log("\n── update: add i18n to an existing project ─────────────────────────────────");
{
  const d = mkdtempSync(join(tmpdir(), "i18n-update-"));
  try {
    await scaffoldApp(cfg("i18n-add-test", ["websocket"]), d);
    const before = readManifest(d);
    assert(before?.features.includes("websocket") === true, "fixture starts with websocket");
    assert(before?.features.includes("i18n") === false, "…and without i18n");

    const first = await runUpdate(d, {
      presets: {
        desiredFeatures: ["websocket", "i18n"],
        confirmAddFeatures: true,
        enableLocalDev: false,
        pushNativeOrigins: false,
        i18n: I18N_PRESETS,
      },
    });

    assert(first.added.includes("i18n"), `the run reports i18n added (added: ${first.added.join(", ")})`);
    assert(
      !first.skipped.includes("i18n"),
      `i18n is not in skipped (${first.skipped.join(", ")})`,
    );
    assert(first.removed.length === 0, "nothing is reported removed");

    const missing = MARKERS.filter((rel) => !existsSync(join(d, rel)));
    assert(
      missing.length === 0,
      `the generated files landed${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`,
    );

    // The rewrites reached the project's own files, not just the new ones.
    const layout = readFileSync(join(d, "packages/client/src/app/layout.tsx"), "utf-8");
    assert(layout.includes("LOCALE_SCRIPT"), "the project's layout was wired");
    assert(
      /<div data-locale-gate>/.test(layout) &&
        !(layout.match(/<body[^>]*>/)?.[0] ?? "").includes("data-locale-gate"),
      "the gate is on a wrapper inside <body>, not on <body>",
    );

    const after = readManifest(d);
    assert(after?.features.includes("i18n") === true, "the manifest records i18n");
    assert(after?.features.includes("websocket") === true, "…and keeps websocket");
    assert(
      after?.features.length === (before?.features.length ?? 0) + 1,
      `exactly one feature was added (${after?.features.join(", ")})`,
    );
    // A generator-shaped feature must not have claimed a native HMR port.
    assert(after?.ports.nativeHmr === undefined, "i18n claims no native HMR port");

    // 2. The second run is a no-op.
    const second = await runUpdate(d, {
      presets: {
        desiredFeatures: ["websocket", "i18n"],
        confirmAddFeatures: true,
        enableLocalDev: false,
        pushNativeOrigins: false,
        i18n: I18N_PRESETS,
      },
    });
    assert(
      !second.added.includes("i18n"),
      `a second run does not re-add i18n (added: ${second.added.join(", ")})`,
    );
    const layoutAgain = readFileSync(join(d, "packages/client/src/app/layout.tsx"), "utf-8");
    assert(layoutAgain === layout, "the layout is byte-identical after the second run");
    const manifestAgain = readManifest(d);
    assert(
      JSON.stringify(manifestAgain?.features) === JSON.stringify(after?.features),
      "the manifest feature list is unchanged",
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3. A backend-only project. There is no client to localise, so the run must
//    write what it can and REFUSE to record the feature — a manifest that
//    claims a language the project has no files for is worse than no
//    manifest entry, because the next update treats it as done.
// ---------------------------------------------------------------------------
console.log("\n── update: a project with no client surface ────────────────────────────────");
{
  const d = mkdtempSync(join(tmpdir(), "i18n-update-backend-"));
  try {
    await scaffoldApp(cfg("i18n-backend-test", [], { surfaces: "backend" }), d);
    assert(
      !existsSync(join(d, "packages/client/package.json")),
      "fixture really has no client package",
    );

    const run = await runUpdate(d, {
      presets: {
        desiredFeatures: ["i18n"],
        confirmAddFeatures: true,
        enableLocalDev: false,
        pushNativeOrigins: false,
        i18n: I18N_PRESETS,
      },
    });

    const manifest = readManifest(d);
    const recorded = manifest?.features.includes("i18n") === true;
    const reportedAdded = run.added.includes("i18n");
    // Whatever the command decides, the manifest and the report must agree —
    // that is the invariant. Disagreeing is how a project ends up claiming a
    // feature it does not have.
    assert(
      recorded === reportedAdded,
      `the manifest and the report agree (recorded=${recorded}, added=${reportedAdded})`,
    );
    assert(
      !existsSync(join(d, "packages/client/src/i18n/store.ts")),
      "no client files were invented for a project with no client",
    );
    // Not one stray file either. The surface prune deliberately removed
    // packages/client, so anything written back under it is a directory
    // this project was built without — and the glossary is the file most
    // likely to land there, since it is written outside the plan.
    assert(
      !existsSync(join(d, "packages/client")),
      "no packages/client directory is conjured back into existence",
    );
    // The server half must actually be there: per-document email and
    // document locales are useful without a client, which is why the run
    // applies a subset rather than refusing outright.
    for (const rel of [
      "packages/server/src/i18n/resolve.ts",
      "packages/server/src/i18n/messages/de/email.ts",
      "packages/shared/src/locale.ts",
    ]) {
      assert(existsSync(join(d, rel)), `the server half landed: ${rel}`);
    }
    // …and the translator's glossary came with it, beside the catalogs it
    // describes rather than at its planned client path.
    assert(
      existsSync(join(d, "packages/server/src/i18n/GLOSSARY.de.md")),
      "the glossary lands beside the server catalogs",
    );
    if (!reportedAdded) {
      assert(
        run.skipped.includes("i18n"),
        `a refusal is reported as skipped (${run.skipped.join(", ")})`,
      );
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. Removal is still refused. i18n touches the user's own layout and
//    schemas, so "unpick the checkbox" must not mean "delete my code".
// ---------------------------------------------------------------------------
console.log("\n── update: removal stays refused ──────────────────────────────────────────");
{
  const d = mkdtempSync(join(tmpdir(), "i18n-update-remove-"));
  try {
    await scaffoldApp(cfg("i18n-remove-test", []), d);
    await runUpdate(d, {
      presets: {
        desiredFeatures: ["i18n"],
        confirmAddFeatures: true,
        enableLocalDev: false,
        pushNativeOrigins: false,
        i18n: I18N_PRESETS,
      },
    });
    const withI18n = readManifest(d);
    assert(withI18n?.features.includes("i18n") === true, "i18n is recorded first");

    const drop = await runUpdate(d, {
      presets: {
        desiredFeatures: [],
        confirmAddFeatures: true,
        enableLocalDev: false,
        pushNativeOrigins: false,
      },
    });
    assert(drop.removed.includes("i18n"), "unpicking it is reported as a removal request");
    const still = readManifest(d);
    assert(still?.features.includes("i18n") === true, "…but the manifest keeps the feature");
    assert(
      existsSync(join(d, "packages/client/src/i18n/store.ts")),
      "…and the generated files are still on disk",
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

console.log(failed === 0 ? "\nAll i18n update tests passed.\n" : `\n${failed} check(s) failed.\n`);
process.exit(failed > 0 ? 1 : 0);
