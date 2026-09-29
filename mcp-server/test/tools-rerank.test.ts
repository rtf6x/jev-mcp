// Adapted from jkudish/jev-mcp test/e2e.test.mjs (MIT): the live battery is replayed against
// the stub endpoint. See THIRD-PARTY-NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestBody } from "./mcp-client.ts";
import { payload, rows, withToolServer } from "./tool-harness.ts";

const query = "how do I rotate API keys";

describe("jev_rerank", () => {
  it("asks one relevance question per candidate and keeps fallback ids collision-free", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: {} } }),
      async ({ requests, call }) => {
        const candidates = [
          { id: "candidate1", text: "Rotate an API key in Settings > Keys." },
          { text: "Invoices are issued monthly." },
        ];
        await call("jev_rerank", { query, candidates });
        assert.equal(requests.length, 1);
        const body = requestBody(requests[0]);
        assert.deepEqual(body.state, { query }, "the query lives once in the state");
        assert.deepEqual(Object.keys(body.questions).sort(), ["rel_0", "rel_1"]);
        assert.equal(body.questions["rel_0"]?.type, "noul");
        assert.equal(
          body.questions["rel_1"]?.["instructions"],
          "Is candidate c1 relevant to the query in the state? Candidate c1: Invoices are issued monthly.",
        );
      },
    );
  });

  it("scores every candidate and sorts the whole ordering", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: {
          answers: {
            rel_0: { type: "noul", noul: 0.12 },
            rel_1: { type: "noul", noul: 0.91 },
            rel_2: { type: "noul", noul: 0.4 },
          },
        },
      }),
      async ({ call }) => {
        const candidates = [
          { id: "billing", text: "Invoices." },
          { id: "auth", text: "Rotate keys." },
          { id: "support", text: "Contact support." },
        ];
        const body = payload(await call("jev_rerank", { query, candidates }));
        const ranked = rows(body, "ranked");
        assert.deepEqual(
          ranked.map((row) => [row["rank"], row["id"], row["relevance"]]),
          [
            [1, "auth", 0.91],
            [2, "support", 0.4],
            [3, "billing", 0.12],
          ],
        );
        assert.deepEqual(body["summary"], { candidates: 3, returned: 3 });
      },
    );
  });

  it("returns no ordering at all when one relevance answer is malformed", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: { answers: { rel_0: { type: "noul", noul: 0.12 }, rel_1: { type: "noul", noul: "high" } } },
      }),
      async ({ call }) => {
        const body = payload(await call("jev_rerank", { query, candidates: [{ id: "a", text: "A" }, { id: "b", text: "B" }] }));
        assert.equal(body["status"], "invalid_response");
        assert.equal(body["ranked"], null);
      },
    );
  });
});
