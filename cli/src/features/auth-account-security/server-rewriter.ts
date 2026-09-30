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
 * A configured transport that throws still logs the URL on the way out, and
 * still rethrows — a silent delivery failure is the worse outcome.
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

  // requireEmailVerification becomes dynamic. Only when mail can actually
  // be delivered — a self-host with no transport would otherwise lock
  // every new account out behind a link that reaches only the server log.
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

  const verificationPolicy = /requireEmailVerification:\s*([^,\n]+),/.exec(out)?.[1] ?? "isEmailDeliveryConfigured()";
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

  if (options.serverPlugins.length > 0) {
    const calls = options.serverPlugins.map((name) => {
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
