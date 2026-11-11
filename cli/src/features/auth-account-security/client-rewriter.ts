/*
 * cli/src/features/auth-account-security/client-rewriter.ts — patch the
 * starter's existing client files.
 *
 * Same contract as the server rewriter: pure, idempotent, and never
 * throwing. A transform whose anchor has moved returns the source
 * unchanged with a reason, and the caller turns that into a manual step.
 *
 * The login page is the one file here that a project is likely to have
 * rewritten by hand, so every insertion is guarded on a marker rather
 * than on line position.
 */

import type { RewriteResult } from "./server-rewriter.js";

const unchanged = (source: string, reason: string): RewriteResult => ({
  source,
  applied: false,
  reason,
});
const alreadyDone = (source: string): RewriteResult => ({ source, applied: true });

export interface ClientAuthRewriteOptions {
  /** Client plugin call expressions, in the same order as the server. */
  clientPlugins: readonly string[];
  wantsAccountDeletion: boolean;
  wantsPasskeys: boolean;
}

/**
 * Patch `packages/client/src/lib/auth-client.ts`.
 *
 * Adds the plugin registrations and the three helpers the account
 * surfaces need: `refreshSession`, `accountHasPassword` and
 * `deleteAccount`.
 */
export function rewriteAuthClient(
  source: string,
  options: ClientAuthRewriteOptions,
): RewriteResult {
  if (source.includes("export const refreshSession")) return alreadyDone(source);
  if (!source.includes("createAuthClient({")) {
    return unchanged(source, "auth-client.ts does not call createAuthClient({ ... })");
  }

  let out = source;

  if (options.clientPlugins.length > 0) {
    const names = [...options.clientPlugins];
    if (options.wantsPasskeys) {
      // Ships in its own package, like the server half.
      out = out.replace(
        /(import \{ createAuthClient \} from "better-auth\/react";\n)/,
        `$1import { passkeyClient } from "@better-auth/passkey/client";\n`,
      );
    }
    const core = names.filter((name) => name !== "passkeyClient");
    if (core.length > 0) {
      out = out.replace(
        /(import \{ createAuthClient \} from "better-auth\/react";\n)/,
        `$1import { ${core.join(", ")} } from "better-auth/client/plugins";\n`,
      );
    }
    out = out.replace(
      /createAuthClient\(\{\n(\s*)baseURL: ([^\n]+)\n\}\);/,
      (_match, indent: string, base: string) =>
        `createAuthClient({\n${indent}baseURL: ${base}\n${indent}// Same order as the server's plugin array. These client plugins carry\n${indent}// no after-hooks, so the order is cosmetic here — keeping it identical\n${indent}// is what makes a side-by-side diff of the two files readable.\n${indent}plugins: [${names.map((name) => `${name}()`).join(", ")}],\n});`,
    );
  }

  const helpers = `

/**
 * Re-read the session with the cookie cache DISABLED, and tell the hook.
 *
 * For a change made outside better-auth's own endpoints — setting a profile
 * picture writes \`user.image\` straight through the adapter — which therefore
 * never refreshes the cookie cache. Until it is re-read, \`/get-session\` keeps
 * answering with the OLD user out of that cookie, and the change looks like it
 * did not happen. Call this after any server-side write to the user row that
 * bypassed better-auth's endpoints.
 */
export const refreshSession = async (): Promise<void> => {
  await authClient.getSession({ query: { disableCookieCache: true } });
  authClient.$store.notify("$sessionSignal");
};

/** True when \`data\` is better-auth's "password accepted, now do the second
 *  factor" answer. Read structurally: the client's result type does not carry
 *  the field. */
export const isTwoFactorChallenge = (data: unknown): boolean =>
  typeof data === "object" &&
  data !== null &&
  (data as { twoFactorRedirect?: unknown }).twoFactorRedirect === true;
`;

  const deletionHelpers = `
export type AccountDeletionRefusal =
  /** A password account sent none — ask for it. */
  | "password-required"
  /** The password was wrong. */
  | "invalid-password"
  /** An account with no password whose session is too old — sign in again. */
  | "session-expired"
  /** Anything else, the network included. The account still exists. */
  | "failed";

export const accountDeletionRefusal = (code: unknown): AccountDeletionRefusal => {
  switch (code) {
    case ACCOUNT_DELETION_PASSWORD_REQUIRED:
      return "password-required";
    case "INVALID_PASSWORD":
      return "invalid-password";
    case "SESSION_EXPIRED":
      return "session-expired";
    default:
      return "failed";
  }
};

/**
 * Does this account sign in with a password?
 *
 * An unknown answer reads as "yes": asking for a password the server then
 * turns out not to need costs one retry, while not asking for one it does need
 * costs a refusal with nowhere to type the answer.
 */
export const accountHasPassword = async (): Promise<boolean> => {
  const { data, error } = await authClient.listAccounts();
  if (error || !Array.isArray(data)) return true;
  return data.some((account: { providerId?: string }) => account.providerId === "credential");
};

/**
 * Delete the account, and forget it on this device — but only on success.
 *
 * On a refusal nothing local is touched: the account still exists. On a
 * success the account is gone whatever happens next, so a local cleanup that
 * throws must not report the deletion as failed.
 */
export const deleteAccount = async (args: {
  userId: string;
  password?: string;
}): Promise<{ ok: true } | { ok: false; reason: AccountDeletionRefusal }> => {
  try {
    const { error } = await authClient.deleteUser(
      args.password ? { password: args.password } : {},
    );
    if (error) return { ok: false, reason: accountDeletionRefusal(error.code) };
  } catch {
    return { ok: false, reason: "failed" };
  }
  return { ok: true };
};
`;

  out = `${out.trimEnd()}\n${helpers}`;
  if (options.wantsAccountDeletion) {
    out = out.replace(
      /(import \{ createAuthClient \} from "better-auth\/react";\n)/,
      `$1import { ACCOUNT_DELETION_PASSWORD_REQUIRED } from "__HATCHKIT_SHARED_SCOPE__/shared";\n`,
    );
    out = `${out.trimEnd()}\n${deletionHelpers}`;
  }

  return { source: out, applied: true };
}

