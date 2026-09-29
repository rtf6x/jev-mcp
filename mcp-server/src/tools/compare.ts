// Ported from jkudish/jev-mcp src/index.ts (MIT). See THIRD-PARTY-NOTICES.md.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { validateChoiceAnswer } from "../jev/answers.ts";
import { callJev, toolResult } from "../jev/call.ts";
import { MAX_COMPARE_ASPECTS } from "../jev/limits.ts";
import { classificationDecision, marginOf } from "../jev/policy.ts";
import { choiceQuestion } from "../jev/questions.ts";
import { truncate } from "../jev/text.ts";
import { strictShape } from "./schema.ts";

/** The three pairwise relations jev_compare judges overall. */
const COMPARE_RELATIONS = {
  same_fact: "Both passages state the same underlying fact or claim",
  contradicts: "The passages state opposing facts about the same subject",
  different_facts: "The passages discuss different subjects or make non-overlapping claims",
} as const;

/**
 * Per-aspect wording of the same three relations. At aspect granularity the
 * third outcome usually means one or both passages do not address the aspect,
 * so the criterion says so explicitly instead of relying on the label alone.
 */
const ASPECT_RELATIONS = {
  same_fact: "Both passages make comparable assertions about this aspect and they agree",
  contradicts: "Both passages address this aspect and their assertions conflict",
  different_facts:
    "The passages do not both make a comparable assertion about this aspect: at least one does not address it, or their mentions do not overlap",
} as const;

export function registerCompareTool(server: McpServer, config: Config): void {
  server.registerTool(
    "jev_compare",
    {
      title: "Compare two passages for factual agreement",
      description:
        "Judge the relation between two passages with TypeSafe Jev: same_fact, contradicts, or different_facts, " +
        "with the full probability distribution, confidence, and an auto-versus-review decision. " +
        "Optionally supply aspects (price, date, method, …) and each gets an independent per-aspect judgment " +
        "in the same single request. Use for source reconciliation, changelog-vs-code drift, or merge sanity checks. " +
        "The request supplies no evidence beyond the two passages, so a same_fact verdict means they agree with each other, not that they are true.",
      inputSchema: strictShape({
        passage_a: z.string().min(1).max(20000).describe("First passage. Rejected above 20,000 characters."),
        passage_b: z.string().min(1).max(20000).describe("Second passage. Rejected above 20,000 characters."),
        aspects: z
          .array(z.string().min(1).max(200))
          .max(MAX_COMPARE_ASPECTS)
          .optional()
          .describe("Named aspects to judge independently (e.g. 'price', 'launch date'). Each tests one property."),
        purpose: z.string().optional().describe("What this comparison is for; helps disambiguate overlap."),
        auto_accept: z.number().min(0).max(1).optional().describe("Minimum top probability for auto. Default 0.85."),
        minimum_margin: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Minimum winner-to-runner-up gap for auto. Default 0.5."),
      }),
    },
    async ({ passage_a, passage_b, aspects: rawAspects, purpose, auto_accept, minimum_margin }) => {
      const autoAccept = auto_accept ?? 0.85;
      const minMargin = minimum_margin ?? 0.5;
      const aspects = rawAspects ?? [];

      const a = truncate(passage_a, 20000);
      const b = truncate(passage_b, 20000);

      // Overall relation plus one independent Choice per aspect, one request.
      // Aspect questions use aspect-specific wording for the third outcome,
      // where "different facts" usually means one passage does not address it.
      const questions: Record<string, unknown> = {
        overall: choiceQuestion(
          "Do the two passages state the same underlying fact, contradict each other, or discuss different facts?",
          { ...COMPARE_RELATIONS },
        ),
      };
      aspects.forEach((aspect, i) => {
        questions[`aspect_${i}`] = choiceQuestion(
          `Judging only the aspect "${aspect}" of the two passages in the state, which relation holds?`,
          { ...ASPECT_RELATIONS },
        );
      });

      const state = { purpose: purpose ?? null, passage_a: a, passage_b: b, aspects };
      const call = await callJev(config, state, questions);
      if (!call.ok) return call.result;
      const { answers, usage, provider, model } = call.reply;

      const expected = new Set(Object.keys(COMPARE_RELATIONS));

      // classify-grade validation via the shared validateChoiceAnswer; the
      // overall and aspect questions share the same three relation keys.
      const shape = (raw: unknown) => {
        const answer = validateChoiceAnswer(raw, expected);
        if (!answer) {
          return {
            relation: null,
            probabilities: null,
            confidence: null,
            margin: null,
            decision: "review" as const,
            status: "invalid_response" as const,
          };
        }
        const margin = marginOf(answer.probabilities);
        return {
          relation: answer.choice,
          probabilities: answer.probabilities,
          confidence: answer.confidence,
          margin,
          decision: classificationDecision(answer.probabilities[answer.choice] ?? 0, margin, autoAccept, minMargin),
        };
      };

      const overall = shape(answers["overall"]);
      const aspectResults = aspects.map((aspect, i) => ({ aspect, ...shape(answers[`aspect_${i}`]) }));

      return toolResult({
        tool: "jev_compare",
        model,
        provider,
        overall,
        aspects: aspectResults,
        thresholds: { auto_accept: autoAccept, minimum_margin: minMargin },
        usage,
      });
    },
  );
}
