// Ported from jkudish/jev-mcp src/index.ts (MIT).
// Question design adapted from burnigtm/jev-mcp (MIT) via PR #2 by rimusz.
// See THIRD-PARTY-NOTICES.md.

import type { Config } from "../config.ts";
import { validateNoulAnswer, validateScoreAnswer, type ScoreAnswer } from "../jev/answers.ts";
import { REVIEW_WEIGHTS } from "../jev/limits.ts";
import {
  requireCompleteContext,
  reviewAction,
  reviewComposite,
  worstAction,
  type PolicyAction,
} from "../jev/policy.ts";
import { ANTI_INJECTION, scoreQuestion, yesNoQuestion } from "../jev/questions.ts";

/** The four 0..2 rubric scores; the last two lower the weighted composite. */
export const RUBRICS = ["correctness", "spec_match", "test_gap", "blast_radius"] as const;

type Rubric = (typeof RUBRICS)[number];

export type ReviewThresholds = { auto_accept: number; review_at: number; composite_floor: number };

export type ScoredRubric = {
  score: number | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  status?: "invalid_response";
};

/** One rubric whose answer was missing or malformed. */
const INVALID_SCORE: ScoredRubric = { score: null, confidence: null, probabilities: null, status: "invalid_response" };

/** What one projection of the review half carries, before composition across files. */
export type ReviewHalf = {
  action: PolicyAction;
  composite: number | null;
  status?: "invalid_response";
  reason_codes: string[];
  limiting_rubrics: string[];
  safe_to_apply: number | null;
  scores: Record<string, ScoredRubric>;
  weights: Record<string, number>;
  thresholds: ReviewThresholds;
};

/** A per-file projection, the unit composePerFileReview combines. */
export type PerFileReview = ReviewHalf & { path: string };

export type ComposedReview = {
  action: PolicyAction;
  composite: number | null;
  safe_to_apply: number | null;
  reason_codes: string[];
  limiting: Array<{ file: string; rubrics: string[] }>;
  status?: "invalid_response";
  weights: Record<string, number>;
  thresholds: ReviewThresholds;
};

export function reviewQuestions(
  config: Config,
  extraFraming = "",
  scope = "",
  keyPrefix = "",
): Record<string, unknown> {
  const frame = (instructions: string) => instructions + extraFraming + scope + ANTI_INJECTION;
  return {
    [`${keyPrefix}correctness`]: scoreQuestion(
      frame("How likely is this change to be functionally correct for the stated request?"),
      [
        "Clearly wrong or breaks the stated behavior",
        "Uncertain; needs a closer look or tests",
        "Looks correct for the request",
      ],
    ),
    [`${keyPrefix}spec_match`]: scoreQuestion(
      frame("How well does the change match the user's request, not extra work?"),
      ["Misses the request or solves a different problem", "Partial match; important pieces missing", "Matches the request"],
    ),
    [`${keyPrefix}test_gap`]: scoreQuestion(frame("How large is the test gap for this change?"), [
      "Covered, or tests are not applicable to this change",
      "Some gaps remain on less critical paths",
      "Likely untested on the risky path",
    ]),
    [`${keyPrefix}blast_radius`]: scoreQuestion(frame("How wide is the blast radius if this lands?"), [
      "Tiny local change",
      "Moderate; a few modules",
      "Wide, shared, or production-facing",
    ]),
    [`${keyPrefix}safe_to_apply`]: yesNoQuestion(
      config,
      frame("Is it safe for the host coding agent to apply this change without a human first?"),
      { true: "Low-risk and ready", false: "Hold for review or more tests" },
    ),
  };
}

/**
 * Per-file review: the same rubric asked once per file, all in one request
 * (#42). The scope sentence binds every question to one files[i] and keeps
 * the tool — not the caller — in charge of the question design. Caller
 * paths are evidence, never instructions: questions scope by index only.
 */
export const fileScope = (index: number) => ` Judge only files[${index}], not the change as a whole.`;

/**
 * Slice a per-file answer set out of the flat answers record, restoring the
 * bare rubric keys projectReviewHalf reads.
 */
export const fileAnswers = (answers: Record<string, unknown>, index: number): Record<string, unknown> =>
  Object.fromEntries(
    [...RUBRICS, "safe_to_apply"].map((key): [string, unknown] => [key, answers[`file_${index}_${key}`]]),
  );

/**
 * Compose per-file projections into one whole-change result: auto only when
 * every file is auto (worstAction), composite is the file mean, safe_to_apply
 * the file minimum, reason codes merge in first-seen order, and limiting
 * names each file whose rubrics bound the decision. Nothing is re-judged or
 * averaged into invisibility: a weak file is visible as itself.
 */
export function composePerFileReview(
  files: PerFileReview[],
  weights: Record<string, number>,
  thresholds: ReviewThresholds,
): ComposedReview {
  const action = worstAction(files.map((file) => file.action));
  const composites = files.map((file) => file.composite).filter((value): value is number => value !== null);
  const composite =
    composites.length === files.length ? composites.reduce((sum, value) => sum + value, 0) / files.length : null;
  const safes = files.map((file) => file.safe_to_apply).filter((value): value is number => value !== null);
  const safeToApply = safes.length === files.length ? Math.min(...safes) : null;
  const reasonCodes: string[] = [];
  for (const file of files) {
    for (const code of file.reason_codes) if (!reasonCodes.includes(code) && code !== "accepted") reasonCodes.push(code);
  }
  if (action === "auto") reasonCodes.push("accepted");
  const limiting = files
    .filter((file) => file.limiting_rubrics.length > 0)
    .map((file) => ({ file: file.path, rubrics: file.limiting_rubrics }));
  return {
    action,
    composite,
    safe_to_apply: safeToApply,
    reason_codes: reasonCodes,
    limiting,
    ...(files.some((file) => file.status === "invalid_response") ? { status: "invalid_response" as const } : {}),
    weights,
    thresholds,
  };
}

