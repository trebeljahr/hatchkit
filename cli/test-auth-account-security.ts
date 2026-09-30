/**
 * auth-account-security.ts: the `auth-account-security` feature.
 *
 * Four things are worth a test here, and one of them is the reason the
 * feature has a test at all.
 *
 *  1. **better-auth plugin order.** after-hooks run in registration order,
 *     and `bearer()` emits `set-auth-token` for whatever session cookie the
 *     response carries. Every plugin ahead of it can replace the session
 *     sign-in just made — two-factor deletes it outright. Get the order
 *     wrong and a token client stores a credential for a deleted session:
 *     401 everywhere, no error logged, and every unit test still passes,
 *     because nothing at runtime observes the order. So the test reads the
 *     GENERATED `auth.ts` back off disk, exactly as the reference
 *     implementation reads its own.
 *
 *  2. **The `?next=` guard.** The rendered module is imported and run
 *     against an acceptance/rejection table. Testing the real module rather
 *     than the template text is the point: every entry below is a string
 *     that reaches another origin despite starting with "/".
 *
 *  3. **Idempotence.** `hatchkit update` runs this against projects that
 *     have been live for months. A second apply must not duplicate a plugin
 *     registration, re-patch a file, or overwrite anything.
 *
 *  4. **Every sign-in method has a token-shell answer**, and it reaches the
 *     generated docs. A method that silently cannot be completed in the
 *     app's own native shell is the failure this column exists to prevent.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AUTH_SECURITY_DEFAULT_OPTIONS,
  AUTH_SECURITY_OPTIONS,
  type AuthSecurityOption,
} from "./src/features/auth-account-security/types.js";
import {
  ORDERED_SERVER_PLUGINS,
  assertPluginOrder,
  describeOrderViolation,
  extractRegisteredPlugins,
  findPluginOrderViolation,
  serverPluginsFor,
} from "./src/features/auth-account-security/plugin-order.js";
import { AUTH_SECURITY_SPECS, specFor } from "./src/features/auth-account-security/options.js";
import { planAuthAccountSecurity } from "./src/features/auth-account-security/plan.js";
import { renderAuthSecurityDocs } from "./src/features/auth-account-security/docs.js";
import { renderAuthSecurityTemplate } from "./src/features/auth-account-security/render.js";
import { applyAuthAccountSecurity } from "./src/features/auth-account-security/index.js";
import { authAccountSecurityFeature } from "./src/features/auth-account-security/definition.js";
import { FeatureLedger, getFeature } from "./src/features/contract.js";

const STARTER = join(import.meta.dirname, "..", "starter");

const failures: string[] = [];
function expect(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        console.log(`  ✓ ${label}`);
      },
      (err: Error) => {
        failures.push(`${label}: ${err.message}`);
        console.log(`  ✗ ${label}`);
      },
    );
}

/** A throwaway project with just the files the feature patches, copied
 *  from the real starter so the anchors under test are the real ones. */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "auth-account-security-"));
  const copy = (rel: string): void => {
    const src = join(STARTER, rel);
    if (!existsSync(src)) throw new Error(`starter is missing ${rel}`);
    const dst = join(dir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
  };
  copy("packages/server/src/auth/auth.ts");
  copy("packages/server/src/app.ts");
  copy("packages/server/src/trpc/routers/health.ts");
  copy("packages/server/src/trpc/routers/profile.ts");
  copy("packages/server/src/models/Item.ts");
  copy("packages/server/src/models/Profile.ts");
  copy("packages/server/package.json");
  copy("packages/client/src/lib/auth-client.ts");
  copy("packages/client/src/app/login/page.tsx");
  copy("packages/client/package.json");
  copy("packages/shared/src/index.ts");
  return dir;
}

const ALL_OPTIONS = [...AUTH_SECURITY_OPTIONS];

async function apply(dir: string, options: AuthSecurityOption[], hasNativeClient = true) {
  return applyAuthAccountSecurity({
    projectDir: dir,
    projectName: "Test App",
    options,
    hasNativeClient,
    hasEmailTransport: false,
  });
}

// ── 1. Plugin order ───────────────────────────────────────────────────
console.log("\nbetter-auth plugin order:");

await expect("bearer is last in the contract", () => {
  assert.equal(
    ORDERED_SERVER_PLUGINS[ORDERED_SERVER_PLUGINS.length - 1],
    "bearer",
    "bearer() must be registered after every plugin that can replace the session",
  );
});

