/*
 * cli/src/features/auth-account-security/definition.ts — the feature's
 * registration against the shared contract in `../contract.ts`.
 *
 * Both invariants the contract demands hold here, and neither is a
 * coincidence:
 *
 * · **Additive.** The starter's better-auth instance registers no
 *   plugins, so there is nothing for this feature to strip. It only
 *   writes new files and patches the auth wiring, which is what makes
 *   it safe to layer onto a repo that has been live for months.
 *
 * · **Idempotent.** Template files are skipped when they already exist
 *   (they are scaffolding the user edits, not files hatchkit owns), and
 *   every rewriter detects its own previous output, so a second apply
 *   reports `unchanged` and writes nothing.
 *
 * The sub-option selection lives in the manifest rather than being
 * re-derived here: `apply` must not prompt, and a project that took
 * two-factor last month should not silently gain passkeys because the
 * defaults moved.
 */

import { type FeatureContext, registerFeature } from "../contract.js";
import { applyAuthAccountSecurity } from "./index.js";
import { AUTH_SECURITY_DEFAULT_OPTIONS, type AuthSecurityOption } from "./types.js";

/** Native shells hold a bearer token rather than a cookie, which decides
 *  whether `bearer()` is registered at all — and which sign-in methods
 *  can be completed there. */
function hasNativeShell(features: readonly string[]): boolean {
  return features.includes("desktop") || features.includes("mobile");
}

export const authAccountSecurityFeature = registerFeature({
  id: "auth-account-security",
  title: "Account security",
  summary:
    "Two-factor, account controls and extra sign-in methods on the starter's better-auth instance.",
  addableAfterScaffold: true,
  async apply(ctx: FeatureContext): Promise<void> {
    // Whatever the project already recorded wins over today's defaults.
    // A feature apply is not the place to change somebody's mind about
    // which sign-in methods their app offers.
    const recorded = ctx.manifest.authSecurity?.options as AuthSecurityOption[] | undefined;
    const options = recorded?.length ? recorded : [...AUTH_SECURITY_DEFAULT_OPTIONS];

    const audit = await applyAuthAccountSecurity({
      projectDir: ctx.projectDir,
      // Never a name derived here — the TOTP issuer is the label an
      // authenticator app shows forever after somebody enrols.
      projectName: ctx.identifiers.productName,
      options,
      hasNativeClient: hasNativeShell(ctx.manifest.features),
      hasEmailTransport:
        ctx.manifest.email?.transactional === "listmonk-ses" ||
        ctx.manifest.email?.mailingList === "listmonk-ses",
      domain: ctx.manifest.domain,
      ledger: ctx.ledger,
    });

    for (const warning of audit.warnings) ctx.log(`  ⚠ ${warning}`);
    for (const step of audit.manualResidue) ctx.log(`  → ${step}`);
  },
});