/**
 * Shared projection of the patch-review half. Unknown confidence counts as
 * zero: a rubric the model was not confident about cannot support auto.
 */
export function projectReviewHalf(
  answers: Record<string, unknown>,
  thresholds: { autoAccept: number; reviewAt: number; compositeFloor: number },
  truncated: boolean,
): ReviewHalf {
  const parsed: Record<Rubric, ScoreAnswer | null> = {
    correctness: validateScoreAnswer(answers["correctness"]),
    spec_match: validateScoreAnswer(answers["spec_match"]),
    test_gap: validateScoreAnswer(answers["test_gap"]),
    blast_radius: validateScoreAnswer(answers["blast_radius"]),
  };
  const safeToApply = validateNoulAnswer(answers["safe_to_apply"]);
  const scores: Record<string, ScoredRubric> = {
    correctness: parsed.correctness ?? INVALID_SCORE,
    spec_match: parsed.spec_match ?? INVALID_SCORE,
    test_gap: parsed.test_gap ?? INVALID_SCORE,
    blast_radius: parsed.blast_radius ?? INVALID_SCORE,
  };

  const base = {
    safe_to_apply: safeToApply,
    scores,
    weights: { ...REVIEW_WEIGHTS },
    thresholds: {
      auto_accept: thresholds.autoAccept,
      review_at: thresholds.reviewAt,
      composite_floor: thresholds.compositeFloor,
    },
  };

  if (
    parsed.correctness === null ||
    parsed.spec_match === null ||
    parsed.test_gap === null ||
    parsed.blast_radius === null ||
    safeToApply === null
  ) {
    return {
      ...base,
      action: "escalate" as const,
      status: "invalid_response" as const,
      composite: null,
      reason_codes: ["invalid_response"],
      limiting_rubrics: [],
    };
  }
  const { correctness, spec_match: specMatch, test_gap: testGap, blast_radius: blastRadius } = parsed;

  // Per-rubric favorability: the normalized 0..1 contribution each rubric
  // makes to the composite (test gap and blast radius inverted), used to name
  // the limiting rubric(s) when the composite is what blocks auto.
  const favorability: Record<Rubric, number> = {
    correctness: correctness.score / 2,
    spec_match: specMatch.score / 2,
    test_gap: 1 - testGap.score / 2,
    blast_radius: 1 - blastRadius.score / 2,
  };
  const favorabilities = RUBRICS.map((rubric) => favorability[rubric]);
  const minFavorability = Math.min(...favorabilities);

  const composite = reviewComposite({
    correctness: correctness.score,
    specMatch: specMatch.score,
    testGap: testGap.score,
    blastRadius: blastRadius.score,
  });
  // Unknown confidence on any rubric is unknown overall: it must not become a
  // number that can satisfy a threshold (a bare zero would, at auto_accept 0).
  const rubricConfidence: Record<Rubric, number | null> = {
    correctness: correctness.confidence,
    spec_match: specMatch.confidence,
    test_gap: testGap.confidence,
    blast_radius: blastRadius.confidence,
  };
  const knownConfidences = RUBRICS.map((rubric) => rubricConfidence[rubric]).filter(
    (value): value is number => value !== null,
  );
  const minConfidence = knownConfidences.length === RUBRICS.length ? Math.min(...knownConfidences) : null;
  const rawAction = reviewAction({ composite, safeToApply, minConfidence, ...thresholds });
  const action = requireCompleteContext(rawAction, truncated);

  // Reason codes cover every action path; limiting_rubrics names the rubric(s)
  // that bound the decision: the null-confidence ones when confidence is
  // unknown, every rubric tied at the minimum confidence when confidence is
  // what blocks, and every rubric tied at the minimum favorability when the
  // composite floor is what blocks (ties always included, never a lone winner).
  const reasonCodes: string[] = [];
  let limitingRubrics: Rubric[] = [];
  if (minConfidence === null) {
    reasonCodes.push("unknown_confidence");
    limitingRubrics = RUBRICS.filter((rubric) => rubricConfidence[rubric] === null);
  } else if (minConfidence < thresholds.reviewAt) {
    reasonCodes.push("confidence_below_review");
    limitingRubrics = RUBRICS.filter((rubric) => rubricConfidence[rubric] === minConfidence);
  }
  if (safeToApply < thresholds.reviewAt) reasonCodes.push("safe_to_apply_below_review");
  if (rawAction !== "escalate") {
    if (safeToApply < thresholds.autoAccept) reasonCodes.push("safe_to_apply_below_auto_accept");
    if (minConfidence !== null && minConfidence < thresholds.autoAccept) {
      reasonCodes.push("confidence_below_auto_accept");
      if (limitingRubrics.length === 0) {
        limitingRubrics = RUBRICS.filter((rubric) => rubricConfidence[rubric] === minConfidence);
      }
    }
    if (composite < thresholds.compositeFloor) {
      reasonCodes.push("composite_below_floor");
      // Tolerant equality: complementary scores (0.6 vs 1.4) are
      // mathematically tied but differ by a float ulp after inversion.
      if (limitingRubrics.length === 0) {
        limitingRubrics = RUBRICS.filter((rubric) => Math.abs(favorability[rubric] - minFavorability) <= 1e-12);
      }
    }
  }
  if (truncated) reasonCodes.push("incomplete_context");
  if (action === "auto") reasonCodes.push("accepted");
  return { ...base, action, composite, reason_codes: reasonCodes, limiting_rubrics: [...limitingRubrics] };
}
