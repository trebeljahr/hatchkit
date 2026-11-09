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

  // Apple's plugin is left to `rewriteServerAuthApple`, which writes it
  // together with the `appleConfig` it reads and the import it needs. Written
  // here, a later decline of that step would leave a reference to a name
  // nothing declares.
  const rendered = options.serverPlugins.filter((name) => name !== "appleSignInPlugin");
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

// ── Sign in with Apple ─────────────────────────────────────────────────
//
// Its own transforms, each detecting its own output, rather than branches
// inside `rewriteServerAuth`: that one returns early on any file it has
// already patched, so Apple could otherwise never be added on a later run.
// Nothing here touches `trustedOrigins:` — other features replace that line
// wholesale — so Apple's origin arrives through `appleSignInPlugin()`.

/** The plugin registration, as it is written into the `plugins` array. */
export const APPLE_PLUGIN_CALL = "appleSignInPlugin(appleConfig)";

const APPLE_IMPORT = `import { appleProviderOptions, appleSignInConfig, appleSignInPlugin } from "./apple-sign-in.js";`;

const APPLE_CONFIG_LINE = `  // Sign in with Apple: off unless every APPLE_* variable is set. Read once,
  // here, so the provider and the plugin below agree. See auth/apple-sign-in.ts.
  const appleConfig = appleSignInConfig();
`;

const APPLE_PROVIDER_LINE =
  "      ...(appleConfig ? { apple: appleProviderOptions(appleConfig) } : {}),\n";

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

/**
 * Put `appleSignInPlugin(appleConfig)` into an existing plugin array: on its
 * own line directly above the first line that mentions `bearer(` — which
 * also catches a conditional `...(x ? [bearer()] : [])` — or as the last
 * element when there is no bearer. A one-line array gets the same rule
 * inline.
 */
function insertIntoPluginArray(source: string, bounds: { open: number; close: number }): string {
  const body = source.slice(bounds.open + 1, bounds.close);
  const before = source.slice(0, bounds.open + 1);
  const after = source.slice(bounds.close);

  if (!body.includes("\n")) {
    const bearerAt = body.search(/(?:\.\.\.\()?[^,]*\bbearer\(/);
    if (bearerAt !== -1) {
      const lead = body.slice(0, bearerAt).replace(/\s*$/, "");
      const sep = lead === "" ? "" : `${lead} `;
      return `${before}${sep}${APPLE_PLUGIN_CALL}, ${body.slice(bearerAt).trimStart()}${after}`;
    }
    const trimmed = body.trim().replace(/,$/, "");
    return `${before}${trimmed ? `${trimmed}, ` : ""}${APPLE_PLUGIN_CALL}${after}`;
  }

  const bearerLine = /\n([ \t]*)[^\n]*\bbearer\(/.exec(body);
  if (bearerLine) {
    const at = bearerLine.index + 1;
    return `${before}${body.slice(0, at)}${bearerLine[1]}${APPLE_PLUGIN_CALL},\n${body.slice(at)}${after}`;
  }

  // Last element. The one before it may lack a trailing comma.
  const lastNewline = body.lastIndexOf("\n");
  const head = body.slice(0, lastNewline).replace(/\s*$/, "");
  const closingIndent = body.slice(lastNewline + 1);
  const element = /\n([ \t]*)\S/.exec(body)?.[1] ?? `${closingIndent}  `;
  const comma = head.endsWith(",") || head.endsWith("[") || head === "" ? "" : ",";
  return `${before}${head}${comma}\n${element}${APPLE_PLUGIN_CALL},\n${closingIndent}${after}`;
}

/**
 * Add Sign in with Apple to an `auth.ts` that `rewriteServerAuth` has
 * already patched (or that never needed patching). Four independent steps,
 * each skipped when its output is already there:
 *
 *  1. the import;
 *  2. `const appleConfig = appleSignInConfig();` above `betterAuth({`;
 *  3. the provider, first in `socialProviders`;
 *  4. `appleSignInPlugin(appleConfig)` in the plugin array — BEFORE
 *     `bearer()`, which must stay last (see plugin-order.ts).
 */
export function rewriteServerAuthApple(source: string): RewriteResult {
  let out = addImports(source, [APPLE_IMPORT]);

  if (!out.includes("const appleConfig = appleSignInConfig()")) {
    const at = out.search(/\n {2}_auth = betterAuth\(\{/);
    if (at === -1)
      return unchanged(
        source,
        "auth.ts has no `_auth = betterAuth({` to anchor Apple's config above",
      );
    out = `${out.slice(0, at + 1)}${APPLE_CONFIG_LINE}\n${out.slice(at + 1)}`;
  }

  if (!out.includes("apple: appleProviderOptions(")) {
    const match = /\n {4}socialProviders: \{\n/.exec(out);
    if (!match)
      return unchanged(source, "auth.ts has no `socialProviders: {` block for the Apple provider");
    const at = match.index + match[0].length;
    out = `${out.slice(0, at)}${APPLE_PROVIDER_LINE}${out.slice(at)}`;
  }

  if (!out.includes("appleSignInPlugin(")) {
    const bounds = pluginArrayBounds(out);
    if (bounds) {
      out = insertIntoPluginArray(out, bounds);
    } else {
      const marker = "\n  });";
      const at = out.lastIndexOf(marker);
      if (at === -1)
        return unchanged(source, "could not find the end of the betterAuth({ ... }) call");
      out = `${out.slice(0, at)}\n\n    // Adds Apple's origin for its form_post callback. Must stay ahead of\n    // bearer() if one is ever added (see auth/apple-sign-in.ts).\n    plugins: [${APPLE_PLUGIN_CALL}],${out.slice(at)}`;
    }
  }

  return { source: out, applied: true };
}

/**
 * Publish whether Apple is configured, beside the existing booleans the
 * login page reads before anyone is signed in. Wraps rather than edits
 * `resolveAuthConfig(...)`: `account-security.ts` is a file the project
 * owns, and an earlier copy of it has no Apple field to pass.
 */
export function rewriteHealthRouterApple(source: string): RewriteResult {
  if (source.includes("appleEnabled")) return alreadyDone(source);
  const match = /\n( +)authConfig: resolveAuthConfig\((\{[\s\S]*?\n\1\})\),/.exec(source);
  if (!match) {
    return unchanged(
      source,
      "health router has no `authConfig: resolveAuthConfig({ ... })` to extend",
    );
  }
  const indent = match[1] ?? "      ";
  const args = (match[2] ?? "").replace(/\n/g, "\n  ");
  const replacement = `\n${indent}authConfig: {\n${indent}  ...resolveAuthConfig(${args}),\n${indent}  // Whether the Apple button can work. A boolean, like the rest.\n${indent}  appleEnabled: isAppleSignInConfigured(),\n${indent}},`;
  const withImport = addImports(source, [
    `import { isAppleSignInConfigured } from "../../auth/apple-sign-in.js";`,
  ]);
  return {
    source: withImport.replace(match[0], replacement),
    applied: true,
  };
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
    .map((name) => `export * from "./${name}.js";`)
    .filter((line) => !source.includes(line));
  if (lines.length === 0) return alreadyDone(source);
  return { source: `${source.trimEnd()}\n${lines.join("\n")}\n`, applied: true };
}
