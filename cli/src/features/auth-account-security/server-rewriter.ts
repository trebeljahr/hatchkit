/*
 * cli/src/features/auth-account-security/server-rewriter.ts — patch the
 * starter's existing server files.
 *
 * Every function here is a pure string transform and every one is
 * IDEMPOTENT: it detects its own previous output and returns the source
 * unchanged. That is what lets `hatchkit update` run repeatedly, and what
 * lets a project that took the feature at `create` take a new sub-option
 * later without the first pass being applied twice.
 *
 * A transform that cannot find its anchor returns the source unchanged
 * and says so through `applied: false`, so the caller can report a
 * manual step instead of writing a file it has silently mangled. Never
 * throw here: a half-patched server is worse than an unpatched one with
 * an instruction attached.
 *
 * Output still carries `__HATCHKIT_<TOKEN>__` placeholders. `index.ts`
 * runs every rewritten file through the same renderer the templates go
 * through, so a token means the same thing whether it was written into a
 * template or spliced in here.
 */

import { hasSharedBarrelExport, sharedBarrelExport } from "../shared-barrel.js";
import { ORDERED_SERVER_PLUGINS } from "./plugin-order.js";
import { renderPluginList } from "./render.js";

export interface RewriteResult {
  source: string;
  applied: boolean;
  /** Set when the transform declined. Surfaced as manual residue. */
  reason?: string;
  /** Steps that declined while the rest of the file was patched. Surfaced
   *  as manual residue too — see `chain` in index.ts. */
  partial?: string[];
}

const unchanged = (source: string, reason: string): RewriteResult => ({
  source,
  applied: false,
  reason,
});

const alreadyDone = (source: string): RewriteResult => ({ source, applied: true });

/** Insert `lines` immediately after the last existing import statement. */
function addImports(source: string, lines: readonly string[]): string {
  const wanted = lines.filter((line) => !source.includes(line));
  if (wanted.length === 0) return source;
  const importRe = /^import[\s\S]*?from\s+"[^"]+";$/gm;
  let lastEnd = -1;
  for (const match of source.matchAll(importRe)) {
    lastEnd = (match.index ?? 0) + match[0].length;
  }
  if (lastEnd === -1) return `${wanted.join("\n")}\n${source}`;
  return `${source.slice(0, lastEnd)}\n${wanted.join("\n")}${source.slice(lastEnd)}`;
}

export interface ServerAuthRewriteOptions {
  /** Server plugin call expressions, already in mandatory order. */
  serverPlugins: readonly string[];
  wantsTwoFactor: boolean;
  wantsEmailVerification: boolean;
  wantsAccountDeletion: boolean;
  wantsEmailOtp: boolean;
  wantsMagicLink: boolean;
  wantsPasskeys: boolean;
}

/**
 * Patch `packages/server/src/auth/auth.ts`.
 *
 * The starter registers no plugins at all, so there is no `plugins:` key
 * to extend — it is inserted whole, in contract order, which is also why
 * the order test reads this generated file rather than trusting the
 * generator.
 */