export interface LoginPageRewriteOptions {
  wantsTwoFactor: boolean;
  wantsGoogle: boolean;
  wantsEmailOtp: boolean;
  wantsMagicLink: boolean;
}

/**
 * Patch `packages/client/src/app/login/page.tsx`.
 *
 * Three things go in, and the first is the one that matters:
 *
 *  1. the post-sign-in destination is validated `?next=` rather than a
 *     hardcoded path — an unvalidated one on the page everybody trusts is
 *     a working phishing redirect;
 *  2. the two-factor second step, which is skipped with an explanation on
 *     a host that cannot carry the challenge cookie;
 *  3. the alternative sign-in methods, below the password form.
 */
export function rewriteLoginPage(source: string, options: LoginPageRewriteOptions): RewriteResult {
  if (source.includes("safeNextFromSearch")) return alreadyDone(source);
  if (!source.includes('router.push("/dashboard")')) {
    return unchanged(
      source,
      "login page does not push /dashboard after sign-in, so the redirect could not be replaced safely",
    );
  }

  const imports = [`import { POST_AUTH_REDIRECT, safeNextFromSearch } from "@/lib/safe-next";`];
  // Whether mail can actually be delivered, so the alternative sign-in
  // forms can say "the code went to the server log" instead of leaving
  // somebody waiting for mail nobody tried to send.
  const needsHealth = options.wantsEmailOtp || options.wantsMagicLink;
  if (needsHealth) imports.push(`import { trpc } from "@/lib/trpc";`);
  if (options.wantsTwoFactor) {
    imports.push(
      `import { isTokenShell } from "@/lib/shell";`,
      `import { TwoFactorChallenge } from "@/components/auth/two-factor-challenge";`,
    );
  }
  if (options.wantsGoogle) {
    imports.push(`import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";`);
  }
  if (options.wantsEmailOtp) {
    imports.push(`import { EmailOtpSignIn } from "@/components/auth/email-otp-sign-in";`);
  }
  if (options.wantsMagicLink) {
    imports.push(`import { MagicLinkSignIn } from "@/components/auth/magic-link-sign-in";`);
  }

  const authClientNames = [
    "signIn",
    ...(options.wantsTwoFactor ? ["authClient", "isTwoFactorChallenge"] : []),
  ];
  let out = source.replace(
    /import \{ signIn \} from "@\/lib\/auth-client";\n/,
    `import { ${authClientNames.join(", ")} } from "@/lib/auth-client";\n${imports.join("\n")}\n`,
  );

  const stateLines: string[] = [];
  if (options.wantsTwoFactor) {
    stateLines.push(`  const [step, setStep] = useState<"password" | "two-factor">("password");`);
  }
  if (needsHealth) {
    stateLines.push(
      `  // Public before sign-in, and two booleans wide. Used only to word the`,
      `  // "we sent you a code" confirmation honestly on a server with no mail.`,
      `  const health = trpc.health.check.useQuery(undefined, { staleTime: 5 * 60_000, retry: false });`,
      `  const mailConfigured = health.data?.authConfig?.emailVerificationRequired;`,
    );
  }
  if (stateLines.length > 0) {
    out = out.replace(
      /(const \[loading, setLoading\] = useState\(false\);\n)/,
      `$1${stateLines.join("\n")}\n`,
    );
  }

  // The redirect. Re-read from `window.location.search` at submit time
  // rather than from state: a submit that beat the effect still honours
  // the link it arrived with.
  const success = options.wantsTwoFactor
    ? `      } else if (isTwoFactorChallenge(result.data)) {
        // No session exists yet and no token was issued. The challenge is a
        // cookie, so a host that cannot send one could never finish this —
        // saying so beats a code field that always answers "invalid".
        if (isTokenShell()) {
          setError(
            "This account uses two-factor authentication, which this app cannot complete. Sign in on the web app instead.",
          );
        } else {
          setStep("two-factor");
        }
      } else {
        router.replace(safeNextFromSearch(window.location.search) ?? POST_AUTH_REDIRECT);
      }`
    : `      } else {
        router.replace(safeNextFromSearch(window.location.search) ?? POST_AUTH_REDIRECT);
      }`;

  out = out.replace(/\s*\} else \{\n\s*router\.push\("\/dashboard"\);\n\s*\}/, `\n${success}`);

  if (options.wantsTwoFactor) {
    const challenge = `
        {step === "two-factor" ? (
          <TwoFactorChallenge
            onDone={async (outcome) => {
              if (outcome === "expired") {
                setStep("password");
                setPassword("");
                setError("The sign-in took too long. Enter your password again.");
                return;
              }
              await authClient.getSession();
              router.replace(safeNextFromSearch(window.location.search) ?? POST_AUTH_REDIRECT);
            }}
            onCancel={() => {
              setStep("password");
              setPassword("");
              setError("");
            }}
          />
        ) : (
`;
    out = out.replace(/(\n\s*)(<form onSubmit=\{handleSubmit\})/, `${challenge}$1  $2`);
    out = out.replace(/(<\/form>)/, `$1\n        )}`);
  }

  const extras: string[] = [];
  if (options.wantsGoogle) extras.push("<GoogleSignInButton />");
  if (options.wantsEmailOtp) {
    extras.push(
      "<EmailOtpSignIn\n            mailConfigured={mailConfigured}\n            onSignedIn={() => {\n              router.replace(safeNextFromSearch(window.location.search) ?? POST_AUTH_REDIRECT);\n            }}\n          />",
    );
  }
  if (options.wantsMagicLink) extras.push("<MagicLinkSignIn mailConfigured={mailConfigured} />");

  if (extras.length > 0) {
    const block = `
        <div className="space-y-3 border-t pt-6">
${extras.map((node) => `          ${node}`).join("\n")}
        </div>
`;
    out = out.replace(
      /(\n\s*<div className="text-center text-sm">\n\s*<Link href="\/forgot-password")/,
      `${block}$1`,
    );
  }

  return { source: out, applied: true };
}

