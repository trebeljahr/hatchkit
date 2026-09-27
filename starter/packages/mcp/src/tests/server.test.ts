/*
 * The fast tier: an in-memory MCP client connected to the SAME factory the
 * binary connects to stdio. A test that assembled its own server would prove
 * nothing about what ships.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createRestClient } from "../client.js";
import { API_BASE_PATH } from "../config.js";
import { SERVER_NAME, SERVER_VERSION } from "../identity.js";
import type { ApiTokenScope } from "../routes.js";
import { buildServer, probeCapabilities, startupLine } from "../server.js";
import { TOOL_DEFINITIONS } from "../tools.js";
import { type FakeAnswer, createFakeApi, problemBody } from "./fake-api.js";

const ORIGIN = "https://api.example.test";
const BASE = `${ORIGIN}${API_BASE_PATH}`;

function identity(scopes: readonly ApiTokenScope[]): FakeAnswer {
  return {
    json: {
      data: {
        tokenId: "tok_1",
        tenantId: "ten_1",
        userId: "usr_1",
        scopes,
        permissions: [],
      },
    },
  };
}

async function connect(answers: Record<string, FakeAnswer | ((call: never) => FakeAnswer)>) {
  const fake = createFakeApi(BASE, answers as Parameters<typeof createFakeApi>[1]);
  const built = await buildServer(
    { origin: ORIGIN, baseUrl: BASE, token: "sk_test" },
    { fetchImpl: fake.fetchImpl },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { ...built, client, fake };
}

const textOf = (result: CallToolResult): string =>
  result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");

describe("what the server announces", () => {
  it("declares its name, version and instructions", async () => {
    const { client } = await connect({ "GET /me": identity([]) });
    assert.deepEqual(client.getServerVersion(), { name: SERVER_NAME, version: SERVER_VERSION });
    const instructions = client.getInstructions() ?? "";
    // The five things a model gets wrong without them.
    assert.match(instructions, /ITEM/);
    assert.match(instructions, /WEBHOOK SUBSCRIPTION/);
    assert.match(instructions, /list_items or get_item before update_item/);
    assert.match(instructions, /ISO-8601 in UTC/);
    assert.match(instructions, /does not sign anyone in/);
  });
});

describe("capability probing", () => {
  it("offers every tool to a credential that carries every capability", async () => {
    const { client, probe } = await connect({
      "GET /me": identity(["items:read", "items:write", "webhooks:read", "webhooks:write"]),
    });
    assert.equal(probe.known, true);
    const { tools } = await client.listTools();
    assert.equal(tools.length, TOOL_DEFINITIONS.length);
  });

  it("does not register a tool the credential cannot call", async () => {
    const { client } = await connect({ "GET /me": identity(["items:read"]) });
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["get_item", "get_token_info", "list_items"]);
  });

  it("offers nothing but the free tool to a credential with no capabilities", async () => {
    const { client } = await connect({ "GET /me": identity([]) });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(names, ["get_token_info"]);
  });

  it("ignores a scope this build has never heard of", async () => {
    const { probe } = await connect({
      "GET /me": {
        json: { data: { scopes: ["items:read", "reports:read"], tenantId: "ten_1" } },
      },
    });
    assert.equal(probe.known, true);
    assert.deepEqual(probe.known ? [...probe.scopes] : [], ["items:read"]);
  });

  it("offers EVERY tool when the probe fails, and does not exit", async () => {
    // A host that sees the server exit reports "server exited" and nothing
    // else. A registered tool's call comes back with the real reason.
    const { client, probe } = await connect({
      "GET /me": { status: 401, json: problemBody("invalid-token", 401, "Bad credential.") },
    });
    assert.equal(probe.known, false);
    const { tools } = await client.listTools();
    assert.equal(tools.length, TOOL_DEFINITIONS.length);
  });

  it("treats an identity answer with no scope list as unknown", async () => {
    const { probe } = await connect({ "GET /me": { json: { data: { tenantId: "ten_1" } } } });
    assert.equal(probe.known, false);
    assert.match(probe.known ? "" : probe.reason, /scope list/);
  });

  it("says in the startup line which way it went", async () => {
    const good = await connect({ "GET /me": identity(["items:read"]) });
    assert.match(
      startupLine({ origin: ORIGIN, baseUrl: BASE, token: "x" }, good.probe, good.toolNames),
      /3 tool\(s\) · capabilities: items:read/,
    );

    const bad = await connect({ "GET /me": { status: 500, json: problemBody("internal-error", 500, "boom") } });
    assert.match(
      startupLine({ origin: ORIGIN, baseUrl: BASE, token: "x" }, bad.probe, bad.toolNames),
      /capabilities: unknown \(.*\) — offering every tool/,
    );
  });
});

describe("calling a tool", () => {
  it("returns the API's payload as JSON text", async () => {
    const { client } = await connect({
      "GET /me": identity(["items:read"]),
      "GET /items": { json: { data: [{ id: "i1", title: "One" }], nextCursor: null } },
    });
    const result = (await client.callTool({
      name: "list_items",
      arguments: { limit: 1 },
    })) as CallToolResult;
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(textOf(result)), {
      data: [{ id: "i1", title: "One" }],
      nextCursor: null,
    });
  });

  it("returns a refusal as an error RESULT with the actionable sentence", async () => {
    // A throw that escaped to the transport would read to the host as the
    // server dying rather than as one call failing.
    const { client } = await connect({
      "GET /me": { status: 503, json: problemBody("internal-error", 503, "down") },
      "GET /items": {
        status: 403,
        json: problemBody("insufficient-scope", 403, "This token does not carry `items:read`."),
      },
    });
    const result = (await client.callTool({ name: "list_items", arguments: {} })) as CallToolResult;
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /HTTP 403/);
    assert.match(text, /does not carry/);
    assert.match(text, /Mint a new token that carries it/);
  });

  it("reports the real reason when the probe failed and the call then fails too", async () => {
    const { client } = await connect({
      "GET /me": { status: 401, json: problemBody("invalid-token", 401, "Unknown credential.") },
      "GET /items": { status: 401, json: problemBody("invalid-token", 401, "Unknown credential.") },
    });
    const result = (await client.callTool({ name: "list_items", arguments: {} })) as CallToolResult;
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Check the token in your MCP host's configuration/);
  });

  it("does not let a body that is not this API look like a refusal", async () => {
    const { client } = await connect({
      "GET /me": identity(["items:read"]),
      "GET /items": { status: 404, raw: "<html>web app 404</html>", contentType: "text/html" },
    });
    const result = (await client.callTool({ name: "list_items", arguments: {} })) as CallToolResult;
    assert.equal(result.isError, true);
    assert.match(textOf(result), /instead of JSON/);
    assert.match(textOf(result), /web app 404/);
  });
});

describe("optional enrichment", () => {
  const deleteAnswers = (scopes: readonly ApiTokenScope[], itemRead: FakeAnswer) => ({
    "GET /me": identity(scopes),
    "GET /items/i1": itemRead,
    "DELETE /items/i1": { json: { data: { success: true, id: "i1" } } },
  });

  it("decorates the delete when the credential can read", async () => {
    const { client, fake } = await connect(
      deleteAnswers(["items:read", "items:write"], { json: { data: { id: "i1", title: "One" } } }),
    );
    const result = (await client.callTool({
      name: "delete_item",
      arguments: { id: "i1" },
    })) as CallToolResult;
    assert.equal(JSON.parse(textOf(result)).deletedTitle, "One");
    // The lookup has to happen BEFORE the delete: afterwards the row is gone.
    const order = fake.calls.map((call) => `${call.method} ${call.target}`);
    assert.ok(order.indexOf("GET /items/i1") < order.indexOf("DELETE /items/i1"));
  });

  it("does not attempt the lookup at all for a write-only credential", async () => {
    const { client, fake } = await connect(
      deleteAnswers(["items:write"], { json: { data: { id: "i1", title: "One" } } }),
    );
    const result = (await client.callTool({
      name: "delete_item",
      arguments: { id: "i1" },
    })) as CallToolResult;
    assert.equal("deletedTitle" in JSON.parse(textOf(result)), false);
    assert.equal(
      fake.calls.some((call) => call.method === "GET" && call.target === "/items/i1"),
      false,
      "no request is spent on a lookup the credential cannot make",
    );
  });

  it("drops a failed enrichment instead of reporting it", async () => {
    // The primary call succeeded, and that is what the result is about.
    const { client } = await connect(
      deleteAnswers(["items:read", "items:write"], {
        status: 500,
        json: problemBody("internal-error", 500, "boom"),
      }),
    );
    const result = (await client.callTool({
      name: "delete_item",
      arguments: { id: "i1" },
    })) as CallToolResult;
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(textOf(result)), { data: { success: true, id: "i1" } });
  });
});

describe("probeCapabilities on its own", () => {
  it("reports an unreachable API as unknown with the real cause", async () => {
    const rest = createRestClient({
      baseUrl: BASE,
      token: "sk_test",
      clientId: SERVER_NAME,
      fetchImpl: (() => {
        const error = new TypeError("fetch failed");
        (error as { cause?: unknown }).cause = { code: "ENOTFOUND" };
        return Promise.reject(error);
      }) as unknown as typeof fetch,
    });
    const probe = await probeCapabilities(rest);
    assert.equal(probe.known, false);
    assert.match(probe.known ? "" : probe.reason, /does not resolve/);
  });
});
