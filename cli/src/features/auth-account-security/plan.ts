/*
 * cli/src/features/auth-account-security/plan.ts — decide everything
 * before writing anything.
 *
 * `planAuthAccountSecurity` is pure: options in, a description of the
 * whole change out. Nothing here touches a filesystem, a network or a
 * provider, which is what lets the test suite assert the interesting
 * parts — the plugin order, the file set per option, the warnings — at
 * the cost of a function call.
 *
 * The apply step in `index.ts` does only what a plan says.
 */

import { optionsNeedingEmail, specFor } from "./options.js";
import { assertPluginOrder, clientPluginsFor, serverPluginsFor } from "./plugin-order.js";
import {
  AUTH_SECURITY_OPTIONS,
  type ApplyAuthSecurityOptions,
  type AuthSecurityOption,
  type AuthSecurityPlan,
} from "./types.js";

/** One template, and where it lands in the generated project.
 *  `template` is the path under cli/src/templates/auth-account-security/
 *  WITHOUT the `.tpl` suffix; `target` is relative to the project dir. */
export interface AuthSecurityFile {
  template: string;
  target: string;
}

/** Written whenever the feature is enabled at all, whatever the
 *  selection. The redirect guard is here rather than under an option on
 *  purpose: it is a security control, and an app that offers a `?next=`
 *  at all needs it. Making it optional would mean offering a build with
 *  a known open redirect. */
const CORE_FILES: readonly AuthSecurityFile[] = [
  { template: "client/safe-next.ts", target: "packages/client/src/lib/safe-next.ts" },
  { template: "client/shell.ts", target: "packages/client/src/lib/shell.ts" },
  // How the components read `shell.ts` after hydration without setting
  // state in an effect, which the starter's lint gate refuses.
  { template: "client/use-mounted.ts", target: "packages/client/src/lib/use-mounted.ts" },
  {
    template: "client/session-revoked.ts",
    target: "packages/client/src/lib/session-revoked.ts",
  },
  {
    template: "server/account-security.ts",
    target: "packages/server/src/auth/account-security.ts",
  },
  {
    template: "server/email-delivery.ts",
    target: "packages/server/src/services/email-delivery.ts",
  },
  // Account linking is the default, so its screen is core: every project
  // with a second sign-in method needs somewhere to attach and detach it.
  {
    template: "client/linked-accounts.tsx",
    target: "packages/client/src/components/settings/linked-accounts.tsx",
  },
  {
    template: "client/settings-accounts-page.tsx",
    target: "packages/client/src/app/(protected)/settings/accounts/page.tsx",
  },
] as const;

/** The login-page component every extra method shares. */
const MORE_METHODS_BUTTONS: AuthSecurityFile = {
  template: "client/more-sign-in-methods.tsx",
  target: "packages/client/src/components/auth/more-sign-in-methods.tsx",
};
const SOCIAL_PROVIDERS_MODULE: AuthSecurityFile = {
  template: "server/social-providers.ts",
  target: "packages/server/src/auth/social-providers.ts",
};