await expect("two-factor sorts ahead of bearer whatever order it is asked for", () => {
  const plugins = serverPluginsFor(["two-factor"], { hasNativeClient: true });
  assert.deepEqual(plugins, ["twoFactorPlugin", "bearer"]);
});

await expect("bearer is only registered when a native shell needs a token", () => {
  assert.deepEqual(serverPluginsFor(["two-factor"], { hasNativeClient: false }), [
    "twoFactorPlugin",
  ]);
});

await expect("every plugin sorts ahead of bearer", () => {
  const plugins = serverPluginsFor(["passkeys", "two-factor", "magic-link", "email-otp"], {
    hasNativeClient: true,
  });
  assert.deepEqual(plugins, [
    "twoFactorPlugin",
    "emailOtpPlugin",
    "magicLinkPlugin",
    "passkeyPlugin",
    "bearer",
  ]);
});

await expect("a wrong order is described rather than silently accepted", () => {
  const violation = describeOrderViolation(["bearer", "twoFactorPlugin"]);
  assert.ok(violation, "bearer before twoFactorPlugin must be reported");
  assert.match(violation ?? "", /registration order/);
  assert.throws(() => assertPluginOrder(["bearer", "twoFactorPlugin"]));
});

await expect("an unknown plugin is refused rather than sorted to the end", () => {
  // Sorting an unrecognised name to the end would place it after bearer(),
  // which is exactly the bug the contract exists to prevent.
  assert.throws(
    () => assertPluginOrder(["twoFactorPlugin", "somethingNew", "bearer"]),
    /./,
    "an unknown plugin must not pass silently",
  );
});

await expect("the plugin array is read out of a source file, not out of imports", () => {
  const source = `
import { bearer } from "better-auth/plugins/bearer";
import { twoFactorPlugin } from "./account-security.js";
// bearer() is mentioned in this comment and must not count.
const auth = betterAuth({
  plugins: [
    twoFactorPlugin(),
    bearer(),
  ],
});`;
  assert.deepEqual(extractRegisteredPlugins(source), ["twoFactorPlugin", "bearer"]);
  assert.equal(findPluginOrderViolation(source), null);
});

await expect("THE GENERATED auth.ts registers two-factor before bearer", async () => {
  const dir = makeProject();
  await apply(dir, ALL_OPTIONS);
  const generated = readFileSync(join(dir, "packages/server/src/auth/auth.ts"), "utf-8");

  const registered = extractRegisteredPlugins(generated);
  assert.ok(registered.includes("twoFactorPlugin"), "two-factor must be registered");
  assert.ok(registered.includes("bearer"), "bearer must be registered for a native project");
  assert.equal(
    findPluginOrderViolation(generated),
    null,
    `generated plugin order is wrong: ${registered.join(" → ")}`,
  );
  assert.ok(
    registered.indexOf("twoFactorPlugin") < registered.indexOf("bearer"),
    "twoFactorPlugin() must come before bearer()",
  );
  // And the file carries no unrendered placeholders.
  assert.ok(!generated.includes("__HATCHKIT_"), "generated auth.ts still has a placeholder");
});

await expect("a hand-scrambled auth.ts IS caught by the same check", () => {
  // Proves the check can fail. A test that only ever sees correct input
  // would pass just as happily against a check that always returns null.
  const scrambled = `betterAuth({ plugins: [ bearer(), twoFactorPlugin() ] });`;
  assert.ok(findPluginOrderViolation(scrambled), "a wrong order must be caught");
});

// ── 2. The ?next= guard ───────────────────────────────────────────────
console.log("\nredirect-parameter validation:");

const safeNextDir = mkdtempSync(join(tmpdir(), "safe-next-"));
const safeNextPath = join(safeNextDir, "safe-next.ts");
writeFileSync(
  safeNextPath,
  renderAuthSecurityTemplate("client/safe-next.ts", {
    SAFE_NEXT_PREFIXES: ['  "/dashboard",', '  "/settings",'].join("\n"),
    POST_AUTH_REDIRECT: "/dashboard",
  }),
  "utf-8",
);
const { safeNext, authPageHref } = await import(pathToFileURL(safeNextPath).href);

