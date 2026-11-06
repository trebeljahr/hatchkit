/*
 * Stripe per-project provisioning.
 *
 * Called from BOTH `hatchkit create` and `hatchkit adopt`. Each call
 * stands up Stripe credentials + a webhook endpoint for the project in
 * **two** modes:
 *
 *   · TEST / sandbox  → ends up in `.env.development.local` (plaintext, gitignored)
 *   · LIVE            → ends up in `.env.production`  (dotenvx-encrypted)
 *
 * What hatchkit can auto-provision (one resource per mode):
 *   POST /v1/webhook_endpoints  → returns whsec_… signing secret
 *
 * The endpoint is created in the project's own Stripe account, the one
 * its events come from: with the organization key and `Stripe-Context:
 * <acct_…>` when `.hatchkit.json` names the account (`stripe.accounts`),
 * else with the project's own key pasted below. Same resolution as
 * `hatchkit stripe sync` (`resolveSyncClient`). Before 2026-11-07 the
 * master key created it, in the master's account, so a per-project
 * sandbox never received its events; rename-domain and destroy still
 * find those older endpoints through the master key.
 *
 * What hatchkit MUST collect from the user (Stripe API doesn't allow
 * minting these programmatically — only the dashboard does):
 *   · per-project secret key (sk_test/sk_live or rk_test/rk_live)
 *   · per-project publishable key (pk_test/pk_live)
 *
 * Best-practice steering:
 *   · TEST mode → encourage one Sandbox per project so test data is
 *     fully isolated. Each Sandbox has its own sk_test/pk_test pair.
 *   · LIVE mode → encourage a project-scoped restricted key (Charges,
 *     Customers, PaymentIntents, Subscriptions, Checkout) so a leak
 *     of one project's `.env.production` can't access another's data.
 *
 * Stripe's API uses application/x-www-form-urlencoded for write
 * endpoints. Reference:
 *   https://docs.stripe.com/api/webhook_endpoints/create
 *   https://docs.stripe.com/sandboxes
 *   https://docs.stripe.com/keys-best-practices
 */

import { input, select } from "@inquirer/prompts";
import chalk from "chalk";
import { confirmPastedSecret, ensureStripe } from "../config.js";
import { type StripeClient, StripeError, stripeRequest } from "../paid-unlock/core.js";
import type { LedgerStep } from "../utils/run-ledger.js";
import {
  SECRET_KEYS,
  type StripeWebhookEndpoint,
  deleteSecret,
  getSecret,
  setSecret,
} from "../utils/secrets.js";
import { type Step, runSteps } from "../utils/step-runner.js";
import { resolveSyncClient, resolveWebhookClients } from "./stripe-sync-cli.js";

/** CHANGE_ME_<KEY> values the starter looks for to log a "Stripe is
 *  unconfigured" warning at boot. Kept in a single export so the
 *  starter and the CLI agree on the sentinel; updates here must be
 *  mirrored by `starter/packages/server/src/services/stripe.ts`. */
export const STRIPE_PLACEHOLDER = {
  secretKey: "CHANGE_ME_STRIPE_SECRET_KEY",
  publishableKey: "CHANGE_ME_STRIPE_PUBLISHABLE_KEY",
  webhookSecret: "CHANGE_ME_STRIPE_WEBHOOK_SECRET",
} as const;

/** Default events the starter's `/api/stripe/webhook` handler cares
 *  about. Coverage for the standard Checkout + Subscription flow;
 *  extend here when the starter grows new webhook handlers. */
export const DEFAULT_STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
];

export type StripeMode = "test" | "live";

/** Per-project Stripe credentials for ONE mode. Returned per mode by
 *  the provisioner so the caller can write each into the right env file
 *  (`.env.development.local` for test, `.env.production` for live). */
export interface StripeModeCredentials {
  kind: "configured";
  mode: StripeMode;
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  webhookEndpointId: string;
  webhookUrl: string;
  /** True when this run created the endpoint; false when it reused the
   *  one cached in the keychain. Only a created endpoint is recorded on
   *  the run ledger by this run. */
  webhookCreated: boolean;
  /** The `acct_…` the organization key wrote to; absent when the
   *  project's own key created the endpoint (or it was reused). */
  webhookAccount?: string;
}

