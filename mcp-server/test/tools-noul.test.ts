// Adapted from jkudish/jev-mcp test/e2e.test.mjs (MIT): the live battery is replayed against
// the stub endpoint. See THIRD-PARTY-NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestBody } from "./mcp-client.ts";
import { payload, rows, withToolServer } from "./tool-harness.ts";

const propositions = ["Paris is the capital of France", "The moon is made entirely of cheese"];

describe("jev_noul", () => {
  it("asks one yes/no question per proposition against the supplied context", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: {} } }),
      async ({ requests, call }) => {
        await call("jev_noul", { propositions, context: { text: "Reference material." } });
        assert.equal(requests.length, 1);
        const body = requestBody(requests[0]);
        assert.deepEqual(body.state, {
          propositions: propositions.map((text, i) => ({ text, id: `proposition${i}` })),
          context: [{ text: "Reference material." }],
        });
        assert.deepEqual(Object.keys(body.questions).sort(), ["p_proposition0", "p_proposition1"]);
        assert.equal(body.questions["p_proposition0"]?.type, "noul");
        assert.equal(body.questions["p_proposition0"]?.["instructions"], "proposition `proposition0`: Paris is the capital of France");
      },
    );
  });

  it("labels a probability against the threshold, with p + auto_accept <= 1 for unlikely", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: {
          answers: {
            p_proposition0: { type: "noul", noul: 0.93 },
            p_proposition1: { type: "noul", probability: 0.08 },
          },
          usage: { inputTokens: 12, outputTokens: 4, cost: 0.03 },
        },
      }),
      async ({ call }) => {
        const body = payload(await call("jev_noul", { propositions }));
        assert.equal(body["status"], "ok");
        const results = rows(body, "results");
        assert.equal(results[0]?.["label"], "likely");
        assert.equal(results[0]?.["auto"], true);
        assert.equal(results[1]?.["label"], "unlikely");
        assert.equal(results[1]?.["probability"], 0.08);
        assert.deepEqual(body["thresholds"], { auto_accept: 0.85 });
        assert.deepEqual(body["usage"], { input_tokens: 12, output_tokens: 4, cost: 0.03 }, "camelCase counters");
      },
    );
  });

  it("fails closed on a malformed probability, without ever labelling it", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: { answers: { p_proposition0: { type: "noul", noul: 0.93 }, p_proposition1: { type: "noul", noul: 1.4 } } },
      }),
      async ({ call }) => {
        const body = payload(await call("jev_noul", { propositions }));
        assert.equal(body["status"], "invalid_response");
        assert.deepEqual(body["invalid"], ["proposition1"]);
        const results = rows(body, "results");
        assert.equal(results[1]?.["probability"], null);
        assert.equal(results[1]?.["label"], null);
        assert.equal(results[1]?.["auto"], false);
      },
    );
  });
});
