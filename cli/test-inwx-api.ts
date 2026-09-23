/**
 * inwx-api.ts: session-cookie + 2FA unit tests.
 *
 * Regression cover for the auth break where `hatchkit dns
 * link-to-cloudflare` failed with "INWX login succeeded but no session
 * cookie was set". Root cause: INWX renamed its session cookie from
 * `PHPSESSID` to `domrobot`, and the client matched the old name with a
 * hard-coded regex, so the session was silently dropped. Goldens lock in:
 *
 *   1. The current `domrobot` cookie is captured on login and replayed on
 *      every follow-up call (the actual fix).
 *   2. The legacy `PHPSESSID` name still works (back-compat).
 *   3. A login that sets NO session cookie still throws the guard error.
 *   4. A 2FA-enabled account without INWX_TOTP throws a clear, actionable
 *      error instead of an opaque downstream failure.
 *   5. A 2FA-enabled account WITH INWX_TOTP performs account.unlock with
 *      the TOTP so subsequent calls are authorized.
 *
 * The client talks to the network via the global `fetch`, so each case
 * stubs `globalThis.fetch` with a recorder that returns real `Response`
 * objects (so `getSetCookie()` behaves exactly as in production).
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import { InwxApi } from "./src/utils/inwx-api.js";

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
  cookie: string | null;
}

interface FakeReply {
  code?: number;
  msg?: string;
  resData?: unknown;
  /** Raw Set-Cookie header lines to attach to the response. */
  setCookies?: string[];
}

/** Install a fake global fetch that records each JSON-RPC call and answers
 *  it from `replies` keyed by method. Returns the recorder + a restore fn. */
function stubFetch(replies: Record<string, FakeReply>): {
  calls: RecordedCall[];
  restore: () => void;
} {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: Record<string, unknown>;
    };
    const headers = new Headers(init.headers as HeadersInit);
    calls.push({ method: body.method, params: body.params, cookie: headers.get("cookie") });

    const reply = replies[body.method] ?? { code: 1000, msg: "ok" };
    const respHeaders = new Headers();
    respHeaders.set("content-type", "application/json");
    for (const line of reply.setCookies ?? []) respHeaders.append("set-cookie", line);
    return new Response(
      JSON.stringify({
        code: reply.code ?? 1000,
        msg: reply.msg ?? "Command completed successfully",
        resData: reply.resData,
      }),
      { status: 200, headers: respHeaders },
    );
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

const failures: string[] = [];

async function expect(label: string, fn: () => Promise<void>): Promise<void> {
  const savedTotp = process.env.INWX_TOTP;
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  } finally {
    // Keep cases isolated from each other's env mutation.
    if (savedTotp === undefined) delete process.env.INWX_TOTP;
    else process.env.INWX_TOTP = savedTotp;
  }
}

console.log("InwxApi:");

await expect(
  "captures the 2026 `domrobot` cookie and replays it on follow-up calls",
  async () => {
    const { calls, restore } = stubFetch({
      "account.login": {
        resData: { tfa: "0" },
        setCookies: ["domrobot=SESSIONVALUE123; path=/; HttpOnly; Secure"],
      },
      "domain.info": { resData: { domain: "example.com", ns: ["a.ns", "b.ns"] } },
    });
    try {
      const api = new InwxApi({ username: "user", password: "pw" });
      await api.login(); // must NOT throw
      await api.getDomainInfo("example.com");
    } finally {
      restore();
    }
    const info = calls.find((c) => c.method === "domain.info");
    assert.ok(info, "domain.info should have been called");
    assert.equal(info?.cookie, "domrobot=SESSIONVALUE123");
  },
);

await expect("still captures the legacy `PHPSESSID` cookie name", async () => {
  const { calls, restore } = stubFetch({
    "account.login": {
      resData: { tfa: "0" },
      setCookies: ["PHPSESSID=LEGACY456; path=/"],
    },
    "domain.info": { resData: { domain: "example.com", ns: ["a.ns", "b.ns"] } },
  });
  try {
    const api = new InwxApi({ username: "user", password: "pw" });
    await api.login();
    await api.getDomainInfo("example.com");
  } finally {
    restore();
  }
  const info = calls.find((c) => c.method === "domain.info");
  assert.equal(info?.cookie, "PHPSESSID=LEGACY456");
});

await expect("throws the guard error when login sets no session cookie", async () => {
  const { restore } = stubFetch({
    "account.login": { resData: { tfa: "0" }, setCookies: [] },
  });
  try {
    const api = new InwxApi({ username: "user", password: "pw" });
    await assert.rejects(
      () => api.login(),
      /login succeeded but no session cookie was set/,
    );
  } finally {
    restore();
  }
});

await expect("2FA account without INWX_TOTP throws a clear, actionable error", async () => {
  delete process.env.INWX_TOTP;
  const { calls, restore } = stubFetch({
    "account.login": {
      resData: { tfa: "GOOGLE-AUTH" },
      setCookies: ["domrobot=SESS2FA; path=/"],
    },
  });
  try {
    const api = new InwxApi({ username: "user", password: "pw" });
    await assert.rejects(() => api.login(), /2FA enabled.*INWX_TOTP/s);
  } finally {
    restore();
  }
  assert.ok(
    !calls.some((c) => c.method === "account.unlock"),
    "must not attempt unlock without a TOTP",
  );
});

await expect("2FA account with INWX_TOTP performs account.unlock with the TOTP", async () => {
  process.env.INWX_TOTP = "123456";
  const { calls, restore } = stubFetch({
    "account.login": {
      resData: { tfa: "GOOGLE-AUTH" },
      setCookies: ["domrobot=SESS2FA; path=/"],
    },
    "account.unlock": { resData: {} },
  });
  try {
    const api = new InwxApi({ username: "user", password: "pw" });
    await api.login(); // must NOT throw
  } finally {
    restore();
  }
  const unlock = calls.find((c) => c.method === "account.unlock");
  assert.ok(unlock, "account.unlock should have been called");
  assert.equal(unlock?.params.tan, "123456");
  assert.equal(unlock?.cookie, "domrobot=SESS2FA", "unlock must carry the session cookie");
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll inwx-api tests passed.");