/** User opted out of providing Stripe keys for this mode at scaffold
 *  time. Hatchkit doesn't touch Stripe's API on skip — no webhook gets
 *  minted — and writes a comment header + `CHANGE_ME_*` placeholders
 *  to the env file so the starter logs a loud "unconfigured" warning
 *  at boot. The user wires up later with `dotenvx set` or the dashboard. */
export interface StripeModeSkipped {
  kind: "skipped";
  mode: StripeMode;
}

export type StripeModeOutcome = StripeModeCredentials | StripeModeSkipped;

export interface ProvisionStripeProjectOptions {
  /** Project slug — used in webhook descriptions and as the keychain
   *  prefix so `hatchkit destroy <project>` can find/clean up. */
  projectName: string;
  /** Public domain the project will be reachable at. The webhook URL
   *  is `https://<domain>/api/stripe/webhook`. */
  domain: string;
  /** Override the event list the webhook subscribes to. Defaults to
   *  `DEFAULT_STRIPE_EVENTS`. */
  events?: string[];
  /** Force re-prompting per-project keys even if hatchkit has them
   *  cached in keychain from a previous run. */
  reprompt?: boolean;
  /** The project's Stripe account per mode (`.hatchkit.json`
   *  `stripe.accounts`). With an organization key stored, the webhook
   *  is created there through `Stripe-Context`; otherwise the project's
   *  own key creates it in its own account. */
  accounts?: { test?: string; live?: string };
  /** Called right after a webhook endpoint is created, with its
   *  `stripeWebhook` run-ledger entry, so destroy can delete it even if
   *  a later step fails. Reused (cached) endpoints are not reported. */
  onLedgerStep?: (step: LedgerStep) => void;
}

export interface ProvisionStripeProjectResult {
  test?: StripeModeOutcome;
  live?: StripeModeOutcome;
}

/** Per-mode tone for prompts and dashboard deep-links. */
const MODE_INFO: Record<
  StripeMode,
  {
    label: string;
    sandboxesUrl: string;
    apiKeysUrl: string;
    skPattern: RegExp;
    pkPattern: RegExp;
    skSample: string;
    pkSample: string;
  }
> = {
  test: {
    label: "TEST / Sandbox",
    sandboxesUrl: "https://dashboard.stripe.com/sandboxes",
    apiKeysUrl: "https://dashboard.stripe.com/test/apikeys",
    skPattern: /^(sk|rk)_test_/,
    pkPattern: /^pk_test_/,
    skSample: "sk_test_… or rk_test_…",
    pkSample: "pk_test_…",
  },
  live: {
    label: "LIVE",
    sandboxesUrl: "https://dashboard.stripe.com/apikeys",
    apiKeysUrl: "https://dashboard.stripe.com/apikeys",
    skPattern: /^(sk|rk)_live_/,
    pkPattern: /^pk_live_/,
    skSample: "sk_live_… or rk_live_…",
    pkSample: "pk_live_…",
  },
};

/** Provision Stripe for a project: collect per-project keys for each
 *  configured mode, register a webhook endpoint, persist everything in
 *  the OS keychain. The caller is responsible for writing the returned
 *  values into `.env.{development,production}`. */
