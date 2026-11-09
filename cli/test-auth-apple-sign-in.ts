/**
 * test-auth-apple-sign-in.ts: the `apple-oauth` option of the
 * `auth-account-security` feature.
 *
 * Three groups, and the first is the one that fails quietly:
 *
 *  1. **The generated `auth.ts`.** Read back off disk, like the plugin-order
 *     test in test-auth-account-security.ts: the provider block, the config
 *     read above `betterAuth({`, Apple's plugin AHEAD of `bearer()`, and the
 *     `trustedOrigins:` line left exactly as it was — other features replace
 *     that line wholesale, so Apple must never depend on it.
 *
 *  2. **The secret minter**, rendered from its template and imported, so the
 *     module under test is the one a project gets: config parsing, the ES256
 *     signature, the refresh, and the getter better-auth reads.
 *
 *  3. **Everything around it**: health router, login page, env examples,
 *     idempotence, the retrofit onto an already-patched project, and docs.
 *
 * The shipped `apple-sign-in.test.ts` covers what needs better-auth itself
 * (the getter surviving init, the form_post passing the origin check); this
 * CLI has no better-auth dependency to run it with.
 *
 * Run: `node scripts/test.mjs test-auth-apple-sign-in.ts`.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { rewriteLoginPageApple } from "./src/features/auth-account-security/client-rewriter.js";
import { renderAuthSecurityDocs } from "./src/features/auth-account-security/docs.js";
import { applyAuthAccountSecurity } from "./src/features/auth-account-security/index.js";
import { specFor } from "./src/features/auth-account-security/options.js";
import {
  APPLE_ENV_VARS,
  planAuthAccountSecurity,
} from "./src/features/auth-account-security/plan.js";
import {
  extractRegisteredPlugins,
  findPluginOrderViolation,
  serverPluginsFor,
} from "./src/features/auth-account-security/plugin-order.js";
import { renderAuthSecurityTemplate } from "./src/features/auth-account-security/render.js";
import {
  rewriteHealthRouterApple,
  rewriteServerAuthApple,
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
  "packages/server/.env.example",
  "packages/server/package.json",
  "packages/client/src/lib/auth-client.ts",
  "packages/client/src/app/login/page.tsx",
  "packages/client/package.json",
  "packages/shared/src/index.ts",
  "docker-compose.yml",
];

/** A throwaway project holding the real starter's copies of the files the
 *  feature patches, so the anchors under test are the shipped ones. */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "auth-apple-"));
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

// ── 1. The generated auth.ts ──────────────────────────────────────────
console.log("\ngenerated auth.ts:");

await expect("Apple's plugin sorts ahead of bearer whatever it is asked with", () => {
  assert.deepEqual(serverPluginsFor(["apple-oauth", "two-factor"], { hasNativeClient: true }), [
    "twoFactorPlugin",
    "appleSignInPlugin",
    "bearer",
  ]);
  assert.deepEqual(serverPluginsFor(["apple-oauth"], { hasNativeClient: false }), [
    "appleSignInPlugin",
  ]);
});

