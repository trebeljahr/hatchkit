/*
 * cli/src/features/auth-account-security/index.ts — the entrypoint every
 * command path routes through.
 *
 * `hatchkit create` (scaffold time) and `hatchkit update` (retrofit) both
 * call {@link applyAuthAccountSecurity}, so the on-disk result is
 * identical however the project got here.
 *
 * Idempotent by construction:
 *   • a template file that already exists is SKIPPED, never overwritten —
 *     a re-run must not clobber code somebody has since edited;
 *   • every rewrite detects its own previous output and no-ops;
 *   • a rewrite whose anchor has moved is reported as manual residue
 *     rather than forced.
 */

import { FeatureLedger } from "../contract.js";
import {
  APPLE_LOGIN_EXTRA,
  type LoginExtra,
  rewriteAuthClient,
  rewriteLoginPage,
  rewriteLoginPageExtras,
  rewriteSettingsPage,
} from "./client-rewriter.js";
import { renderAuthSecurityDocs } from "./docs.js";
import { PASSKEY_PACKAGE } from "./options.js";
import { APPLE_ENV_VARS, METHOD_ENV_VARS, filesFor, planAuthAccountSecurity } from "./plan.js";
import {
  type AuthSecurityTokens,
  renderAuthSecurityString,
  renderAuthSecurityTemplate,
} from "./render.js";
import {
  APPLE_ADDITION,
  APPLE_HEALTH_EXTRA,
  type AuthAddition,
  GENERIC_OAUTH_ADDITION,
  GUEST_ACCOUNTS_ADDITION,
  type HealthExtra,
  type RewriteResult,
  SIGN_IN_METHODS_HEALTH_EXTRA,
  SOCIAL_PROVIDERS_ADDITION,
  STEAM_ADDITION,
  USERNAME_ADDITION,
  rewriteHealthRouter,
  rewriteHealthRouterExtras,
  rewriteProfileRouter,
  rewriteServerApp,
  rewriteServerAuth,
  rewriteServerAuthAccountLinking,
  rewriteServerAuthAddition,
  rewriteSharedIndex,
} from "./server-rewriter.js";
import type { ApplyAuthSecurityOptions, AuthSecurityAudit, AuthSecurityOption } from "./types.js";

export * from "./types.js";
export { AUTH_SECURITY_SPECS, specFor, signInMethods, PASSKEY_PACKAGE } from "./options.js";
export { planAuthAccountSecurity, filesFor, APPLE_ENV_VARS, METHOD_ENV_VARS } from "./plan.js";
export { renderAuthSecurityDocs, tokenShellVerdicts } from "./docs.js";
export {
  ORDERED_SERVER_PLUGINS,
  assertPluginOrder,
  extractRegisteredPlugins,
  findPluginOrderViolation,
  serverPluginsFor,
} from "./plugin-order.js";
export {
  rewriteServerAuth,
  rewriteServerAuthAddition,
  rewriteServerAuthAccountLinking,
  rewriteServerAuthApple,
  rewriteHealthRouterApple,
  rewriteHealthRouterExtras,
  ACCOUNT_LINKING_BLOCK,
} from "./server-rewriter.js";
export {
  rewriteAuthClient,
  rewriteLoginPage,
  rewriteLoginPageApple,
  rewriteLoginPageExtras,
  rewriteSettingsPage,
} from "./client-rewriter.js";

/** Screens a signed-out visitor may be sent back to after signing in.
 *  The starter's protected routes; a project adds its own. */
const DEFAULT_SAFE_NEXT_PREFIXES = ["/dashboard", "/profile", "/settings"] as const;

/** Where a freshly authenticated user lands when there is no `next`. */
const DEFAULT_POST_AUTH_REDIRECT = "/dashboard";

/**
 * Run transforms in sequence over one file, as ONE edit. Each is idempotent
 * on its own, so the sequence is too — which `ledger.edit` requires.
 *
 * The first transform is the file's base patch: when it declines, nothing
 * is written, as before. A later one that declines is skipped and reported
 * in `partial`, and the patches before it still land — a moved anchor for
 * Sign in with Apple must not cost the project its two-factor wiring.
 */
function chain(
  base: (source: string) => RewriteResult,
  ...extras: Array<((source: string) => RewriteResult) | false>
): (source: string) => RewriteResult {
  return (source) => {
    const first = base(source);
    if (!first.applied) return first;
    let out = first.source;
    const partial: string[] = [];
    for (const extra of extras) {
      if (!extra) continue;
      const result = extra(out);
      if (result.applied) out = result.source;
      else partial.push(result.reason ?? "could not be patched automatically");
    }
    return { source: out, applied: true, partial };
  };
}