export async function provisionStripeProject(
  opts: ProvisionStripeProjectOptions,
): Promise<ProvisionStripeProjectResult> {
  // Master keys — ensureStripe returns an `unconfigured` meta (no
  // throw) when the user deferred both modes during onboarding. In
  // that case we still emit per-mode skipped outcomes so the caller
  // writes CHANGE_ME placeholders + skip-comment recipes into both
  // env files; the starter then surfaces a clear "Stripe not
  // configured" notice in the billing UI at runtime.
  const master = await ensureStripe();

  console.log(chalk.bold(`\n  ── Stripe (${opts.projectName}) ─────────────────────────────\n`));

  if (!master.hasTestMaster && !master.hasLiveMaster) {
    console.log(
      chalk.yellow(
        `  Stripe master keys are not configured — emitting placeholder env values\n` +
          `  for both modes. The scaffolded project still ships the Stripe surface;\n` +
          `  the billing screen will render an "unconfigured" notice with the exact\n` +
          `  dotenvx commands until you wire real keys.\n` +
          `    Add masters later:  hatchkit config add stripe\n` +
          `    Then re-run wiring: hatchkit add ${opts.projectName} stripe\n`,
      ),
    );
    return {
      test: { kind: "skipped", mode: "test" },
      live: { kind: "skipped", mode: "live" },
    };
  }

  console.log(
    chalk.dim(
      `  Hatchkit provisions Stripe in two modes per project:\n` +
        `    TEST/sandbox → .env.development.local (plaintext, gitignored)\n` +
        `    LIVE         → .env.production  (dotenvx-encrypted)\n` +
        `  Per-project app keys (sk + pk) you'll paste below — Stripe doesn't\n` +
        `  expose an API to mint those automatically. Hatchkit then creates the\n` +
        `  webhook endpoint in that project's own account (with its key, or the\n` +
        `  organization key when .hatchkit.json names the account).\n`,
    ),
  );

  const result: ProvisionStripeProjectResult = {};

  if (master.hasTestMaster && master.testSecretKey) {
    result.test = await provisionMode({
      projectName: opts.projectName,
      domain: opts.domain,
      events: opts.events ?? DEFAULT_STRIPE_EVENTS,
      mode: "test",
      account: opts.accounts?.test,
      onLedgerStep: opts.onLedgerStep,
      reprompt: opts.reprompt ?? false,
    });
  } else {
    console.log(
      chalk.yellow(
        "  · Skipping TEST/sandbox — no test master key configured. " +
          "Run `hatchkit config add stripe` to add one.",
      ),
    );
    result.test = { kind: "skipped", mode: "test" };
  }

  if (master.hasLiveMaster && master.liveSecretKey) {
    result.live = await provisionMode({
      projectName: opts.projectName,
      domain: opts.domain,
      events: opts.events ?? DEFAULT_STRIPE_EVENTS,
      mode: "live",
      account: opts.accounts?.live,
      onLedgerStep: opts.onLedgerStep,
      reprompt: opts.reprompt ?? false,
    });
  } else {
    console.log(
      chalk.yellow(
        "  · Skipping LIVE — no live master key configured. " +
          "Run `hatchkit config add stripe` to add one.",
      ),
    );
    result.live = { kind: "skipped", mode: "live" };
  }

  return result;
}

interface ProvisionModeArgs {
  projectName: string;
  domain: string;
  events: string[];
  mode: StripeMode;
  /** The project's `acct_…` for this mode, if `.hatchkit.json` names it. */
  account?: string;
  onLedgerStep?: (step: LedgerStep) => void;
  reprompt: boolean;
}

async function provisionMode(args: ProvisionModeArgs): Promise<StripeModeOutcome> {
  const info = MODE_INFO[args.mode];
  console.log(chalk.bold(`\n  ${info.label}\n`));

  // Per-project app keys — paste once, cached in keychain for re-runs.
  // Skip path returns null so we short-circuit the webhook minting too:
  // a skipped mode should leave the user's Stripe account completely
  // untouched (no orphan webhook endpoints they didn't ask for).
  const collected = await collectPerProjectKeys({
    projectName: args.projectName,
    mode: args.mode,
    reprompt: args.reprompt,
  });
  if (collected.kind === "skipped") {
    console.log(
      chalk.yellow(
        `  · Skipped ${info.label}. Hatchkit will write commented placeholders\n` +
          `    to the env file. The starter logs a clear startup warning when\n` +
          `    Stripe vars are missing — non-Stripe features still work.`,
      ),
    );
    return { kind: "skipped", mode: args.mode };
  }

  // Webhook endpoint — ALWAYS re-create on a re-prompt to avoid orphaned
  // endpoints; idempotent re-runs (no reprompt) reuse the cached
  // signing secret if both the secret AND endpoint id are still in the
  // keychain.
  const cachedWebhookSecret = await getSecret(
    SECRET_KEYS.stripeProjectWebhookSecret(args.projectName, args.mode),
  );
  const cachedWebhookId = await getSecret(
    SECRET_KEYS.stripeProjectWebhookId(args.projectName, args.mode),
  );

  let webhookSecret: string;
  let webhookEndpointId: string;
  let webhookCreated = false;
  let webhookAccount: string | undefined;
  const webhookUrl = `https://${args.domain}/api/stripe/webhook`;

  if (!args.reprompt && cachedWebhookSecret && cachedWebhookId) {
    webhookSecret = cachedWebhookSecret;
    webhookEndpointId = cachedWebhookId;
    console.log(chalk.dim(`  · ${info.label} webhook reused from cache (${webhookEndpointId})`));
  } else {
    // The project's account: organization key + Stripe-Context when the
    // manifest names the account, else the key pasted above.
    const target = await resolveSyncClient(args.projectName, args.mode, args.account);
    console.log(chalk.dim(`  Creating ${info.label} webhook → ${webhookUrl} (${target.label})`));
    const created = await createStripeWebhook({
      projectName: args.projectName,
      url: webhookUrl,
      events: args.events,
      mode: args.mode,
      client: target.client,
      keyLabel: target.label,
    });
    webhookSecret = created.signingSecret;
    webhookEndpointId = created.endpointId;
    webhookCreated = true;
    if (target.usesAccount) webhookAccount = target.client.context;
    args.onLedgerStep?.({
      kind: "stripeWebhook",
      mode: args.mode,
      endpoint: "starter",
      endpointId: webhookEndpointId,
      url: webhookUrl,
      ...(webhookAccount ? { account: webhookAccount } : {}),
    });
    await setSecret(
      SECRET_KEYS.stripeProjectWebhookSecret(args.projectName, args.mode),
      webhookSecret,
    );
    await setSecret(
      SECRET_KEYS.stripeProjectWebhookId(args.projectName, args.mode),
      webhookEndpointId,
    );
    console.log(chalk.green(`  ✓ ${info.label} webhook created (${webhookEndpointId})`));
  }

  return {
    kind: "configured",
    mode: args.mode,
    secretKey: collected.secretKey,
    publishableKey: collected.publishableKey,
    webhookSecret,
    webhookEndpointId,
    webhookUrl,
    webhookCreated,
    ...(webhookAccount ? { webhookAccount } : {}),
  };
}

