// Ported from jkudish/jev-mcp src/index.ts (MIT).
// Question design adapted from the TypeSafe SDE cascade cookbook (docs.typesafe.ai/cookbooks/sde_cascade).
// See THIRD-PARTY-NOTICES.md.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { validateNoulAnswer } from "../jev/answers.ts";
import { callJev, toolResult } from "../jev/call.ts";
import {
  MAX_AUDIT_RECORDS,
  MAX_AUDIT_REQUEST_CHARS,
  MAX_AUDIT_VALUE_CHARS,
  MAX_REVIEW_DOC_CHARS,
} from "../jev/limits.ts";
import { ANTI_INJECTION, yesNoQuestion } from "../jev/questions.ts";
import { truncate } from "../jev/text.ts";
import { strictShape } from "./schema.ts";

// Every check is framed so true = something is wrong with the value, so one
// max-gated threshold routes the record; a mean would dilute a fired flag.
const AUDIT_CHECKS: Record<string, { question: string; yes: string; no: string }> = {
  hallucinated: {
    question:
      "Is `records[i].value` unsupported by, or absent from, the `source`? Judge only against the source text, not world knowledge.",
    yes: "the value is not supported by, or is absent from, the source",
    no: "the value is supported by the source",
  },
  off_target: {
    question:
      "Does the `source` fail to genuinely provide what `records[i].request` asks for, so `records[i].value` was pulled from incidental text?",
    yes: "the source does not genuinely provide this value; it was pulled from incidental text",
    no: "the source genuinely provides this value",
  },
  incomplete: {
    question: "Does `records[i].value` fail to capture what the `source` supports for `records[i].request`?",
    yes: "the value fails to capture what the source supports",
    no: "the value captures what the source supports",
  },
  format: {
    question:
      "Does `records[i].value` violate the format or constraints implied by `records[i].request` (for example date format, units, or enumeration membership)?",
    yes: "the value violates the implied format or constraints",
    no: "the value satisfies the implied format or constraints",
  },
};

const AUDIT_ABSENCE = {
  question:
    "`records[i].value` is empty. Does the `source` contain what `records[i].request` asks for, making the empty result wrong?",
  yes: "a value was wrongly omitted",
  no: "returning nothing is correct",
};

