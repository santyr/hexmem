import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools } from "./tools.js";

export function createServer(): McpServer {
  const server = new McpServer({ name: "hexmem", version: "2.0.0" });
  registerTools(server);
  return server;
}