export interface CollectKeysArgs {
  projectName: string;
  mode: StripeMode;
  reprompt: boolean;
}

export type CollectedKeys =
  | { kind: "provided"; secretKey: string; publishableKey: string }
  | { kind: "skipped" };

export async function collectPerProjectKeys(args: CollectKeysArgs): Promise<CollectedKeys> {
  const info = MODE_INFO[args.mode];
  const skKeychain = SECRET_KEYS.stripeProjectSecretKey(args.projectName, args.mode);
  const pkKeychain = SECRET_KEYS.stripeProjectPublishableKey(args.projectName, args.mode);

  if (!args.reprompt) {
    const cachedSk = await getSecret(skKeychain);
    const cachedPk = await getSecret(pkKeychain);
    if (cachedSk && cachedPk) {
      console.log(
        chalk.dim(
          `  · ${info.label} per-project keys reused from cache ` +
            `(${args.projectName}). Pass --reprompt-stripe or rotate via the ` +
            `dashboard if you need fresh values.`,
        ),
      );
      return { kind: "provided", secretKey: cachedSk, publishableKey: cachedPk };
    }
  }

  // Best-practice steering specific to mode.
  if (args.mode === "test") {
    console.log(
      chalk.dim(
        `  Recommended: create a dedicated Sandbox for this project so test\n` +
          `  data (customers, charges, subscriptions) stays isolated from your\n` +
          `  other projects. Each sandbox has its own sk_test_/pk_test_ pair.\n` +
          `    1. Open ${chalk.cyan(info.sandboxesUrl)}\n` +
          `    2. Create a sandbox named ${chalk.cyan(args.projectName)} (or pick existing)\n` +
          `    3. Inside the sandbox: Developers → API keys → reveal sk_test/pk_test\n`,
      ),
    );
  } else {
    console.log(
      chalk.dim(
        `  Recommended: create a project-scoped restricted key so a leak in this\n` +
          `  project's .env.production can't reach customer/charge data on others.\n` +
          `    1. Open ${chalk.cyan(info.apiKeysUrl)} (must be in LIVE mode)\n` +
          `    2. Click 'Create restricted key', name it ${chalk.cyan(args.projectName)}\n` +
          `    3. Grant: Charges Write, Customers Write, PaymentIntents Write,\n` +
          `       Subscriptions Write, Checkout Sessions Write, Billing Portal Sessions Write,\n` +
          `       Webhook Endpoints Write (hatchkit creates the webhook with this key\n` +
          `       unless you stored an organization key: hatchkit stripe org-key)\n` +
          `    4. (You can also paste your account-wide sk_live but the blast\n` +
          `       radius will be larger.)\n`,
      ),
    );
  }

  interface KeysState {
    action: "provide" | "skip";
    secretKey: string;
    publishableKey: string;
  }

  const steps: Step<KeysState>[] = [
    {
      name: `${info.label}: provide or skip`,
      run: async (s) => ({
        ...s,
        action: await select<"provide" | "skip">({
          message: `${info.label}: provide keys now, or skip and wire up later?`,
          choices: [
            { name: "Provide keys now (paste sk + pk)", value: "provide" },
            {
              name: "Skip — write commented placeholders to the env file",
              value: "skip",
            },
          ],
          default: "provide",
        }),
      }),
    },
    {
      name: `${info.label} secret key`,
      skip: (s) => s.action === "skip",
      run: async (s) => {
        const secretKey = await confirmPastedSecret(
          `Per-project ${info.label} secret key (${info.skSample})`,
        );
        if (!info.skPattern.test(secretKey)) {
          throw new Error(
            `Pasted secret key doesn't match ${args.mode} mode (expected prefix ` +
              `sk_${args.mode}_ or rk_${args.mode}_).`,
          );
        }
        return { ...s, secretKey };
      },
    },
    {
      name: `${info.label} publishable key`,
      skip: (s) => s.action === "skip",
      run: async (s) => ({
        ...s,
        publishableKey: (
          await input({
            message: `Per-project ${info.label} publishable key (${info.pkSample}):`,
            validate: (v) => {
              const t = v.trim();
              if (!info.pkPattern.test(t))
                return `Must start with pk_${args.mode}_ for ${args.mode} mode.`;
              return true;
            },
          })
        ).trim(),
      }),
    },
  ];

  const collected = await runSteps(steps, {
    action: "provide" as const,
    secretKey: "",
    publishableKey: "",
  });
  if (collected.action === "skip") {
    return { kind: "skipped" };
  }

  const { secretKey, publishableKey } = collected;

  // Sanity-check the per-project secret by hitting /v1/balance.
  const verifyRes = await fetch("https://api.stripe.com/v1/balance", {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!verifyRes.ok) {
    const body = await verifyRes.text().catch(() => "");
    throw new Error(
      `Per-project ${args.mode} secret key failed verification (HTTP ${verifyRes.status}): ${body}`,
    );
  }

  await setSecret(skKeychain, secretKey);
  await setSecret(pkKeychain, publishableKey);

  return { kind: "provided", secretKey, publishableKey };
}

interface CreateWebhookArgs {
  projectName: string;
  url: string;
  events: string[];
  mode: StripeMode;
  /** Writes to the project's account (see `resolveSyncClient`). */
  client: StripeClient;
  keyLabel: string;
}

async function createStripeWebhook(args: CreateWebhookArgs): Promise<{
  endpointId: string;
  signingSecret: string;
}> {
  let data: { id?: string; secret?: string };
  try {
    data = await stripeRequest<{ id?: string; secret?: string }>(
      args.client,
      "POST",
      "/v1/webhook_endpoints",
      {
        url: args.url,
        description: `hatchkit: ${args.projectName} (${args.mode})`,
        enabled_events: args.events,
      },
    );
  } catch (err) {
    if (err instanceof StripeError && (err.status === 401 || err.status === 403)) {
      throw new Error(
        `Stripe create webhook failed (${args.mode}, ${args.keyLabel}): ${err.message}. ` +
          `The key needs Webhook Endpoints: Write; or store an organization key ` +
          `(hatchkit stripe org-key --mode ${args.mode}) and the project's acct_… under ` +
          `stripe.accounts.${args.mode} in .hatchkit.json.`,
      );
    }
    throw err;
  }
  if (!data.id || !data.secret)
    throw new Error(
      `Stripe created the ${args.mode} webhook but returned no id or signing secret.`,
    );
  return { endpointId: data.id, signingSecret: data.secret };
}

/** Render env-file lines for one mode. The starter reads:
 *    STRIPE_SECRET_KEY        — server, dotenvx-decrypted in prod
 *    STRIPE_PUBLISHABLE_KEY   — server (also surfaced to client below)
 *    STRIPE_WEBHOOK_SECRET    — server, dotenvx-decrypted in prod
 *    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY — client bundle (Next.js convention)
 *    STRIPE_MODE              — informational, lets the app warn loudly
 *                               if a live key was deployed without TLS
 *
 *  For a `skipped` outcome we emit `CHANGE_ME_*` placeholder values for
 *  the three secrets — the starter checks for that prefix at boot and
 *  logs a clear "Stripe is unconfigured" warning so dev/prod surfaces
 *  the gap instead of failing silently. STRIPE_MODE is still set so
 *  the warning message can name the right mode. */
export function renderStripeEnv(outcome: StripeModeOutcome): string[] {
  if (outcome.kind === "skipped") {
    return [
      `STRIPE_MODE=${outcome.mode}`,
      `STRIPE_SECRET_KEY=${STRIPE_PLACEHOLDER.secretKey}`,
      `STRIPE_PUBLISHABLE_KEY=${STRIPE_PLACEHOLDER.publishableKey}`,
      `STRIPE_WEBHOOK_SECRET=${STRIPE_PLACEHOLDER.webhookSecret}`,
      `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${STRIPE_PLACEHOLDER.publishableKey}`,
    ];
  }
  return [
    `STRIPE_MODE=${outcome.mode}`,
    `STRIPE_SECRET_KEY=${outcome.secretKey}`,
    `STRIPE_PUBLISHABLE_KEY=${outcome.publishableKey}`,
    `STRIPE_WEBHOOK_SECRET=${outcome.webhookSecret}`,
    `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${outcome.publishableKey}`,
  ];
}

/** Comment header to inject into the env file ABOVE the CHANGE_ME
 *  placeholder lines when the user skipped a mode. Idempotent — the
 *  first line acts as a sentinel that callers grep for, so re-runs
 *  don't duplicate the block. Listing concrete `dotenvx set` commands
 *  saves the user a trip to the docs.
 *
 *  `envFileLabel` is the relative path the user sees in their project
 *  (e.g. "packages/server/.env.production"); embedding it makes the
 *  copy-paste recipe complete. */
export function renderStripeSkipComment(mode: StripeMode, envFileLabel: string): string[] {
  const dashUrl =
    mode === "test"
      ? "https://dashboard.stripe.com/sandboxes (per-project sandbox recommended)"
      : "https://dashboard.stripe.com/apikeys (project-scoped restricted key recommended)";
  // dotenvx `set` encrypts by default; the dev file is plaintext.
  const dotenvxFlag = envFileLabel.endsWith(".env.production") ? " --encrypt" : " --plain";
  return [
    `# ─── Stripe (${mode}) — skipped at hatchkit scaffold time ───`,
    `# To wire up later:`,
    `#   1. Get your sk + pk from ${dashUrl}`,
    `#   2. Replace each CHANGE_ME_* with the real value:`,
    `#      pnpm --filter @starter/server exec dotenvx set STRIPE_SECRET_KEY <sk_${mode}_…> -f ${envFileLabel}${dotenvxFlag}`,
    `#      pnpm --filter @starter/server exec dotenvx set STRIPE_PUBLISHABLE_KEY <pk_${mode}_…> -f ${envFileLabel}${dotenvxFlag}`,
    `#   3. Create a webhook endpoint in the dashboard pointing at`,
    `#      https://<your-domain>/api/stripe/webhook (or use the Stripe CLI`,
    `#      \`stripe listen --forward-to localhost:5000/api/stripe/webhook\`),`,
    `#      then store its whsec_…:`,
    `#      pnpm --filter @starter/server exec dotenvx set STRIPE_WEBHOOK_SECRET <whsec_…> -f ${envFileLabel}${dotenvxFlag}`,
  ];
}

function webhookKeychain(project: string, mode: StripeMode, endpoint: StripeWebhookEndpoint) {
  return endpoint === "unlock"
    ? {
        id: SECRET_KEYS.stripeProjectUnlockWebhookId(project, mode),
        secret: SECRET_KEYS.stripeProjectUnlockWebhookSecret(project, mode),
      }
    : {
        id: SECRET_KEYS.stripeProjectWebhookId(project, mode),
        secret: SECRET_KEYS.stripeProjectWebhookSecret(project, mode),
      };
}

/** Thrown when no Stripe key that could reach the endpoint is stored. */
export class NoStripeKeyError extends Error {
  constructor(project: string, mode: StripeMode) {
    super(`No ${mode} Stripe key stored for ${project} (project key, organization key or master)`);
    this.name = "NoStripeKeyError";
  }
}

/** Delete one webhook endpoint hatchkit created, by its id, in the
 *  project's account (organization key + `account`, else the project's
 *  own key), then in the master key's account, where endpoints made
 *  before 2026-11-07 live. "not-found" when no key finds it. Throws
 *  NoStripeKeyError when no key is stored at all. */
export async function deleteStripeWebhookEndpoint(args: {
  project: string;
  mode: StripeMode;
  endpointId: string;
  account?: string;
}): Promise<"deleted" | "not-found"> {
  const clients = await resolveWebhookClients(args.project, args.mode, args.account);
  if (clients.length === 0) throw new NoStripeKeyError(args.project, args.mode);
  const path = `/v1/webhook_endpoints/${encodeURIComponent(args.endpointId)}`;
  for (const { client } of clients) {
    try {
      await stripeRequest(client, "DELETE", path);
      return "deleted";
    } catch (err) {
      if (err instanceof StripeError && err.status === 404) continue;
      throw err;
    }
  }
  return "not-found";
}

/** Drop the keychain id + signing secret of a deleted endpoint, but only
 *  while they still name it: a later run may have stored another one. */
export async function forgetStripeWebhook(
  project: string,
  mode: StripeMode,
  endpoint: StripeWebhookEndpoint,
  endpointId: string,
): Promise<void> {
  const keys = webhookKeychain(project, mode, endpoint);
  if ((await getSecret(keys.id)) !== endpointId) return;
  await deleteSecret(keys.secret);
  await deleteSecret(keys.id);
}

/** Delete the webhook endpoint whose id hatchkit stored for `project`
 *  in `mode` (the starter's by default), and forget its id + secret.
 *  "not-found" when no id is stored or Stripe no longer has it. */
export async function deleteStripeProjectWebhook(
  project: string,
  mode: StripeMode,
  opts: { endpoint?: StripeWebhookEndpoint; account?: string } = {},
): Promise<"deleted" | "not-found"> {
  const endpoint = opts.endpoint ?? "starter";
  const endpointId = await getSecret(webhookKeychain(project, mode, endpoint).id);
  if (!endpointId) return "not-found";
  const result = await deleteStripeWebhookEndpoint({
    project,
    mode,
    endpointId,
    account: opts.account,
  });
  await forgetStripeWebhook(project, mode, endpoint, endpointId);
  return result;
}

/**
 * Repoint the webhook endpoint hatchkit registered for `project` in
 * `mode` at a new URL. Used by the cutover phase of
 * `hatchkit migrate-domain`.
 *
 * The important property, and the reason this is an update rather than
 * a delete-and-recreate: Stripe keeps the endpoint's `whsec_` signing
 * secret across a URL change. Recreating the endpoint would mint a new
 * secret, which means `STRIPE_WEBHOOK_SECRET` in `.env.production` goes
 * stale the instant the new endpoint exists — every event between the
 * swap and the redeploy fails signature verification. Updating in place
 * has no such window and needs no env rewrite.
 *
 * The endpoint is looked up by id in the project's account (`account`
 * is the manifest's `stripe.accounts[mode]`, used with the organization
 * key), then in the master key's account for endpoints made before
 * 2026-11-07; the update goes to the account that has it.
 *
 * Returns "not-found" when no Stripe key is stored, the endpoint id
 * isn't in the keychain (nothing hatchkit created, nothing hatchkit
 * should move) or no account has it, and "unchanged" when Stripe already
 * holds the target URL — so re-running a cutover is free.
 */
export async function updateStripeProjectWebhookUrl(
  project: string,
  mode: StripeMode,
  url: string,
  account?: string,
): Promise<{ result: "updated" | "unchanged" | "not-found"; endpointId?: string }> {
  const endpointId = await getSecret(SECRET_KEYS.stripeProjectWebhookId(project, mode));
  if (!endpointId) return { result: "not-found" };
  const clients = await resolveWebhookClients(project, mode, account);
  if (clients.length === 0) return { result: "not-found" };

  const path = `/v1/webhook_endpoints/${encodeURIComponent(endpointId)}`;
  for (const { client } of clients) {
    let existing: { url?: string };
    try {
      existing = await stripeRequest<{ url?: string }>(client, "GET", path);
    } catch (err) {
      if (err instanceof StripeError && err.status === 404) continue;
      throw new Error(`Stripe read webhook failed (${mode}): ${(err as Error).message}`);
    }
    if (existing.url === url) return { result: "unchanged", endpointId };
    try {
      await stripeRequest(client, "POST", path, { url });
    } catch (err) {
      throw new Error(`Stripe update webhook failed (${mode}): ${(err as Error).message}`);
    }
    return { result: "updated", endpointId };
  }
  return { result: "not-found", endpointId };
}
