/**
 * Deploy recovery — the client-side answer to a tab that was open before
 * a deploy and whose chunks no longer exist.
 *
 * The failure these encode: every image replaces every hashed chunk, so
 * a tab left open across a deploy 404s the first time it lazily loads a
 * route it has not visited. The person sees a blank screen for a deploy
 * they never noticed, and nothing in the pipeline can tell them about it
 * — the pipeline's job ends at the container.
 *
 * The properties that keep the cure from being worse than the disease:
 *
 *   1. Off where it makes no sense: in development (no image, no build
 *      info), in every native shell (its bundle ships inside its own
 *      package), and with no built commit (nothing to compare, so every
 *      answer would read as "deployed" and the offer would never stop).
 *   2. Throttled. The two triggers are focus and becoming visible, and
 *      both are gated on one interval — otherwise a person switching
 *      windows asks the server on every alt-tab.
 *   3. An unreadable served commit is `unknown`, never an offer. Offline,
 *      a captive portal and a proxy error page all land there, and none
 *      of them is evidence of a deploy.
 *   4. The reload is OFFERED, never taken. A page that reloads itself
 *      under a half-typed form is worse than a stale tab — so the
 *      generated component's only reload call sits in the click handler,
 *      and the module that detects the new version has none at all.
 *   5. The offer waits for writes in flight and is made when they drain:
 *      an offline queue cannot catch a write that fails during unload.
 *   6. The chunk guard allows exactly one automatic reload per window.
 *      Without it, a server that is broken rather than merely updated
 *      becomes a reload loop the person cannot read their way out of —
 *      so the generated code is asserted to carry the guard.
 *   7. `isChunkLoadFailure` recognises more than one bundler's wording,
 *      from ONE list. Matching webpack's string alone is how this check
 *      silently stops working the day the project moves to Vite — and a
 *      second, hand-kept copy inside the generated client is how it
 *      happens without anyone editing the detector at all, since the
 *      tested copy keeps passing. The generated module is rendered from
 *      the same constants, and a check here fails if it stops being.
 *   8. The build-info file is served with no caching, and the retrofit
 *      that arranges it is idempotent — a cached build-info file reports
 *      the commit the tab already has, so the offer never appears and
 *      nothing errors.
 *   9. The component is actually MOUNTED. Everything above hangs off
 *      `<DeployRecovery />` being rendered, so a project that has all
 *      the files and never mounts it has a feature that has never once
 *      run — with every file present and every other check passing,
 *      which is the quietest way for this to be broken. The mount is a
 *      retrofit: idempotent, never touching a layout that already has
 *      one, and leaving a hand-rolled layout alone with a reason.
 *  10. Idempotent, and a dry run that touches nothing. Both are
 *      properties of the ledger every write goes through rather than of
 *      this module, which is why they are asserted against a real
 *      `FeatureLedger` and never a stub. `hatchkit update` re-applies
 *      the whole operational layer on every run, so a second apply that
 *      records a write has already corrupted something — a second mount,
 *      a second headers() block — and a dry run that reaches the disk is
 *      a preview that changed the user's files.
 *  11. The error boundaries are the user's. A project may well have
 *      written its own, and replacing somebody's error screen is worse
 *      than the stale tab this closes, so they are written when absent
 *      and reported in a note when the one that is there is not wired to
 *      the guarded reload.
 *
 * No test touches the network or a real project: filesystem cases run in
 * a temp directory.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import ts from "typescript";

// Nothing here opens the config store, but a module pulled in later
// might — keep every run away from the user's real config.
process.env.HATCHKIT_CONF_DIR = mkdtempSync(join(tmpdir(), "deploy-recovery-conf-"));

const {
  CHUNK_RELOAD_STORAGE_KEY,
  DEFAULT_CHUNK_RELOAD_GUARD_MS,
  DEFAULT_VERSION_CHECK_INTERVAL_MS,
  NATIVE_SHELLS,
  claimChunkReload,
  evaluateVersion,
  isChunkLoadFailure,
  isChunkRecoveryEnabled,
  isNativeShell,
  isRecoveryEnabled,
  nativeShellsOf,
  readChunkReloadAt,
  recordChunkReload,
  shouldCheckVersion,
  shouldChunkReload,
  shouldOfferReload,
  CHUNK_ERROR_NAMES,
  CHUNK_ERROR_PATTERNS,
} = await import("./src/features/deploy-recovery/policy.js");
const {
  buildInfoWriterSource,
  chunkReloadSource,
  clientHostSource,
  clientPolicySource,
  componentSource,
  errorBoundarySource,
  globalErrorBoundarySource,
  versionCheckSource,
} = await import("./src/features/deploy-recovery/client-sources.js");
const { LAYOUT_CANDIDATES, mountRecoveryInLayout, recoveryImportSpecifier } = await import(
  "./src/features/deploy-recovery/layout.js"
);
const { BUILD_INFO_CACHE_CONTROL, upgradeNextConfig, upgradeNginxConf } = await import(
  "./src/features/deploy-recovery/serving.js"
);
const { BUILD_COMMIT_ENV_VAR, applyDeployRecovery } = await import(
  "./src/features/deploy-recovery/index.js"
);
// A real ledger, never a stub: idempotency and the dry run are
// properties OF the ledger, and a fake one would assert them away.
const { FeatureLedger } = await import("./src/features/contract.js");

const failures: string[] = [];

function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`  ✗ ${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

const SOURCE_OPTS = {
  buildInfoPath: "/version.json",
  commitEnvVar: BUILD_COMMIT_ENV_VAR,
  intervalMs: DEFAULT_VERSION_CHECK_INTERVAL_MS,
  chunkGuardMs: DEFAULT_CHUNK_RELOAD_GUARD_MS,
  chunkGuardKey: CHUNK_RELOAD_STORAGE_KEY,
};

const COMMIT = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

// ---------------------------------------------------------------------------
console.log("\nwhere recovery runs at all\n");
// ---------------------------------------------------------------------------

check("production web build with a commit is enabled", () => {
  assert.equal(isRecoveryEnabled({ mode: "production", shell: "web", builtCommit: COMMIT }), true);
});

check("development is disabled — no image, no build info to fetch", () => {
  assert.equal(
    isRecoveryEnabled({ mode: "development", shell: "web", builtCommit: COMMIT }),
    false,
  );
  assert.equal(isChunkRecoveryEnabled({ mode: "development", shell: "web" }), false);
});

check("a test run is disabled too", () => {
  assert.equal(isRecoveryEnabled({ mode: "test", shell: "web", builtCommit: COMMIT }), false);
});

check("every native shell is disabled — its bundle ships inside the app", () => {
  assert.deepEqual([...NATIVE_SHELLS], ["capacitor", "electron", "tauri"]);
  for (const shell of NATIVE_SHELLS) {
    assert.equal(
      isRecoveryEnabled({ mode: "production", shell, builtCommit: COMMIT }),
      false,
      `${shell} must not check for deploys`,
    );
    assert.equal(
      isChunkRecoveryEnabled({ mode: "production", shell }),
      false,
      `${shell} must not reload itself`,
    );
    assert.equal(isNativeShell(shell), true);
  }
});

check("an unknown host counts as web rather than disabling recovery", () => {
  assert.equal(isNativeShell("some-new-webview"), false);
});

check("an empty or blank built commit disables the version check", () => {
  assert.equal(isRecoveryEnabled({ mode: "production", shell: "web", builtCommit: "" }), false);
  assert.equal(isRecoveryEnabled({ mode: "production", shell: "web", builtCommit: "   " }), false);
});

check("the chunk half still runs on an unstamped production image", () => {
  assert.equal(isChunkRecoveryEnabled({ mode: "production", shell: "web" }), true);
});

check("manifest features map to the shells that skip recovery", () => {
  assert.deepEqual(nativeShellsOf(["mobile", "websocket", "desktop"]), ["capacitor", "electron"]);
  assert.deepEqual(nativeShellsOf(["websocket"]), []);
  // Tauri is a host the bundle can still be loaded into, but hatchkit
  // scaffolds no Tauri shell any more, so no manifest can name one.
  assert.deepEqual(nativeShellsOf(["desktop-tauri"]), []);
});

// ---------------------------------------------------------------------------
console.log("\nthe interval gate\n");
// ---------------------------------------------------------------------------

for (const trigger of ["focus", "visibility-change"] as const) {
  check(`${trigger} inside the interval does not ask`, () => {
    assert.equal(
      shouldCheckVersion({ now: 1_000, lastCheckedAt: 0, intervalMs: 5_000, trigger }),
      false,
    );
  });

  check(`${trigger} at the interval asks`, () => {
    assert.equal(
      shouldCheckVersion({ now: 5_000, lastCheckedAt: 0, intervalMs: 5_000, trigger }),
      true,
    );
  });
}

check("an unrecognised trigger never asks", () => {
  assert.equal(
    shouldCheckVersion({
      now: 60_000,
      lastCheckedAt: 0,
      intervalMs: 5_000,
      trigger: "scroll" as unknown as "focus",
    }),
    false,
  );
});

check("a clock that moved backwards counts as due, not as wedged", () => {
  assert.equal(
    shouldCheckVersion({ now: 10, lastCheckedAt: 999_999, intervalMs: 5_000, trigger: "focus" }),
    true,
  );
});

// ---------------------------------------------------------------------------
console.log("\ncomparing the served build with the running one\n");
// ---------------------------------------------------------------------------

check("the same commit is same", () => {
  assert.equal(evaluateVersion({ builtCommit: COMMIT, servedCommit: COMMIT }).outcome, "same");
});

check("a different commit is newer", () => {
  assert.equal(
    evaluateVersion({ builtCommit: COMMIT, servedCommit: "0000000111122223333" }).outcome,
    "newer",
  );
});

check("an abbreviated sha on either side is still the same build", () => {
  assert.equal(
    evaluateVersion({ builtCommit: COMMIT, servedCommit: COMMIT.slice(0, 7) }).outcome,
    "same",
  );
  assert.equal(
    evaluateVersion({ builtCommit: COMMIT.slice(0, 12), servedCommit: COMMIT }).outcome,
    "same",
  );
});

check("a prefix shorter than an abbreviated sha is not treated as a match", () => {
  assert.equal(
    evaluateVersion({ builtCommit: COMMIT, servedCommit: COMMIT.slice(0, 6) }).outcome,
    "newer",
  );
});

check("an unreadable served commit is unknown, never newer", () => {
  for (const servedCommit of [null, undefined, "", "   "]) {
    assert.equal(
      evaluateVersion({ builtCommit: COMMIT, servedCommit }).outcome,
      "unknown",
      `served ${JSON.stringify(servedCommit)} must be unknown`,
    );
  }
});

check("no built commit is unknown as well", () => {
  assert.equal(evaluateVersion({ builtCommit: "", servedCommit: COMMIT }).outcome, "unknown");
});

// ---------------------------------------------------------------------------
console.log("\noffering the reload\n");
// ---------------------------------------------------------------------------

check("an unknown outcome never offers", () => {
  assert.equal(
    shouldOfferReload({ versionOutcome: "unknown", writesInFlight: 0, alreadyOffered: false }),
    false,
  );
});

check("the same build never offers", () => {
  assert.equal(
    shouldOfferReload({ versionOutcome: "same", writesInFlight: 0, alreadyOffered: false }),
    false,
  );
});

check("a newer build on a quiet tab offers", () => {
  assert.equal(
    shouldOfferReload({ versionOutcome: "newer", writesInFlight: 0, alreadyOffered: false }),
    true,
  );
});

check("the offer is deferred while writes are in flight, and made once they drain", () => {
  assert.equal(
    shouldOfferReload({ versionOutcome: "newer", writesInFlight: 2, alreadyOffered: false }),
    false,
  );
  assert.equal(
    shouldOfferReload({ versionOutcome: "newer", writesInFlight: 0, alreadyOffered: false }),
    true,
  );
});

check("an offer already on screen is not repeated", () => {
  assert.equal(
    shouldOfferReload({ versionOutcome: "newer", writesInFlight: 0, alreadyOffered: true }),
    false,
  );
});

// ---------------------------------------------------------------------------
console.log("\nthe chunk-reload guard\n");
// ---------------------------------------------------------------------------

check("a tab that never reloaded may reload", () => {
  assert.equal(shouldChunkReload({ now: 1_000, lastReloadAt: null, guardMs: 60_000 }), true);
});

check("a second reload inside the window is refused — this is the loop guard", () => {
  assert.equal(shouldChunkReload({ now: 30_000, lastReloadAt: 1_000, guardMs: 60_000 }), false);
});

check("a reload after the window is allowed again", () => {
  assert.equal(shouldChunkReload({ now: 61_001, lastReloadAt: 1_000, guardMs: 60_000 }), true);
});

check("a garbled stored timestamp reads as never reloaded", () => {
  assert.equal(readChunkReloadAt("not-a-number"), null);
  assert.equal(readChunkReloadAt(""), null);
  assert.equal(readChunkReloadAt(null), null);
  assert.equal(readChunkReloadAt("1700000000000"), 1_700_000_000_000);
  assert.equal(recordChunkReload(17), "17");
});

function memoryStore(): { get: (k: string) => string | null; set: (k: string, v: string) => void } {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
  };
}

check("the storage pair allows one reload, refuses the next, allows one after the window", () => {
  const store = memoryStore();
  assert.equal(claimChunkReload(store, { now: 1_000, guardMs: 60_000 }), true);
  assert.equal(claimChunkReload(store, { now: 2_000, guardMs: 60_000 }), false);
  assert.equal(claimChunkReload(store, { now: 59_999, guardMs: 60_000 }), false);
  assert.equal(claimChunkReload(store, { now: 61_001, guardMs: 60_000 }), true);
});

check("the claim is written under the documented key", () => {
  const store = memoryStore();
  claimChunkReload(store, { now: 4_242 });
  assert.equal(store.get(CHUNK_RELOAD_STORAGE_KEY), "4242");
});

check("no storage means no automatic reload — a loop nobody can detect is the worst case", () => {
  assert.equal(claimChunkReload(null, { now: 1_000 }), false);
});

check("storage that throws means no automatic reload either", () => {
  const throwing = {
    get: (): string | null => {
      throw new Error("blocked site data");
    },
    set: (): void => {
      throw new Error("blocked site data");
    },
  };
  assert.equal(claimChunkReload(throwing, { now: 1_000 }), false);
});

// ---------------------------------------------------------------------------
console.log("\nrecognising a failed chunk across bundlers\n");
// ---------------------------------------------------------------------------

const CHUNK_FAILURES: Array<[string, unknown]> = [
  [
    "webpack ChunkLoadError",
    Object.assign(new Error("Loading chunk 42 failed."), {
      name: "ChunkLoadError",
    }),
  ],
  [
    "webpack CSS chunk",
    new Error("Loading CSS chunk app-layout failed.\n(/_next/static/css/a.css)"),
  ],
  [
    "vite dynamic import",
    new TypeError(
      "Failed to fetch dynamically imported module: https://app.test/assets/route-9f2.js",
    ),
  ],
  ["firefox dynamic import", new Error("error loading dynamically imported module")],
  ["safari module script", new TypeError("Importing a module script failed.")],
  ["vite css preload", new Error("Unable to preload CSS for /assets/route-9f2.css")],
  [
    "404 answered with the index document",
    new TypeError(
      'Failed to load module script: expected a JavaScript module script but the server responded with a MIME type of "text/html".',
    ),
  ],
  ["a bare string from an ErrorEvent", "Loading chunk 7 failed."],
  [
    "a chunk failure wrapped as a cause",
    new Error("Route render failed", {
      cause: new TypeError("Failed to fetch dynamically imported module: /assets/x.js"),
    }),
  ],
];

for (const [label, value] of CHUNK_FAILURES) {
  check(`${label} is a chunk failure`, () => {
    assert.equal(isChunkLoadFailure(value), true);
  });
}

check("an unrelated error is not a chunk failure", () => {
  assert.equal(
    isChunkLoadFailure(new TypeError("Cannot read properties of undefined (reading 'id')")),
    false,
  );
  assert.equal(isChunkLoadFailure(new Error("Network request failed")), false);
  assert.equal(isChunkLoadFailure("user cancelled"), false);
  assert.equal(isChunkLoadFailure(null), false);
  assert.equal(isChunkLoadFailure(undefined), false);
  assert.equal(isChunkLoadFailure(404), false);
  assert.equal(isChunkLoadFailure({ status: 404 }), false);
});

// ---------------------------------------------------------------------------
console.log("\nwhat the generated client carries\n");
// ---------------------------------------------------------------------------

const component = componentSource(SOURCE_OPTS);
const versionCheck = versionCheckSource(SOURCE_OPTS);
const chunkReload = chunkReloadSource(SOURCE_OPTS);
const clientPolicy = clientPolicySource(SOURCE_OPTS);
const host = clientHostSource(SOURCE_OPTS);

check("the generated sources parse", () => {
  const cases: Array<[string, string, boolean]> = [
    ["policy.ts", clientPolicy, false],
    ["host.ts", host, false],
    ["version-check.ts", versionCheck, false],
    ["chunk-reload.ts", chunkReload, false],
    ["deploy-recovery.tsx", component, true],
    ["error.tsx", errorBoundarySource(SOURCE_OPTS), true],
    ["global-error.tsx", globalErrorBoundarySource(SOURCE_OPTS), true],
    [
      "write-version-json.mjs",
      buildInfoWriterSource({ defaultTarget: "p/c/public/version.json" }),
      false,
    ],
  ];
  for (const [name, source, jsx] of cases) {
    const out = ts.transpileModule(source, {
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        jsx: jsx ? ts.JsxEmit.ReactJSX : ts.JsxEmit.Preserve,
      },
    });
    const messages = (out.diagnostics ?? []).map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, " "),
    );
    assert.deepEqual(messages, [], `${name} must parse cleanly`);
  }
});

check("the version difference never reloads by itself", () => {
  // The module that DETECTS the new build cannot reload the page at all,
  // and the component's single reload sits in the click handler.
  assert.equal(versionCheck.includes("location.reload"), false);
  const reloads = component.match(/window\.location\.reload\(\)/g) ?? [];
  assert.equal(reloads.length, 1, "the component must hold exactly one reload call");
  const handlerAt = component.indexOf("const handleReloadClick");
  assert.ok(handlerAt > 0, "the reload must live in a named click handler");
  assert.ok(component.indexOf("window.location.reload()") > handlerAt);
  assert.match(component, /onOffer: \(\) => setOffered\(true\)/);
});

check("the generated chunk reload keeps the guard", () => {
  assert.match(chunkReload, /claimChunkReload\(store, \{ now \}\)/);
  assert.match(chunkReload, /if \(!claimChunkReload/);
  assert.match(clientPolicy, /CHUNK_RELOAD_GUARD_MS = 60000/);
  assert.ok(clientPolicy.includes(CHUNK_RELOAD_STORAGE_KEY));
  assert.match(clientPolicy, /export const claimChunkReload/);
  assert.match(clientPolicy, /export const shouldChunkReload/);
});

check("the generated policy keeps every disable rule", () => {
  assert.match(clientPolicy, /host\.mode === "production"/);
  assert.match(clientPolicy, /!isNativeShell\(host\.shell\)/);
  assert.match(clientPolicy, /host\.builtCommit\.trim\(\) !== ""/);
  assert.ok(clientPolicy.includes('["capacitor", "electron", "tauri"]'));
  assert.match(clientPolicy, /VERSION_CHECK_INTERVAL_MS = 300000/);
});

check("the generated comments say why the reload is offered and why the guard exists", () => {
  assert.match(component, /only ever raises the offer/i);
  assert.match(component, /worse outcome than the stale tab/i);
  assert.match(chunkReload, /loop/i);
  assert.match(clientPolicy, /loop/i);
});

check("the generated client fetches the build info uncached", () => {
  assert.match(versionCheck, /cache: "no-store"/);
  assert.ok(host.includes('BUILD_INFO_PATH = "/version.json"'));
  assert.ok(host.includes(`process.env.${BUILD_COMMIT_ENV_VAR}`));
});

check("the error boundaries are wired to the guarded reload", () => {
  for (const source of [errorBoundarySource(SOURCE_OPTS), globalErrorBoundarySource(SOURCE_OPTS)]) {
    assert.match(source, /isChunkLoadFailure\(error\)/);
    assert.match(source, /reloadOnceForChunkError\(\)/);
  }
});

// ---------------------------------------------------------------------------
console.log("\nserving the build info with no caching\n");
// ---------------------------------------------------------------------------

const NEXT_CONFIG = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
`;

check("the retrofit sets no-cache on the build-info file and inlines the commit", () => {
  const upgrade = upgradeNextConfig(NEXT_CONFIG, {
    buildInfoPath: "/version.json",
    commitEnvVar: BUILD_COMMIT_ENV_VAR,
  });
  assert.equal(upgrade.changed, true);
  assert.equal(upgrade.noCacheRule, true);
  assert.equal(upgrade.commitInlined, true);
  assert.match(upgrade.content, /source: "\/version\.json"/);
  assert.ok(upgrade.content.includes(`value: "${BUILD_INFO_CACHE_CONTROL}"`));
  assert.ok(BUILD_INFO_CACHE_CONTROL.includes("no-store"));
  assert.ok(upgrade.content.includes(`${BUILD_COMMIT_ENV_VAR}: process.env.COMMIT_SHA ?? ""`));
  assert.ok(upgrade.content.includes("trailingSlash: true"), "existing config is preserved");
});

check("the retrofit is idempotent", () => {
  const once = upgradeNextConfig(NEXT_CONFIG, {
    buildInfoPath: "/version.json",
    commitEnvVar: BUILD_COMMIT_ENV_VAR,
  });
  const twice = upgradeNextConfig(once.content, {
    buildInfoPath: "/version.json",
    commitEnvVar: BUILD_COMMIT_ENV_VAR,
  });
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once.content);
  assert.equal((once.content.match(/async headers\(\)/g) ?? []).length, 1);
});

check("a config with no recognisable anchor is returned unchanged", () => {
  const handRolled = "export default { reactStrictMode: true };\n";
  const upgrade = upgradeNextConfig(handRolled, {
    buildInfoPath: "/version.json",
    commitEnvVar: BUILD_COMMIT_ENV_VAR,
  });
  assert.equal(upgrade.changed, false);
  assert.equal(upgrade.content, handRolled);
  assert.equal(upgrade.notes.length, 1);
});

check("an existing headers() is reported rather than duplicated", () => {
  const withHeaders = NEXT_CONFIG.replace(
    "  trailingSlash: true,",
    "  async headers() {\n    return [];\n  },",
  );
  const upgrade = upgradeNextConfig(withHeaders, {
    buildInfoPath: "/version.json",
    commitEnvVar: BUILD_COMMIT_ENV_VAR,
  });
  assert.equal((upgrade.content.match(/headers\(\)/g) ?? []).length, 1);
  assert.equal(upgrade.commitInlined, true);
  assert.ok(upgrade.notes.some((n) => n.includes("headers()")));
});

check("an existing env key is reported rather than merged into blind", () => {
  const withEnv = NEXT_CONFIG.replace("  trailingSlash: true,", '  env: { A: "b" },');
  const upgrade = upgradeNextConfig(withEnv, {
    buildInfoPath: "/version.json",
    commitEnvVar: BUILD_COMMIT_ENV_VAR,
  });
  assert.equal((upgrade.content.match(/env: \{/g) ?? []).length, 1);
  assert.ok(upgrade.notes.some((n) => n.includes(BUILD_COMMIT_ENV_VAR)));
});

check("the nginx retrofit inserts the rule once and only into a real server block", () => {
  const conf = "server {\n    listen 80;\n    root /usr/share/nginx/html;\n}\n";
  const once = upgradeNginxConf(conf, "/version.json");
  assert.equal(once.changed, true);
  assert.match(once.content, /location = \/version\.json \{/);
  assert.ok(once.content.includes(BUILD_INFO_CACHE_CONTROL));
  const twice = upgradeNginxConf(once.content, "/version.json");
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once.content);

  const noServer = "# just a comment\n";
  const untouched = upgradeNginxConf(noServer, "/version.json");
  assert.equal(untouched.content, noServer);
  assert.equal(untouched.changed, false);
});

// ---------------------------------------------------------------------------
console.log("\nwriting the feature into a project\n");
// ---------------------------------------------------------------------------

/** The context the operational layer hands a module, built around a real
 *  ledger. Nothing here stubs the ledger: the two invariants this module
 *  has to hold — idempotent, and a dry run that touches nothing — are
 *  properties OF the ledger, and a fake one would assert them away. */
