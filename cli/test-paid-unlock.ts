/**
 * Paid unlock runtime: the shared core (cli/src/paid-unlock/core.ts), the
 * Worker entry and the Express adapter, each as `hatchkit add …
 * paid-unlock` writes them into a project. Stripe and Listmonk are
 * in-memory fakes; nothing reaches the network.
 *
 * Pinned here:
 *
 *   1. Checkout sends only allowlisted products, with the metadata that
 *      tags the purchase, the refund line and (when on) Stripe Tax.
 *   2. The return URL unlocks only a paid, complete, own-project session,
 *      and only for 24 h; the cookie opens the product and nothing else.
 *   3. Refunds, disputes and ended subscriptions end access: email links
 *      at once, cookies at the daily re-check. A Stripe outage during a
 *      re-check keeps a paying buyer in.
 *   4. The webhook mails once per purchase (Stripe retries do not mail
 *      twice), waits for async payments, and answers 500 on a failed send
 *      so Stripe retries.
 *   5. Restore mails links only for live purchases of this project, and
 *      answers the same whether or not the address bought anything.
 *   6. Page paths cannot leave the product's folder.
 *   7. The Worker and the Express adapter map their bindings onto the
 *      core: secrets missing → 503 on unlock paths only, Set-Cookie
 *      survives, the webhook's raw body reaches the signature check.
 *
 * Run: `pnpm --filter hatchkit run test:paid-unlock`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPaidUnlock } from "./src/features/paid-unlock/index.ts";
import {
  COOKIE_RECHECK_MS,
  type Mailer,
  type UnlockConfig,
  type UnlockDeps,
  _clearPriceCache,
  handleUnlockRequest,
  listmonkMailer,
  openToken,
  signToken,
  stripeLookupKey,
  stripeProductId,
  stripeSignatureHeader,
  unlockConfigProblems,
  verifyStripeSignature,
} from "./src/paid-unlock/core.ts";
import { type FakeStripe, fakeStripe } from "./test-support/fake-stripe.ts";

const results: Record<string, boolean> = {};
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results[name] = true;
  } catch (err) {
    results[name] = false;
    console.log(`\n  x ${name}\n    ${(err as Error).stack}\n`);
  }
}

const SITE = "https://shop.example.com";
const TOKEN_SECRET = "token-secret-for-tests";
const WEBHOOK_SECRET = "whsec_test_secret";

const CONFIG: UnlockConfig = {
  project: "example",
  currency: "eur",
  refundPolicy: "Not happy? Write to hello@example.com within 30 days for a full refund.",
  products: {
    guide: {
      name: "Field guide",
      kind: "download",
      price: 900,
      files: [
        { object: "paid/guide.pdf", filename: "Field guide.pdf" },
        { object: "paid/missing.zip" },
      ],
    },
    "making-of": { name: "Making of", kind: "page", price: { min: 300, preset: 800 } },
    letters: {
      name: "Five letters",
      kind: "email",
      price: 500,
      email: "letters.html",
      subject: "Your five letters",
    },
    supporter: { name: "Supporter", kind: "page", price: 500, interval: "month" },
    retired: { name: "Retired", kind: "page", price: 100, active: false },
  },
};

interface Harness {
  stripe: FakeStripe;
  deps: UnlockDeps;
  mail: Array<{ to: string; subject: string; html: string }>;
  clock: { now: number };
  logs: Array<Record<string, unknown>>;
  failMail: { on: boolean };
}

function harness(config: UnlockConfig = CONFIG): Harness {
  _clearPriceCache();
  const clock = { now: Date.UTC(2026, 10, 7, 12) };
  const stripe = fakeStripe({ now: () => clock.now });
  const mail: Harness["mail"] = [];
  const failMail = { on: false };
  const logs: Array<Record<string, unknown>> = [];
  const mailer: Mailer = {
    async send(message) {
      if (failMail.on) throw new Error("smtp down");
      mail.push(message);
    },
  };
  const assets = new Map<string, string>([
    ["paid/making-of/index.html", "<h1>Making of</h1>"],
    ["paid/making-of/notes.html", "<h1>Notes</h1>"],
    ["paid/supporter/index.html", "<h1>Supporters</h1>"],
    ["emails/letters.html", "<p>Letter one.</p>"],
  ]);
  const files = new Map<string, Uint8Array>([
    ["paid/guide.pdf", new TextEncoder().encode("%PDF guide")],
  ]);
  for (const [key, product] of Object.entries(config.products)) {
    stripe.seedPrice({
      id: `price_${key}`,
      active: true,
      currency: config.currency,
      product: stripeProductId(config.project, key),
      lookup_key: stripeLookupKey(config.project, key),
      unit_amount: typeof product.price === "number" ? product.price : null,
    });
  }
  const deps: UnlockDeps = {
    config,
    siteUrl: SITE,
    stripeSecretKey: "rk_test_runtime",
    webhookSecret: WEBHOOK_SECRET,
    tokenSecret: TOKEN_SECRET,
    fetch: stripe.fetch,
    now: () => clock.now,
    mailer,
    log: (entry) => logs.push(entry),
    assets: {
      async get(path) {
        const body = assets.get(path);
        return body === undefined ? null : { body, contentType: "text/html; charset=utf-8" };
      },
    },
    files: {
      async get(object) {
        const body = files.get(object);
        return body ? { body, size: body.length, contentType: "application/pdf" } : null;
      },
    },
  };
  return { stripe, deps, mail, clock, logs, failMail };
}

function form(
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

function get(path: string, cookie?: string): Request {
  return new Request(`${SITE}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
}

async function call(h: Harness, request: Request): Promise<Response> {
  const res = await handleUnlockRequest(request, h.deps, { clientIp: "203.0.113.7" });
  assert.ok(res, `no response for ${request.url}`);
  return res;
}

function cookieOf(res: Response): string {
  const set = res.headers.getSetCookie()[0];
  assert.ok(set, "expected Set-Cookie");
  return set.split(";")[0];
}

/** Checkout → paid → return: the buyer's cookie. */
async function buy(
  h: Harness,
  key: string,
  email = "buyer@example.com",
): Promise<{ cookie: string; session: string }> {
  const res = await call(h, form("/api/unlock/checkout", { product: key }));
  assert.equal(res.status, 303);
  const session = String(res.headers.get("Location")).split("/").pop() as string;
  h.stripe.complete(session, { email });
  const back = await call(h, get(`/api/unlock/return?session_id=${session}`));
  assert.equal(back.status, 303, await back.clone().text());
  return { cookie: cookieOf(back), session };
}

