/**
 * Listmonk client smoke tests — pure helpers only.
 *
 *  - `listmonkAuthHeader` follows the Listmonk docs verbatim:
 *      Authorization: token <api_user>:<token>
 *    Format is parsed server-side by string match, so any drift here
 *    silently breaks every API call. Worth a golden test.
 *
 *  - `normalizeListmonkUrl` strips trailing slashes so that
 *    `${base}/api/lists` always renders one separator, regardless of
 *    whether the user pasted `https://newsletter.example.com` or
 *    `https://newsletter.example.com/`.
 *
 *  - `createListmonkList` defaults to `optin: double`. On a single list
 *    Listmonk sends campaigns to every member not `unsubscribed`,
 *    `unconfirmed` included.
 *
 *  - `findListmonkSubscriberByEmail` uses an anchored, quoted `search`,
 *    not `query` (which needs the `subscribers:sql_query` permission).
 *
 * Run: `pnpm test` (via the script in cli/package.json).
 */
import assert from "node:assert/strict";
import {
  createListmonkList,
  findListmonkSubscriberByEmail,
  listmonkAuthHeader,
  listmonkEmailSearch,
  normalizeListmonkUrl,
} from "./src/provision/listmonk.js";

const failures: string[] = [];

function expect(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

console.log("listmonkAuthHeader:");

expect("formats as `token <user>:<token>` per Listmonk docs", () => {
  assert.equal(
    listmonkAuthHeader({ apiUser: "hatchkit", apiToken: "abc123" }),
    "token hatchkit:abc123",
  );
});

expect("does not URL-encode or otherwise transform the inputs", () => {
  assert.equal(
    listmonkAuthHeader({ apiUser: "user with spaces", apiToken: "tok+ /=" }),
    "token user with spaces:tok+ /=",
  );
});

console.log("\nnormalizeListmonkUrl:");

expect("strips a single trailing slash", () => {
  assert.equal(
    normalizeListmonkUrl("https://newsletter.example.com/"),
    "https://newsletter.example.com",
  );
});

expect("strips multiple trailing slashes", () => {
  assert.equal(
    normalizeListmonkUrl("https://newsletter.example.com///"),
    "https://newsletter.example.com",
  );
});

expect("leaves a slashless URL untouched", () => {
  assert.equal(
    normalizeListmonkUrl("https://newsletter.example.com"),
    "https://newsletter.example.com",
  );
});

expect("trims surrounding whitespace", () => {
  assert.equal(
    normalizeListmonkUrl("  https://newsletter.example.com/  "),
    "https://newsletter.example.com",
  );
});

const auth = { url: "https://listmonk.test", apiUser: "hatchkit", apiToken: "tok" };
const realFetch = globalThis.fetch;

/** Stub fetch with one canned `data` payload; returns the recorded calls. */
function stubFetch(data: unknown): Array<{ url: URL; init?: RequestInit }> {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

async function expectAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("\ncreateListmonkList:");

await expectAsync("creates lists double opt-in unless told otherwise", async () => {
  const calls = stubFetch({ id: 7, name: "demo", type: "private", optin: "double" });
  await createListmonkList("demo", { auth });
  assert.equal(calls[0].url.pathname, "/api/lists");
  assert.equal(JSON.parse(calls[0].init?.body as string).optin, "double");
});

console.log("\nfindListmonkSubscriberByEmail:");

expect("anchors the search and quotes regex characters", () => {
  const search = listmonkEmailSearch("Reader+Test@Example.com");
  assert.equal(search, "^reader\\+test@example\\.com$");
  // Same semantics as Postgres `~*` for this pattern.
  assert.ok(new RegExp(search, "i").test("reader+test@example.com"));
  assert.ok(!new RegExp(search, "i").test("readerrtest@example.com"));
  assert.ok(!new RegExp(search, "i").test("xreader+test@example.com"));
});

await expectAsync("uses search, not the sql_query-gated query param", async () => {
  const calls = stubFetch({ results: [], total: 0 });
  await findListmonkSubscriberByEmail("a+b@example.com", auth);
  assert.equal(calls[0].url.pathname, "/api/subscribers");
  assert.equal(calls[0].url.searchParams.get("search"), "^a\\+b@example\\.com$");
  assert.equal(calls[0].url.searchParams.get("query"), null);
});

await expectAsync("keeps only the exact email when the name column also matches", async () => {
  stubFetch({
    results: [
      { id: 1, email: "other@example.com", name: "a@example.com", status: "enabled" },
      { id: 2, email: "A@Example.com", name: "A", status: "enabled" },
    ],
    total: 2,
  });
  const found = await findListmonkSubscriberByEmail("a@example.com", auth);
  assert.equal(found?.id, 2);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll listmonk client tests passed.");
