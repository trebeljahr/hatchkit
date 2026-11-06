/*
 * `hatchkit stripe sync` — make a project's Stripe account match its
 * unlocks.json: one Product per unlock, one current Price per Product
 * (found by lookup key), and the paid-unlock webhook endpoint.
 *
 * Why this exists: products and prices used to be typed into every
 * Stripe account by hand, and the webhook was created with a master key
 * in whatever account that key belonged to — not necessarily the
 * project's (a per-project sandbox never received its events). Sync
 * writes only to the project's own account: with an organization key it
 * sends `Stripe-Context: <the project's acct_…>`, otherwise it uses the
 * project's own key.
 *
 * Idempotent: a second run plans nothing. Never deletes: a removed
 * product is reported, and archived only with `archiveRemoved`. Stripe
 * Price amounts are immutable, so a changed price is a new Price that
 * takes over the lookup key (`transfer_lookup_key`); the old one is
 * archived.
 *
 * The Stripe calls go through `stripeRequest` from the runtime core, so
 * the CLI and the deployed Worker/server encode requests the same way.
 */

import {
  STRIPE_API_VERSION,
  type StripeClient,
  StripeError,
  type UnlockConfig,
  type UnlockProduct,
  stripeLookupKey,
  stripeProductId,
  stripeRequest,
} from "../paid-unlock/core.js";

export type StripeMode = "test" | "live";

/** Events the paid-unlock webhook needs: the purchase email. */
export const UNLOCK_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
] as const;

export interface SyncStep {
  action: "create" | "update" | "keep" | "archive" | "report";
  target: "product" | "price" | "webhook";
  key?: string;
  id?: string;
  detail: string;
}

/** Where the webhook signing secret is kept between runs (the keychain in
 *  the CLI, a map in tests). Stripe shows a secret only once, at creation. */
export interface WebhookSecretStore {
  get(): Promise<{ id: string; secret: string } | null>;
  set(value: { id: string; secret: string }): Promise<void>;
}

export interface StripeSyncInput {
  client: StripeClient;
  config: UnlockConfig;
  mode: StripeMode;
  /** null: no webhook endpoint (test mode without --webhook-url). */
  webhookUrl: string | null;
  secrets: WebhookSecretStore;
  dryRun?: boolean;
  archiveRemoved?: boolean;
  /** Delete the endpoint at `webhookUrl` and create it again, when its
   *  signing secret is lost. Running deliveries fail until the new secret
   *  is deployed. */
  recreateWebhook?: boolean;
}

export interface StripeSyncResult {
  steps: SyncStep[];
  /** Number of steps that write (or would write, on a dry run). */
  writes: number;
  webhook: {
    id?: string;
    url?: string;
    /** Set when this run created the endpoint (the only time Stripe
     *  returns the secret). Also stored through `secrets`. */
    createdSecret?: string;
    /** Secret on hand (from the store or just created). */
    secretKnown: boolean;
  };
}

interface StripeProduct {
  id: string;
  name: string;
  description?: string | null;
  active: boolean;
  tax_code?: string | { id: string } | null;
  metadata?: Record<string, string>;
}

interface StripePrice {
  id: string;
  active: boolean;
  currency: string;
  product: string | { id: string };
  unit_amount: number | null;
  custom_unit_amount?: {
    minimum?: number | null;
    preset?: number | null;
    maximum?: number | null;
  } | null;
  recurring?: { interval: string } | null;
  tax_behavior?: string | null;
  lookup_key?: string | null;
}

interface StripeWebhookEndpoint {
  id: string;
  url: string;
  enabled_events: string[];
  status?: string;
  secret?: string;
}

interface StripeList<T> {
  data: T[];
  has_more: boolean;
}

/** Fields of a Product hatchkit owns. Name and active state always;
 *  description and tax code only when unlocks.json sets them, so a
 *  description written in the dashboard survives. */
function desiredProduct(
  config: UnlockConfig,
  key: string,
  product: UnlockProduct,
): Record<string, unknown> {
  return {
    name: product.name,
    active: product.active !== false,
    ...(product.description ? { description: product.description } : {}),
    ...(product.taxCode ? { tax_code: product.taxCode } : {}),
    metadata: { hatchkit_project: config.project, hatchkit_unlock: key },
  };
}

function productDiff(existing: StripeProduct, desired: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (existing.name !== desired.name) out.push("name");
  if (existing.active !== desired.active) out.push(desired.active ? "reactivate" : "deactivate");
  if (desired.description !== undefined && existing.description !== desired.description)
    out.push("description");
  const taxCode = typeof existing.tax_code === "string" ? existing.tax_code : existing.tax_code?.id;
  if (desired.tax_code !== undefined && taxCode !== desired.tax_code) out.push("tax code");
  const meta = desired.metadata as Record<string, string>;
  if (
    existing.metadata?.hatchkit_project !== meta.hatchkit_project ||
    existing.metadata?.hatchkit_unlock !== meta.hatchkit_unlock
  )
    out.push("metadata");
  return out;
}

