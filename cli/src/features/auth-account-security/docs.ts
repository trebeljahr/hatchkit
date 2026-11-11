/*
 * cli/src/features/auth-account-security/docs.ts — write the answer down
 * where the code is.
 *
 * The table this produces exists because of one recurring failure: a
 * sign-in method is added, it works in the browser, and it silently
 * cannot be completed in the app's own native shell. Nobody finds out
 * until a user reports a form that does nothing, because the shell has no
 * console and the server logs a perfectly ordinary request.
 *
 * So every method carries its verdict, and the verdict travels with the
 * generated project rather than living in a CLI that generated it once.
 */

import { AUTH_SECURITY_SPECS, specFor } from "./options.js";
import { APPLE_ENV_VARS, METHOD_ENV_VARS } from "./plan.js";
import type { AuthSecurityOption, AuthSecurityPlan, TokenShellSupport } from "./types.js";

const VERDICT_LABEL: Record<TokenShellSupport, string> = {
  yes: "Yes",
  partial: "Only with extra shell work",
  no: "No — web browsers only",
  "n/a": "Not a sign-in method",
};

/** Wrap each https URL in a code span. A bare `<domain>` placeholder is an
 *  HTML tag to a Markdown renderer, which drops it. A sentence's closing
 *  full stop stays outside the span. */
function codeSpanUrls(text: string): string {
  return text.replace(/https:\/\/\S+?(?=\.?(?:\s|$))/g, (url) => `\`${url}\``);
}

export interface AuthSecurityDocsInput {
  projectName: string;
  plan: AuthSecurityPlan;
  hasNativeClient: boolean;
  hasEmailTransport: boolean;
}

