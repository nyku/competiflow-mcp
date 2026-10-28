#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/** Resolved at runtime from `dist/index.js` → repo `package.json`. */
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")) as { version: string }
).version;

const BASE_URL = "https://api.competiflow.com";
const API_KEY = process.env.COMPETIFLOW_API_KEY || "";
const MISSING_API_KEY_MESSAGE =
  "COMPETIFLOW_API_KEY is not set. Create an API key in the Competiflow dashboard under API keys and add it to this server's env.";

const workspaceId = z.union([z.string(), z.number()]).describe("Workspace id from list_workspaces or create_workspace");
const resourceId = z.union([z.string(), z.number()]);
const competitorId = resourceId.describe("Competitor id from list_competitors or add_competitor");
const monitorId = resourceId.describe("Monitor id from list_monitors or list_competitors");
const changeId = resourceId.describe("Change id from list_changes or get_digest");

const monitorType = z
  .enum(["homepage", "blog", "docs", "changelog", "pricing"])
  .describe("Kind of page: homepage, blog, docs, changelog, or pricing");
const cadence = z
  .enum(["hourly", "six_hourly", "daily", "weekly"])
  .describe("Check frequency. Faster cadences use more monthly checks; plans set a minimum (422 cadence_not_allowed).");
const status = z.enum(["active", "paused"]).describe("active runs checks; paused stops checks and keeps history");
const severity = z.enum(["info", "low", "medium", "high", "critical"]);
const reviewStatus = z
  .enum(["unreviewed", "acknowledged", "dismissed"])
  .describe("unreviewed (in the inbox), acknowledged (seen and relevant), or dismissed (noise)");

const includeCapture = z
  .array(z.enum(["capture", "capture_markdown", "raw_diff"]))
  .optional()
  .describe("Evidence to add: capture (structured page data), capture_markdown (page as markdown), raw_diff");

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

/** Shown to MCP clients that support server instructions (e.g. Cursor). */
const MCP_AGENT_INSTRUCTIONS = `
Competiflow watches competitor websites and returns interpreted changes.

Typical flow:
1. list_workspaces or create_workspace (optional product_url improves why_it_matters).
2. add_competitor with a homepage URL. Discovery is async. Poll get_competitor until discovery_status is completed. If you get 409 discovery_in_progress, read active_competitor_id and poll that competitor.
3. refresh_workspace or check_monitor to pull fresh data.
4. list_changes with since and min_severity. Use meta.counts for inbox totals. Each change includes why_it_matters (competitive context), not recommended_action.
5. get_change with include capture or raw_diff when you need evidence.
6. update_change to triage (acknowledged or dismissed).
7. get_digest for a weekly summary; needs_review.items include why_it_matters.

add_competitor is idempotent on duplicate URLs. delete_workspace, delete_competitor, and delete_monitor remove history. Prefer update_workspace, update_competitor, or update_monitor with status paused when you want to keep history.
`.trim();