await expect("THE GENERATED auth.ts wires Apple and keeps bearer last", async () => {
  const dir = makeProject();
  await apply(dir, ["two-factor", "google-oauth", "apple-oauth"]);
  const auth = read(dir, AUTH);

  assert.match(
    auth,
    /^import \{ appleProviderOptions, appleSignInConfig, appleSignInPlugin \} from "\.\/apple-sign-in\.js";$/m,
  );
  // Read once, above the call, so the provider and the plugin agree.
  const configAt = auth.indexOf("const appleConfig = appleSignInConfig();");
  assert.ok(configAt !== -1, "the Apple config is not read");
  assert.ok(
    configAt < auth.indexOf("_auth = betterAuth({"),
    "the config must be read before betterAuth({",
  );

  const providers = socialProvidersBlock(auth);
  assert.match(
    providers,
    /socialProviders: \{\n {6}\.\.\.\(appleConfig \? \{ apple: appleProviderOptions\(appleConfig\) \} : \{\}\),\n/,
    "Apple must be the first, env-gated entry",
  );
  assert.ok(providers.includes("google:"), "Google must still be there");

  const registered = extractRegisteredPlugins(auth);
  assert.deepEqual(registered, ["twoFactorPlugin", "appleSignInPlugin", "bearer"]);
  assert.equal(findPluginOrderViolation(auth), null);
  assert.ok(auth.includes("appleSignInPlugin(appleConfig),"));

  // Apple's origin arrives through the plugin, never through this line —
  // which the extension feature replaces wholesale.
  assert.ok(auth.includes("\n    trustedOrigins: getTrustedOrigins(),\n"));
  assert.ok(!/trustedOrigins:[^\n]*appleid/.test(auth));
  assert.ok(!auth.includes("__HATCHKIT_"), "unrendered placeholder");
});

await expect("a web-only project with Apple alone gets a one-plugin array", async () => {
  const dir = makeProject();
  await apply(dir, ["apple-oauth"], false);
  const auth = read(dir, AUTH);
  assert.deepEqual(extractRegisteredPlugins(auth), ["appleSignInPlugin"]);
  assert.equal((auth.match(/\bplugins\s*:/g) ?? []).length, 1, "exactly one plugins key");
});

await expect("the Postgres overlay's auth.ts takes the same patch", async () => {
  const dir = makeProject();
  // The overlay writes whole files and needs only their directories.
  for (const rel of ["packages/server/src/db", "packages/server/src/models", "e2e"]) {
    mkdirSync(join(dir, rel), { recursive: true });
  }
  applyPostgresOverlay(dir);
  assert.ok(read(dir, AUTH).includes("drizzleAdapter"), "overlay did not write its auth.ts");
  await apply(dir, ["two-factor", "apple-oauth"]);
  const auth = read(dir, AUTH);
  assert.ok(auth.includes("apple: appleProviderOptions(appleConfig)"));
  assert.deepEqual(extractRegisteredPlugins(auth), [
    "twoFactorPlugin",
    "appleSignInPlugin",
    "bearer",
  ]);
});

await expect(
  "it composes with the extension's per-request trustedOrigins, in either order",
  async () => {
    // Extension first, Apple second.
    const first = makeProject();
    const wired = wireAuth(read(first, AUTH));
    assert.equal(wired.problem, undefined);
    writeFileSync(join(first, AUTH), wired.content);
    const audit = await apply(first, ["apple-oauth"]);
    const auth = read(first, AUTH);
    assert.ok(
      auth.includes("trustedOriginsForRequest(getTrustedOrigins(), request"),
      "extension wiring lost",
    );
    assert.ok(auth.includes("apple: appleProviderOptions(appleConfig)"));
    assert.ok(
      !audit.manualResidue.some((step) => step.startsWith("server auth")),
      audit.manualResidue.join(" | "),
    );

    // Apple first, extension second: its anchor must still be there.
    const second = makeProject();
    await apply(second, ["apple-oauth"]);
    const after = wireAuth(read(second, AUTH));
    assert.equal(after.problem, undefined, "the extension's trustedOrigins anchor was disturbed");
  },
);

// ── 2. The minter ─────────────────────────────────────────────────────
console.log("\nclient-secret minting:");

const moduleDir = mkdtempSync(join(tmpdir(), "apple-sign-in-module-"));
const modulePath = join(moduleDir, "apple-sign-in.ts");
writeFileSync(modulePath, renderAuthSecurityTemplate("server/apple-sign-in.ts", {}), "utf-8");
const apple = await import(pathToFileURL(modulePath).href);

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ENV = {
  APPLE_CLIENT_ID: "com.example.app.signin",
  APPLE_TEAM_ID: "ABCDE12345",
  APPLE_KEY_ID: "KEY1234567",
  APPLE_PRIVATE_KEY: PEM.replace(/\n/g, "\\n"),
};

function decode(jwt: string): {
  header: Record<string, unknown>;
  payload: Record<string, number | string>;
} {
  const [h, p] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h ?? "", "base64url").toString()),
    payload: JSON.parse(Buffer.from(p ?? "", "base64url").toString()),
  };
}