/** One method's lines in `.env.example`: a managed block under the Google
 *  pair, every value empty and commented out. */
function envExampleBlock(
  title: string,
  vars: ReadonlyArray<{ key: string; comment: string }>,
): string {
  const lines = [`# ${title} (optional — leave empty to disable). See docs/account-security.md.`];
  for (const { key, comment } of vars) {
    lines.push(`# ${comment}`, `# ${key}=`);
  }
  return lines.join("\n");
}

/** The same variables, passed through to the server container by the
 *  compose runtime — the way Coolify learns there is a field to fill. */
function composeBlock(vars: ReadonlyArray<{ key: string }>): string {
  return vars.map(({ key }) => `      ${key}: \${${key}:-}`).join("\n");
}

/** Every env-gated method's block: id, title, variables. */
function envBlocksFor(
  has: (option: AuthSecurityOption) => boolean,
): Array<{ id: string; title: string; vars: ReadonlyArray<{ key: string; comment: string }> }> {
  const blocks = [
    {
      option: "apple-oauth",
      id: "apple-sign-in",
      title: "Sign in with Apple",
      vars: APPLE_ENV_VARS,
    },
    { option: "github-oauth", id: "github-sign-in", title: "GitHub sign-in" },
    { option: "discord-oauth", id: "discord-sign-in", title: "Discord sign-in" },
    { option: "generic-oauth", id: "generic-oauth", title: "Generic OAuth / OIDC sign-in" },
    { option: "steam-openid", id: "steam-sign-in", title: "Steam sign-in" },
  ] as const;
  return blocks
    .filter((block) => has(block.option))
    .map((block) => ({
      id: block.id,
      title: block.title,
      vars: "vars" in block ? block.vars : (METHOD_ENV_VARS[block.option] ?? []),
    }));
}

/**
 * How `services/guest-upgrade.ts` moves a guest's items, for the database the
 * project's `Item` model actually uses: a Mongoose model in the starter, a
 * drizzle repository in the Postgres overlay. Read from the model file rather
 * than from the manifest, because the file is what the code will import.
 */
function guestMoveTokens(itemModel: string | undefined): {
  GUEST_MOVE_IMPORTS: string;
  GUEST_MOVE_BODY: string;
} {
  if (itemModel?.includes("mongoose")) {
    return {
      GUEST_MOVE_IMPORTS: `import { Item } from "../models/Item.js";`,
      GUEST_MOVE_BODY:
        "  await Item.updateMany({ ownerId: fromUserId }, { $set: { ownerId: toUserId } });",
    };
  }
  if (itemModel?.includes("drizzle")) {
    return {
      GUEST_MOVE_IMPORTS: [
        `import { eq } from "drizzle-orm";`,
        `import { getDb } from "../db/connection.js";`,
        `import { items } from "../db/schema.js";`,
      ].join("\n"),
      GUEST_MOVE_BODY:
        "  await getDb().update(items).set({ ownerId: toUserId }).where(eq(items.ownerId, fromUserId));",
    };
  }
  return {
    GUEST_MOVE_IMPORTS: "",
    GUEST_MOVE_BODY:
      "  // No per-user collections yet. Add one statement per collection keyed by user id.",
  };
}

/**
 * `auth/sign-in-methods.ts`: which extra methods this project offers, and
 * which can work right now. Generated from the selection and OWNED by
 * hatchkit — the selection lives in `.hatchkit.json`, so this file can always
 * be rebuilt from it.
 */
