import type { Config } from "./config.ts";
import type { EndpointResponse } from "./forward.ts";
import { isRecord } from "./guards.ts";

export const DEFAULT_ACCEPT_AT = 0.85;
export const DEFAULT_MARGIN_AT = 0.5;

/** A question as the caller wrote it; every field is forwarded verbatim. */
export type Question = {
  type: string;
  instructions?: unknown;
  criteria?: unknown;
  [key: string]: unknown;
};

export type JudgeOptions = {
  acceptAt?: number | undefined;
  marginAt?: number | undefined;
};

export type Verdict = {
  type: "choice" | "score" | "noul";
  status: "ok" | "invalid_response";
  reason: string | null;
  /** Chosen option, level index (score) or yes-probability. */
  value: string | number | null;
  /** Option or level description, or `yes` / `no` / `uncertain` for a yes-no answer. */
  label: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  /** Winner minus runner-up, choice answers only. */
  margin: number | null;
  action: "auto" | "review";
};

export type JudgeResult = {
  endpoint: { url: string; status: number };
  model: string | null;
  results: Record<string, Verdict>;
  summary: { questions: number; auto: number; review: number; invalid: number };
  usage: { input_tokens: number | null; output_tokens: number | null; cost: number | null };
  raw: unknown;
};

/**
 * Map a caller-supplied question type onto the primitive it asks for.
 * `bool` and `boolean` are accepted spellings of a yes/no question.
 */
export function canonicalQuestionType(type: string): "choice" | "score" | "noul" | null {
  const normalized = type.trim().toLowerCase();
  if (normalized === "choice") return "choice";
  if (normalized === "score") return "score";
  if (normalized === "noul" || normalized === "bool" || normalized === "boolean") return "noul";
  return null;
}

/**
 * Build the request body: `{ model, state, questions }` — the shape every Jev endpoint takes.
 * Questions are forwarded as written, except that a yes/no question is spelled the way the
 * configured endpoint expects.
 */
export function buildRequestBody(
  config: Config,
  input: { state: unknown; questions: Record<string, Question>; model?: string | undefined },
): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(input.questions)) {
    const type = canonicalQuestionType(question.type) === "noul" ? config.questionType : question.type;
    questions[id] = { ...question, type };
  }
  const model = input.model !== undefined && input.model !== "" ? input.model : config.model;
  return { model, state: input.state, questions };
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Exactly `keys`, each a probability, summing to one. */
function readProbabilities(raw: unknown, keys: string[]): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const present = Object.keys(raw);
  if (present.length !== keys.length || keys.some((key) => !present.includes(key))) return null;
  const probabilities: Record<string, number> = {};
  let sum = 0;
  for (const key of keys) {
    const value = readNumber(raw[key]);
    if (value === null || value < 0 || value > 1) return null;
    probabilities[key] = value;
    sum += value;
  }
  return Math.abs(sum - 1) > 0.01 ? null : probabilities;
}

function topTwo(probabilities: Record<string, number>): { key: string; value: number; margin: number } | null {
  let best: [string, number] | null = null;
  let runnerUp = 0;
  for (const [key, value] of Object.entries(probabilities)) {
    if (best === null || value > best[1]) {
      if (best !== null) runnerUp = best[1];
      best = [key, value];
    } else if (value > runnerUp) {
      runnerUp = value;
    }
  }
  if (best === null) return null;
  return { key: best[0], value: best[1], margin: best[1] - runnerUp };
}

function invalid(reason: string, type: Verdict["type"]): Verdict {
  return {
    type,
    status: "invalid_response",
    reason,
    value: null,
    label: null,
    probabilities: null,
    confidence: null,
    margin: null,
    action: "review",
  };
}

/** Confidence is optional; a present but malformed one invalidates the answer. */
function readConfidence(answer: Record<string, unknown>): { ok: boolean; value: number | null } {
  const raw = answer["confidence"];
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const value = readNumber(raw);
  if (value === null || value < 0 || value > 1) return { ok: false, value: null };
  return { ok: true, value };
}

