/**
 * An in-memory Stripe for the paid-unlock tests: the subset of the REST
 * API that the runtime core and `hatchkit stripe sync` call, form-encoded
 * the way Stripe takes it. Nothing reaches the network.
 */

type Json = Record<string, unknown>;

/** Inverse of the core's encodeForm: `a[b][0][c]=v` → nested objects/arrays. */
export function decodeForm(text: string): Json {
  const root: Json = {};
  for (const [name, value] of new URLSearchParams(text)) {
    const parts = name.replace(/\]/g, "").split("[");
    let node: Json = root;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        node[part] = value;
        return;
      }
      const nextIsIndex = /^\d+$/.test(parts[i + 1]);
      node[part] ??= nextIsIndex ? [] : {};
      node = node[part] as Json;
    });
  }
  return root;
}

export interface FakeSession {
  id: string;
  object: "checkout.session";
  status: "open" | "complete" | "expired";
  mode: "payment" | "subscription";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  created: number;
  url: string;
  metadata: Record<string, string>;
  customer: string | null;
  customer_details: { email: string | null } | null;
  payment_intent: string | null;
  subscription: string | null;
  params: Json;
}

export interface FakeCall {
  method: string;
  path: string;
  params: Json;
  headers: Record<string, string>;
}

export function fakeStripe(options: { now?: () => number } = {}) {
  const now = options.now ?? (() => Date.now());
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${(++seq).toString().padStart(6, "0")}`;
  const sessions = new Map<string, FakeSession>();
  const paymentIntents = new Map<
    string,
    { id: string; metadata: Record<string, string>; latest_charge: string }
  >();
  const charges = new Map<string, { id: string; refunded: boolean; disputed: boolean }>();
  const subscriptions = new Map<
    string,
    { id: string; status: string; metadata: Record<string, string> }
  >();
  const products = new Map<string, Json>();
  const prices = new Map<string, Json>();
  const webhooks = new Map<string, Json>();
  const calls: FakeCall[] = [];

  function respond(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const missing = (what: string) =>
    respond(404, { error: { code: "resource_missing", message: `No such ${what}` } });

  function expandedSession(session: FakeSession): Json {
    const pi = session.payment_intent ? paymentIntents.get(session.payment_intent) : undefined;
    const sub = session.subscription ? subscriptions.get(session.subscription) : undefined;
    const { params: _params, ...rest } = session;
    return {
      ...rest,
      payment_intent: pi ? { ...pi, latest_charge: charges.get(pi.latest_charge) ?? null } : null,
      subscription: sub ?? null,
    };
  }

  async function handle(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== "https://api.stripe.com")
      throw new Error(`fake-stripe: unexpected ${url.href}`);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const params =
      method === "POST" ? decodeForm(String(init.body ?? "")) : decodeForm(url.search.slice(1));
    const path = url.pathname;
    calls.push({ method, path, params, headers });
    if (!headers.authorization?.startsWith("Bearer "))
      return respond(401, { error: { message: "no key" } });

    // ── Checkout ──────────────────────────────────────────────────────
    if (method === "POST" && path === "/v1/checkout/sessions") {
      const sid = `cs_test_${(++seq).toString().padStart(8, "0")}`;
      const session: FakeSession = {
        id: sid,
        object: "checkout.session",
        status: "open",
        mode: params.mode as "payment" | "subscription",
        payment_status: "unpaid",
        created: Math.floor(now() / 1000),
        url: `https://checkout.stripe.com/c/pay/${sid}`,
        metadata: (params.metadata as Record<string, string>) ?? {},
        customer: null,
        customer_details: null,
        payment_intent: null,
        subscription: null,
        params,
      };
      sessions.set(sid, session);
      return respond(200, expandedSession(session));
    }
    if (method === "GET" && path === "/v1/checkout/sessions") {
      const email = (params.customer_details as Json | undefined)?.email;
      const list = [...sessions.values()]
        .filter(
          (s) =>
            s.customer_details?.email === email && (!params.status || s.status === params.status),
        )
        .reverse()
        .map((s) => expandedSession(s));
      return respond(200, { data: list, has_more: false });
    }
    const sessionMatch = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (method === "GET" && sessionMatch) {
      const session = sessions.get(decodeURIComponent(sessionMatch[1]));
      return session ? respond(200, expandedSession(session)) : missing("checkout session");
    }
    const piMatch = path.match(/^\/v1\/payment_intents\/([^/]+)$/);
    if (method === "POST" && piMatch) {
      const pi = paymentIntents.get(piMatch[1]);
      if (!pi) return missing("payment intent");
      Object.assign(pi.metadata, params.metadata as Json);
      return respond(200, pi);
    }
    const subMatch = path.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (method === "POST" && subMatch) {
      const sub = subscriptions.get(subMatch[1]);
      if (!sub) return missing("subscription");
      Object.assign(sub.metadata, params.metadata as Json);
      return respond(200, sub);
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions") {
      return respond(200, { url: `https://billing.stripe.com/p/session/${params.customer}` });
    }

    // ── Products ──────────────────────────────────────────────────────
    if (method === "POST" && path === "/v1/products") {
      const pid = String(params.id ?? id("prod"));
      if (products.has(pid))
        return respond(400, { error: { code: "resource_already_exists", message: "exists" } });
      const product = {
        id: pid,
        active: params.active !== "false",
        metadata: {},
        ...params,
        object: "product",
      };
      product.active = params.active !== "false";
      products.set(pid, product);
      return respond(200, product);
    }
    if (method === "GET" && path === "/v1/products") {
      const list = [...products.values()].filter(
        (p) => params.active === undefined || String(p.active) === params.active,
      );
      return respond(200, { data: list, has_more: false });
    }
    const productMatch = path.match(/^\/v1\/products\/([^/]+)$/);
    if (productMatch) {
      const product = products.get(productMatch[1]);
      if (!product) return missing("product");
      if (method === "POST") {
        Object.assign(product, params);
        if (params.active !== undefined) product.active = params.active !== "false";
      }
      return respond(200, product);
    }

    // ── Prices ────────────────────────────────────────────────────────
    if (method === "GET" && path === "/v1/prices") {
      const keys = (params.lookup_keys as string[] | undefined) ?? [];
      const list = [...prices.values()].filter(
        (p) =>
          keys.includes(String(p.lookup_key)) &&
          (params.active === undefined || String(p.active) === params.active),
      );
      return respond(200, { data: list.slice(0, Number(params.limit ?? 10)), has_more: false });
    }
    if (method === "POST" && path === "/v1/prices") {
      if (params.lookup_key && params.transfer_lookup_key === "true")
        for (const p of prices.values())
          if (p.lookup_key === params.lookup_key) p.lookup_key = null;
      const custom = params.custom_unit_amount as Json | undefined;
      const price: Json = {
        id: id("price"),
        object: "price",
        active: true,
        currency: params.currency,
        product: params.product,
        lookup_key: params.lookup_key ?? null,
        tax_behavior: params.tax_behavior ?? "unspecified",
        unit_amount: params.unit_amount !== undefined ? Number(params.unit_amount) : null,
        custom_unit_amount: custom
          ? {
              minimum: custom.minimum !== undefined ? Number(custom.minimum) : null,
              preset: custom.preset !== undefined ? Number(custom.preset) : null,
              maximum: custom.maximum !== undefined ? Number(custom.maximum) : null,
            }
          : null,
        recurring: params.recurring ? { interval: (params.recurring as Json).interval } : null,
        metadata: params.metadata ?? {},
      };
      prices.set(String(price.id), price);
      return respond(200, price);
    }
    const priceMatch = path.match(/^\/v1\/prices\/([^/]+)$/);
    if (method === "POST" && priceMatch) {
      const price = prices.get(priceMatch[1]);
      if (!price) return missing("price");
      if (params.active !== undefined) price.active = params.active !== "false";
      return respond(200, price);
    }

    // ── Webhook endpoints ─────────────────────────────────────────────
    if (method === "GET" && path === "/v1/webhook_endpoints") {
      return respond(200, {
        data: [...webhooks.values()].map(({ secret: _secret, ...rest }) => rest),
        has_more: false,
      });
    }
    if (method === "POST" && path === "/v1/webhook_endpoints") {
      const endpoint = {
        id: id("we"),
        object: "webhook_endpoint",
        url: params.url,
        enabled_events: params.enabled_events,
        status: "enabled",
        api_version: params.api_version,
        metadata: params.metadata ?? {},
        secret: `whsec_${id("secret")}`,
      };
      webhooks.set(endpoint.id, endpoint);
      return respond(200, endpoint);
    }
    const webhookMatch = path.match(/^\/v1\/webhook_endpoints\/([^/]+)$/);
    if (webhookMatch) {
      const endpoint = webhooks.get(webhookMatch[1]);
      if (!endpoint) return missing("webhook endpoint");
      if (method === "DELETE") {
        webhooks.delete(webhookMatch[1]);
        return respond(200, { id: endpoint.id, deleted: true });
      }
      if (method === "POST") {
        if (params.enabled_events) endpoint.enabled_events = params.enabled_events;
        if (params.disabled === "false") endpoint.status = "enabled";
      }
      const { secret: _secret, ...rest } = endpoint;
      return respond(200, rest);
    }

    return respond(404, { error: { message: `fake-stripe: no route ${method} ${path}` } });
  }

  return {
    fetch: handle as typeof fetch,
    calls,
    sessions,
    products,
    prices,
    webhooks,
    paymentIntents,
    subscriptions,
    /** The buyer paid (or, with `async`, finished an async method that
     *  has not cleared yet). */
    complete(sessionId: string, options: { email?: string; async?: boolean } = {}): FakeSession {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`no session ${sessionId}`);
      session.status = "complete";
      session.customer_details = { email: options.email ?? "buyer@example.com" };
      session.customer = id("cus");
      if (session.mode === "subscription") {
        const sub = { id: id("sub"), status: "active", metadata: { ...session.metadata } };
        subscriptions.set(sub.id, sub);
        session.subscription = sub.id;
        session.payment_status = "paid";
      } else {
        const charge = { id: id("ch"), refunded: false, disputed: false };
        charges.set(charge.id, charge);
        const pi = { id: id("pi"), metadata: { ...session.metadata }, latest_charge: charge.id };
        paymentIntents.set(pi.id, pi);
        session.payment_intent = pi.id;
        session.payment_status = options.async ? "unpaid" : "paid";
      }
      return session;
    },
    clear(sessionId: string): void {
      const session = sessions.get(sessionId);
      if (session) session.payment_status = "paid";
    },
    refund(sessionId: string): void {
      const pi = paymentIntents.get(String(sessions.get(sessionId)?.payment_intent));
      const charge = pi ? charges.get(pi.latest_charge) : undefined;
      if (charge) charge.refunded = true;
    },
    dispute(sessionId: string): void {
      const pi = paymentIntents.get(String(sessions.get(sessionId)?.payment_intent));
      const charge = pi ? charges.get(pi.latest_charge) : undefined;
      if (charge) charge.disputed = true;
    },
    endSubscription(sessionId: string): void {
      const sub = subscriptions.get(String(sessions.get(sessionId)?.subscription));
      if (sub) sub.status = "canceled";
    },
    /** Seed a price as if created earlier. */
    seedPrice(price: Json): void {
      prices.set(String(price.id), price);
    },
  };
}

export type FakeStripe = ReturnType<typeof fakeStripe>;
