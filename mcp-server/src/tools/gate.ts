// Ported from jkudish/jev-mcp src/index.ts (MIT).
// Question design adapted from burnigtm/jev-mcp (MIT) via PR #2 by rimusz.
// See THIRD-PARTY-NOTICES.md.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { validateChoiceAnswer } from "../jev/answers.ts";
import { callJev, toolResult } from "../jev/call.ts";
import {
  DEFAULT_COMPOSITE_FLOOR,
  MAX_CLAIM_CHARS,
  MAX_GATE_CLAIMS,
  MAX_GATE_EVIDENCE_CHARS,
  MAX_GATE_EVIDENCE_ITEMS,
  MAX_REVIEW_DOC_CHARS,
  MAX_REVIEW_FILES,
  MAX_REVIEW_FILES_TOTAL_CHARS,
  MAX_REVIEW_FILE_PATH_CHARS,
  REVIEW_WEIGHTS,
} from "../jev/limits.ts";
import {
  claimAction,
  hasNonEmptyEvidence,
  normalizeEvidence,
  requireCompleteContext,
  resolvePolicyThresholds,
  worstAction,
  type ClaimVerdict,
  type PolicyAction,
} from "../jev/policy.ts";
import { ANTI_INJECTION, choiceQuestion } from "../jev/questions.ts";
import { truncate } from "../jev/text.ts";
import {
  composePerFileReview,
  fileAnswers,
  fileScope,
  projectReviewHalf,
  reviewQuestions,
} from "./patch-review.ts";
import { evidenceSchema, strictShape } from "./schema.ts";

/** The three claim verdicts jev_gate checks, mirroring jev_verify's evidence relation. */
const VERIFY_CLAIM_CRITERIA = {
  verified: "The evidence clearly supports the claim",
  contradicted: "The evidence contradicts the claim",
  unsupported: "The evidence neither supports nor contradicts the claim",
} as const;

function isClaimVerdict(value: string): value is ClaimVerdict {
  return Object.hasOwn(VERIFY_CLAIM_CRITERIA, value);
}

