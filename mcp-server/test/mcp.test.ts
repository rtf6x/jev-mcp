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

const noulSchema = z.object({
  tool: z.literal("jev_noul"),
  status: z.string(),
  results: z.array(z.object({ probability: z.number().nullable(), label: z.string().nullable(), auto: z.boolean() })),
});

const noolCall = {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "jev_noul", arguments: { propositions: ["Paris is the capital of France"] } },
};

const TWELVE = [
  "jev_audit",
  "jev_classify",
  "jev_compare",
  "jev_decide",
  "jev_extract",
  "jev_find",
  "jev_gate",
  "jev_noul",
  "jev_rerank",
  "jev_review",
  "jev_screen",
  "jev_verify",
];

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

  it("completes the MCP handshake and lists exactly the twelve tools", async () => {
    await withServer(
      () => ({ status: 200, body: { answers: {} } }),
      async ({ port }) => {
        const handshake = await rpc(port, initialize);
        assert.equal(handshake.status, 200);
        const info = handshakeSchema.parse(handshake.json.result);
        assert.equal(info.serverInfo.name, "jev-mcp");

        const listed = await rpc(port, { jsonrpc: "2.0", id: 2, method: "tools/list" });
        const tools = toolsListSchema.parse(listed.json.result).tools;
        assert.deepEqual(
          tools.map((tool) => tool.name).sort(),
          TWELVE,
        );
        for (const tool of tools) {
          assert.equal(tool.inputSchema?.["type"], "object", `${tool.name} declares an object input schema`);
        }
        const verify = tools.find((tool) => tool.name === "jev_verify");
        assert.deepEqual(verify?.inputSchema?.["required"], ["claims", "evidence"]);
        assert.equal(verify?.inputSchema?.["additionalProperties"], false, "unknown keys are rejected");
      },
    );
  });

  it("forwards one tool call to the endpoint and returns its payload", async () => {
    await withServer(
      () => ({
        status: 200,
        body: {
          model: "jev-1.13.0",
          answers: { p_proposition0: { type: "noul", noul: 0.95 } },
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      }),
      async ({ endpoint, port }) => {
        const call = toolResult((await rpc(port, noolCall)).json);
        assert.equal(call.isError, undefined);
        const body = noulSchema.parse(JSON.parse(toolText(call)));
        assert.equal(body.status, "ok");
        assert.equal(body.results[0]?.label, "likely");
        assert.equal(body.results[0]?.auto, true);
        assert.equal(endpoint.requests.length, 1, "one upstream request per tool call");
        assert.deepEqual(JSON.parse(toolText(call))["usage"], { input_tokens: 10, output_tokens: 2, cost: null });

        assert.deepEqual(requestBody(endpoint.requests[0]), {
          model: "jev-latest",
          state: { propositions: [{ id: "proposition0", text: "Paris is the capital of France" }], context: null },
          questions: {
            p_proposition0: {
              type: "noul",
              instructions: "proposition `proposition0`: Paris is the capital of France",
              criteria: {
                true: "The proposition is likely true, given the supplied context (when present) and general knowledge",
                false: "The proposition is likely not true",
              },
            },
          },
        });
      },
    );
  });

  it("spells the yes/no question for the configured endpoint", async () => {
    await withServer(
      () => ({ status: 200, body: { answers: { p_proposition0: { type: "boolean", probability: 0.9 } } } }),
      async ({ endpoint, port }) => {
        const call = toolResult((await rpc(port, noolCall)).json);
        assert.equal(noulSchema.parse(JSON.parse(toolText(call))).results[0]?.label, "likely");
        assert.equal(requestBody(endpoint.requests[0]).questions["p_proposition0"]?.type, "boolean");
      },
      "boolean",
    );
  });

  it("surfaces an endpoint error as a tool error", async () => {
    await withServer(
      () => ({ status: 401, text: '{"error":{"message":"Missing Authentication header"}}' }),
      async ({ port }) => {
        const call = toolResult((await rpc(port, noolCall)).json);
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
