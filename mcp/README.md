# @hatchkit/mcp

Model Context Protocol server for [hatchkit](../README.md). Exposes the
machine-readable subset of the CLI as MCP tools so any MCP-compatible
client (Claude Desktop, Cursor, Claude Code) can inspect the user's
hatchkit state without scraping CLI output.

This is the **operator MCP server**. The optional `mcp` feature generated
inside an app is a separate server for that app's `/api/v1` records. The
two servers have separate credentials and can be installed independently.
See the [MCP guide](https://hatchkit.trebeljahr.com/docs/mcp) for a comparison.

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
# From a Hatchkit source checkout:
pnpm install --frozen-lockfile
pnpm --filter hatchkit run build
pnpm --filter @hatchkit/mcp run build
node mcp/dist/index.js
```

Earlier releases published only the CLI. If npm cannot find the operator package, use the source build above. Configure your host with `node` plus the absolute path to `mcp/dist/index.js`. Put `hatchkit` on PATH or set `HATCHKIT_BIN` to the absolute path to `cli/dist/index.js`. The release flow publishes CLI and operator packages together.

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
pnpm test            # local CLI bridge behavior; no provider credentials
```
