// Adapted from jkudish/jev-mcp test/e2e.test.mjs (MIT): the live battery is replayed against
// the stub endpoint. See THIRD-PARTY-NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestBody } from "./mcp-client.ts";
import { payload, record, rows, withToolServer } from "./tool-harness.ts";

const compare = {
  passage_a: "The Pro plan costs $29 per month and includes unlimited builds.",
  passage_b: "The Pro plan is priced at $59 per month. All plans include unlimited builds.",
  aspects: ["price", "build limits"],
};

describe("jev_compare", () => {
  it("asks the overall relation plus one independent question per aspect", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: {} } }),
      async ({ requests, call }) => {
        await call("jev_compare", compare);
        assert.equal(requests.length, 1);
        const body = requestBody(requests[0]);
        assert.deepEqual(body.state, {
          purpose: null,
          passage_a: compare.passage_a,
          passage_b: compare.passage_b,
          aspects: compare.aspects,
        });
        assert.deepEqual(Object.keys(body.questions).sort(), ["aspect_0", "aspect_1", "overall"]);
        assert.deepEqual(body.questions["overall"]?.["criteria"], {
          same_fact: "Both passages state the same underlying fact or claim",
          contradicts: "The passages state opposing facts about the same subject",
          different_facts: "The passages discuss different subjects or make non-overlapping claims",
        });
        assert.deepEqual(body.questions["aspect_0"]?.["criteria"], {
          same_fact: "Both passages make comparable assertions about this aspect and they agree",
          contradicts: "Both passages address this aspect and their assertions conflict",
          different_facts:
            "The passages do not both make a comparable assertion about this aspect: at least one does not address it, or their mentions do not overlap",
        });
      },
    );
  });

  it("returns the relation, probabilities and a gated decision", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: {
          answers: {
            overall: {
              type: "choice",
              choice: "contradicts",
              confidence: 0.9,
              probabilities: { same_fact: 0.05, contradicts: 0.9, different_facts: 0.05 },
            },
            aspect_0: {
              type: "choice",
              choice: "contradicts",
              confidence: 0.9,
              probabilities: { same_fact: 0.02, contradicts: 0.92, different_facts: 0.06 },
            },
            aspect_1: {
              type: "choice",
              choice: "same_fact",
              confidence: 0.9,
              probabilities: { same_fact: 0.9, contradicts: 0.05, different_facts: 0.05 },
            },
          },
        },
      }),
      async ({ call }) => {
        const body = payload(await call("jev_compare", compare));
        const overall = record(body, "overall");
        assert.equal(overall["relation"], "contradicts");
        assert.equal(overall["decision"], "auto");
        assert.equal(overall["confidence"], 0.9);
        assert.ok(Math.abs(Number(overall["margin"]) - 0.85) < 1e-9);
        const aspects = rows(body, "aspects");
        assert.deepEqual(aspects.map((aspect) => [aspect["aspect"], aspect["relation"]]), [
          ["price", "contradicts"],
          ["build limits", "same_fact"],
        ]);
        assert.deepEqual(body["thresholds"], { auto_accept: 0.85, minimum_margin: 0.5 });
      },
    );
  });

  it("reports invalid_response when the chosen relation is not the argmax", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: {
          answers: {
            overall: {
              type: "choice",
              choice: "same_fact",
              confidence: 0.9,
              probabilities: { same_fact: 0.4, contradicts: 0.45, different_facts: 0.15 },
            },
          },
        },
      }),
      async ({ call }) => {
        const overall = record(payload(await call("jev_compare", compare)), "overall");
        assert.equal(overall["status"], "invalid_response");
        assert.equal(overall["relation"], null);
        assert.equal(overall["decision"], "review");
        assert.equal(overall["probabilities"], null);
      },
    );
  });
});
