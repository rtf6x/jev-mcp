import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Config } from "./config.ts";
import { createMcpServer } from "./server.ts";

/** Serve MCP over stdio for hosts that spawn a process (Claude Desktop, Claude Code). */
export async function serveStdio(config: Config, log: (message: string) => void): Promise<void> {
  const server = createMcpServer(config);
  await server.connect(new StdioServerTransport());
  log(`jev-mcp ready on stdio → ${config.url}`);
}
