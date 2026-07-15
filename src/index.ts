#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/** Resolved at runtime from `dist/index.js` → repo `package.json`. */
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")) as { version: string }
).version;

const BASE_URL = "https://api.competiflow.com";
const API_KEY = process.env.COMPETIFLOW_API_KEY || "";

const workspaceId = z.union([z.string(), z.number()]).describe("Workspace id from list_workspaces or create_workspace");
const resourceId = z.union([z.string(), z.number()]);

const includeCapture = z
  .array(z.enum(["capture", "capture_markdown", "raw_diff"]))
  .optional()
  .describe("Optional evidence payloads for get_change or get_monitor");

/** Shown to MCP clients that support server instructions (e.g. Cursor). */
const MCP_AGENT_INSTRUCTIONS = `
Competiflow watches competitor websites and returns interpreted changes.

Typical flow:
1. list_workspaces or create_workspace.
2. add_competitor with a homepage URL. Discovery is async. Poll get_competitor until discovery_status is completed. If you get 409 discovery_in_progress, read active_competitor_id and poll that competitor.
3. refresh_workspace or check_monitor to pull fresh data.
4. list_changes with since and min_severity. Use meta.counts for inbox totals.
5. get_change with include capture or raw_diff when you need evidence.
6. update_change to triage (acknowledged or dismissed).
7. get_digest for a weekly summary.

add_competitor is idempotent on duplicate URLs. delete_monitor and delete_competitor remove history. Prefer update_monitor or update_competitor with status paused when you want to keep history.
`.trim();

interface ApiError {
  code?: string;
  message?: string;
  active_competitor_id?: number;
}

async function apiRequest<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) return {} as T;

  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status >= 400) {
    const err = json.error as ApiError | undefined;
    const extra = err?.active_competitor_id ? ` (active_competitor_id: ${err.active_competitor_id})` : "";
    throw new Error(`API error ${response.status}: ${err?.message || "Unknown error"}${extra}`);
  }
  return json as T;
}

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function buildQuery(params: Record<string, string | number | undefined>) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

const server = new McpServer(
  { name: "competiflow", version: PACKAGE_VERSION },
  { instructions: MCP_AGENT_INSTRUCTIONS },
);

server.tool(
  "list_workspaces",
  "GET /v1/workspaces. List workspaces with needs_review_count and monitor totals.",
  {},
  async () => text(await apiRequest("GET", "/v1/workspaces")),
);

server.tool(
  "create_workspace",
  "POST /v1/workspaces. Create a workspace for one product or market.",
  { name: z.string().describe("Workspace name") },
  async (params) => text(await apiRequest("POST", "/v1/workspaces", { name: params.name })),
);

server.tool(
  "add_competitor",
  "POST /v1/workspaces/:id/competitors. Add a competitor by homepage URL. Idempotent on duplicate URLs. Returns 409 with active_competitor_id when another discovery is running.",
  {
    workspace_id: workspaceId,
    url: z.string().describe("Competitor homepage URL"),
    monitor_types: z
      .array(z.enum(["blog", "changelog", "pricing", "docs", "homepage"]))
      .optional()
      .describe("Limit discovery to these surface types"),
  },
  async (params) => {
    const body: Record<string, unknown> = { url: params.url };
    if (params.monitor_types) body.monitor_types = params.monitor_types;
    return text(await apiRequest("POST", `/v1/workspaces/${params.workspace_id}/competitors`, body));
  },
);

server.tool(
  "list_competitors",
  "GET /v1/workspaces/:id/competitors. List competitors with discovery_status and nested monitors (includes last_run on each monitor).",
  { workspace_id: workspaceId },
  async (params) => text(await apiRequest("GET", `/v1/workspaces/${params.workspace_id}/competitors`)),
);

server.tool(
  "get_competitor",
  "GET /v1/competitors/:id. Read one competitor with monitors and discovery fields.",
  { competitor_id: resourceId.describe("Competitor id") },
  async (params) => text(await apiRequest("GET", `/v1/competitors/${params.competitor_id}`)),
);

server.tool(
  "update_competitor",
  "PATCH /v1/competitors/:id. Set cadence or status on all monitors for this competitor.",
  {
    competitor_id: resourceId,
    cadence: z.enum(["hourly", "six_hourly", "daily", "weekly"]).optional(),
    status: z.enum(["active", "paused"]).optional(),
  },
  async (params) => {
    const body: Record<string, unknown> = {};
    if (params.cadence) body.cadence = params.cadence;
    if (params.status) body.status = params.status;
    return text(await apiRequest("PATCH", `/v1/competitors/${params.competitor_id}`, body));
  },
);

server.tool(
  "delete_competitor",
  "DELETE /v1/competitors/:id. Permanently removes the competitor, its monitors, snapshots, and changes.",
  { competitor_id: resourceId },
  async (params) => text(await apiRequest("DELETE", `/v1/competitors/${params.competitor_id}`)),
);

server.tool(
  "list_monitors",
  "GET /v1/monitors. List monitors in a workspace with health, cadence, and last_run.",
  {
    workspace_id: workspaceId,
    competitor_id: resourceId.optional().describe("Filter to one competitor"),
  },
  async (params) => {
    const qs = buildQuery({
      workspace_id: params.workspace_id,
      competitor_id: params.competitor_id,
    });
    return text(await apiRequest("GET", `/v1/monitors${qs}`));
  },
);

