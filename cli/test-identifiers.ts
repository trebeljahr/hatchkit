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
 *
 * Run: pnpm --filter hatchkit test:identifiers
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
    assert(res.mismatches.length === 0, `build-setting reference tolerated: ${JSON.stringify(res.mismatches)}`);
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

if (failed === 0) {
  console.log("\ntest-identifiers: ok");
  process.exit(0);
} else {
  console.error(`\ntest-identifiers: ${failed} assertion(s) failed`);
  process.exit(1);
}
