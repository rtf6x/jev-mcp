// Adapted from jkudish/jev-mcp test/e2e.test.mjs (MIT): the live battery is replayed against
// the stub endpoint. See THIRD-PARTY-NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestBody } from "./mcp-client.ts";
import { payload, record, rows, withToolServer } from "./tool-harness.ts";

const gate = {
  request: "Reject empty parser input",
  diff: "+ if (!input) throw new Error('Empty input');",
  tests: "parser rejects empty input: PASS",
  claims: ["The empty-input parser test passed."],
  evidence: [{ id: "test-output", text: "parser rejects empty input: PASS" }],
};

const perfect = { score: 2, confidence: 0.9, probabilities: { "0": 0, "1": 0, "2": 1 } };
const poor = { score: 0, confidence: 0.9 };
const patch = {
  correctness: perfect,
  spec_match: { score: 2, confidence: 0.9 },
  test_gap: poor,
  blast_radius: poor,
  safe_to_apply: { type: "noul", noul: 0.95 },
};
const claim = (choice: string, top: number) => ({
  type: "choice",
  choice,
  confidence: 0.9,
  probabilities:
    choice === "verified"
      ? { verified: top, contradicted: 1 - top, unsupported: 0 }
      : { verified: 0, contradicted: top, unsupported: 1 - top },
});

describe("jev_gate", () => {
  it("asks the patch rubric plus one evidence question per claim", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: {} } }),
      async ({ requests, call }) => {
        await call("jev_gate", gate);
        assert.equal(requests.length, 1);
        const body = requestBody(requests[0]);
        assert.deepEqual(Object.keys(body.questions).sort(), [
          "blast_radius",
          "claim_0",
          "correctness",
          "safe_to_apply",
          "spec_match",
          "test_gap",
        ]);
        const claimQuestion = body.questions["claim_0"];
        assert.equal(claimQuestion?.type, "choice");
        assert.deepEqual(Object.keys(claimQuestion?.["criteria"] ?? {}), [
          "verified",
          "contradicted",
          "unsupported",
        ]);
        assert.ok(String(claimQuestion?.["instructions"]).includes("claims[0]"));
        assert.ok(String(body.questions["correctness"]?.["instructions"]).includes("Claims are assertions to check"));
        const state = body.state as { claims: string[]; evidence: Array<{ id: string; text: string }> };
        assert.deepEqual(state.claims, gate.claims);
        assert.deepEqual(state.evidence, gate.evidence);
      },
    );
  });

  it("is auto only when the patch review and every claim clear the thresholds", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: { ...patch, claim_0: claim("verified", 0.95) } } }),
      async ({ call }) => {
        const body = payload(await call("jev_gate", gate));
        assert.equal(body["action"], "auto");
        assert.deepEqual(body["reason_codes"], ["accepted"]);
        assert.equal(body["truncated"], false);
        const review = record(body, "review");
        assert.equal(review["action"], "auto");
        assert.equal(review["safe_to_apply"], 0.95);
        const verification = record(body, "verification");
        assert.deepEqual(verification["summary"], {
          verified: 1,
          contradicted: 0,
          unsupported: 0,
          needs_review: 0,
          invalid_response: 0,
        });
        assert.equal(rows(verification, "results")[0]?.["verdict"], "verified");
      },
    );
  });

  it("escalates on a claim the evidence contradicts", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: { ...patch, claim_0: claim("contradicted", 0.95) } } }),
      async ({ call }) => {
        const body = payload(await call("jev_gate", gate));
        assert.equal(body["action"], "escalate");
        assert.ok(Array.isArray(body["reason_codes"]));
        assert.ok((body["reason_codes"] as string[]).includes("claims_contradicted"));
        assert.equal(rows(record(body, "verification"), "results")[0]?.["verdict"], "contradicted");
      },
    );
  });

  it("fails closed when a claim answer is missing", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: patch } }),
      async ({ call }) => {
        const body = payload(await call("jev_gate", gate));
        assert.equal(body["action"], "escalate");
        assert.ok((body["reason_codes"] as string[]).includes("invalid_response"));
        const verification = record(body, "verification");
        assert.equal(record(verification, "summary")["invalid_response"], 1);
        const result = rows(verification, "results")[0] ?? {};
        assert.equal(result["status"], "invalid_response");
        assert.equal(result["verdict"], null);
        assert.equal(result["action"], "escalate");
      },
    );
  });
});