function verifies(jwt: string): boolean {
  const [h, p, s] = jwt.split(".");
  return verify(
    "sha256",
    Buffer.from(`${h}.${p}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(s ?? "", "base64url"),
  );
}

await expect("nothing set: off, and silent", () => {
  const logged: string[] = [];
  assert.equal(
    apple.readAppleConfig({}, (m: string) => logged.push(m)),
    null,
  );
  assert.deepEqual(logged, []);
});

await expect("a partial set is off and names what is missing, never a value", () => {
  const logged: string[] = [];
  const config = apple.readAppleConfig(
    { APPLE_CLIENT_ID: ENV.APPLE_CLIENT_ID, APPLE_PRIVATE_KEY: ENV.APPLE_PRIVATE_KEY },
    (m: string) => logged.push(m),
  );
  assert.equal(config, null);
  assert.equal(logged.length, 1);
  assert.match(logged[0] ?? "", /APPLE_TEAM_ID, APPLE_KEY_ID/);
  assert.ok(!(logged[0] ?? "").includes("PRIVATE KEY-----"), "a key reached the log");
  assert.ok(!(logged[0] ?? "").includes(ENV.APPLE_CLIENT_ID), "a value reached the log");
});

await expect("malformed ids and keys switch Apple off with a reason", () => {
  const quiet = (): void => {};
  assert.equal(apple.readAppleConfig({ ...ENV, APPLE_TEAM_ID: "abc" }, quiet), null);
  assert.equal(apple.readAppleConfig({ ...ENV, APPLE_KEY_ID: "KEY-123" }, quiet), null);
  assert.equal(apple.readAppleConfig({ ...ENV, APPLE_PRIVATE_KEY: "not a key" }, quiet), null);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  assert.equal(
    apple.readAppleConfig({ ...ENV, APPLE_PRIVATE_KEY: rsa }, quiet),
    null,
    "RSA key accepted",
  );
  const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  assert.equal(
    apple.readAppleConfig({ ...ENV, APPLE_PRIVATE_KEY: p384 }, quiet),
    null,
    "P-384 key accepted",
  );
});

await expect("the key is accepted with literal \\n and with real line breaks", () => {
  assert.ok(apple.readAppleConfig(ENV, () => {}));
  assert.ok(apple.readAppleConfig({ ...ENV, APPLE_PRIVATE_KEY: PEM }, () => {}));
  const padded = apple.readAppleConfig(
    { ...ENV, APPLE_CLIENT_ID: `  ${ENV.APPLE_CLIENT_ID} ` },
    () => {},
  );
  assert.equal(padded?.clientId, ENV.APPLE_CLIENT_ID);
  assert.equal(padded?.appBundleIdentifier, undefined);
});

await expect("the secret is an ES256 JWT Apple's token endpoint accepts", () => {
  const config = apple.readAppleConfig(ENV, () => {});
  const now = 1_700_000_000;
  const secret = apple.createAppleClientSecret(config, now);
  const { header, payload } = decode(secret);
  assert.deepEqual(header, { alg: "ES256", kid: "KEY1234567", typ: "JWT" });
  assert.deepEqual(payload, {
    iss: "ABCDE12345",
    iat: now,
    exp: now + apple.APPLE_SECRET_TTL_SEC,
    aud: "https://appleid.apple.com",
    sub: "com.example.app.signin",
  });
  // Raw r||s, not DER: a DER signature is 70-72 bytes and Apple refuses it.
  assert.equal(Buffer.from(secret.split(".")[2] ?? "", "base64url").length, 64);
  assert.ok(verifies(secret), "signature does not verify");
});

await expect("no secret outlives Apple's six-month limit", () => {
  const config = apple.readAppleConfig(ENV, () => {});
  const { payload } = decode(apple.createAppleClientSecret(config, 0, 10 * 365 * 24 * 3600));
  assert.equal(payload.exp, apple.APPLE_MAX_SECRET_TTL_SEC);
  assert.ok(apple.APPLE_SECRET_TTL_SEC < apple.APPLE_MAX_SECRET_TTL_SEC);
  assert.ok(apple.APPLE_SECRET_REFRESH_AFTER_SEC < apple.APPLE_SECRET_TTL_SEC);
});

await expect("the source re-mints only after the refresh interval", () => {
  const config = apple.readAppleConfig(ENV, () => {});
  let now = 1_700_000_000;
  const source = apple.createAppleClientSecretSource(config, () => now);
  const first = source();
  now += apple.APPLE_SECRET_REFRESH_AFTER_SEC - 1;
  assert.equal(source(), first, "re-minted too early");
  now += 1;
  const second = source();
  assert.notEqual(second, first, "did not re-mint");
  assert.equal(decode(second).payload.iat, now);
  assert.ok(verifies(second));
  assert.equal(source(), second, "re-minted on every read");
});

await expect("clientSecret is a GETTER that follows the clock", () => {
  const config = apple.readAppleConfig(ENV, () => {});
  let now = 1_700_000_000;
  const options = apple.appleProviderOptions(config, () => now);
  const descriptor = Object.getOwnPropertyDescriptor(options, "clientSecret");
  assert.equal(typeof descriptor?.get, "function", "a plain value expires after 90 days");
  const first = options.clientSecret;
  now += apple.APPLE_SECRET_REFRESH_AFTER_SEC;
  assert.notEqual(options.clientSecret, first);
  // Spreading the provider entry, as auth.ts does, must keep the object.
  const wrapped = { ...(config ? { apple: options } : {}) };
  assert.equal(wrapped.apple, options);
});

await expect("ID-token sign-in is off without a bundle ID, and scoped to it with one", () => {
  const web = apple.appleProviderOptions(apple.readAppleConfig(ENV, () => {}));
  assert.equal(web.disableIdTokenSignIn, true);
  assert.equal(web.audience, undefined);
  const native = apple.appleProviderOptions(
    apple.readAppleConfig({ ...ENV, APPLE_APP_BUNDLE_ID: "com.example.app" }, () => {}),
  );
  assert.deepEqual(
    native.audience,
    ["com.example.app"],
    "the web Services ID must not be an audience",
  );
  assert.equal(native.appBundleIdentifier, "com.example.app");
  assert.equal(native.disableIdTokenSignIn, undefined);
});

await expect("the plugin adds Apple's origin only when configured", async () => {
  const off = apple.appleSignInPlugin(null);
  assert.deepEqual(await off.init(), {});
  const on = apple.appleSignInPlugin(apple.readAppleConfig(ENV, () => {}));
  assert.deepEqual(await on.init(), { options: { trustedOrigins: ["https://appleid.apple.com"] } });
  assert.equal(on.hooks, undefined, "the plugin must not grow hooks: it sits ahead of bearer()");
});

await expect("the process config is read lazily and once", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, ENV);
    assert.equal(apple.isAppleSignInConfigured(), true);
    delete process.env.APPLE_CLIENT_ID;
    assert.equal(apple.isAppleSignInConfigured(), true, "re-read the environment");
  } finally {
    for (const key of Object.keys(ENV)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

// ── 3. Around it ──────────────────────────────────────────────────────
console.log("\nhealth, login, env and idempotence:");

await expect("the health router publishes appleEnabled inside authConfig", async () => {
  const dir = makeProject();
  await apply(dir, ["apple-oauth"]);
  const health = read(dir, HEALTH);
  assert.match(
    health,
    /import \{ isAppleSignInConfigured \} from "\.\.\/\.\.\/auth\/apple-sign-in\.js";/,
  );
  assert.match(
    health,
    /authConfig: \{\n\s+\.\.\.resolveAuthConfig\(\{[\s\S]*?\}\),\n[\s\S]*?appleEnabled: isAppleSignInConfigured\(\),\n\s+\},/,
  );
  assert.equal(rewriteHealthRouterApple(health).source, health, "not idempotent");
  assert.equal(rewriteHealthRouterApple("export const x = 1;\n").applied, false);
});

await expect("the login page puts Apple first among the other methods", async () => {
  const dir = makeProject();
  await apply(dir, ["google-oauth", "apple-oauth"]);
  const login = read(dir, LOGIN);
  assert.match(
    login,
    /^import \{ AppleSignInButton \} from "@\/components\/auth\/apple-sign-in-button";$/m,
  );
  assert.match(
    login,
    /<div className="space-y-3 border-t pt-6">\n\s+<AppleSignInButton \/>\n\s+<GoogleSignInButton \/>/,
  );

  const alone = makeProject();
  await apply(alone, ["apple-oauth"]);
  assert.match(
    read(alone, LOGIN),
    /<div className="space-y-3 border-t pt-6">\n\s+<AppleSignInButton \/>\n\s+<\/div>/,
  );
  assert.equal(rewriteLoginPageApple(read(alone, LOGIN)).source, read(alone, LOGIN));
});

await expect("the env example and compose file list every variable, with no value", async () => {
  const dir = makeProject();
  const audit = await apply(dir, ["apple-oauth"]);
  const example = read(dir, "packages/server/.env.example");
  const compose = read(dir, "docker-compose.yml");
  for (const { key } of APPLE_ENV_VARS) {
    assert.match(example, new RegExp(`^# ${key}=$`, "m"), `${key} missing from .env.example`);
    assert.ok(
      compose.includes(`      ${key}: \${${key}:-}`),
      `${key} missing from docker-compose.yml`,
    );
  }
  assert.ok(
    example.indexOf("# hatchkit:begin apple-sign-in") > example.indexOf("GOOGLE_CLIENT_SECRET"),
  );
  assert.ok(
    compose.indexOf("hatchkit:begin apple-sign-in") > compose.indexOf("GOOGLE_CLIENT_SECRET:"),
  );
  assert.ok(compose.indexOf("hatchkit:begin apple-sign-in") < compose.indexOf("depends_on:"));
  const residue = audit.manualResidue.join("\n");
  assert.match(residue, /https:\/\/app\.example\.com\/api\/auth\/callback\/apple/);
  assert.match(residue, /no API/);
});