type Ctx = Parameters<typeof applyDeployRecovery>[0];

function contextFor(
  dir: string,
  opts: { dryRun?: boolean; force?: boolean; surfaces?: Ctx["project"]["surfaces"] } = {},
): { ctx: Ctx; ledger: Ctx["ledger"] } {
  const ledger = new FeatureLedger(dir, opts.dryRun === true);
  return {
    ctx: {
      projectDir: dir,
      project: {
        name: "demo",
        domain: "demo.test",
        topology: "single-origin",
        surfaces: opts.surfaces ?? "fullstack",
        features: [],
      },
      mode: "update",
      ledger,
      log: () => undefined,
      force: opts.force,
    },
    ledger,
  };
}

function makeProject(dir: string): void {
  mkdirSync(join(dir, "packages/client/src/app"), { recursive: true });
  writeFileSync(join(dir, "packages/client/package.json"), '{"name":"@x/client"}\n');
  writeFileSync(join(dir, "packages/client/next.config.ts"), NEXT_CONFIG);
}

function withTempProject(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "deploy-recovery-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every file under a directory, by project-relative path. Used to prove
 *  that a dry run left the tree byte-identical — a weaker check (this
 *  one file is absent) passes while a retrofit quietly rewrites a config
 *  that was already there. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    out[relative(dir, abs).split(sep).join("/")] = readFileSync(abs, "utf-8");
  }
  return out;
}