export function registerAuditTool(server: McpServer, config: Config): void {
  server.registerTool(
    "jev_audit",
    {
      title: "Audit extracted values against their source text",
      description:
        "Audit extracted values against the text they claim to come from, before the values are trusted: one request with a " +
        "per-value failure-mode battery (hallucinated / off-target / incomplete / wrong format, each framed so true = something " +
        "is wrong) plus a dedicated omission check for empty values. Any value's P(wrong) at wrong_at escalates the whole audit; " +
        "max-gated, never averaged. For multimodal intake: run your vision or ASR model first to produce a dense transcript of the " +
        "image, scan, or recording, screen that transcript with jev_screen, then audit the extracted values against it here — the " +
        "tool never sees pixels or audio, it audits two text artifacts against each other. Schema validation catches structural " +
        "errors; it can flag a schema-valid fabrication against the supplied source text — " +
        "a limited cross-check, not verification of the original.",
      inputSchema: strictShape({
        source: z
          .string()
          .min(1)
          .describe(
            `The text the values claim to come from: a document, or the dense transcript a vision or ASR model produced. ` +
              `Truncated at ${MAX_REVIEW_DOC_CHARS.toLocaleString("en-US")} chars.`,
          ),
        records: z
          .array(
            z
              .object({
                id: z
                  .string()
                  .regex(/^[a-z][a-z0-9_-]*$/)
                  .max(64)
                  .describe("Short identifier for this value (e.g. 'due_date')."),
                request: z
                  .string()
                  .min(1)
                  .max(MAX_AUDIT_REQUEST_CHARS)
                  .describe("What was to be extracted, in one sentence (e.g. 'the due date in YYYY-MM-DD')."),
                value: z
                  .string()
                  .max(MAX_AUDIT_VALUE_CHARS)
                  .describe("The extracted value, verbatim; empty when the extractor returned nothing."),
              })
              .strict(),
          )
          .min(1)
          .max(MAX_AUDIT_RECORDS)
          .describe(`Extracted values to audit against the source. Up to ${MAX_AUDIT_RECORDS} per call.`),
        wrong_at: z
          .number()
          .min(0.5)
          .max(1)
          .optional()
          .describe("A record's P(wrong) at or above this flags the value and escalates. Default 0.7."),
      }),
    },
    async ({ source, records, wrong_at: wrongAtRaw }) => {
      const wrongAt = wrongAtRaw ?? 0.7;

      // Reject duplicate ids so wire-key mapping can never alias results.
      const seenIds = new Set<string>();
      for (const record of records) {
        if (seenIds.has(record.id)) throw new Error("Duplicate record id: " + record.id);
        seenIds.add(record.id);
      }

      const truncated =
        source.length > MAX_REVIEW_DOC_CHARS ||
        records.some(
          (record) => record.request.length > MAX_AUDIT_REQUEST_CHARS || record.value.length > MAX_AUDIT_VALUE_CHARS,
        );

      const state = {
        purpose: "Audit each extracted value against the source text it claims to come from.",
        source: truncate(source, MAX_REVIEW_DOC_CHARS),
        records: records.map((record) => ({
          id: record.id,
          request: truncate(record.request, MAX_AUDIT_REQUEST_CHARS),
          value: truncate(record.value, MAX_AUDIT_VALUE_CHARS),
        })),
      };
      // Anti-injection framing: a transcript of fetched content is evidence to
      // evaluate, never instructions to follow.
      const questions: Record<string, unknown> = {};
      records.forEach((record, i) => {
        const at = (text: string) => text.replaceAll("records[i]", `records[${i}]`);
        if (record.value.trim() === "") {
          questions[`absence_${i}`] = yesNoQuestion(config, at(AUDIT_ABSENCE.question) + ANTI_INJECTION, {
            true: AUDIT_ABSENCE.yes,
            false: AUDIT_ABSENCE.no,
          });
          return;
        }
        for (const [name, check] of Object.entries(AUDIT_CHECKS)) {
          questions[`check_${i}_${name}`] = yesNoQuestion(config, at(check.question) + ANTI_INJECTION, {
            true: check.yes,
            false: check.no,
          });
        }
      });

      const call = await callJev(config, state, questions);
      if (!call.ok) return call.result;
      const { answers, usage, provider, model } = call.reply;

      const results = records.map((record, i) => {
        const checks: Record<string, number> = {};
        let invalid = false;
        const read = (key: string, name: string) => {
          const probability = validateNoulAnswer(answers[key]);
          if (probability === null) invalid = true;
          else checks[name] = probability;
        };
        if (record.value.trim() === "") read(`absence_${i}`, "absence");
        else for (const name of Object.keys(AUDIT_CHECKS)) read(`check_${i}_${name}`, name);
        const probabilities = Object.values(checks);
        const pWrong = invalid ? null : probabilities.length > 0 ? Math.max(...probabilities) : null;
        return {
          id: record.id,
          value: record.value,
          checks,
          p_wrong: pWrong,
          ...(invalid ? { status: "invalid_response" as const } : {}),
          action: invalid
            ? ("invalid_response" as const)
            : pWrong !== null && pWrong >= wrongAt
              ? ("wrong" as const)
              : ("ok" as const),
        };
      });

      const flagged = results.filter((result) => result.action === "wrong").length;
      const invalidCount = results.filter((result) => result.action === "invalid_response").length;
      // Max-gated and fail closed: any fired flag or malformed answer escalates;
      // a truncated source can only demote pass to review, never keep it.
      const action = invalidCount > 0 || flagged > 0 ? "escalate" : truncated ? "review" : "pass";

      return toolResult({
        tool: "jev_audit",
        model,
        provider,
        action,
        wrong_at: wrongAt,
        truncated,
        summary: { records: results.length, flagged, invalid: invalidCount },
        records: results,
        usage,
      });
    },
  );
}