async function webhook(
  h: Harness,
  type: string,
  session: string,
  metadata = { hatchkit_project: "example" },
) {
  const stored = h.stripe.sessions.get(session);
  const payload = JSON.stringify({
    type,
    data: { object: { id: session, payment_status: stored?.payment_status ?? "paid", metadata } },
  });
  return call(
    h,
    new Request(`${SITE}/api/unlock/webhook`, {
      method: "POST",
      headers: {
        "Stripe-Signature": await stripeSignatureHeader(payload, WEBHOOK_SECRET, h.clock.now),
      },
      body: payload,
    }),
  );
}

function linkIn(html: string, path: string): string {
  const match = html.match(new RegExp(`href="(${SITE.replace(/\./g, "\\.")}${path}[^"]*)"`));
  assert.ok(match, `no ${path} link in: ${html}`);
  return match[1].replace(SITE, "").replace(/&amp;/g, "&");
}

// ── 1. Checkout ─────────────────────────────────────────────────────────

await test("checkout tags the session and refuses what is not for sale", async () => {
  const h = harness({ ...CONFIG, automaticTax: true });
  const res = await call(
    h,
    form("/api/unlock/checkout", { product: "guide" }, { Referer: `${SITE}/shop` }),
  );
  assert.equal(res.status, 303);
  assert.match(String(res.headers.get("Location")), /^https:\/\/checkout\.stripe\.com\//);
  const created = h.stripe.calls.find(
    (c) => c.method === "POST" && c.path === "/v1/checkout/sessions",
  );
  assert.ok(created);
  const p = created.params as Record<string, any>;
  assert.equal(p.mode, "payment");
  assert.equal(p.line_items[0].price, "price_guide");
  assert.deepEqual(p.metadata, { hatchkit_project: "example", hatchkit_unlock: "guide" });
  assert.deepEqual(p.payment_intent_data.metadata, p.metadata);
  assert.equal(p.success_url, `${SITE}/api/unlock/return?session_id={CHECKOUT_SESSION_ID}`);
  assert.equal(p.cancel_url, `${SITE}/shop`);
  assert.equal(p.automatic_tax.enabled, "true");
  assert.equal(p.custom_text.submit.message, CONFIG.refundPolicy);
  assert.equal(created.headers["stripe-version"], "2025-03-31.basil");

  const foreign = await call(
    h,
    form("/api/unlock/checkout", { product: "guide" }, { Referer: "https://evil.example/x" }),
  );
  assert.equal(foreign.status, 303);
  const last = h.stripe.calls.filter((c) => c.path === "/v1/checkout/sessions").pop();
  assert.equal((last?.params as Record<string, string>).cancel_url, `${SITE}/`);

  for (const product of ["retired", "nope", "../x", ""]) {
    const refused = await call(h, form("/api/unlock/checkout", { product }));
    assert.equal(refused.status, 404, product);
  }
});

await test("subscriptions check out in subscription mode; tax is off unless asked", async () => {
  const h = harness();
  await call(h, form("/api/unlock/checkout", { product: "supporter" }));
  const p = h.stripe.calls.find((c) => c.path === "/v1/checkout/sessions")?.params as Record<
    string,
    any
  >;
  assert.equal(p.mode, "subscription");
  assert.deepEqual(p.subscription_data.metadata, {
    hatchkit_project: "example",
    hatchkit_unlock: "supporter",
  });
  assert.equal(p.payment_intent_data, undefined);
  assert.equal(p.automatic_tax, undefined);
});

await test("a product without a synced price answers 503", async () => {
  const h = harness();
  h.stripe.prices.clear();
  const res = await call(h, form("/api/unlock/checkout", { product: "guide" }));
  assert.equal(res.status, 503);
});

// ── 2. Return and pages ─────────────────────────────────────────────────

await test("return unlocks a paid session for its product only", async () => {
  const h = harness();
  const { cookie } = await buy(h, "making-of");
  const page = await call(h, get("/paid/making-of/", cookie));
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<h1>Making of</h1>");
  assert.equal(page.headers.get("Cache-Control"), "private, no-store");
  assert.equal((await call(h, get("/paid/making-of/notes", cookie))).status, 200);
  assert.equal((await call(h, get("/paid/making-of", cookie))).status, 308);
  const other = await call(
    h,
    get("/paid/supporter/", cookie.replace("hk_unlock_making-of", "hk_unlock_supporter")),
  );
  assert.equal(other.status, 402, "a cookie for one product opens no other");
  const locked = await call(h, get("/paid/making-of/"));
  assert.equal(locked.status, 402);
  const html = await locked.text();
  assert.match(html, /action="\/api\/unlock\/checkout"/);
  assert.match(html, /Pay what you want \(from €3\.00\)/);
});

await test("the return cookie is HttpOnly, Secure and SameSite=Lax", async () => {
  const h = harness();
  const res = await call(h, form("/api/unlock/checkout", { product: "making-of" }));
  const session = String(res.headers.get("Location")).split("/").pop() as string;
  h.stripe.complete(session);
  const back = await call(h, get(`/api/unlock/return?session_id=${session}`));
  const set = back.headers.getSetCookie()[0];
  assert.match(set, /^hk_unlock_making-of=/);
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"])
    assert.ok(set.includes(flag), flag);
  assert.equal(back.headers.get("Location"), "/paid/making-of/");
  assert.equal(back.headers.get("Referrer-Policy"), "no-referrer");
});

await test("return refuses open, foreign, pending and old sessions", async () => {
  const h = harness();
  const res = await call(h, form("/api/unlock/checkout", { product: "guide" }));
  const session = String(res.headers.get("Location")).split("/").pop() as string;
  assert.equal(
    (await call(h, get(`/api/unlock/return?session_id=${session}`))).status,
    403,
    "open",
  );
  h.stripe.complete(session, { async: true });
  const pending = await call(h, get(`/api/unlock/return?session_id=${session}`));
  assert.equal(pending.status, 200);
  assert.match(await pending.text(), /processing/);
  assert.equal(pending.headers.getSetCookie().length, 0);
  h.stripe.clear(session);
  h.clock.now += 25 * 60 * 60 * 1000;
  assert.equal(
    (await call(h, get(`/api/unlock/return?session_id=${session}`))).status,
    410,
    "older than 24 h",
  );
  assert.equal((await call(h, get("/api/unlock/return?session_id=nope"))).status, 400);
  assert.equal((await call(h, get("/api/unlock/return?session_id=cs_test_missing"))).status, 403);

  const other = harness({ ...CONFIG, project: "other-project" });
  const { stripe } = other;
  const r = await call(other, form("/api/unlock/checkout", { product: "guide" }));
  const foreignSession = String(r.headers.get("Location")).split("/").pop() as string;
  stripe.complete(foreignSession);
  h.stripe.sessions.set(foreignSession, stripe.sessions.get(foreignSession) as never);
  assert.equal(
    (await call(h, get(`/api/unlock/return?session_id=${foreignSession}`))).status,
    403,
    "foreign",
  );
});

await test("page paths cannot leave the product folder; forged cookies fail", async () => {
  const h = harness();
  const { cookie } = await buy(h, "making-of");
  for (const path of [
    "/paid/making-of/%2e%2e%2fsupporter/",
    "/paid/making-of/a%2F..%2F..%2Femails/letters.html",
    "/paid/making-of/%00",
  ]) {
    const res = await call(h, get(path, cookie));
    assert.ok(res.status === 404 || res.status === 402, `${path} → ${res.status}`);
    assert.doesNotMatch(await res.text(), /Supporters|Letter one/);
  }
  assert.equal((await call(h, get("/paid/emails/letters.html", cookie))).status, 404);
  const forged = await signToken("wrong-secret", {
    p: "c",
    k: "making-of",
    s: "cs_test_x",
    c: h.clock.now,
  });
  assert.equal(
    (await call(h, get("/paid/making-of/", `hk_unlock_making-of=${forged}`))).status,
    402,
  );
  const [body] = cookie.split("=").slice(1).join("=").split(".");
  const tampered = `${body.slice(0, -2)}AA.${cookie.split(".").pop()}`;
  assert.equal(
    (await call(h, get("/paid/making-of/", `hk_unlock_making-of=${tampered}`))).status,
    402,
  );
});

// ── 3. Revocation ───────────────────────────────────────────────────────

await test("a refund ends cookie access at the daily re-check", async () => {
  const h = harness();
  const { cookie, session } = await buy(h, "making-of");
  h.stripe.refund(session);
  assert.equal(
    (await call(h, get("/paid/making-of/", cookie))).status,
    200,
    "within 24 h: no Stripe call",
  );
  h.clock.now += COOKIE_RECHECK_MS + 1;
  const after = await call(h, get("/paid/making-of/", cookie));
  assert.equal(after.status, 402);
  assert.match(after.headers.getSetCookie()[0] ?? "", /Max-Age=0/);
});

await test("the re-check renews a valid cookie and survives a Stripe outage", async () => {
  const h = harness();
  const { cookie } = await buy(h, "making-of");
  h.clock.now += COOKIE_RECHECK_MS + 1;
  const renewed = await call(h, get("/paid/making-of/", cookie));
  assert.equal(renewed.status, 200);
  const fresh = cookieOf(renewed);
  const token = await openToken(TOKEN_SECRET, fresh.split("=").slice(1).join("="));
  assert.equal(token?.p === "c" && token.c, h.clock.now);

  h.clock.now += COOKIE_RECHECK_MS + 1;
  h.deps.fetch = async () => {
    throw new Error("network down");
  };
  assert.equal((await call(h, get("/paid/making-of/", fresh))).status, 200);
});

await test("a dispute and an ended subscription end access", async () => {
  const h = harness();
  const bought = await buy(h, "guide");
  h.stripe.dispute(bought.session);
  h.clock.now += COOKIE_RECHECK_MS + 1;
  assert.equal((await call(h, get("/api/unlock/files/guide", bought.cookie))).status, 402);

  const sub = await buy(h, "supporter");
  assert.equal((await call(h, get("/paid/supporter/", sub.cookie))).status, 200);
  h.stripe.endSubscription(sub.session);
  h.clock.now += COOKIE_RECHECK_MS + 1;
  assert.equal((await call(h, get("/paid/supporter/", sub.cookie))).status, 402);
});

// ── 4. Webhook and email ────────────────────────────────────────────────

await test("the webhook mails once per purchase, with a link that unlocks on any device", async () => {
  const h = harness();
  const { session } = await buy(h, "making-of");
  const first = await webhook(h, "checkout.session.completed", session);
  assert.equal(first.status, 200);
  assert.equal(h.mail.length, 1);
  assert.equal(h.mail[0].to, "buyer@example.com");
  assert.equal(h.mail[0].subject, "Your purchase: Making of");
  assert.ok(h.mail[0].html.includes(CONFIG.refundPolicy as string));
  const pi = h.stripe.paymentIntents.get(String(h.stripe.sessions.get(session)?.payment_intent));
  assert.ok(pi?.metadata.hatchkit_mailed_at);

  const retry = await webhook(h, "checkout.session.completed", session);
  assert.deepEqual(await retry.json(), { received: true, outcome: "already" });
  assert.equal(h.mail.length, 1);

  const claim = await call(h, get(linkIn(h.mail[0].html, "/api/unlock/claim")));
  assert.equal(claim.status, 303);
  assert.equal(claim.headers.get("Location"), "/paid/making-of/");
  assert.equal((await call(h, get("/paid/making-of/", cookieOf(claim)))).status, 200);

  h.stripe.refund(session);
  const after = await call(h, get(linkIn(h.mail[0].html, "/api/unlock/claim")));
  assert.equal(after.status, 410, "an email link checks Stripe on every use");
});

await test("the webhook checks its signature and ignores other projects", async () => {
  const h = harness();
  const { session } = await buy(h, "making-of");
  const payload = JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { id: session } },
  });
  const bad = await call(
    h,
    new Request(`${SITE}/api/unlock/webhook`, {
      method: "POST",
      headers: {
        "Stripe-Signature": await stripeSignatureHeader(payload, "whsec_other", h.clock.now),
      },
      body: payload,
    }),
  );
  assert.equal(bad.status, 400);
  const stale = await stripeSignatureHeader(payload, WEBHOOK_SECRET, h.clock.now - 10 * 60 * 1000);
  assert.equal(await verifyStripeSignature(payload, stale, WEBHOOK_SECRET, h.clock.now), false);
  await webhook(h, "checkout.session.completed", session, { hatchkit_project: "someone-else" });
  await webhook(h, "customer.subscription.updated", session);
  assert.equal(h.mail.length, 0);
});