await expect("a compose file with no Google line is left alone and reported", async () => {
  const dir = makeProject();
  writeFileSync(join(dir, "docker-compose.yml"), "services:\n  server:\n    image: app\n");
  const audit = await apply(dir, ["apple-oauth"]);
  assert.equal(read(dir, "docker-compose.yml"), "services:\n  server:\n    image: app\n");
  assert.ok(audit.manualResidue.some((step) => step.includes("docker-compose.yml")));
});

await expect("applying twice changes nothing", async () => {
  const dir = makeProject();
  await apply(dir, ["two-factor", "google-oauth", "apple-oauth"]);
  const before = Object.fromEntries(FILES.map((rel) => [rel, read(dir, rel)]));
  const second = await apply(dir, ["two-factor", "google-oauth", "apple-oauth"]);
  for (const rel of FILES) assert.equal(read(dir, rel), before[rel], `${rel} changed on a re-run`);
  assert.equal(second.written.length, 0);
});

await expect("Apple added on a LATER run lands in an already-patched project", async () => {
  const dir = makeProject();
  await apply(dir, ["two-factor", "google-oauth"]);
  assert.ok(!read(dir, AUTH).includes("apple"), "control: no Apple yet");
  await apply(dir, ["two-factor", "google-oauth", "apple-oauth"]);
  const auth = read(dir, AUTH);
  assert.deepEqual(extractRegisteredPlugins(auth), [
    "twoFactorPlugin",
    "appleSignInPlugin",
    "bearer",
  ]);
  assert.ok(auth.includes("apple: appleProviderOptions(appleConfig)"));
  assert.ok(read(dir, HEALTH).includes("appleEnabled: isAppleSignInConfigured()"));
  assert.ok(read(dir, LOGIN).includes("<AppleSignInButton />"));
  assert.ok(existsSync(join(dir, "packages/server/src/auth/apple-sign-in.ts")));
  const again = Object.fromEntries(FILES.map((rel) => [rel, read(dir, rel)]));
  await apply(dir, ["two-factor", "google-oauth", "apple-oauth"]);
  for (const rel of FILES)
    assert.equal(read(dir, rel), again[rel], `${rel} changed on a third run`);
});