await expect("accepts same-origin paths under the allowlist", () => {
  assert.equal(safeNext("/dashboard"), "/dashboard");
  assert.equal(safeNext("/dashboard/reports"), "/dashboard/reports");
  assert.equal(safeNext("/settings?tab=account"), "/settings?tab=account");
});

await expect("rejects every value that reaches another origin", () => {
  for (const hostile of [
    "//evil.com", // protocol-relative
    "/\\evil.com", // browsers normalise the backslash to "//"
    "/\t/evil.com", // tab is stripped, leaving "//evil.com"
    "/\n/evil.com",
    "https://evil.com/dashboard",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    " /dashboard", // leading space
    "/dashboard/../evil", // normalises out of the allowlist
    "/dashboardish", // prefix must be a path segment, not a substring
    "/",
    "dashboard", // relative
    "",
  ]) {
    assert.equal(safeNext(hostile), null, `must reject ${JSON.stringify(hostile)}`);
  }
});

await expect("rejects non-strings and overlong values", () => {
  assert.equal(safeNext(null), null);
  assert.equal(safeNext(42), null);
  assert.equal(safeNext(undefined), null);
  assert.equal(safeNext(`/dashboard/${"a".repeat(4096)}`), null);
});

await expect("an unsafe next is DROPPED rather than forwarded between pages", () => {
  // This is how an allowlist gets bypassed in practice: nobody attacks the
  // page that validates, they attack the link that passes the value along.
  assert.equal(authPageHref("login", { next: "//evil.com" }), "/login");
  assert.equal(authPageHref("signup", { next: "/dashboard" }), "/signup?next=%2Fdashboard");
});

// ── 3. Planning, files and idempotence ────────────────────────────────
console.log("\nplan and apply:");

await expect("the redirect guard is written whatever the selection", () => {
  const plan = planAuthAccountSecurity({
    options: [],
    hasNativeClient: false,
    hasEmailTransport: true,
  });
  assert.ok(
    plan.files.includes("packages/client/src/lib/safe-next.ts"),
    "an app that offers ?next= at all needs the guard; it is not optional",
  );
});

await expect("options that need mail warn when there is no transport", () => {
  const plan = planAuthAccountSecurity({
    options: ["email-otp", "magic-link"],
    hasNativeClient: false,
    hasEmailTransport: false,
  });
  assert.equal(plan.warnings.length > 0, true);
  assert.match(plan.warnings.join(" "), /never at build time/);
});

