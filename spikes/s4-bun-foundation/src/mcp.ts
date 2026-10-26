// S4 spike: MCP stdio server via @modelcontextprotocol/sdk.
// Not production code.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export async function runMcp(_args: string[]) {
  const server = new McpServer({ name: "dayline", version: "0.0.0-spike" });
  server.registerTool(
    "today",
    {
      description: "Return a fake summary of today (spike)",
      inputSchema: { date: z.string().optional() },
    },
    async ({ date }) => ({
      content: [{ type: "text", text: JSON.stringify({ date: date ?? "today", items: 0 }) }],
    }),
  );
  await server.connect(new StdioServerTransport());
}