/** Everything the module writes into a project shaped like the starter's
 *  client package. */
const WRITTEN_INTO_STARTER_SHAPE = [
  "packages/client/src/lib/deploy-recovery/policy.ts",
  "packages/client/src/lib/deploy-recovery/host.ts",
  "packages/client/src/lib/deploy-recovery/version-check.ts",
  "packages/client/src/lib/deploy-recovery/chunk-reload.ts",
  "packages/client/src/components/deploy-recovery.tsx",
  "packages/client/src/app/error.tsx",
  "packages/client/src/app/global-error.tsx",
  "scripts/write-version-json.mjs",
  ".gitignore",
  "packages/client/next.config.ts",
];

check("a backend project is skipped with a reason, and touches nothing", () => {
  withTempProject((dir) => {
    const { ctx, ledger } = contextFor(dir, { surfaces: "backend" });
    const outcome = applyDeployRecovery(ctx);
    assert.match(outcome.skipped ?? "", /backend/);
    assert.deepEqual(outcome.notes, []);
    assert.deepEqual(ledger.entries, []);
  });
});

check("a fullstack project gets the client modules and the retrofits", () => {
  withTempProject((dir) => {
    makeProject(dir);
    const { ctx, ledger } = contextFor(dir);
    const outcome = applyDeployRecovery(ctx);
    const written = ledger.summary().written;
    for (const expected of WRITTEN_INTO_STARTER_SHAPE) {
      assert.ok(written.includes(expected), `expected ${expected} to be written`);
      assert.ok(existsSync(join(dir, expected)), `expected ${expected} on disk`);
    }
    const config = readFileSync(join(dir, "packages/client/next.config.ts"), "utf-8");
    assert.ok(config.includes(BUILD_INFO_CACHE_CONTROL));
    const writer = readFileSync(join(dir, "scripts/write-version-json.mjs"), "utf-8");
    assert.ok(writer.includes("packages/client/public/version.json"));
    assert.ok(outcome.notes.some((n) => n.includes("DeployRecovery")));
  });
});