await expect(
  "an Apple step that declines leaves the rest patched and nothing dangling",
  async () => {
    const dir = makeProject();
    const original = read(dir, AUTH);
    writeFileSync(
      join(dir, AUTH),
      original.replace(`    ${socialProvidersBlock(original)},\n`, ""),
    );
    const audit = await apply(dir, ["two-factor", "apple-oauth"]);
    const auth = read(dir, AUTH);
    assert.deepEqual(
      extractRegisteredPlugins(auth),
      ["twoFactorPlugin", "bearer"],
      "base patch lost",
    );
    assert.ok(!auth.includes("appleConfig"), "a name nothing declares was left behind");
    assert.ok(!auth.includes("apple-sign-in.js"));
    assert.ok(
      audit.manualResidue.some((step) => /server auth: .*socialProviders/.test(step)),
      audit.manualResidue.join(" | "),
    );
  },
);

await expect("plugin arrays of every shape get Apple ahead of bearer", () => {
  const wrap = (plugins: string): string =>
    `import { x } from "y";\nexport async function initAuth() {\n  _auth = betterAuth({\n    socialProviders: {\n    },\n${plugins}\n  });\n}\n`;
  const cases: Array<[string, string[]]> = [
    [
      "    plugins: [twoFactorPlugin(), bearer()],",
      ["twoFactorPlugin", "appleSignInPlugin", "bearer"],
    ],
    ["    plugins: [bearer()],", ["appleSignInPlugin", "bearer"]],
    ["    plugins: [twoFactorPlugin()],", ["twoFactorPlugin", "appleSignInPlugin"]],
    ["    plugins: [\n      twoFactorPlugin()\n    ],", ["twoFactorPlugin", "appleSignInPlugin"]],
    [
      "    plugins: [\n      twoFactorPlugin(),\n      ...(native ? [bearer()] : []),\n    ],",
      ["twoFactorPlugin", "appleSignInPlugin", "bearer"],
    ],
    ["    session: {},", ["appleSignInPlugin"]],
  ];
  for (const [plugins, expected] of cases) {
    const result = rewriteServerAuthApple(wrap(plugins));
    assert.equal(result.applied, true, plugins);
    assert.deepEqual(extractRegisteredPlugins(result.source), expected, plugins);
    assert.equal(findPluginOrderViolation(result.source), null, plugins);
    assert.equal(
      rewriteServerAuthApple(result.source).source,
      result.source,
      `not idempotent: ${plugins}`,
    );
    // A missing comma would be a syntax error the order check cannot see.
    assert.ok(!/\)\n\s+appleSignInPlugin/.test(result.source), `missing comma: ${plugins}`);
  }
  assert.equal(rewriteServerAuthApple("const x = 1;\n").applied, false);
});

