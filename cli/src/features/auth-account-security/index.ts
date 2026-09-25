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
import { rewriteAuthClient, rewriteLoginPage } from "./client-rewriter.js";
import { renderAuthSecurityDocs } from "./docs.js";
import { PASSKEY_PACKAGE } from "./options.js";
import { filesFor, planAuthAccountSecurity } from "./plan.js";
import {
  type AuthSecurityTokens,
  renderAuthSecurityString,
  renderAuthSecurityTemplate,
} from "./render.js";
import {
  type RewriteResult,
  rewriteHealthRouter,
  rewriteProfileRouter,
  rewriteServerApp,
  rewriteServerAuth,
  rewriteSharedIndex,
} from "./server-rewriter.js";
import type { ApplyAuthSecurityOptions, AuthSecurityAudit, AuthSecurityOption } from "./types.js";

export * from "./types.js";
export { AUTH_SECURITY_SPECS, specFor, signInMethods, PASSKEY_PACKAGE } from "./options.js";
export { planAuthAccountSecurity, filesFor } from "./plan.js";
export { renderAuthSecurityDocs, tokenShellVerdicts } from "./docs.js";
export {
  ORDERED_SERVER_PLUGINS,
  assertPluginOrder,
  extractRegisteredPlugins,
  findPluginOrderViolation,
  serverPluginsFor,
} from "./plugin-order.js";
export { rewriteServerAuth } from "./server-rewriter.js";
export { rewriteAuthClient, rewriteLoginPage } from "./client-rewriter.js";

/** Screens a signed-out visitor may be sent back to after signing in.
 *  The starter's protected routes; a project adds its own. */
const DEFAULT_SAFE_NEXT_PREFIXES = ["/dashboard", "/profile", "/settings"] as const;

/** Where a freshly authenticated user lands when there is no `next`. */
const DEFAULT_POST_AUTH_REDIRECT = "/dashboard";

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
  const action = ledger.edit(rel, (source) => {
    const result = transform(source);
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
  };

  // 1. New files.
  for (const file of filesFor(plan.options)) {
    writeIfAbsent(ledger, file.target, renderAuthSecurityTemplate(file.template, tokens), audit);
  }

  // 2. Patches to files the starter already ships.
  rewriteExisting(
    ledger,
    "packages/server/src/auth/auth.ts",
    "server auth",
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
    tokens,
    audit,
  );

  rewriteExisting(
    ledger,
    "packages/server/src/trpc/routers/health.ts",
    "health router",
    rewriteHealthRouter,
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
    (source) =>
      rewriteLoginPage(source, {
        wantsTwoFactor: has("two-factor"),
        wantsGoogle: has("google-oauth"),
        wantsEmailOtp: has("email-otp"),
        wantsMagicLink: has("magic-link"),
      }),
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
  if (has("email-verification")) {
    audit.manualResidue.push(
      "Email verification: run `pnpm --filter @starter/server run backfill:email-verified` ONCE, straight after the first deploy that configures mail. Without it, every account created while verification was off is refused at sign-in.",
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