function judgeAnswer(question: Question, raw: unknown, acceptAt: number, marginAt: number): Verdict {
  const type = canonicalQuestionType(question.type);
  if (type === null) return invalid(`unsupported question type "${question.type}"`, "choice");
  const answer = isRecord(raw) ? raw : null;
  if (answer === null) return invalid("no answer object for this question", type);

  if (type === "noul") {
    const rawProbability = answer["noul"] ?? answer["probability"] ?? answer["bool"];
    const probability = readNumber(rawProbability);
    if (probability === null || probability < 0 || probability > 1) {
      return invalid("yes/no answer must be a probability between 0 and 1", "noul");
    }
    const label = probability >= acceptAt ? "yes" : probability <= 1 - acceptAt ? "no" : "uncertain";
    return {
      type: "noul",
      status: "ok",
      reason: null,
      value: probability,
      label,
      probabilities: null,
      confidence: null,
      margin: null,
      action: label === "uncertain" ? "review" : "auto",
    };
  }

  if (type === "choice") {
    const criteria = isRecord(question.criteria) ? question.criteria : null;
    const probabilityKeys = isRecord(answer["probabilities"]) ? Object.keys(answer["probabilities"]) : null;
    const keys = criteria !== null ? Object.keys(criteria) : probabilityKeys;
    if (keys === null || keys.length < 2) {
      return invalid("a choice question needs at least two options (criteria, or a probabilities map)", "choice");
    }
    const probabilities = readProbabilities(answer["probabilities"], keys);
    if (probabilities === null) {
      return invalid("probabilities must cover exactly the options and sum to one", "choice");
    }
    const winner = topTwo(probabilities);
    const choice = answer["choice"];
    if (winner === null || typeof choice !== "string" || !(choice in probabilities)) {
      return invalid("choice is not one of the options", "choice");
    }
    if (choice !== winner.key) {
      return invalid(`choice "${choice}" is not the highest-probability option ("${winner.key}")`, "choice");
    }
    const confidence = readConfidence(answer);
    if (!confidence.ok) return invalid("confidence must be between 0 and 1", "choice");
    const description = criteria?.[choice];
    return {
      type: "choice",
      status: "ok",
      reason: null,
      value: choice,
      label: typeof description === "string" ? description : null,
      probabilities,
      confidence: confidence.value,
      margin: winner.margin,
      action: winner.value >= acceptAt && winner.margin >= marginAt ? "auto" : "review",
    };
  }

  const probabilitiesRaw = answer["probabilities"];
  const levels = Array.isArray(question.criteria) ? question.criteria.length : null;
  const keys =
    levels !== null && levels >= 2
      ? Array.from({ length: levels }, (_, index) => String(index))
      : isRecord(probabilitiesRaw)
        ? Object.keys(probabilitiesRaw)
        : null;
  if (keys === null || keys.length < 2) {
    return invalid("a score question needs at least two levels (criteria, or a probabilities map)", "score");
  }
  const probabilities = readProbabilities(probabilitiesRaw, keys);
  if (probabilities === null) {
    return invalid("probabilities must cover exactly the levels and sum to one", "score");
  }
  const score = readNumber(answer["score"]);
  if (score === null || score < -0.001 || score > keys.length - 1 + 0.001) {
    return invalid(`score must be a position between 0 and ${keys.length - 1}`, "score");
  }
  const confidence = readConfidence(answer);
  if (!confidence.ok) return invalid("confidence must be between 0 and 1", "score");
  const legend = isRecord(answer["legend"]) ? answer["legend"] : null;
  const legendLabel = legend?.[String(Math.round(score))];
  return {
    type: "score",
    status: "ok",
    reason: null,
    value: score,
    label: typeof legendLabel === "string" ? legendLabel : null,
    probabilities,
    confidence: confidence.value,
    margin: null,
    action: confidence.value !== null && confidence.value >= acceptAt ? "auto" : "review",
  };
}

/**
 * Validate the endpoint's answer to every question and turn each one into a verdict with an
 * action. A missing or malformed answer is `invalid_response` with action `review`: the
 * server never invents a value and never passes a broken answer through as a decision.
 */
export function interpretResponse(
  config: Config,
  questions: Record<string, Question>,
  upstream: EndpointResponse,
  options: JudgeOptions = {},
): JudgeResult {
  const acceptAt = options.acceptAt ?? DEFAULT_ACCEPT_AT;
  const marginAt = options.marginAt ?? DEFAULT_MARGIN_AT;
  const body = isRecord(upstream.body) ? upstream.body : null;
  const answers = isRecord(body?.["answers"]) ? body["answers"] : {};

  const results: Record<string, Verdict> = {};
  let auto = 0;
  let review = 0;
  let invalidCount = 0;
  for (const [id, question] of Object.entries(questions)) {
    const verdict = judgeAnswer(question, answers[id], acceptAt, marginAt);
    results[id] = verdict;
    if (verdict.status === "invalid_response") invalidCount += 1;
    if (verdict.action === "auto") auto += 1;
    else review += 1;
  }

  const usage = isRecord(body?.["usage"]) ? body["usage"] : null;
  const model = body?.["model"];
  return {
    endpoint: { url: config.url, status: upstream.status },
    model: typeof model === "string" ? model : null,
    results,
    summary: { questions: Object.keys(questions).length, auto, review, invalid: invalidCount },
    usage: {
      input_tokens: readNumber(usage?.["input_tokens"] ?? usage?.["inputTokens"]),
      output_tokens: readNumber(usage?.["output_tokens"] ?? usage?.["outputTokens"]),
      cost: readNumber(usage?.["cost"]),
    },
    raw: upstream.body,
  };
}
