// Shared harness for the per-tool suites: the stub endpoint, the real HTTP MCP server pointed at
// it, and a `call` that returns whatever the tool answered.
import assert from "node:assert/strict";
import { isRecord } from "../src/guards.ts";
import { startHttpServer } from "../src/server.ts";
import { startStubEndpoint, testConfig, type StubReply, type StubRequest } from "./helpers.ts";
import { rpc, toolResult, toolText } from "./mcp-client.ts";

export type ToolCall = { isError: boolean; text: string };

export type ToolHarness = {
  /** Requests the stub endpoint received, oldest first. */
  readonly requests: StubRequest[];
  call: (name: string, args: unknown) => Promise<ToolCall>;
};

export async function withToolServer(
  reply: (request: StubRequest) => StubReply,
  run: (harness: ToolHarness) => Promise<void>,
  questionType: "noul" | "boolean" = "noul",
): Promise<void> {
  const endpoint = await startStubEndpoint(reply);
  const server = await startHttpServer(testConfig({ url: endpoint.url, httpPort: 0, questionType }), () => {});
  let nextId = 0;
  try {
    await run({
      requests: endpoint.requests,
      call: async (name, args) => {
        const response = await rpc(server.port, {
          jsonrpc: "2.0",
          id: ++nextId,
          method: "tools/call",
          params: { name, arguments: args },
        });
        const result = toolResult(response.json);
        return { isError: result.isError === true, text: toolText(result) };
      },
    });
  } finally {
    await server.close();
    await endpoint.close();
  }
}

/** The payload a tool returned: the JSON object every tool result carries. */
export function payload(call: ToolCall): Record<string, unknown> {
  const parsed: unknown = JSON.parse(call.text);
  assert.ok(isRecord(parsed), "tool result is a JSON object");
  return parsed;
}

/** One array field of a payload, every element an object. */
export function rows(body: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = body[key];
  assert.ok(Array.isArray(value), `${key} is an array`);
  const items: Array<Record<string, unknown>> = [];
  for (const item of value) {
    assert.ok(isRecord(item), `${key} holds objects`);
    items.push(item);
  }
  return items;
}

/** One object field of a payload. */
export function record(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  assert.ok(isRecord(value), `${key} is an object`);
  return value;
}