check("the generated build-info file is ignored, rather than asked for in a note", () => {
  withTempProject((dir) => {
    makeProject(dir);
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    const { ctx } = contextFor(dir);
    const outcome = applyDeployRecovery(ctx);
    const ignore = readFileSync(join(dir, ".gitignore"), "utf-8");
    assert.ok(ignore.includes("node_modules"), "the project's own entries survive");
    assert.ok(ignore.includes("packages/client/public/version.json"));
    // It is written per build, locally and in CI, so a committed copy is
    // a stale answer to the only question this feature asks.
    assert.equal(
      outcome.notes.some((n) => /gitignore/i.test(n)),
      false,
      "the ledger arranges the ignore; nothing is left for a person to do",
    );
  });
});

check("a hand-written error boundary is never overwritten without force", () => {
  withTempProject((dir) => {
    makeProject(dir);
    const boundary = join(dir, "packages/client/src/app/error.tsx");
    writeFileSync(boundary, "// mine\n");

    const { ctx, ledger } = contextFor(dir);
    const outcome = applyDeployRecovery(ctx);
    assert.equal(readFileSync(boundary, "utf-8"), "// mine\n");
    assert.equal(
      ledger.summary().written.includes("packages/client/src/app/error.tsx"),
      false,
      "an error screen somebody wrote is not this module's to replace",
    );
    assert.ok(
      outcome.notes.some((n) => n.includes("packages/client/src/app/error.tsx")),
      "the note must say which file was left alone",
    );

    const forced = contextFor(dir, { force: true });
    applyDeployRecovery(forced.ctx);
    assert.ok(forced.ledger.summary().written.includes("packages/client/src/app/error.tsx"));
    assert.match(readFileSync(boundary, "utf-8"), /isChunkLoadFailure/);
  });
});

