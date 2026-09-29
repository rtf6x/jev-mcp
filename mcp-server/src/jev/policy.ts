// Ported from jkudish/jev-mcp src/lib.ts (MIT). See THIRD-PARTY-NOTICES.md.

import { REVIEW_WEIGHTS } from "./limits.ts";
import { ensureUniqueIds } from "./text.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Verify, screen, find, classify, rerank
// ─────────────────────────────────────────────────────────────────────────────

/** Does this verdict stand on its own, or should a human confirm it? */
export function verifyAction(confidence: number, autoAccept: number): "auto" | "review" {
  return confidence >= autoAccept ? "auto" : "review";
}

/**
 * Screen recommendation from probabilities.
 * injection: probability the text contains instructions aimed at an AI agent.
 * relevance: probability the text is useful for the stated purpose (optional).
 * substance: probability the text has substantive readable content (optional).
 */
export function screenRecommendation(input: {
  injection: number;
  relevance?: number;
  substance?: number;
  blockAt: number;
  reviewAt: number;
}): { action: "pass" | "review" | "block" | "skip"; reason: string } {
  const { injection, relevance, substance, blockAt, reviewAt } = input;
  if (injection >= blockAt)
    return { action: "block", reason: `injection probability ${injection.toFixed(2)} >= block threshold ${blockAt}` };
  if (injection >= reviewAt)
    return { action: "review", reason: `injection probability ${injection.toFixed(2)} >= review threshold ${reviewAt}` };
  if (substance !== undefined && substance < 0.3)
    return { action: "skip", reason: `little substantive content (substance ${substance.toFixed(2)})` };
  if (relevance !== undefined && relevance < 0.3)
    return { action: "skip", reason: `not relevant to the stated purpose (relevance ${relevance.toFixed(2)})` };
  return { action: "pass", reason: "no signals above thresholds" };
}

/** Turn the exists Noul into a document-level verdict (semantic-find cookbook thresholds). */
export function existsVerdict(exists: number, found = 0.7, absent = 0.35): string {
  if (exists >= found) return "answered";
  return exists < absent ? "absent" : "partial";
}

/** Rank candidate ids by Choice probability, descending. Ties keep caller order. */
export function rankCandidates<T extends { id: string }>(
  candidates: T[],
  probabilities: Record<string, number>,
): Array<T & { probability: number }> {
  return candidates
    .map((candidate, index) => ({
      candidate: { ...candidate, probability: probabilities[candidate.id] ?? 0 },
      index,
    }))
    .sort((a, b) => b.candidate.probability - a.candidate.probability || a.index - b.index)
    .map(({ candidate }) => candidate);
}

/** Winner-to-runner-up gap; a lone probability has no runner-up, so its margin is 0. */
export function marginOf(probabilities: Record<string, number> | undefined | null): number {
  const ranked = Object.values(probabilities ?? {}).sort((a, b) => b - a);
  if (ranked.length < 2) return 0;
  return (ranked[0] ?? 0) - (ranked[1] ?? 0);
}

/**
 * Auto-accept requires BOTH a high top probability and a clear margin, per the
 * conservative thresholds recommended after classification spike testing.
 */
export function classificationDecision(
  topProbability: number,
  margin: number,
  autoAccept: number,
  minimumMargin: number,
): "auto" | "review" {
  return topProbability >= autoAccept && margin >= minimumMargin ? "auto" : "review";
}

/**
 * A requirement check contradicts the recommended candidate when it returns
 * "contradicted" for that candidate. Independent questions may disagree with
 * the recommendation; surface the disagreement, do not average it away.
 */
export function contradictsRecommendation(
  checks: Array<{ candidate: string; requirement: number; answer: string }>,
  recommended: string,
): number[] {
  return checks
    .filter((c) => c.candidate === recommended && c.answer === "contradicted")
    .map((c) => c.requirement);
}

/**
 * Rerank candidates by per-candidate relevance scores aligned by index,
 * descending. Scores are validated by the caller before this runs; the 0
 * fallback only guards an internal wiring mistake, never a model answer.
 */
export function rerankByScore<T extends object>(candidates: T[], scores: number[]): Array<T & { relevance: number }> {
  return candidates
    .map((c, i) => ({ ...c, relevance: scores[i] ?? 0 }))
    .sort((a, b) => b.relevance - a.relevance);
}

// ─────────────────────────────────────────────────────────────────────────────
// Patch review and completion gate (jev_review / jev_gate)
// Question design adapted from burnigtm/jev-mcp (MIT) via PR #2 by rimusz;
// thresholds are parameters and arithmetic stays here.
// ─────────────────────────────────────────────────────────────────────────────

