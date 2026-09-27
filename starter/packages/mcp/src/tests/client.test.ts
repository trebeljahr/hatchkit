import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, CLIENT_ID_HEADER, isTransportFailure } from "@starter/core";
import {
  ApiNotThisApi,
  ApiRefusal,
  ApiUnreachable,
  createRestClient,
  describeTransportFailure,
} from "../client.js";
import { hintForProblem, problemSlug } from "../problems.js";
import { route } from "../routes.js";
import { createFakeApi, problemBody } from "./fake-api.js";

const BASE = "https://api.example.test/api/v1";

function client(answers: Parameters<typeof createFakeApi>[1]) {
  const fake = createFakeApi(BASE, answers);
  return {
    fake,
    rest: createRestClient({
      baseUrl: BASE,
      token: "sk_test",
      clientId: "starter-mcp",
      fetchImpl: fake.fetchImpl,
    }),
  };
}

describe("request building", () => {
  it("sends the bearer credential and names the surface", async () => {
    const { fake, rest } = client({ "GET /me": { json: { data: { scopes: [] } } } });
    await rest.request({ route: route("get", "/me") });
    const call = fake.calls[0];
    assert.equal(call?.headers.authorization, "Bearer sk_test");
    assert.equal(call?.headers[CLIENT_ID_HEADER], "starter-mcp");
  });

  it("fills path parameters and omits absent query values", async () => {
    const { fake, rest } = client({ "GET /items": { json: { data: [], nextCursor: null } } });
    await rest.request({
      route: route("get", "/items"),
      query: { limit: 5, cursor: undefined, status: null },
    });
    assert.equal(fake.calls[0]?.target, "/items?limit=5");
  });

  it("escapes a path parameter rather than letting it change the path", async () => {
    const { fake, rest } = client({ "GET /items/a%2Fb": { json: { data: {} } } });
    await rest.request({ route: route("get", "/items/:id"), params: { id: "a/b" } });
    assert.equal(fake.calls[0]?.target, "/items/a%2Fb");
  });

  it("refuses to build a path with a missing parameter", async () => {
    const { rest } = client({});
    await assert.rejects(
      () => rest.request({ route: route("get", "/items/:id"), params: {} }),
      /needs a "id" path parameter/,
    );
  });
});

describe("the three failure classes", () => {
  it("class 1: a refusal the server answered with a problem document", async () => {
    const { rest } = client({
      "GET /items": { status: 403, json: problemBody("insufficient-scope", 403, "No scope.") },
    });
    await assert.rejects(
      () => rest.request({ route: route("get", "/items") }),
      (error: unknown) => {
        assert.ok(error instanceof ApiRefusal);
        assert.equal(error.problem.status, 403);
        assert.equal(problemSlug(error.problem.type), "insufficient-scope");
        // A refusal IS an answer, so core's transport predicate must say so.
        assert.equal(isTransportFailure(error), false);
        return true;
      },
    );
  });

  it("class 2: no answer at all", async () => {
    const rest = createRestClient({
      baseUrl: BASE,
      token: "sk_test",
      clientId: "starter-mcp",
      fetchImpl: (() => {
        const error = new TypeError("fetch failed");
        (error as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
        return Promise.reject(error);
      }) as unknown as typeof fetch,
    });
    await assert.rejects(
      () => rest.request({ route: route("get", "/me") }),
      (error: unknown) => {
        assert.ok(error instanceof ApiUnreachable);
        // Core's predicate is "not an ApiError" == "no answer came back".
        assert.equal(isTransportFailure(error), true);
        assert.match(error.message, /Nothing is listening/);
        return true;
      },
    );
  });

  it("class 3: an answer that is not this API", async () => {
    const { rest } = client({
      "GET /me": {
        status: 502,
        raw: "<html><head><title>502 Bad Gateway</title></head></html>",
        contentType: "text/html",
      },
    });
    await assert.rejects(
      () => rest.request({ route: route("get", "/me") }),
      (error: unknown) => {
        assert.ok(error instanceof ApiNotThisApi);
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "PARSE_ERROR");
        assert.match(error.bodyPreview, /502 Bad Gateway/);
        return true;
      },
    );
  });

  it("class 3 also covers JSON from something that is not this API", async () => {
    // An API gateway's own error envelope: JSON, an error status, and not a
    // problem document. Reporting it as a refusal would send the user looking
    // at their token.
    const { rest } = client({ "GET /me": { status: 503, json: { message: "upstream down" } } });
    await assert.rejects(
      () => rest.request({ route: route("get", "/me") }),
      (error: unknown) => error instanceof ApiNotThisApi,
    );
  });

  it("clips the body preview so an error page cannot fill a tool result", async () => {
    const { rest } = client({
      "GET /me": { status: 500, raw: "x".repeat(10_000), contentType: "text/html" },
    });
    await assert.rejects(
      () => rest.request({ route: route("get", "/me") }),
      (error: unknown) => (error as ApiNotThisApi).bodyPreview.length <= 200,
    );
  });
});

describe("transport failure descriptions", () => {
  const cases: [string, RegExp][] = [
    ["ENOTFOUND", /does not resolve/],
    ["ECONNREFUSED", /Nothing is listening/],
    ["UND_ERR_CONNECT_TIMEOUT", /timed out/],
    ["CERT_HAS_EXPIRED", /certificate/],
  ];
  for (const [code, expected] of cases) {
    it(`digs ${code} out of the wrapped error`, () => {
      const wrapped = new TypeError("fetch failed");
      (wrapped as { cause?: unknown }).cause = new Error("inner", { cause: { code } });
      assert.match(describeTransportFailure(wrapped, "https://x.test", 20), expected);
    });
  }

  it("names the timeout rather than the generic failure", () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "TimeoutError";
    assert.match(describeTransportFailure(aborted, "https://x.test", 1234), /within 1234ms/);
  });

  it("still says something useful for a cause it has never seen", () => {
    const message = describeTransportFailure(new Error("weird"), "https://x.test", 20);
    assert.match(message, /https:\/\/x\.test/);
    assert.match(message, /weird/);
  });
});

describe("problem hints", () => {
  it("gives every refusal this API can answer with exactly one actionable sentence", () => {
    const slugs = [
      "invalid-token",
      "insufficient-scope",
      "tenant-not-addressable",
      "rate-limited",
      "invalid-request",
      "forbidden",
      "not-found",
      "conflict",
      "payload-too-large",
      "internal-error",
    ];
    const seen = new Set<string>();
    for (const slug of slugs) {
      const hint = hintForProblem({
        type: `https://docs.example/problems/${slug}`,
        title: "Refused",
        status: 400,
        detail: "",
        instance: "/",
      });
      assert.ok(hint.length > 0, `${slug} has a hint`);
      assert.equal(seen.has(hint), false, `${slug} does not share a sentence with another slug`);
      seen.add(hint);
    }
  });

  it("falls back on the status family for a slug it has never heard of", () => {
    const hint = hintForProblem({
      type: "https://docs.example/problems/brand-new-refusal",
      title: "Refused",
      status: 403,
      detail: "",
      instance: "/",
    });
    assert.match(hint, /permission/);
  });

  it("matches on the slug, not the documentation base, which projects change", () => {
    assert.equal(problemSlug("https://a.example/problems/not-found"), "not-found");
    assert.equal(problemSlug("https://b.invalid/docs/api/problems/not-found?v=2"), "not-found");
  });
});
