/**
 * test-auth-sign-in-methods.ts: GitHub, Discord, generic OAuth, Steam, guest
 * accounts and usernames in the `auth-account-security` feature, and account
 * linking as the starter's default.
 *
 * The generated files are read back off disk, as in the plugin-order test:
 * the rule that fails quietly is still that `bearer()` comes after every
 * plugin, and with six more plugins there are six more ways to get it wrong —
 * on the first apply and when a method is added to a project later.
 *
 * What needs better-auth itself (the Steam OpenID round trip, replay, guest
 * hand-over) is in the shipped `tests/steam-sign-in.test.ts`; this CLI has no
 * better-auth to run it with.
 *
 * Run: `node scripts/test.mjs test-auth-sign-in-methods.ts`.
 */

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { renderAuthSecurityDocs } from "./src/features/auth-account-security/docs.js";
import {
  applyAuthAccountSecurity,
  renderSignInMethodsModule,
} from "./src/features/auth-account-security/index.js";
import { specFor } from "./src/features/auth-account-security/options.js";
import {
  METHOD_ENV_VARS,
  planAuthAccountSecurity,
} from "./src/features/auth-account-security/plan.js";
import {
  ORDERED_SERVER_PLUGINS,
  extractRegisteredPlugins,
  findPluginOrderViolation,
  serverPluginsFor,
} from "./src/features/auth-account-security/plugin-order.js";
import { renderAuthSecurityTemplate } from "./src/features/auth-account-security/render.js";
import {
  ACCOUNT_LINKING_BLOCK,
  rewriteServerAuthAccountLinking,
} from "./src/features/auth-account-security/server-rewriter.js";
import {
  AUTH_SECURITY_DEFAULT_OPTIONS,
  type AuthSecurityOption,
} from "./src/features/auth-account-security/types.js";
import { wireAuth } from "./src/features/extension/patches.js";
import { applyPostgresOverlay } from "./src/scaffold/postgres-overlay.js";

const REPO = join(import.meta.dirname, "..");
const STARTER = join(REPO, "starter");

const failures: string[] = [];
async function expect(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

const FILES = [
  "packages/server/src/auth/auth.ts",
  "packages/server/src/app.ts",
  "packages/server/src/trpc/routers/health.ts",
  "packages/server/src/trpc/routers/profile.ts",
  "packages/server/src/models/Item.ts",
  "packages/server/src/models/Profile.ts",
  "packages/server/.env.example",
  "packages/server/package.json",
  "packages/client/src/lib/auth-client.ts",
  "packages/client/src/app/login/page.tsx",
  "packages/client/src/app/(protected)/settings/page.tsx",
  "packages/client/package.json",
  "packages/shared/src/index.ts",
  "docker-compose.yml",
];

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "auth-methods-"));
  for (const rel of FILES) {
    const src = join(STARTER, rel);
    if (!existsSync(src)) throw new Error(`starter is missing ${rel}`);
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(src, join(dir, rel));
  }
  return dir;
}

async function apply(dir: string, options: AuthSecurityOption[], hasNativeClient = true) {
  return applyAuthAccountSecurity({
    projectDir: dir,
    projectName: "Test App",
    options,
    hasNativeClient,
    hasEmailTransport: false,
    domain: "app.example.com",
  });
}

const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), "utf-8");
const AUTH = "packages/server/src/auth/auth.ts";
const HEALTH = "packages/server/src/trpc/routers/health.ts";
const LOGIN = "packages/client/src/app/login/page.tsx";
const SETTINGS = "packages/client/src/app/(protected)/settings/page.tsx";
const METHODS = "packages/server/src/auth/sign-in-methods.ts";
const ACCOUNTS_PAGE = "packages/client/src/app/(protected)/settings/accounts/page.tsx";

const NEW_METHODS: AuthSecurityOption[] = [
  "github-oauth",
  "discord-oauth",
  "generic-oauth",
  "steam-openid",
  "guest-accounts",
  "username-sign-in",
];
const EVERYTHING: AuthSecurityOption[] = [
  "two-factor",
  "google-oauth",
  "apple-oauth",
  ...NEW_METHODS,
];

