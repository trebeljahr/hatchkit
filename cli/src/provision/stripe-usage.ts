/* Usage text of `hatchkit stripe`, kept apart so `--help` loads nothing else. */

import chalk from "chalk";

export const STRIPE_USAGE = `
  ${chalk.bold("hatchkit stripe")} — Stripe for paid unlocks

  ${chalk.bold("Subcommands:")}
    ${chalk.cyan("sync [dir] --mode test|live")}
                       Make the project's Stripe account match unlocks.json
                       (\`hatchkit add <project> paid-unlock\`): one product per
                       unlock (id hk_<project>_<key>), its current price under the
                       lookup key hatchkit:<project>:<key>, and the webhook
                       https://<domain>/api/unlock/webhook (live; test only with
                       --webhook-url). A changed price is a new price that takes
                       over the lookup key; the old one is archived. Never deletes.
                       A created webhook secret goes to the keychain and to
                       .dev.vars / .env.development.local (test) or
                       .env.production (live, server runtime). Live asks first.

    ${chalk.cyan("org-key --mode test|live")}
                       Store a Stripe organization API key (restricted: Products,
                       Prices, Webhook Endpoints write). With it, sync writes into
                       each project's own account via Stripe-Context.

    ${chalk.cyan("webhook-secret [dir] --mode test|live")}
                       Print the stored paid-unlock webhook secret, for piping into
                       \`wrangler secret put UNLOCK_WEBHOOK_SECRET\`.

  ${chalk.bold("Flags for sync:")}
    --account <acct_…>     The project's Stripe account for this mode; saved in
                           .hatchkit.json (stripe.accounts). Needed with an org key.
    --webhook-url <url>    Webhook URL (default live: https://<domain>/api/unlock/webhook;
                           test: none — use \`stripe listen\` locally)
    --archive-removed      Archive products that unlocks.json no longer lists
    --recreate-webhook     Delete and recreate the endpoint when its secret is lost
    --dry-run              Read Stripe, print the plan, write nothing
    --json                 Machine-readable result (never contains secrets)
    --yes                  Live: skip the confirmation (after reading the plan)

  HATCHKIT_STRIPE_API_VERSION overrides the Stripe-Version sync sends.
`;
