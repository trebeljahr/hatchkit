/**
 * Newsletter double opt-in against a stubbed Listmonk.
 *
 * The subscribe form must not touch list membership. On a single-opt-in
 * list Listmonk sends campaigns to every member not `unsubscribed`,
 * `unconfirmed` included, so an early membership mails an address that
 * never confirmed. On a double-opt-in list, an `unconfirmed` membership
 * written without `preconfirm_subscriptions` makes Listmonk send its own
 * opt-in email next to ours. Only the confirm route may add the list,
 * and only as `confirmed`.
 *
 * These drive the real Express routes over HTTP. Every request to the
 * Listmonk host is answered by an in-memory fake, and the tests assert on
 * the writes it received.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, test } from "node:test";
import express from "express";

import { describeListTarget, findSubscriber, resolveListId } from "../services/newsletter/listmonk.js";
import { registerNewsletterRoutes } from "../services/newsletter/routes.js";
import { _resetRateLimit, mintConfirmToken } from "../services/newsletter/subscribe.js";

const LISTMONK = "https://listmonk.test";
const LIST_ID = 4;

process.env.LISTMONK_URL = LISTMONK;
process.env.LISTMONK_API_USER = "api-user";
process.env.LISTMONK_API_TOKEN = "api-token";
// NODE_ENV decides which one `resolveListId` reads. Point both at the
// same list so the assertions hold either way.
process.env.LISTMONK_LIVE_LIST_ID = String(LIST_ID);
process.env.LISTMONK_TEST_LIST_ID = String(LIST_ID);
process.env.LISTMONK_TX_TEMPLATE_ID = "5";
process.env.NEWSLETTER_TOKEN_SECRET = "test-secret";

type Membership = { id: number; subscription_status: "unconfirmed" | "confirmed" | "unsubscribed" };
type FakeSubscriber = { id: number; uuid: string; email: string; name: string; status: "enabled"; lists: Membership[] };
type Write = { call: string; body: any };

const realFetch = globalThis.fetch;

/** In-memory Listmonk: just the four endpoints the newsletter code uses. */
function fakeListmonk(seed: FakeSubscriber[] = []) {
  const subscribers = [...seed];
  const writes: Write[] = [];
  const searches: URLSearchParams[] = [];

  const json = (data: unknown): Response =>
    new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });

  const handle = (url: URL, init: RequestInit = {}): Response => {
    const call = `${init.method ?? "GET"} ${url.pathname}`;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    if (call !== "GET /api/subscribers") writes.push({ call, body });

    switch (call) {
      case "GET /api/subscribers": {
        searches.push(url.searchParams);
        // Listmonk v6: `name ~* $search OR email ~* $search`. A JS
        // RegExp with the `i` flag behaves the same for these patterns.
        const re = new RegExp(url.searchParams.get("search") ?? "", "i");
        const results = subscribers.filter((s) => re.test(s.name) || re.test(s.email));
        return json({ results, total: results.length });
      }
      case "POST /api/subscribers": {
        const sub: FakeSubscriber = {
          id: 100 + subscribers.length,
          uuid: `uuid-${subscribers.length}`,
          email: body.email,
          name: body.name,
          status: "enabled",
          lists: (body.lists as number[]).map((id) => ({
            id,
            subscription_status: body.preconfirm_subscriptions ? "confirmed" : "unconfirmed",
          })),
        };
        subscribers.push(sub);
        return json(sub);
      }
      case "PUT /api/subscribers/lists": {
        for (const sub of subscribers.filter((s) => body.ids.includes(s.id))) {
          for (const listId of body.target_list_ids as number[]) {
            sub.lists = sub.lists.filter((l) => l.id !== listId);
            sub.lists.push({ id: listId, subscription_status: body.status });
          }
        }
        return json(true);
      }
      case "POST /api/tx":
        return json(true);
      default:
        return new Response("not found", { status: 404 });
    }
  };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== LISTMONK) return realFetch(input, init);
    return handle(url, init);
  }) as typeof fetch;

  return {
    subscribers,
    searches,
    /** Every Listmonk request except the subscriber lookups. */
    writes,
    calls: () => writes.map((w) => w.call),
    membership: (email: string) =>
      subscribers.find((s) => s.email === email)?.lists.find((l) => l.id === LIST_ID)?.subscription_status,
  };
}

