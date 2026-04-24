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

import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const HATCHKIT_BIN = process.env.HATCHKIT_BIN ?? "hatchkit";

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runHatchkit(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(HATCHKIT_BIN, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            `Could not find \`${HATCHKIT_BIN}\` on PATH. Install hatchkit (e.g. \`pnpm add -g hatchkit\`) or set HATCHKIT_BIN.`,
          ),
        );
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

/** Parse a JSON payload from the end of stdout. The CLI prefixes a
 *  banner on some non-JSON runs, so we find the first `{` or `[`. */
function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  const start = Math.min(
    ...[trimmed.indexOf("{"), trimmed.indexOf("[")].filter((i) => i >= 0),
  );
  if (!Number.isFinite(start)) {
    throw new Error(`hatchkit produced no JSON:\n${stdout}`);
  }
  return JSON.parse(trimmed.slice(start));
}

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
      "Live-verifies every configured provider with a read-only API call. Returns per-provider health plus `hint` arrays with contextual fix steps (credential rotation URL, required scopes, exact `hatchkit config add <x>` to re-run) for any failing check.",
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
      "Returns the dotenvx private key for a project from the OS keychain. Returns `{ project, found: false, error }` if no key is stored. CAUTION: the key is a live secret — treat output accordingly.",
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
  { name: "hatchkit-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    if (name === "hatchkit_status") {
      const { stdout } = await runHatchkit(["status", "--json"]);
      return jsonToolResponse(parseJsonOutput(stdout));
    }
    if (name === "hatchkit_doctor") {
      const res = await runHatchkit(["doctor", "--json"]);
      // doctor exits non-zero when checks fail — still return the parsed payload.
      return jsonToolResponse(parseJsonOutput(res.stdout));
    }
    if (name === "hatchkit_explain") {
      const { stdout } = await runHatchkit(["explain", "--json"]);
      return jsonToolResponse(parseJsonOutput(stdout));
    }
    if (name === "hatchkit_keys_show") {
      const project = (args as { project?: unknown })?.project;
      if (typeof project !== "string" || !project) {
        throw new Error("`project` (string) is required");
      }
      const res = await runHatchkit(["keys", "show", project, "--json"]);
      return jsonToolResponse(parseJsonOutput(res.stdout));
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
