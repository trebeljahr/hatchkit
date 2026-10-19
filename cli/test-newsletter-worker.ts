/**
 * The newsletter Worker template (src/templates/newsletter-worker), the
 * static-site port of the starter's newsletter service. Listmonk and R2
 * are in-memory fakes; nothing reaches the network.
 *
 * Pinned here:
 *
 *   1. Signup with a magnet: the subscriber is created on no list with
 *      `attribs.signup`, the confirm link carries the magnet key, the
 *      click adds the list and mails a download link, and that link
 *      streams the R2 object.
 *   2. Unknown magnets are refused; a confirmed member gets the download
 *      straight from the form; a second confirm click sends nothing.
 *   3. A failed delivery still confirms and logs `delivery_failed`.
 *   4. Download tokens expire and are not interchangeable with confirm
 *      tokens.
 *   5. The cron deletes only this form's signups that sit on no list for
 *      30 days; the form mails one inbox at the limiter's rate.
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";

const worker = await import("./src/templates/newsletter-worker/src/newsletter.ts");
const {
  _setMagnetsForTests,
  DOWNLOAD_TOKEN_TTL_MS,
  handleRequest,
  handleScheduled,
  mintConfirmToken,
  mintDownloadToken,
  parseMagnets,
  verifyConfirmToken,
} = worker;
type Env = import("./src/templates/newsletter-worker/src/newsletter.ts").Env;

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

const LISTMONK = "https://listmonk.test";
const SITE = "https://site.test";
const SECRET = "test-secret";
const LIST_ID = 21;
const FILE = new TextEncoder().encode("PK\u0003\u0004 wallpapers");

type Membership = { id: number; subscription_status: "unconfirmed" | "confirmed" | "unsubscribed" };
type FakeSubscriber = {
  id: number;
  email: string;
  name: string;
  status: "enabled" | "disabled" | "blocklisted";
  lists: Membership[];
  attribs?: Record<string, unknown>;
  created_at?: string;
};
type Write = { call: string; url: URL; body: any };

/** In-memory Listmonk behind globalThis.fetch. */
function fakeListmonk(seed: FakeSubscriber[] = [], opts: { failTx?: boolean } = {}) {
  const subscribers = [...seed];
  const writes: Write[] = [];
  const json = (data: unknown): Response => new Response(JSON.stringify({ data }), { status: 200 });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== LISTMONK) throw new Error(`Unexpected network access: ${url}`);
    const call = `${init.method ?? "GET"} ${url.pathname}`;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    if ((init.method ?? "GET") !== "GET") writes.push({ call, url, body });
    const byId = /^GET \/api\/subscribers\/(\d+)$/.exec(call);
    if (byId) {
      const sub = subscribers.find((s) => s.id === Number(byId[1]));
      return sub ? json(sub) : new Response("not found", { status: 404 });
    }
    switch (call) {
      case "GET /api/subscribers": {
        const re = new RegExp(url.searchParams.get("search") ?? "", "i");
        const results = subscribers.filter((s) => re.test(s.name) || re.test(s.email));
        return json({ results, total: results.length });
      }
      case "POST /api/subscribers": {
        const sub: FakeSubscriber = {
          id: 100 + subscribers.length,
          email: body.email,
          name: body.name,
          status: "enabled",
          lists: (body.lists as number[]).map((id) => ({ id, subscription_status: "confirmed" })),
          attribs: body.attribs,
          created_at: new Date().toISOString(),
        };
        subscribers.push(sub);
        return json(sub);
      }
      case "PUT /api/subscribers/lists": {
        for (const sub of subscribers.filter((s) => body.ids.includes(s.id))) {
          sub.lists = sub.lists.filter((l) => !body.target_list_ids.includes(l.id));
          for (const id of body.target_list_ids) sub.lists.push({ id, subscription_status: body.status });
        }
        return json(true);
      }
      case "DELETE /api/subscribers": {
        const ids = url.searchParams.getAll("id").map(Number);
        for (let i = subscribers.length - 1; i >= 0; i--) {
          if (ids.includes(subscribers[i].id)) subscribers.splice(i, 1);
        }
        return json(true);
      }
      case "POST /api/tx":
        return opts.failTx ? new Response("smtp down", { status: 500 }) : json(true);
      default:
        return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;
  return {
    subscribers,
    writes,
    calls: () => writes.map((w) => w.call),
    txs: () => writes.filter((w) => w.call === "POST /api/tx").map((w) => w.body),
    membership: (email: string) =>
      subscribers.find((s) => s.email === email)?.lists.find((l) => l.id === LIST_ID)?.subscription_status,
  };
}

