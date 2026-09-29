// Adapted from jkudish/jev-mcp test/e2e.test.mjs (MIT): the live battery is replayed against
// the stub endpoint. See THIRD-PARTY-NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestBody } from "./mcp-client.ts";
import { payload, rows, withToolServer } from "./tool-harness.ts";

const candidates = [
  { id: "billing", text: "Invoices are issued monthly and can be downloaded as PDF." },
  { id: "auth", text: "To rotate an API key: create a new key in Settings > Keys, then revoke the old key." },
  { id: "support", text: "Contact support at support@example.com." },
];
const find = { query: "how do I rotate API keys", candidates, top_k: 2 };

describe("jev_find", () => {
  it("asks one choice over the candidate ids plus an existence question", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: {} } }),
      async ({ requests, call }) => {
        await call("jev_find", find);
        assert.equal(requests.length, 1);
        const body = requestBody(requests[0]);
        assert.deepEqual(body.state, { query: find.query, candidates });
        assert.deepEqual(Object.keys(body.questions).sort(), ["best", "exists"]);
        assert.equal(body.questions["best"]?.type, "choice");
        assert.deepEqual(body.questions["best"]?.["criteria"], { billing: null, auth: null, support: null });
        assert.equal(body.questions["exists"]?.type, "noul");
      },
    );
  });

  it("ranks the top_k candidates and reports that the query is answered", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: {
          answers: {
            best: {
              type: "choice",
              choice: "auth",
              confidence: 0.9,
              probabilities: { billing: 0.05, auth: 0.9, support: 0.05 },
            },
            exists: { type: "noul", noul: 0.95 },
          },
        },
      }),
      async ({ call }) => {
        const body = payload(await call("jev_find", find));
        assert.equal(body["exists"], 0.95);
        assert.equal(body["exists_verdict"], "answered");
        const top = rows(body, "top");
        assert.equal(top.length, 2, "top_k");
        assert.equal(top[0]?.["id"], "auth");
        assert.equal(top[0]?.["probability"], 0.9);
        assert.equal(top[1]?.["id"], "billing");
      },
    );
  });

  it("reports invalid_response rather than reading a missing answer as no match", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: { exists: { type: "noul", noul: 0.1 } } } }),
      async ({ call }) => {
        const body = payload(await call("jev_find", find));
        assert.equal(body["status"], "invalid_response");
        assert.equal(body["exists"], 0.1);
        assert.equal(body["exists_verdict"], null);
        assert.deepEqual(body["top"], []);
        assert.equal(body["reason"], "missing or malformed best or exists answer; cannot rank safely");
      },
    );
  });
});
