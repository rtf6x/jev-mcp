import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.ts";
import { registerJudgeTool } from "./tool.ts";
import { SERVER_NAME, VERSION } from "./version.ts";

const MAX_BODY_BYTES = 1 << 20;

export function createMcpServer(config: Config): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  registerJudgeTool(server, config);
  return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export type HttpServerHandle = {
  /** Port actually bound; real when the configured port was 0. */
  readonly port: number;
  readonly close: () => Promise<void>;
};

/**
 * Serve MCP over Streamable HTTP, stateless: one server and transport per request, no session
 * state. `/health` answers for the tray app and for smoke checks; every other path is refused.
 */
export async function startHttpServer(
  config: Config,
  log: (message: string) => void = () => {},
): Promise<HttpServerHandle> {
  const http = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/health") {
        sendJson(res, 200, {
          status: "ok",
          version: VERSION,
          endpoint: config.url,
          model: config.model,
        });
        return;
      }
      if (path !== "/mcp") {
        sendJson(res, 404, { error: "not found", paths: ["/mcp", "/health"] });
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST", "content-type": "application/json" });
        res.end(JSON.stringify({ error: "MCP over Streamable HTTP accepts POST only" }));
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const server = createMcpServer(config);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((error: unknown) => {
      log(`jev-mcp: request failed: ${error instanceof Error ? error.stack : String(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.httpPort, config.httpHost, () => {
      http.removeListener("error", reject);
      resolve();
    });
  });

  const address = http.address();
  const port = typeof address === "object" && address !== null ? address.port : config.httpPort;
  log(`jev-mcp ${VERSION}: http://${config.httpHost}:${port}/mcp → ${config.url}`);
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