const FILES_BY_OPTION: Record<AuthSecurityOption, readonly AuthSecurityFile[]> = {
  "two-factor": [
    {
      template: "client/two-factor-challenge.tsx",
      target: "packages/client/src/components/auth/two-factor-challenge.tsx",
    },
    {
      template: "client/settings-two-factor.tsx",
      target: "packages/client/src/components/settings/two-factor.tsx",
    },
  ],
  "email-verification": [
    {
      template: "scripts/backfill-email-verified.ts",
      target: "packages/server/src/scripts/backfill-email-verified.ts",
    },
  ],
  credentials: [
    {
      template: "client/settings-account-credentials.tsx",
      target: "packages/client/src/components/settings/account-credentials.tsx",
    },
  ],
  "google-oauth": [
    {
      template: "client/google-sign-in-button.tsx",
      target: "packages/client/src/components/auth/google-sign-in-button.tsx",
    },
  ],
  "apple-oauth": [
    { template: "server/apple-sign-in.ts", target: "packages/server/src/auth/apple-sign-in.ts" },
    // Runs a real better-auth instance: the getter that keeps the client
    // secret fresh and Apple's trusted origin both fail quietly otherwise.
    {
      template: "server/apple-sign-in.test.ts",
      target: "packages/server/src/tests/apple-sign-in.test.ts",
    },
    {
      template: "client/apple-sign-in-button.tsx",
      target: "packages/client/src/components/auth/apple-sign-in-button.tsx",
    },
  ],
  "github-oauth": [SOCIAL_PROVIDERS_MODULE, MORE_METHODS_BUTTONS],
  "discord-oauth": [SOCIAL_PROVIDERS_MODULE, MORE_METHODS_BUTTONS],
  "generic-oauth": [
    { template: "server/generic-oauth.ts", target: "packages/server/src/auth/generic-oauth.ts" },
    MORE_METHODS_BUTTONS,
  ],
  "steam-openid": [
    { template: "server/steam-sign-in.ts", target: "packages/server/src/auth/steam-sign-in.ts" },
    // Runs the plugin inside a real better-auth instance with Steam stubbed:
    // a skipped check_authentication or a replayable return fails here.
    {
      template: "server/steam-sign-in.test.ts",
      target: "packages/server/src/tests/steam-sign-in.test.ts",
    },
    MORE_METHODS_BUTTONS,
  ],
  "guest-accounts": [
    { template: "server/guest-accounts.ts", target: "packages/server/src/auth/guest-accounts.ts" },
    {
      template: "server/guest-upgrade.ts",
      target: "packages/server/src/services/guest-upgrade.ts",
    },
    MORE_METHODS_BUTTONS,
  ],
  "username-sign-in": [
    {
      template: "server/username-sign-in.ts",
      target: "packages/server/src/auth/username-sign-in.ts",
    },
    {
      template: "client/username-sign-in.tsx",
      target: "packages/client/src/components/auth/username-sign-in.tsx",
    },
    {
      template: "client/settings-username.tsx",
      target: "packages/client/src/components/settings/username.tsx",
    },
  ],
  "account-deletion": [
    { template: "shared/account-deletion.ts", target: "packages/shared/src/account-deletion.ts" },
    {
      template: "server/account-deletion.ts",
      target: "packages/server/src/auth/account-deletion.ts",
    },
    {
      template: "server/account-deletion-plan.ts",
      target: "packages/server/src/services/account-deletion/plan.ts",
    },
    {
      template: "server/account-deletion-delete.ts",
      target: "packages/server/src/services/account-deletion/delete-account.ts",
    },
    {
      template: "server/account-deletion-stores.ts",
      target: "packages/server/src/services/account-deletion/stores.ts",
    },
    {
      template: "server/account-deletion-index.ts",
      target: "packages/server/src/services/account-deletion/index.ts",
    },
    {
      template: "client/settings-delete-account.tsx",
      target: "packages/client/src/components/settings/delete-account.tsx",
    },
  ],
  "profile-pictures": [
    { template: "shared/avatar.ts", target: "packages/shared/src/avatar.ts" },
    { template: "server/avatar-model.ts", target: "packages/server/src/models/Avatar.ts" },
    { template: "server/avatar-image.ts", target: "packages/server/src/services/avatar/image.ts" },
    { template: "server/avatar-store.ts", target: "packages/server/src/services/avatar/store.ts" },
    { template: "server/avatar-route.ts", target: "packages/server/src/services/avatar/route.ts" },
    { template: "server/avatar-index.ts", target: "packages/server/src/services/avatar/index.ts" },
    { template: "client/avatar-image.ts", target: "packages/client/src/lib/avatar-image.ts" },
    {
      template: "client/profile-picture.tsx",
      target: "packages/client/src/components/profile/profile-picture.tsx",
    },
  ],
  "email-otp": [
    {
      template: "client/email-otp-sign-in.tsx",
      target: "packages/client/src/components/auth/email-otp-sign-in.tsx",
    },
  ],
  "magic-link": [
    {
      template: "client/magic-link-sign-in.tsx",
      target: "packages/client/src/components/auth/magic-link-sign-in.tsx",
    },
  ],
  passkeys: [
    // Its own server module, because `@better-auth/passkey` is a separate
    // dependency: a project that did not ask for passkeys must not have to
    // install it just to compile `account-security.ts`.
    {
      template: "server/account-security-passkey.ts",
      target: "packages/server/src/auth/account-security-passkey.ts",
    },
    {
      template: "client/settings-passkeys.tsx",
      target: "packages/client/src/components/settings/passkeys.tsx",
    },
    // The login page's half: without it a passkey could be registered but
    // never used to sign in.
    {
      template: "client/passkey-sign-in.tsx",
      target: "packages/client/src/components/auth/passkey-sign-in.tsx",
    },
  ],
};

