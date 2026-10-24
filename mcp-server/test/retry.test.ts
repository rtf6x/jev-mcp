import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { callJev } from "../src/jev/call.ts";
import type { JevOutcome } from "../src/jev/call.ts";
import { startStubEndpoint, testConfig } from "./helpers.ts";

const state = { propositions: [{ text: "The sky is blue.", id: "proposition0" }] };
const questions = {
  p_proposition0: {
    type: "noul",
    instructions: "proposition `proposition0`: The sky is blue.",
    criteria: { true: "blue", false: "not blue" },
  },
};

function failureText(outcome: JevOutcome): string {
  if (outcome.ok) assert.fail("expected the call to fail");
  const content = outcome.result.content[0];
  return content?.type === "text" ? content.text : "";
}

describe("callJev retry", () => {
  it("retries a 503 until the provider serves the request", async () => {
    let served = 0;
    const stub = await startStubEndpoint(() => {
      served += 1;
      if (served < 3) return { status: 503, body: { error: { message: "Service temporarily unavailable" } } };
      return { status: 200, body: { answers: questions, model: "liquid/d1" } };
    });
    try {
      const outcome = await callJev(
        testConfig({ url: stub.url, retryAttempts: 3, retryBaseDelayMs: 1 }),
        state,
        questions,
      );
      assert.equal(outcome.ok, true);
      assert.equal(stub.requests.length, 3);
    } finally {
      await stub.close();
    }
  });

  it("does not retry a rejected question", async () => {
    const stub = await startStubEndpoint(() => ({ status: 422, body: { error: { message: "bad question" } } }));
    try {
      const outcome = await callJev(
        testConfig({ url: stub.url, retryAttempts: 5, retryBaseDelayMs: 1 }),
        state,
        questions,
      );
      assert.match(failureText(outcome), /HTTP 422/);
      assert.equal(stub.requests.length, 1);
    } finally {
      await stub.close();
    }
  });

  it("surfaces the last status once the attempts are spent", async () => {
    const stub = await startStubEndpoint(() => ({ status: 503, body: { error: { message: "Service temporarily unavailable" } } }));
    try {
      const outcome = await callJev(
        testConfig({ url: stub.url, retryAttempts: 3, retryBaseDelayMs: 1 }),
        state,
        questions,
      );
      assert.match(failureText(outcome), /HTTP 503/);
      assert.equal(stub.requests.length, 3);
    } finally {
      await stub.close();
    }
  });

  it("does not retry a request whose deadline expired", async () => {
    let hits = 0;
    const server = createServer(() => {
      hits += 1;
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const outcome = await callJev(
        testConfig({
          url: `http://127.0.0.1:${port}/v1/evaluate`,
          timeoutMs: 100,
          retryAttempts: 4,
          retryBaseDelayMs: 1,
        }),
        state,
        questions,
      );
      assert.match(failureText(outcome), /unreachable/);
      assert.equal(hits, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