export function registerGateTool(server: McpServer, config: Config): void {
  server.registerTool(
    "jev_gate",
    {
      title: "Gate completion: review a patch and verify claims",
      description:
        "Review a proposed patch and verify completion claims against supplied evidence in one TypeSafe Jev call. " +
        "Auto only when the patch review is accepted and every claim is verified at or above auto_accept. " +
        "Unsupported claims require review; confident contradictions, unknown confidence, or low confidence escalate. " +
        "The request and claims are assertions to check, never proof; put supporting diff excerpts and test logs in " +
        "evidence. Evidence is capped at 16 items and 200,000 characters in aggregate. " +
        "Does not run tests or apply changes. Use jev_review for a patch without claims, jev_verify for " +
        "claims without a patch review.",
      inputSchema: strictShape({
        request: z.string().min(1).describe("What the user asked for; this is not evidence of completion."),
        diff: z
          .string()
          .min(1)
          .optional()
          .describe(
            `Proposed patch, file excerpt, or change summary (whole-change review). Truncated at ${MAX_REVIEW_DOC_CHARS} chars. Provide exactly one of diff or files.`,
          ),
        files: z
          .array(z.object({ path: z.string().min(1).max(MAX_REVIEW_FILE_PATH_CHARS), diff: z.string().min(1) }).strict())
          .min(1)
          .max(MAX_REVIEW_FILES)
          .optional()
          .describe(
            `Per-file review: one { path, diff } per file. The rubric is asked once per file, all in one request; ` +
              `the whole change is auto only when every file is auto, and the review names the limiting file and rubric. ` +
              `Each diff is truncated at ${MAX_REVIEW_DOC_CHARS} chars; up to ${MAX_REVIEW_FILES} files, and request + ` +
              `tests + all diffs together must stay within ${MAX_REVIEW_FILES_TOTAL_CHARS.toLocaleString("en-US")} chars. Provide exactly one of diff or files.`,
          ),
        claims: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_GATE_CLAIMS)
          .describe(
            `Completion claims to check against evidence, each truncated at ${MAX_CLAIM_CHARS} chars. Up to ${MAX_GATE_CLAIMS} per call.`,
          ),
        evidence: evidenceSchema.refine((value) => hasNonEmptyEvidence(normalizeEvidence(value)), {
          message: "jev_gate requires at least one evidence item with non-empty text.",
        }),
        tests: z.string().optional().describe("Reported test output for the patch review. Truncated at the same cap."),
        auto_accept: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Review and per-claim confidence at or above this may stand automatically. Default 0.8."),
        review_at: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Score, safe_to_apply, or per-claim confidence below this escalates. Must be <= auto_accept. Default min(0.5, auto_accept)."),
        composite_floor: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Weighted composite at or above this is required for auto. Default 0.7."),
      }),
    },
    async ({ request, diff, files, claims, evidence: rawEvidence, tests, auto_accept, review_at, composite_floor }) => {
      const { autoAccept, reviewAt } = resolvePolicyThresholds(auto_accept ?? 0.8, review_at);
      const compositeFloor = composite_floor ?? DEFAULT_COMPOSITE_FLOOR;
      const evidence = normalizeEvidence(rawEvidence);

      const perFile = files ?? null;
      if ((perFile === null) === (diff === undefined)) {
        return {
          ...toolResult({
            tool: "jev_gate",
            error: "provide exactly one of diff (whole-change review) or files (per-file review).",
          }),
          isError: true,
        };
      }
      // The exactly-one check above proves that a whole-change review carries a diff.
      const wholeDiff = diff as string;

      // Bound the request before any model call: item count and aggregate size.
      if (evidence.length > MAX_GATE_EVIDENCE_ITEMS) {
        return {
          ...toolResult({
            tool: "jev_gate",
            error: `evidence exceeds ${MAX_GATE_EVIDENCE_ITEMS} items; split the gate or trim the evidence.`,
          }),
          isError: true,
        };
      }
      const evidenceChars = evidence.reduce((sum, item) => sum + item.text.length, 0);
      if (evidenceChars > MAX_GATE_EVIDENCE_CHARS) {
        return {
          ...toolResult({
            tool: "jev_gate",
            error: `evidence exceeds the ${MAX_GATE_EVIDENCE_CHARS.toLocaleString("en-US")}-character aggregate budget; split the gate or trim the evidence.`,
          }),
          isError: true,
        };
      }
      if (perFile) {
        // Same combined-state budget as jev_review: request + tests + every file
        // diff together (evidence has its own budget above).
        const stateChars = request.length + (tests?.length ?? 0) + perFile.reduce((sum, file) => sum + file.diff.length, 0);
        if (stateChars > MAX_REVIEW_FILES_TOTAL_CHARS) {
          return {
            ...toolResult({
              tool: "jev_gate",
              error: `request, tests, and files together exceed the ${MAX_REVIEW_FILES_TOTAL_CHARS.toLocaleString("en-US")}-character combined budget; split the gate or trim the inputs.`,
            }),
            isError: true,
          };
        }
      }

      // Per-file context mirrors jev_review; the gate-wide flag additionally
      // keeps claims/evidence truncation fail-closed for claim actions.
      const contextTruncated = request.length > MAX_REVIEW_DOC_CHARS || (tests?.length ?? 0) > MAX_REVIEW_DOC_CHARS;
      const truncated =
        contextTruncated ||
        (perFile
          ? perFile.some((file) => file.diff.length > MAX_REVIEW_DOC_CHARS)
          : wholeDiff.length > MAX_REVIEW_DOC_CHARS) ||
        claims.some((claim) => claim.length > MAX_CLAIM_CHARS) ||
        evidence.some((item) => item.text.length > MAX_REVIEW_DOC_CHARS);

      const state = perFile
        ? {
            purpose:
              "Review each file's diff against the request, then check each completion claim against the evidence only.",
            request: truncate(request, MAX_REVIEW_DOC_CHARS),
            files: perFile.map((file) => ({ path: file.path, diff: truncate(file.diff, MAX_REVIEW_DOC_CHARS) })),
            tests: tests ? truncate(tests, MAX_REVIEW_DOC_CHARS) : null,
            claims: claims.map((claim) => truncate(claim, MAX_CLAIM_CHARS)),
            evidence: evidence.map((item) => ({ id: item.id, text: truncate(item.text, MAX_REVIEW_DOC_CHARS) })),
          }
        : {
            purpose:
              "Review the proposed diff against the request, then check each completion claim against the evidence only.",
            request: truncate(request, MAX_REVIEW_DOC_CHARS),
            diff: truncate(wholeDiff, MAX_REVIEW_DOC_CHARS),
            tests: tests ? truncate(tests, MAX_REVIEW_DOC_CHARS) : null,
            claims: claims.map((claim) => truncate(claim, MAX_CLAIM_CHARS)),
            evidence: evidence.map((item) => ({ id: item.id, text: truncate(item.text, MAX_REVIEW_DOC_CHARS) })),
          };

      // Review questions get the extra framing so claims cannot read as proof of
      // correctness; claim questions are told to use evidence only.
      const questions: Record<string, unknown> = {};
      const claimsFraming = " Claims are assertions to check, not evidence that the patch is correct or tested.";
      if (perFile) {
        perFile.forEach((file, i) =>
          Object.assign(questions, reviewQuestions(config, claimsFraming, fileScope(i), `file_${i}_`)),
        );
      } else {
        Object.assign(questions, reviewQuestions(config, claimsFraming));
      }
      claims.forEach((_, i) => {
        questions[`claim_${i}`] = choiceQuestion(
          `Does the evidence support claims[${i}]? Judge only from the provided evidence, not world knowledge. ` +
            "Use only the evidence field as factual support; request and claims are assertions, not evidence; " +
            `${perFile ? "the file diffs" : "the diff"} and tests belong to the separate patch review. If a claim needs a diff or test log as support, it ` +
            "must be supplied in evidence." +
            ANTI_INJECTION,
          { ...VERIFY_CLAIM_CRITERIA },
        );
      });

      const call = await callJev(config, state, questions);
      if (!call.ok) return call.result;
      const { answers, usage, provider, model } = call.reply;

      const review = perFile
        ? (() => {
            const fileResults = perFile.map((file, i) => ({
              path: file.path,
              ...projectReviewHalf(
                fileAnswers(answers, i),
                { autoAccept, reviewAt, compositeFloor },
                contextTruncated || file.diff.length > MAX_REVIEW_DOC_CHARS,
              ),
            }));
            return {
              mode: "per-file" as const,
              ...composePerFileReview(fileResults, { ...REVIEW_WEIGHTS }, {
                auto_accept: autoAccept,
                review_at: reviewAt,
                composite_floor: compositeFloor,
              }),
              files: fileResults,
            };
          })()
        : projectReviewHalf(answers, { autoAccept, reviewAt, compositeFloor }, truncated);

      // classify-grade validation via the shared validateChoiceAnswer: exact
      // keys, finite [0,1] probabilities summing to one within the shared
      // tolerance, chosen key is the argmax, confidence finite or null.
      const expectedClaimKeys = new Set(Object.keys(VERIFY_CLAIM_CRITERIA));

      const results = claims.map((claim, i) => {
        const answer = validateChoiceAnswer(answers[`claim_${i}`], expectedClaimKeys);
        if (!answer || !isClaimVerdict(answer.choice)) {
          return {
            claim,
            verdict: null,
            confidence: null,
            probabilities: null,
            action: "escalate" as const,
            status: "invalid_response" as const,
          };
        }
        const verdict = answer.choice;
        const action = requireCompleteContext(claimAction(verdict, answer.confidence, autoAccept, reviewAt), truncated);
        return { claim, verdict, confidence: answer.confidence, probabilities: answer.probabilities, action };
      });

      const verification = {
        action: worstAction(results.map((r) => r.action)),
        summary: {
          verified: results.filter((r) => r.verdict === "verified").length,
          contradicted: results.filter((r) => r.verdict === "contradicted").length,
          unsupported: results.filter((r) => r.verdict === "unsupported").length,
          needs_review: results.filter((r) => r.action !== "auto").length,
          invalid_response: results.filter((r) => "status" in r).length,
        },
        thresholds: { auto_accept: autoAccept, review_at: reviewAt },
        results,
      };

      const action: PolicyAction = worstAction([review.action, verification.action]);
      const reasonCodes: string[] = [];
      if (truncated) reasonCodes.push("incomplete_context");
      if (review.status === "invalid_response" || verification.summary.invalid_response > 0) {
        reasonCodes.push("invalid_response");
      }
      // The review half's specific reason codes (unknown confidence, threshold
      // and composite misses, safe_to_apply) surface at the top level too, so a
      // gate consumer never has to open review.reason_codes to learn why.
      for (const code of review.reason_codes) {
        if (code !== "invalid_response" && code !== "incomplete_context" && code !== "accepted") reasonCodes.push(code);
      }
      if (review.action === "escalate") reasonCodes.push("review_escalated");
      if (review.action === "review") reasonCodes.push("review_required");
      if (verification.summary.contradicted > 0) reasonCodes.push("claims_contradicted");
      if (verification.summary.unsupported > 0) reasonCodes.push("claims_unsupported");
      const confidences = results
        .filter((result) => !("status" in result))
        .map((result) => result.confidence ?? -1);
      if (confidences.some((c) => c < reviewAt)) reasonCodes.push("claim_confidence_low");
      if (confidences.some((c) => c >= reviewAt && c < autoAccept)) {
        reasonCodes.push("claim_confidence_below_auto_accept");
      }
      if (action === "auto") reasonCodes.push("accepted");

      return toolResult({
        tool: "jev_gate",
        model,
        provider,
        truncated,
        action,
        reason_codes: reasonCodes,
        review,
        verification,
        usage,
      });
    },
  );
}