/** Sign in with Apple's variables. Written into `.env.example` and the
 *  compose file's environment by `index.ts`, and read straight from
 *  `process.env` by `auth/apple-sign-in.ts` — `config/env.ts` is not
 *  touched, because it would need one more anchor in a file several
 *  features edit. */
export const APPLE_ENV_VARS: ReadonlyArray<{ key: string; comment: string }> = [
  {
    key: "APPLE_CLIENT_ID",
    comment:
      "Services ID from the Apple Developer portal (e.g. com.example.app.signin). Its return URL is https://<domain>/api/auth/callback/apple.",
  },
  { key: "APPLE_TEAM_ID", comment: "10-character Team ID (Membership details)." },
  { key: "APPLE_KEY_ID", comment: "10-character Key ID of the Sign in with Apple key." },
  {
    key: "APPLE_PRIVATE_KEY",
    comment:
      "Contents of the .p8 file, on one line with literal \\n. A secret: encrypted in .env.production only.",
  },
  {
    key: "APPLE_APP_BUNDLE_ID",
    comment:
      "Optional. The native app's bundle ID, accepted as an identity-token audience. Leave empty unless a native app signs in with an Apple identity token.",
  },
];

/** Variables of the other env-gated sign-in methods, written into
 *  `.env.example` and the compose file beside Apple's. Read from
 *  `process.env` by each method's own module. */
export const METHOD_ENV_VARS: Partial<
  Record<AuthSecurityOption, ReadonlyArray<{ key: string; comment: string }>>
> = {
  "github-oauth": [
    {
      key: "GITHUB_CLIENT_ID",
      comment:
        "GitHub OAuth app client id. Callback URL: https://<domain>/api/auth/callback/github.",
    },
    { key: "GITHUB_CLIENT_SECRET", comment: "GitHub OAuth app client secret. A secret." },
  ],
  "discord-oauth": [
    {
      key: "DISCORD_CLIENT_ID",
      comment: "Discord application id. Redirect: https://<domain>/api/auth/callback/discord.",
    },
    { key: "DISCORD_CLIENT_SECRET", comment: "Discord OAuth2 client secret. A secret." },
  ],
  "generic-oauth": [
    {
      key: "OAUTH_PROVIDER_ID",
      comment:
        "Lowercase slug, e.g. keycloak. Redirect: https://<domain>/api/auth/oauth2/callback/<id>.",
    },
    { key: "OAUTH_PROVIDER_NAME", comment: "Button label, e.g. Company SSO." },
    { key: "OAUTH_CLIENT_ID", comment: "Client id from the provider." },
    { key: "OAUTH_CLIENT_SECRET", comment: "Client secret from the provider. A secret." },
    {
      key: "OAUTH_DISCOVERY_URL",
      comment:
        "OIDC discovery URL (.well-known/openid-configuration). Or set the three URLs below for plain OAuth 2.0.",
    },
    { key: "OAUTH_AUTHORIZATION_URL", comment: "Plain OAuth 2.0 only." },
    { key: "OAUTH_TOKEN_URL", comment: "Plain OAuth 2.0 only." },
    { key: "OAUTH_USERINFO_URL", comment: "Plain OAuth 2.0 only." },
    { key: "OAUTH_SCOPES", comment: "Optional, space-separated. Default: openid email profile." },
  ],
  "steam-openid": [
    {
      key: "STEAM_SIGN_IN",
      comment: "true switches Steam sign-in on. Steam OpenID needs no credentials.",
    },
    {
      key: "STEAM_WEB_API_KEY",
      comment:
        "Optional. Gives new Steam accounts their Steam name and avatar. https://steamcommunity.com/dev/apikey",
    },
  ],
};

/** Env vars the feature introduces, with the comment written above each
 *  in `.env.example` / `config/env.ts`. Only vars that are genuinely new
 *  — `GOOGLE_CLIENT_ID` and friends are already in the starter. */