/** The `socialProviders: { ... }` block of an auth.ts, brace-matched. */
function socialProvidersBlock(source: string): string {
  const start = source.indexOf("socialProviders: {");
  assert.ok(start !== -1, "auth.ts has no socialProviders block");
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("unterminated socialProviders block");
}

// ── 1. Plugin order ───────────────────────────────────────────────────
console.log("\nplugin order:");

await expect("every new plugin ranks ahead of bearer, guests after two-factor", () => {
  const bearer = ORDERED_SERVER_PLUGINS.indexOf("bearer");
  for (const name of [
    "usernamePlugin",
    "genericOAuthPlugin",
    "steamSignInPlugin",
    "guestAccountsPlugin",
  ]) {
    const rank = ORDERED_SERVER_PLUGINS.indexOf(name);
    assert.ok(rank !== -1 && rank < bearer, `${name} must be in the contract ahead of bearer`);
  }
  assert.ok(
    ORDERED_SERVER_PLUGINS.indexOf("twoFactorPlugin") <
      ORDERED_SERVER_PLUGINS.indexOf("guestAccountsPlugin"),
    "the guest hook must see two-factor's expired cookie, so it runs after it",
  );
  assert.deepEqual(serverPluginsFor(EVERYTHING, { hasNativeClient: true }), [
    "twoFactorPlugin",
    "usernamePlugin",
    "genericOAuthPlugin",
    "steamSignInPlugin",
    "appleSignInPlugin",
    "guestAccountsPlugin",
    "bearer",
  ]);
});

await expect("THE GENERATED auth.ts registers every method in contract order", async () => {
  const dir = makeProject();
  await apply(dir, EVERYTHING);
  const auth = read(dir, AUTH);
  assert.deepEqual(
    extractRegisteredPlugins(auth),
    serverPluginsFor(EVERYTHING, { hasNativeClient: true }),
  );
  assert.equal(findPluginOrderViolation(auth), null);
  for (const line of [
    `import { extraSocialProviders } from "./social-providers.js";`,
    `import { EXTRA_SOCIAL_PROVIDERS } from "./sign-in-methods.js";`,
    `import { genericOAuthPlugin } from "./generic-oauth.js";`,
    `import { steamSignInPlugin } from "./steam-sign-in.js";`,
    `import { guestAccountsPlugin } from "./guest-accounts.js";`,
    `import { usernamePlugin } from "./username-sign-in.js";`,
  ]) {
    assert.ok(auth.includes(line), `missing: ${line}`);
  }
  const providers = socialProvidersBlock(auth);
  const order = ["apple: appleProviderOptions(", "extraSocialProviders(", "google:"].map((m) =>
    providers.indexOf(m),
  );
  assert.ok(
    order.every((at) => at !== -1),
    "a provider entry is missing",
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "Apple, then GitHub/Discord, then Google",
  );
  assert.equal((auth.match(/\bplugins\s*:/g) ?? []).length, 1, "exactly one plugins key");
  assert.equal((auth.match(/accountLinking/g) ?? []).length, 1, "exactly one accountLinking block");
  assert.ok(!auth.includes("__HATCHKIT_"));
});

await expect("methods added on a LATER run land at their rank", async () => {
  const dir = makeProject();
  await apply(dir, ["two-factor", "apple-oauth"]);
  await apply(dir, [
    "two-factor",
    "apple-oauth",
    "steam-openid",
    "guest-accounts",
    "username-sign-in",
  ]);
  const auth = read(dir, AUTH);
  assert.deepEqual(extractRegisteredPlugins(auth), [
    "twoFactorPlugin",
    "usernamePlugin",
    "steamSignInPlugin",
    "appleSignInPlugin",
    "guestAccountsPlugin",
    "bearer",
  ]);
  assert.equal(findPluginOrderViolation(auth), null);
  const again = read(dir, AUTH);
  await apply(dir, [
    "two-factor",
    "apple-oauth",
    "steam-openid",
    "guest-accounts",
    "username-sign-in",
  ]);
  assert.equal(read(dir, AUTH), again, "a third run changed auth.ts");
});

