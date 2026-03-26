import Stripe from "stripe";
import type { Request, Response } from "express";
import { env } from "../config/env.js";

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY is not configured");
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
  if (!env.STRIPE_WEBHOOK_SECRET) {
    res.status(500).json({ error: "Stripe webhook secret not configured" });
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
