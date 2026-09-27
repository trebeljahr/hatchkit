/*
 * The browser-extension feature: what it writes, what it wires, and the
 * manifest rules a store release depends on.
 *
 * Everything asserted here fails QUIETLY in production if it regresses:
 *
 *  - a permission added to the manifest is an install warning on every
 *    user's machine and a review question, and nothing in a build says
 *    so;
 *  - a `service_worker` key in the Firefox manifest loads the add-on
 *    with no background at all — the popup opens and does nothing;
 *  - a patch anchor that moved in the starter makes the feature write
 *    twenty files that cannot work, with no error;
 *  - an unrendered `__HATCHKIT_*` token ships a project with a
 *    placeholder where its API origin should be.
 *
 * Plus the four cases `docs/feature-authoring.md` asks every feature to
 * cover: idempotency, dry run, user edits surviving, and no unrendered
 * tokens. The patch tests run against the REAL starter files, so a
 * change to `starter/packages/server/src/app.ts` that moves an anchor
 * fails here rather than in somebody's project.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { expandFeatureSelection } from "./src/features/all.js";
import { FeatureLedger } from "./src/features/contract.js";
import {
  EXTENSION_FORBIDDEN_MANIFEST_KEYS,
  EXTENSION_FORBIDDEN_PERMISSIONS,
  EXTENSION_PERMISSIONS,
  EXTENSION_SCRIPTS,
  extensionFeature,
  extensionPrerequisiteProblem,
  extensionTokens,
} from "./src/features/extension/index.js";
import {
  findUnrenderedTokens,
  listFeatureTemplates,
  renderFeatureTemplate,
} from "./src/features/templates.js";
import { resolveIdentifiers } from "./src/scaffold/identifiers.js";
import type { ProjectManifest } from "./src/scaffold/manifest.js";

const failures: string[] = [];
const check = (name: string, run: () => void): void => {
  try {
    run();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(`  ✗ ${name}: ${(error as Error).message}`);
  }
};

const STARTER_ROOT = join(import.meta.dirname, "..", "starter");

const identifiers = resolveIdentifiers({ name: "example-app", orgDomain: "example.com" });

const manifest = {
  name: "example-app",
  domain: "example.com",
  topology: "split",
  surfaces: "fullstack",
  ports: { server: 5123, client: 5124 },
  features: ["extension"],
} as unknown as ProjectManifest;

const tokens = extensionTokens(identifiers, {
  domain: "example.com",
  topology: "split",
  serverPort: 5123,
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const rendered = new Map<string, string>(
  listFeatureTemplates("extension").map((rel) => [
    rel,
    renderFeatureTemplate("extension", rel, tokens),
  ]),
);

check("every template renders with no placeholder left behind", () => {
  assert.ok(rendered.size > 30, `only ${rendered.size} templates found`);
  for (const [path, content] of rendered) {
    const leftover = findUnrenderedTokens(content);
    assert.deepEqual(leftover, [], `${path} still has ${leftover.join(", ")}`);
  }
});

check("the manifest asks for exactly the pinned permissions", () => {
  const manifestConfig = rendered.get("extension/manifest.config.ts") ?? "";
  assert.ok(
    manifestConfig.includes(`permissions: ${JSON.stringify(EXTENSION_PERMISSIONS)}`),
    "the permission list is not the one types.ts pins",
  );
  for (const key of EXTENSION_FORBIDDEN_MANIFEST_KEYS) {
    assert.ok(!manifestConfig.includes(`${key}:`), `manifest declares ${key}`);
  }
  for (const permission of EXTENSION_FORBIDDEN_PERMISSIONS) {
    assert.ok(!manifestConfig.includes(`"${permission}"`), `manifest asks for ${permission}`);
  }
});

check("the generated project pins the same permission list at runtime", () => {
  const test = rendered.get("extension/src/manifest.test.ts") ?? "";
  assert.ok(test.includes(`toEqual(${JSON.stringify(EXTENSION_PERMISSIONS)})`));
  assert.ok(test.includes('not.toHaveProperty("host_permissions")'));
  assert.ok(test.includes('not.toContain("cookies")'));
});

check("the three build targets bake in their own origin, name and bridge", () => {
  const manifestConfig = rendered.get("extension/manifest.config.ts") ?? "";
  // A development build points at the dev server, both others at the
  // deployed API — and the split topology puts the API on its own host.
  assert.ok(manifestConfig.includes('apiUrl: "http://localhost:5123"'));
  assert.ok(manifestConfig.includes('apiUrl: "https://api.example.com"'));
  // Distinct names and out dirs: both Chromium builds installed at once.
  assert.ok(manifestConfig.includes(`name: "${identifiers.productName} (dev)"`));
  assert.ok(manifestConfig.includes('outDir: "dist-prod"'));
  assert.ok(manifestConfig.includes('outDir: "dist-firefox"'));
  assert.ok(manifestConfig.includes('bridgeTarget: "development"'));
  assert.ok(manifestConfig.includes('bridgeTarget: "production"'));
  assert.ok(manifestConfig.includes('bridgeTarget: "none"'));
});

check("the Firefox target keeps every engine difference", () => {
  const manifestConfig = rendered.get("extension/manifest.config.ts") ?? "";
  // An event page, not a service worker: a manifest with
  // `service_worker` loads on Gecko with no background at all.
  assert.ok(
    manifestConfig.includes('background: gecko\n      ? { scripts: ["background.js"], type: "module" }'),
  );
  // A permanent add-on id, composed from two frozen identifiers, and
  // the floor AMO's data-collection key needs.
  assert.ok(manifestConfig.includes(`id: "${identifiers.token}@${identifiers.orgDomain}"`));
  assert.ok(manifestConfig.includes('strict_min_version: "140.0"'));
  assert.ok(manifestConfig.includes("data_collection_permissions"));
  // `key` is Chromium's; a stray one is a Chrome build somebody forgot
  // to clean up, and AMO reviews the manifest it is sent.
  assert.ok(manifestConfig.includes("const key = gecko ? undefined : pinnedKey(target, env);"));
  // externally_connectable is OMITTED, not written empty.
  assert.ok(
    manifestConfig.includes(
      "...(connectable.length > 0 ? { externally_connectable: { matches: connectable } } : {})",
    ),
  );
});

check("no bridge target means no listener registered at all", () => {
  const bridge = rendered.get("extension/src/background/bridge.ts") ?? "";
  assert.ok(bridge.includes('if (target === "none") return;'));
  const shared = rendered.get("shared/extension-bridge.ts") ?? "";
  assert.ok(shared.includes('if (target === "none") return [];'));
  assert.ok(shared.includes('if (target === "none") return false;'));
});

check("the bridge has its own version, separate from any API level", () => {
  const shared = rendered.get("shared/extension-bridge.ts") ?? "";
  assert.ok(shared.includes("export const EXTENSION_BRIDGE_VERSION = 1;"));
  assert.ok(
    shared.includes(
      `export const EXTENSION_BRIDGE_CHANNEL = "${identifiers.storagePrefix}.extension-bridge";`,
    ),
  );
  assert.ok(shared.includes("extensionBridgeUnsupportedReply"));
});

check("every sender is checked three ways, and frames are refused on both ends", () => {
  const bridge = rendered.get("extension/src/background/bridge.ts") ?? "";
  assert.ok(bridge.includes("isAllowedExtensionBridgeOrigin(sender.origin, target)"));
  assert.ok(bridge.includes("sender.id !== undefined"));
  assert.ok(bridge.includes("sender.frameId !== 0 || sender.tab.incognito === true"));
  assert.ok(bridge.includes("isWebAppOrigin(origin, webUrl, target)"));
  const web = rendered.get("client/ExtensionBridge.tsx") ?? "";
  assert.ok(web.includes("isTopLevelDocument(window)"));
});

check("a token is adopted only after the session names the expected user", () => {
  const device = rendered.get("extension/src/background/device-sign-in.ts") ?? "";
  assert.ok(device.includes("const named = await sessionUser(record.apiOrigin, token);"));
  assert.ok(device.includes("record.forUserId !== null && named.userId !== record.forUserId"));
  // Not kept and quietly ignored — revoked.
  assert.ok(device.includes("await revokeSession(record.apiOrigin, token);"));
  // And it authenticates as this project's own client id, which the
  // server allowlists.
  assert.ok(
    (rendered.get("extension/src/lib/config.ts") ?? "").includes(
      `export const EXTENSION_CLIENT_ID = "${identifiers.clientIds.extension}";`,
    ),
  );
});

check("an explicit session is never displaced by the web app", () => {
  const bridge = rendered.get("extension/src/background/bridge.ts") ?? "";
  assert.ok(bridge.includes('if (current.sessionSource !== "web") return none("explicit-session");'));
});

check("the sign-out marker stays narrow enough to sign back in on the web", () => {
  const marker = rendered.get("extension/src/lib/sign-out-marker.ts") ?? "";
  assert.ok(marker.includes('if (marker.userId !== web.userId) return "discard";'));
  assert.ok(marker.includes('if (marker.at <= web.sessionCreatedAt) return "discard";'));
  assert.ok(marker.includes("EXTENSION_SIGN_OUT_MARKER_TTL_MS"));
});

check("a transport failure re-checks the server and is never read as a refusal", () => {
  const api = rendered.get("extension/src/lib/api.ts") ?? "";
  // The verdict comes from the client kit, not from a second copy: an
  // `instanceof ApiError` inside core has to answer true for an error
  // this module threw, or the offline queue drops rows it should keep.
  assert.ok(api.includes('import { ApiError, isTransportFailure } from "@starter/core";'));
  assert.ok(api.includes("export { ApiError, isTransportFailure };"));
  assert.ok(!api.includes("class ApiError"), "the extension defines its own ApiError");
  const runtime = rendered.get("extension/src/background/runtime.ts") ?? "";
  assert.ok(runtime.includes("export const SERVER_RECHECK_MIN_INTERVAL_MS = 60_000;"));
  assert.ok(runtime.includes("export async function noteTransportFailure()"));
  // The popup names the trust problem the TypeError cannot.
  const popup = rendered.get("extension/src/popup/index.html") ?? "";
  assert.ok(popup.includes("TRUST_EXTENSION_ORIGINS"));
  assert.ok(popup.includes("TRUSTED_ORIGINS"));
});

check("the release workflow fails closed on half a configuration", () => {
  const workflow = rendered.get("workflows/extension-release.yml") ?? "";
  // Chrome: all four secrets or none.
  assert.ok(workflow.includes("of 4 Chrome Web Store secrets are set"));
  for (const secret of [
    "CHROME_CLIENT_ID",
    "CHROME_CLIENT_SECRET",
    "CHROME_REFRESH_TOKEN",
    "CHROME_EXTENSION_ID",
  ]) {
    assert.ok(workflow.includes(secret), `${secret} is not read by the workflow`);
  }
  // Firefox: both or neither, named individually.
  assert.ok(workflow.includes("::error::AMO_JWT_ISSUER is set but AMO_JWT_SECRET is not."));
  assert.ok(workflow.includes("::error::AMO_JWT_SECRET is set but AMO_JWT_ISSUER is not."));
  // The two jobs and the step names the release feature's status table
  // matches against by exact text.
  assert.ok(workflow.includes("name: Extension Release"));
  assert.ok(workflow.includes("chrome-web-store:"));
  assert.ok(workflow.includes("firefox-add-ons:"));
  assert.ok(workflow.includes("- name: Upload to the Chrome Web Store"));
  assert.ok(workflow.includes("- name: Sign and submit to addons.mozilla.org"));
  // Neither store gets a prerelease.
  assert.ok(workflow.includes("not uploaded to the Chrome Web Store."));
  assert.ok(workflow.includes("not submitted to addons.mozilla.org."));
  // AMO reviews bundled code only with the sources beside it.
  assert.ok(workflow.includes("git archive --format=tar.gz"));
  assert.ok(workflow.includes("--upload-source-code"));
});

check("the signing key is checked before it is stripped", () => {
  const script = rendered.get("scripts/extension-package.mjs") ?? "";
  const checkAt = script.indexOf("const id = extensionIdFromKey(manifest.key);");
  const stripAt = script.indexOf("const { key: _key, ...rest } = manifest;");
  assert.ok(checkAt > 0 && stripAt > 0, "the key check or the strip is missing");
  assert.ok(checkAt < stripAt, "the key is stripped before it is checked");
  assert.ok(script.includes("not store item"));
  // A build that pinned an id with no store item to check it against is
  // refused rather than uploaded.
  assert.ok(script.includes("names no store item to check it against"));
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

check("selecting the extension pulls the shared client core in, and applies it first", () => {
  // `requires` is enforced, not documentation: the extension binds the
  // kit's storage seam and throws its ApiError, so a project that got
  // the extension without `packages/core` would not compile.
  const selection = expandFeatureSelection(["extension"]);
  assert.deepEqual(selection.errors, []);
  assert.ok(selection.implied.includes("client-core"), "client-core was not pulled in");
  assert.ok(
    selection.ordered.indexOf("client-core") < selection.ordered.indexOf("extension"),
    `apply order was ${selection.ordered.join(", ")}`,
  );
});

check("the feature is registered, addable later, and refused where it cannot work", () => {
  assert.equal(extensionFeature.id, "extension");
  assert.equal(extensionFeature.addableAfterScaffold, true);
  assert.deepEqual(extensionFeature.surfaces, ["fullstack", "split"]);
  const selection = expandFeatureSelection(["extension"]);
  assert.deepEqual(selection.errors, []);
  assert.ok(selection.ordered.includes("extension"));

  assert.equal(extensionPrerequisiteProblem("fullstack"), null);
  assert.equal(extensionPrerequisiteProblem("split"), null);
  assert.match(extensionPrerequisiteProblem("static") ?? "", /server runtime/);
  assert.match(extensionPrerequisiteProblem("backend") ?? "", /web app/);
});

// ---------------------------------------------------------------------------
// Applying to a project
// ---------------------------------------------------------------------------

/** The starter files the feature edits, copied as they really are. */
const PATCHED_FILES = [
  "package.json",
  ".github/workflows/build-and-deploy.yml",
  "packages/shared/src/index.ts",
  "packages/server/src/app.ts",
  "packages/server/src/auth/auth.ts",
  "packages/server/src/config/env.ts",
  "packages/server/.env.example",
  "packages/client/src/app/layout.tsx",
  "packages/client/src/lib/auth-client.ts",
  "packages/client/.env.example",
];