export function renderSignInMethodsModule(has: (option: AuthSecurityOption) => boolean): string {
  const social = (["github", "discord"] as const).filter((id) => has(`${id}-oauth`));
  const imports = [
    ...(social.length > 0
      ? [
          `import { type ExtraSocialProvider, enabledExtraSocialProviders } from "./social-providers.js";`,
        ]
      : []),
    ...(has("generic-oauth") ? [`import { genericOAuthButton } from "./generic-oauth.js";`] : []),
    ...(has("steam-openid") ? [`import { isSteamSignInEnabled } from "./steam-sign-in.js";`] : []),
  ];
  return `/**
 * Which extra sign-in methods this project offers, and which of them can work
 * right now. Served publicly by \`health.check\` (ids and a label, never a
 * credential), so the login page and Settings → Sign-in methods only offer
 * buttons that can finish.
 *
 * GENERATED by hatchkit's auth-account-security feature from
 * \`.hatchkit.json\` → authSecurity.options. \`hatchkit update\` rewrites it.
 */
${imports.join("\n")}${imports.length > 0 ? "\n" : ""}${
  social.length > 0
    ? `
/** The extra social providers this project offers. Each is live once its
 *  client id and secret are set (see social-providers.ts). */
export const EXTRA_SOCIAL_PROVIDERS: readonly ExtraSocialProvider[] = [${social.map((id) => `"${id}"`).join(", ")}];
`
    : ""
}
export type PublicSignInMethods = {
  social: string[];
  oauth: { id: string; name: string } | null;
  steam: boolean;
  guest: boolean;
  username: boolean;
};

export function publicSignInMethods(): PublicSignInMethods {
  return {
    social: ${social.length > 0 ? "enabledExtraSocialProviders(EXTRA_SOCIAL_PROVIDERS)" : "[]"},
    oauth: ${has("generic-oauth") ? "genericOAuthButton()" : "null"},
    steam: ${has("steam-openid") ? "isSteamSignInEnabled()" : "false"},
    guest: ${has("guest-accounts")},
    username: ${has("username-sign-in")},
  };
}
`;
}

/**
 * Write a template file, but never over one that is already there.
 *
 * Deliberately NOT `ledger.writeIfChanged`, which is for files a feature
 * owns outright and overwrites. These are scaffolding the user is
 * expected to edit — a settings component, a login form — so a second
 * `hatchkit update` must leave their version alone. The idempotency key
 * is existence, not content.
 */
function writeIfAbsent(
  ledger: FeatureLedger,
  rel: string,
  contents: string,
  audit: AuthSecurityAudit,
): void {
  if (ledger.exists(rel)) {
    audit.skipped.push(rel);
    return;
  }
  ledger.writeIfChanged(rel, contents);
  audit.written.push(rel);
}

/**
 * Patch a file the starter already ships.
 *
 * `ledger.edit` requires the transform to be a fixed point, and every
 * rewriter here satisfies that by detecting its own previous output — so
 * a re-run reports `unchanged` rather than patching twice.
 *
 * A rewriter whose anchor has moved returns `applied: false`, and that
 * becomes manual residue rather than a mangled file.
 */
function rewriteExisting(
  ledger: FeatureLedger,
  rel: string,
  label: string,
  transform: (source: string) => RewriteResult,
  tokens: AuthSecurityTokens,
  audit: AuthSecurityAudit,
): void {
  if (!ledger.exists(rel)) {
    audit.manualResidue.push(`${label}: ${rel} not found, so it was left alone.`);
    return;
  }
  let declined: string | undefined;
  let partial: string[] = [];
  const action = ledger.edit(rel, (source) => {
    const result = transform(source);
    partial = result.partial ?? [];
    if (!result.applied) {
      declined = result.reason ?? "could not be patched automatically";
      return source;
    }
    return renderAuthSecurityString(result.source, tokens);
  });
  if (declined) {
    audit.manualResidue.push(
      `${label}: ${declined}. Wire it by hand — see docs/account-security.md.`,
    );
    return;
  }
  for (const reason of partial) {
    audit.manualResidue.push(
      `${label}: ${reason}. Wire it by hand — see docs/account-security.md.`,
    );
  }
  if (action === "written" || action === "would-write") audit.rewritten.push(rel);
}