export function rewriteServerAuth(
  source: string,
  options: ServerAuthRewriteOptions,
): RewriteResult {
  if (source.includes("account-security.js")) return alreadyDone(source);
  if (!source.includes("betterAuth({")) {
    return unchanged(source, "auth.ts does not call betterAuth({ ... }) where expected");
  }

  const imports: string[] = [];
  const securityImports = ["emailVerificationOptions", "logAuthUrl", "passwordResetEmailBody"];
  if (options.wantsTwoFactor) securityImports.push("twoFactorPlugin");
  if (options.wantsEmailOtp) securityImports.push("emailOtpPlugin");
  if (options.wantsMagicLink) securityImports.push("magicLinkPlugin");
  securityImports.sort();
  imports.push(
    `import { ${securityImports.join(", ")} } from "./account-security.js";`,
    `import { isEmailDeliveryConfigured } from "../services/email-delivery.js";`,
  );
  if (options.wantsPasskeys) {
    imports.push(`import { passkeyPlugin, rpIdFromUrl } from "./account-security-passkey.js";`);
  }
  if (options.wantsAccountDeletion) {
    imports.push(
      `import { accountDeletionOptions, recordDeletionPassword } from "./account-deletion.js";`,
    );
  }
  if (options.serverPlugins.includes("bearer")) {
    imports.push(`import { bearer } from "better-auth/plugins/bearer";`);
  }

  let out = addImports(source, imports);

  // The shared sender every mail-bearing option uses. Declared once,
  // above initAuth, so each call site is a single line.
  const senderBlock = `
/**
 * Deliver an auth URL, or make it recoverable when delivery is not possible.
 *
 * Branch on whether ANY transport is configured, never on one provider's
 * variables: a check shaped like one provider would log the URL and return on
 * a self-host that has another configured perfectly well, leaving the user
 * waiting for mail nobody ever tried to send.
 *
 * Recovery logging follows logAuthUrl's policy: development/test, or explicit
 * AUTH_LOG_LINKS=true owner recovery. Production otherwise refuses the fallback.
 * A configured transport failure still rejects the request.
 */
async function deliverAuthMail(
  label: string,
  url: string,
  mail: { to: string; subject: string; text: string; html: string },
): Promise<void> {
  if (!isEmailDeliveryConfigured()) {
    logAuthUrl(label, mail.to, url);
    return;
  }
  try {
    await sendEmail(mail);
  } catch (error) {
    logAuthUrl(label, mail.to, url);
    throw error;
  }
}
`;
  if (!out.includes("async function deliverAuthMail")) {
    const anchor = out.indexOf("export async function initAuth");
    if (anchor === -1) {
      return unchanged(out, "auth.ts has no initAuth() to anchor the mail helper above");
    }
    out = `${out.slice(0, anchor)}${senderBlock.trimStart()}\n${out.slice(anchor)}`;
  }

  // Normalize a legacy literal before installing verificationPolicy below.
  // The final policy requires verification by default in production.
  if (options.wantsEmailVerification) {
    out = out.replace(
      /requireEmailVerification:\s*false,[^\n]*/,
      "requireEmailVerification: isEmailDeliveryConfigured(),",
    );
  }

  // Replace the starter's inline sendVerificationEmail under
  // emailAndPassword. better-auth reads that callback from the
  // `emailVerification` block ONLY; left where the starter put it, it is
  // never called and nothing logs that it was skipped.
  out = out.replace(/\n\s*async sendVerificationEmail\(\{[\s\S]*?\n {6}\},\n/, "\n");
  out = out.replace(
    /\n\s*async sendResetPassword\(\{[\s\S]*?\n {6}\},\n/,
    `
      async sendResetPassword({ user, url }: { user: { email: string }; url: string }) {
        await deliverAuthMail("Password reset", url, {
          to: user.email,
          ...passwordResetEmailBody(url),
        });
      },
`,
  );

  const verificationPolicy =
    /requireEmailVerification:\s*([^,\n]+),/.exec(out)?.[1] ?? "isEmailDeliveryConfigured()";
  const blocks: string[] = [];

  if (options.wantsEmailVerification) {
    blocks.push(`    emailVerification: emailVerificationOptions((url, mail) =>
      deliverAuthMail("Verification", url, mail),
      ${verificationPolicy},
    ),`);
  }

  if (options.wantsAccountDeletion) {
    blocks.push(`    user: {
      changeEmail: { enabled: true },
      deleteUser: accountDeletionOptions({
        context: () => getAuth().$context,
      }),
    },

    // One before-hook for the whole instance: it records whether
    // /delete-user carried a password, which beforeDelete cannot see for
    // itself. See auth/account-deletion.ts.
    hooks: {
      before: recordDeletionPassword,
    },`);
  } else {
    blocks.push(`    user: {
      changeEmail: { enabled: true },
    },`);
  }

  // Only the plugins this function also writes the imports and helpers for.
  // The sign-in methods added later (Apple, Steam, guests, …) are placed by
  // `rewriteServerAuthAddition` together with their own imports: written
  // here, a later decline of that step would leave a call to a name nothing
  // imports.
  const rendered = options.serverPlugins.filter((name) => BASE_RENDERED_PLUGINS.has(name));
  if (rendered.length > 0) {
    const calls = rendered.map((name) => {
      if (name === "twoFactorPlugin") return "twoFactorPlugin()";
      if (name === "emailOtpPlugin") {
        return `emailOtpPlugin((otp, mail) => deliverAuthMail("Sign-in code", otp, mail))`;
      }
      if (name === "magicLinkPlugin") {
        return `magicLinkPlugin((url, mail) => deliverAuthMail("Sign-in link", url, mail))`;
      }
      if (name === "passkeyPlugin") {
        return `passkeyPlugin({
        rpID: rpIdFromUrl(env.BETTER_AUTH_URL),
        rpName: "__HATCHKIT_PROJECT_NAME__",
        origin: getTrustedOrigins(),
      })`;
      }
      return `${name}()`;
    });
    blocks.push(`    // ORDER IS A CORRECTNESS CONSTRAINT, NOT STYLE.
    //
    // better-auth runs plugin after-hooks in registration order, and
    // bearer() emits set-auth-token for whatever session cookie the
    // response carries. Every plugin above it can REPLACE the session the
    // sign-in endpoint just made — two-factor deletes it outright and
    // answers { twoFactorRedirect: true }. Put bearer() first and a token
    // client stores a credential for a session that is deleted a moment
    // later: every request answers 401, the client believes it is signed
    // in, and nothing logs a reason.
    //
    // The test suite reads this array back out of this file.
    plugins: [
${renderPluginList(calls, 6)}
    ],`);
  }

  // Insert before the closing `});` of the betterAuth({ ... }) call.
  const marker = "\n  });";
  const at = out.lastIndexOf(marker);
  if (at === -1) {
    return unchanged(out, "could not find the end of the betterAuth({ ... }) call");
  }
  return {
    source: `${out.slice(0, at)}\n\n${blocks.join("\n\n")}${out.slice(at)}`,
    applied: true,
  };
}

// ── Sign-in methods added after the base patch ──────────────────────────
//
// Each method is an `AuthAddition`: imports, an optional line above
// `betterAuth({`, optional `socialProviders` entries and an optional plugin.
// Every piece detects its own output, so a method can be added on a later run
// to a file `rewriteServerAuth` patched long ago — that one returns early on
// any file it has seen. Nothing here touches `trustedOrigins:`: other
// features replace that line wholesale.

/** Plugins `rewriteServerAuth` renders itself, with their imports. */
const BASE_RENDERED_PLUGINS: ReadonlySet<string> = new Set([
  "twoFactorPlugin",
  "emailOtpPlugin",
  "magicLinkPlugin",
  "passkeyPlugin",
  "bearer",
]);

export interface AuthAddition {
  /** Names the step in a manual-residue line when it declines. */
  label: string;
  imports?: readonly string[];
  /** Inserted above `_auth = betterAuth({` unless `marker` is present. */
  preamble?: { marker: string; text: string };
  /** First entries of `socialProviders`, each skipped when its marker is. */
  providers?: ReadonlyArray<{ marker: string; line: string }>;
  /** One plugin registration, placed by its rank in ORDERED_SERVER_PLUGINS. */
  plugin?: { name: string; call: string };
}

/** Bounds of the first `plugins: [ ... ]` array, or null. Bracket-matched,
 *  so a nested call with its own array cannot end it early. */
function pluginArrayBounds(source: string): { open: number; close: number } | null {
  const start = source.search(/\bplugins\s*:\s*\[/);
  if (start === -1) return null;
  const open = source.indexOf("[", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) return { open, close: i };
    }
  }
  return null;
}

/** Plugin names this module ranks, outranking `name`, as one regex. */
function outrankingPattern(name: string): RegExp | null {
  const rank = ORDERED_SERVER_PLUGINS.indexOf(name);
  const later = ORDERED_SERVER_PLUGINS.slice(rank + 1);
  return later.length === 0 ? null : new RegExp(`\\b(?:${later.join("|")})\\(`);
}

/**
 * Put one plugin call into an existing plugin array, at its rank: on its own
 * line directly above the first line that registers a plugin ranked after it
 * — which also catches a conditional `...(x ? [bearer()] : [])` — or as the
 * last element. A one-line array gets the same rule inline.
 */
function insertPluginByRank(
  source: string,
  bounds: { open: number; close: number },
  plugin: { name: string; call: string },
): string {
  const body = source.slice(bounds.open + 1, bounds.close);
  const before = source.slice(0, bounds.open + 1);
  const after = source.slice(bounds.close);
  const later = outrankingPattern(plugin.name);

  if (!body.includes("\n")) {
    const hit = later ? later.exec(body) : null;
    if (hit) {
      // Start of the element holding the later plugin: just past the
      // previous separator, so a spread `...(x ? [bearer()] : [])` moves whole.
      const elementStart = Math.max(body.lastIndexOf(",", hit.index) + 1, 0);
      const lead = body.slice(0, elementStart).replace(/\s*$/, "");
      const sep = lead === "" ? "" : `${lead} `;
      return `${before}${sep}${plugin.call}, ${body.slice(elementStart).trimStart()}${after}`;
    }
    const trimmed = body.trim().replace(/,$/, "");
    return `${before}${trimmed ? `${trimmed}, ` : ""}${plugin.call}${after}`;
  }

  const lines = body.split("\n");
  const at = later ? lines.findIndex((line) => later.test(line)) : -1;
  if (at !== -1) {
    const indent = /^[ \t]*/.exec(lines[at] ?? "")?.[0] ?? "      ";
    lines.splice(at, 0, `${indent}${plugin.call},`);
    return `${before}${lines.join("\n")}${after}`;
  }

  // Last element. The one before it may lack a trailing comma.
  const lastNewline = body.lastIndexOf("\n");
  const head = body.slice(0, lastNewline).replace(/\s*$/, "");
  const closingIndent = body.slice(lastNewline + 1);
  const element = /\n([ \t]*)\S/.exec(body)?.[1] ?? `${closingIndent}  `;
  const comma = head.endsWith(",") || head === "" ? "" : ",";
  return `${before}${head}${comma}\n${element}${plugin.call},\n${closingIndent}${after}`;
}

/**
 * Apply one {@link AuthAddition} to `auth.ts`. All or nothing: a missing
 * anchor declines the whole addition, so the file never imports a module it
 * does not call or calls a name it does not import.
 */
export function rewriteServerAuthAddition(source: string, addition: AuthAddition): RewriteResult {
  let out = addImports(source, addition.imports ?? []);

  if (addition.preamble && !out.includes(addition.preamble.marker)) {
    const at = out.search(/\n {2}_auth = betterAuth\(\{/);
    if (at === -1) {
      return unchanged(source, "auth.ts has no `_auth = betterAuth({` to anchor the config above");
    }
    out = `${out.slice(0, at + 1)}${addition.preamble.text}\n${out.slice(at + 1)}`;
  }

  for (const provider of addition.providers ?? []) {
    if (out.includes(provider.marker)) continue;
    const match = /\n {4}socialProviders: \{\n/.exec(out);
    if (!match) return unchanged(source, "auth.ts has no `socialProviders: {` block");
    const at = match.index + match[0].length;
    out = `${out.slice(0, at)}${provider.line}${out.slice(at)}`;
  }

  const plugin = addition.plugin;
  if (plugin && !new RegExp(`\\b${plugin.name}\\(`).test(out)) {
    const bounds = pluginArrayBounds(out);
    if (bounds) {
      out = insertPluginByRank(out, bounds, plugin);
    } else {
      const marker = "\n  });";
      const at = out.lastIndexOf(marker);
      if (at === -1) {
        return unchanged(source, "could not find the end of the betterAuth({ ... }) call");
      }
      out = `${out.slice(0, at)}\n\n    // Contract order: see plugin-order.ts. bearer(), if it is ever added,\n    // goes after every one of these.\n    plugins: [${plugin.call}],${out.slice(at)}`;
    }
  }

  return { source: out, applied: true };
}

/** The plugin registration, as it is written into the `plugins` array. */
export const APPLE_PLUGIN_CALL = "appleSignInPlugin(appleConfig)";

export const APPLE_ADDITION: AuthAddition = {
  label: "Sign in with Apple",
  imports: [
    `import { appleProviderOptions, appleSignInConfig, appleSignInPlugin } from "./apple-sign-in.js";`,
  ],
  preamble: {
    marker: "const appleConfig = appleSignInConfig()",
    text: `  // Sign in with Apple: off unless every APPLE_* variable is set. Read once,
  // here, so the provider and the plugin below agree. See auth/apple-sign-in.ts.
  const appleConfig = appleSignInConfig();
`,
  },
  providers: [
    {
      marker: "apple: appleProviderOptions(",
      line: "      ...(appleConfig ? { apple: appleProviderOptions(appleConfig) } : {}),\n",
    },
  ],
  plugin: { name: "appleSignInPlugin", call: APPLE_PLUGIN_CALL },
};

/** GitHub and Discord, whichever `sign-in-methods.ts` lists. */
export const SOCIAL_PROVIDERS_ADDITION: AuthAddition = {
  label: "GitHub and Discord sign-in",
  imports: [
    `import { extraSocialProviders } from "./social-providers.js";`,
    `import { EXTRA_SOCIAL_PROVIDERS } from "./sign-in-methods.js";`,
  ],
  providers: [
    {
      marker: "extraSocialProviders(",
      line: "      ...extraSocialProviders(EXTRA_SOCIAL_PROVIDERS),\n",
    },
  ],
};

export const GENERIC_OAUTH_ADDITION: AuthAddition = {
  label: "Generic OAuth sign-in",
  imports: [`import { genericOAuthPlugin } from "./generic-oauth.js";`],
  plugin: { name: "genericOAuthPlugin", call: "genericOAuthPlugin()" },
};

export const STEAM_ADDITION: AuthAddition = {
  label: "Steam sign-in",
  imports: [`import { steamSignInPlugin } from "./steam-sign-in.js";`],
  plugin: { name: "steamSignInPlugin", call: "steamSignInPlugin()" },
};

export const GUEST_ACCOUNTS_ADDITION: AuthAddition = {
  label: "Guest accounts",
  imports: [`import { guestAccountsPlugin } from "./guest-accounts.js";`],
  plugin: { name: "guestAccountsPlugin", call: "guestAccountsPlugin()" },
};

export const USERNAME_ADDITION: AuthAddition = {
  label: "Username sign-in",
  imports: [`import { usernamePlugin } from "./username-sign-in.js";`],
  plugin: { name: "usernamePlugin", call: "usernamePlugin()" },
};

/** Kept for callers and tests that name Apple directly. */
export function rewriteServerAuthApple(source: string): RewriteResult {
  return rewriteServerAuthAddition(source, APPLE_ADDITION);
}

/**
 * better-auth's account-linking settings, as the starter ships them. The same
 * text is in `starter/packages/server/src/auth/auth.ts` and the Postgres
 * overlay; the test suite checks they agree.
 */
export const ACCOUNT_LINKING_BLOCK = `    // Account linking: one person, several ways to sign in.
    //
    // - Linking while signed in (\`linkSocial\`; Settings → Sign-in methods
    //   when the auth-account-security feature is on) always works, even when
    //   the provider's address differs from the account's
    //   (allowDifferentEmails): the person is signed in and asked for it.
    // - Implicit linking — "Continue with Google" for an address that already
    //   has an account — happens only when BOTH sides verified that address
    //   (requireLocalEmailVerified). Without it, anybody could register a
    //   victim's address with a password and inherit their Google sign-in.
    // - trustedProviders: Google and Apple verify every address they return.
    //   Never add a provider that can report an unverified address.
    // - The last way to sign in cannot be unlinked: better-auth refuses it
    //   while allowUnlinkingAll is false.
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google", "apple"],
        allowDifferentEmails: true,
        requireLocalEmailVerified: true,
        allowUnlinkingAll: false,
      },
    },`;

/** Index just past the `}` that closes the brace opened at `open`. */
function closingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Give an existing project the starter's account-linking settings, after its
 * `socialProviders` block. A project that already configures `account:` is
 * left alone: merging into somebody's own linking policy is a decision.
 */
export function rewriteServerAuthAccountLinking(source: string): RewriteResult {
  if (source.includes("accountLinking")) return alreadyDone(source);
  if (/\n {4}account: \{/.test(source)) {
    return unchanged(source, "auth.ts already has an `account:` block; add `accountLinking` to it");
  }
  const providers = source.indexOf("\n    socialProviders: {");
  if (providers !== -1) {
    const end = closingBrace(source, source.indexOf("{", providers));
    const lineEnd = source.indexOf("\n", end);
    if (end !== -1 && lineEnd !== -1) {
      return {
        source: `${source.slice(0, lineEnd)}\n\n${ACCOUNT_LINKING_BLOCK}${source.slice(lineEnd)}`,
        applied: true,
      };
    }
  }
  const marker = "\n  });";
  const at = source.lastIndexOf(marker);
  if (at === -1) return unchanged(source, "could not find the end of the betterAuth({ ... }) call");
  return {
    source: `${source.slice(0, at)}\n\n${ACCOUNT_LINKING_BLOCK}${source.slice(at)}`,
    applied: true,
  };
}

export interface HealthExtra {
  key: string;
  expr: string;
  importLine: string;
  comment: string;
}

/**
 * Publish more public facts beside the booleans the login page reads before
 * anyone is signed in. Wraps rather than edits `resolveAuthConfig(...)`:
 * `account-security.ts` is a file the project owns, and an earlier copy of it
 * knows nothing of these fields.
 */
export function rewriteHealthRouterExtras(
  source: string,
  extras: readonly HealthExtra[],
): RewriteResult {
  const wanted = extras.filter((extra) => !source.includes(`${extra.key}:`));
  if (wanted.length === 0) return alreadyDone(source);

  let out = source;
  const call = /\n( +)authConfig: resolveAuthConfig\((\{[\s\S]*?\n\1\})\),/.exec(out);
  if (call) {
    const indent = call[1] ?? "      ";
    const args = (call[2] ?? "").replace(/\n/g, "\n  ");
    out = out.replace(
      call[0],
      `\n${indent}authConfig: {\n${indent}  ...resolveAuthConfig(${args}),\n${indent}},`,
    );
  }
  const open = /\n( +)authConfig: \{\n/.exec(out);
  if (!open) {
    return unchanged(
      source,
      "health router has no `authConfig: resolveAuthConfig({ ... })` to extend",
    );
  }
  const indent = open[1] ?? "      ";
  const end = closingBrace(out, out.indexOf("{", open.index));
  if (end === -1) return unchanged(source, "health router's authConfig block is not closed");
  const closeAt = out.lastIndexOf("\n", end);
  const lines = wanted
    .map((extra) => `${indent}  // ${extra.comment}\n${indent}  ${extra.key}: ${extra.expr},`)
    .join("\n");
  out = `${out.slice(0, closeAt)}\n${lines}${out.slice(closeAt)}`;
  return {
    source: addImports(
      out,
      wanted.map((extra) => extra.importLine),
    ),
    applied: true,
  };
}

export const APPLE_HEALTH_EXTRA: HealthExtra = {
  key: "appleEnabled",
  expr: "isAppleSignInConfigured()",
  importLine: `import { isAppleSignInConfigured } from "../../auth/apple-sign-in.js";`,
  comment: "Whether the Apple button can work. A boolean, like the rest.",
};

export const SIGN_IN_METHODS_HEALTH_EXTRA: HealthExtra = {
  key: "signInMethods",
  expr: "publicSignInMethods()",
  importLine: `import { publicSignInMethods } from "../../auth/sign-in-methods.js";`,
  comment: "Which extra sign-in buttons can work: ids and a label, no secrets.",
};

/** Kept for callers and tests that name Apple directly. */
export function rewriteHealthRouterApple(source: string): RewriteResult {
  return rewriteHealthRouterExtras(source, [APPLE_HEALTH_EXTRA]);
}

/** Mount the avatar route in `app.ts`, after helmet — whose
 *  Cross-Origin-Resource-Policy it overrides for that one route. */
export function rewriteServerApp(source: string): RewriteResult {
  if (source.includes("registerAvatarRoutes")) return alreadyDone(source);
  if (!source.includes("app.use(helmet())")) {
    return unchanged(source, "app.ts does not call app.use(helmet()) where expected");
  }
  const withImport = addImports(source, [
    `import { registerAvatarRoutes } from "./services/avatar/index.js";`,
  ]);
  return {
    source: withImport.replace(
      /(app\.use\(helmet\(\)\);\n)/,
      `$1
  // Profile pictures — public bytes at an unguessable address, so an <img>
  // in any client can load them without a credential. Registered AFTER
  // helmet, whose Cross-Origin-Resource-Policy: same-origin this route
  // overrides: without that override no other origin can load the image at
  // all, which is every client but this API itself.
  registerAvatarRoutes(app);
`,
    ),
    applied: true,
  };
}

/** Publish the two booleans the login page needs before anyone is signed
 *  in. Two booleans and no configuration values — this is public. */
export function rewriteHealthRouter(source: string): RewriteResult {
  if (source.includes("authConfig")) return alreadyDone(source);
  if (!source.includes("timestamp: new Date().toISOString()")) {
    return unchanged(source, "health router does not have the expected shape");
  }
  const withImports = addImports(source, [
    `import { resolveAuthConfig } from "../../auth/account-security.js";`,
    `import { isEmailDeliveryConfigured } from "../../services/email-delivery.js";`,
    `import { env } from "../../config/env.js";`,
  ]);
  return {
    source: withImports.replace(
      /(timestamp: new Date\(\)\.toISOString\(\),)/,
      `$1
      // Public on purpose: /login and /signup read this before anyone is
      // signed in, to decide whether the Google button can work and whether
      // a new account will have to confirm its address. Two booleans, no
      // configuration values — do not widen it.
      authConfig: resolveAuthConfig({
        googleClientId: env.GOOGLE_CLIENT_ID,
        googleClientSecret: env.GOOGLE_CLIENT_SECRET,
        emailDeliveryConfigured: isEmailDeliveryConfigured(),
      }),`,
    ),
    applied: true,
  };
}

/** Add the avatar mutations to the profile router. */
export function rewriteProfileRouter(source: string): RewriteResult {
  if (source.includes("setAvatar")) return alreadyDone(source);
  const closing = source.lastIndexOf("});");
  if (closing === -1) {
    return unchanged(source, "profile router does not end with the expected `});`");
  }
  const withImports = addImports(source, [
    `import { TRPCError } from "@trpc/server";`,
    `import { setAvatarSchema } from "__HATCHKIT_SHARED_SCOPE__/shared";`,
    `import { removeAvatar, storeAvatar } from "../../services/avatar/index.js";`,
  ]);
  const at = withImports.lastIndexOf("});");
  const block = `
  /** The bytes arrive base64 in the request body; the server decides the
   *  content type from them, never from the client. A declared type is a
   *  claim, and these bytes are served back to a browser. */
  setAvatar: protectedProcedure
    .input(setAvatarSchema)
    .mutation(async ({ ctx, input }) => {
      const outcome = await storeAvatar(ctx.user.id, input.data);
      if (!outcome.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: outcome.refusal });
      }
      return { image: outcome.image };
    }),

  removeAvatar: protectedProcedure.mutation(async ({ ctx }) => {
    await removeAvatar(ctx.user.id);
    return { image: null };
  }),
`;
  return { source: `${withImports.slice(0, at)}${block}${withImports.slice(at)}`, applied: true };
}

/** Re-export the new shared modules from the shared package barrel. */
export function rewriteSharedIndex(source: string, modules: readonly string[]): RewriteResult {
  const lines = modules
    .filter((name) => !hasSharedBarrelExport(source, name))
    .map(sharedBarrelExport);
  if (lines.length === 0) return alreadyDone(source);
  return { source: `${source.trimEnd()}\n${lines.join("\n")}\n`, applied: true };
}