await expect("the extension's per-request trustedOrigins survives every method", async () => {
  const dir = makeProject();
  const wired = wireAuth(read(dir, AUTH));
  assert.equal(wired.problem, undefined);
  writeFileSync(join(dir, AUTH), wired.content);
  await apply(dir, EVERYTHING);
  assert.ok(read(dir, AUTH).includes("trustedOriginsForRequest(getTrustedOrigins(), request"));
});

// ── 2. Generated modules ──────────────────────────────────────────────
console.log("\ngenerated modules:");

await expect("sign-in-methods.ts lists exactly the selection", () => {
  const has = (options: AuthSecurityOption[]) => (option: AuthSecurityOption) =>
    options.includes(option);
  const all = renderSignInMethodsModule(has(NEW_METHODS));
  assert.match(
    all,
    /EXTRA_SOCIAL_PROVIDERS: readonly ExtraSocialProvider\[\] = \["github", "discord"\];/,
  );
  assert.match(all, /oauth: genericOAuthButton\(\),/);
  assert.match(all, /steam: isSteamSignInEnabled\(\),/);
  assert.match(all, /guest: true,/);
  assert.match(all, /username: true,/);
  const none = renderSignInMethodsModule(has([]));
  assert.ok(!none.includes("import "), "no method selected, so nothing to import");
  assert.ok(!none.includes("EXTRA_SOCIAL_PROVIDERS"));
  assert.match(none, /social: \[\],/);
  const discordOnly = renderSignInMethodsModule(has(["discord-oauth"]));
  assert.match(discordOnly, /= \["discord"\];/);
});

await expect("social-providers.ts turns a provider on only with both variables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "social-providers-"));
  const path = join(dir, "social-providers.ts");
  writeFileSync(path, renderAuthSecurityTemplate("server/social-providers.ts", {}));
  const mod = await import(pathToFileURL(path).href);
  const env = {
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    DISCORD_CLIENT_ID: "only-id",
  };
  assert.deepEqual(mod.extraSocialProviders(["github", "discord"], env), {
    github: { clientId: "id", clientSecret: "secret" },
  });
  assert.deepEqual(mod.enabledExtraSocialProviders(["github", "discord"], env), ["github"]);
  assert.deepEqual(
    mod.enabledExtraSocialProviders(["discord"], env),
    [],
    "not selected, not offered",
  );
});

await expect("the guest hand-over is rendered for the project's database", async () => {
  const mongo = makeProject();
  await apply(mongo, ["guest-accounts"]);
  const mongoMove = read(mongo, "packages/server/src/services/guest-upgrade.ts");
  assert.match(mongoMove, /import \{ Item \} from "\.\.\/models\/Item\.js";/);
  assert.match(
    mongoMove,
    /Item\.updateMany\(\{ ownerId: fromUserId \}, \{ \$set: \{ ownerId: toUserId \} \}\)/,
  );

  const pg = makeProject();
  for (const rel of ["packages/server/src/db", "e2e"])
    mkdirSync(join(pg, rel), { recursive: true });
  applyPostgresOverlay(pg);
  await apply(pg, ["guest-accounts"]);
  const pgMove = read(pg, "packages/server/src/services/guest-upgrade.ts");
  assert.match(
    pgMove,
    /getDb\(\)\.update\(items\)\.set\(\{ ownerId: toUserId \}\)\.where\(eq\(items\.ownerId, fromUserId\)\)/,
  );
  assert.ok(!pgMove.includes("__HATCHKIT_"));
});

// ── 3. Health, login, settings ────────────────────────────────────────
console.log("\nhealth, login and settings:");