let server: ReturnType<ReturnType<typeof express>["listen"]>;
let base = "";

beforeEach(async () => {
  _resetRateLimit();
  const app = express();
  app.use(express.json());
  registerNewsletterRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.NEWSLETTER_SITE_URL = base;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function subscribe(email: string): Promise<Response> {
  return realFetch(`${base}/api/newsletter/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

function confirm(email: string): Promise<Response> {
  const token = encodeURIComponent(mintConfirmToken(email));
  return realFetch(`${base}/api/newsletter/confirm?token=${token}`, { redirect: "manual" });
}

function existing(email: string, lists: Membership[]): FakeSubscriber {
  return { id: 42, uuid: "uuid-42", email, name: email, status: "enabled", lists };
}

describe("POST /api/newsletter/subscribe", () => {
  test("creates a new address on no list, then sends the confirmation", async () => {
    const lm = fakeListmonk();

    const res = await subscribe("new@example.com");

    assert.equal(res.status, 200);
    assert.deepEqual(lm.calls(), ["POST /api/subscribers", "POST /api/tx"]);
    assert.deepEqual(lm.writes[0]!.body.lists, []);
    assert.equal(lm.membership("new@example.com"), undefined);
  });

  test("leaves a known address off the list, even one that unsubscribed", async () => {
    const lm = fakeListmonk([
      existing("old@example.com", [{ id: LIST_ID, subscription_status: "unsubscribed" }]),
    ]);

    const res = await subscribe("old@example.com");

    assert.equal(res.status, 200);
    assert.deepEqual(lm.calls(), ["POST /api/tx"]);
    assert.equal(lm.membership("old@example.com"), "unsubscribed");
  });

  test("sends nothing to an address that is already confirmed", async () => {
    const lm = fakeListmonk([
      existing("done@example.com", [{ id: LIST_ID, subscription_status: "confirmed" }]),
    ]);

    const res = await subscribe("done@example.com");

    assert.deepEqual(await res.json(), { ok: true, alreadySubscribed: true });
    assert.deepEqual(lm.calls(), []);
  });
});

describe("GET /api/newsletter/confirm", () => {
  test("adds an existing subscriber to the list as confirmed", async () => {
    const lm = fakeListmonk([existing("reader@example.com", [])]);

    const res = await confirm("reader@example.com");

    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `${base}/sub/confirmed`);
    assert.deepEqual(lm.calls(), ["PUT /api/subscribers/lists"]);
    assert.deepEqual(lm.writes[0]!.body, {
      ids: [42],
      action: "add",
      target_list_ids: [LIST_ID],
      status: "confirmed",
    });
    assert.equal(lm.membership("reader@example.com"), "confirmed");
  });

  test("recreates a subscriber that went missing, preconfirmed on the list", async () => {
    const lm = fakeListmonk();

    const res = await confirm("gone@example.com");

    assert.equal(res.status, 303);
    assert.deepEqual(lm.calls(), ["POST /api/subscribers"]);
    assert.deepEqual(lm.writes[0]!.body.lists, [LIST_ID]);
    assert.equal(lm.writes[0]!.body.preconfirm_subscriptions, true);
    assert.equal(lm.membership("gone@example.com"), "confirmed");
  });
});

test("subscribe then confirm: the membership appears only on the click", async () => {
  const lm = fakeListmonk();

  await subscribe("a+b@example.com");
  assert.equal(lm.membership("a+b@example.com"), undefined);

  await confirm("a+b@example.com");
  assert.equal(lm.membership("a+b@example.com"), "confirmed");
  // One subscriber row: the confirm click found the plus-address the form
  // created instead of trying to create it again (a 409 on real Listmonk).
  assert.equal(lm.subscribers.length, 1);
  assert.deepEqual(lm.calls(), ["POST /api/subscribers", "POST /api/tx", "PUT /api/subscribers/lists"]);
  // No write ever asks Listmonk for an `unconfirmed` membership or skips
  // `preconfirm_subscriptions`, the two ways to trigger its own opt-in email.
  for (const { body } of lm.writes) {
    assert.notEqual(body?.status, "unconfirmed");
    assert.notEqual(body?.preconfirm_subscriptions, false);
  }
});

describe("findSubscriber", () => {
  test("anchors and quotes the search so a plus-address matches only itself", async () => {
    const lm = fakeListmonk([
      existing("readerrtest@example.com", []),
      { ...existing("reader+test@example.com", []), id: 43 },
    ]);

    const found = await findSubscriber("Reader+Test@Example.com");

    assert.equal(found?.id, 43);
    assert.equal(lm.searches[0]!.get("search"), "^reader\\+test@example\\.com$");
    // `query` needs Listmonk's `subscribers:sql_query` permission.
    assert.equal(lm.searches[0]!.get("query"), null);
  });

  test("keeps only the exact email when the name column also matches", async () => {
    fakeListmonk([{ ...existing("other@example.com", []), name: "reader@example.com" }]);

    assert.equal(await findSubscriber("reader@example.com"), null);
  });
});

/** Run `fn` with these env vars set (or deleted, for `undefined`), then
 *  put every one of them back. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>): void => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(vars);
  try {
    await fn();
  } finally {
    apply(saved);
  }
}

describe("the list NODE_ENV selects", () => {
  // config/env.ts, docker-compose.yml, .env.example and Hatchkit's
  // provisioner all name the live list LISTMONK_LIVE_LIST_ID, and the
  // container receives nothing else.
  test("production subscribes and confirms on LISTMONK_LIVE_LIST_ID alone", async () => {
    await withEnv(
      { NODE_ENV: "production", LISTMONK_LIVE_LIST_ID: String(LIST_ID), LISTMONK_LIST_ID: undefined, LISTMONK_TEST_LIST_ID: "99" },
      async () => {
        const lm = fakeListmonk();

        assert.equal((await subscribe("live@example.com")).status, 200);
        assert.equal((await confirm("live@example.com")).status, 303);

        assert.equal(lm.membership("live@example.com"), "confirmed");
        assert.equal(describeListTarget(), `LISTMONK_LIVE_LIST_ID=${LIST_ID} (production)`);
      },
    );
  });

  test("production prefers LISTMONK_LIVE_LIST_ID over LISTMONK_LIST_ID", async () => {
    await withEnv({ NODE_ENV: "production", LISTMONK_LIVE_LIST_ID: "7", LISTMONK_LIST_ID: "8" }, () => {
      assert.equal(resolveListId(), 7);
    });
  });

  // An env file written by an older Hatchkit holds the live id under
  // LISTMONK_LIST_ID.
  test("production reads LISTMONK_LIST_ID only when LISTMONK_LIVE_LIST_ID is unset", async () => {
    await withEnv({ NODE_ENV: "production", LISTMONK_LIVE_LIST_ID: undefined, LISTMONK_LIST_ID: "8" }, () => {
      assert.equal(resolveListId(), 8);
      assert.equal(describeListTarget(), "LISTMONK_LIST_ID=8 (production)");
    });
  });

  test("production with no live id names the documented variable", async () => {
    await withEnv({ NODE_ENV: "production", LISTMONK_LIVE_LIST_ID: undefined, LISTMONK_LIST_ID: undefined }, () => {
      assert.throws(() => resolveListId(), /Missing required env var: LISTMONK_LIVE_LIST_ID/);
    });
  });

  test("outside production only LISTMONK_TEST_LIST_ID is read", async () => {
    await withEnv(
      { NODE_ENV: "development", LISTMONK_LIVE_LIST_ID: "7", LISTMONK_LIST_ID: "8", LISTMONK_TEST_LIST_ID: undefined },
      () => {
        assert.throws(() => resolveListId(), /Missing required env var: LISTMONK_TEST_LIST_ID/);
      },
    );
  });
});