const ENV_BY_OPTION: Partial<Record<AuthSecurityOption, Array<{ key: string; comment: string }>>> =
  {
    "email-verification": [
      {
        key: "SMTP_HOST",
        comment:
          "Selects SMTP for delivery. Production requires verified email by default even without mail; configure and test delivery before rollout. Auth URLs reach production logs only with explicit AUTH_LOG_LINKS=true owner recovery.",
      },
      { key: "SMTP_PORT", comment: "Defaults to 587 when empty." },
      { key: "SMTP_USER", comment: "Omit entirely for a relay that wants no AUTH." },
      { key: "SMTP_PASSWORD", comment: "" },
      {
        key: "EMAIL_FROM",
        comment:
          "From address. Deliberately not part of transport selection: an SMTP host with no From must still select SMTP and fail loudly, rather than look like 'mail is not configured'.",
      },
    ],
    "apple-oauth": [...APPLE_ENV_VARS],
    "github-oauth": [...(METHOD_ENV_VARS["github-oauth"] ?? [])],
    "discord-oauth": [...(METHOD_ENV_VARS["discord-oauth"] ?? [])],
    "generic-oauth": [...(METHOD_ENV_VARS["generic-oauth"] ?? [])],
    "steam-openid": [...(METHOD_ENV_VARS["steam-openid"] ?? [])],
  };

/** Order the options are applied and reported in — catalogue order, not
 *  the order the user happened to tick them. Keeps generated docs and
 *  audit output stable between runs. */
function inCatalogueOrder(options: readonly AuthSecurityOption[]): AuthSecurityOption[] {
  const picked = new Set(options);
  return AUTH_SECURITY_OPTIONS.filter((option) => picked.has(option));
}

/** Files a selection writes, deduplicated and in a stable order.
 *  Deduplication matters because two options can want the same shared
 *  constant file; writing it twice would be harmless but reporting it
 *  twice is a bug in the audit. */
export function filesFor(options: readonly AuthSecurityOption[]): AuthSecurityFile[] {
  const seen = new Set<string>();
  const out: AuthSecurityFile[] = [];
  for (const file of [
    ...CORE_FILES,
    ...inCatalogueOrder(options).flatMap((option) => FILES_BY_OPTION[option]),
  ]) {
    if (seen.has(file.target)) continue;
    seen.add(file.target);
    out.push(file);
  }
  return out;
}

export function planAuthAccountSecurity(
  input: Pick<ApplyAuthSecurityOptions, "options" | "hasNativeClient" | "hasEmailTransport">,
): AuthSecurityPlan {
  const options = inCatalogueOrder(input.options);

  const serverPlugins = serverPluginsFor(options, {
    hasNativeClient: input.hasNativeClient,
  });
  // Belt and braces. `serverPluginsFor` builds the list by filtering the
  // contract, so it cannot produce a wrong order — but this is the rule
  // the whole feature exists to keep, and a future refactor that starts
  // appending to the list instead should fail here rather than ship.
  assertPluginOrder(serverPlugins);

  const warnings: string[] = [];
  if (!input.hasEmailTransport) {
    const needsMail = optionsNeedingEmail(options);
    if (needsMail.length > 0) {
      warnings.push(
        `No email transport is configured for this project. Configure and test delivery for ${needsMail
          .map((spec) => spec.label)
          .join(", ")} before rollout. ` +
          "Production verification remains required by default. Auth links are not logged in production unless the operator explicitly enables AUTH_LOG_LINKS=true for recovery.",
      );
    }
  }

  // Native shells and the methods they cannot finish. Worth saying at
  // selection time, because the symptom on the device is a form that
  // accepts input and then fails with nothing useful in any log.
  if (input.hasNativeClient) {
    const unusable = options
      .map(specFor)
      .filter((spec) => spec.tokenShell === "no" || spec.tokenShell === "partial");
    if (unusable.length > 0) {
      warnings.push(
        `This project ships a native shell, which can hold a bearer token but not a cookie. ` +
          `${unusable.map((spec) => `${spec.label} (${spec.tokenShell})`).join(", ")} ` +
          "cannot be completed there as configured; the generated docs give the reason per method and the shells show a note instead of a dead form.",
      );
    }
  }

  const deps: AuthSecurityPlan["deps"] = [];
  for (const option of options) {
    const spec = specFor(option);
    for (const name of spec.serverDeps ?? []) {
      deps.push({ pkgDir: "packages/server", name, dev: false });
    }
    for (const name of spec.clientDeps ?? []) {
      deps.push({ pkgDir: "packages/client", name, dev: false });
    }
  }

  const envVars = options.flatMap((option) => ENV_BY_OPTION[option] ?? []);

  return {
    options,
    serverPlugins,
    clientPlugins: clientPluginsFor(options),
    files: filesFor(options).map((file) => file.target),
    envVars,
    deps,
    warnings,
  };
}
