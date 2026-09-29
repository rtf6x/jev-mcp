// Adapted from jkudish/jev-mcp test/e2e.test.mjs (MIT): the live battery is replayed against
// the stub endpoint. See THIRD-PARTY-NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestBody } from "./mcp-client.ts";
import { payload, record, rows, withToolServer } from "./tool-harness.ts";

const document = "Starter is $9/mo. Pro is $29/mo. Version 3.2.1 released 2024-06-01.";
const priceField = {
  id: "price_pro",
  pattern: "\\$\\d+",
  description: "The current monthly price of the Pro plan in US dollars",
};

describe("jev_extract", () => {
  it("sends the document once and only the fields that matched", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: {} } }),
      async ({ requests, call }) => {
        const fields = [priceField, { id: "sla_hours", pattern: "\\d+ hour", description: "Response time" }];
        await call("jev_extract", { document, fields, purpose: "Price the plan" });
        assert.equal(requests.length, 1);
        const body = requestBody(requests[0]);
        assert.deepEqual(body.state, {
          purpose: "Price the plan",
          document,
          fields: [{ id: "f0", description: priceField.description, pattern: priceField.pattern }],
        });
        assert.deepEqual(Object.keys(body.questions), ["f0"], "a field with no matches never reaches the model");
        assert.equal(body.questions["f0"]?.type, "choice");
        assert.deepEqual(body.questions["f0"]?.["criteria"], {
          c0: 'Candidate value: "$9"',
          c1: 'Candidate value: "$29"',
          none_of_them: "None of the candidates is the value this field asks for",
        });
      },
    );
  });

  it("returns the picked candidate verbatim, gated by confidence and margin", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: {
          answers: {
            f0: {
              type: "choice",
              choice: "c1",
              confidence: 0.9,
              probabilities: { c0: 0.05, c1: 0.9, none_of_them: 0.05 },
            },
          },
        },
      }),
      async ({ call }) => {
        const body = payload(await call("jev_extract", { document, fields: [priceField] }));
        const field = rows(body, "results")[0] ?? {};
        assert.equal(field["value"], "$29");
        assert.equal(field["status"], "auto");
        assert.equal(field["reason"], null);
        assert.equal(field["confidence"], 0.9);
        assert.equal(field["top_probability"], 0.9);
        assert.equal(field["candidates_considered"], 2);
        assert.equal(field["candidates_truncated"], false);
        assert.equal(field["matches_skipped_too_long"], 0);
        assert.deepEqual(record(body, "summary")["extracted"], 1);
      },
    );
  });

  it("returns no value when the answer is malformed", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: { answers: { f0: { type: "choice", choice: "c1", probabilities: { c0: 0.5, c1: 0.5 } } } },
      }),
      async ({ call }) => {
        const body = payload(await call("jev_extract", { document, fields: [priceField] }));
        const field = rows(body, "results")[0] ?? {};
        assert.equal(field["status"], "invalid_response");
        assert.equal(field["value"], null);
        assert.equal(field["reason"], null);
        assert.equal(field["candidates_considered"], 2);
      },
    );
  });

  it("makes no request at all when no field matched", async () => {
    await withToolServer(
      () => ({ status: 200, body: { usage: { input_tokens: 99 }, answers: {} } }),
      async ({ requests, call }) => {
        const body = payload(
          await call("jev_extract", {
            document,
            fields: [{ id: "sla_hours", pattern: "\\d+ hour", description: "Response time" }],
          }),
        );
        assert.equal(requests.length, 0);
        const field = rows(body, "results")[0] ?? {};
        assert.equal(field["status"], "not_found");
        assert.equal(field["reason"], "no_regex_matches");
        assert.equal(field["value"], null);
        assert.equal(body["usage"], null);
        assert.equal(body["model"], "jev-latest", "the configured model is reported when nothing was called");
      },
    );
  });

  it("gates a capped candidate universe even on a confident none_of_them", async () => {
    const versions = Array.from({ length: 25 }, (_, i) => `1.0.${i}`).join(" ");
    // The worker caps the universe at 20 candidates, so the answer must name all of them.
    const probabilities: Record<string, number> = { none_of_them: 1 };
    for (let i = 0; i < 20; i++) probabilities[`c${i}`] = 0;
    await withToolServer(
      () => ({
        status: 200,
        body: {
          answers: {
            f0: { type: "choice", choice: "none_of_them", confidence: 0.99, probabilities },
          },
        },
      }),
      async ({ call }) => {
        const body = payload(
          await call("jev_extract", {
            document: `Changelog: ${versions}`,
            fields: [{ id: "ceo", pattern: "\\d+\\.\\d+\\.\\d+", description: "The full name of the CEO" }],
          }),
        );
        const field = rows(body, "results")[0] ?? {};
        assert.equal(field["candidates_truncated"], true);
        assert.equal(field["status"], "review");
        assert.equal(field["reason"], "candidate_limit");
        assert.equal(field["value"], null);
      },
    );
  });
});
