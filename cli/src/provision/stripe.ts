/*
 * Stripe per-project provisioning.
 *
 * Called from BOTH `hatchkit create` and `hatchkit adopt`. Each call
 * stands up Stripe credentials + a webhook endpoint for the project in
 * **two** modes:
 *
 *   · TEST / sandbox  → ends up in `.env.development` (plaintext)
 *   · LIVE            → ends up in `.env.production`  (dotenvx-encrypted)
 *
 * What hatchkit can auto-provision (one resource per mode):
 *   POST /v1/webhook_endpoints  → returns whsec_… signing secret
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
import { SECRET_KEYS, getSecret, setSecret } from "../utils/secrets.js";
import { type Step, runSteps } from "../utils/step-runner.js";

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
 *  (`.env.development` for test, `.env.production` for live). */
export interface StripeModeCredentials {
  kind: "configured";
  mode: StripeMode;
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  webhookEndpointId: string;
  webhookUrl: string;
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
        `    TEST/sandbox → .env.development (plaintext)\n` +
        `    LIVE         → .env.production  (dotenvx-encrypted)\n` +
        `  Webhook signing secrets are auto-minted using your master keys;\n` +
        `  per-project app keys (sk + pk) you'll paste below — Stripe doesn't\n` +
        `  expose an API to mint those automatically.\n`,
    ),
  );

  const result: ProvisionStripeProjectResult = {};

  if (master.hasTestMaster && master.testSecretKey) {
    result.test = await provisionMode({
      projectName: opts.projectName,
      domain: opts.domain,
      events: opts.events ?? DEFAULT_STRIPE_EVENTS,
      mode: "test",
      masterSecretKey: master.testSecretKey,
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
      masterSecretKey: master.liveSecretKey,
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
  /** Master secret key for THIS mode — used to call POST
   *  /v1/webhook_endpoints. Distinct from the per-project sk pasted by
   *  the user; the master is hatchkit's own wiring credential. */
  masterSecretKey: string;
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
  const webhookUrl = `https://${args.domain}/api/stripe/webhook`;

  if (!args.reprompt && cachedWebhookSecret && cachedWebhookId) {
    webhookSecret = cachedWebhookSecret;
    webhookEndpointId = cachedWebhookId;
    console.log(chalk.dim(`  · ${info.label} webhook reused from cache (${webhookEndpointId})`));
  } else {
    console.log(chalk.dim(`  Creating ${info.label} webhook → ${webhookUrl}`));
    const created = await createStripeWebhook({
      projectName: args.projectName,
      url: webhookUrl,
      events: args.events,
      mode: args.mode,
      masterSecretKey: args.masterSecretKey,
    });
    webhookSecret = created.signingSecret;
    webhookEndpointId = created.endpointId;
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
          `       Subscriptions Write, Checkout Sessions Write, Billing Portal Sessions Write\n` +
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
  masterSecretKey: string;
}

async function createStripeWebhook(args: CreateWebhookArgs): Promise<{
  endpointId: string;
  signingSecret: string;
}> {
  const body = new URLSearchParams();
  body.set("url", args.url);
  body.set("description", `hatchkit: ${args.projectName} (${args.mode})`);
  for (const ev of args.events) body.append("enabled_events[]", ev);

  const res = await fetch("https://api.stripe.com/v1/webhook_endpoints", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.masterSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Stripe create webhook failed (${args.mode}): HTTP ${res.status} ${text}`);
  }
  const data = (await res.json()) as { id: string; secret: string };
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
  const dotenvxFlag = envFileLabel.endsWith(".env.production") ? " --encrypt" : "";
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

/** Delete the webhook endpoint hatchkit registered for `project` in
 *  `mode`. Returns "deleted" on success, "not-found" if the endpoint
 *  was already removed. Used by `hatchkit destroy <project>`. */
export async function deleteStripeProjectWebhook(
  project: string,
  mode: StripeMode,
): Promise<"deleted" | "not-found"> {
  const master = await ensureStripe();
  const masterKey = mode === "test" ? master.testSecretKey : master.liveSecretKey;
  if (!masterKey) {
    return "not-found";
  }
  const endpointId = await getSecret(SECRET_KEYS.stripeProjectWebhookId(project, mode));
  if (!endpointId) return "not-found";

  const res = await fetch(`https://api.stripe.com/v1/webhook_endpoints/${endpointId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${masterKey}` },
  });
  if (res.status === 404) return "not-found";
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Stripe delete webhook failed: HTTP ${res.status} ${text}`);
  }
  return "deleted";
}