await expect("health.check publishes signInMethods beside the booleans", async () => {
  const dir = makeProject();
  await apply(dir, ["apple-oauth", "steam-openid"]);
  const health = read(dir, HEALTH);
  assert.match(health, /signInMethods: publicSignInMethods\(\),/);
  assert.match(health, /appleEnabled: isAppleSignInConfigured\(\),/);
  assert.match(
    health,
    /import \{ publicSignInMethods \} from "\.\.\/\.\.\/auth\/sign-in-methods\.js";/,
  );
  assert.ok(existsSync(join(dir, METHODS)));
});

await expect("the login page gets the extra buttons and the username form", async () => {
  const withTwoFactor = makeProject();
  await apply(withTwoFactor, ["two-factor", "apple-oauth", "steam-openid", "username-sign-in"]);
  const login = read(withTwoFactor, LOGIN);
  const block = login.slice(login.indexOf('<div className="space-y-3 border-t pt-6">'));
  const at = ["<AppleSignInButton", "<MoreSignInMethods", "<UsernameSignIn"].map((m) =>
    block.indexOf(m),
  );
  assert.ok(
    at.every((i) => i !== -1),
    "a component is missing from the block",
  );
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
    "Apple first, the rest after",
  );
  assert.match(login, /onTwoFactor=\{\(\) => setStep\("two-factor"\)\}/);

  const plain = makeProject();
  await apply(plain, ["username-sign-in"]);
  assert.ok(!read(plain, LOGIN).includes("onTwoFactor"), "no two-factor step to hand over to");
  assert.ok(!read(plain, LOGIN).includes("<MoreSignInMethods"), "no redirect method selected");
});

await expect("Settings links to Sign-in methods, once", async () => {
  const dir = makeProject();
  await apply(dir, ["google-oauth"]);
  const settings = read(dir, SETTINGS);
  assert.match(settings, /href="\/settings\/accounts"/);
  assert.match(settings, /^import Link from "next\/link";$/m);
  await apply(dir, ["google-oauth"]);
  assert.equal(read(dir, SETTINGS), settings, "patched twice");
});

await expect("the Sign-in methods page is written whatever the selection", async () => {
  const bare = makeProject();
  await apply(bare, [], false);
  const page = read(bare, ACCOUNTS_PAGE);
  assert.match(page, /<LinkedAccounts \/>/);
  assert.ok(!page.includes("UsernameSettings"));
  assert.ok(!page.includes("__HATCHKIT_"));
  assert.ok(existsSync(join(bare, "packages/client/src/components/settings/linked-accounts.tsx")));

  const named = makeProject();
  await apply(named, ["username-sign-in"]);
  assert.match(read(named, ACCOUNTS_PAGE), /<UsernameSettings \/>/);
});

await expect("every env-gated method lists its variables, empty", async () => {
  const dir = makeProject();
  await apply(dir, NEW_METHODS);
  const example = read(dir, "packages/server/.env.example");
  const compose = read(dir, "docker-compose.yml");
  for (const option of [
    "github-oauth",
    "discord-oauth",
    "generic-oauth",
    "steam-openid",
  ] as const) {
    for (const { key } of METHOD_ENV_VARS[option] ?? []) {
      assert.match(example, new RegExp(`^# ${key}=$`, "m"), `${key} missing from .env.example`);
      assert.ok(
        compose.includes(`      ${key}: \${${key}:-}`),
        `${key} missing from docker-compose.yml`,
      );
    }
  }
});

await expect("applying everything twice changes nothing", async () => {
  const dir = makeProject();
  await apply(dir, EVERYTHING);
  const rels = [...FILES, METHODS, ACCOUNTS_PAGE];
  const before = Object.fromEntries(rels.map((rel) => [rel, read(dir, rel)]));
  const second = await apply(dir, EVERYTHING);
  for (const rel of rels) assert.equal(read(dir, rel), before[rel], `${rel} changed on a re-run`);
  assert.equal(second.written.length, 0);
});

// ── 4. Account linking ────────────────────────────────────────────────
console.log("\naccount linking:");