check("a boundary that already calls the guarded reload is left alone, with no note", () => {
  withTempProject((dir) => {
    makeProject(dir);
    const boundary = join(dir, "packages/client/src/app/error.tsx");
    const mine = "// mine\nexport default function E() {\n  reloadOnceForChunkError();\n}\n";
    writeFileSync(boundary, mine);

    const { ctx } = contextFor(dir);
    const outcome = applyDeployRecovery(ctx);
    assert.equal(readFileSync(boundary, "utf-8"), mine);
    // The call is the only thing this module needs from a boundary, so a
    // boundary that has it — however it got there — is wired, and
    // nagging about it every run would train people to ignore the notes.
    assert.equal(
      outcome.notes.some((n) => n.includes("app/error.tsx")),
      false,
    );
  });
});

check("a project with no app router is told its boundary needs wiring", () => {
  withTempProject((dir) => {
    mkdirSync(join(dir, "packages/client/src"), { recursive: true });
    writeFileSync(join(dir, "packages/client/package.json"), '{"name":"@x/client"}\n');
    const { ctx, ledger } = contextFor(dir);
    const outcome = applyDeployRecovery(ctx);
    assert.equal(
      ledger.summary().written.includes("packages/client/src/app/error.tsx"),
      false,
      "a boundary nothing renders would look wired up without being wired up",
    );
    assert.ok(outcome.notes.some((n) => n.includes("error boundary")));
    // No next.config either: the nginx rule has to be printed instead.
    assert.ok(outcome.notes.some((n) => n.includes("location = /version.json")));
  });
});