// ── 4. Catalogue and docs ─────────────────────────────────────────────
console.log("\ncatalogue and docs:");

await expect("off by default, and honest about native shells", () => {
  assert.ok(!AUTH_SECURITY_DEFAULT_OPTIONS.includes("apple-oauth"));
  const spec = specFor("apple-oauth");
  assert.equal(spec.tokenShell, "partial");
  assert.match(spec.tokenShellNote, /form_post/);
  assert.match(spec.tokenShellNote, /APPLE_APP_BUNDLE_ID/);
  assert.equal(spec.needsEmail, false);
  const plan = planAuthAccountSecurity({
    options: ["apple-oauth"],
    hasNativeClient: true,
    hasEmailTransport: true,
  });
  assert.match(plan.warnings.join(" "), /Sign in with Apple button \(partial\)/);
  assert.deepEqual(
    plan.envVars.map((v) => v.key),
    APPLE_ENV_VARS.map((v) => v.key),
  );
  assert.ok(plan.files.includes("packages/server/src/tests/apple-sign-in.test.ts"));
});

await expect("the generated docs say where the values go and name guideline 4.8", () => {
  const input = {
    options: ["apple-oauth"] as AuthSecurityOption[],
    hasNativeClient: true,
    hasEmailTransport: true,
  };
  const docs = renderAuthSecurityDocs({
    ...input,
    projectName: "Test App",
    plan: planAuthAccountSecurity(input),
  });
  for (const { key } of APPLE_ENV_VARS)
    assert.ok(docs.includes(`\`${key}\``), `${key} not in docs`);
  assert.match(docs, /\.env\.production/);
  assert.match(docs, /guideline 4\.8/);
  assert.match(
    docs,
    /`https:\/\/<domain>\/api\/auth\/callback\/apple`/,
    "the URL must be in a code span",
  );
  assert.match(docs, /appleSignInPlugin → bearer/);
});

await expect("the public docs page exists, is in the nav, and names the human-only steps", () => {
  const page = readFileSync(join(REPO, "docs/content/docs/sign-in-with-apple.mdx"), "utf-8");
  const meta = JSON.parse(readFileSync(join(REPO, "docs/content/docs/meta.json"), "utf-8"));
  assert.ok(meta.pages.includes("sign-in-with-apple"));
  for (const phrase of [
    "Services ID",
    "Return URLs",
    ".p8",
    "Team ID",
    "/api/auth/callback/apple",
    "no API",
    "4.8",
  ]) {
    assert.ok(page.includes(phrase), `docs page does not mention ${phrase}`);
  }
  for (const { key } of APPLE_ENV_VARS)
    assert.ok(page.includes(key), `${key} not on the docs page`);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nAll Sign in with Apple tests passed.\n");