export type PolicyAction = "auto" | "review" | "escalate";
export type ClaimVerdict = "verified" | "contradicted" | "unsupported";

/** Policy thresholds must satisfy 0 <= review_at <= auto_accept <= 1. */
export function validatePolicyThresholds(autoAccept: number, reviewAt: number): void {
  if (
    !Number.isFinite(autoAccept) ||
    !Number.isFinite(reviewAt) ||
    autoAccept < 0 ||
    autoAccept > 1 ||
    reviewAt < 0 ||
    reviewAt > 1 ||
    reviewAt > autoAccept
  ) {
    throw new Error("Thresholds must satisfy 0 <= review_at <= auto_accept <= 1.");
  }
}

/** Fill an omitted review_at so a lone low auto_accept cannot invert the pair. */
export function resolvePolicyThresholds(
  autoAccept = 0.8,
  reviewAt?: number,
): { autoAccept: number; reviewAt: number } {
  const resolved = reviewAt ?? Math.min(0.5, autoAccept);
  validatePolicyThresholds(autoAccept, resolved);
  return { autoAccept, reviewAt: resolved };
}

/** Truncated input is incomplete context; it never permits auto, only stronger actions. */
export function requireCompleteContext(action: PolicyAction, truncated: boolean): PolicyAction {
  return truncated && action === "auto" ? "review" : action;
}

/** Weighted 0..1 composite from 0..2 rubric scores, inverting test gap and blast radius. */
export function reviewComposite(scores: {
  correctness: number;
  specMatch: number;
  testGap: number;
  blastRadius: number;
}): number {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const clamp02 = (v: number) => Math.min(2, Math.max(0, v));
  const correctness = clamp01(clamp02(scores.correctness) / 2);
  const specMatch = clamp01(clamp02(scores.specMatch) / 2);
  const tests = clamp01(1 - clamp02(scores.testGap) / 2);
  const blast = clamp01(1 - clamp02(scores.blastRadius) / 2);
  return (
    REVIEW_WEIGHTS.correctness * correctness +
    REVIEW_WEIGHTS.spec_match * specMatch +
    REVIEW_WEIGHTS.test_gap * tests +
    REVIEW_WEIGHTS.blast_radius * blast
  );
}

/**
 * Patch-review action. Escalates when score confidence or safe_to_apply is
 * unknown or below review_at; auto only when safe_to_apply and min confidence
 * reach auto_accept and the composite clears composite_floor; otherwise review.
 * Unknown confidence is escalate, never a value that can satisfy a threshold.
 */
export function reviewAction(input: {
  composite: number;
  safeToApply: number;
  minConfidence: number | null;
  autoAccept: number;
  reviewAt: number;
  compositeFloor: number;
}): PolicyAction {
  if (input.minConfidence === null || input.minConfidence < input.reviewAt || input.safeToApply < input.reviewAt)
    return "escalate";
  if (
    input.safeToApply >= input.autoAccept &&
    input.composite >= input.compositeFloor &&
    input.minConfidence >= input.autoAccept
  ) {
    return "auto";
  }
  return "review";
}

/**
 * Per-claim action: unknown or low confidence and confident contradictions
 * escalate; only confident verification is auto. Unknown confidence can never
 * satisfy a threshold, even a zero one.
 */
export function claimAction(
  verdict: ClaimVerdict,
  confidence: number | null,
  autoAccept: number,
  reviewAt: number,
): PolicyAction {
  if (confidence === null || confidence < reviewAt) return "escalate";
  if (verdict === "contradicted" && confidence >= autoAccept) return "escalate";
  return verdict === "verified" && confidence >= autoAccept ? "auto" : "review";
}

/** The most severe action wins; a gate is only as strong as its weakest judgment. */
export function worstAction(actions: PolicyAction[]): PolicyAction {
  if (actions.includes("escalate")) return "escalate";
  if (actions.includes("review")) return "review";
  return "auto";
}

export type ReviewEvidenceInput = string | { id?: string; text: string } | Array<{ id?: string; text: string }>;

/** Normalize evidence to {id,text} items with unique ids, same shape as jev_verify. */
export function normalizeEvidence(raw: ReviewEvidenceInput): Array<{ id: string; text: string }> {
  const items = typeof raw === "string" ? [{ id: "evidence", text: raw }] : Array.isArray(raw) ? raw : [raw];
  return ensureUniqueIds(items, "evidence").items;
}

/** True when at least one evidence item carries non-whitespace text. */
export function hasNonEmptyEvidence(items: Array<{ id: string; text: string }>): boolean {
  return items.some((item) => item.text.trim().length > 0);
}

