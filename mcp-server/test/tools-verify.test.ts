// Adapted from jkudish/jev-mcp test/e2e.test.mjs (MIT): the live battery is replayed against
// the stub endpoint. See THIRD-PARTY-NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestBody } from "./mcp-client.ts";
import { payload, rows, withToolServer } from "./tool-harness.ts";

const verify = {
  claims: ["Wearing a helmet is optional for all riders.", "The document is about bicycle safety."],
  evidence: {
    text: "City Bicycle Safety Ordinance, s.4: Every rider must wear an approved helmet at all times.",
  },
};

describe("jev_verify", () => {
  it("builds one relation question per claim, and a source question only for several evidence items", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: {} } }),
      async ({ requests, call }) => {
        await call("jev_verify", verify);
        assert.equal(requests.length, 1);
        const body = requestBody(requests[0]);
        assert.equal(body.model, "jev-latest");
        assert.deepEqual(body.state, {
          purpose: "Verify each claim in claims against the evidence in evidence.",
          claims: verify.claims.map((text, i) => ({ text, id: `claim${i}` })),
          evidence: [{ id: "evidence0", text: verify.evidence.text }],
        });
        const relation = body.questions["relation_claim0"];
        assert.equal(relation?.type, "choice");
        assert.deepEqual(Object.keys(relation?.["criteria"] ?? {}), ["supports", "contradicts", "says_nothing"]);
        assert.deepEqual(Object.keys(body.questions).sort(), ["relation_claim0", "relation_claim1"]);
        assert.equal(body.questions["source_claim0"], undefined, "one evidence item needs no source question");
      },
    );
  });

  it("maps the relation answer to a verdict and an action", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: {
          answers: {
            relation_claim0: {
              type: "choice",
              choice: "contradicts",
              confidence: 0.9,
              probabilities: { supports: 0.05, contradicts: 0.9, says_nothing: 0.05 },
            },
            relation_claim1: {
              type: "choice",
              choice: "supports",
              confidence: 0.4,
              probabilities: { supports: 0.6, contradicts: 0.2, says_nothing: 0.2 },
            },
          },
        },
      }),
      async ({ call }) => {
        const body = payload(await call("jev_verify", verify));
        assert.equal(body["tool"], "jev_verify");
        const results = rows(body, "results");
        assert.equal(results[0]?.["verdict"], "contradicted");
        assert.equal(results[0]?.["action"], "auto");
        assert.equal(results[1]?.["verdict"], "verified");
        assert.equal(results[1]?.["action"], "review", "0.4 is below the 0.8 default");
        assert.equal(results[0]?.["supporting_evidence"], null, "a single evidence item is not echoed as the source");
        assert.deepEqual(body["summary"], { verified: 1, contradicted: 1, unsupported: 0, needs_review: 1 });
      },
    );
  });

  it("reports a malformed relation as invalid_response, never as a verdict", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: {
          answers: {
            relation_claim0: { type: "choice", choice: "maybe", confidence: 0.9, probabilities: { supports: 1 } },
            relation_claim1: {
              type: "choice",
              choice: "supports",
              confidence: "high",
              probabilities: { supports: 0.7, contradicts: 0.2, says_nothing: 0.1 },
            },
          },
        },
      }),
      async ({ call }) => {
        const results = rows(payload(await call("jev_verify", verify)), "results");
        assert.equal(results[0]?.["status"], "invalid_response");
        assert.equal(results[0]?.["verdict"], "unknown");
        assert.equal(results[0]?.["action"], "review");
        assert.equal(results[1]?.["status"], "invalid_response", "a malformed confidence invalidates the verdict");
      },
    );
  });
});