// ---------------------------------------------------------------------------
// Mounting the component — the step without which none of the rest runs
// ---------------------------------------------------------------------------

const STARTER_LAYOUT = `import type { Metadata } from "next";
import { TRPCProvider } from "@/providers/trpc-provider";
import "@/styles/globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans antialiased">
        <MobileBridgeLoader />
        <TRPCProvider>{children}</TRPCProvider>
      </body>
    </html>
  );
}
`;

check("the component is mounted inside <body>, after the layout's imports", () => {
  const out = mountRecoveryInLayout(STARTER_LAYOUT, "@/components/deploy-recovery");
  assert.equal(out.changed, true);
  assert.match(out.content, /import \{ DeployRecovery \} from "@\/components\/deploy-recovery";/);
  const body = out.content.indexOf("<body");
  const mount = out.content.indexOf("<DeployRecovery />");
  const closing = out.content.indexOf("</body>");
  assert.ok(body < mount && mount < closing, "the element must sit inside <body>");
  // Above the app's own tree, so a tab on any route learns its bundle is stale.
  assert.ok(mount < out.content.indexOf("<TRPCProvider>"));
  // The import lands in the import block, not above it.
  assert.ok(
    out.content.indexOf("import { DeployRecovery }") >
      out.content.indexOf("import type { Metadata }"),
  );
});

