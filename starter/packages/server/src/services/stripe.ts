import Stripe from "stripe";
import type { Request, Response } from "express";
import { env } from "../config/env.js";

let _stripe: Stripe | null = null;

/** Detect the `CHANGE_ME_*` placeholders hatchkit writes when the user
 *  opted to skip pasting per-project keys at scaffold time. The starter
 *  treats these as "unconfigured" — same effect as an empty value, but
 *  preserved in the env file so the user notices. Mirrors the constants
 *  defined in `cli/src/provision/stripe.ts`. */
function isStripePlaceholder(value: string | undefined): boolean {
  return !!value && value.startsWith("CHANGE_ME_");
}

/** True when STRIPE_SECRET_KEY is either missing or still the
 *  CHANGE_ME placeholder. Stripe-dependent endpoints must short-circuit
 *  on this check; everything else in the app should keep working. */
export function isStripeUnconfigured(): boolean {
  return !env.STRIPE_SECRET_KEY || isStripePlaceholder(env.STRIPE_SECRET_KEY);
}

/** Log a clear warning at boot when any STRIPE_* env var is missing or
 *  still a CHANGE_ME placeholder. Called once from `index.ts` so the
 *  state shows up in dev (terminal) and prod (Coolify logs) without
 *  preventing the server from starting. */
export function warnStripeStatus(): void {
  const checks: Array<{ key: string; value: string | undefined }> = [
    { key: "STRIPE_SECRET_KEY", value: env.STRIPE_SECRET_KEY },
    { key: "STRIPE_PUBLISHABLE_KEY", value: env.STRIPE_PUBLISHABLE_KEY },
    { key: "STRIPE_WEBHOOK_SECRET", value: env.STRIPE_WEBHOOK_SECRET },
  ];
  const missing = checks.filter((c) => !c.value || isStripePlaceholder(c.value));
  if (missing.length === 0) return;

  const mode = env.STRIPE_MODE || "?";
  const prefix = "[stripe]";
  console.warn(
    `${prefix} WARNING: Stripe is not fully configured (mode=${mode}, ${missing.length}/3 vars missing).\n` +
      `${prefix}   Missing: ${missing.map((m) => m.key).join(", ")}\n` +
      `${prefix}   Stripe endpoints (checkout, billing portal, webhooks) will return errors\n` +
      `${prefix}   until set. Other features are unaffected.\n` +
      `${prefix}   Fix: replace each CHANGE_ME_* in .env.${env.isProduction ? "production" : "development"}\n` +
      `${prefix}        with a real value via \`dotenvx set <KEY> <value> -f <env-file>${env.isProduction ? " --encrypt" : ""}\`,\n` +
      `${prefix}        then restart the server.`,
  );
}

function getStripe(): Stripe {
  if (!_stripe) {
    if (isStripeUnconfigured()) {
      throw new Error(
        "Stripe is not configured (STRIPE_SECRET_KEY is missing or a CHANGE_ME_* placeholder). " +
          "Set it in your env file and restart. See the [stripe] startup warning for details.",
      );
    }
    _stripe = new Stripe(env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

/** Create a Stripe Checkout session for subscription or one-time purchase. */
export async function createCheckoutSession(params: {
  userId: string;
  priceId: string;
  mode: "subscription" | "payment";
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: params.mode,
    line_items: [{ price: params.priceId, quantity: 1 }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    client_reference_id: params.userId,
    metadata: { userId: params.userId },
  });
  return session.url!;
}

/** Create a Stripe billing portal session for managing subscriptions. */
export async function createPortalSession(params: {
  customerId: string;
  returnUrl: string;
}): Promise<string> {
  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: params.customerId,
    return_url: params.returnUrl,
  });
  return session.url;
}

/**
 * Express handler for Stripe webhooks.
 * Mount BEFORE express.json() with express.raw({ type: "application/json" }).
 */
export async function handleStripeWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  if (!env.STRIPE_WEBHOOK_SECRET || isStripePlaceholder(env.STRIPE_WEBHOOK_SECRET)) {
    res.status(503).json({
      error: "Stripe webhook secret not configured",
      hint: "STRIPE_WEBHOOK_SECRET is missing or a CHANGE_ME_* placeholder. See the [stripe] startup warning.",
    });
    return;
  }

  const stripe = getStripe();
  const signature = req.headers["stripe-signature"];

  if (!signature) {
    res.status(400).json({ error: "Missing stripe-signature header" });
    return;
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body as Buffer,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error("[stripe] Webhook signature verification failed:", err);
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  // Handle events — extend this switch for your billing logic
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      console.log(
        `[stripe] Checkout completed for user ${session.client_reference_id}`,
      );
      // TODO: Update user's subscription status in your database
      break;
    }
    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      console.log(
        `[stripe] Subscription ${subscription.id} updated: ${subscription.status}`,
      );
      // TODO: Update subscription status
      break;
    }
    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      console.log(`[stripe] Subscription ${subscription.id} cancelled`);
      // TODO: Handle cancellation
      break;
    }
    default:
      console.log(`[stripe] Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
}