await expect("a native project is warned about the methods it cannot finish", () => {
  const plan = planAuthAccountSecurity({
    options: ["two-factor", "email-otp"],
    hasNativeClient: true,
    hasEmailTransport: true,
  });
  const text = plan.warnings.join(" ");
  assert.match(text, /Two-factor/);
  // Email codes DO work on a token shell, so they must not be listed.
  assert.ok(!/Email one-time code sign-in \(/.test(text));
});

await expect("passkeys add their dependency, and nothing else does", () => {
  const withPasskeys = planAuthAccountSecurity({
    options: ["passkeys"],
    hasNativeClient: false,
    hasEmailTransport: true,
  });
  assert.deepEqual(
    withPasskeys.deps.map((dep) => dep.name).sort(),
    ["@better-auth/passkey", "@better-auth/passkey"],
    "passkeys need the package on both sides — it is not in better-auth core",
  );
  const without = planAuthAccountSecurity({
    options: [...AUTH_SECURITY_DEFAULT_OPTIONS],
    hasNativeClient: false,
    hasEmailTransport: true,
  });
  assert.deepEqual(without.deps, []);
});

await expect("the cascade never names a collection with no model behind it", async () => {
  // Without profile pictures there is no Avatar model, and a cascade that
  // named `avatars` would fail at import — taking the whole server down
  // rather than the one call that needed it.
  const dir = makeProject();
  await apply(dir, ["account-deletion"]);
  const plan = readFileSync(
    join(dir, "packages/server/src/services/account-deletion/plan.ts"),
    "utf-8",
  );
  const stores = readFileSync(
    join(dir, "packages/server/src/services/account-deletion/stores.ts"),
    "utf-8",
  );
  assert.ok(!plan.includes('"avatars"'), "avatars must not be in the cascade without the model");
  assert.ok(!stores.includes("models/Avatar.js"), "stores must not import a model that is absent");
  assert.ok(!plan.includes("__HATCHKIT_"), "plan.ts still has a placeholder");
  assert.ok(!stores.includes("__HATCHKIT_"), "stores.ts still has a placeholder");

  const both = makeProject();
  await apply(both, ["account-deletion", "profile-pictures"]);
  const withAvatars = readFileSync(
    join(both, "packages/server/src/services/account-deletion/plan.ts"),
    "utf-8",
  );
  assert.ok(withAvatars.includes('"avatars"'), "avatars must be swept when the model exists");
});

await expect("applying twice changes nothing the second time", async () => {
  const dir = makeProject();
  await apply(dir, ALL_OPTIONS);
  const authPath = join(dir, "packages/server/src/auth/auth.ts");
  const clientPath = join(dir, "packages/client/src/lib/auth-client.ts");
  const loginPath = join(dir, "packages/client/src/app/login/page.tsx");
  const first = {
    auth: readFileSync(authPath, "utf-8"),
    client: readFileSync(clientPath, "utf-8"),
    login: readFileSync(loginPath, "utf-8"),
  };

  const second = await apply(dir, ALL_OPTIONS);
  assert.equal(readFileSync(authPath, "utf-8"), first.auth, "auth.ts was patched twice");
  assert.equal(readFileSync(clientPath, "utf-8"), first.client, "auth-client.ts was patched twice");
  assert.equal(readFileSync(loginPath, "utf-8"), first.login, "login page was patched twice");
  assert.equal(second.written.length, 0, "a second run must write no new files");
  assert.ok(second.skipped.length > 0, "existing files must be reported as skipped");

  // And the plugin array still has exactly one of each.
  const registered = extractRegisteredPlugins(first.auth);
  assert.equal(
    new Set(registered).size,
    registered.length,
    `a plugin was registered twice: ${registered.join(", ")}`,
  );
});

await expect("a file the user has edited is never overwritten", async () => {
  const dir = makeProject();
  await apply(dir, ["two-factor"]);
  const challenge = join(dir, "packages/client/src/components/auth/two-factor-challenge.tsx");
  writeFileSync(challenge, "// my own version\n", "utf-8");
  await apply(dir, ["two-factor", "google-oauth"]);
  assert.equal(readFileSync(challenge, "utf-8"), "// my own version\n");
});

await expect("email verification becomes conditional, and ships the backfill", async () => {
  const dir = makeProject();
  await apply(dir, ["email-verification"]);
  const auth = readFileSync(join(dir, "packages/server/src/auth/auth.ts"), "utf-8");
  assert.match(auth, /requireEmailVerification: requireEmailVerification\(isEmailConfigured\(\)\)/);
  // sendVerificationEmail must live in the emailVerification block —
  // better-auth never calls it from under emailAndPassword.
  assert.match(auth, /emailVerification: emailVerificationOptions\(/);
  assert.ok(
    existsSync(join(dir, "packages/server/src/scripts/backfill-email-verified.ts")),
    "the backfill script must ship with the option that creates the obligation",
  );
  const pkg = JSON.parse(readFileSync(join(dir, "packages/server/package.json"), "utf-8"));
  assert.ok(pkg.scripts["backfill:email-verified"]);
});

// ── 4. The token-shell answers ────────────────────────────────────────
console.log("\ntoken-shell verdicts:");

await expect("every sign-in method has a verdict AND a reason", () => {
  for (const option of AUTH_SECURITY_OPTIONS) {
    const spec = specFor(option);
    assert.ok(spec.tokenShellNote.trim().length > 0, `${option} has no token-shell note`);
    if (spec.tokenShell === "n/a") continue;
    assert.ok(
      spec.tokenShellNote.length > 60,
      `${option} is a sign-in method, so its note must say WHY, not just assert a verdict`,
    );
  }
});

await expect("the verdicts match what better-auth 1.6.x actually does", () => {
  // Checked against the shipped source, not the docs:
  //  - two-factor: the challenge is the signed cookie better-auth.two_factor
  //    and the sign-in body is { twoFactorRedirect, twoFactorMethods };
  //  - email-otp: send sets no cookie, /sign-in/email-otp takes the code in
  //    the body and sets the session inside the handler, so bearer emits;
  //  - magic-link: /magic-link/verify answers JSON when no callbackURL is
  //    given, but the link is opened by a mail client in the browser;
  //  - passkeys: not in core at all, and a shell origin cannot be an RP ID.
  assert.equal(AUTH_SECURITY_SPECS["two-factor"].tokenShell, "no");
  assert.equal(AUTH_SECURITY_SPECS["email-otp"].tokenShell, "yes");
  assert.equal(AUTH_SECURITY_SPECS["magic-link"].tokenShell, "partial");
  assert.equal(AUTH_SECURITY_SPECS.passkeys.tokenShell, "no");
});

await expect("the answers reach the generated docs", () => {
  const plan = planAuthAccountSecurity({
    options: ALL_OPTIONS,
    hasNativeClient: true,
    hasEmailTransport: true,
  });
  const docs = renderAuthSecurityDocs({
    projectName: "Test App",
    plan,
    hasNativeClient: true,
    hasEmailTransport: true,
  });
  assert.match(docs, /stored-token client/);
  for (const option of AUTH_SECURITY_OPTIONS) {
    const spec = specFor(option);
    if (spec.tokenShell === "n/a") continue;
    assert.ok(docs.includes(spec.label), `${option} is missing from the docs table`);
  }
  // The order is written down where somebody changing auth.ts will see it.
  assert.match(docs, /bearer/);
  assert.match(docs, /plugin order/i);
});

await expect("the docs are written into the project", async () => {
  const dir = makeProject();
  const audit = await apply(dir, ALL_OPTIONS);
  assert.ok(existsSync(join(dir, "docs/account-security.md")));
  assert.ok(audit.manualResidue.some((step) => /backfill/.test(step)));
});

// ── 5. The feature-authoring contract ─────────────────────────────────
console.log("\nfeature contract:");

await expect("the feature registers, and can be added after scaffold", () => {
  assert.equal(getFeature("auth-account-security"), authAccountSecurityFeature);
  assert.equal(
    authAccountSecurityFeature.addableAfterScaffold,
    true,
    "the whole point is that it can be layered onto a live project",
  );
  // It strips nothing, so it has no prerequisites and conflicts with
  // nothing. If that ever changes, declare it rather than documenting it.
  assert.equal(authAccountSecurityFeature.requires, undefined);
  assert.equal(authAccountSecurityFeature.conflictsWith, undefined);
});

await expect("a dry run describes the change without touching the disk", async () => {
  const dir = makeProject();
  const before = readFileSync(join(dir, "packages/server/src/auth/auth.ts"), "utf-8");
  const ledger = new FeatureLedger(dir, true);

  await applyAuthAccountSecurity({
    projectDir: dir,
    projectName: "Test App",
    options: ALL_OPTIONS,
    hasNativeClient: true,
    hasEmailTransport: false,
    ledger,
  });

  assert.ok(ledger.touched, "a dry run must still report that there is something to do");
  assert.ok(
    ledger.entries.some((entry) => entry.action === "would-write"),
    "a dry run must describe the writes it would make",
  );
  assert.equal(
    readFileSync(join(dir, "packages/server/src/auth/auth.ts"), "utf-8"),
    before,
    "a dry run changed auth.ts",
  );
  assert.ok(
    !existsSync(join(dir, "packages/client/src/lib/safe-next.ts")),
    "a dry run created a file",
  );
  // Every entry is attributed, so a combined run can report per feature.
  assert.ok(ledger.entries.every((entry) => entry.feature === "auth-account-security"));
});

await expect("a real run through a shared ledger reports no conflicts", async () => {
  const dir = makeProject();
  const ledger = new FeatureLedger(dir, false);
  await applyAuthAccountSecurity({
    projectDir: dir,
    projectName: "Test App",
    options: ALL_OPTIONS,
    hasNativeClient: true,
    hasEmailTransport: false,
    ledger,
  });
  assert.deepEqual(
    ledger.conflicts().map((entry) => `${entry.file}: ${entry.detail}`),
    [],
    "a fresh project must apply cleanly",
  );

  // And a second pass over the same ledger writes nothing new.
  const second = new FeatureLedger(dir, false);
  await applyAuthAccountSecurity({
    projectDir: dir,
    projectName: "Test App",
    options: ALL_OPTIONS,
    hasNativeClient: true,
    hasEmailTransport: false,
    ledger: second,
  });
  assert.deepEqual(
    second.summary().written,
    [],
    "a re-apply wrote files: the feature is not idempotent",
  );
});

// ── Result ────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nAll account-security tests passed.\n");
