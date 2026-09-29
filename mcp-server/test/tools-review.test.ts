// Adapted from jkudish/jev-mcp test/e2e.test.mjs (MIT): the live battery is replayed against
// the stub endpoint. See THIRD-PARTY-NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestBody } from "./mcp-client.ts";
import { payload, record, rows, withToolServer } from "./tool-harness.ts";

const review = {
  request: "Reject empty parser input",
  diff: "+ if (!input) throw new Error('Empty input');",
  tests: "parser rejects empty input: PASS",
};

const perfect = { score: 2, confidence: 0.9, probabilities: { "0": 0, "1": 0, "2": 1 } };
const poor = { score: 0, confidence: 0.9 };
const safe = { type: "noul", noul: 0.95 };

const autoAnswers = {
  correctness: perfect,
  spec_match: { score: 2, confidence: 0.9 },
  test_gap: poor,
  blast_radius: poor,
  safe_to_apply: safe,
};

describe("jev_review", () => {
  it("asks the four rubric scores and safe_to_apply, with the rubric spelled out", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: {} } }),
      async ({ requests, call }) => {
        await call("jev_review", review);
        assert.equal(requests.length, 1);
        const body = requestBody(requests[0]);
        assert.deepEqual(body.state, {
          purpose: "Review the proposed diff against the request; tests is reported test output.",
          request: review.request,
          diff: review.diff,
          tests: review.tests,
        });
        assert.deepEqual(Object.keys(body.questions).sort(), [
          "blast_radius",
          "correctness",
          "safe_to_apply",
          "spec_match",
          "test_gap",
        ]);
        assert.equal(body.questions["correctness"]?.type, "score");
        assert.deepEqual(body.questions["correctness"]?.["criteria"], [
          "Clearly wrong or breaks the stated behavior",
          "Uncertain; needs a closer look or tests",
          "Looks correct for the request",
        ]);
        assert.equal(body.questions["safe_to_apply"]?.type, "noul");
      },
    );
  });

  it("returns a weighted composite and an auto action when every gate clears", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: autoAnswers } }),
      async ({ call }) => {
        const body = payload(await call("jev_review", review));
        assert.equal(body["action"], "auto");
        assert.ok(Math.abs(Number(body["composite"]) - 1) < 1e-9);
        assert.equal(body["safe_to_apply"], 0.95);
        assert.equal(body["truncated"], false);
        assert.deepEqual(body["reason_codes"], ["accepted"]);
        assert.deepEqual(body["limiting_rubrics"], []);
        assert.deepEqual(body["thresholds"], { auto_accept: 0.8, review_at: 0.5, composite_floor: 0.7 });
        assert.deepEqual(record(body, "weights"), {
          correctness: 0.4,
          spec_match: 0.3,
          test_gap: 0.15,
          blast_radius: 0.15,
        });
        const scores = record(body, "scores");
        assert.deepEqual(scores["correctness"], perfect);
        assert.deepEqual(scores["spec_match"], { score: 2, confidence: 0.9, probabilities: null });
      },
    );
  });

  it("escalates on a malformed rubric score instead of scoring the patch", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: { answers: { ...autoAnswers, correctness: { score: 3, confidence: 0.9 } } },
      }),
      async ({ call }) => {
        const body = payload(await call("jev_review", review));
        assert.equal(body["action"], "escalate");
        assert.equal(body["status"], "invalid_response");
        assert.equal(body["composite"], null);
        assert.deepEqual(body["reason_codes"], ["invalid_response"]);
        const scores = record(body, "scores");
        assert.deepEqual(record(scores, "correctness"), {
          score: null,
          confidence: null,
          probabilities: null,
          status: "invalid_response",
        });
      },
    );
  });

  it("refuses a call that names both a diff and files", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: {} } }),
      async ({ requests, call }) => {
        const result = await call("jev_review", { ...review, files: [{ path: "a.ts", diff: "+x" }] });
        assert.equal(result.isError, true);
        assert.match(result.text, /provide exactly one of diff .* or files/);
        assert.equal(requests.length, 0, "the endpoint is never called for a malformed request");
      },
    );
  });

  it("composes per-file projections: auto only when every file is auto", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: {
          answers: {
            file_0_correctness: perfect,
            file_0_spec_match: { score: 2, confidence: 0.9 },
            file_0_test_gap: poor,
            file_0_blast_radius: poor,
            file_0_safe_to_apply: safe,
            file_1_correctness: perfect,
            file_1_spec_match: { score: 2, confidence: 0.9 },
            file_1_test_gap: poor,
            file_1_blast_radius: poor,
            file_1_safe_to_apply: { type: "noul", noul: 0.6 },
          },
        },
      }),
      async ({ requests, call }) => {
        const files = [
          { path: "src/a.ts", diff: "+a" },
          { path: "src/b.ts", diff: "+b" },
        ];
        const body = payload(await call("jev_review", { ...review, files, diff: undefined }));
        assert.equal(body["mode"], "per-file");
        assert.equal(body["action"], "review", "the weak file bounds the whole change");
        assert.equal(body["safe_to_apply"], 0.6);
        assert.deepEqual(body["reason_codes"], ["safe_to_apply_below_auto_accept"]);
        assert.deepEqual(body["limiting"], []);
        const perFile = rows(body, "files");
        assert.deepEqual(perFile.map((file) => [file["path"], file["action"]]), [
          ["src/a.ts", "auto"],
          ["src/b.ts", "review"],
        ]);
        const question = requestBody(requests[0]).questions["file_1_correctness"];
        assert.ok(String(question?.["instructions"]).includes("Judge only files[1]"));
      },
    );
  });
});