const makeProject = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hatchkit-extension-"));
  for (const rel of PATCHED_FILES) {
    const to = join(dir, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(STARTER_ROOT, rel), to);
  }
  return dir;
};

const applyTo = (dir: string, opts: { dryRun?: boolean } = {}): FeatureLedger => {
  const ledger = new FeatureLedger(dir, opts.dryRun ?? false);
  ledger.scopeTo("extension");
  const result = extensionFeature.apply({
    projectDir: dir,
    manifestDir: dir,
    manifest,
    identifiers,
    mode: "create",
    ledger,
    log: () => {},
  });
  assert.equal(result, undefined, "apply is synchronous");
  return ledger;
};

/** Every file under `dir`, with its contents — for the dry-run test. */
const snapshot = (dir: string): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const abs = join(current, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.set(relative(dir, abs).split(sep).join("/"), readFileSync(abs, "utf-8"));
    }
  };
  walk(dir);
  return out;
};

const withProject = (run: (dir: string) => void): void => {
  const dir = makeProject();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

check("a fresh apply lands the whole file set and wires every starter file", () => {
  withProject((dir) => {
    const ledger = applyTo(dir);
    assert.deepEqual(ledger.conflicts(), []);
    for (const rel of [
      "packages/extension/manifest.config.ts",
      "packages/extension/src/background/bridge.ts",
      "packages/extension/src/manifest.test.ts",
      "packages/shared/src/extension-bridge.ts",
      "packages/server/src/auth/extension-origins.ts",
      "packages/server/src/tests/extension-origins.test.ts",
      "packages/client/src/components/ExtensionBridge.tsx",
      "packages/client/src/app/device/page.tsx",
      "scripts/extension-package.mjs",
      ".github/workflows/extension-release.yml",
    ]) {
      assert.ok(existsSync(join(dir, rel)), `${rel} was not written`);
    }

    const read = (rel: string): string => readFileSync(join(dir, rel), "utf-8");

    assert.ok(read("packages/shared/src/index.ts").includes('export * from "./extension-bridge.js";'));

    // The starter owns the switch, so the feature leaves env.ts and the
    // server's .env.example alone. It keeps the RAW string plus a
    // resolver, because unset follows TRUST_STORE_APPS — something a bare
    // `=== "true"` coercion cannot express — and a second, coarser copy
    // injected here would shadow it.
    const serverEnv = read("packages/server/src/config/env.ts");
    assert.equal(
      serverEnv.match(/TRUST_EXTENSION_ORIGINS: /g)?.length,
      1,
      "the feature must not add a second TRUST_EXTENSION_ORIGINS entry",
    );
    assert.ok(serverEnv.includes('TRUST_EXTENSION_ORIGINS: getOptional("TRUST_EXTENSION_ORIGINS"),'));
    assert.ok(serverEnv.includes("export function trustsExtensionOrigins()"));
    assert.equal(read("packages/server/.env.example").match(/TRUST_EXTENSION_ORIGINS/g)?.length, 1);

    const app = read("packages/server/src/app.ts");
    // The CORS answer for an extension origin is uncredentialed, and
    // /api/health answers every origin so an untrusted client can find
    // out that is what it is.
    assert.ok(app.includes("corsDecisionFor("));
    assert.ok(app.includes('res.setHeader("Access-Control-Allow-Origin", "*");'));
    assert.ok(app.includes(`service: "${identifiers.slug}"`));
    assert.ok(app.includes("originTrusted:"));
    // Both callers ask the resolver. `env.TRUST_EXTENSION_ORIGINS` is a
    // string, so reading it raw would trust the literal "false".
    assert.ok(
      app.includes('import { env, getTrustedOrigins, trustsExtensionOrigins } from "./config/env.js";'),
    );
    assert.equal(app.match(/trustsExtensionOrigins\(\)/g)?.length, 2);
    assert.ok(!app.includes("env.TRUST_EXTENSION_ORIGINS"));

    const auth = read("packages/server/src/auth/auth.ts");
    assert.ok(
      auth.includes("trustedOriginsForRequest(getTrustedOrigins(), request, trustsExtensionOrigins())"),
    );
    assert.ok(
      auth.includes('import { env, getTrustedOrigins, trustsExtensionOrigins } from "../config/env.js";'),
    );
    assert.ok(!auth.includes("env.TRUST_EXTENSION_ORIGINS"));
    assert.ok(auth.includes("bearer(),"));
    assert.ok(auth.includes("deviceAuthorization({"));
    assert.ok(auth.includes(`clientId === "${identifiers.clientIds.extension}"`));

    const layout = read("packages/client/src/app/layout.tsx");
    assert.equal(layout.match(/<ExtensionBridge \/>/g)?.length, 1);

    assert.ok(read("packages/client/src/lib/auth-client.ts").includes("deviceAuthorizationClient()"));

    // The permission pin is worth nothing unless CI runs it.
    const ci = read(".github/workflows/build-and-deploy.yml");
    assert.ok(ci.includes("- run: pnpm run test:extension"));
    assert.ok(ci.includes("- run: pnpm run build:extension"));
    assert.ok(ci.includes("hatchkit:begin extension-ci"));

    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    for (const [name, command] of Object.entries(EXTENSION_SCRIPTS)) {
      assert.equal(pkg.scripts[name], command, `script ${name}`);
    }
  });
});

check("applying twice changes nothing", () => {
  withProject((dir) => {
    applyTo(dir);
    const before = snapshot(dir);
    const again = applyTo(dir);
    assert.deepEqual(again.summary().written, [], "a second apply wrote files");
    assert.equal(again.touched, false);
    const after = snapshot(dir);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [file, content] of after) {
      assert.equal(content, before.get(file), `${file} changed on the second apply`);
    }
  });
});

