// Ported from jkudish/jev-mcp src/index.ts (MIT). See THIRD-PARTY-NOTICES.md.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { confidenceRejected, validateChoiceAnswer } from "../jev/answers.ts";
import { callJev, toolResult } from "../jev/call.ts";
import { verifyAction } from "../jev/policy.ts";
import { choiceQuestion } from "../jev/questions.ts";
import { ensureUniqueIds } from "../jev/text.ts";
import { evidenceSchema, strictShape } from "./schema.ts";

/** The criteria a jev_verify relation question offers (citation-check cookbook). */
const RELATION_CRITERIA = {
  supports: "The evidence states the claim or directly implies that it is true",
  contradicts: "The evidence states the opposite of the claim or implies that it is false",
  says_nothing: "The evidence does not address what the claim asserts, either way",
} as const;

/** Relation answer -> verdict label. */
const RELATION_TO_VERDICT = {
  supports: "verified",
  contradicts: "contradicted",
  says_nothing: "unsupported",
} as const satisfies Record<keyof typeof RELATION_CRITERIA, string>;

function isRelation(value: string): value is keyof typeof RELATION_CRITERIA {
  return Object.hasOwn(RELATION_CRITERIA, value);
}

export function registerVerifyTool(server: McpServer, config: Config): void {
  server.registerTool(
    "jev_verify",
    {
      title: "Verify claims against evidence",
      description:
        "Check each claim against provided evidence text with TypeSafe Jev. Returns per claim: " +
        "verdict (verified | contradicted | unsupported), full probability distribution, confidence, " +
        "and whether the verdict stands on its own (auto) or needs human review. " +
        "Pattern: docs.typesafe.ai/cookbooks/citation_check. Pass reports, PR descriptions, or agent briefs as claims " +
        "and their cited sources, diffs, or documents as evidence.",
      inputSchema: strictShape({
        claims: z
          .array(z.string())
          .min(1)
          .describe("Claims to verify, e.g. individual factual statements from a report."),
        evidence: evidenceSchema,
        auto_accept: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Verdicts at or above this confidence stand automatically; below it they are flagged 'review'. Default 0.8."),
      }),
    },
    async ({ claims, evidence: rawEvidence, auto_accept }) => {
      const autoAccept = auto_accept ?? 0.8;
      const evidenceItems =
        typeof rawEvidence === "string"
          ? [{ id: "evidence", text: rawEvidence }]
          : Array.isArray(rawEvidence)
            ? rawEvidence
            : [rawEvidence];
      const { items: evidence } = ensureUniqueIds(evidenceItems, "evidence");
      const { items: claimItems } = ensureUniqueIds(
        claims.map((text) => ({ text })),
        "claim",
      );

      // Keep the internal no-source option distinct from caller-provided evidence
      // ids. A real evidence item named "none" must remain selectable and must be
      // returned as supporting_evidence rather than being mistaken for the sentinel.
      const evidenceIds = new Set(evidence.map((item) => item.id));
      let noEvidenceKey = "none";
      for (let suffix = 1; evidenceIds.has(noEvidenceKey); suffix++) {
        noEvidenceKey = `none_${suffix}`;
      }

      const questions: Record<string, unknown> = {};
      for (const claim of claimItems) {
        questions[`relation_${claim.id}`] = choiceQuestion(
          `How does the evidence relate to claim \`${claim.id}\` (${claim.text})?`,
          { ...RELATION_CRITERIA },
        );
        if (evidence.length > 1) {
          const criteria: Record<string, string | null> = Object.fromEntries(
            evidence.map((e): [string, null] => [e.id, null]),
          );
          criteria[noEvidenceKey] = "No single evidence item contains the content the claim depends on";
          questions[`source_${claim.id}`] = choiceQuestion(
            `Which evidence item does claim \`${claim.id}\` (${claim.text}) rest on?`,
            criteria,
          );
        }
      }

      const state = {
        purpose: "Verify each claim in claims against the evidence in evidence.",
        claims: claimItems,
        evidence,
      };

      const call = await callJev(config, state, questions);
      if (!call.ok) return call.result;
      const { answers, usage, provider, model } = call.reply;

      const results = claimItems.map((claim) => {
        const rawRelation = answers[`relation_${claim.id}`];
        const validated = validateChoiceAnswer(rawRelation, Object.keys(RELATION_CRITERIA));
        // source_* is optional auxiliary information, requested only for multiple
        // evidence items. Its absence does not invalidate the relation verdict,
        // but a present source must name a supplied evidence id or the internal
        // no-evidence option.
        const sourceKeys = [...evidence.map((e) => e.id), noEvidenceKey];
        const source = validateChoiceAnswer(answers[`source_${claim.id}`], sourceKeys);
        if (validated === null || !isRelation(validated.choice) || confidenceRejected(rawRelation)) {
          // A missing or malformed relation must not masquerade as an unsupported
          // claim: surface it as invalid so callers can tell protocol failure
          // apart from a real verdict.
          return {
            id: claim.id,
            claim: claim.text,
            verdict: "unknown",
            probabilities: null,
            confidence: null,
            status: "invalid_response" as const,
            action: "review" as const,
            supporting_evidence: null,
          };
        }
        const confidence = validated.confidence;
        return {
          id: claim.id,
          claim: claim.text,
          verdict: RELATION_TO_VERDICT[validated.choice],
          probabilities: validated.probabilities,
          confidence,
          // An endpoint that reported no confidence cannot clear a threshold.
          action: confidence === null ? ("review" as const) : verifyAction(confidence, autoAccept),
          supporting_evidence: source && source.choice !== noEvidenceKey ? source.choice : null,
        };
      });

      return toolResult({
        tool: "jev_verify",
        model,
        provider,
        auto_accept: autoAccept,
        summary: {
          verified: results.filter((r) => r.verdict === "verified").length,
          contradicted: results.filter((r) => r.verdict === "contradicted").length,
          unsupported: results.filter((r) => r.verdict === "unsupported").length,
          needs_review: results.filter((r) => r.action === "review").length,
        },
        results,
        usage,
      });
    },
  );
}