await test("async payments mail when they clear; a failed send answers 500 and retries", async () => {
  const h = harness();
  const res = await call(h, form("/api/unlock/checkout", { product: "guide" }));
  const session = String(res.headers.get("Location")).split("/").pop() as string;
  h.stripe.complete(session, { async: true });
  await webhook(h, "checkout.session.completed", session);
  assert.equal(h.mail.length, 0, "not paid yet");
  h.stripe.clear(session);
  h.failMail.on = true;
  const failed = await webhook(h, "checkout.session.async_payment_succeeded", session);
  assert.equal(failed.status, 500);
  const pi = h.stripe.paymentIntents.get(String(h.stripe.sessions.get(session)?.payment_intent));
  assert.equal(pi?.metadata.hatchkit_mailed_at, undefined);
  h.failMail.on = false;
  assert.equal((await webhook(h, "checkout.session.async_payment_succeeded", session)).status, 200);
  assert.equal(h.mail.length, 1);
  assert.match(h.mail[0].html, /Open Field guide/);
});

await test("an email product mails its body; a subscription mail links the portal", async () => {
  const h = harness();
  const letters = await buy(h, "letters");
  await webhook(h, "checkout.session.completed", letters.session);
  assert.equal(h.mail[0].subject, "Your five letters");
  assert.match(h.mail[0].html, /<p>Letter one\.<\/p>/);
  const sent = await call(h, get("/api/unlock/sent/letters", letters.cookie));
  assert.equal(sent.status, 200);

  const sub = await buy(h, "supporter", "fan@example.com");
  await webhook(h, "checkout.session.completed", sub.session);
  const subscription = h.stripe.subscriptions.get(
    String(h.stripe.sessions.get(sub.session)?.subscription),
  );
  assert.ok(subscription?.metadata.hatchkit_mailed_at, "the marker sits on the subscription");
  const manageLink = linkIn(h.mail[1].html, "/api/unlock/claim");
  assert.match(h.mail[1].html, /next=manage/);
  const portal = await call(h, get(`${manageLink.replace(/&next=manage$/, "")}&next=manage`));
  assert.match(String(portal.headers.get("Location")), /^https:\/\/billing\.stripe\.com\//);
  const manage = await call(
    h,
    form("/api/unlock/manage", { product: "supporter" }, { Cookie: sub.cookie }),
  );
  assert.equal(manage.status, 303);
  assert.match(String(manage.headers.get("Location")), /^https:\/\/billing\.stripe\.com\//);
  assert.equal((await call(h, form("/api/unlock/manage", { product: "supporter" }))).status, 402);
});

// ── 5. Downloads, status, restore ───────────────────────────────────────

await test("downloads stream to buyers, by cookie or by the email link", async () => {
  const h = harness();
  const { cookie, session } = await buy(h, "guide");
  const list = await call(h, get("/api/unlock/files/guide", cookie));
  assert.match(await list.text(), /href="\/api\/unlock\/download\/guide\/0">Field guide\.pdf/);
  const file = await call(h, get("/api/unlock/download/guide/0", cookie));
  assert.equal(file.status, 200);
  assert.equal(await file.text(), "%PDF guide");
  assert.match(String(file.headers.get("Content-Disposition")), /filename="Field guide\.pdf"/);
  assert.equal(
    (await call(h, get("/api/unlock/download/guide/1", cookie))).status,
    404,
    "object missing",
  );
  assert.equal((await call(h, get("/api/unlock/download/guide/9", cookie))).status, 404);
  assert.equal((await call(h, get("/api/unlock/download/guide/0"))).status, 402);
  const link = await signToken(TOKEN_SECRET, { p: "l", k: "guide", s: session });
  const viaLink = await call(h, get(`/api/unlock/download/guide/0?t=${link}`));
  assert.equal(viaLink.status, 200);
  assert.ok(viaLink.headers.getSetCookie()[0]?.startsWith("hk_unlock_guide="));
  const wrongKey = await signToken(TOKEN_SECRET, { p: "l", k: "letters", s: session });
  assert.equal((await call(h, get(`/api/unlock/download/guide/0?t=${wrongKey}`))).status, 402);
});

await test("status reports the cookie without a Stripe call", async () => {
  const h = harness();
  const { cookie } = await buy(h, "making-of");
  const before = h.stripe.calls.length;
  assert.deepEqual(await (await call(h, get("/api/unlock/status/making-of", cookie))).json(), {
    unlocked: true,
  });
  assert.deepEqual(await (await call(h, get("/api/unlock/status/making-of"))).json(), {
    unlocked: false,
  });
  assert.equal(h.stripe.calls.length, before);
  assert.equal((await call(h, get("/api/unlock/status/nope"))).status, 404);
});

await test("restore mails live purchases of this project only, and says the same either way", async () => {
  const h = harness();
  await buy(h, "making-of", "fan@example.com");
  const refunded = await buy(h, "guide", "fan@example.com");
  h.stripe.refund(refunded.session);
  const res = await call(h, form("/api/unlock/restore", { email: "fan@example.com" }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "/api/unlock/restore?sent=1");
  assert.equal(h.mail.length, 1);
  assert.match(h.mail[0].html, /Making of/);
  assert.doesNotMatch(h.mail[0].html, /Field guide/);
  const none = await call(h, form("/api/unlock/restore", { email: "nobody@example.com" }));
  assert.equal(none.headers.get("Location"), "/api/unlock/restore?sent=1");
  assert.equal(h.mail.length, 1);
  assert.equal(
    (await call(h, form("/api/unlock/restore", { email: "not-an-address" }))).status,
    400,
  );
  assert.match(await (await call(h, get("/api/unlock/restore"))).text(), /type="email"/);
});

await test("restore is rate-limited per client and per address", async () => {
  const h = harness();
  const seen: string[] = [];
  h.deps.limit = async (key) => {
    seen.push(key);
    return !key.startsWith("restore-email:");
  };
  const res = await call(h, form("/api/unlock/restore", { email: "Fan@Example.com" }));
  assert.equal(res.status, 429);
  assert.deepEqual(seen, ["restore-ip:203.0.113.7", "restore-email:fan@example.com"]);
});

await test("paths outside the unlock routes are not answered", async () => {
  const h = harness();
  assert.equal(await handleUnlockRequest(get("/about"), h.deps), null);
  assert.equal(await handleUnlockRequest(get("/paidx"), h.deps), null);
  assert.equal((await call(h, get("/api/unlock/whatever"))).status, 404);
  assert.equal(
    (await call(h, new Request(`${SITE}/api/unlock/checkout`, { method: "PUT" }))).status,
    405,
  );
  assert.ok(
    h.logs.every((entry) => !JSON.stringify(entry).includes("@")),
    "logs carry no addresses",
  );
});

// ── 6. Config rules and mail transport ──────────────────────────────────

await test("unlocks.json rules", () => {
  assert.deepEqual(unlockConfigProblems(CONFIG), []);
  const problems = unlockConfigProblems({
    project: "Example",
    currency: "EUR",
    pagePrefix: "/api/unlock/pages",
    extra: 1,
    products: {
      "Bad Key": { name: "x", kind: "page", price: 100 },
      sub: { name: "Sub", kind: "page", price: { min: 100 }, interval: "month" },
      dl: { name: "Download", kind: "download", price: 100 },
      mail: { name: "Mail", kind: "email", price: 100, email: "../x.html" },
      page: { name: "Page", kind: "page", price: 0, files: [] },
    },
  }).join("\n");
  for (const fragment of [
    '"project"',
    '"currency"',
    '"pagePrefix" must not be inside',
    'unknown field "extra"',
    "products.Bad Key: the key",
    "no pay-what-you-want for subscriptions",
    "products.dl.files must list at least one file",
    "products.mail.email",
    "products.page.price must be at least 1",
    "products.page.files belongs only to a download product",
  ])
    assert.ok(problems.includes(fragment), `missing: ${fragment}\n${problems}`);
});

await test("Listmonk mail goes to the address without making a subscriber", async () => {
  const sent: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  const mailer = listmonkMailer({
    url: "https://listmonk.example.com/",
    user: "example",
    token: "tok",
    templateId: 7,
    from: "Example <noreply@mail.example.com>",
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get("Authorization"),
      });
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  await mailer.send({ to: "buyer@example.com", subject: "Hi", html: "<p>x</p>" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://listmonk.example.com/api/tx");
  assert.equal(sent[0].auth, "token example:tok");
  assert.equal(sent[0].body.subscriber_mode, "external");
  assert.deepEqual(sent[0].body.subscriber_emails, ["buyer@example.com"]);
  assert.equal(sent[0].body.template_id, 7);
});

// ── 7. The written Worker and Express adapter ───────────────────────────

const root = mkdtempSync(join(tmpdir(), "paid-unlock-runtime-"));

function manifest(dir: string, surfaces: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".hatchkit.json"),
    JSON.stringify({
      version: 5,
      cliVersion: "0.0.0",
      scaffoldedAt: "2026-11-07T00:00:00.000Z",
      name: "example",
      domain: "shop.example.com",
      features: [],
      mlServices: [],
      deployTarget: "existing",
      ports: { server: 5000, client: 3000 },
      surfaces,
    }),
  );
}

await test("the Worker maps R2, assets, the limiter and secrets onto the core", async () => {
  const dir = join(root, "static-site");
  manifest(dir, "static");
  const added = applyPaidUnlock({ projectDir: dir, runtime: "worker" });
  assert.ok(added.ok, added.errors.join("\n"));
  const worker = await import(join(dir, "workers", "unlock", "src", "index.ts"));
  worker._setConfigForTests(CONFIG);
  const h = harness();
  const originalFetch = globalThis.fetch;
  const listmonkBodies: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://listmonk.example.com")) {
      listmonkBodies.push(JSON.parse(String(init?.body)));
      return new Response("{}");
    }
    return h.stripe.fetch(input, init);
  }) as typeof fetch;
  try {
    const assetsSeen: string[] = [];
    const env = {
      SITE_URL: SITE,
      STRIPE_SECRET_KEY: "rk_test_runtime",
      UNLOCK_WEBHOOK_SECRET: WEBHOOK_SECRET,
      UNLOCK_TOKEN_SECRET: TOKEN_SECRET,
      LISTMONK_URL: "https://listmonk.example.com",
      LISTMONK_API_USER: "example",
      LISTMONK_API_TOKEN: "tok",
      LISTMONK_TX_TEMPLATE_ID: "3",
      ASSETS: {
        async fetch(request: Request) {
          const path = new URL(request.url).pathname;
          assetsSeen.push(path);
          return path === "/paid/making-of/index.html"
            ? new Response("<h1>Worker page</h1>", { headers: { "Content-Type": "text/html" } })
            : new Response("missing", { status: 404 });
        },
      },
      FILES: {
        async get(key: string) {
          return key === "paid/guide.pdf"
            ? {
                body: new Response("r2 bytes").body,
                size: 8,
                httpMetadata: { contentType: "application/pdf" },
              }
            : null;
        },
      },
      RESTORE_LIMITER: {
        async limit() {
          return { success: false };
        },
      },
    };
    const run = (request: Request) => worker.default.fetch(request, env) as Promise<Response>;
    const res = await run(form("/api/unlock/checkout", { product: "making-of" }));
    const session = String(res.headers.get("Location")).split("/").pop() as string;
    h.stripe.complete(session);
    const back = await run(get(`/api/unlock/return?session_id=${session}`));
    const cookie = cookieOf(back);
    const page = await run(get("/paid/making-of/", cookie));
    assert.equal(await page.text(), "<h1>Worker page</h1>");
    assert.deepEqual(assetsSeen, ["/paid/making-of/index.html"]);

    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: {
        object: { id: session, payment_status: "paid", metadata: { hatchkit_project: "example" } },
      },
    });
    const hook = await run(
      new Request(`${SITE}/api/unlock/webhook`, {
        method: "POST",
        headers: {
          "Stripe-Signature": await stripeSignatureHeader(payload, WEBHOOK_SECRET, Date.now()),
        },
        body: payload,
      }),
    );
    assert.equal(hook.status, 200);
    assert.equal((listmonkBodies[0] as Record<string, unknown>).subscriber_mode, "external");

    const guide = await run(form("/api/unlock/checkout", { product: "guide" }));
    const guideSession = String(guide.headers.get("Location")).split("/").pop() as string;
    h.stripe.complete(guideSession);
    const guideCookie = cookieOf(await run(get(`/api/unlock/return?session_id=${guideSession}`)));
    assert.equal(
      await (await run(get("/api/unlock/download/guide/0", guideCookie))).text(),
      "r2 bytes",
    );

    const limited = await run(form("/api/unlock/restore", { email: "fan@example.com" }));
    assert.equal(limited.status, 429);
    assert.equal((await run(get("/elsewhere"))).status, 404);
    const unconfigured = await worker.default.fetch(get("/api/unlock/restore"), {
      ...env,
      UNLOCK_TOKEN_SECRET: "",
    });
    assert.equal(unconfigured.status, 503);
  } finally {
    globalThis.fetch = originalFetch;
    worker._setConfigForTests(null);
  }
});

