#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["server.mjs"],
  cwd: new URL("..", import.meta.url).pathname,
  env: process.env,
  stderr: "pipe",
});

transport.stderr?.on("data", (data) => {
  process.stderr.write(data);
});

const client = new Client({
  name: "ask-claude-smoke",
  version: "0.1.0",
});

await client.connect(transport);
const tools = await client.listTools();
console.log(JSON.stringify({
  tools: tools.tools.map((tool) => tool.name),
}, null, 2));

const sessions = await client.callTool({
  name: "ask_claude_sessions",
  arguments: {
    include_inactive: true,
  },
});
console.log(JSON.stringify({
  session_count: sessions.structuredContent?.sessions?.length ?? 0,
}, null, 2));

await client.close();