/**
 * Add `names` to the page's import from `module`, or add that import after
 * the auth-client one. Null when neither import is where it should be.
 */
function withNamedImports(source: string, module: string, names: readonly string[]): string | null {
  const escaped = module.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const existing = new RegExp(`^import \\{([^}]*)\\} from "${escaped}";$`, "m").exec(source);
  const have = (existing?.[1] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (names.every((name) => have.includes(name))) return source;
  const merged = [...new Set([...have, ...names])].sort((a, b) =>
    a.localeCompare(b, "en", { sensitivity: "base" }),
  );
  const line = `import { ${merged.join(", ")} } from "${module}";`;
  if (existing) {
    return `${source.slice(0, existing.index)}${line}${source.slice(existing.index + existing[0].length)}`;
  }
  const authImport = /^import \{[^}]*\} from "@\/lib\/auth-client";\n/m.exec(source);
  if (!authImport) return null;
  const at = authImport.index + authImport[0].length;
  return `${source.slice(0, at)}${line}\n${source.slice(at)}`;
}

/** The validated `next` as a render-time value: null until hydrated, since
 *  the prerender has no URL to read. */
const NEXT_DECLARATION = `  const mounted = useMounted();
  // After hydration: the page is prerendered, where there is no URL to read.
  const next = mounted ? safeNextFromSearch(window.location.search) : null;
`;