check("mounting is idempotent", () => {
  const once = mountRecoveryInLayout(STARTER_LAYOUT, "@/components/deploy-recovery");
  const twice = mountRecoveryInLayout(once.content, "@/components/deploy-recovery");
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once.content);
});

check("a layout with a hand-rolled mount is left exactly as it is", () => {
  const custom = STARTER_LAYOUT.replace(
    "<TRPCProvider>{children}</TRPCProvider>",
    "<TRPCProvider><DeployRecovery writes={writes} />{children}</TRPCProvider>",
  );
  const out = mountRecoveryInLayout(custom, "@/components/deploy-recovery");
  assert.equal(out.changed, false);
  assert.equal(out.content, custom);
});

check("a <body> named in a comment is not the body tag", () => {
  // The starter's pre-paint comment says the marker goes on `<html>, never
  // <body>`. Matching that spliced the element into the comment and broke
  // every mobile scaffold's client build.
  const commented = STARTER_LAYOUT.replace(
    '    <html lang="en">\n',
    '    <html lang="en">\n      {/* The marker goes on <html>, never <body>. */}\n' +
      "      // and never <body> here either\n",
  );
  const out = mountRecoveryInLayout(commented, "@/components/deploy-recovery");
  assert.equal(out.changed, true);
  assert.ok(out.content.includes("{/* The marker goes on <html>, never <body>. */}"));
  const tag = out.content.indexOf("<body className=");
  assert.ok(tag < out.content.indexOf("<DeployRecovery />"), "mounted before the real tag");
});

