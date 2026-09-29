/**
 * Scaffold-time identifier resolution + cross-file agreement.
 *
 * What this guards:
 *   1. One decision each — `resolveIdentifiers` is pure and deterministic,
 *      so a re-run against a stored manifest reproduces it exactly.
 *   2. Every platform rule that rejects a value far from the scaffold
 *      (bundle-id shape, Mongo/Postgres database names, header casing,
 *      POSIX env-var names) is caught here instead.
 *   3. Overrides win, so a project that already published under some
 *      other spelling is not renamed by a later hatchkit run.
 *   4. The agreement check finds a drifted copy in every file that
 *      carries one, and stays silent about files that are absent.
 *   5. The pre-v5 derivation is reproduced verbatim by `legacyIdentifiers`
 *      — a migration must not propose a new bundle id for a project whose
 *      App ID is already registered.
 *   6. Every identifier-bearing value in the starter is reached by a pass
 *      that rewrites it. Substitution and renaming each cover a fixed list,
 *      neither covers the starter as a whole, and a value on neither list
 *      ships to a user verbatim — a storage key spelled with braces in it.
 *
 * Run: pnpm --filter hatchkit test:identifiers
 */

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
import { dirname, join, relative, sep } from "node:path";

import { renameStarterIdentifiers } from "./src/features/client-core/rename.js";
import { collectIdentifierMismatches } from "./src/scaffold/identifier-agreement.js";
import {
  CLIENT_HOSTS,
  type ProjectIdentifiers,
  findUnsubstitutedIdentifierTokens,
  legacyIdentifiers,
  resolveIdentifiers,
  reverseDomain,
  substituteIdentifierTokens,
  toIdentifierToken,
  toProductName,
  validateIdentifiers,
} from "./src/scaffold/identifiers.js";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

// ---------------------------------------------------------------------------
// 1. Derivation
// ---------------------------------------------------------------------------
console.log("\nderivation:");
{
  const ids = resolveIdentifiers({
    name: "track-your-time",
    productName: "Track Your Time",
    shortName: "Track Time",
    orgDomain: "ricoslabs.com",
  });
  assert(ids.slug === "track-your-time", `slug: ${ids.slug}`);
  assert(ids.token === "trackyourtime", `token: ${ids.token}`);
  assert(ids.bundleId === "com.ricoslabs.trackyourtime", `bundleId: ${ids.bundleId}`);
  assert(ids.envPrefix === "TRACKYOURTIME", `envPrefix: ${ids.envPrefix}`);
  assert(ids.clientHeader === "x-trackyourtime-client", `clientHeader: ${ids.clientHeader}`);
  assert(
    ids.webhookHeaderPrefix === "X-TrackYourTime-",
    `webhookHeaderPrefix: ${ids.webhookHeaderPrefix}`,
  );
  assert(ids.clientIds.desktop === "trackyourtime-desktop", `clientIds.desktop`);
  assert(ids.npmScope === "@track-your-time", `npmScope: ${ids.npmScope}`);
  assert(ids.databaseName === "trackyourtime", `databaseName: ${ids.databaseName}`);
  assert(ids.desktopOrigin.scheme === "app" && ids.desktopOrigin.host === "-", "desktopOrigin");

  // Pure + deterministic: the manifest stores the OUTPUT, so a re-run
  // against the same decisions must reproduce it byte for byte.
  const again = resolveIdentifiers({
    name: "track-your-time",
    productName: "Track Your Time",
    shortName: "Track Time",
    orgDomain: "ricoslabs.com",
  });
  assert(JSON.stringify(again) === JSON.stringify(ids), "resolveIdentifiers is deterministic");

  // Re-resolving FROM a stored set must be a fixed point too — that is
  // what makes `identifiers` safe to round-trip through the manifest.
  const fromStored = resolveIdentifiers({ name: "anything at all", overrides: ids });
  assert(JSON.stringify(fromStored) === JSON.stringify(ids), "overrides reproduce a stored set");
}

{
  // Defaults: a bare slug gets a title-cased product name and the
  // deliberately-obvious placeholder organisation.
  const ids = resolveIdentifiers({ name: "my-cool-app" });
  assert(ids.productName === "My Cool App", `productName default: ${ids.productName}`);
  assert(ids.bundleId === "com.example.mycoolapp", `bundleId default: ${ids.bundleId}`);
  // Short name falls back to the first word once the product name is
  // longer than a launcher will show.
  assert(ids.shortName === "My Cool App", `shortName fits: ${ids.shortName}`);
  const long = resolveIdentifiers({ name: "supercalifragilistic-tracker" });
  assert(long.shortName.length <= 12, `shortName truncated: ${long.shortName}`);
}