/** Price fields, for creation. Always tax-inclusive: the buyer sees one
 *  number, and turning Stripe Tax on later needs no new Price. */
function desiredPrice(
  config: UnlockConfig,
  key: string,
  product: UnlockProduct,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    product: stripeProductId(config.project, key),
    currency: config.currency,
    tax_behavior: "inclusive",
    lookup_key: stripeLookupKey(config.project, key),
    transfer_lookup_key: "true",
    metadata: { hatchkit_project: config.project, hatchkit_unlock: key },
  };
  if (typeof product.price === "number") {
    base.unit_amount = product.price;
  } else {
    base.custom_unit_amount = {
      enabled: "true",
      minimum: product.price.min,
      ...(product.price.preset !== undefined ? { preset: product.price.preset } : {}),
      ...(product.price.max !== undefined ? { maximum: product.price.max } : {}),
    };
  }
  if (product.interval) base.recurring = { interval: product.interval };
  return base;
}

/** Why `existing` no longer matches unlocks.json, or [] when it does. */
export function priceDiff(
  config: UnlockConfig,
  key: string,
  product: UnlockProduct,
  existing: StripePrice,
): string[] {
  const out: string[] = [];
  const productId = typeof existing.product === "string" ? existing.product : existing.product.id;
  if (!existing.active) out.push("archived");
  if (productId !== stripeProductId(config.project, key)) out.push("product");
  if (existing.currency !== config.currency) out.push("currency");
  if (existing.tax_behavior !== "inclusive") out.push("tax behavior");
  if (typeof product.price === "number") {
    if (existing.unit_amount !== product.price) out.push("amount");
  } else {
    const custom = existing.custom_unit_amount;
    if (
      !custom ||
      (custom.minimum ?? 0) !== product.price.min ||
      (custom.preset ?? undefined) !== product.price.preset ||
      (custom.maximum ?? undefined) !== product.price.max
    )
      out.push("pay what you want");
  }
  if ((existing.recurring?.interval ?? undefined) !== product.interval) out.push("interval");
  return out;
}