const env: Env = {
  LISTMONK_URL: LISTMONK,
  LISTMONK_API_USER: "project",
  LISTMONK_API_TOKEN: "token",
  LISTMONK_TX_TEMPLATE_ID: "22",
  LISTMONK_FROM: "Project <noreply@mail.site.test>",
  LISTMONK_LIST_ID: String(LIST_ID),
  NEWSLETTER_TOKEN_SECRET: SECRET,
  SITE_URL: SITE,
  API_URL: SITE,
  SITE_NAME: "Project",
  MAGNETS: {
    async get(key: string) {
      if (key !== "magnets/wallpapers.zip") return null;
      return {
        body: new Response(FILE).body as ReadableStream,
        size: FILE.byteLength,
        httpMetadata: { contentType: "application/zip" },
      };
    },
  },
};

_setMagnetsForTests({
  wallpapers: { title: "Wallpaper pack", object: "magnets/wallpapers.zip", filename: "Wallpapers.zip" },
  "reading-list": { title: "Reading list", url: "https://files.site.test/list.pdf" },
});

function post(fields: Record<string, string>): Promise<Response> {
  return handleRequest(
    new Request(`${SITE}/api/newsletter/subscribe`, { method: "POST", body: new URLSearchParams(fields) }),
    env,
  );
}
const get = (url: string) => handleRequest(new Request(url), env);
const location = (res: Response) => res.headers.get("location") ?? "";
function linkIn(tx: any): string {
  const href = /href="([^"]+)"/.exec(tx?.data?.body ?? "")?.[1]?.replace(/&amp;/g, "&");
  assert.ok(href, "email has no link");
  return href;
}
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const [error, info] = [console.error, console.info];
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
  console.info = () => {};
  try {
    return { result: await fn(), errors };
  } finally {
    console.error = error;
    console.info = info;
  }
}

await test("token → delivery → attribs: confirm mails a link that streams the R2 object", async () => {
  const lm = fakeListmonk();
  await quietly(async () => {
    const res = await post({ email: "Fan@Example.com", magnet: "wallpapers", source: "home-hero" });
    assert.equal(location(res), `${SITE}/sub/check-email`);

    const created = lm.writes.find((w) => w.call === "POST /api/subscribers")?.body;
    assert.deepEqual(created.lists, []);
    assert.deepEqual(created.attribs, { signup: { list: LIST_ID, source: "home-hero", magnet: "wallpapers" } });

    const confirmUrl = linkIn(lm.txs()[0]);
    const token = new URL(confirmUrl).searchParams.get("token") ?? "";
    assert.deepEqual(await verifyConfirmToken(SECRET, token), {
      ok: true,
      email: "fan@example.com",
      magnet: "wallpapers",
      source: "home-hero",
    });

    const confirmed = await get(confirmUrl);
    assert.equal(location(confirmed), `${SITE}/sub/confirmed?delivery=sent`);
    assert.equal(lm.membership("fan@example.com"), "confirmed");

    const delivery = lm.txs()[1];
    assert.equal(delivery.from_email, env.LISTMONK_FROM);
    assert.match(delivery.data.subject, /Wallpaper pack/);
    const download = await get(linkIn(delivery));
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/zip");
    assert.match(download.headers.get("content-disposition") ?? "", /attachment; filename="Wallpapers\.zip"/);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), FILE);
  });
});

await test("a url magnet redirects; an unknown one is refused before Listmonk", async () => {
  const lm = fakeListmonk();
  await quietly(async () => {
    const res = await get(
      `${SITE}/api/newsletter/download?token=${encodeURIComponent(await mintDownloadToken(SECRET, "reading-list"))}`,
    );
    assert.equal(res.status, 302);
    assert.equal(location(res), "https://files.site.test/list.pdf");

    const refused = await post({ email: "fan@example.com", magnet: "https://evil.test/x.exe" });
    assert.equal(location(refused), `${SITE}/sub/error?reason=unknown_magnet`);
    assert.deepEqual(lm.calls(), []);
  });
});

await test("a confirmed member gets the download from the form; a second click sends nothing", async () => {
  const member: FakeSubscriber = {
    id: 42,
    email: "done@example.com",
    name: "done@example.com",
    status: "enabled",
    lists: [{ id: LIST_ID, subscription_status: "confirmed" }],
  };
  const lm = fakeListmonk([member]);
  await quietly(async () => {
    const res = await post({ email: "done@example.com", magnet: "reading-list" });
    assert.equal(location(res), `${SITE}/sub/check-email`);
    assert.deepEqual(lm.calls(), ["POST /api/tx"]);
    assert.match(linkIn(lm.txs()[0]), /\/api\/newsletter\/download\?token=/);

    const again = await get(
      `${SITE}/api/newsletter/confirm?token=${encodeURIComponent(await mintConfirmToken(SECRET, "done@example.com", { magnet: "wallpapers" }))}`,
    );
    assert.equal(location(again), `${SITE}/sub/confirmed`);
    assert.equal(lm.txs().length, 1);
  });
});

