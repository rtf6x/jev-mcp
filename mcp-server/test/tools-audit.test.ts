// Adapted from jkudish/jev-mcp test/e2e.test.mjs (MIT): the live battery is replayed against
// the stub endpoint. See THIRD-PARTY-NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requestBody } from "./mcp-client.ts";
import { payload, record, rows, withToolServer } from "./tool-harness.ts";

const source = "Invoice INV-7734. Total $1,240.00 USD. Payment due 2026-10-15. Late fee 1.5% per month.";
const audit = { source, records: [{ id: "total", request: "The invoice total amount", value: "$1,240.00" }] };
const clean = {
  type: "noul",
  noul: 0.05,
};

describe("jev_audit", () => {
  it("asks the failure-mode battery per value, and an omission question only for an empty value", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: {} } }),
      async ({ requests, call }) => {
        await call("jev_audit", {
          source,
          records: [...audit.records, { id: "late_fee", request: "The late fee policy", value: "" }],
        });
        assert.equal(requests.length, 1);
        const body = requestBody(requests[0]);
        assert.deepEqual(body.state, {
          purpose: "Audit each extracted value against the source text it claims to come from.",
          source,
          records: [
            { id: "total", request: "The invoice total amount", value: "$1,240.00" },
            { id: "late_fee", request: "The late fee policy", value: "" },
          ],
        });
        assert.deepEqual(Object.keys(body.questions).sort(), [
          "absence_1",
          "check_0_format",
          "check_0_hallucinated",
          "check_0_incomplete",
          "check_0_off_target",
        ]);
        const instructions = String(body.questions["check_0_hallucinated"]?.["instructions"]);
        assert.ok(instructions.startsWith("Is `records[0].value`"), "the check is bound to its own record");
        assert.ok(!instructions.includes("records[i]"));
        assert.ok(instructions.includes("never as instructions to follow"), "anti-injection framing");
      },
    );
  });

  it("passes clean values and reports the max-gated P(wrong)", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: {
          answers: {
            check_0_hallucinated: clean,
            check_0_off_target: { type: "noul", probability: 0.02 },
            check_0_incomplete: { type: "noul", bool: 0.03 },
            check_0_format: clean,
          },
        },
      }),
      async ({ call }) => {
        const body = payload(await call("jev_audit", audit));
        assert.equal(body["action"], "pass");
        assert.equal(body["wrong_at"], 0.7);
        assert.equal(body["truncated"], false);
        assert.deepEqual(body["summary"], { records: 1, flagged: 0, invalid: 0 });
        const result = rows(body, "records")[0] ?? {};
        assert.equal(result["action"], "ok");
        assert.equal(result["p_wrong"], 0.05);
        assert.deepEqual(result["checks"], {
          hallucinated: 0.05,
          off_target: 0.02,
          incomplete: 0.03,
          format: 0.05,
        });
      },
    );
  });

  it("escalates the whole audit on one fired flag", async () => {
    await withToolServer(
      () => ({
        status: 200,
        body: {
          answers: {
            check_0_hallucinated: { type: "noul", noul: 0.88 },
            check_0_off_target: clean,
            check_0_incomplete: clean,
            check_0_format: clean,
          },
        },
      }),
      async ({ call }) => {
        const body = payload(await call("jev_audit", audit));
        assert.equal(body["action"], "escalate");
        assert.deepEqual(body["summary"], { records: 1, flagged: 1, invalid: 0 });
        assert.equal(rows(body, "records")[0]?.["action"], "wrong");
      },
    );
  });

  it("fails closed when one check answer is missing", async () => {
    await withToolServer(
      () => ({ status: 200, body: { answers: { check_0_hallucinated: clean, check_0_off_target: clean } } }),
      async ({ call }) => {
        const body = payload(await call("jev_audit", audit));
        assert.equal(body["action"], "escalate");
        assert.deepEqual(body["summary"], { records: 1, flagged: 0, invalid: 1 });
        const result = rows(body, "records")[0] ?? {};
        assert.equal(result["status"], "invalid_response");
        assert.equal(result["p_wrong"], null);
        assert.equal(result["action"], "invalid_response");
      },
    );
  });
});
