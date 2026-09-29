import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { startHttpServer, type HttpServerHandle } from "../src/server.ts";
import { startStubEndpoint, testConfig, type StubEndpoint } from "./helpers.ts";
import { requestBody, rpc, toolResult, toolText, toolsListSchema } from "./mcp-client.ts";

async function withServer(
  reply: Parameters<typeof startStubEndpoint>[0],
  run: (context: { endpoint: StubEndpoint; server: HttpServerHandle; port: number }) => Promise<void>,
  questionType: "noul" | "boolean" = "noul",
): Promise<void> {
  const endpoint = await startStubEndpoint(reply);
  const server = await startHttpServer(testConfig({ url: endpoint.url, httpPort: 0, questionType }));
  try {
    await run({ endpoint, server, port: server.port });
  } finally {
    await server.close();
    await endpoint.close();
  }
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

const handshakeSchema = z.object({
  serverInfo: z.object({ name: z.string(), version: z.string() }),
  protocolVersion: z.string(),
});

const healthSchema = z.object({ status: z.string(), endpoint: z.string(), model: z.string() });

const verdictsSchema = z.object({
  results: z.record(
    z.object({ status: z.string(), label: z.string().nullable(), action: z.string(), reason: z.string().nullable() }),
  ),
  summary: z.record(z.number()),
});

const testCall = {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "jev_judge", arguments: { state: "help", questions: { is_urgent: { type: "bool", instructions: "Urgent?" } } } },
};

describe("HTTP transport", () => {
  it("reports the configured endpoint on /health", async () => {
    await withServer(
      () => ({ status: 200, body: { answers: {} } }),
      async ({ endpoint, port }) => {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        assert.equal(response.status, 200);
        const health = healthSchema.parse(await response.json());
        assert.equal(health.status, "ok");
        assert.equal(health.endpoint, endpoint.url);
        assert.equal(health.model, "jev-latest");
      },
    );
  });

  it("completes the MCP handshake and lists the judge tool", async () => {
    await withServer(
      () => ({ status: 200, body: { answers: {} } }),
      async ({ port }) => {
        const handshake = await rpc(port, initialize);
        assert.equal(handshake.status, 200);
        const info = handshakeSchema.parse(handshake.json.result);
        assert.equal(info.serverInfo.name, "jev-mcp");

        const listed = await rpc(port, { jsonrpc: "2.0", id: 2, method: "tools/list" });
        const tools = toolsListSchema.parse(listed.json.result).tools;
        const judge = tools.find((tool) => tool.name === "jev_judge");
        assert.ok(judge, "jev_judge is listed");
        const required = judge.inputSchema?.["required"];
        assert.deepEqual(required, ["state", "questions"]);
      },
    );
  });

  it("forwards a tool call to the endpoint and returns verdicts", async () => {
    await withServer(
      () => ({
        status: 200,
        body: {
          model: "jev-1.13.0",
          answers: { is_urgent: { type: "noul", noul: 0.95 } },
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      }),
      async ({ endpoint, port }) => {
        const call = toolResult((await rpc(port, testCall)).json);
        assert.equal(call.isError, undefined);
        const verdicts = verdictsSchema.parse(call.structuredContent);
        assert.equal(verdicts.results["is_urgent"]?.label, "yes");
        assert.equal(verdicts.results["is_urgent"]?.action, "auto");
        assert.equal(verdicts.summary["auto"], 1);
        assert.equal(verdictsSchema.parse(JSON.parse(toolText(call))).results["is_urgent"]?.action, "auto");

        assert.deepEqual(requestBody(endpoint.requests[0]), {
          model: "jev-latest",
          state: "help",
          questions: { is_urgent: { type: "noul", instructions: "Urgent?" } },
        });
      },
    );
  });

  it("spells the yes/no question for the configured endpoint", async () => {
    await withServer(
      () => ({ status: 200, body: { answers: { is_urgent: { type: "boolean", probability: 0.9 } } } }),
      async ({ endpoint, port }) => {
        await rpc(port, testCall);
        assert.equal(requestBody(endpoint.requests[0]).questions["is_urgent"]?.type, "boolean");
      },
      "boolean",
    );
  });

  it("surfaces an endpoint error as a tool error", async () => {
    await withServer(
      () => ({ status: 401, text: '{"error":{"message":"Missing Authentication header"}}' }),
      async ({ port }) => {
        const call = toolResult((await rpc(port, testCall)).json);
        assert.equal(call.isError, true);
        const text = toolText(call);
        assert.match(text, /HTTP 401/);
        assert.match(text, /Missing Authentication header/);
      },
    );
  });

  it("refuses GET on /mcp and unknown paths", async () => {
    await withServer(
      () => ({ status: 200, body: {} }),
      async ({ port }) => {
        assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`)).status, 405);
        assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
      },
    );
  });
});