{
  // A name the user typed with capitals or spaces is left alone — they
  // wrote what they meant.
  assert(toProductName("Track Your Time") === "Track Your Time", "explicit name preserved");
  assert(toProductName("my_app.name") === "My App Name", "slug title-cased");
  // A leading digit is legal almost everywhere and illegal in a
  // bundle-id segment, so it is fixed once at the token.
  assert(toIdentifierToken("3d-viewer") === "app3dviewer", "digit-leading token prefixed");
  assert(reverseDomain("ricos-labs.co.uk") === "uk.co.ricoslabs", "hyphens stripped, not kept");
}

// ---------------------------------------------------------------------------
// 2. Validation — every rule is a platform that rejects the value later
// ---------------------------------------------------------------------------
console.log("\nvalidation:");
{
  const base = resolveIdentifiers({ name: "ok-app", orgDomain: "acme.com" });
  assert(validateIdentifiers(base).length === 0, "a clean set has no problems");

  const problems = (patch: Partial<ProjectIdentifiers>) =>
    validateIdentifiers({ ...base, ...patch }).filter((p) => p.severity === "error");

  assert(problems({ bundleId: "com.acme.my-app" }).length > 0, "hyphen in a bundle-id segment");
  assert(problems({ bundleId: "acmeapp" }).length > 0, "single-segment bundle id");
  assert(problems({ bundleId: "com.acme.1app" }).length > 0, "digit-leading bundle-id segment");
  assert(problems({ databaseName: "my-app" }).length > 0, "hyphen in a database name");
  assert(problems({ databaseName: "a".repeat(64) }).length > 0, "database name over 63 chars");
  assert(problems({ envPrefix: "My_App" }).length > 0, "lowercase in an env prefix");
  assert(problems({ envPrefix: "1APP" }).length > 0, "digit-leading env prefix");
  assert(problems({ clientHeader: "X-Acme-Client" }).length > 0, "uppercase header name");
  assert(problems({ webhookHeaderPrefix: "X-Acme" }).length > 0, "header prefix missing its dash");
  assert(
    problems({ desktopOrigin: { scheme: "file", host: "" } }).length > 0,
    "file:// desktop origin",
  );
  assert(
    problems({
      clientIds: { ...base.clientIds, desktop: "acme-x", extension: "acme-x" },
    }).length > 0,
    "duplicate client ids defeat per-surface revocation",
  );

  // The placeholder org is legal but must be called out before anything
  // is registered, because registration cannot be undone.
  const placeholder = validateIdentifiers(resolveIdentifiers({ name: "ok-app" }));
  assert(
    placeholder.some((p) => p.severity === "warning" && p.field === "bundleId"),
    "com.example is warned about",
  );
}

