/*
 * The slow tier: the BUILT binary, over a real stdio pipe.
 *
 * The fast tier connects in memory to the server factory, which proves the
 * tool list and every refusal. What it cannot prove is that the process
 * starts, that the transport survives the startup banner, and that nothing in
 * it writes to stdout — and a stray stdout write is the one failure that
 * presents to a user as "the server crashed" with nothing to read.
 *
 * Skips, loudly, when `dist/` is not there. `pnpm --filter @starter/mcp run
 * build` first.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ORIGIN_VAR, TOKEN_VAR } from "../../config.js";
import { SERVER_NAME, SERVER_VERSION } from "../../identity.js";
import { TOOL_DEFINITIONS } from "../../tools.js";
import { type LocalApi, startLocalApi } from "./local-api.js";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BINARY = join(PACKAGE_DIR, "dist", "index.js");

/** A deployment the suite was pointed at by hand, instead of the stand-in. */
const EXTERNAL_ORIGIN = process.env.MCP_IT_API_URL;
const EXTERNAL_TOKEN = process.env.MCP_IT_API_TOKEN;

const built = existsSync(BINARY);

async function connect(env: Record<string, string>): Promise<{
  client: Client;
  stderr: string[];
  close(): Promise<void>;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BINARY],
    env: { PATH: process.env.PATH ?? "", ...env },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

  const client = new Client({ name: "integration", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr, close: () => client.close() };
}

describe("the built binary over stdio", { skip: built ? false : `${BINARY} is not built` }, () => {
  let api: LocalApi;
  let origin: string;
  let token: string;

  before(async () => {
    if (EXTERNAL_ORIGIN !== undefined && EXTERNAL_TOKEN !== undefined) {
      origin = EXTERNAL_ORIGIN;
      token = EXTERNAL_TOKEN;
      return;
    }
    api = await startLocalApi(["items:read", "items:write"]);
    origin = api.origin;
    token = api.token;
  });

  after(async () => {
    // Also removes the throwaway data directory, so a failed run leaves
    // nothing a later run could read.
    if (api !== undefined) await api.stop();
  });

  it("serves the probed tool list and nothing it cannot call", async () => {
    const { client, stderr, close } = await connect({
      [TOKEN_VAR]: token,
      [ORIGIN_VAR]: origin,
    });
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [
        "create_item",
        "delete_item",
        "get_item",
        "get_token_info",
        "list_items",
        "update_item",
      ]);
      assert.deepEqual(client.getServerVersion(), {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      });
      // The banner is on stderr. If it had gone to stdout the handshake above
      // would already have failed, which is the point of asserting it here.
      assert.match(stderr.join(""), new RegExp(`${SERVER_NAME} ${SERVER_VERSION}`));
      assert.match(stderr.join(""), /capabilities: items:read, items:write/);
    } finally {
      await close();
    }
  });

  it("reads and deletes through the real transport", async () => {
    const { client, close } = await connect({ [TOKEN_VAR]: token, [ORIGIN_VAR]: origin });
    try {
      const listed = (await client.callTool({
        name: "list_items",
        arguments: {},
      })) as CallToolResult;
      const first = JSON.parse(text(listed)).data[0] as { id: string };
      assert.ok(typeof first.id === "string");

      const deleted = (await client.callTool({
        name: "delete_item",
        arguments: { id: first.id },
      })) as CallToolResult;
      assert.notEqual(deleted.isError, true);
    } finally {
      await close();
    }
  });

  it("offers every tool when the probe fails, instead of exiting", async () => {
    const { client, stderr, close } = await connect({
      [TOKEN_VAR]: "sk_not_a_real_token",
      [ORIGIN_VAR]: origin,
    });
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, TOOL_DEFINITIONS.length);
      assert.match(stderr.join(""), /capabilities: unknown/);

      // And the call carries the real reason, which is the whole argument for
      // staying up: a host that saw the process exit would report nothing.
      const result = (await client.callTool({
        name: "list_items",
        arguments: {},
      })) as CallToolResult;
      assert.equal(result.isError, true);
      assert.match(text(result), /HTTP 401/);
      assert.match(text(result), /Check the token/);
    } finally {
      await close();
    }
  });

  it("refuses a missing credential with one sentence on stderr, and writes nothing to stdout", async () => {
    const child = spawn(process.execPath, [BINARY], {
      env: { PATH: process.env.PATH ?? "", [ORIGIN_VAR]: origin },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));

    assert.equal(code, 1);
    assert.equal(out, "", "stdout belongs to the protocol, even on the failure path");
    assert.match(err, new RegExp(TOKEN_VAR));
    assert.match(err, /apiTokens\.create/);
  });
});

const text = (result: CallToolResult): string =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
