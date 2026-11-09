/**
 * Steam OpenID sign-in and linking, against the real library.
 *
 * Steam itself is replaced by a stub of `fetch` that answers
 * `check_authentication`; everything else — better-auth's router, cookies,
 * the verification table and the account rows — is real. The cases are the
 * ones that fail quietly: an assertion that was never checked with Steam, a
 * replayed assertion, a link that lands on the wrong account.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { anonymous } from "better-auth/plugins/anonymous";
import {
  STEAM_OPENID_ENDPOINT,
  steamReturnPath,
  steamSignInPlugin,
  verifySteamAssertion,
} from "../auth/steam-sign-in.js";

const BASE = "http://localhost:5000";
const STEAM_ID = "76561198000000001";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Steam answers `is_valid` for `check_authentication`, and nothing else is reached. */
function stubSteam(valid = true): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input) !== STEAM_OPENID_ENDPOINT) throw new Error(`unexpected fetch ${input}`);
    return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${valid}\n`);
  }) as typeof fetch;
}

function assertion(returnTo: string, overrides: Record<string, string> = {}): URLSearchParams {
  const claimed = `https://steamcommunity.com/openid/id/${STEAM_ID}`;
  return new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": STEAM_OPENID_ENDPOINT,
    "openid.claimed_id": claimed,
    "openid.identity": claimed,
    "openid.return_to": returnTo,
    "openid.response_nonce": `${new Date().toISOString().slice(0, 19)}Z${Math.random()}`,
    "openid.assoc_handle": "1234567890",
    "openid.signed": "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "c2lnbmF0dXJl",
    ...overrides,
  });
}

function build(onGuestUpgrade?: (from: string, to: string) => void) {
  const db: Record<string, unknown[]> = { user: [], session: [], account: [], verification: [] };
  const auth = betterAuth({
    database: memoryAdapter(db),
    secret: "test-secret-that-is-at-least-32-characters-long",
    baseURL: BASE,
    trustedOrigins: [BASE],
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
    plugins: [
      steamSignInPlugin({ STEAM_SIGN_IN: "true", FRONTEND_URL: BASE }),
      ...(onGuestUpgrade
        ? [
            anonymous({
              onLinkAccount: async ({ anonymousUser, newUser }) =>
                onGuestUpgrade(anonymousUser.user.id, newUser.user.id),
            }),
          ]
        : []),
    ],
  });
  return { auth, db };
}

const cookiesOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .filter((pair) => !pair.endsWith("="))
    .join("; ");

type Auth = ReturnType<typeof build>["auth"];

