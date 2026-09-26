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

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type { RunI18nSetupOptions } from "./src/features/i18n/index.js";
import type { Feature, ProjectConfig } from "./src/prompts.js";
import { scaffoldApp } from "./src/scaffold/app.js";
import { readManifest } from "./src/scaffold/manifest.js";
import { runUpdate } from "./src/scaffold/update.js";
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

function cfg(
  name: string,
  features: Feature[],
  overrides: Partial<ProjectConfig> = {},
): ProjectConfig {
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
  assert(
    KNOWN_FEATURES.includes("i18n"),
    "`i18n` is a KNOWN_FEATURES value (so --features i18n parses)",
  );
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

    assert(
      first.added.includes("i18n"),
      `the run reports i18n added (added: ${first.added.join(", ")})`,
    );
    assert(!first.skipped.includes("i18n"), `i18n is not in skipped (${first.skipped.join(", ")})`);
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

// ---------------------------------------------------------------------------
// 5. `--dry-run` itemises the feature's files, and writes none of them.
//
//    The feature is registered against the shared contract
//    (features/i18n/definition.ts), so `plannedFilesFor` in update.ts asks
//    the registry for its plan instead of returning [] the way it does for
//    a feature it has no table for. The plan is read off plan.ts, which is
//    the single source of truth for template → destination — so this also
//    pins that the dry run cannot describe a file set the apply would not
//    write.
//
//    The other half is the older promise: a dry run touches nothing. That
//    is enforced in update.ts by the early return before the feature-apply
//    loop, and here by comparing a full tree snapshot.
// ---------------------------------------------------------------------------
console.log("\n── update --dry-run: itemised, and writes nothing ──────────────────────────");
{
  const d = mkdtempSync(join(tmpdir(), "i18n-update-dry-"));
  try {
    await scaffoldApp(cfg("i18n-dry-test", ["websocket"]), d);

    /** Every file under `dir`, path → contents, so a stray write shows up. */
    const snapshot = (dir: string): Map<string, string> => {
      const out = new Map<string, string>();
      const stack = [dir];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        for (const entry of readdirSync(cur)) {
          if (entry === "node_modules" || entry === ".git") continue;
          const full = join(cur, entry);
          if (statSync(full).isDirectory()) stack.push(full);
          else out.set(relative(dir, full), readFileSync(full, "utf-8"));
        }
      }
      return out;
    };

    const before = snapshot(d);

    // Capture what the dry run printed, which is the itemisation itself.
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    let run: Awaited<ReturnType<typeof runUpdate>>;
    try {
      run = await runUpdate(d, {
        dryRun: true,
        presets: {
          desiredFeatures: ["websocket", "i18n"],
          confirmAddFeatures: true,
          enableLocalDev: false,
          pushNativeOrigins: false,
          i18n: I18N_PRESETS,
        },
      });
    } finally {
      console.log = realLog;
    }

    assert(run.dryRun === true, "the run reports itself as a dry run");
    assert(run.added.includes("i18n"), `…and names i18n as a would-add (${run.added.join(", ")})`);

    // The itemisation. Strip ANSI so the assertions read the text.
    const printed = lines.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""));
    const itemised = printed
      .filter((l) => l.trimStart().startsWith("+ "))
      .map((l) => l.trim().slice(2));
    assert(itemised.length > 30, `the dry run itemises the i18n files (${itemised.length} listed)`);
    // A handful of specific paths, one per axis the plan expands over, so
    // an itemisation that silently lost a gate or a locale is caught.
    for (const rel of [
      "packages/client/src/i18n/store.ts",
      "packages/client/src/i18n/messages/en/common.ts",
      "packages/client/src/i18n/messages/de/common.ts",
      "packages/client/src/app/de/page.tsx",
      "packages/server/src/i18n/resolve.ts",
      "docs/i18n.md",
    ]) {
      assert(itemised.includes(rel), `the itemisation names ${rel}`);
    }

    // And nothing was written. This is the invariant the itemisation must
    // not have cost: the plan is DECLARED by the feature, never obtained by
    // running its apply against a dry ledger.
    const after = snapshot(d);
    const changed = [...after.keys()].filter((k) => after.get(k) !== before.get(k));
    const appeared = [...after.keys()].filter((k) => !before.has(k));
    const vanished = [...before.keys()].filter((k) => !after.has(k));
    assert(
      changed.length === 0 && appeared.length === 0 && vanished.length === 0,
      `the dry run left the tree byte-identical (changed: ${changed.length}, new: ${appeared.length}, gone: ${vanished.length}${appeared.length ? ` — ${appeared.slice(0, 5).join(", ")}` : ""})`,
    );
    assert(readManifest(d)?.features.includes("i18n") === false, "…and did not record the feature");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 6. The registered feature's own `apply`.