const AGENT_GUIDE = `
# Competiflow agent guide

${MCP_AGENT_INSTRUCTIONS}

## Prompts

- weekly_briefing: summarize a workspace's competitor activity for a period.
- triage_changes: walk the unreviewed inbox and propose acknowledge or dismiss.
- track_competitor: add a competitor, wait for discovery, and report what is monitored.

## Resources

- competiflow://workspaces/{workspace_id}/digest: the 7-day digest of one workspace as JSON.
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
  if (!API_KEY) throw new Error(MISSING_API_KEY_MESSAGE);

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
  {
    name: "competiflow",
    title: "Competiflow",
    version: PACKAGE_VERSION,
    websiteUrl: "https://competiflow.com",
    icons: [{ src: "https://competiflow.com/logo.png", mimeType: "image/png", sizes: ["512x512"] }],
  },
  { instructions: MCP_AGENT_INSTRUCTIONS },
);

server.registerTool(
  "list_workspaces",
  {
    title: "List workspaces",
    description:
      "List all your workspaces with competitor and monitor counts, needs_review_count, and the highest unreviewed severity. Start here to find a workspace_id. For one workspace's recent activity, use get_digest.",
    annotations: READ_ONLY,
  },
  async () => text(await apiRequest("GET", "/v1/workspaces")),
);

server.registerTool(
  "create_workspace",
  {
    title: "Create workspace",
    description:
      "Create a workspace for one product or market. Set product_url to your own product so why_it_matters explains each change relative to it. Returns 422 when your plan's workspace limit is reached. To rename or change an existing workspace, use update_workspace.",
    inputSchema: {
      name: z.string().describe("Workspace name, e.g. the product or market it covers"),
      product_url: z
        .string()
        .nullish()
        .describe("Your own product's URL (e.g. example.com). The server adds https:// when missing."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (params) => {
    const body: Record<string, unknown> = { name: params.name };
    if (params.product_url) body.product_url = params.product_url;
    return text(await apiRequest("POST", "/v1/workspaces", body));
  },
);

server.registerTool(
  "update_workspace",
  {
    title: "Update workspace",
    description:
      "Rename a workspace, set or clear its product_url, or pause/resume every monitor in it. Send only the fields to change; nothing is written if any field is invalid. Pausing keeps all history, so prefer it over delete_workspace. To pause one competitor, use update_competitor.",
    inputSchema: {
      workspace_id: workspaceId,
      name: z.string().optional().describe("New workspace name. Cannot be blank."),
      product_url: z
        .string()
        .nullable()
        .optional()
        .describe("Your own product's URL (e.g. example.com). Pass null to clear it; omit to leave it unchanged."),
      status: status.optional().describe("paused stops checks on every monitor in the workspace; active resumes them"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (params) => {
    const body: Record<string, unknown> = {};
    if (params.name !== undefined) body.name = params.name;
    if (params.product_url !== undefined) body.product_url = params.product_url;
    if (params.status) body.status = params.status;
    return text(await apiRequest("PATCH", `/v1/workspaces/${params.workspace_id}`, body));
  },
);

server.registerTool(
  "delete_workspace",
  {
    title: "Delete workspace",
    description:
      "Permanently delete a workspace with all its competitors, monitors, snapshots, and changes. Cannot be undone. Returns 409 discovery_in_progress while a competitor is still being discovered. To stop checks and keep history, use update_workspace with status paused.",
    inputSchema: { workspace_id: workspaceId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (params) => text(await apiRequest("DELETE", `/v1/workspaces/${params.workspace_id}`)),
);

server.registerTool(
  "add_competitor",
  {
    title: "Add competitor",
    description:
      "Add a competitor to a workspace by homepage URL and start discovering its pricing, docs, blog, and changelog pages. Discovery is async: poll get_competitor until discovery_status is completed. Re-adding the same URL returns the existing competitor. Returns 409 with active_competitor_id while another discovery runs in the workspace. To watch one specific page, use create_monitor.",
    inputSchema: {
      workspace_id: workspaceId,
      url: z.string().describe("Competitor homepage URL, e.g. https://rival.com"),
      monitor_types: z
        .array(z.enum(["blog", "changelog", "pricing", "docs", "homepage"]))
        .optional()
        .describe("Only discover these page types. Omit to discover all of them."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (params) => {
    const body: Record<string, unknown> = { url: params.url };
    if (params.monitor_types) body.monitor_types = params.monitor_types;
    return text(await apiRequest("POST", `/v1/workspaces/${params.workspace_id}/competitors`, body));
  },
);

server.registerTool(
  "list_competitors",
  {
    title: "List competitors",
    description:
      "List the competitors in a workspace with discovery_status and their monitors, each with last_run. Use it for an overview of what is tracked. To list monitors alone or filter them by competitor, use list_monitors.",
    inputSchema: { workspace_id: workspaceId },
    annotations: READ_ONLY,
  },
  async (params) => text(await apiRequest("GET", `/v1/workspaces/${params.workspace_id}/competitors`)),
);

server.registerTool(
  "get_competitor",
  {
    title: "Get competitor",
    description:
      "Get one competitor with its monitors and discovery fields. Use it to poll discovery after add_competitor until discovery_status is completed or failed.",
    inputSchema: { competitor_id: competitorId },
    annotations: READ_ONLY,
  },
  async (params) => text(await apiRequest("GET", `/v1/competitors/${params.competitor_id}`)),
);

server.registerTool(
  "update_competitor",
  {
    title: "Update competitor",
    description:
      "Set the check cadence or pause/resume every monitor of one competitor. History is kept. To change a single monitor, use update_monitor; for a whole workspace, use update_workspace.",
    inputSchema: {
      competitor_id: competitorId,
      cadence: cadence.optional(),
      status: status.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (params) => {
    const body: Record<string, unknown> = {};
    if (params.cadence) body.cadence = params.cadence;
    if (params.status) body.status = params.status;
    return text(await apiRequest("PATCH", `/v1/competitors/${params.competitor_id}`, body));
  },
);

server.registerTool(
  "delete_competitor",
  {
    title: "Delete competitor",
    description:
      "Permanently delete a competitor with its monitors, snapshots, and changes. Cannot be undone. To stop checks and keep history, use update_competitor with status paused.",
    inputSchema: { competitor_id: competitorId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (params) => text(await apiRequest("DELETE", `/v1/competitors/${params.competitor_id}`)),
);

server.registerTool(
  "list_monitors",
  {
    title: "List monitors",
    description:
      "List the monitors in a workspace, optionally for one competitor, with URL, type, cadence, status, health, and last_run. Use it to find a monitor_id or spot failing monitors. For competitors with their monitors nested, use list_competitors.",
    inputSchema: {
      workspace_id: workspaceId,
      competitor_id: competitorId.optional().describe("Only list this competitor's monitors"),
    },
    annotations: READ_ONLY,
  },
  async (params) => {
    const qs = buildQuery({
      workspace_id: params.workspace_id,
      competitor_id: params.competitor_id,
    });
    return text(await apiRequest("GET", `/v1/monitors${qs}`));
  },
);

server.registerTool(
  "get_monitor",
  {
    title: "Get monitor",
    description:
      "Get one monitor's settings, health, and last run. Set include to also return the latest successful capture as structured data or markdown.",
    inputSchema: {
      monitor_id: monitorId,
      include: includeCapture,
    },
    annotations: READ_ONLY,
  },
  async (params) => {
    const include = params.include?.length ? params.include.join(",") : undefined;
    const qs = buildQuery({ include });
    return text(await apiRequest("GET", `/v1/monitors/${params.monitor_id}${qs}`));
  },
);

server.registerTool(
  "create_monitor",
  {
    title: "Create monitor",
    description:
      "Watch one specific page of an existing competitor, such as a pricing or docs URL that discovery missed. To add a new competitor and discover its pages automatically, use add_competitor.",
    inputSchema: {
      competitor_id: competitorId,
      url: z.string().describe("Full URL of the page to watch"),
      monitor_type: monitorType,
      cadence: cadence.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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

server.registerTool(
  "update_monitor",
  {
    title: "Update monitor",
    description:
      "Change one monitor's URL, type, cadence, status, or min_severity. Use status paused to stop checks and keep history. To change every monitor of a competitor at once, use update_competitor.",
    inputSchema: {
      monitor_id: monitorId,
      url: z.string().optional().describe("New URL to watch"),
      monitor_type: monitorType.optional(),
      cadence: cadence.optional(),
      status: status.optional(),
      min_severity: severity.optional().describe("Changes below this severity are not reported"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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

server.registerTool(
  "delete_monitor",
  {
    title: "Delete monitor",
    description:
      "Permanently delete one monitor with its snapshots and changes. Cannot be undone. To stop checks and keep history, use update_monitor with status paused.",
    inputSchema: { monitor_id: monitorId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (params) => text(await apiRequest("DELETE", `/v1/monitors/${params.monitor_id}`)),
);

server.registerTool(
  "check_monitor",
  {
    title: "Check monitor now",
    description:
      "Queue an immediate check of one monitor. Uses one of your monthly checks and returns 429 refresh_throttled if the monitor was checked too recently. Results arrive asynchronously: read them later with list_changes or get_monitor. To check every monitor in a workspace, use refresh_workspace.",
    inputSchema: { monitor_id: monitorId },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (params) => text(await apiRequest("POST", `/v1/monitors/${params.monitor_id}/check`)),
);

server.registerTool(
  "refresh_workspace",
  {
    title: "Refresh workspace",
    description:
      "Queue immediate checks for every active monitor in a workspace, or for one competitor when competitor_id is set. Each monitor checked uses one monthly check; recently checked monitors are skipped and listed in skipped_ids. Returns 409 while discovery is running. For a single monitor, use check_monitor.",
    inputSchema: {
      workspace_id: workspaceId,
      competitor_id: competitorId.optional().describe("Only refresh this competitor's monitors"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (params) => {
    const body: Record<string, unknown> = {};
    if (params.competitor_id !== undefined) body.competitor_id = params.competitor_id;
    return text(await apiRequest("POST", `/v1/workspaces/${params.workspace_id}/refresh`, body));
  },
);

server.registerTool(
  "list_changes",
  {
    title: "List changes",
    description:
      "List detected competitor changes in a workspace, newest first, with summary, severity, why_it_matters, monitor_type, and review_status. meta.counts gives inbox totals; page with after set to next_cursor. For a summarized period, use get_digest; for evidence on one change, use get_change.",
    inputSchema: {
      workspace_id: workspaceId,
      competitor_id: competitorId.optional().describe("Only this competitor's changes"),
      min_severity: severity.optional().describe("Lowest severity to include"),
      review_status: reviewStatus.optional(),
      since: z.string().optional().describe("ISO 8601 timestamp, or a relative window: 1d, 7d, 30d"),
      monitor_type: monitorType.optional(),
      limit: z.number().optional().describe("Page size, 1-100 (default 25)"),
      after: resourceId.optional().describe("next_cursor from the previous page"),
    },
    annotations: READ_ONLY,
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

server.registerTool(
  "get_change",
  {
    title: "Get change",
    description:
      "Get one change with why_it_matters, field-level diffs, and related clusters. Set include to add the captured page or the raw diff as evidence.",
    inputSchema: {
      change_id: changeId,
      include: includeCapture,
    },
    annotations: READ_ONLY,
  },
  async (params) => {
    const include = params.include?.length ? params.include.join(",") : undefined;
    const qs = buildQuery({ include });
    return text(await apiRequest("GET", `/v1/changes/${params.change_id}${qs}`));
  },
);

server.registerTool(
  "update_change",
  {
    title: "Triage change",
    description:
      "Triage a change by setting its review_status: acknowledged when it is relevant, dismissed when it is noise, or unreviewed to put it back in the inbox.",
    inputSchema: {
      change_id: changeId,
      review_status: reviewStatus,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (params) =>
    text(
      await apiRequest("PATCH", `/v1/changes/${params.change_id}`, {
        review_status: params.review_status,
      }),
    ),
);

server.registerTool(
  "get_digest",
  {
    title: "Get workspace digest",
    description:
      "Get a workspace summary for a period: changes needing review with why_it_matters, an activity map by competitor, and top opportunities. Use it for briefings; to page through individual changes, use list_changes.",
    inputSchema: {
      workspace_id: workspaceId,
      period: z.enum(["1d", "7d", "30d"]).optional().describe("Time window to summarize (default 7d)"),
    },
    annotations: READ_ONLY,
  },
  async (params) => {
    const qs = buildQuery({ period: params.period });
    return text(await apiRequest("GET", `/v1/workspaces/${params.workspace_id}/digest${qs}`));
  },
);

// Prompt arguments arrive as strings, and some clients send "" for optional ones.
function present(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function oneOf(value: string | undefined, allowed: string[], fallback: string) {
  const picked = present(value);
  return picked && allowed.includes(picked) ? picked : fallback;
}

function workspaceStep(id: string | undefined) {
  return id
    ? `Use workspace_id ${id}.`
    : "Call list_workspaces first. If there is more than one workspace, ask me which one to use.";
}

function userPrompt(lines: string[]) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text: lines.join("\n") } }] };
}

server.registerPrompt(
  "weekly_briefing",
  {
    title: "Competitor briefing",
    description: "Summarize what competitors changed in a workspace over a period, most important first.",
    argsSchema: {
      workspace_id: z.string().optional().describe("Workspace id. Omit to pick from list_workspaces."),
      period: z.string().optional().describe("1d, 7d, or 30d (default 7d)"),
    },
  },
  ({ workspace_id, period }) => {
    const window = oneOf(period, ["1d", "7d", "30d"], "7d");
    return userPrompt([
      `Brief me on competitor activity in Competiflow over the last ${window}.`,
      workspaceStep(present(workspace_id)),
      `1. Call get_digest with period ${window}.`,
      `2. Call list_changes with since ${window} and min_severity medium.`,
      "3. Write a short briefing: the most important changes first, each with the competitor, what changed, and why_it_matters. End with what still needs my review.",
      "Do not change any review_status.",
    ]);
  },
);

server.registerPrompt(
  "triage_changes",
  {
    title: "Triage changes",
    description: "Walk the unreviewed change inbox and propose acknowledge or dismiss for each change.",
    argsSchema: {
      workspace_id: z.string().optional().describe("Workspace id. Omit to pick from list_workspaces."),
      min_severity: z.string().optional().describe("info, low, medium, high, or critical (default medium)"),
    },
  },
  ({ workspace_id, min_severity }) => {
    const floor = oneOf(min_severity, ["info", "low", "medium", "high", "critical"], "medium");
    return userPrompt([
      "Help me triage unreviewed competitor changes in Competiflow.",
      workspaceStep(present(workspace_id)),
      `1. Call list_changes with review_status unreviewed and min_severity ${floor}.`,
      "2. For each change, read summary and why_it_matters. Call get_change with include raw_diff only when that is not enough to judge.",
      "3. Propose acknowledged (relevant) or dismissed (noise) for each change with a one-line reason.",
      "4. Ask me to confirm before calling update_change.",
    ]);
  },
);

server.registerPrompt(
  "track_competitor",
  {
    title: "Track a competitor",
    description: "Add a competitor by URL, wait for discovery, and report which pages are monitored.",
    argsSchema: {
      url: z.string().trim().min(1).describe("Competitor homepage URL, e.g. https://rival.com"),
      workspace_id: z.string().optional().describe("Workspace id. Omit to pick from list_workspaces."),
    },
  },
  ({ url, workspace_id }) =>
    userPrompt([
      `Start tracking ${url} as a competitor in Competiflow.`,
      workspaceStep(present(workspace_id)),
      "1. Call add_competitor with that URL. If it returns 409 discovery_in_progress, poll get_competitor for active_competitor_id until it finishes, then retry.",
      "2. Poll get_competitor about every 30 seconds until discovery_status is completed or failed.",
      "3. Report the monitors found (type and URL) and any page types that are missing, which I could add with create_monitor.",
    ]),
);

server.registerResource(
  "guide",
  "competiflow://guide",
  {
    title: "Competiflow agent guide",
    description: "How to use the Competiflow tools: the typical flow, async discovery, evidence, triage, and delete versus pause.",
    mimeType: "text/markdown",
  },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: AGENT_GUIDE }] }),
);

server.registerResource(
  "workspace_digest",
  new ResourceTemplate("competiflow://workspaces/{workspace_id}/digest", {
    list: async () => {
      if (!API_KEY) return { resources: [] };
      try {
        const { workspaces } = await apiRequest<{ workspaces: { id: number; name: string }[] }>("GET", "/v1/workspaces");
        return {
          resources: workspaces.map((w) => ({
            uri: `competiflow://workspaces/${w.id}/digest`,
            name: `${w.name} digest`,
            mimeType: "application/json",
          })),
        };
      } catch {
        // Listing digests is optional context; a bad key or an outage must not break resources/list.
        return { resources: [] };
      }
    },
  }),
  {
    title: "Workspace digest",
    description:
      "7-day digest of one workspace: changes needing review with why_it_matters, activity by competitor, and top opportunities.",
    mimeType: "application/json",
  },
  async (uri, { workspace_id }) => {
    const digest = await apiRequest("GET", `/v1/workspaces/${encodeURIComponent(String(workspace_id))}/digest`);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(digest, null, 2) }] };
  },
);

async function main() {
  // Start without a key so clients and directory inspectors can still list tools;
  // each tool call reports the missing key instead.
  if (!API_KEY) console.error(MISSING_API_KEY_MESSAGE);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