/** Start a flow and build the request Steam would send the browser back with. */
async function begin(auth: Auth, body: Record<string, unknown>, cookie = ""): Promise<() => Request> {
  const start = await auth.handler(
    new Request(`${BASE}/api/auth/steam/start`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
  assert.equal(start.status, 200, await start.clone().text());
  const { url } = (await start.json()) as { url: string };
  const returnTo = new URL(url).searchParams.get("openid.return_to") ?? "";
  const back = new URL(returnTo);
  for (const [key, value] of assertion(returnTo)) back.searchParams.set(key, value);
  const stateCookie = cookiesOf(start);
  return () => new Request(back, { headers: { cookie: [cookie, stateCookie].filter(Boolean).join("; ") } });
}

/** Start a flow, then come back from Steam with a valid assertion. */
async function roundTrip(auth: Auth, body: Record<string, unknown>, cookie = ""): Promise<Response> {
  return auth.handler((await begin(auth, body, cookie))());
}

test("a callback signs in once: the same return is refused the second time", async () => {
  stubSteam();
  const { auth } = build();
  const callback = await begin(auth, { intent: "sign-in" });
  const first = await auth.handler(callback());
  assert.match(cookiesOf(first), /session_token=/);
  const replay = await auth.handler(callback());
  assert.match(replay.headers.get("location") ?? "", /error=steam_expired/);
  assert.doesNotMatch(cookiesOf(replay), /session_token=/);
});

test("a guest who signs in with Steam hands over their data and is removed", async () => {
  stubSteam();
  const moved: Array<[string, string]> = [];
  const { auth, db } = build((from, to) => moved.push([from, to]));
  const guest = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/anonymous`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: "{}",
    }),
  );
  const guestId = (db.user[0] as { id: string }).id;
  await roundTrip(auth, { intent: "sign-in" }, cookiesOf(guest));
  assert.equal(moved.length, 1, "onLinkAccount was not called");
  assert.equal(moved[0]?.[0], guestId);
  assert.ok(
    !(db.user as Array<{ id: string }>).some((u) => u.id === guestId),
    "the guest user must be deleted after the hand-over",
  );
});

test("a valid assertion signs a new player in with a placeholder address", async () => {
  stubSteam();
  const { auth, db } = build();
  const done = await roundTrip(auth, { intent: "sign-in", returnPath: "/dashboard" });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get("location"), `${BASE}/dashboard`);
  assert.match(cookiesOf(done), /session_token=/);
  const accounts = db.account as Array<{ providerId: string; accountId: string }>;
  assert.deepEqual(
    accounts.map((a) => [a.providerId, a.accountId]),
    [["steam", STEAM_ID]],
  );
  assert.equal((db.user[0] as { email: string }).email, `${STEAM_ID}@steam.invalid`);
});

test("the same Steam ID signs in to the same account the second time", async () => {
  stubSteam();
  const { auth, db } = build();
  await roundTrip(auth, { intent: "sign-in" });
  await roundTrip(auth, { intent: "sign-in" });
  assert.equal(db.user.length, 1);
  assert.equal(db.account.length, 1);
});

test("an assertion Steam does not confirm signs nobody in", async () => {
  stubSteam(false);
  const { auth, db } = build();
  const done = await roundTrip(auth, { intent: "sign-in" });
  assert.equal(done.status, 302);
  assert.match(done.headers.get("location") ?? "", /error=steam_sign_in_failed/);
  assert.equal(db.user.length, 0);
});

test("a link attaches Steam to the signed-in account", async () => {
  stubSteam();
  const { auth, db } = build();
  const signUp = await auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ email: "player@example.com", password: "correct-horse-1", name: "P" }),
    }),
  );
  const session = cookiesOf(signUp);
  const done = await roundTrip(auth, { intent: "link" }, session);
  assert.equal(done.headers.get("location"), `${BASE}/settings/accounts`);
  const userId = (db.user[0] as { id: string }).id;
  const steam = (db.account as Array<{ providerId: string; userId: string }>).find(
    (a) => a.providerId === "steam",
  );
  assert.equal(String(steam?.userId), String(userId));
  assert.equal(db.user.length, 1, "a link must not create a second user");
});

test("linking needs a session, and the placeholder domain cannot be claimed", async () => {
  const { auth } = build();
  const start = await auth.handler(
    new Request(`${BASE}/api/auth/steam/start`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ intent: "link" }),
    }),
  );
  assert.equal(start.status, 401);
  const squat = await auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ email: `${STEAM_ID}@steam.invalid`, password: "correct-horse-1", name: "x" }),
    }),
  );
  assert.equal(squat.status, 400);
});

test("a start from an untrusted page is refused", async () => {
  const { auth } = build();
  const start = await auth.handler(
    new Request(`${BASE}/api/auth/steam/start`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(start.status, 403);
});

test("the assertion checker refuses what Steam did not sign", async () => {
  const returnTo = `${BASE}/api/auth/steam/callback?state=x`;
  const post = async () => ({ ok: true, text: async () => "is_valid:true" });
  const ok = await verifySteamAssertion(assertion(returnTo), returnTo, { post });
  assert.equal(ok.steamId, STEAM_ID);
  const forged: Array<Record<string, string>> = [
    { "openid.return_to": `${BASE}/elsewhere` },
    { "openid.op_endpoint": "https://evil.example/openid/login" },
    { "openid.claimed_id": "https://steamcommunity.com/openid/id/1" },
    { "openid.signed": "op_endpoint,claimed_id" },
    { "openid.response_nonce": "2001-01-01T00:00:00Zold" },
  ];
  for (const bad of forged) {
    await assert.rejects(verifySteamAssertion(assertion(returnTo, bad), returnTo, { post }));
  }
});

test("the return path never leaves the site", () => {
  assert.equal(steamReturnPath("/settings/accounts"), "/settings/accounts");
  for (const hostile of ["//evil.example", "https://evil.example", "/\\evil", "/api/auth/x", " /x"]) {
    assert.equal(steamReturnPath(hostile), "/dashboard", hostile);
  }
});