await expect("the starter ships the linking block the rewriter writes", () => {
  const starter = readFileSync(join(STARTER, AUTH), "utf-8");
  assert.ok(
    starter.includes(ACCOUNT_LINKING_BLOCK),
    "starter auth.ts drifted from ACCOUNT_LINKING_BLOCK",
  );
  const overlay = readFileSync(join(REPO, "cli/src/scaffold/postgres-overlay.ts"), "utf-8");
  // The overlay holds the text inside a template literal, backticks escaped.
  assert.ok(
    overlay.includes(ACCOUNT_LINKING_BLOCK.replace(/`/g, "\\`")),
    "Postgres overlay auth.ts drifted from ACCOUNT_LINKING_BLOCK",
  );
});

await expect("linking is safe by default: verified both sides, never the last method", () => {
  assert.match(ACCOUNT_LINKING_BLOCK, /requireLocalEmailVerified: true/);
  assert.match(ACCOUNT_LINKING_BLOCK, /allowUnlinkingAll: false/);
  assert.match(ACCOUNT_LINKING_BLOCK, /trustedProviders: \["google", "apple"\]/);
  // Only providers that verify every address they return may be trusted by name.
  for (const unsafe of ["github", "discord", "steam"]) {
    assert.ok(
      !/trustedProviders: \[[^\]]*"(github|discord|steam)"/.test(ACCOUNT_LINKING_BLOCK),
      unsafe,
    );
  }
});

await expect("an existing project without linking gets the block after socialProviders", () => {
  const starter = readFileSync(join(STARTER, AUTH), "utf-8");
  const old = starter.replace(`\n\n${ACCOUNT_LINKING_BLOCK}`, "");
  assert.ok(!old.includes("accountLinking"), "control: block removed");
  const result = rewriteServerAuthAccountLinking(old);
  assert.equal(result.applied, true);
  assert.equal(result.source, starter, "the rewriter must reproduce the starter exactly");
  assert.equal(
    rewriteServerAuthAccountLinking(result.source).source,
    result.source,
    "not idempotent",
  );
  const custom = old.replace(
    "    session: {",
    "    account: { encryptOAuthTokens: true },\n\n    session: {",
  );
  assert.equal(
    rewriteServerAuthAccountLinking(custom).applied,
    false,
    "an own account: block is left alone",
  );
});

// ── 5. Catalogue and docs ─────────────────────────────────────────────
console.log("\ncatalogue and docs:");

await expect("each new method has an honest native-shell verdict and is off by default", () => {
  const expected: Record<string, string> = {
    "github-oauth": "no",
    "discord-oauth": "no",
    "generic-oauth": "no",
    "steam-openid": "no",
    "guest-accounts": "yes",
    "username-sign-in": "yes",
  };
  for (const option of NEW_METHODS) {
    assert.equal(specFor(option).tokenShell, expected[option], option);
    assert.ok(specFor(option).tokenShellNote.length > 60, `${option} must say why`);
    assert.ok(!AUTH_SECURITY_DEFAULT_OPTIONS.includes(option), `${option} must be off by default`);
  }
});

await expect("the generated docs explain linking and each selected method", () => {
  const input = { options: [...NEW_METHODS], hasNativeClient: true, hasEmailTransport: true };
  const docs = renderAuthSecurityDocs({
    ...input,
    projectName: "Test App",
    plan: planAuthAccountSecurity(input),
  });
  assert.match(docs, /Account linking is on/);
  assert.match(docs, /\/settings\/accounts/);
  for (const title of [
    "GitHub sign-in",
    "Discord sign-in",
    "Generic OAuth / OIDC sign-in",
    "Steam sign-in",
  ]) {
    assert.ok(docs.includes(`### ${title}`), `${title} section missing`);
  }
  assert.match(docs, /services\/guest-upgrade\.ts/);
  assert.match(docs, /`https:\/\/<domain>\/api\/auth\/callback\/github`/);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nAll sign-in method tests passed.\n");
