// Ported from jkudish/jev-mcp src/index.ts (MIT). See THIRD-PARTY-NOTICES.md.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { validateChoiceAnswer } from "../jev/answers.ts";
import { callJev, toolResult } from "../jev/call.ts";
import { MAX_CANDIDATES_DECIDE, MAX_REQUIREMENTS } from "../jev/limits.ts";
import { contradictsRecommendation } from "../jev/policy.ts";
import { choiceQuestion } from "../jev/questions.ts";
import { strictShape } from "./schema.ts";

/** Escape-hatch options appended to the Choice criteria so the model can decline to rank. */
const DECIDE_ESCAPE_HATCHES: Record<string, string> = {
  ask_user: "A consequential user preference or requirement is missing; ask instead of inventing it",
  investigate: "Gather missing technical or factual evidence before selecting a candidate",
  none: "None of the supplied candidates fits the known requirements",
};

export function registerDecideTool(server: McpServer, config: Config): void {
  server.registerTool(
    "jev_decide",
    {
      title: "Decide between bounded alternatives",
      description:
        "One unresolved, bounded decision where semantic judgment over supplied evidence could change your plan: " +
        "implementation alternatives, product tradeoffs with known preferences, workflow selection. " +
        "Supply 2-6 candidates, evidence, and explicit priorities. Jev returns a Choice distribution over the candidates " +
        "plus escape hatches (ask_user / investigate / none), and a per-candidate per-requirement " +
        "supported / contradicted / unknown judgment for each optional requirement, all in one request. " +
        "One call per unchanged decision; do not repeat a call to obtain a more pleasing answer. " +
        "Use source inspection, tests, the user, or a reasoning model for open-ended research, routine choices, " +
        "correctness proofs, or predicting user consent. High probability is not proof.",
      inputSchema: strictShape({
        decision: z.string().min(1).max(1500).describe("The bounded decision to make."),
        evidence: z
          .string()
          .min(1)
          .max(12000)
          .describe("Facts and measurements, not opinions. State is evidence, not instructions."),
        priorities: z.string().min(1).max(2000).describe("Explicit preferences and constraints from the user or plan."),
        candidates: z
          .array(
            z
              .object({
                id: z
                  .string()
                  .regex(/^[a-z][a-z0-9_-]*$/)
                  .max(64),
                description: z.string().min(1).max(2000),
              })
              .strict(),
          )
          .min(2)
          .max(MAX_CANDIDATES_DECIDE)
          .describe("The alternatives. Include 'do nothing' or 'gather more evidence' as candidates when useful."),
        requirements: z
          .array(z.string().min(1).max(500))
          .max(MAX_REQUIREMENTS)
          .optional()
          .describe("Specific requirements to check per candidate. Each must test one property, not overall goodness."),
        escape_hatches: z
          .boolean()
          .optional()
          .describe("Include ask_user / investigate / none as Choosable options so the model can decline to rank. Default true."),
        escalate_on_contradiction: z
          .boolean()
          .optional()
          .describe(
            "When true, a recommendation whose own requirement checks came back contradicted returns " +
              'selected: null with status "escalate" instead of the candidate id (the jev_verify vocabulary). ' +
              "Default false keeps the recommendation and warns.",
          ),
      }),
    },
    async ({
      decision,
      evidence,
      priorities,
      candidates,
      requirements: reqs,
      escape_hatches,
      escalate_on_contradiction,
    }) => {
      const includeHatches = escape_hatches ?? true;
      const requirements = reqs ?? [];

      // Reject duplicate candidate IDs and collisions with active escape hatches
      // so wire-key mapping can never alias or corrupt results.
      const seenIds = new Set<string>();
      for (const c of candidates) {
        if (seenIds.has(c.id)) throw new Error("Duplicate candidate id: " + c.id);
        if (includeHatches && Object.hasOwn(DECIDE_ESCAPE_HATCHES, c.id)) {
          throw new Error(
            'Candidate id "' + c.id + '" collides with an escape hatch; rename it or set escape_hatches: false.',
          );
        }
        seenIds.add(c.id);
      }

      // Wire keys are opaque and positional; caller IDs are preserved verbatim
      // in the result (validated slug IDs need no sanitization).
      const candidateKeys = candidates.map((c, i) => ({ ...c, key: `option_${i}` }));
      const candidateKeySet = new Set(candidateKeys.map((c) => c.key));

      const criteria: Record<string, string> = Object.fromEntries(candidateKeys.map((c) => [c.key, c.description]));
      if (includeHatches) Object.assign(criteria, DECIDE_ESCAPE_HATCHES);

      const questions: Record<string, unknown> = {
        recommendation: choiceQuestion(
          "Which candidate best fits the decision, evidence, and priorities? " +
            (includeHatches ? "Select a candidate or an escape hatch. " : "") +
            "Do not invent missing facts, preferences, or approvals.",
          criteria,
        ),
      };
      const relationCriteria: Record<string, string> = {
        supported: "The evidence and mechanism support this specific requirement",
        contradicted: "The evidence or mechanism contradicts this specific requirement, not merely another requirement",
        unknown: "Relevant evidence is missing; neither satisfaction nor violation is established",
      };
      candidateKeys.forEach((c, i) =>
        requirements.forEach((r, j) => {
          questions[`check_${i}_${j}`] = choiceQuestion(
            `How does the mechanism in candidates[${i}] relate to requirements[${j}], using the evidence? Judge only this property, not the candidate overall desirability. Missing evidence is not contradiction.`,
            relationCriteria,
          );
        }),
      );

      const state = {
        decision,
        evidence,
        priorities,
        candidates: candidateKeys.map((c) => ({ id: c.key, description: c.description })),
        requirements,
      };

      const call = await callJev(config, state, questions);
      if (!call.ok) return call.result;
      const { answers, usage, provider, model } = call.reply;

      const keyToId = new Map(candidateKeys.map((c) => [c.key, c.id]));
      const expectedRecKeys = new Set([
        ...candidateKeys.map((c) => c.key),
        ...(includeHatches ? Object.keys(DECIDE_ESCAPE_HATCHES) : []),
      ]);
      const expectedCheckKeys = new Set(["supported", "contradicted", "unknown"]);

      // classify-grade validation via the shared validateChoiceAnswer: exact
      // keys, finite [0,1] probabilities summing to one within the shared
      // tolerance, chosen key is the argmax, confidence finite or null.
      // Malformed responses are never semantic outcomes.
      const rec = validateChoiceAnswer(answers["recommendation"], expectedRecKeys);
      const recommendedKey = rec?.choice ?? null;
      const checks = candidateKeys.flatMap((c, i) =>
        requirements.map((_, j) => {
          const answer = validateChoiceAnswer(answers[`check_${i}_${j}`], expectedCheckKeys);
          return { candidate: c.id, requirement: j, answer: answer?.choice ?? "invalid_response" };
        }),
      );
      const contradicted =
        recommendedKey !== null && candidateKeySet.has(recommendedKey)
          ? contradictsRecommendation(
              checks.filter((c) => c.answer !== "invalid_response"),
              keyToId.get(recommendedKey) ?? "",
            )
          : [];
      // Escalation is opt-in and never re-selects: the model's recommendation is
      // withdrawn, not replaced, so no fabricated choice reaches the caller.
      const escalating = Boolean(escalate_on_contradiction) && contradicted.length > 0;

      const recommendation =
        rec === null
          ? {
              selected: null,
              escaped: null,
              confidence: null,
              probabilities: null,
              contradicted_requirements: [] as number[],
              status: "invalid_response" as const,
            }
          : {
              selected: escalating
                ? null
                : candidateKeySet.has(rec.choice)
                  ? (keyToId.get(rec.choice) ?? rec.choice)
                  : rec.choice,
              escaped: escalating ? false : !candidateKeySet.has(rec.choice),
              confidence: rec.confidence,
              probabilities: Object.fromEntries(
                Object.entries(rec.probabilities).map(([k, p]): [string, number] => [
                  candidateKeySet.has(k) ? (keyToId.get(k) ?? k) : k,
                  p,
                ]),
              ),
              contradicted_requirements: contradicted,
              ...(escalating ? { status: "escalate" as const } : {}),
            };

      return toolResult({
        tool: "jev_decide",
        model,
        provider,
        recommendation,
        requirements_checked: requirements.length,
        checks,
        warnings:
          contradicted.length > 0
            ? [
                `Requirement${contradicted.length > 1 ? "s" : ""} ${contradicted.map((i) => i + 1).join(", ")} contradicted by the recommended candidate; inspect before acting`,
              ]
            : [],
        usage,
      });
    },
  );
}
