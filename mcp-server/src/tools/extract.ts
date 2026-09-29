// Ported from jkudish/jev-mcp src/index.ts (MIT). See THIRD-PARTY-NOTICES.md.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { callJev, skippedCall, toolResult } from "../jev/call.ts";
import { isRecord } from "../guards.ts";
import {
  MAX_EXTRACT_FIELDS,
  MAX_EXTRACT_TOTAL_CHARS,
  PROBABILITY_SUM_TOLERANCE,
} from "../jev/limits.ts";
import { classificationDecision, marginOf } from "../jev/policy.ts";
import { choiceQuestion } from "../jev/questions.ts";
import { runRegex } from "../jev/regex.ts";
import { truncate } from "../jev/text.ts";
import { strictShape } from "./schema.ts";

export function registerExtractTool(server: McpServer, config: Config): void {
  server.registerTool(
    "jev_extract",
    {
      title: "Extract fields by regex, Jev picks the right match",
      description:
        "Extract structured fields from a document with TypeSafe Jev as the picker, not the generator: your regex " +
        "finds candidate substrings in code, Jev chooses which candidate is the field's true value, and the result is " +
        "returned verbatim — never model-generated text. Fields with zero regex matches never reach the model " +
        "(not_found); if no field has matches, no API call is made. Ambiguous picks are flagged for review. Use for prices, dates, version numbers, " +
        "IDs, and anything with a recognizable shape; keep documents bounded.",
      inputSchema: strictShape({
        document: z.string().min(1).max(50000).describe("The document to extract from. Rejected above 50,000 characters."),
        fields: z
          .array(
            z
              .object({
                id: z
                  .string()
                  .regex(/^[a-z][a-z0-9_-]*$/)
                  .max(64)
                  .describe("Field name, e.g. 'price' or 'version'."),
                pattern: z
                  .string()
                  .min(1)
                  .max(500)
                  .describe(
                    "JavaScript regex source (without delimiters) that matches candidate values. Runs in a sandboxed worker with a hard timeout.",
                  ),
                flags: z.string().max(8).optional().describe("Regex flags (e.g. 'i'). 'g' is always added; non-letters are dropped."),
                description: z
                  .string()
                  .min(1)
                  .max(2000)
                  .describe("What the field is, so Jev can pick the right candidate among regex matches."),
              })
              .strict(),
          )
          .min(1)
          .max(MAX_EXTRACT_FIELDS)
          .describe(`Fields to extract. Up to ${MAX_EXTRACT_FIELDS} per call, all judged in one request.`),
        purpose: z.string().optional().describe("What the extraction is for; shared across fields."),
        auto_accept: z.number().min(0).max(1).optional().describe("Minimum top probability for auto. Default 0.85."),
        minimum_margin: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Minimum winner-to-runner-up gap for auto. Default 0.5."),
      }),
    },
    async ({ document, fields: rawFields, purpose, auto_accept, minimum_margin }, extra) => {
      const autoAccept = auto_accept ?? 0.85;
      const minMargin = minimum_margin ?? 0.5;
      const doc = truncate(document, 50000);

      const seenFieldIds = new Set<string>();
      for (const f of rawFields) {
        if (seenFieldIds.has(f.id)) throw new Error(`Duplicate field id: ${f.id}`);
        seenFieldIds.add(f.id);
      }

      // Regex runs in an isolated worker; Jev only picks among the matches.
      // Zero-length matches are dropped and overlong matches are skipped before
      // the cap is applied, so eligible matches are never crowded out by
      // ineligible ones, and candidate identity on the wire always equals the
      // value returned.
      const fields: Array<{
        id: string;
        pattern: string;
        description: string;
        key: string;
        candidates: string[];
        tooLong: number;
        truncated: boolean;
        error: string | null;
      }> = [];
      for (let i = 0; i < rawFields.length; i++) {
        const f = rawFields[i];
        if (f === undefined) break;
        // A cancelled request's regex work serves nobody; stop scheduling it.
        if (extra.signal.aborted) break;
        // Strip every g (and non-letters) before appending exactly one, so
        // multi-letter flags like "gi" never become "gig" and throw.
        const flags = (f.flags ?? "").replace(/[^a-z]/g, "").replace(/g/g, "") + "g";
        const result = await runRegex(doc, f.pattern, flags, extra.signal);
        fields.push({
          id: f.id,
          pattern: f.pattern,
          description: f.description,
          key: `f${i}`,
          candidates: result.error ? [] : result.candidates,
          tooLong: result.tooLong,
          truncated: result.truncated,
          error: result.error,
        });
      }

      // Aggregate preview budget across all fields keeps one request bounded.
      const totalPreviewChars = fields.reduce((n, f) => n + f.candidates.reduce((m, c) => m + c.length, 0), 0);
      if (totalPreviewChars > MAX_EXTRACT_TOTAL_CHARS) {
        throw new Error(
          `Batch too large: ${totalPreviewChars} candidate characters exceeds the ${MAX_EXTRACT_TOTAL_CHARS} character budget. Tighten the patterns or split the call.`,
        );
      }

      // One request: one Choice per field that has candidates. Zero-match and
      // invalid-pattern fields never reach the model. Candidates appear only in
      // their own question's criteria; the document is sent once in the state.
      const questions: Record<string, unknown> = {};
      const stateFields: Array<{ id: string; description: string; pattern: string }> = [];
      for (const f of fields) {
        if (f.error || f.candidates.length === 0) continue;
        const criteria: Record<string, string> = Object.fromEntries(
          f.candidates.map((c, j) => [`c${j}`, `Candidate value: ${JSON.stringify(c)}`]),
        );
        criteria["none_of_them"] = "None of the candidates is the value this field asks for";
        questions[f.key] = choiceQuestion(
          `Which candidate is the correct value of the field "${f.id}" (${f.description}) in the document in the state? Pick the exact substring the document presents as this field's value.`,
          criteria,
        );
        stateFields.push({ id: f.key, description: f.description, pattern: f.pattern });
      }

      // No candidates anywhere means nothing to ask: the model is never called.
      const call =
        stateFields.length > 0
          ? await callJev(config, { purpose: purpose ?? null, document: doc, fields: stateFields }, questions)
          : null;
      if (call !== null && !call.ok) return call.result;
      const { answers, usage, provider, model } = call === null ? skippedCall(config) : call.reply;

      const results = fields.map((f) => {
        const flags = { candidates_truncated: f.truncated, matches_skipped_too_long: f.tooLong };
        // An incomplete candidate universe (capped or overlong-skipped matches)
        // poisons every outcome, including none_of_them: the right value may be
        // among the matches we did not send, so nothing can be auto or a
        // definite not_found.
        const incomplete = f.truncated || f.tooLong > 0;
        if (f.error) {
          return {
            id: f.id,
            value: null,
            status: "invalid_pattern" as const,
            reason: f.error,
            candidates_considered: 0,
            ...flags,
          };
        }
        if (f.candidates.length === 0) {
          return f.tooLong > 0
            ? {
                id: f.id,
                value: null,
                status: "review" as const,
                reason: "matches_too_long" as const,
                candidates_considered: 0,
                ...flags,
              }
            : {
                id: f.id,
                value: null,
                status: "not_found" as const,
                reason: "no_regex_matches" as const,
                candidates_considered: 0,
                ...flags,
              };
        }
        const raw = answers[f.key];
        const answer = isRecord(raw) ? raw : null;
        const rawProbabilities = answer === null ? null : answer["probabilities"];
        const probabilities: Record<string, number> = isRecord(rawProbabilities)
          ? (rawProbabilities as Record<string, number>)
          : {};
        const keys = Object.keys(probabilities);
        const values = Object.values(probabilities);
        const expectedKeys = new Set([...f.candidates.map((_, j) => `c${j}`), "none_of_them"]);
        const choice = answer === null ? undefined : answer["choice"];
        const valid =
          typeof choice === "string" &&
          expectedKeys.has(choice) &&
          keys.length === expectedKeys.size &&
          keys.every((k) => expectedKeys.has(k)) &&
          values.every((p) => Number.isFinite(p) && p >= 0 && p <= 1) &&
          Math.abs(values.reduce((x, y) => x + y, 0) - 1) <= PROBABILITY_SUM_TOLERANCE &&
          (probabilities[choice] ?? Number.NaN) >= Math.max(...values) - 1e-9;
        if (!valid || typeof choice !== "string" || answer === null) {
          return {
            id: f.id,
            value: null,
            status: "invalid_response" as const,
            reason: null,
            candidates_considered: f.candidates.length,
            ...flags,
          };
        }
        const margin = marginOf(probabilities);
        const topProbability = probabilities[choice] ?? 0;
        const rawConfidence = answer["confidence"];
        const confidence =
          typeof rawConfidence === "number" && Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1
            ? rawConfidence
            : null;
        if (choice === "none_of_them") {
          // The negative answer is gated like a positive one, and an incomplete
          // universe makes even a confident "none of them" provisional.
          if (incomplete) {
            return {
              id: f.id,
              value: null,
              status: "review" as const,
              reason: "candidate_limit" as const,
              confidence,
              top_probability: topProbability,
              margin,
              candidates_considered: f.candidates.length,
              ...flags,
            };
          }
          return classificationDecision(topProbability, margin, autoAccept, minMargin) === "auto"
            ? {
                id: f.id,
                value: null,
                status: "not_found" as const,
                reason: "none_matched" as const,
                confidence,
                top_probability: topProbability,
                margin,
                candidates_considered: f.candidates.length,
                ...flags,
              }
            : {
                id: f.id,
                value: null,
                status: "review" as const,
                reason: "none_matched_ambiguous" as const,
                confidence,
                top_probability: topProbability,
                margin,
                candidates_considered: f.candidates.length,
                ...flags,
              };
        }
        // The best value may be among the unsent matches; a truncated universe
        // can never be auto.
        const decision = incomplete ? ("review" as const) : classificationDecision(topProbability, margin, autoAccept, minMargin);
        return {
          id: f.id,
          // The exact-key check above proves the index is in range.
          value: f.candidates[Number(choice.slice(1))] ?? null,
          status: decision,
          reason: incomplete ? ("candidate_limit" as const) : null,
          confidence,
          top_probability: topProbability,
          margin,
          candidates_considered: f.candidates.length,
          ...flags,
        };
      });

      return toolResult({
        tool: "jev_extract",
        model,
        provider,
        summary: {
          fields: results.length,
          extracted: results.filter((r) => r.value !== null).length,
          auto: results.filter((r) => r.status === "auto").length,
          review: results.filter((r) => r.status === "review").length,
          not_found: results.filter((r) => r.status === "not_found").length,
          invalid: results.filter((r) => r.status === "invalid_pattern" || r.status === "invalid_response").length,
        },
        thresholds: { auto_accept: autoAccept, minimum_margin: minMargin },
        results,
        usage,
      });
    },
  );
}