//
//    `runI18nSetup` is the interactive front door; this is the other entry
//    point — the one `applyFeatures` uses, which reads the config back off
//    `manifest.i18n` rather than prompting. The two share
//    `applyI18nConfig`, and the contract demands the same two things of
//    this path as of any feature: a second apply writes nothing, and a dry
//    apply writes nothing at all.
// ---------------------------------------------------------------------------
console.log("\n── the registered apply: idempotent, and dry-runnable ──────────────────────");
{
  const d = mkdtempSync(join(tmpdir(), "i18n-apply-"));
  try {
    await scaffoldApp(cfg("i18n-apply-test", ["i18n"]), d);
    const manifest = readManifest(d);
    assert(manifest !== null, "the fixture has a manifest");
    if (manifest === null) throw new Error("no manifest");

    // `create` recorded the answers, which is what makes a non-prompting
    // re-apply possible at all.
    assert(
      manifest.i18n?.sourceLocale === "en" && manifest.i18n?.targetLocales.includes("de"),
      `the manifest records the languages (${JSON.stringify(manifest.i18n)})`,
    );

    const { FeatureLedger, applyFeatures, getFeature } = await import("./src/features/contract.js");
    await import("./src/features/i18n/definition.js");
    const { legacyIdentifiers } = await import("./src/scaffold/identifiers.js");
    /** Same fallback update.ts uses: the frozen set when the manifest
     *  carries one, the old derivation when it predates v5. */
    const idsFor = (m: NonNullable<typeof manifest>) => m.identifiers ?? legacyIdentifiers(m.name);

    const def = getFeature("i18n");
    assert(def !== undefined, "i18n is in the feature registry");
    assert(def?.addableAfterScaffold === true, "…and declares itself addable after scaffold");

    const ctx = {
      projectDir: d,
      manifestDir: d,
      manifest,
      identifiers: idsFor(manifest),
      mode: "update" as const,
      log: () => {},
    };

    // The app's display name in the generated catalogs is the FROZEN
    // product name — not the starter's placeholder title, and not the raw
    // slug. This is the "never derive a name" rule, and it used to be
    // broken in a way only a re-apply could show: `create` runs the
    // generator before the manifest is written, so detection fell through
    // to the starter's "My App"; a later re-apply found the manifest and
    // rendered the slug instead, rewriting nine generated files.
    {
      const ids = idsFor(manifest);
      const marketing = readFileSync(
        join(d, "packages/client/src/i18n/messages/en/marketing.ts"),
        "utf-8",
      );
      assert(
        marketing.includes(ids.productName),
        `the catalogs name the product (${ids.productName})`,
      );
      assert(!marketing.includes("My App"), "…not the starter's placeholder title");
      assert(
        !new RegExp(`Welcome to ${manifest.name}\\b`).test(marketing),
        `…and not the raw slug (${manifest.name})`,
      );
    }

    // Its declared plan must name files that are really there — the tree
    // was just generated from the same table.
    const planned = def?.plannedFiles?.(ctx) ?? [];
    const notThere = planned.filter((rel) => !existsSync(join(d, rel)));
    assert(planned.length > 30, `plannedFiles declares ${planned.length} paths`);
    assert(
      notThere.length === 0,
      `every declared path exists after a create${notThere.length ? ` (missing: ${notThere.slice(0, 5).join(", ")})` : ""}`,
    );

    // A real re-apply changes nothing: the invariant `update` depends on,
    // since it re-applies every selected feature on every run.
    const real = new FeatureLedger(d, false);
    await applyFeatures(["i18n"], { ...ctx, ledger: real });
    const wrote = real.summary().written;
    assert(
      wrote.length === 0,
      `a re-apply writes 0 files (got ${wrote.length}${wrote.length ? `: ${wrote.slice(0, 5).join(", ")}` : ""})`,
    );
    assert(
      real.summary().unchanged.length > 30,
      `…and reports the tree unchanged (${real.summary().unchanged.length} files)`,
    );

    // A dry apply against a project that does NOT have the feature is the
    // case that matters: it must report `would-write` and touch nothing.
    const fresh = mkdtempSync(join(tmpdir(), "i18n-apply-dry-"));
    try {
      await scaffoldApp(cfg("i18n-apply-dry", []), fresh);
      const freshManifest = readManifest(fresh);
      if (freshManifest === null) throw new Error("no manifest");
      assert(
        !existsSync(join(fresh, "packages/client/src/i18n/store.ts")),
        "the fresh fixture has no i18n tree",
      );
      const dry = new FeatureLedger(fresh, true);
      await applyFeatures(["i18n"], {
        projectDir: fresh,
        manifestDir: fresh,
        manifest: freshManifest,
        identifiers: idsFor(freshManifest),
        mode: "update" as const,
        log: () => {},
        ledger: dry,
      });
      assert(
        dry.summary()["would-write"].length > 30,
        `a dry apply reports would-write (${dry.summary()["would-write"].length} files)`,
      );
      assert(
        dry.summary().written.length === 0,
        `…and nothing as written (${dry.summary().written.length})`,
      );
      assert(
        !existsSync(join(fresh, "packages/client/src/i18n/store.ts")),
        "…and the file it would have written is not on disk",
      );
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }

    // A backend surface has no client to localise, and the declared plan
    // has to say so: the apply narrows to the server + shared halves and
    // redirects the translator's glossary beside the catalogs that exist.
    // A plan naming `packages/client/...` there would describe files the
    // apply deliberately refuses to write.
    const backend = mkdtempSync(join(tmpdir(), "i18n-apply-backend-"));
    try {
      await scaffoldApp(cfg("i18n-apply-backend", [], { surfaces: "backend" }), backend);
      const bm = readManifest(backend);
      if (bm === null) throw new Error("no manifest");
      const declared =
        getFeature("i18n")?.plannedFiles?.({
          projectDir: backend,
          manifestDir: backend,
          manifest: bm,
          identifiers: idsFor(bm),
        }) ?? [];
      assert(declared.length > 0, `the backend plan names ${declared.length} files`);
      assert(
        declared.every((rel) => !rel.startsWith("packages/client/")),
        `…none of them under packages/client (${declared
          .filter((r) => r.startsWith("packages/client/"))
          .slice(0, 3)
          .join(", ")})`,
      );
      assert(
        declared.some((rel) => rel.startsWith("packages/server/src/i18n/")),
        "…and the server catalogs are named",
      );
      assert(
        declared.some((rel) => /^packages\/server\/src\/i18n\/GLOSSARY\./.test(rel)),
        "…with the glossary redirected beside them",
      );

      // And the plan agrees with what an apply actually writes. Anything
      // written that the plan did not name has to be one of the anchored
      // EDITS to a file the starter already shipped — which the plan
      // excludes on purpose — so the test is that it existed beforehand,
      // not that the list is empty.
      const existedBefore = new Set<string>();
      for (const rel of [
        "packages/shared/src/index.ts",
        "packages/shared/package.json",
        "packages/shared/src/schemas.ts",
        "packages/server/src/models/Profile.ts",
        "packages/server/src/trpc/routers/profile.ts",
        "packages/server/package.json",
        "packages/client/src/app/layout.tsx",
        "packages/client/src/styles/globals.css",
        "packages/client/package.json",
      ]) {
        if (existsSync(join(backend, rel))) existedBefore.add(rel);
      }
      const bl = new FeatureLedger(backend, false);
      await applyFeatures(["i18n"], {
        projectDir: backend,
        manifestDir: backend,
        manifest: bm,
        identifiers: idsFor(bm),
        mode: "update" as const,
        log: () => {},
        ledger: bl,
      });
      const unaccounted = bl
        .summary()
        .written.filter((rel) => !declared.includes(rel) && !existedBefore.has(rel));
      assert(
        unaccounted.length === 0,
        `every file written is either in the plan or an edit to one that was already there${unaccounted.length ? ` (unaccounted: ${unaccounted.slice(0, 5).join(", ")})` : ""}`,
      );
      const plannedButUnwritten = declared.filter((rel) => !existsSync(join(backend, rel)));
      assert(
        plannedButUnwritten.length === 0,
        `and every planned file is on disk afterwards${plannedButUnwritten.length ? ` (missing: ${plannedButUnwritten.join(", ")})` : ""}`,
      );
    } finally {
      rmSync(backend, { recursive: true, force: true });
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

console.log(failed === 0 ? "\nAll i18n update tests passed.\n" : `\n${failed} check(s) failed.\n`);
process.exit(failed > 0 ? 1 : 0);