// ---------------------------------------------------------------------------
// 3. Template tokens
// ---------------------------------------------------------------------------
console.log("\ntokens:");
{
  const ids = resolveIdentifiers({ name: "acme-app", orgDomain: "acme.com" });
  const rendered = substituteIdentifierTokens(
    `{"appId":"{{bundleId}}","appName":"{{shortName}}","name":"{{productName}}"}`,
    ids,
  );
  assert(rendered.includes('"appId":"com.acme.acmeapp"'), `bundleId token: ${rendered}`);
  assert(!rendered.includes("{{"), "no identifier tokens survive");
  assert(findUnsubstitutedIdentifierTokens(rendered).length === 0, "nothing left to substitute");

  // A leftover token must be detectable — it means a template outgrew
  // the token map and a literal `{{…}}` would ship to a user's repo.
  assert(
    findUnsubstitutedIdentifierTokens("x {{bundleId}} y").includes("{{bundleId}}"),
    "leftover token detected",
  );
  // An unrelated mustache belongs to some other pass and is left alone.
  assert(
    findUnsubstitutedIdentifierTokens("${{ secrets.FOO }} {{notAToken}}").length === 0,
    "foreign braces ignored",
  );
  for (const host of CLIENT_HOSTS) {
    assert(
      substituteIdentifierTokens(`{{clientId:${host}}}`, ids) === ids.clientIds[host],
      `clientId token for ${host}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Agreement across every file that carries a copy
// ---------------------------------------------------------------------------
console.log("\nagreement:");
{
  const root = mkdtempSync(join(tmpdir(), "identifier-agreement-"));
  try {
    const ids = resolveIdentifiers({
      name: "acme-app",
      productName: "Acme App",
      shortName: "Acme",
      orgDomain: "acme.com",
    });
    const bid = ids.bundleId;

    write(
      root,
      "package.json",
      JSON.stringify({ name: "acme-app", build: { appId: bid, productName: "Acme App" } }),
    );
    write(root, "capacitor.config.ts", `const c = { appId: "${bid}", appName: "Acme" };\n`);
    write(
      root,
      "packages/client/public/manifest.json",
      JSON.stringify({ name: "Acme App", short_name: "Acme" }),
    );
    write(
      root,
      "ios/App/App/Info.plist",
      `<dict><key>CFBundleDisplayName</key><string>Acme</string><key>CFBundleIdentifier</key><string>${bid}</string></dict>`,
    );
    write(root, "android/app/build.gradle", `android {\n  applicationId "${bid}"\n}\n`);
    write(
      root,
      "android/app/src/main/res/values/strings.xml",
      `<resources><string name="app_name">Acme</string><string name="title_activity_main">Acme</string></resources>`,
    );

    const clean = collectIdentifierMismatches(root, ids);
    assert(clean.mismatches.length === 0, `clean tree: ${JSON.stringify(clean.mismatches)}`);
    assert(clean.checked.length === 6, `all six files checked (got ${clean.checked.length})`);
    assert(clean.unreadable.length === 0, "nothing unreadable");

    // The launcher label lives in four places. Drift in the one nobody
    // looks at — the Android activity title — must still be caught.
    write(
      root,
      "android/app/src/main/res/values/strings.xml",
      `<resources><string name="app_name">Acme</string><string name="title_activity_main">Acme App</string></resources>`,
    );
    const drift = collectIdentifierMismatches(root, ids);
    assert(drift.mismatches.length === 1, `one mismatch (got ${drift.mismatches.length})`);
    assert(drift.mismatches[0]?.field === "shortName", "mismatch is on shortName");
    assert(
      drift.mismatches[0]?.location.includes("title_activity_main"),
      `location names the field: ${drift.mismatches[0]?.location}`,
    );

    // A bundle id that drifted in one native tree only.
    write(root, "android/app/build.gradle", `android {\n  applicationId "com.other.acmeapp"\n}\n`);
    const both = collectIdentifierMismatches(root, ids);
    assert(both.mismatches.length === 2, `two mismatches (got ${both.mismatches.length})`);
    assert(
      both.mismatches.some((m) => m.field === "bundleId" && m.actual === "com.other.acmeapp"),
      "bundle-id drift reported with the actual value",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  // A web-only project has no native trees. Absent files are not findings.
  const root = mkdtempSync(join(tmpdir(), "identifier-absent-"));
  try {
    const ids = resolveIdentifiers({ name: "web-only" });
    write(root, "package.json", JSON.stringify({ name: "web-only" }));
    const res = collectIdentifierMismatches(root, ids);
    assert(res.mismatches.length === 0, "no mismatches from absent files");
    // package.json exists but has no `build` block — reported as
    // unreadable-for-this-purpose, not as a mismatch.
    assert(res.unreadable.includes("package.json"), "a file with no copy is unreadable, not wrong");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  // Xcode writes a build-setting reference rather than a literal. That
  // is not drift and must not be reported.
  const root = mkdtempSync(join(tmpdir(), "identifier-xcodevar-"));
  try {
    const ids = resolveIdentifiers({ name: "acme-app", shortName: "Acme", orgDomain: "acme.com" });
    write(
      root,
      "ios/App/App/Info.plist",
      `<dict><key>CFBundleDisplayName</key><string>Acme</string><key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string></dict>`,
    );
    write(
      root,
      "ios/App/App.xcodeproj/project.pbxproj",
      `\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${ids.bundleId};\n`,
    );
    const res = collectIdentifierMismatches(root, ids);
    assert(
      res.mismatches.length === 0,
      `build-setting reference tolerated: ${JSON.stringify(res.mismatches)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5. Back-compat
// ---------------------------------------------------------------------------
console.log("\nlegacy:");
{
  // The pre-v5 CLI wrote exactly `com.example.<name stripped to [a-z0-9]>`
  // and used the raw project name as the display name. A migration that
  // produced anything else would rename a project that may already have a
  // registered App ID.
  for (const name of ["my-cool-app", "Dino Game", "tiao"]) {
    const legacy = legacyIdentifiers(name);
    const oldRule = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
    assert(
      legacy.bundleId === `com.example.${oldRule}`,
      `legacy bundleId for ${name}: ${legacy.bundleId}`,
    );
    assert(legacy.productName === name, `legacy productName for ${name}: ${legacy.productName}`);
  }
  // And it differs from the current derivation where the rules diverge —
  // which is exactly why the migration does not call resolveIdentifiers
  // with default decisions.
  assert(
    legacyIdentifiers("my-cool-app").productName !==
      resolveIdentifiers({ name: "my-cool-app" }).productName,
    "legacy and current display names genuinely differ",
  );
}

// ---------------------------------------------------------------------------
// 6. No unsubstituted token, and no unrenamed literal, can ship
// ---------------------------------------------------------------------------
//
// THE FAILURE MODE THIS EXISTS FOR. `substituteIdentifierTokens` runs over a
// fixed set of paths, and `renameStarterIdentifiers` over another. Neither
// reaches the starter as a whole. So an identifier placeholder added to a
// starter file that no pass covers typechecks, passes review, and ships into a
// user's repo verbatim — a storage key literally spelled with braces in it.
//
// The covered roots below are taken from each feature's OWN path list wherever
// it has one, rather than restated here: a hand-kept copy goes stale the first
// time a feature grows a file, which is the drift this scan is supposed to
// catch rather than reproduce.
console.log("\nstarter coverage:");
{
  const { DESKTOP_FILES } = await import("./src/scaffold/desktop.js");
  const { MOBILE_IDENTIFIER_RENAME_PATHS } = await import("./src/scaffold/mobile-feature.js");
  const { CLIENT_CORE_MARKED_FILES, CLIENT_CORE_OWNED_PATHS } = await import(
    "./src/features/client-core/types.js"
  );

  // Starter paths some pass rewrites. A token anywhere under one of these is
  // fine; a token outside all of them ships verbatim.
  const COVERED: readonly string[] = [
    // scaffold/app.ts, unconditionally and in the desktop branch.
    "packages/client/public/manifest.json",
    "package.json",
    // features/mobile/index.ts.
    "capacitor.config.ts",
    // scaffold/desktop.ts — substituteDesktopFiles walks this list.
    ...DESKTOP_FILES,
    // features/client-core/apply.ts renders the files it owns.
    ...CLIENT_CORE_OWNED_PATHS,
    ...CLIENT_CORE_MARKED_FILES,
  ];

  // Storage keys that ship as `starter.`-prefixed literals rather than tokens,
  // because the starter has to typecheck and run before it is ever scaffolded.
  const PREFIXED_KEYS: readonly { file: string; constant: string }[] = [
    { file: "packages/client/src/lib/native-session.ts", constant: "SESSION_TOKEN_KEY" },
    { file: "packages/client/src/mobile/preferences-storage.ts", constant: "HANDOVER_MARKER_KEY" },
  ];

  const starter = join(import.meta.dirname, "..", "starter");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next") {
        continue;
      }
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else files.push(abs);
    }
  };
  walk(starter);

  const isCovered = (rel: string): boolean =>
    COVERED.some((root) => rel === root || rel.startsWith(`${root}/`));

  // 1. No token in a file no pass reaches.
  const stray: string[] = [];
  for (const abs of files) {
    let content: string;
    try {
      content = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const tokens = findUnsubstitutedIdentifierTokens(content);
    if (tokens.length === 0) continue;
    const rel = relative(starter, abs).split(sep).join("/");
    if (!isCovered(rel)) stray.push(`${rel}: ${tokens.join(", ")}`);
  }
  assert(
    stray.length === 0,
    `identifier tokens in files no pass substitutes: ${stray.join(" | ")}`,
  );

  // 2. The other direction, so the list cannot rot: a covered root that no
  //    longer exists in the starter is a path that was renamed or deleted with
  //    the list left behind — after which direction 1 silently stops guarding
  //    whatever moved there.
  const missing = COVERED.filter((rel) => !existsSync(join(starter, rel)));
  assert(missing.length === 0, `covered path absent from the starter: ${missing.join(", ")}`);

  // 3. Each prefixed storage key is present, carries the starter prefix, and is
  //    actually rewritten by the rename pass.
  const ids = resolveIdentifiers({ name: "acme-app", orgDomain: "acme.com" });
  for (const { file, constant } of PREFIXED_KEYS) {
    const content = readFileSync(join(starter, file), "utf-8");
    // Plain scan rather than a built regex: the declaration is always
    // `export const <CONSTANT> = "<key>";` and a literal search cannot be
    // broken by escaping.
    const marker = `${constant} = "`;
    const at = content.indexOf(marker);
    assert(at !== -1, `${constant} is declared in ${file}`);
    if (at === -1) continue;
    const from = at + marker.length - 1;
    const literal = content.slice(from, content.indexOf('"', from + 1) + 1);
    assert(literal.startsWith('"starter.'), `${constant} carries the starter prefix: ${literal}`);
    const renamed = renameStarterIdentifiers(literal, ids);
    assert(
      renamed === `"${ids.storagePrefix}.${literal.slice('"starter.'.length)}`,
      `${constant} is rewritten to the project prefix: ${renamed}`,
    );
    assert(!renamed.includes('"starter.'), `${constant} keeps no starter prefix: ${renamed}`);
  }
}

if (failed === 0) {
  console.log("\ntest-identifiers: ok");
  process.exit(0);
} else {
  console.error(`\ntest-identifiers: ${failed} assertion(s) failed`);
  process.exit(1);
}
