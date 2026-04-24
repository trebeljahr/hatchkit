/*
 * Stripe webhook auto-provisioning.
 *
 * When a project enables the `stripe` feature, hatchkit registers a
 * dedicated webhook endpoint on the user's Stripe account pointing at
 * `https://<domain>/api/stripe/webhook` and writes the resulting
 * `whsec_…` signing secret encrypted into `.env.production`.
 *
 * The Stripe API uses application/x-www-form-urlencoded for write
 * endpoints (not JSON). Arrays are encoded as `key[]=v1&key[]=v2`.
 *
 * Reference: https://docs.stripe.com/api/webhook_endpoints/create
 */

import { ensureStripe } from "../config.js";

/** Default events that the starter's `/api/stripe/webhook` handler
 *  cares about. Coverage for the standard Checkout + Subscription
 *  flow; extend here when the starter grows new webhook handlers. */
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

export interface StripeWebhookResult {
  /** `we_…` id Stripe assigns to the endpoint — useful for later teardown. */
  endpointId: string;
  /** The signing secret (`whsec_…`). Shown ONCE per Stripe API call. */
  signingSecret: string;
  /** Echo of the URL Stripe will POST to. */
  url: string;
  /** Resolved endpoint mode (test vs live) — taken from the Stripe
   *  config so callers can label env files / dashboards correctly. */
  mode: "test" | "live";
}

/** Register a webhook endpoint on Stripe pointing at the project's
 *  `/api/stripe/webhook` URL. */
export async function provisionStripeWebhook(
  projectName: string,
  domain: string,
  events: string[] = DEFAULT_STRIPE_EVENTS,
): Promise<StripeWebhookResult> {
  const cfg = await ensureStripe();
  const url = `https://${domain}/api/stripe/webhook`;

  const body = new URLSearchParams();
  body.set("url", url);
  body.set("description", `hatchkit: ${projectName} (${cfg.mode})`);
  for (const ev of events) body.append("enabled_events[]", ev);

  const res = await fetch("https://api.stripe.com/v1/webhook_endpoints", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Stripe create webhook failed: HTTP ${res.status} ${text}`);
  }
  const data = (await res.json()) as { id: string; secret: string; url: string };
  return {
    endpointId: data.id,
    signingSecret: data.secret,
    url: data.url,
    mode: cfg.mode ?? "test",
  };
}
