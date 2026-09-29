/*
 * Stripe → project wiring.
 *
 * Extracted out of the `hatchkit create` flow so `hatchkit add
 * <project> stripe` runs the exact same steps. That matters for
 * deferrals: a user who skips the Stripe key prompts during `create`
 * gets `stripe` recorded in `.hatchkit.json`'s `deferred[]`, and the
 * follow-up command printed in the summary has to land them back in
 * this function — not a subtly different second implementation.
 *
 * Shape per mode (test + live), mirroring `provisionStripeProject`:
 *   · `configured` → real keys collected, webhook endpoint minted,
 *                    values written to the env file for that mode.
 *   · `skipped`    → CHANGE_ME_* placeholders + a comment block naming
 *                    the exact `dotenvx set` commands to finish later.
 *
 * A fully-skipped run (both modes skipped, or master keys absent) is a
 * deferral, not a failure: nothing was created in Stripe, so there is
 * nothing to roll back — the caller records the returned `deferred`
 * step and carries on.
 */

import { join } from "node:path";
import chalk from "chalk";
import { SECRET_KEYS } from "../utils/secrets.js";
import { type DeferredStep, classifyOptionalStepError, deferralForStripe } from "./deferrals.js";

export interface WireStripeArgs {
  projectName: string;
  domain: string;
  /** Directory holding `.env.development(.local)` / `.env.production`
   *  for the server bundle. Stripe secrets are server-side only. */
  serverEnvDir: string;
  /** Label prefix used in console output, e.g. `packages/server`.
   *  Defaults to the directory name. */
  envLabelPrefix?: string;
}

export interface WireStripeResult {
  /** True when at least one mode ended up with real credentials. */
  configured: boolean;
  /** Present when no mode was configured — carries the follow-up
   *  command for the end-of-run summary and `.hatchkit.json`. */
  deferred?: DeferredStep;
  /** Keychain accounts holding webhook endpoint ids created by this
   *  run. The caller records them on its run ledger so `destroy` /
   *  rollback can reach the endpoints later. */
  webhookKeychainAccounts: string[];
}

export async function wireStripeForProject(args: WireStripeArgs): Promise<WireStripeResult> {
  const labelPrefix = args.envLabelPrefix ?? args.serverEnvDir;
  const webhookKeychainAccounts: string[] = [];

  try {
    const { provisionStripeProject, renderStripeEnv, renderStripeSkipComment } = await import(
      "./stripe.js"
    );
    const { appendCommentBlock, devLocalEnvPath, parseEnvLines, writeDevEnv, writeProdEnv } =
      await import("./write-env.js");
    const result = await provisionStripeProject({
      projectName: args.projectName,
      domain: args.domain,
    });

    const devEnvPath = devLocalEnvPath(args.serverEnvDir);
    const prodEnvPath = join(args.serverEnvDir, ".env.production");
    const devLabel = `${labelPrefix}/.env.development.local`;
    const prodLabel = `${labelPrefix}/.env.production`;

    if (result.test) {
      if (result.test.kind === "skipped") {
        appendCommentBlock(devEnvPath, renderStripeSkipComment("test", devLabel));
      }
      const pairs = parseEnvLines(renderStripeEnv(result.test));
      writeDevEnv(devEnvPath, pairs);
      // Only record the webhook ledger entry when we actually touched
      // Stripe's API — skipped runs leave nothing to undo.
      if (result.test.kind === "configured") {
        webhookKeychainAccounts.push(SECRET_KEYS.stripeProjectWebhookId(args.projectName, "test"));
      }
      console.log(
        chalk.green(
          result.test.kind === "skipped"
            ? `  ✓ Stripe sandbox placeholders → ${devLabel} (fill in later)`
            : `  ✓ Stripe sandbox creds → ${devLabel} (${pairs.length} keys)`,
        ),
      );
    }
    if (result.live) {
      if (result.live.kind === "skipped") {
        appendCommentBlock(prodEnvPath, renderStripeSkipComment("live", prodLabel));
      }
      const pairs = parseEnvLines(renderStripeEnv(result.live));
      writeProdEnv(prodEnvPath, pairs);
      if (result.live.kind === "configured") {
        webhookKeychainAccounts.push(SECRET_KEYS.stripeProjectWebhookId(args.projectName, "live"));
      }
      console.log(
        chalk.green(
          result.live.kind === "skipped"
            ? `  ✓ Stripe live placeholders → ${prodLabel} (encrypted CHANGE_ME values, fill in later)`
            : `  ✓ Stripe live creds → ${prodLabel} (encrypted, ${pairs.length} keys)`,
        ),
      );
    }

    const configured =
      result.test?.kind === "configured" || result.live?.kind === "configured" || false;
    if (configured) return { configured: true, webhookKeychainAccounts };
    return {
      configured: false,
      webhookKeychainAccounts,
      deferred: deferralForStripe({
        project: args.projectName,
        kind: "declined",
        reason: "no per-project keys entered — placeholder env values written instead",
      }),
    };
  } catch (err) {
    const outcome = classifyOptionalStepError(err);
    if (!outcome) throw err;
    console.log(chalk.yellow(`  Couldn't auto-provision Stripe: ${outcome.reason}`));
    console.log(
      chalk.dim(
        `  Create the webhook manually: dashboard.stripe.com → Developers → Webhooks,\n` +
          `  point at https://${args.domain}/api/stripe/webhook, then\n` +
          `  \`dotenvx set STRIPE_WEBHOOK_SECRET <whsec_…> -f ${labelPrefix}/.env.production\`.`,
      ),
    );
    return {
      configured: false,
      webhookKeychainAccounts,
      deferred: deferralForStripe({
        project: args.projectName,
        kind: outcome.kind,
        reason: outcome.reason,
      }),
    };
  }
}
