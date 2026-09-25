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
] as const;

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
          "Any SMTP host here selects SMTP as the transport, which is what turns email verification on. Leave every mail variable empty and the server logs verification URLs instead of mailing them — the documented way back into a self-host with no mail.",
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
        `No email transport is configured for this project, so ${needsMail
          .map((spec) => spec.label)
          .join(", ")} will stay switched off at runtime until one is. ` +
          "The code is still written — it decides per request, never at build time — so configuring mail later is a redeploy, not a re-scaffold.",
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
