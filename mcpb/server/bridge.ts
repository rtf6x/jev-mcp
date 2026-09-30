/**
 * Stdio -> Streamable HTTP bridge.
 *
 * Hosts such as Claude Desktop can only start local stdio MCP servers, while the Jev MCP server is
 * a single long-running process: the tray app owns it, its `.env` and `127.0.0.1:18791`. This bridge
 * lets such a host speak stdio and forwards every request to that one server, so no second server
 * process is ever started and the app's `.env` stays the only configuration. When the app is not
 * running the bridge says so and exits — it never starts a server of its own.
 *
 * Nothing is written to stdout except MCP protocol traffic; all diagnostics go to stderr, which
 * hosts record in their MCP log.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";

/** Injected by esbuild from the repository version at build time. */
declare const __JEV_MCP_VERSION__: string;

/**
 * Longer than any server-side deadline — `JEV_TIMEOUT_MS` tops out at 600 s — so a slow judgment
 * surfaces the server's own error rather than a bridge timeout that hides it.
 */
const TOOL_TIMEOUT_MS = 900_000;

const DEFAULT_SERVER_URL = "http://127.0.0.1:18791/mcp";

function log(message: string): void {
  console.error(`jev-mcp: ${message}`);
}

async function main(): Promise<void> {
  const url = process.env.JEV_MCP_URL?.trim() || DEFAULT_SERVER_URL;

  const upstream = new Client(
    { name: "jev-mcp-bridge", version: __JEV_MCP_VERSION__ },
    { capabilities: {} },
  );
  upstream.onerror = (error) =>
    log(`server error: ${error instanceof Error ? error.message : String(error)}`);

  try {
    await upstream.connect(new StreamableHTTPClientTransport(new URL(url)));
  } catch (error) {
    log(`cannot reach ${url} — ${error instanceof Error ? error.message : String(error)}`);
    log("start the Jev MCP app (it serves 127.0.0.1:18791), then restart this client");
    process.exitCode = 1;
    return;
  }

  // The server exposes tools and nothing else: no prompts, no resources.
  const capabilities: ServerCapabilities = { tools: { listChanged: true } };

  // The upstream `instructions` string is passed on — it is the server's own "how to use me" text,
  // and a host that reads it should get it through the bridge as well.
  const downstream = new Server(
    { name: "jev-mcp", version: __JEV_MCP_VERSION__ },
    { capabilities, instructions: upstream.getInstructions() },
  );

  downstream.setRequestHandler(ListToolsRequestSchema, (request, extra) =>
    upstream.listTools(request.params, { signal: extra.signal }),
  );
  downstream.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    upstream.callTool(request.params, undefined, {
      signal: extra.signal,
      timeout: TOOL_TIMEOUT_MS,
    }),
  );

  // Anything the server does not implement fails there too; answer locally so the host gets a
  // protocol error instead of a dropped request.
  downstream.fallbackRequestHandler = async (request) => {
    throw new McpError(ErrorCode.MethodNotFound, `jev-mcp does not support ${request.method}`);
  };

  // The host's own notifications (initialized, cancelled) are handled by the SDK; it advertises no
  // capabilities this bridge could forward upstream.
  downstream.fallbackNotificationHandler = async () => {};

  // A tool-list change is the one server-initiated signal worth passing through, so the host
  // re-reads the list when the server reloads.
  upstream.fallbackNotificationHandler = async (notification) => {
    if (notification.method === "notifications/tools/list_changed") {
      await downstream.sendToolListChanged();
    }
  };

  const shutdown = async (code: number): Promise<void> => {
    await downstream.close().catch(() => undefined);
    await upstream.close().catch(() => undefined);
    process.exit(code);
  };

  // The host died or closed the pipe.
  downstream.onclose = () => void shutdown(0);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(0));
  }

  await downstream.connect(new StdioServerTransport());
  log(`forwarding to ${url} (v${__JEV_MCP_VERSION__})`);
}

await main();