server.tool(
  "get_monitor",
  "GET /v1/monitors/:id. Read one monitor. Pass include for capture or capture_markdown from the latest successful check.",
  {
    monitor_id: resourceId,
    include: includeCapture,
  },
  async (params) => {
    const include = params.include?.length ? params.include.join(",") : undefined;
    const qs = buildQuery({ include });
    return text(await apiRequest("GET", `/v1/monitors/${params.monitor_id}${qs}`));
  },
);

server.tool(
  "create_monitor",
  "POST /v1/monitors. Add a manual monitor on a specific URL.",
  {
    competitor_id: resourceId,
    url: z.string(),
    monitor_type: z.string(),
    cadence: z.enum(["hourly", "six_hourly", "daily", "weekly"]).optional(),
  },
  async (params) => {
    const body: Record<string, unknown> = {
      competitor_id: params.competitor_id,
      url: params.url,
      monitor_type: params.monitor_type,
    };
    if (params.cadence) body.cadence = params.cadence;
    return text(await apiRequest("POST", "/v1/monitors", body));
  },
);

server.tool(
  "update_monitor",
  "PATCH /v1/monitors/:id. Update url, monitor_type, cadence, status, or min_severity. Use status paused to keep history.",
  {
    monitor_id: resourceId,
    url: z.string().optional(),
    monitor_type: z.string().optional(),
    cadence: z.enum(["hourly", "six_hourly", "daily", "weekly"]).optional(),
    status: z.enum(["active", "paused"]).optional(),
    min_severity: z.enum(["info", "low", "medium", "high", "critical"]).optional(),
  },
  async (params) => {
    const body: Record<string, unknown> = {};
    if (params.url) body.url = params.url;
    if (params.monitor_type) body.monitor_type = params.monitor_type;
    if (params.cadence) body.cadence = params.cadence;
    if (params.status) body.status = params.status;
    if (params.min_severity) body.min_severity = params.min_severity;
    return text(await apiRequest("PATCH", `/v1/monitors/${params.monitor_id}`, body));
  },
);

server.tool(
  "delete_monitor",
  "DELETE /v1/monitors/:id. Permanently removes the monitor and all its changes and snapshots.",
  { monitor_id: resourceId },
  async (params) => text(await apiRequest("DELETE", `/v1/monitors/${params.monitor_id}`)),
);

server.tool(
  "check_monitor",
  "POST /v1/monitors/:id/check. Queue an on-demand check for one monitor.",
  { monitor_id: resourceId },
  async (params) => text(await apiRequest("POST", `/v1/monitors/${params.monitor_id}/check`)),
);

server.tool(
  "refresh_workspace",
  "POST /v1/workspaces/:id/refresh. Queue checks for all active monitors, or one competitor when competitor_id is set.",
  {
    workspace_id: workspaceId,
    competitor_id: resourceId.optional(),
  },
  async (params) => {
    const body: Record<string, unknown> = {};
    if (params.competitor_id !== undefined) body.competitor_id = params.competitor_id;
    return text(await apiRequest("POST", `/v1/workspaces/${params.workspace_id}/refresh`, body));
  },
);

server.tool(
  "list_changes",
  "GET /v1/changes. Cursor-paginated change feed. Response includes meta.counts and max_unreviewed_severity.",
  {
    workspace_id: workspaceId,
    competitor_id: resourceId.optional(),
    min_severity: z.enum(["info", "low", "medium", "high", "critical"]).optional(),
    review_status: z.enum(["unreviewed", "acknowledged", "dismissed"]).optional(),
    since: z.string().optional().describe("ISO8601 or 1d, 7d, 30d"),
    monitor_type: z.string().optional(),
    limit: z.number().optional().describe("1-100, default 25"),
    after: resourceId.optional().describe("Cursor from next_cursor"),
  },
  async (params) => {
    const qs = buildQuery({
      workspace_id: params.workspace_id,
      competitor_id: params.competitor_id,
      min_severity: params.min_severity,
      review_status: params.review_status,
      since: params.since,
      monitor_type: params.monitor_type,
      limit: params.limit,
      after: params.after,
    });
    return text(await apiRequest("GET", `/v1/changes${qs}`));
  },
);

server.tool(
  "get_change",
  "GET /v1/changes/:id. Full change detail. Pass include for capture, capture_markdown, or raw_diff evidence.",
  {
    change_id: resourceId,
    include: includeCapture,
  },
  async (params) => {
    const include = params.include?.length ? params.include.join(",") : undefined;
    const qs = buildQuery({ include });
    return text(await apiRequest("GET", `/v1/changes/${params.change_id}${qs}`));
  },
);

server.tool(
  "update_change",
  "PATCH /v1/changes/:id. Set review_status to unreviewed, acknowledged, or dismissed.",
  {
    change_id: resourceId,
    review_status: z.enum(["unreviewed", "acknowledged", "dismissed"]),
  },
  async (params) =>
    text(
      await apiRequest("PATCH", `/v1/changes/${params.change_id}`, {
        review_status: params.review_status,
      }),
    ),
);

server.tool(
  "get_digest",
  "GET /v1/workspaces/:id/digest. Weekly workspace summary with needs-review items and top opportunities.",
  {
    workspace_id: workspaceId,
    period: z.enum(["1d", "7d", "30d"]).optional(),
  },
  async (params) => {
    const qs = buildQuery({ period: params.period });
    return text(await apiRequest("GET", `/v1/workspaces/${params.workspace_id}/digest${qs}`));
  },
);

async function main() {
  if (!API_KEY) {
    console.error("COMPETIFLOW_API_KEY environment variable is required.");
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