/** Declare `next` after `const router = useRouter();` and import what it
 *  needs. Null when the anchor or an import is missing. */
function withNextDeclaration(source: string): string | null {
  // A page that already has its own `next` or `mounted` is somebody's
  // edit; a second declaration would not compile.
  if (/\bconst next = mounted \? safeNextFromSearch\(/.test(source)) return source;
  if (/\bconst (next|mounted)\b/.test(source)) return null;
  const router = /^(\s*const router = useRouter\(\);\n)/m;
  if (!router.test(source)) return null;
  const out = withNamedImports(source.replace(router, `$1${NEXT_DECLARATION}`), "@/lib/safe-next", [
    "safeNextFromSearch",
  ]);
  return out && withNamedImports(out, "@/lib/use-mounted", ["useMounted"]);
}

/**
 * Patch `packages/client/src/app/signup/page.tsx`: after signing up, go where
 * `?next=` says (when the guard accepts it) instead of always to the
 * dashboard, and keep `next` on the link to the login page.
 */
export function rewriteSignupPage(source: string): RewriteResult {
  if (source.includes("safeNextFromSearch")) return alreadyDone(source);
  if (!source.includes('router.push("/dashboard")')) {
    return unchanged(
      source,
      "signup page does not push /dashboard after sign-up, so the redirect could not be replaced safely",
    );
  }
  if (!source.includes('<Link href="/login"')) {
    return unchanged(source, "signup page has no link to /login to carry ?next= on");
  }
  let out = withNamedImports(source, "@/lib/safe-next", ["authPageHref", "POST_AUTH_REDIRECT"]);
  out = out && withNextDeclaration(out);
  if (!out) {
    return unchanged(
      source,
      "signup page does not import from @/lib/auth-client or call useRouter() where expected, or already declares its own next or mounted",
    );
  }
  out = out
    .replace(
      'router.push("/dashboard")',
      // Re-read at submit time, like the login page: a submit that beat
      // hydration still honours the link it arrived with.
      "router.push(safeNextFromSearch(window.location.search) ?? POST_AUTH_REDIRECT)",
    )
    .replace('<Link href="/login"', '<Link href={authPageHref("login", { next })}');
  return { source: out, applied: true };
}

/**
 * Keep `?next=` on the login page's link to the signup page, so somebody
 * who arrives to sign in and has no account yet still comes back to the
 * page that sent them. Separate from `rewriteLoginPage`, which returns early
 * on a page it has already patched.
 */
export function rewriteLoginSignupLink(source: string): RewriteResult {
  if (source.includes('authPageHref("signup"')) return alreadyDone(source);
  if (!source.includes('<Link href="/signup"')) {
    return unchanged(source, "login page has no link to /signup to carry ?next= on");
  }
  let out = withNamedImports(source, "@/lib/safe-next", ["authPageHref"]);
  out = out && withNextDeclaration(out);
  if (!out) {
    return unchanged(
      source,
      "login page does not import from @/lib/auth-client or call useRouter() where expected, or already declares its own next or mounted",
    );
  }
  out = out.replace('<Link href="/signup"', '<Link href={authPageHref("signup", { next })}');
  return { source: out, applied: true };
}

/** The block of alternative sign-in methods `rewriteLoginPage` writes. */
const ALT_METHODS_OPEN = '<div className="space-y-3 border-t pt-6">\n';

export interface LoginExtra {
  /** The component name, which is also the idempotency marker. */
  name: string;
  importLine: string;
  /** The element as written, one or more lines, without leading indent. */
  jsx: string;
  /** Apple goes first (its guidelines ask for equal prominence); the rest
   *  after whatever is already there. */
  position: "first" | "last";
}

const indentJsx = (jsx: string): string =>
  jsx
    .split("\n")
    .map((line) => `          ${line}`)
    .join("\n");

/**
 * Add sign-in components to the login page's alternative-methods block,
 * creating the block above the forgot-password link when there is none.
 *
 * Separate from `rewriteLoginPage`, which returns early on a page it has
 * already patched, so a method can be added on a later run too. Each
 * component is skipped when the page already names it.
 */
export function rewriteLoginPageExtras(
  source: string,
  extras: readonly LoginExtra[],
): RewriteResult {
  return insertSignInExtras(source, extras, {
    page: "login page",
    placeBlock: (out) => {
      const forgot =
        /(\n\s*<div className="text-center text-sm">\n\s*<Link href="\/forgot-password")/;
      if (!forgot.test(out)) return null;
      return out.replace(forgot, `\n        ${ALT_METHODS_OPEN}        </div>\n$1`);
    },
    missingAnchor: "neither the alternative sign-in block nor the forgot-password link",
  });
}

/**
 * The same for the signup page: the methods that create an account on first
 * use (Apple, Google, the extra social providers, guests) go below the form.
 * Email codes, sign-in links, usernames and passkeys stay on the login page:
 * each signs in to an account that already exists.
 */
export function rewriteSignupPageExtras(
  source: string,
  extras: readonly LoginExtra[],
): RewriteResult {
  return insertSignInExtras(source, extras, {
    page: "signup page",
    placeBlock: (out) => {
      const form = /(\n {8}<\/form>\n)/;
      if (!form.test(out)) return null;
      return out.replace(form, `$1\n        ${ALT_METHODS_OPEN}        </div>\n`);
    },
    missingAnchor: "neither the alternative sign-in block nor a closing </form>",
  });
}

function insertSignInExtras(
  source: string,
  extras: readonly LoginExtra[],
  target: {
    page: string;
    /** The page with an empty methods block added, or null when the anchor
     *  for it is gone. */
    placeBlock: (source: string) => string | null;
    missingAnchor: string;
  },
): RewriteResult {
  const wanted = extras.filter((extra) => !source.includes(`<${extra.name}`));
  if (wanted.length === 0) return alreadyDone(source);

  const authImport = /^import \{[^}]*\} from "@\/lib\/auth-client";\n/m.exec(source);
  if (!authImport) {
    return unchanged(
      source,
      `${target.page} does not import from @/lib/auth-client where expected`,
    );
  }
  const importAt = authImport.index + authImport[0].length;
  const imports = wanted
    .map((extra) => extra.importLine)
    .filter((line) => !source.includes(line))
    .map((line) => `${line}\n`)
    .join("");
  let out = `${source.slice(0, importAt)}${imports}${source.slice(importAt)}`;

  if (!out.includes(ALT_METHODS_OPEN)) {
    const placed = target.placeBlock(out);
    if (placed === null) {
      return unchanged(
        source,
        `${target.page} has ${target.missingAnchor} to place the sign-in buttons by`,
      );
    }
    out = placed;
  }

  const open = out.indexOf(ALT_METHODS_OPEN) + ALT_METHODS_OPEN.length;
  const first = wanted
    .filter((extra) => extra.position === "first")
    .map((extra) => indentJsx(extra.jsx));
  if (first.length > 0) out = `${out.slice(0, open)}${first.join("\n")}\n${out.slice(open)}`;
  const last = wanted
    .filter((extra) => extra.position === "last")
    .map((extra) => indentJsx(extra.jsx));
  if (last.length > 0) {
    const close = out.indexOf("\n        </div>", out.indexOf(ALT_METHODS_OPEN));
    out = `${out.slice(0, close)}\n${last.join("\n")}${out.slice(close)}`;
  }
  return { source: out, applied: true };
}

