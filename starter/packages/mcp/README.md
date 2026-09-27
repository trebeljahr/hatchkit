# `@starter/mcp` — the MCP server

A server that lets an MCP host read and change this project's records through
the public REST API, using a scoped API token you mint yourself.

It speaks MCP over stdio. The host starts it as a child process; there is no
port, no daemon and no browser sign-in.

## What it does

Ten tools over `/api/v1`: read, create, edit and delete items, and manage
webhook subscriptions and read their delivery attempts. Which of the ten your
host sees depends on the token — see the capability table below.

## What it does not do

- **No sign-in.** It authenticates with a token you paste, and nothing else.
  It cannot mint, rotate or revoke one.
- **No tenant or membership management**, and no access to anything the public
  API has no route for. This server is a client of that surface and can never
  do more than it does.
- **No published package.** The only install path is this repository: you build
  the package here and point your host at the file. There is nothing to
  `npm install`.
- **One language.** Every string it emits is English.

## Requirements

- The public REST API feature, enabled on the server this points at. Without
  `/api/v1` there is nothing for the tools to call.
- Node 24 or newer, and this repository installed with `pnpm install`.

## 1. Mint a credential

Tokens are minted from the web app's typed API, which returns the plaintext
once and never again:

```ts
await trpc.apiTokens.create.mutate({
  label: "mcp",
  scopes: ["items:read", "items:write"],
});
```

Give it the smallest set of capabilities you need. Each one unlocks exactly
these tools, and a tool your token cannot call is not offered to the model at
all rather than failing when it is used:

<!-- capability-table:begin -->
| Capability | Tools |
| --- | --- |
| _none — any valid token_ | `get_token_info` |
| `items:read` | `list_items`, `get_item` |
| `items:write` | `create_item`, `update_item`, `delete_item` |
| `webhooks:read` | `list_webhooks`, `list_webhook_deliveries` |
| `webhooks:write` | `create_webhook`, `delete_webhook` |
<!-- capability-table:end -->

`delete_item` also reads the item's title before deleting it, when the token
carries `items:read`, so the result can say what was removed. Without that
capability it just deletes.

**The token is stored in plain text** in your host's configuration file, which
is an ordinary file on your disk with no encryption. Treat it like a password:
give it the fewest capabilities that work, and revoke it from the web app's
API-token settings when the integration is finished or the machine changes
hands. Revoking takes effect on the token's next request.

## 2. Build

```bash
pnpm install
pnpm --filter @starter/mcp run build
```

This writes `packages/mcp/dist/index.js`, which is the file your host runs.

## 3. Verify, before you configure anything

Do this step first. A misconfigured stdio server tells its host nothing except
that the process exited, which cannot be diagnosed from inside the host — so
find out here, where the error is printed.

```bash
STARTER_API_TOKEN=<your token> \
  node packages/mcp/dist/index.js < /dev/null
```

A working configuration prints one line to stderr and exits:

```
starter-mcp 0.1.0 → http://localhost:5000 · 10 tool(s) · capabilities: items:read, items:write, webhooks:read, webhooks:write
```

The origin, the tool count and the capability list are what your host will get.
If the line says `capabilities: unknown (…)`, the server could not reach the
API or the API refused the token: it still starts and still offers every tool,
and the first tool call will report the real reason. If nothing prints except a
single sentence naming an environment variable, that sentence is the fix.

## 4. Configure your host

Add an entry to your MCP host's configuration file. The shape below is the one
every host that launches stdio servers uses:

```json
{
  "mcpServers": {
    "starter": {
      "command": "node",
      "args": ["/absolute/path/to/this/repo/packages/mcp/dist/index.js"],
      "env": {
        "STARTER_API_TOKEN": "<your token>"
      }
    }
  }
}
```

Against a deployment other than the default origin — a self-hosted install, a
staging environment, or a local server on a different port — add the origin:

```json
{
  "mcpServers": {
    "starter": {
      "command": "node",
      "args": ["/absolute/path/to/this/repo/packages/mcp/dist/index.js"],
      "env": {
        "STARTER_API_TOKEN": "<your token>",
        "STARTER_API_URL": "https://api.example.com"
      }
    }
  }
}
```

Restart the host after editing the file. Hosts read this configuration once, at
startup.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `STARTER_API_TOKEN` | yes | The scoped API token, in plaintext. |
| `STARTER_API_URL` | no | The API origin. Defaults to `http://localhost:5000`. |

`STARTER_API_URL` accepts the three spellings of one origin — `https://host`,
`https://host/` and `https://host/api/v1` all mean the same deployment. A value
that is not an `http` or `https` URL is refused rather than guessed at: adding
a scheme for you would mean choosing one, and choosing `http` would send the
token in clear text.

## Development

```bash
pnpm --filter @starter/mcp run typecheck   # sources and tests
pnpm --filter @starter/mcp run test        # unit tier: fake API, in-memory client
pnpm --filter @starter/mcp run build
pnpm --filter @starter/mcp run test:integration   # the built binary over stdio
```

This package is outside the main build graph: nothing in the root `build`
imports it, so a change that breaks it compiles green through the rest of the
pipeline. The root `typecheck` and `lint` scripts reach it because they run
recursively over every workspace package, but the root `test:unit` names its
packages one at a time and has to name this one too.
