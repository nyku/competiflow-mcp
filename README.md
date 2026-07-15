# Competiflow MCP Server

[MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for [Competiflow](https://competiflow.com). Use competitor monitoring as tools in Cursor, Claude Desktop, Windsurf, and any MCP-compatible client.

Track competitors, run discovery, read the interpreted change feed, triage items, and pull workspace digests without leaving your AI client.

## Setup

Create an API key in the Competiflow dashboard under **API keys**, then add the server to your client config. `COMPETIFLOW_API_KEY` is the only variable you need.

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "competiflow": {
      "command": "npx",
      "args": ["-y", "@competiflow/mcp-server"],
      "env": {
        "COMPETIFLOW_API_KEY": "sk_live_your_key_here"
      }
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "competiflow": {
      "command": "npx",
      "args": ["-y", "@competiflow/mcp-server"],
      "env": {
        "COMPETIFLOW_API_KEY": "sk_live_your_key_here"
      }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "competiflow": {
      "command": "npx",
      "args": ["-y", "@competiflow/mcp-server"],
      "env": {
        "COMPETIFLOW_API_KEY": "sk_live_your_key_here"
      }
    }
  }
}
```

## Available Tools

| Tool | API | Description |
| --- | --- | --- |
| `list_workspaces` | `GET /v1/workspaces` | List workspaces with review counts |
| `create_workspace` | `POST /v1/workspaces` | Create a workspace |
| `add_competitor` | `POST /v1/workspaces/:id/competitors` | Add a competitor by homepage URL. Async discovery, idempotent on duplicate URL |
| `list_competitors` | `GET /v1/workspaces/:id/competitors` | List competitors with monitors and `last_run` |
| `get_competitor` | `GET /v1/competitors/:id` | Read one competitor |
| `update_competitor` | `PATCH /v1/competitors/:id` | Set cadence or status on all its monitors |
| `delete_competitor` | `DELETE /v1/competitors/:id` | Remove a competitor and all its history |
| `list_monitors` | `GET /v1/monitors` | List monitors with status, cadence, and `last_run` |
| `get_monitor` | `GET /v1/monitors/:id` | Read one monitor. Pass `include` for capture evidence |
| `create_monitor` | `POST /v1/monitors` | Add a manual monitor on a specific URL |
| `update_monitor` | `PATCH /v1/monitors/:id` | Update URL, cadence, status, or `min_severity` |
| `delete_monitor` | `DELETE /v1/monitors/:id` | Remove a monitor and all its history |
| `check_monitor` | `POST /v1/monitors/:id/check` | Queue an on-demand check |
| `refresh_workspace` | `POST /v1/workspaces/:id/refresh` | Queue checks for active monitors |
| `list_changes` | `GET /v1/changes` | Change feed with `since`, filters, and `meta` counts |
| `get_change` | `GET /v1/changes/:id` | Full change. Pass `include` for capture or raw diff |
| `update_change` | `PATCH /v1/changes/:id` | Set `review_status` |
| `get_digest` | `GET /v1/workspaces/:id/digest` | Weekly workspace summary |

## Typical flow

1. `list_workspaces` or `create_workspace`.
2. `add_competitor` with a homepage URL.
3. `get_competitor` until `discovery_status` is `completed`.
4. `refresh_workspace` or `check_monitor` to pull fresh data.
5. `list_changes` with `since=7d` and `min_severity`, or `get_digest` for a summary.
6. `get_change` with `include` when you need evidence.
7. `update_change` to acknowledge or dismiss items.

## Discovery and idempotency

`add_competitor` starts discovery in the background and returns an acknowledgement, not the finished result. Poll `get_competitor` until `discovery_status` is `completed`.

A workspace runs one discovery at a time. Posting the same homepage URL again returns the existing competitor without starting a second run. If a different competitor is still discovering, the call returns `409 discovery_in_progress` with `active_competitor_id` so you know which one to poll.

## Evidence with `include`

`get_change` and `get_monitor` accept an `include` array to attach the underlying capture in one call:

| Token | Available on | Returns |
| --- | --- | --- |
| `capture` | `get_change`, `get_monitor` | Extracted fields from the snapshot |
| `capture_markdown` | `get_change`, `get_monitor` | Page markdown from the snapshot |
| `raw_diff` | `get_change` | Before and after diff for the change |

For a change the capture is the post-change page. For a monitor it is the latest successful check, which is the current baseline.

## Delete versus pause

`delete_monitor` and `delete_competitor` are permanent. They remove the monitor or competitor along with its check runs, snapshots, and changes. To stop checks while keeping intel history, call `update_monitor` or `update_competitor` with `status: paused` instead.

## Agent guidelines (for AI clients)

- **Poll discovery, do not assume:** after `add_competitor`, poll `get_competitor` until `discovery_status` is `completed` before reading changes. On `409`, poll the `active_competitor_id` from the error.
- **Filter the feed:** pass `since` (`1d`, `7d`, `30d`, or ISO8601), `min_severity`, `monitor_type`, and `review_status` to `list_changes` instead of pulling everything. Use `meta.counts` for inbox totals and `next_cursor` to page.
- **Fetch evidence on demand:** only add `include` to `get_change` or `get_monitor` when you need the underlying capture. It adds payload.
- **Prefer pause over delete:** default to `status: paused` when a user wants to stop a monitor. Reserve `delete_*` for permanent removal, since it drops history.

## How it works

The server translates each tool call into a Competiflow v1 API request and returns structured JSON. Your agent sees interpreted changes, severity, and recommended actions instead of raw page scrapes.

```
AI Agent → MCP Tool Call → Competiflow API → Interpreted Change Feed → Structured Response → AI Agent
```

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `COMPETIFLOW_API_KEY` | Yes | Your Competiflow API key (`sk_live_...`) |

## Get an API key

Sign up at [competiflow.com](https://competiflow.com) and create a key under **API keys**.

## Development

```bash
npm install
npm run build
COMPETIFLOW_API_KEY=sk_live_... node dist/index.js
```

## License

MIT