export async function applyAuthAccountSecurity(
  opts: ApplyAuthSecurityOptions & {
    projectName: string;
    /** Supply one to fold this feature's writes into a larger run's
     *  ledger (and to inherit its `--dry-run`). Omitted, a real-write
     *  ledger scoped to this feature is created. */
    ledger?: FeatureLedger;
  },
): Promise<AuthSecurityAudit> {
  const ledger = opts.ledger ?? new FeatureLedger(opts.projectDir, false);
  ledger.scopeTo("auth-account-security");
  const plan = planAuthAccountSecurity(opts);
  const audit: AuthSecurityAudit = {
    ok: false,
    options: plan.options,
    written: [],
    skipped: [],
    rewritten: [],
    warnings: [...plan.warnings],
    manualResidue: [],
  };

  const has = (option: AuthSecurityOption): boolean => plan.options.includes(option);

  // The cascade is rendered from the selection: a project without profile
  // pictures has no Avatar model, and naming a collection with no model
  // behind it would fail at import rather than at the call that needed it.
  const appCollections = ["profiles", ...(has("profile-pictures") ? ["avatars"] : []), "items"];
  const userSteps = [
    `    { collection: "profiles", filter: { userId: user.id } },`,
    ...(has("profile-pictures")
      ? [
          `    // The URL dies with the user row anyway, but the bytes would`,
          `    // otherwise stay served from an address a page may have cached.`,
          `    { collection: "avatars", filter: { userId: user.id } },`,
        ]
      : []),
    `    { collection: "items", filter: { ownerId: user.id } },`,
    `    { collection: "authTwoFactors", filter: { userId: user.id } },`,
  ];
  const modelImports = [
    ...(has("profile-pictures") ? [`import { Avatar } from "../../models/Avatar.js";`] : []),
    `import { Item } from "../../models/Item.js";`,
    `import { Profile } from "../../models/Profile.js";`,
  ];
  const modelMap = [
    `  profiles: Profile,`,
    ...(has("profile-pictures") ? [`  avatars: Avatar,`] : []),
    `  items: Item,`,
  ];

  const tokens: AuthSecurityTokens = {
    PROJECT_NAME: opts.projectName,
    SHARED_SCOPE: "@starter",
    POST_AUTH_REDIRECT: DEFAULT_POST_AUTH_REDIRECT,
    SAFE_NEXT_PREFIXES: DEFAULT_SAFE_NEXT_PREFIXES.map((prefix) => `  "${prefix}",`).join("\n"),
    DELETION_APP_COLLECTIONS: appCollections.map((name) => `"${name}"`).join(", "),
    DELETION_USER_STEPS: userSteps.join("\n"),
    DELETION_MODEL_IMPORTS: modelImports.join("\n"),
    DELETION_MODEL_MAP: modelMap.join("\n"),
    ...guestMoveTokens(ledger.read("packages/server/src/models/Item.ts")),
    ACCOUNTS_IMPORTS: has("username-sign-in")
      ? `import { UsernameSettings } from "@/components/settings/username";`
      : "",
    ACCOUNTS_SECTIONS: has("username-sign-in") ? "        <UsernameSettings />" : "",
  };

  // 1. New files.
  for (const file of filesFor(plan.options)) {
    writeIfAbsent(ledger, file.target, renderAuthSecurityTemplate(file.template, tokens), audit);
  }
  // Owned and regenerated, like the docs: it is a pure function of the
  // selection recorded in the manifest.
  const methodsAction = ledger.writeIfChanged(
    "packages/server/src/auth/sign-in-methods.ts",
    renderSignInMethodsModule(has),
  );
  if (methodsAction === "written" || methodsAction === "would-write") {
    audit.rewritten.push("packages/server/src/auth/sign-in-methods.ts");
  }

  // Applied in this order so that Apple's provider line, inserted last, ends
  // up FIRST in socialProviders. Plugins are placed by rank, not by order.
  const additions: AuthAddition[] = [
    ...(has("github-oauth") || has("discord-oauth") ? [SOCIAL_PROVIDERS_ADDITION] : []),
    ...(has("generic-oauth") ? [GENERIC_OAUTH_ADDITION] : []),
    ...(has("steam-openid") ? [STEAM_ADDITION] : []),
    ...(has("username-sign-in") ? [USERNAME_ADDITION] : []),
    ...(has("guest-accounts") ? [GUEST_ACCOUNTS_ADDITION] : []),
    ...(has("apple-oauth") ? [APPLE_ADDITION] : []),
  ];
  const healthExtras: HealthExtra[] = [
    SIGN_IN_METHODS_HEALTH_EXTRA,
    ...(has("apple-oauth") ? [APPLE_HEALTH_EXTRA] : []),
  ];
  const loginExtras: LoginExtra[] = [
    ...(has("apple-oauth") ? [APPLE_LOGIN_EXTRA] : []),
    ...((
      ["github-oauth", "discord-oauth", "generic-oauth", "steam-openid", "guest-accounts"] as const
    ).some(has)
      ? [
          {
            name: "MoreSignInMethods",
            importLine: `import { MoreSignInMethods } from "@/components/auth/more-sign-in-methods";`,
            jsx: "<MoreSignInMethods />",
            position: "last" as const,
          },
        ]
      : []),
    ...(has("username-sign-in")
      ? [
          {
            name: "UsernameSignIn",
            importLine: `import { UsernameSignIn } from "@/components/auth/username-sign-in";`,
            jsx: [
              "<UsernameSignIn",
              "  onSignedIn={() => {",
              "    router.replace(safeNextFromSearch(window.location.search) ?? POST_AUTH_REDIRECT);",
              "  }}",
              ...(has("two-factor") ? [`  onTwoFactor={() => setStep("two-factor")}`] : []),
              "/>",
            ].join("\n"),
            position: "last" as const,
          },
        ]
      : []),
  ];

  // 2. Patches to files the starter already ships.
  rewriteExisting(
    ledger,
    "packages/server/src/auth/auth.ts",
    "server auth",
    chain(
      (source) =>
        rewriteServerAuth(source, {
          serverPlugins: plan.serverPlugins,
          wantsTwoFactor: has("two-factor"),
          wantsEmailVerification: has("email-verification"),
          wantsAccountDeletion: has("account-deletion"),
          wantsEmailOtp: has("email-otp"),
          wantsMagicLink: has("magic-link"),
          wantsPasskeys: has("passkeys"),
        }),
      rewriteServerAuthAccountLinking,
      ...additions.map(
        (addition) => (source: string) => rewriteServerAuthAddition(source, addition),
      ),
    ),
    tokens,
    audit,
  );

  rewriteExisting(
    ledger,
    "packages/server/src/trpc/routers/health.ts",
    "health router",
    chain(rewriteHealthRouter, (source) => rewriteHealthRouterExtras(source, healthExtras)),
    tokens,
    audit,
  );

  if (has("profile-pictures")) {
    rewriteExisting(
      ledger,
      "packages/server/src/app.ts",
      "avatar route",
      rewriteServerApp,
      tokens,
      audit,
    );
    rewriteExisting(
      ledger,
      "packages/server/src/trpc/routers/profile.ts",
      "profile router",
      rewriteProfileRouter,
      tokens,
      audit,
    );
  }

  const sharedModules = [
    ...(has("account-deletion") ? ["account-deletion"] : []),
    ...(has("profile-pictures") ? ["avatar"] : []),
  ];
  if (sharedModules.length > 0) {
    rewriteExisting(
      ledger,
      "packages/shared/src/index.ts",
      "shared barrel",
      (source) => rewriteSharedIndex(source, sharedModules),
      tokens,
      audit,
    );
  }

  rewriteExisting(
    ledger,
    "packages/client/src/lib/auth-client.ts",
    "auth client",
    (source) =>
      rewriteAuthClient(source, {
        clientPlugins: plan.clientPlugins,
        wantsAccountDeletion: has("account-deletion"),
        wantsPasskeys: has("passkeys"),
      }),
    tokens,
    audit,
  );

  rewriteExisting(
    ledger,
    "packages/client/src/app/login/page.tsx",
    "login page",
    chain(
      (source) =>
        rewriteLoginPage(source, {
          wantsTwoFactor: has("two-factor"),
          wantsGoogle: has("google-oauth"),
          wantsEmailOtp: has("email-otp"),
          wantsMagicLink: has("magic-link"),
        }),
      loginExtras.length > 0 && ((source: string) => rewriteLoginPageExtras(source, loginExtras)),
    ),
    tokens,
    audit,
  );

  // Sign in with Apple's variables, where a person setting them up will look.
  // Managed blocks: hatchkit owns the lines between its markers and nothing
  // else, and a project without the file (or without the Google anchor in
  // the compose file) is left alone rather than given a block in the wrong
  // place.
  const exampleHasAnchor = ledger
    .read("packages/server/.env.example")
    ?.includes("GOOGLE_CLIENT_SECRET");
  const compose = ledger.read("docker-compose.yml");
  const composeAnchor = "GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET";
  for (const block of envBlocksFor(has)) {
    if (exampleHasAnchor) {
      ledger.ensureManagedBlock(
        "packages/server/.env.example",
        block.id,
        envExampleBlock(block.title, block.vars),
        { anchor: "GOOGLE_CLIENT_SECRET", commentPrefix: "#" },
      );
    }
    if (compose?.includes(composeAnchor)) {
      ledger.ensureManagedBlock("docker-compose.yml", block.id, composeBlock(block.vars), {
        anchor: composeAnchor,
        commentPrefix: "      #",
      });
    } else if (compose !== undefined) {
      audit.manualResidue.push(
        `${block.title}: docker-compose.yml has no GOOGLE_CLIENT_SECRET line to place ${block.vars.map((v) => v.key).join(", ")} by. Add them to the server's environment by hand if this project deploys with compose.`,
      );
    }
  }

  // Settings links to the new Sign-in methods screen.
  rewriteExisting(
    ledger,
    "packages/client/src/app/(protected)/settings/page.tsx",
    "settings link",
    rewriteSettingsPage,
    tokens,
    audit,
  );

  // 3. package.json, through the ledger's add-only merge: a script or a
  // version the user has changed is reported as a conflict and left
  // alone, rather than silently reverted on every `update`.
  if (has("email-verification")) {
    ledger.mergePackageJson("packages/server/package.json", {
      scripts: { "backfill:email-verified": "tsx src/scripts/backfill-email-verified.ts" },
    });
  }
  for (const pkgDir of new Set(plan.deps.map((dep) => dep.pkgDir))) {
    const dependencies = Object.fromEntries(
      plan.deps.filter((dep) => dep.pkgDir === pkgDir).map((dep) => [dep.name, "^1.7.0"]),
    );
    ledger.mergePackageJson(`${pkgDir}/package.json`, { dependencies });
  }

  // 4. The docs — which is where the token-shell answers live. This file
  // IS owned by hatchkit (it is regenerated from the selection every
  // run, and says so), so it goes through writeIfChanged.
  const docs = renderAuthSecurityDocs({
    projectName: opts.projectName,
    plan,
    hasNativeClient: opts.hasNativeClient,
    hasEmailTransport: opts.hasEmailTransport,
  });
  const docsAction = ledger.writeIfChanged("docs/account-security.md", docs);
  if (docsAction === "written" || docsAction === "would-write") {
    audit.rewritten.push("docs/account-security.md");
  }

  if (has("google-oauth")) {
    audit.manualResidue.push(
      "Google sign-in: create an OAuth client, then set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Until both are set the button renders disabled with a note — it never silently disappears.",
    );
  }
  if (has("apple-oauth")) {
    audit.manualResidue.push(
      `Sign in with Apple: in the Apple Developer portal, enable the capability on your App ID, create a Services ID with the return URL https://${opts.domain ?? "<domain>"}/api/auth/callback/apple (Apple accepts no localhost or IP address), and create a Sign in with Apple key. Then set APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY in packages/server/.env.production and run hatchkit sync. hatchkit cannot do the portal steps: Apple has no API for them. Until all four are set the button does not render. Steps: docs/account-security.md.`,
    );
  }
  const domain = opts.domain ?? "<domain>";
  if (has("github-oauth")) {
    audit.manualResidue.push(
      `GitHub sign-in: create an OAuth app (github.com → Settings → Developer settings) with the callback https://${domain}/api/auth/callback/github, then set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET. Until both are set the button does not render.`,
    );
  }
  if (has("discord-oauth")) {
    audit.manualResidue.push(
      `Discord sign-in: create an application (discord.com/developers) and add the OAuth2 redirect https://${domain}/api/auth/callback/discord, then set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.`,
    );
  }
  if (has("generic-oauth")) {
    audit.manualResidue.push(
      `Generic OAuth: register a client with your provider using the redirect https://${domain}/api/auth/oauth2/callback/<OAUTH_PROVIDER_ID>, then set the OAUTH_* variables.`,
    );
  }
  if (has("steam-openid")) {
    audit.manualResidue.push(
      "Steam sign-in: set STEAM_SIGN_IN=true. Steam OpenID needs no app registration; STEAM_WEB_API_KEY (steamcommunity.com/dev/apikey) is optional and only fills in names and avatars.",
    );
  }
  if (has("guest-accounts") || has("username-sign-in")) {
    audit.manualResidue.push(
      "Guest accounts / usernames add fields to better-auth's user table (isAnonymous; username, displayUsername). MongoDB needs nothing. A Postgres project must add the columns to src/db/schema.ts and run a migration.",
    );
  }
  if (has("guest-accounts")) {
    audit.manualResidue.push(
      "Guest accounts: add a line to services/guest-upgrade.ts for every collection your app keys by user id. Anything not moved there is deleted with the guest.",
    );
  }
  if (has("email-verification")) {
    audit.manualResidue.push(
      "Email verification: configure and test mail before rollout. Production requires verification by default; existing unverified accounts must verify on their next password sign-in. Do not run the legacy backfill or blanket-mark addresses verified. A mail-free deployment must explicitly accept unverified addresses with AUTH_REQUIRE_EMAIL_VERIFICATION=false.",
    );
  }
  if (has("passkeys")) {
    audit.manualResidue.push(
      `Passkeys: run your package manager's install — ${PASSKEY_PACKAGE} was added to package.json but not installed.`,
    );
  }

  audit.ok = true;
  return audit;
}