check("the real starter layout gets the element right after its body tag", () => {
  // The fixture above is a hand copy; this is the file scaffolds start from.
  const path = join(import.meta.dirname, "..", "starter/packages/client/src/app/layout.tsx");
  if (!existsSync(path)) return;
  const out = mountRecoveryInLayout(readFileSync(path, "utf-8"), "@/components/deploy-recovery");
  assert.equal(out.changed, true);
  const bodyTag = /<body(?:\s[^>]*?)?>\s*\{\/\* Offers a reload/.exec(out.content);
  assert.ok(bodyTag, "the element does not directly follow a <body> tag");
  // Every comment the transform touched still closes before the element.
  const before = out.content.slice(0, out.content.indexOf("<DeployRecovery />"));
  assert.equal(
    (before.match(/\{\/\*/g) ?? []).length,
    (before.match(/\*\/\}/g) ?? []).length,
    "the element landed inside a JSX comment",
  );
});

check("a layout with no <body> is returned unchanged, with a reason", () => {
  const odd = "export default function App() {\n  return null;\n}\n";
  const out = mountRecoveryInLayout(odd, "@/components/deploy-recovery");
  assert.equal(out.changed, false);
  assert.equal(out.content, odd);
  assert.match(out.blocked ?? "", /<body>/);
});

check(
  "the import specifier follows the layout's own alias, or falls back to a relative path",
  () => {
    assert.equal(
      recoveryImportSpecifier(STARTER_LAYOUT, "app/layout.tsx"),
      "@/components/deploy-recovery",
    );
    const tilde = STARTER_LAYOUT.replaceAll('from "@/', 'from "~/');
    assert.equal(recoveryImportSpecifier(tilde, "app/layout.tsx"), "~/components/deploy-recovery");
    // No alias: guessing one would produce a layout that does not compile.
    const plain = 'import type { Metadata } from "next";\n<body></body>';
    assert.equal(recoveryImportSpecifier(plain, "app/layout.tsx"), "../components/deploy-recovery");
  },
);

check("applying to a starter-shaped project mounts the component and says what is left", () => {
  withTempProject((dir) => {
    const appDir = join(dir, "packages/client/src/app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(dir, "packages/client/package.json"), '{"name":"@x/client"}\n');
    writeFileSync(join(appDir, "layout.tsx"), STARTER_LAYOUT);

    const { ctx, ledger } = contextFor(dir);
    const outcome = applyDeployRecovery(ctx);
    assert.ok(ledger.summary().written.includes("packages/client/src/app/layout.tsx"));
    const layout = readFileSync(join(appDir, "layout.tsx"), "utf-8");
    assert.match(layout, /<DeployRecovery \/>/);
    // The component it imports is one this run actually wrote.
    assert.ok(existsSync(join(dir, "packages/client/src/components/deploy-recovery.tsx")));
    // The remaining manual step is the writes, and only the writes.
    assert.ok(outcome.notes.some((n) => n.includes("writes")));
    assert.equal(
      outcome.notes.some((n) => /^Mount <DeployRecovery \/> in the root layout/.test(n)),
      false,
      "the old do-it-yourself note must be gone",
    );
  });
});

check("a project with no layout is told the feature will not run at all", () => {
  withTempProject((dir) => {
    mkdirSync(join(dir, "packages/client/src"), { recursive: true });
    writeFileSync(join(dir, "packages/client/package.json"), '{"name":"@x/client"}\n');
    const outcome = applyDeployRecovery(contextFor(dir).ctx);
    const note = outcome.notes.find((n) => n.includes("No root layout"));
    assert.ok(note, "the note must say no layout was found");
    assert.ok(LAYOUT_CANDIDATES.every((c: string) => note?.includes(c)));
    assert.match(note ?? "", /none of the deploy recovery runs/);
  });
});

// ---------------------------------------------------------------------------
// The two invariants, over a project that has every shape this module
// touches: owned files, an edited config and an edited layout.
// ---------------------------------------------------------------------------

check("applying twice records nothing written — the idempotency invariant", () => {
  withTempProject((dir) => {
    const appDir = join(dir, "packages/client/src/app");
    makeProject(dir);
    writeFileSync(join(appDir, "layout.tsx"), STARTER_LAYOUT);

    applyDeployRecovery(contextFor(dir).ctx);
    const afterFirst = snapshotTree(dir);

    const { ctx, ledger } = contextFor(dir);
    applyDeployRecovery(ctx);
    for (const entry of ledger.entries) {
      assert.ok(
        entry.action === "unchanged" || entry.action === "absent",
        `${entry.file} was ${entry.action} on the second run`,
      );
    }
    assert.deepEqual(snapshotTree(dir), afterFirst);
    // `update` re-applies on every run, so a mount that is not a fixed
    // point mounts a second copy each time.
    const layout = readFileSync(join(appDir, "layout.tsx"), "utf-8");
    assert.equal((layout.match(/<DeployRecovery \/>/g) ?? []).length, 1);
  });
});

check("a dry run writes nothing and still says what it would write", () => {
  withTempProject((dir) => {
    const appDir = join(dir, "packages/client/src/app");
    makeProject(dir);
    writeFileSync(join(appDir, "layout.tsx"), STARTER_LAYOUT);
    const before = snapshotTree(dir);

    const { ctx, ledger } = contextFor(dir, { dryRun: true });
    applyDeployRecovery(ctx);

    assert.deepEqual(snapshotTree(dir), before, "a dry run must leave the tree byte-identical");
    const wouldWrite = ledger.summary()["would-write"];
    assert.deepEqual(ledger.summary().written, []);
    for (const expected of [...WRITTEN_INTO_STARTER_SHAPE, "packages/client/src/app/layout.tsx"]) {
      assert.ok(wouldWrite.includes(expected), `the dry run must report ${expected}`);
    }
  });
});

// ---------------------------------------------------------------------------
// One detection list, not two
// ---------------------------------------------------------------------------

check("the shipped chunk detector carries the same lists as the tested one", () => {
  const generated = clientPolicySource(SOURCE_OPTS);

  // Every pattern the policy knows must appear in the generated module,
  // spelled exactly. Rendering them from the same constant is what makes
  // this hold; the check is here so that going back to a hand-kept copy
  // fails loudly instead of silently shipping a shorter list.
  for (const re of CHUNK_ERROR_PATTERNS) {
    assert.ok(
      generated.includes(`/${re.source}/${re.flags}`),
      `generated chunk detector is missing the pattern ${re}`,
    );
  }
  // ...and no others, so a pattern removed from the policy cannot linger
  // in the shipped copy.
  const renderedCount = (generated.match(/^ {2}\/.*\/[a-z]*,$/gm) ?? []).length;
  assert.equal(renderedCount, CHUNK_ERROR_PATTERNS.length);

  for (const name of CHUNK_ERROR_NAMES) {
    assert.ok(
      generated.includes(JSON.stringify(name)),
      `generated chunk detector is missing the error name ${name}`,
    );
  }
});

check("the two detectors agree on real errors from more than one bundler", () => {
  // The generated module is a string, so it cannot be imported and run
  // here. Instead: every message the tested detector accepts must match
  // one of the patterns the generated module carries, and a message it
  // rejects must match none — which is the property that matters, since
  // both sides run the same list against the same message.
  const generated = clientPolicySource(SOURCE_OPTS);
  const shipped = (CHUNK_ERROR_PATTERNS as readonly RegExp[]).filter((re) =>
    generated.includes(`/${re.source}/${re.flags}`),
  );
  const accepted = [
    "Loading chunk 42 failed",
    "Loading CSS chunk 7 failed",
    "Failed to fetch dynamically imported module: https://x/a.js",
    "error loading dynamically imported module",
    "Importing a module script failed",
    "Failed to load module script",
    "Unable to preload CSS for /assets/a.css",
  ];
  for (const message of accepted) {
    assert.ok(isChunkLoadFailure(new Error(message)), `policy rejects ${message}`);
    assert.ok(
      shipped.some((re) => re.test(message)),
      `shipped list rejects ${message}`,
    );
  }
  const unrelated = "Cannot read properties of undefined (reading 'id')";
  assert.equal(isChunkLoadFailure(new Error(unrelated)), false);
  assert.equal(
    shipped.some((re) => re.test(unrelated)),
    false,
  );
});

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log("\n  all deploy-recovery checks passed\n");
