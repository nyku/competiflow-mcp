# Competiflow MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes [Competiflow](https://competiflow.com) competitor monitoring as tools for Cursor, Claude Desktop, and other MCP clients.

Track competitors, run discovery, read the change feed, triage items, and pull workspace digests from your AI client.

## Installation

```bash
npm install -g @competiflow/mcp-server
```

Or run with `npx`:

```bash
COMPETIFLOW_API_KEY=sk_live_... npx @competiflow/mcp-server
```

## Configuration

Create an API key in the Competiflow dashboard under **API keys**.

| Variable | Required | Description |
| --- | --- | --- |
| `COMPETIFLOW_API_KEY` | yes | Your `sk_live_...` API key |

### Cursor / Claude Desktop

Add to your MCP config (`~/.cursor/mcp.json` or Claude Desktop config):

```json
{
  "mcpServers": {
    "competiflow": {
      "command": "npx",
      "args": ["-y", "@competiflow/mcp-server"],
      "env": {
        "COMPETIFLOW_API_KEY": "sk_live_..."
      }
    }
  }
}
```

## Tools

| Tool | API | Description |
| --- | --- | --- |
| `list_workspaces` | `GET /v1/workspaces` | List workspaces with review counts |
| `create_workspace` | `POST /v1/workspaces` | Create a workspace |
| `add_competitor` | `POST /v1/workspaces/:id/competitors` | Add competitor (async discovery, idempotent on duplicate URL) |
| `list_competitors` | `GET /v1/workspaces/:id/competitors` | List competitors with monitors and `last_run` |
| `get_competitor` | `GET /v1/competitors/:id` | Read one competitor |
| `update_competitor` | `PATCH /v1/competitors/:id` | Set cadence or status on all monitors |
| `delete_competitor` | `DELETE /v1/competitors/:id` | Remove competitor and all history |
| `list_monitors` | `GET /v1/monitors` | List monitors with health and cadence |
| `get_monitor` | `GET /v1/monitors/:id` | Read one monitor, optional `include` for capture |
| `create_monitor` | `POST /v1/monitors` | Add a manual monitor |
| `update_monitor` | `PATCH /v1/monitors/:id` | Update cadence, status, or URL |
| `delete_monitor` | `DELETE /v1/monitors/:id` | Remove monitor and all history |
| `check_monitor` | `POST /v1/monitors/:id/check` | On-demand check (async) |
| `refresh_workspace` | `POST /v1/workspaces/:id/refresh` | Queue checks for active monitors |
| `list_changes` | `GET /v1/changes` | Change feed with `since`, filters, and `meta` |
| `get_change` | `GET /v1/changes/:id` | Full change, optional `include` for evidence |
| `update_change` | `PATCH /v1/changes/:id` | Set `review_status` |
| `get_digest` | `GET /v1/workspaces/:id/digest` | Workspace digest |

## Typical flow

1. `list_workspaces` or `create_workspace`
2. `add_competitor` with a homepage URL
3. `get_competitor` until `discovery_status` is `completed`
4. `list_changes` with `since=7d` or `get_digest`
5. `update_change` to acknowledge or dismiss items

`add_competitor` and `check_monitor` return an acknowledgement, not the final result. Read outcomes via `list_changes` or `get_digest`.

`delete_monitor` and `delete_competitor` remove history. Use `update_monitor` or `update_competitor` with `status: paused` to keep data.

## Development

```bash
npm install
npm run build
COMPETIFLOW_API_KEY=sk_live_... node dist/index.js
```

## License

MIT
