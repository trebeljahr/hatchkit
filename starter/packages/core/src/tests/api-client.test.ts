/**
 * The HTTP caller's contract: what it sends, and what it makes of what comes
 * back.
 *
 * Every assertion here is something the offline queue depends on and no
 * type-check can catch — which statuses mean "never retry this", which failures
 * mean "nobody answered", and whether the version handshake actually leaves the
 * process.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  API_LEVEL,
  API_LEVEL_HEADER,
  CLIENT_ID_HEADER,
  CLIENT_TOO_OLD,
  CLIENT_VERSION_HEADER,
  VERSION_REFUSAL_HTTP_STATUS,
} from "@starter/shared";
import {
  ApiError,
  createApiClient,
  isPermanentRejectionStatus,
  isTransportFailure,
  withTenantId,
} from "../api-client.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A client whose every call answers with `answer`, recording what was sent. */
const clientWith = (
  answer: (url: string, init?: RequestInit) => Response,
): {
  api: ReturnType<typeof createApiClient>;
  urls: string[];
  headers: Headers[];
  bodies: Array<string | null>;
} => {
  const urls: string[] = [];
  const headers: Headers[] = [];
  const bodies: Array<string | null> = [];
  const api = createApiClient({
    baseUrl: "https://app.example.com",
    token: "tok",
    clientId: "starter-launcher",
    clientVersion: "0.3.1",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      urls.push(url);
      headers.push(new Headers(init?.headers));
      bodies.push(typeof init?.body === "string" ? init.body : null);
      return answer(url, init);
    }) as unknown as typeof fetch,
  });
  return { api, urls, headers, bodies };
};

test("a tRPC success unwraps result.data", async () => {
  const { api } = clientWith(() => json({ result: { data: { id: "i1" } } }));
  assert.deepEqual(await api.query("items.list"), { id: "i1" });
  assert.deepEqual(await api.mutate("items.create", { title: "A" }), { id: "i1" });
});

test("an error envelope throws ApiError carrying the code and the status", async () => {
  const { api } = clientWith(() =>
    json({ error: { message: "Nope", data: { code: "NOT_FOUND" } } }, 404),
  );
  const error = await api.query("items.get").then(
    () => null,
    (it: unknown) => it,
  );
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, "NOT_FOUND");
  assert.equal(error.httpStatus, 404);
  assert.equal(error.message, "Nope");
  // Not a version refusal, so a queue reads it on the merits of the row.
  assert.equal(error.versionRefusal, null);
});

test("a 412 carrying data.versionRefusal is CLIENT_TOO_OLD, and is not permanent", async () => {
  const { api } = clientWith(() =>
    json(
      {
        error: {
          message: "This app is too old for this server.",
          data: { code: "PRECONDITION_FAILED", versionRefusal: CLIENT_TOO_OLD },
        },
      },
      VERSION_REFUSAL_HTTP_STATUS,
    ),
  );
  const error = await api.mutate("items.create").then(
    () => null,
    (it: unknown) => it,
  );
  assert.ok(error instanceof ApiError);
  assert.equal(error.versionRefusal, CLIENT_TOO_OLD);
  assert.equal(error.httpStatus, 412);
  // The whole point of 412: the row is kept for the build that can send it.
  assert.equal(isPermanentRejectionStatus(error.code, error.httpStatus), false);
});

test("a body that is not JSON is PARSE_ERROR, whatever the status said", async () => {
  const { api } = clientWith(
    () =>
      new Response("<html>403 Forbidden</html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
  );
  const error = await api.query("items.list").then(
    () => null,
    (it: unknown) => it,
  );
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, "PARSE_ERROR");
  assert.equal(error.httpStatus, 403);
});

test("isTransportFailure is true only when nobody answered", () => {
  assert.equal(isTransportFailure(new TypeError("fetch failed")), true);
  assert.equal(isTransportFailure(new ApiError("Nope", "NOT_FOUND", 404)), false);
  assert.equal(isTransportFailure(new ApiError("Boom", "INTERNAL_SERVER_ERROR", 500)), false);
});