await test("a failed delivery still confirms and logs delivery_failed", async () => {
  const lm = fakeListmonk([{ id: 7, email: "r@example.com", name: "r@example.com", status: "enabled", lists: [] }], {
    failTx: true,
  });
  const token = await mintConfirmToken(SECRET, "r@example.com", { magnet: "wallpapers" });
  const { result: res, errors } = await quietly(() =>
    get(`${SITE}/api/newsletter/confirm?token=${encodeURIComponent(token)}`),
  );
  assert.equal(location(res), `${SITE}/sub/confirmed?delivery=failed`);
  assert.equal(lm.membership("r@example.com"), "confirmed");
  const line = errors.map((e) => JSON.parse(e)).find((e) => e.event === "delivery_failed");
  assert.equal(line?.scope, "newsletter.delivery");
  assert.equal(line?.magnet, "wallpapers");
});

await test("download tokens expire and do not swap with confirm tokens", async () => {
  fakeListmonk();
  await quietly(async () => {
    const reason = (res: Response) => new URL(location(res)).searchParams.get("reason");
    const dl = (t: string) => get(`${SITE}/api/newsletter/download?token=${encodeURIComponent(t)}`);
    const old = await mintDownloadToken(SECRET, "wallpapers", Date.now() - DOWNLOAD_TOKEN_TTL_MS - 1000);
    assert.equal(reason(await dl(old)), "download_expired");
    assert.equal(reason(await dl(await mintConfirmToken(SECRET, "a@example.com", { magnet: "wallpapers" }))), "download_invalid");
    assert.deepEqual(await verifyConfirmToken(SECRET, await mintDownloadToken(SECRET, "wallpapers")), {
      ok: false,
      reason: "malformed",
    });
    assert.equal(reason(await dl(await mintDownloadToken(SECRET, "gone"))), "download_unavailable");
  });
});

await test("magnets.json entries are checked one by one", () => {
  const { magnets, problems } = parseMagnets({
    ok: { title: "Fine", object: "magnets/a.zip" },
    both: { title: "x", object: "a.zip", url: "https://x.test/a" },
    plain: { title: "x", url: "http://x.test/a" },
    escape: { title: "x", object: "../a" },
  });
  assert.deepEqual([...magnets.keys()], ["ok"]);
  assert.equal(problems.length, 3);
});

await test("cron: deletes only this form's signups on no list for 30 days", async () => {
  const now = Date.now();
  const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const sub = (id: number, extra: Partial<FakeSubscriber> = {}): FakeSubscriber => ({
    id,
    email: `s${id}@example.com`,
    name: `s${id}@example.com`,
    status: "enabled",
    lists: [],
    attribs: { signup: { list: LIST_ID } },
    created_at: at(40),
    ...extra,
  });
  const lm = fakeListmonk([
    sub(1),
    sub(2, { created_at: at(3) }),
    sub(3, { lists: [{ id: 99, subscription_status: "confirmed" }] }),
    sub(4, { lists: [{ id: LIST_ID, subscription_status: "unsubscribed" }] }),
    sub(5, { status: "blocklisted" }),
    sub(6, { status: "disabled" }),
    sub(7, { attribs: { signup: { list: 99 } } }),
    sub(8, { attribs: {} }),
  ]);
  const waits: Promise<unknown>[] = [];
  await quietly(async () => {
    await handleScheduled({}, env, { waitUntil: (p) => void waits.push(p) });
    await Promise.all(waits);
  });
  assert.deepEqual(lm.subscribers.map((s) => s.id), [2, 3, 4, 5, 6, 7, 8]);
});

await test("the form mails a confirmed inbox only while the per-address limiter allows", async () => {
  const lm = fakeListmonk([
    {
      id: 42,
      email: "done@example.com",
      name: "done@example.com",
      status: "enabled",
      lists: [{ id: LIST_ID, subscription_status: "confirmed" }],
    },
  ]);
  const keys: string[] = [];
  const limited: Env = {
    ...env,
    SUBSCRIBE_LIMITER: {
      async limit({ key }) {
        keys.push(key);
        return { success: !key.startsWith("mail:") };
      },
    },
  };
  await quietly(async () => {
    const res = await handleRequest(
      new Request(`${SITE}/api/newsletter/subscribe`, {
        method: "POST",
        body: new URLSearchParams({ email: "done@example.com", magnet: "reading-list" }),
      }),
      limited,
    );
    assert.equal(location(res), `${SITE}/sub/check-email`);
  });
  assert.deepEqual(keys, ["unknown", "mail:done@example.com"]);
  assert.deepEqual(lm.txs(), []);
});

const failed = Object.entries(results).filter(([, ok]) => !ok);
console.log(
  `\nnewsletter-worker: ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed`,
);
if (failed.length) process.exit(1);
