// Directory scanners (LobeHub, Glama, the MCP Registry) start this server without
// a real API key and read its tools, prompts, and resources. This checks that
// contract against the built dist/ without calling any tool that needs a key.
// Run with `npm test`.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// StdioClientTransport only inherits PATH, HOME, and similar, so a key in the
// developer's shell never leaks into these runs.
async function connect(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "pipe" });
  const client = new Client({ name: "smoke-test", version: "0" });
  await client.connect(transport);
  return client;
}

const noKey = await connect({});
try {
  const info = noKey.getServerVersion();
  assert.equal(info.title, "Competiflow");
  assert.equal(info.icons?.[0]?.src, "https://competiflow.com/logo.png");

  const { tools } = await noKey.listTools();
  assert.equal(tools.length, 20);
  for (const tool of tools) {
    assert.ok(tool.title && tool.description, `${tool.name} needs a title and description`);
    for (const [param, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
      assert.ok(schema.description, `${tool.name}.${param} needs a description`);
    }
    if (tool.name.startsWith("delete_")) assert.equal(tool.annotations?.destructiveHint, true, tool.name);
    if (/^(list|get)_/.test(tool.name)) assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
    if (!tool.annotations?.readOnlyHint) assert.equal(typeof tool.annotations?.destructiveHint, "boolean", tool.name);
  }

  const { prompts } = await noKey.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ["track_competitor", "triage_changes", "weekly_briefing"]);
  const briefing = await noKey.getPrompt({ name: "weekly_briefing", arguments: { workspace_id: "", period: "" } });
  const briefingText = briefing.messages[0].content.text;
  assert.match(briefingText, /list_workspaces/);
  assert.match(briefingText, /period 7d/);

  const { resources } = await noKey.listResources();
  assert.ok(resources.some((r) => r.uri === "competiflow://guide"));
  const guide = await noKey.readResource({ uri: "competiflow://guide" });
  assert.match(guide.contents[0].text, /Typical flow/);

  const { resourceTemplates } = await noKey.listResourceTemplates();
  assert.deepEqual(resourceTemplates.map((t) => t.uriTemplate), ["competiflow://workspaces/{workspace_id}/digest"]);
  await assert.rejects(noKey.readResource({ uri: "competiflow://workspaces/1/digest" }), /COMPETIFLOW_API_KEY is not set/);

  const call = await noKey.callTool({ name: "list_workspaces", arguments: {} });
  assert.equal(call.isError, true);
  assert.match(call.content[0].text, /COMPETIFLOW_API_KEY is not set/);
} finally {
  await noKey.close();
}

// LobeHub's `plugin init` runs the server with a placeholder key, so listing
// digests gets a 401 (or a network error offline). resources/list must survive it.
const placeholderKey = await connect({ COMPETIFLOW_API_KEY: "placeholder" });
try {
  const { resources } = await placeholderKey.listResources();
  assert.ok(resources.some((r) => r.uri === "competiflow://guide"));
} finally {
  await placeholderKey.close();
}

console.log("smoke test passed");
