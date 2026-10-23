#!/usr/bin/env node
/*
 * @hatchkit/mcp — Model Context Protocol server for hatchkit.
 *
 * Exposes a small set of read-only, machine-readable tools that any
 * MCP-compatible client (Claude Desktop, Cursor, etc.) can call to
 * inspect the user's hatchkit state without scraping CLI output.
 *
 * Implementation: shells out to the `hatchkit` binary with `--json`.
 * Kept intentionally thin — the CLI is the source of truth. If the
 * user upgrades hatchkit, the MCP server automatically inherits any
 * new fields in the JSON payloads.
 *
 * Destructive commands (`create`, `setup`, `config add`, `config reset`)
 * are deliberately NOT exposed — those are interactive and state-
 * mutating; the user runs them directly.
 */

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseHatchkitResult, runHatchkit, scrubCliDiagnostic } from "./cli-bridge.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "hatchkit_status",
    description:
      "Returns a StatusSnapshot — which providers are configured, the next best step, and suggested commands. Run this first when the user asks about their hatchkit state.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "hatchkit_doctor",
    description:
      "Runs read-only provider, project and host health checks. Returns per-check health and contextual `hint` arrays. Native keychain access is denied by default under MCP, so credential-dependent checks can be skipped and unverified. Do not treat an unverified check as healthy or enable credential access without the user's authorization.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "hatchkit_explain",
    description:
      "Returns the hatchkit mental model — concepts, commands, canonical workflows, provider glossary, state locations. Useful for orienting an agent that has no prior context.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "hatchkit_keys_show",
    description:
      "Returns the dotenvx private key for a project from the OS keychain. Call only when the user explicitly requests that secret. Native keychain access needs intentional host configuration; the default denies unattended access. Returns `{ project, found: false, error }` if no key is stored, or an error if access is blocked. The key is a live secret.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Kebab-case project name (matches the scaffolded directory name).",
        },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server(
  {
    name: "hatchkit-mcp",
    version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
  },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    if (name === "hatchkit_status") {
      return jsonToolResponse(parseHatchkitResult(await runHatchkit(["status", "--json"])));
    }
    if (name === "hatchkit_doctor") {
      const res = await runHatchkit(["doctor", "--json"]);
      // doctor exits non-zero when checks fail — still return the parsed payload.
      return jsonToolResponse(parseHatchkitResult(res));
    }
    if (name === "hatchkit_explain") {
      return jsonToolResponse(parseHatchkitResult(await runHatchkit(["explain", "--json"])));
    }
    if (name === "hatchkit_keys_show") {
      const project = (args as { project?: unknown })?.project;
      if (typeof project !== "string" || !project) {
        throw new Error("`project` (string) is required");
      }
      const res = await runHatchkit(["keys", "show", project, "--json"]);
      return jsonToolResponse(parseHatchkitResult(res));
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    const message = scrubCliDiagnostic(err instanceof Error ? err.message : String(err));
    return {
      isError: true,
      content: [{ type: "text", text: message }],
    };
  }
});

function jsonToolResponse(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdin closes. No stdout logging — reserved for MCP traffic.
}

main().catch((err) => {
  console.error(`hatchkit-mcp failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