export const APPLE_LOGIN_EXTRA: LoginExtra = {
  name: "AppleSignInButton",
  importLine: `import { AppleSignInButton } from "@/components/auth/apple-sign-in-button";`,
  jsx: "<AppleSignInButton />",
  position: "first",
};

/** "Sign in with a passkey". The component hides itself in a token shell,
 *  where WebAuthn cannot work, so the page needs no host check of its own. */
export const PASSKEY_LOGIN_EXTRA: LoginExtra = {
  name: "PasskeySignIn",
  importLine: `import { PasskeySignIn } from "@/components/auth/passkey-sign-in";`,
  jsx: [
    "<PasskeySignIn",
    "  onSignedIn={() => {",
    "    router.replace(safeNextFromSearch(window.location.search) ?? POST_AUTH_REDIRECT);",
    "  }}",
    "/>",
  ].join("\n"),
  position: "first",
};

/** Kept for callers and tests that name Apple directly. */
export function rewriteLoginPageApple(source: string): RewriteResult {
  return rewriteLoginPageExtras(source, [APPLE_LOGIN_EXTRA]);
}

/**
 * Link Settings to Settings → Sign-in methods, below the page heading. A
 * settings page that has been rewritten past recognition is left alone; the
 * route works without the link.
 */
export function rewriteSettingsPage(source: string): RewriteResult {
  if (source.includes('href="/settings/accounts"')) return alreadyDone(source);
  const heading =
    /(<p className="text-muted-foreground">Manage your account settings<\/p>\n\s*<\/div>\n)/;
  if (!heading.test(source)) {
    return unchanged(
      source,
      "settings page heading not found, so no link to Sign-in methods was added",
    );
  }
  let out = source.replace(
    heading,
    `$1
      <Link
        href="/settings/accounts"
        className="inline-flex text-sm text-primary hover:underline"
        data-testid="settings-sign-in-methods"
      >
        Sign-in methods: link or remove a way to sign in →
      </Link>
`,
  );
  if (!/^import Link from "next\/link";$/m.test(out)) {
    out = out.replace(/^("use client";\n\n)/, `$1import Link from "next/link";\n`);
    if (!out.includes('import Link from "next/link";'))
      out = `import Link from "next/link";\n${out}`;
  }
  return { source: out, applied: true };
}