check("a dry run touches nothing and says what it would do", () => {
  withProject((dir) => {
    const before = snapshot(dir);
    const ledger = applyTo(dir, { dryRun: true });
    const after = snapshot(dir);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), "a dry run created files");
    for (const [file, content] of after) {
      assert.equal(content, before.get(file), `${file} changed during a dry run`);
    }
    const summary = ledger.summary();
    assert.deepEqual(summary.written, []);
    assert.ok(summary["would-write"].includes(".github/workflows/extension-release.yml"));
    assert.ok(summary["would-write"].includes("packages/extension/manifest.config.ts"));
    assert.equal(ledger.touched, true);
  });
});

check("edits survive a re-apply: the extension's source, and a customised script", () => {
  withProject((dir) => {
    applyTo(dir);

    // The extension's own source is the project's from the moment it
    // lands — somebody will add a screen to that popup.
    const popup = join(dir, "packages/extension/src/popup/main.ts");
    writeFileSync(popup, "// mine\n", "utf-8");

    // A line outside the managed block in a file the feature shares.
    const ciPath = join(dir, ".github/workflows/build-and-deploy.yml");
    writeFileSync(ciPath, `${readFileSync(ciPath, "utf-8")}\n# my own note\n`, "utf-8");

    // A script the project customised.
    const pkgPath = join(dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      scripts: Record<string, string>;
    };
    pkg.scripts["build:extension"] = "pnpm --filter @starter/extension run build -- --my-flag";
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");

    const ledger = applyTo(dir);

    assert.equal(readFileSync(popup, "utf-8"), "// mine\n", "the popup was overwritten");
    assert.ok(readFileSync(ciPath, "utf-8").includes("# my own note"), "a CI line was lost");
    const after = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts: Record<string, string> };
    assert.equal(
      after.scripts["build:extension"],
      "pnpm --filter @starter/extension run build -- --my-flag",
      "a customised script was reverted",
    );
    assert.ok(
      ledger.conflicts().some((entry) => (entry.detail ?? "").includes("build:extension")),
      "the customised script was not reported as a conflict",
    );
  });
});

check("a moved anchor is reported, never silently skipped", () => {
  withProject((dir) => {
    // Somebody rewrote the CORS block by hand.
    const app = join(dir, "packages/server/src/app.ts");
    writeFileSync(
      app,
      readFileSync(app, "utf-8").replace(/app\.use\(\n\s*cors\(\{[\s\S]*?\}\),\n\s*\);/, "app.use(cors());"),
      "utf-8",
    );
    const problems: string[] = [];
    const ledger = new FeatureLedger(dir, false);
    extensionFeature.apply({
      projectDir: dir,
      manifestDir: dir,
      manifest,
      identifiers,
      mode: "create",
      ledger,
      log: (message) => problems.push(message),
    });
    assert.ok(
      problems.some((line) => line.includes("cors() call a per-request delegate")),
      `messages were: ${problems.join(" | ")}`,
    );
  });
});

if (failures.length > 0) {
  console.error("\nextension feature failures:");
  for (const line of failures) console.error(line);
  process.exit(1);
}
console.log("extension feature ok");
