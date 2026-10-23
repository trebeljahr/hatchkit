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
| `hatchkit_doctor` | `{ summary, checks[] }` with fix hints and explicit skipped/unverified checks |
| `hatchkit_explain` | Mental model: concepts, commands, workflows, state |
| `hatchkit_keys_show` | `{ project, found, key }` when found; `{ project, found: false, error }` when absent; an error when access is blocked |

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

## Host configuration

For hosts that use an `mcpServers` JSON object:

```json
{
  "mcpServers": {
    "hatchkit": {
      "command": "hatchkit-mcp",
      "env": { "HATCHKIT_KEYCHAIN_ACCESS": "deny" }
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
      "env": {
        "HATCHKIT_BIN": "/Users/you/.local/bin/hatchkit",
        "HATCHKIT_KEYCHAIN_ACCESS": "deny"
      }
    }
  }
}
```

The bridge starts the CLI without interactive stdin. Native keychain access is
therefore denied by default, including when launched from a terminal. Status
and explain remain available; doctor marks blocked credential checks as
unverified, and keys show reports an access error. A configured provider is not
necessarily verified.

If the operator explicitly authorizes this host to read stored credentials,
they can change its `HATCHKIT_KEYCHAIN_ACCESS` value to `allow` and restart the
server. This permits native keychain access; it does not bypass OS access
controls. Do not enable it automatically or retry a denied read. For a single
credential-dependent diagnosis, the operator can instead run the CLI in an
interactive terminal. Call `hatchkit_keys_show` only when the user explicitly
requests that private key.

## How it works

The server shells out to the `hatchkit` binary with `--json` and parses
stdout. Kept intentionally thin — the CLI is the source of truth, and
upgrading hatchkit automatically extends the MCP payloads with any new
fields.

Valid JSON is returned even when doctor reports failures or a requested key is
absent. If the CLI produces no JSON, the tool returns its exit status and a
bounded diagnostic with common credential forms redacted. Requested key JSON
is intentionally preserved as a secret-bearing result.

## Dev

```bash
cd mcp
pnpm install
pnpm run dev        # tsx src/index.ts (stdio)
pnpm run build      # tsc → dist/
pnpm run typecheck
pnpm test            # local CLI bridge behavior; no provider credentials
```
