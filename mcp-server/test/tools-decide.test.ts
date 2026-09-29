// Adapted from jkudish/jev-mcp test/e2e.test.mjs (MIT): the live battery is replayed against
// the stub endpoint. See THIRD-PARTY-NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestBody } from "./mcp-client.ts";
import { payload, record, rows, withToolServer } from "./tool-harness.ts";

const decide = {
  decision: "Choose the deployment that satisfies the offline requirement",
  candidates: [
    { id: "local", description: "Runs entirely on the local machine" },
    { id: "hosted", description: "Remote hosted API requiring network access" },
  ],
  evidence: JSON.stringify([{ id: "local-test", text: "Local deployment passed the offline test suite." }]),
  priorities: JSON.stringify([{ id: "must-be-offline", text: "Must operate without any network access" }]),
  requirements: ["Operates without network access"],
};

const recommendation = {
  type: "choice",
  choice: "option_0",
  confidence: 0.9,
  probabilities: { option_0: 0.86, option_1: 0.05, ask_user: 0.03, investigate: 0.03, none: 0.03 },
};
const supported = {
  type: "choice",
  choice: "supported",
  confidence: 0.9,
  probabilities: { supported: 0.9, contradicted: 0.05, unknown: 0.05 },
};

describe("jev_decide", () => {
  it("offers the candidates as opaque options, with escape hatches and a per-requirement check", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: {} } }),
      async ({ requests, call }) => {
        await call("jev_decide", decide);
        assert.equal(requests.length, 1);
        const body = requestBody(requests[0]);
        const state = body.state as {
          candidates: Array<{ id: string; description: string }>;
          requirements: string[];
        };
        assert.deepEqual(state.candidates, [
          { id: "option_0", description: "Runs entirely on the local machine" },
          { id: "option_1", description: "Remote hosted API requiring network access" },
        ]);
        assert.deepEqual(state.requirements, ["Operates without network access"]);
        assert.deepEqual(Object.keys(body.questions).sort(), ["check_0_0", "check_1_0", "recommendation"]);
        assert.deepEqual(Object.keys(body.questions["recommendation"]?.["criteria"] ?? {}), [
          "option_0",
          "option_1",
          "ask_user",
          "investigate",
          "none",
        ]);
        assert.deepEqual(Object.keys(body.questions["check_0_0"]?.["criteria"] ?? {}), [
          "supported",
          "contradicted",
          "unknown",
        ]);
      },
    );
  });

  it("returns the recommended candidate under its caller id", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: { recommendation, check_0_0: supported, check_1_0: supported } } }),
      async ({ call }) => {
        const body = payload(await call("jev_decide", decide));
        const result = record(body, "recommendation");
        assert.equal(result["selected"], "local");
        assert.equal(result["escaped"], false);
        assert.equal(result["status"], undefined);
        assert.deepEqual(Object.keys(result["probabilities"] as object).sort(), [
          "ask_user",
          "hosted",
          "investigate",
          "local",
          "none",
        ]);
        assert.deepEqual(result["contradicted_requirements"], []);
        assert.deepEqual(body["warnings"], []);
        assert.equal(body["requirements_checked"], 1);
        assert.deepEqual(rows(body, "checks")[1], { candidate: "hosted", requirement: 0, answer: "supported" });
      },
    );
  });

  it("withdraws a recommendation its own requirement checks contradict", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: {
          answers: {
            recommendation,
            check_0_0: {
              type: "choice",
              choice: "contradicted",
              confidence: 0.95,
              probabilities: { supported: 0.02, contradicted: 0.95, unknown: 0.03 },
            },
            check_1_0: supported,
          },
        },
      }),
      async ({ call }) => {
        const body = payload(await call("jev_decide", { ...decide, escalate_on_contradiction: true }));
        const result = record(body, "recommendation");
        assert.equal(result["selected"], null, "the recommendation is withdrawn, not replaced");
        assert.equal(result["status"], "escalate");
        assert.deepEqual(result["contradicted_requirements"], [0]);
        assert.deepEqual(body["warnings"], [
          "Requirement 1 contradicted by the recommended candidate; inspect before acting",
        ]);
      },
    );
  });

  it("reports invalid_response instead of inventing a selection", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: { check_0_0: supported } } }),
      async ({ call }) => {
        const body = payload(await call("jev_decide", decide));
        const result = record(body, "recommendation");
        assert.equal(result["status"], "invalid_response");
        assert.equal(result["selected"], null);
        assert.equal(result["probabilities"], null);
        assert.deepEqual(rows(body, "checks").map((check) => check["answer"]), [
          "supported",
          "invalid_response",
        ]);
      },
    );
  });
});