function money(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

function describePrice(config: UnlockConfig, product: UnlockProduct): string {
  const amount =
    typeof product.price === "number"
      ? money(product.price, config.currency)
      : `pay what you want from ${money(product.price.min, config.currency)}`;
  return product.interval ? `${amount} / ${product.interval}` : amount;
}

async function getOrNull<T>(
  client: StripeClient,
  path: string,
  params?: Record<string, unknown>,
): Promise<T | null> {
  try {
    return await stripeRequest<T>(client, "GET", path, params);
  } catch (err) {
    if (err instanceof StripeError && err.status === 404) return null;
    throw err;
  }
}

async function listAll<T extends { id: string }>(
  client: StripeClient,
  path: string,
  params: Record<string, unknown> = {},
  max = 1000,
): Promise<T[]> {
  const out: T[] = [];
  let startingAfter: string | undefined;
  while (out.length < max) {
    const page = await stripeRequest<StripeList<T>>(client, "GET", path, {
      ...params,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    out.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return out;
}

export async function syncStripe(input: StripeSyncInput): Promise<StripeSyncResult> {
  const { client, config } = input;
  const steps: SyncStep[] = [];
  const write = !input.dryRun;
  const result: StripeSyncResult = { steps, writes: 0, webhook: { secretKnown: false } };

  // ── Products and prices ────────────────────────────────────────────
  for (const [key, product] of Object.entries(config.products)) {
    const productId = stripeProductId(config.project, key);
    const desired = desiredProduct(config, key, product);
    const existing = await getOrNull<StripeProduct>(client, `/v1/products/${productId}`);
    if (!existing) {
      steps.push({ action: "create", target: "product", key, id: productId, detail: product.name });
      if (write) await stripeRequest(client, "POST", "/v1/products", { id: productId, ...desired });
    } else {
      const diff = productDiff(existing, desired);
      if (diff.length) {
        steps.push({
          action: "update",
          target: "product",
          key,
          id: productId,
          detail: diff.join(", "),
        });
        if (write) await stripeRequest(client, "POST", `/v1/products/${productId}`, desired);
      } else {
        steps.push({ action: "keep", target: "product", key, id: productId, detail: product.name });
      }
    }

    const lookupKey = stripeLookupKey(config.project, key);
    const prices = await stripeRequest<StripeList<StripePrice>>(client, "GET", "/v1/prices", {
      lookup_keys: [lookupKey],
      limit: 1,
    });
    const current = prices.data[0];
    const diff = current ? priceDiff(config, key, product, current) : ["missing"];
    if (current && diff.length === 0) {
      steps.push({
        action: "keep",
        target: "price",
        key,
        id: current.id,
        detail: describePrice(config, product),
      });
      continue;
    }
    steps.push({
      action: "create",
      target: "price",
      key,
      detail: `${describePrice(config, product)}${current ? ` (was ${current.id}: ${diff.join(", ")})` : ""}`,
    });
    if (write)
      await stripeRequest(client, "POST", "/v1/prices", desiredPrice(config, key, product));
    if (current?.active) {
      steps.push({ action: "archive", target: "price", key, id: current.id, detail: "replaced" });
      if (write)
        await stripeRequest(client, "POST", `/v1/prices/${current.id}`, { active: "false" });
    }
  }

  // ── Products in Stripe that unlocks.json no longer lists ──────────
  const prefix = stripeProductId(config.project, "");
  const ours = (await listAll<StripeProduct>(client, "/v1/products", { active: "true" })).filter(
    (p) => p.id.startsWith(prefix) && !(p.id.slice(prefix.length) in config.products),
  );
  for (const orphan of ours) {
    const key = orphan.id.slice(prefix.length);
    if (input.archiveRemoved) {
      steps.push({
        action: "archive",
        target: "product",
        key,
        id: orphan.id,
        detail: "not in unlocks.json",
      });
      if (write)
        await stripeRequest(client, "POST", `/v1/products/${orphan.id}`, { active: "false" });
    } else {
      steps.push({
        action: "report",
        target: "product",
        key,
        id: orphan.id,
        detail:
          "in Stripe, not in unlocks.json (--archive-removed archives it; buyers already lose access)",
      });
    }
  }

  // ── Webhook ────────────────────────────────────────────────────────
  if (input.webhookUrl) {
    const url = input.webhookUrl;
    result.webhook.url = url;
    const endpoints = await listAll<StripeWebhookEndpoint>(client, "/v1/webhook_endpoints");
    let endpoint = endpoints.find((e) => e.url === url);
    const stored = await input.secrets.get();
    const secretKnown = Boolean(endpoint && stored && stored.id === endpoint.id);

    if (endpoint && !secretKnown && input.recreateWebhook) {
      steps.push({
        action: "archive",
        target: "webhook",
        id: endpoint.id,
        detail: `delete ${url} (secret lost)`,
      });
      if (write) await stripeRequest(client, "DELETE", `/v1/webhook_endpoints/${endpoint.id}`);
      endpoint = undefined;
    }

    if (!endpoint) {
      steps.push({ action: "create", target: "webhook", detail: url });
      if (write) {
        const created = await stripeRequest<StripeWebhookEndpoint>(
          client,
          "POST",
          "/v1/webhook_endpoints",
          {
            url,
            enabled_events: [...UNLOCK_WEBHOOK_EVENTS],
            api_version: client.apiVersion ?? STRIPE_API_VERSION,
            description: `hatchkit: ${config.project} paid unlock (${input.mode})`,
            metadata: { hatchkit_project: config.project, hatchkit_feature: "paid-unlock" },
          },
        );
        if (!created.secret)
          throw new Error("Stripe created the webhook endpoint but returned no signing secret.");
        await input.secrets.set({ id: created.id, secret: created.secret });
        result.webhook.id = created.id;
        result.webhook.createdSecret = created.secret;
        result.webhook.secretKnown = true;
      }
    } else {
      result.webhook.id = endpoint.id;
      result.webhook.secretKnown = secretKnown;
      const missing = UNLOCK_WEBHOOK_EVENTS.filter(
        (e) => !endpoint?.enabled_events.includes(e) && !endpoint?.enabled_events.includes("*"),
      );
      const disabled = endpoint.status === "disabled";
      if (missing.length || disabled) {
        steps.push({
          action: "update",
          target: "webhook",
          id: endpoint.id,
          detail: [missing.length ? `add ${missing.join(", ")}` : "", disabled ? "enable" : ""]
            .filter(Boolean)
            .join("; "),
        });
        if (write)
          await stripeRequest(client, "POST", `/v1/webhook_endpoints/${endpoint.id}`, {
            enabled_events: [...new Set([...endpoint.enabled_events, ...UNLOCK_WEBHOOK_EVENTS])],
            ...(disabled ? { disabled: "false" } : {}),
          });
      } else {
        steps.push({ action: "keep", target: "webhook", id: endpoint.id, detail: url });
      }
      if (!secretKnown) {
        steps.push({
          action: "report",
          target: "webhook",
          id: endpoint.id,
          detail:
            "hatchkit does not hold this endpoint's signing secret. Use the one you deployed, roll it in the Stripe dashboard, or re-run with --recreate-webhook",
        });
      }
    }
  }

  result.writes = steps.filter(
    (s) => s.action === "create" || s.action === "update" || s.action === "archive",
  ).length;
  return result;
}

/** Second-level suffixes under which a registrable domain has three
 *  labels (example.co.uk). Not the full public suffix list: `hatchkit add`
 *  prints the zone it picked so it can be checked. */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "me.uk",
  "ac.uk",
  "gov.uk",
  "ltd.uk",
  "plc.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "org.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "com.br",
  "com.mx",
  "co.za",
  "co.in",
  "co.kr",
  "com.sg",
  "com.tr",
  "com.cn",
  "com.hk",
  "com.tw",
]);

/** Zone of a Workers route: the registrable domain of the host. */
export function zoneOf(domain: string): string {
  const labels = domain.toLowerCase().split(".");
  if (labels.length <= 2) return labels.join(".");
  const take = MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-take).join(".");
}
