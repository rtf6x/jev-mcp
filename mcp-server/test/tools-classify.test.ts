// Adapted from jkudish/jev-mcp test/e2e.test.mjs (MIT): the live battery is replayed against
// the stub endpoint. See THIRD-PARTY-NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestBody } from "./mcp-client.ts";
import { payload, record, rows, withToolServer } from "./tool-harness.ts";

const classify = {
  items: [
    { id: "refund", text: "I was charged twice. Please refund the duplicate payment." },
    { id: "crash", text: "The application crashes on startup." },
  ],
  classes: [
    { id: "billing", description: "Payments, invoicing, refunds, billing issues" },
    { id: "technical", description: "Bugs, crashes, outages, software problems" },
  ],
  purpose: "Route support tickets",
  context: { policy: "Refunds over $100 need a supervisor." },
};

const answer = (choice: string, top: number) => ({
  type: "choice",
  choice,
  confidence: 0.9,
  probabilities: { c0: choice === "c0" ? top : 1 - top, c1: choice === "c1" ? top : 1 - top },
});

describe("jev_classify", () => {
  it("sends the catalog once, keyed internally, one choice question per item", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: {} } }),
      async ({ requests, call }) => {
        await call("jev_classify", classify);
        assert.equal(requests.length, 1);
        const body = requestBody(requests[0]);
        assert.deepEqual(body.state, {
          purpose: "Route support tickets",
          context: { policy: "Refunds over $100 need a supervisor." },
          classes: [
            { id: "c0", description: "Payments, invoicing, refunds, billing issues" },
            { id: "c1", description: "Bugs, crashes, outages, software problems" },
          ],
        });
        assert.deepEqual(Object.keys(body.questions).sort(), ["i0", "i1"]);
        assert.deepEqual(body.questions["i0"]?.["criteria"], { c0: null, c1: null });
        assert.deepEqual(body.questions["i0"]?.["instructions"], {
          task: "Which class does this item belong to?",
          item: { id: "i0", text: classify.items[0]?.text },
        });
      },
    );
  });

  it("maps the chosen key back to the caller's id and gates auto on margin", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: { i0: answer("c0", 0.95), i1: answer("c1", 0.6) } } }),
      async ({ call }) => {
        const body = payload(await call("jev_classify", classify));
        const results = rows(body, "results");
        assert.equal(results[0]?.["classification"], "billing");
        assert.equal(results[0]?.["decision"], "auto");
        assert.equal(results[0]?.["top_probability"], 0.95);
        const probabilities = record(results[0] ?? {}, "probabilities");
        assert.deepEqual(Object.keys(probabilities).sort(), ["billing", "technical"]);
        assert.equal(probabilities["billing"], 0.95);
        assert.ok(Math.abs(Number(probabilities["billing"]) + Number(probabilities["technical"]) - 1) < 1e-9);
        assert.equal(results[1]?.["classification"], "technical");
        assert.equal(results[1]?.["decision"], "review", "0.6 is below the 0.85 top-probability floor");
        assert.ok(Math.abs(Number(results[1]?.["margin"]) - 0.2) < 1e-9);
        assert.deepEqual(body["summary"], {
          items: 2,
          auto: 1,
          review: 1,
          invalid_response: 0,
          by_class: { billing: 1, technical: 1 },
        });
        assert.deepEqual(body["thresholds"], { auto_accept: 0.85, minimum_margin: 0.5 });
      },
    );
  });

  it("reports a malformed distribution as invalid_response and tallies it", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: { answers: { i0: answer("c0", 0.95), i1: { type: "choice", choice: "c1", probabilities: { c1: 0.9 } } } },
      }),
      async ({ call }) => {
        const body = payload(await call("jev_classify", classify));
        const results = rows(body, "results");
        assert.equal(results[1]?.["status"], "invalid_response");
        assert.equal(results[1]?.["classification"], null);
        assert.equal(results[1]?.["decision"], "review");
        assert.deepEqual(record(body, "summary")["by_class"], { billing: 1 }, "an invalid item is never tallied");
        assert.equal(record(body, "summary")["invalid_response"], 1);
        assert.equal(record(body, "summary")["review"], 0);
      },
    );
  });
});
