# @hatchkit/mcp

Model Context Protocol server for [hatchkit](../README.md). Exposes the
machine-readable subset of the CLI as MCP tools so any MCP-compatible
client (Claude Desktop, Cursor, Claude Code) can inspect the user's
hatchkit state without scraping CLI output.

## Tools

| Tool | Returns |
|---|---|
| `hatchkit_status` | `StatusSnapshot` — providers, next step, suggestions |
| `hatchkit_doctor` | `{ summary, checks[] }` with `hint[]` on failures |
| `hatchkit_explain` | Mental model: concepts, commands, workflows, state |
| `hatchkit_keys_show` | `{ project, found, key }` — dotenvx private key |

The server is **read-only**. Destructive commands (`create`, `setup`,
`config add`, `config reset`) are deliberately not exposed — those are
interactive and state-mutating; the user runs them directly.

## Install

```bash
pnpm add -g hatchkit @hatchkit/mcp
```

Or use `npx`-style invocation from your MCP client config.

## Claude Desktop / Claude Code config

```json
{
  "mcpServers": {
    "hatchkit": {
      "command": "hatchkit-mcp"
    }
  }
}
```

If `hatchkit` is not on the MCP server's PATH, set `HATCHKIT_BIN`:

```json
{
  "mcpServers": {
    "hatchkit": {
      "command": "hatchkit-mcp",
      "env": { "HATCHKIT_BIN": "/Users/you/.local/bin/hatchkit" }
    }
  }
}
```

## How it works

The server shells out to the `hatchkit` binary with `--json` and parses
stdout. Kept intentionally thin — the CLI is the source of truth, and
upgrading hatchkit automatically extends the MCP payloads with any new
fields.

## Dev

```bash
cd mcp
pnpm install
pnpm run dev        # tsx src/index.ts (stdio)
pnpm run build      # tsc → dist/
pnpm run typecheck
```