/** The generated `docs/account-security.md` for a project. */
export function renderAuthSecurityDocs(input: AuthSecurityDocsInput): string {
  const { plan } = input;
  const methods = plan.options.filter((option) => specFor(option).tokenShell !== "n/a");
  const controls = plan.options.filter((option) => specFor(option).tokenShell === "n/a");

  const lines: string[] = [];

  lines.push(`# Account security`);
  lines.push("");
  lines.push(
    `Sign-in methods and account controls for ${input.projectName}, added by \`hatchkit\`'s`,
    `\`auth-account-security\` feature. Re-run \`hatchkit update\` to add more of it later;`,
    `every step is idempotent and nothing already on disk is overwritten.`,
  );
  lines.push("");

  lines.push(`## What is switched on`);
  lines.push("");
  for (const option of plan.options) {
    const spec = specFor(option);
    lines.push(`- **${spec.label}** — ${spec.summary}`);
  }
  lines.push("");

  // ── The table ────────────────────────────────────────────────────────
  lines.push(`## Can a stored-token client complete these?`);
  lines.push("");
  lines.push(
    `A "stored-token client" is anything that authenticates with a bearer token because it`,
    `cannot use a cookie for the API's origin: a WKWebView or Capacitor shell, an Electron`,
    `renderer on a custom protocol, a browser extension's \`fetch\`. Such a client can neither`,
    `read \`set-cookie\` nor send \`Cookie\`, so any step whose state lives in a cookie is`,
    `unreachable for it.`,
  );
  lines.push("");
  lines.push(
    input.hasNativeClient
      ? `**This project ships a native shell, so this table is about code you are actually running.**`
      : `This project has no native shell today. The table still matters the day one is added —` +
          ` it is a property of each method, not of the current build.`,
  );
  lines.push("");

  if (methods.length === 0) {
    lines.push(`No sign-in methods beyond email and password are enabled.`);
  } else {
    lines.push(`| Method | Works on a stored-token client? |`);
    lines.push(`| --- | --- |`);
    for (const option of methods) {
      const spec = specFor(option);
      lines.push(`| ${spec.label} | ${VERDICT_LABEL[spec.tokenShell]} |`);
    }
    lines.push("");
    lines.push(`### Why, in each case`);
    lines.push("");
    for (const option of methods) {
      const spec = specFor(option);
      lines.push(`**${spec.label} — ${VERDICT_LABEL[spec.tokenShell]}**`);
      lines.push("");
      lines.push(spec.tokenShellNote);
      lines.push("");
    }
  }

  if (controls.length > 0) {
    lines.push(`### Account controls`);
    lines.push("");
    lines.push(
      `These are not sign-in methods, so the question above does not arise for them. Where it`,
      `is worth saying anyway, the reason is given.`,
    );
    lines.push("");
    for (const option of controls) {
      const spec = specFor(option);
      lines.push(`- **${spec.label}** — ${spec.tokenShellNote}`);
    }
    lines.push("");
  }

  // ── Rules that fail quietly ──────────────────────────────────────────
  lines.push(`## Rules that fail quietly if they are broken`);
  lines.push("");
  lines.push(
    `### better-auth plugin order`,
    "",
    `\`packages/server/src/auth/auth.ts\` registers its plugins in this order:`,
    "",
    "```",
    plan.serverPlugins.length > 0 ? plan.serverPlugins.join(" → ") : "(none)",
    "```",
    "",
    `after-hooks run in registration order, and \`bearer()\` emits \`set-auth-token\` for`,
    `whatever session cookie the response carries. Every plugin ahead of it can REPLACE the`,
    `session that sign-in just created — the two-factor hook deletes it outright. Register`,
    `\`bearer()\` first and a token client stores a credential for a session that is deleted a`,
    `moment later: every later request answers 401, the client believes it is signed in, and`,
    `nothing logs a reason. **The CLI's test suite reads the generated \`auth.ts\` and fails on`,
    `a wrong order**, because no runtime test catches it.`,
    "",
  );

  if (plan.options.includes("email-verification")) {
    lines.push(
      `### Email verification and existing accounts`,
      "",
      `Production requires verified email by default, even when mail is not configured.`,
      `Configure and test delivery before rollout. Outside production, the default follows`,
      `whether mail is configured. \`AUTH_REQUIRE_EMAIL_VERIFICATION=true\` or \`false\``,
      `explicitly overrides either default.`,
      "",
      `Existing unverified accounts must verify on their next password sign-in; existing`,
      `sessions remain valid. Sign-up and sign-in send verification mail. Verification does`,
      `not create a session automatically. Do not blanket-mark old addresses verified or`,
      `run the legacy \`backfill:email-verified\` script as a rollout step.`,
      "",
      `Mail-free deployments may explicitly set \`AUTH_REQUIRE_EMAIL_VERIFICATION=false\``,
      `only where unverified addresses are an accepted policy. This does not prove ownership.`,
      "",
      `\`sendVerificationEmail\` lives in the \`emailVerification\` block. Under`,
      `\`emailAndPassword\` better-auth never calls it, and nothing logs that it was skipped.`,
      "",
    );
  }

  if (plan.options.includes("credentials")) {
    lines.push(
      `### Changing a password must not sign the caller out`,
      "",
      `"Sign out other devices" is two requests, not \`changePassword\`'s own`,
      `\`revokeOtherSessions\` flag. That flag deletes THIS session too and issues a new one;`,
      `anything watching sessions then sees this device's own credential revoked and signs the`,
      `app out — every tab of the browser, since they share the new cookie. Calling`,
      `\`changePassword\` without the flag and then \`revokeOtherSessions()\` keeps the current`,
      `session, so the caller's credential never changes.`,
      "",
      `Relatedly: two-factor toggles DO replace the session. \`lib/session-revoked.ts\` asks`,
      `\`getSession\` with the cookie cache disabled before concluding that a closed socket`,
      `means "signed out", and resumes instead when the session turns out to be live.`,
      "",
    );
  }

  if (plan.options.includes("account-deletion")) {
    lines.push(
      `### Deletion converges on a retry`,
      "",
      `Every cascade step is a delete by filter, so a step that already ran matches nothing the`,
      `second time. There is no progress marker and no resume point. That is why a failure in`,
      `\`beforeDelete\` is safe — better-auth stops before removing the user row, and the person`,
      `simply tries again — and why \`afterDelete\` runs the whole cascade a SECOND time: a`,
      `request from another of this person's devices can recreate a row between the two passes.`,
      "",
      `A password account must send its password. better-auth alone would delete on a merely`,
      `fresh session, and a browser session lasts far longer than that.`,
      "",
      `better-auth's \`deleteUser\` removes only the user, account and session rows. The cascade in`,
      `\`services/account-deletion/plan.ts\` deletes the rest: the plugin tables of the methods this`,
      `project uses (two-factor secrets, passkeys) and pending verification tokens. A plugin you`,
      `add later that stores rows per user needs a step there. Name only tables whose plugin is`,
      `registered: the adapter throws for an unknown model, and every deletion would then fail.`,
      "",
    );
  }

  if (plan.options.includes("profile-pictures")) {
    lines.push(
      `### Profile-picture bytes are public, at an unguessable address`,
      "",
      `An \`<img>\` sends no bearer token and, cross-origin, no cookie — so the route has to be`,
      `unauthenticated or the picture renders nowhere but the web app. What keeps it private`,
      `enough is the URL: the key is 128 random bits and changes on every upload.`,
      "",
      `The route overrides helmet's \`Cross-Origin-Resource-Policy\` with \`cross-origin\` for`,
      `itself only; without that no other origin can load it at all. The content type comes`,
      `from the bytes, never from the client, and SVG is refused because it can carry script.`,
      "",
      `After an upload the client re-reads the session with the cookie cache disabled —`,
      `\`user.image\` is written through the adapter, so the cached cookie would otherwise serve`,
      `the old user for up to five minutes.`,
      "",
    );
  }

  lines.push(
    `### Account linking is on`,
    "",
    `One person can sign in several ways. \`auth.ts\` sets better-auth's \`account.accountLinking\`:`,
    "",
    `- Linking while signed in always works, from **Settings → Sign-in methods**`,
    `  (\`/settings/accounts\`), even when the provider's address differs from the account's.`,
    `- "Continue with Google" for an address that already has an account links the two only`,
    `  when BOTH sides verified the address. Otherwise somebody could register a victim's`,
    `  address with a password first and inherit their Google sign-in later.`,
    `- Google and Apple are trusted providers: both verify every address they return. Never`,
    `  add one that can report an unverified address.`,
    `- The last way to sign in cannot be unlinked. better-auth refuses it on the server, and`,
    `  the screen does not offer it. Passkeys, email codes and magic links belong to the`,
    `  address, not to an account row, so they never count as "the last one".`,
    "",
    `Linking is a browser redirect to the provider, so it cannot finish in a native or desktop`,
    `shell. Listing and unlinking are plain requests and work there with a bearer token.`,
    "",
  );

  const methodSections: Array<[AuthSecurityOption, string, string[]]> = [
    ["github-oauth", "GitHub", [`Callback URL: \`https://<domain>/api/auth/callback/github\`.`]],
    ["discord-oauth", "Discord", [`Redirect: \`https://<domain>/api/auth/callback/discord\`.`]],
    [
      "generic-oauth",
      "Generic OAuth / OIDC",
      [
        `Redirect: \`https://<domain>/api/auth/oauth2/callback/<OAUTH_PROVIDER_ID>\`. One provider`,
        `comes from the environment; add more entries in \`auth/generic-oauth.ts\`.`,
      ],
    ],
    [
      "steam-openid",
      "Steam",
      [
        `OpenID 2.0, verified with Steam on every return (\`auth/steam-sign-in.ts\`). An unlinked`,
        `Steam ID signs up a new account with a placeholder address under \`steam.invalid\`; to`,
        `add Steam to an existing account, link it from Settings → Sign-in methods.`,
      ],
    ],
  ];
  for (const [option, title, notes] of methodSections) {
    if (!plan.options.includes(option)) continue;
    lines.push(`### ${title} sign-in`, "", ...notes, "");
    const vars = METHOD_ENV_VARS[option] ?? [];
    if (vars.length > 0) {
      lines.push(`| Variable | Value |`, `| --- | --- |`);
      for (const { key, comment } of vars) lines.push(`| \`${key}\` | ${codeSpanUrls(comment)} |`);
      lines.push("");
    }
  }

  if (plan.options.includes("guest-accounts")) {
    lines.push(
      `### Guest accounts keep their data by being moved`,
      "",
      `A guest who signs up or signs in later becomes that account, and better-auth deletes the`,
      `guest. \`services/guest-upgrade.ts\` moves the guest's rows first. Add a line there for`,
      `every collection keyed by a user id: anything not moved is deleted with the guest.`,
      `Steam sign-in hands guests over too, through the same function.`,
      "",
    );
  }
  if (plan.options.includes("passkeys")) {
    lines.push(
      `### Passkeys`,
      "",
      `People add a passkey under Settings → Passkeys, then use "Sign in with a passkey" on the`,
      `login page. Both work in the web app only, because a passkey is bound to the web domain:`,
      `a native or desktop shell hides the button, and Settings explains why.`,
      "",
    );
  }
  if (plan.options.includes("username-sign-in")) {
    lines.push(
      `### Usernames`,
      "",
      `People set a username under Settings → Sign-in methods, then sign in with it and their`,
      `password. Two-factor applies to this path exactly as to email sign-in.`,
      "",
    );
  }
  if (plan.options.includes("guest-accounts") || plan.options.includes("username-sign-in")) {
    lines.push(
      `A Postgres project must add the plugins' user fields (\`isAnonymous\`; \`username\`,`,
      `\`displayUsername\`) to \`src/db/schema.ts\` and migrate. MongoDB needs nothing.`,
      "",
    );
  }

  if (plan.options.includes("apple-oauth")) {
    lines.push(
      `### Sign in with Apple`,
      "",
      `The button renders only when all four required variables are set and the key parses.`,
      `A partial set is logged by name at boot and leaves Apple off. Set the values in`,
      `\`packages/server/.env.production\` (encrypted with dotenvx), then run \`hatchkit sync\` to`,
      `push them to Coolify:`,
      "",
      `| Variable | Value |`,
      `| --- | --- |`,
      ...APPLE_ENV_VARS.map(({ key, comment }) => `| \`${key}\` | ${codeSpanUrls(comment)} |`),
      "",
      `The portal steps — App ID capability, Services ID and its return URL, the \`.p8\` key, the`,
      `Team ID, and registering your sending domain with Apple's private email relay — have no`,
      `API, so only a person can do them. Hatchkit's docs page "Sign in with Apple" lists them.`,
      "",
      `Two rules in \`auth/apple-sign-in.ts\` fail quietly:`,
      "",
      `- **\`clientSecret\` is a getter.** Apple refuses a client secret older than six months.`,
      `  better-auth reads the getter on every token call, so the secret is re-minted in time.`,
      `  A plain value works until the first one expires. \`tests/apple-sign-in.test.ts\` runs a`,
      `  real better-auth instance to prove the secret still changes.`,
      `- **Apple's origin is trusted by \`appleSignInPlugin()\`, not in \`trustedOrigins\`.** Apple`,
      `  returns with a cross-site POST, which better-auth refuses from an untrusted origin`,
      `  whenever the request carries a cookie. \`trustedOrigins\` also feeds the CORS list, and`,
      `  Apple's page must not make credentialed requests to this API.`,
      "",
      `**Native apps.** In a shell the button is disabled with a note, because Apple's`,
      `\`form_post\` cannot return to a shell origin. The server already accepts a native identity`,
      `token at \`/sign-in/social\` with \`idToken: { token, nonce }\`, but only when`,
      `\`APPLE_APP_BUNDLE_ID\` is set; the shell needs a native Sign in with Apple plugin and the`,
      `Sign in with Apple entitlement first. App Store guideline 4.8: an iOS app that offers a`,
      `third-party login, such as Google, must also offer an equivalent such as Sign in with`,
      `Apple. Make both work natively in the same release, or neither.`,
      "",
    );
  }

  lines.push(
    `### The \`?next=\` parameter is validated`,
    "",
    `\`packages/client/src/lib/safe-next.ts\` accepts a redirect target only when it is`,
    `unmistakably a path on this origin — exactly one leading slash, no backslash, whitespace`,
    `or control character, still same-origin once parsed, and under an allowlisted prefix.`,
    "",
    `The login page is the page everybody trusts, which is what makes an unvalidated \`next\` a`,
    `working phishing redirect with your own domain in the address bar. \`authPageHref\` also`,
    `DROPS an unsafe value rather than forwarding it, so it cannot survive the hop between`,
    `login and signup — which is how an allowlist actually gets bypassed.`,
    "",
    `Add a screen to \`SAFE_NEXT_PREFIXES\` when it needs a return trip. Do not replace the`,
    `list with a "starts with /" check.`,
    "",
  );

  if (!input.hasEmailTransport && plan.options.some((option) => specFor(option).needsEmail)) {
    lines.push(
      `## No mail transport is configured yet`,
      "",
      `Configure and test mail before using verification, password reset, sign-in codes or`,
      `magic links. Missing mail does not disable production verification.`,
      `Development and test may log auth links. Production refuses that fallback unless`,
      `the operator explicitly enables \`AUTH_LOG_LINKS=true\` for owner recovery.`,
      `Auth links are credentials: restrict log access and retention, remove the override`,
      `after recovery, and keep it off on hosted or multi-user services.`,
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Every option's verdict, for the CLI's own `hatchkit explain` output
 *  and for the test that asserts no method ships without an answer. */
export function tokenShellVerdicts(): Array<{
  option: AuthSecurityOption;
  verdict: TokenShellSupport;
  note: string;
}> {
  return Object.values(AUTH_SECURITY_SPECS).map((spec) => ({
    option: spec.id,
    verdict: spec.tokenShell,
    note: spec.tokenShellNote,
  }));
}