test("only a tRPC verdict is permanent, and PARSE_ERROR never is", () => {
  for (const status of [400, 403, 404, 409, 410, 422]) {
    assert.equal(
      isPermanentRejectionStatus("BAD_REQUEST", status),
      true,
      `${status} should drop the row`,
    );
  }
  // 401 is recoverable, 412 is version skew, 429 and 5xx are the server asking
  // for patience. None of them may delete a person's queued work.
  for (const status of [401, 412, 429, 500, 502, 503]) {
    assert.equal(
      isPermanentRejectionStatus("BAD_REQUEST", status),
      false,
      `${status} should keep the row`,
    );
  }
  // A body from in front of the API says nothing about the row, at any status.
  for (const status of [400, 403, 404, 409, 410, 422]) {
    assert.equal(isPermanentRejectionStatus("PARSE_ERROR", status), false);
  }
});

test("withTenantId fills a gap and never overwrites an address", () => {
  assert.deepEqual(withTenantId({ title: "A" }, "t1"), { title: "A", tenantId: "t1" });
  assert.deepEqual(withTenantId({ title: "A", tenantId: "t0" }, "t1"), {
    title: "A",
    tenantId: "t0",
  });
  // An empty string is not an address, so it is filled like a missing one.
  assert.deepEqual(withTenantId({ tenantId: "" }, "t1"), { tenantId: "t1" });
  // No input at all becomes an input that names the tenant.
  assert.deepEqual(withTenantId(undefined, "t1"), { tenantId: "t1" });
  // Nothing to carry a tenant, and wrapping would change what the server parses.
  assert.equal(withTenantId("i1", "t1"), "i1");
  assert.deepEqual(withTenantId(["i1"], "t1"), ["i1"]);
  // No tenant chosen: the input goes as it is and the server resolves a default.
  assert.deepEqual(withTenantId({ title: "A" }, null), { title: "A" });
});

test("the tenant getter is read per request, not captured once", async () => {
  const bodies: Array<string | null> = [];
  let tenant = "t1";
  const api = createApiClient({
    baseUrl: "https://app.example.com",
    tenantId: () => tenant,
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      bodies.push(typeof init?.body === "string" ? init.body : null);
      return json({ result: { data: null } });
    }) as unknown as typeof fetch,
  });
  await api.mutate("items.create", { title: "A" });
  tenant = "t2";
  await api.mutate("items.create", { title: "B" });
  assert.deepEqual(JSON.parse(bodies[0] ?? "null"), { title: "A", tenantId: "t1" });
  assert.deepEqual(JSON.parse(bodies[1] ?? "null"), { title: "B", tenantId: "t2" });
});

test("every request declares the API level, the release and the client id", async () => {
  const { api, headers } = clientWith(() => json({ result: { data: null } }));
  await api.query("items.list");
  await api.mutate("items.create", {});
  assert.equal(headers.length, 2);
  for (const sent of headers) {
    assert.equal(sent.get(API_LEVEL_HEADER), String(API_LEVEL));
    assert.equal(sent.get(CLIENT_VERSION_HEADER), "0.3.1");
    // Untouched by the handshake: it names a row in a device list, nothing more.
    assert.equal(sent.get(CLIENT_ID_HEADER), "starter-launcher");
    assert.equal(sent.get("authorization"), "Bearer tok");
  }
});

test("a GET carries its input in ?input=, a POST in the body", async () => {
  const { api, urls, bodies } = clientWith(() => json({ result: { data: null } }));
  await api.query("items.get", { id: "i1" });
  assert.equal(
    urls[0],
    `https://app.example.com/api/trpc/items.get?input=${encodeURIComponent(
      JSON.stringify({ id: "i1" }),
    )}`,
  );
  assert.equal(bodies[0], null);

  await api.mutate("items.create", { title: "A" });
  assert.equal(urls[1], "https://app.example.com/api/trpc/items.create");
  assert.deepEqual(JSON.parse(bodies[1] ?? "null"), { title: "A" });

  // No input, no query parameter — a procedure that takes none must not be sent
  // an `input=undefined` the server then fails to parse.
  await api.query("items.list");
  assert.equal(urls[2], "https://app.example.com/api/trpc/items.list");
});
