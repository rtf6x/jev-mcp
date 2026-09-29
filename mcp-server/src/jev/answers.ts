// Ported from jkudish/jev-mcp src/index.ts (MIT). See THIRD-PARTY-NOTICES.md.

import { isRecord } from "../guards.ts";
import { PROBABILITY_SUM_TOLERANCE, SCORE_MEAN_TOLERANCE } from "./limits.ts";

/** A confidence, or `null` when the endpoint did not report a usable one. */
function readConfidence(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : null;
}

/**
 * Whether the raw answer carries a confidence the validators reject. A missing confidence is
 * fine; a present but malformed one invalidates the answer rather than being dropped.
 */
export function confidenceRejected(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const value = raw["confidence"];
  return value !== undefined && value !== null && readConfidence(value) === null;
}

export type ChoiceAnswer = {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number | null;
};

export type ScoreAnswer = {
  score: number;
  confidence: number | null;
  probabilities: Record<string, number> | null;
};

/**
 * Noul contract: a finite probability in [0,1]. Endpoints name the yes/no answer after their own
 * spelling of the question, so every documented spelling is read here.
 */
export function validateNoulAnswer(answer: unknown): number | null {
  if (!isRecord(answer)) return null;
  const value = answer["noul"] ?? answer["probability"] ?? answer["bool"];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

// Choice contract: exact candidate keys, finite [0,1] probabilities summing
// to one within PROBABILITY_SUM_TOLERANCE, and a choice tied for the maximum
// probability.
export function validateChoiceAnswer(answer: unknown, expectedKeys: Iterable<string>): ChoiceAnswer | null {
  if (!isRecord(answer) || typeof answer["choice"] !== "string" || !isRecord(answer["probabilities"])) return null;
  const expected = new Set(expectedKeys);
  // Shape is enforced by the isRecord guards above and the finite [0,1] check below.
  const probabilities = answer["probabilities"] as Record<string, number>;
  const keys = Object.keys(probabilities);
  const values = Object.values(probabilities);
  const choice = answer["choice"];
  if (
    !expected.has(choice) ||
    keys.length !== expected.size ||
    !keys.every((key) => expected.has(key)) ||
    !values.every((p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1) ||
    Math.abs(values.reduce((a, b) => a + b, 0) - 1) > PROBABILITY_SUM_TOLERANCE ||
    (probabilities[choice] ?? Number.NaN) < Math.max(...values) - 1e-9
  )
    return null;
  return { choice, probabilities, confidence: readConfidence(answer["confidence"]) };
}

/** Score questions always offer exactly three options (0, 1, 2). */
export const SCORE_OPTION_KEYS = ["0", "1", "2"] as const;

// Score contract: a finite 0..2 score, plus, when a distribution is present
// at all, an exact three-key distribution over the option scores summing to
// one whose expected value matches the reported score. A distribution the
// provider did not report stays null (still valid); a malformed or
// contradictory one invalidates the answer.
export function validateScoreAnswer(answer: unknown): ScoreAnswer | null {
  if (!isRecord(answer)) return null;
  const score = answer["score"];
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 2) return null;
  const confidence = readConfidence(answer["confidence"]);
  if (answer["probabilities"] == null) return { score, confidence, probabilities: null };
  if (!isRecord(answer["probabilities"])) return null;
  const probabilities = answer["probabilities"] as Record<string, number>;
  const keys = Object.keys(probabilities);
  const values = Object.values(probabilities);
  const expected = new Set<string>(SCORE_OPTION_KEYS);
  if (
    keys.length !== expected.size ||
    !keys.every((key) => expected.has(key)) ||
    !values.every((p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1) ||
    Math.abs(values.reduce((x, y) => x + y, 0) - 1) > PROBABILITY_SUM_TOLERANCE
  ) {
    return null;
  }
  const mean = SCORE_OPTION_KEYS.reduce((sum, key) => sum + Number(key) * (probabilities[key] ?? 0), 0);
  if (Math.abs(mean - score) > SCORE_MEAN_TOLERANCE) return null;
  return { score, confidence, probabilities };
}