await test("the Express adapter passes other paths on and keeps Set-Cookie and the raw body", async () => {
  const dir = join(root, "fullstack");
  manifest(dir, "fullstack");
  const server = join(dir, "packages", "server");
  mkdirSync(join(server, "src"), { recursive: true });
  writeFileSync(join(server, "src", "index.ts"), "export {};\n");
  writeFileSync(join(server, "package.json"), '{ "name": "@starter/server", "type": "module" }\n');
  const added = applyPaidUnlock({ projectDir: dir });
  assert.equal(added.runtime, "server");
  const privateDir = join(server, "unlock-private");
  mkdirSync(join(privateDir, "paid", "making-of"), { recursive: true });
  writeFileSync(join(privateDir, "paid", "making-of", "index.html"), "<h1>Server page</h1>");
  mkdirSync(join(privateDir, "files", "paid"), { recursive: true });
  writeFileSync(join(privateDir, "files", "paid", "guide.pdf"), "local bytes");

  const adapter = await import(join(server, "src", "services", "unlock", "index.ts"));
  const h = harness();
  const mail: string[] = [];
  const env = {
    UNLOCK_SITE_URL: SITE,
    STRIPE_SECRET_KEY: "rk_test_runtime",
    UNLOCK_WEBHOOK_SECRET: WEBHOOK_SECRET,
    UNLOCK_TOKEN_SECRET: TOKEN_SECRET,
  };
  const handler = adapter.createUnlockHandler({
    env,
    config: CONFIG,
    privateDir,
    fetch: h.stripe.fetch,
    mailer: {
      async send(m: { to: string }) {
        mail.push(m.to);
      },
    },
    log: () => {},
  });
  const unconfigured = adapter.createUnlockHandler({
    env: { ...env, STRIPE_SECRET_KEY: "CHANGE_ME_STRIPE_SECRET_KEY" },
    config: CONFIG,
    privateDir,
  });
  const broken = adapter.createUnlockHandler({ env, config: { project: "x" }, privateDir });
  let active = handler;
  const http = createServer((req, res) =>
    active(req, res, (err?: unknown) => {
      res.statusCode = err ? 500 : 418;
      res.end("next");
    }),
  );
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const send = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { redirect: "manual", ...init });
  try {
    assert.equal((await send("/about")).status, 418, "other paths go to next()");
    const checkout = await send("/api/unlock/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "product=making-of",
    });
    assert.equal(checkout.status, 303);
    const session = String(checkout.headers.get("Location")).split("/").pop() as string;
    h.stripe.complete(session);
    const back = await send(`/api/unlock/return?session_id=${session}`);
    const cookie = back.headers.getSetCookie()[0].split(";")[0];
    const page = await send("/paid/making-of/", { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<h1>Server page</h1>");
    assert.match(String(page.headers.get("Content-Type")), /text\/html/);

    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: {
        object: { id: session, payment_status: "paid", metadata: { hatchkit_project: "example" } },
      },
    });
    const hook = await send("/api/unlock/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": await stripeSignatureHeader(payload, WEBHOOK_SECRET, Date.now()),
      },
      body: payload,
    });
    assert.equal(hook.status, 200, await hook.text());
    assert.deepEqual(mail, ["buyer@example.com"]);

    const guide = await send("/api/unlock/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "product=guide",
    });
    const guideSession = String(guide.headers.get("Location")).split("/").pop() as string;
    h.stripe.complete(guideSession);
    const guideCookie = (await send(`/api/unlock/return?session_id=${guideSession}`)).headers
      .getSetCookie()[0]
      .split(";")[0];
    const file = await send("/api/unlock/download/guide/0", { headers: { Cookie: guideCookie } });
    assert.equal(await file.text(), "local bytes");

    active = unconfigured;
    assert.equal((await send("/api/unlock/restore")).status, 503);
    assert.equal((await send("/about")).status, 418);
    active = broken;
    assert.equal(
      (await send("/api/unlock/restore")).status,
      503,
      "an invalid unlocks.json only disables unlocks",
    );
    assert.equal((await send("/about")).status, 418);
  } finally {
    await new Promise<void>((done) => http.close(() => done()));
  }
});

const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  `\npaid-unlock: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`,
);
if (failed.length) process.exit(1);
