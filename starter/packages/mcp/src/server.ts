/*
 * Building the server, separately from running it.
 *
 * `index.ts` is the process: it reads the environment, opens stdio and exits.
 * Everything else is here, so the fast tests connect an in-memory client to
 * EXACTLY what the binary serves. A test that assembled its own server from
 * the same parts would pass while the binary shipped a different tool list —
 * which is the only failure mode that matters for a program whose entire job
 * is the tool list it announces.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ApiNotThisApi, ApiRefusal, ApiUnreachable, createRestClient } from "./client.js";
import type { RestClient } from "./client.js";
import type { McpConfig } from "./config.js";
import { PRODUCT_NAME, SERVER_NAME, SERVER_VERSION } from "./identity.js";
import { hintForProblem } from "./problems.js";
import { type ApiTokenScope, isApiTokenScope, route } from "./routes.js";
import { TOOL_DEFINITIONS, type ToolContext } from "./tools.js";

/**
 * What the model is told about this server before it calls anything.
 *
 * Five things, and each one is a mistake a model makes without it: what the
 * records are and how they relate; which lookup to run before a write; what
 * ambiguous values mean; what the server will not do; and that the tool list
 * it can see is already narrowed to what this credential may call.
 */
export const SERVER_INSTRUCTIONS = `${PRODUCT_NAME}'s public REST API, over a scoped API token.

Two kinds of record. An ITEM is one of the application's own records: it has a
title, an optional description and a status (draft, published or archived), and
it belongs to one member of one tenant. A WEBHOOK SUBSCRIPTION is an HTTPS
endpoint this tenant wants told when an item changes, plus the log of attempts
to reach it.

Call list_items or get_item before update_item or delete_item. Every write
addresses a record by the id a read returned, and an id from another tenant
answers "not found" rather than admitting that it exists — so a guessed id
reads exactly like a deleted one.

Timestamps are ISO-8601 in UTC and always end in Z. "limit" counts records, not
bytes or pages; leave it out and the server picks, and it caps whatever you
send. "cursor" is the nextCursor value from the previous page and nothing else.

This server does not sign anyone in, mint or revoke credentials, manage tenant
membership, or reach anything the public API has no route for. Its tool list is
already filtered to what this token may call, so a tool you cannot see is one
this credential was not granted rather than one that does not exist.`;

/** What the capability probe learned. */
export type ProbeOutcome =
  | { known: true; scopes: readonly ApiTokenScope[]; tenantId: string }
  | { known: false; reason: string };

type IdentityAnswer = {
  data?: { tenantId?: unknown; scopes?: unknown };
};

/**
 * Ask the API what this credential may do.
 *
 * Known capabilities mean a tool the credential cannot call is never
 * registered: a model that can see a tool will try it, and a refusal after the
 * fact costs the user a turn and a confusing message.
 *
 * A FAILED probe is not fatal, and that is the important half. Exiting here
 * would leave the host showing "server exited" with no reason — the one state
 * a user cannot debug from inside their host — while a registered tool's call
 * comes back with the real problem, in words, in the conversation. So a
 * failure is recorded and every tool is offered.
 */
export async function probeCapabilities(client: RestClient): Promise<ProbeOutcome> {
  try {
    const answer = await client.request<IdentityAnswer>({ route: route("get", "/me") });
    const raw = answer.data?.scopes;
    if (!Array.isArray(raw)) {
      return { known: false, reason: "the identity endpoint answered without a scope list" };
    }
    return {
      known: true,
      // A scope this build has never heard of is dropped rather than kept: it
      // cannot gate any tool here, and carrying it would make the startup line
      // claim a capability this server does nothing with.
      scopes: raw.filter(isApiTokenScope),
      tenantId: typeof answer.data?.tenantId === "string" ? answer.data.tenantId : "",
    };
  } catch (error) {
    return { known: false, reason: describeFailure(error).split("\n")[0] ?? "unknown error" };
  }
}

/**
 * One refusal, in the words a model can act on.
 *
 * Every branch names what to change. A model paraphrases this to a person, so
 * a result that said only "403" would be turned into a confident guess about
 * which of three unrelated causes it was.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof ApiRefusal) {
    return `${error.problem.title} (HTTP ${error.problem.status}): ${error.problem.detail}\n${hintForProblem(error.problem)}`;
  }
  if (error instanceof ApiNotThisApi) {
    return error.bodyPreview === ""
      ? error.message
      : `${error.message}\nThe answer began: ${error.bodyPreview}`;
  }
  if (error instanceof ApiUnreachable) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function textResult(text: string, isError?: true): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

export type CreateServerOptions = {
  client: RestClient;
  probe: ProbeOutcome;
  name?: string;
  version?: string;
};

/**
 * The server the binary serves, and the names of the tools on it.
 *
 * The tool list is filtered by the probe when the probe succeeded, and is
 * complete when it did not.
 */
export function createMcpServer(options: CreateServerOptions): {
  server: McpServer;
  toolNames: string[];
} {
  const { client, probe } = options;
  const server = new McpServer(
    { name: options.name ?? SERVER_NAME, version: options.version ?? SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const ctx: ToolContext = { client, scopes: probe.known ? probe.scopes : null };
  const toolNames: string[] = [];

  for (const definition of TOOL_DEFINITIONS) {
    const required = definition.route.scope;
    if (probe.known && required !== null && !probe.scopes.includes(required)) continue;

    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description:
          definition.route.summary +
          (required === null ? "" : ` Requires the \`${required}\` capability.`),
        inputSchema: definition.inputShape,
        annotations: definition.annotations,
      },
      // EVERY throw is caught here and returned as an error result. A throw
      // that escapes to the transport is reported by the host as the server
      // dying — the user is told the integration is broken when one call
      // failed for a reason the server was perfectly able to explain.
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const payload = await definition.run(ctx, (args ?? {}) as Record<string, unknown>);
          return textResult(JSON.stringify(payload, null, 2));
        } catch (error) {
          return textResult(describeFailure(error), true);
        }
      },
    );
    toolNames.push(definition.name);
  }

  return { server, toolNames };
}

/**
 * Everything the binary does except opening the transport.
 *
 * Returned rather than logged, so the process decides what to print and the
 * tests can read the same facts without parsing a banner.
 */
export async function buildServer(
  config: McpConfig,
  overrides: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ server: McpServer; probe: ProbeOutcome; toolNames: string[]; client: RestClient }> {
  const client = createRestClient({
    baseUrl: config.baseUrl,
    token: config.token,
    clientId: SERVER_NAME,
    fetchImpl: overrides.fetchImpl,
    timeoutMs: overrides.timeoutMs,
  });
  const probe = await probeCapabilities(client);
  const { server, toolNames } = createMcpServer({ client, probe });
  return { server, probe, toolNames, client };
}

/** The one line the host shows in its server log. */
export function startupLine(
  config: McpConfig,
  probe: ProbeOutcome,
  toolNames: readonly string[],
): string {
  const capabilities = probe.known
    ? probe.scopes.length === 0
      ? "none"
      : probe.scopes.join(", ")
    : `unknown (${probe.reason}) — offering every tool`;
  return `${SERVER_NAME} ${SERVER_VERSION} → ${config.origin} · ${toolNames.length} tool(s) · capabilities: ${capabilities}`;
}
