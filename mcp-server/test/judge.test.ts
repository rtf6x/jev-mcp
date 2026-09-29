import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EndpointResponse } from "../src/forward.ts";
import { buildRequestBody, canonicalQuestionType, interpretResponse, type Question } from "../src/judge.ts";
import { testConfig } from "./helpers.ts";

const TYPESAFE_QUESTIONS: Record<string, Question> = {
  department: {
    type: "choice",
    instructions: "Which team should handle this",
    criteria: { billing: "Payment or subscription issues", technical: "Bugs or integration problems", sales: "Pricing or account questions" },
  },
  frustration: {
    type: "score",
    instructions: "How frustrated the customer appears",
    criteria: ["Calm, just stating facts", "Frustrated but civil", "Very angry, strong language"],
  },
  is_urgent: { type: "noul", instructions: "The message conveys urgency or time-sensitivity" },
};

function upstream(status: number, body: unknown, text = JSON.stringify(body)): EndpointResponse {
  return { status, ok: status >= 200 && status < 300, body, text };
}

describe("canonicalQuestionType", () => {
  it("treats every yes/no spelling as one primitive", () => {
    assert.equal(canonicalQuestionType("noul"), "noul");
    assert.equal(canonicalQuestionType("bool"), "noul");
    assert.equal(canonicalQuestionType("BOOLEAN"), "noul");
    assert.equal(canonicalQuestionType("choice"), "choice");
    assert.equal(canonicalQuestionType("score"), "score");
    assert.equal(canonicalQuestionType("ranking"), null);
  });
});

describe("buildRequestBody", () => {
  it("forwards questions verbatim and spells the yes/no type for the endpoint", () => {
    const questions: Record<string, Question> = {
      verdict: { type: "bool", instructions: "Is it true?", criteria: { true: "yes", false: "no" }, note: "kept" },
      rank: { type: "score", instructions: "How good?", criteria: ["low", "high"] },
    };
    assert.deepEqual(buildRequestBody(testConfig({ questionType: "boolean" }), { state: "s", questions }), {
      model: "jev-latest",
      state: "s",
      questions: {
        verdict: { type: "boolean", instructions: "Is it true?", criteria: { true: "yes", false: "no" }, note: "kept" },
        rank: { type: "score", instructions: "How good?", criteria: ["low", "high"] },
      },
    });
  });

  it("prefers the per-call model over the configured one", () => {
    const config = testConfig({ model: "jev-latest" });
    const questions = { q: { type: "noul", instructions: "?" } };
    assert.equal(buildRequestBody(config, { state: "s", questions }).model, "jev-latest");
    assert.equal(buildRequestBody(config, { state: "s", questions, model: "typesafe/jev-1.13" }).model, "typesafe/jev-1.13");
  });
});

describe("interpretResponse with a TypeSafe answer", () => {
  const response = upstream(200, {
    model: "jev-1.13.0",
    answers: {
      department: {
        type: "choice",
        choice: "technical",
        confidence: 0.78,
        probabilities: { technical: 0.85, sales: 0, billing: 0.15 },
      },
      frustration: {
        type: "score",
        score: 1.0,
        confidence: 1.0,
        legend: { 0: "Calm, just stating facts", 1: "Frustrated but civil", 2: "Very angry, strong language" },
        probabilities: { 0: 0, 1: 1, 2: 0 },
      },
      is_urgent: { type: "noul", noul: 1.0 },
    },
    usage: { input_tokens: 392, output_tokens: 65 },
  });

  it("turns every answer into a verdict with an action", () => {
    const result = interpretResponse(testConfig(), TYPESAFE_QUESTIONS, response);
    assert.equal(result.model, "jev-1.13.0");
    assert.deepEqual(result.summary, { questions: 3, auto: 3, review: 0, invalid: 0 });
    assert.deepEqual(result.usage, { input_tokens: 392, output_tokens: 65, cost: null });
    assert.deepEqual(result.results["department"], {
      type: "choice",
      status: "ok",
      reason: null,
      value: "technical",
      label: "Bugs or integration problems",
      probabilities: { technical: 0.85, sales: 0, billing: 0.15 },
      confidence: 0.78,
      margin: 0.7,
      action: "auto",
    });
    assert.equal(result.results["frustration"]?.label, "Frustrated but civil");
    assert.equal(result.results["frustration"]?.action, "auto");
    assert.equal(result.results["is_urgent"]?.label, "yes");
    assert.equal(result.results["is_urgent"]?.value, 1);
  });
});

describe("interpretResponse across provider wrappers", () => {
  it("reads an OpenRouter answer, including cost, and holds back a low top probability", () => {
    const questions: Record<string, Question> = {
      is_bug: { type: "noul", instructions: "Is this a defect?" },
      urgency: {
        type: "score",
        instructions: "How urgent?",
        criteria: ["Can wait", "This week", "Blocking revenue"],
      },
      team: {
        type: "choice",
        instructions: "Which team?",
        criteria: { payments: "payments", frontend: "frontend", account: "account" },
      },
    };
    const result = interpretResponse(
      testConfig(),
      questions,
      upstream(200, {
        id: "gen-dec-1790015143",
        model: "typesafe/jev-1.13-20260917",
        provider: "TypeSafe",
        answers: {
          is_bug: { type: "noul", noul: 0.96 },
          urgency: {
            type: "score",
            score: 1.99,
            confidence: 0.99,
            legend: { 0: "Can wait", 1: "This week", 2: "Blocking revenue" },
            probabilities: { 0: 0, 1: 0, 2: 1 },
          },
          team: {
            type: "choice",
            choice: "payments",
            confidence: 0.67,
            probabilities: { payments: 0.78, frontend: 0.22, account: 0 },
          },
        },
        usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
      }),
    );
    assert.equal(result.model, "typesafe/jev-1.13-20260917");
    assert.deepEqual(result.usage, { input_tokens: 476, output_tokens: 70, cost: 0.000019992 });
    assert.equal(result.results["urgency"]?.label, "Blocking revenue");
    assert.equal(result.results["urgency"]?.action, "auto");
    assert.equal(result.results["team"]?.action, "review");
    assert.equal(result.results["team"]?.reason, null);
    assert.equal(result.summary.review, 1);
  });

  it("reads a Vercel answer: boolean spelling and camelCase usage", () => {
    const questions: Record<string, Question> = { refund: { type: "noul", instructions: "Money back?" } };
    const result = interpretResponse(
      testConfig({ questionType: "boolean" }),
      questions,
      upstream(200, {
        model: "typesafe-ai/jev",
        answers: { refund: { type: "boolean", probability: 0.98 } },
        usage: { inputTokens: 275, outputTokens: 20 },
        providerMetadata: { gateway: { cost: "0.00001155" } },
      }),
    );
    assert.equal(result.results["refund"]?.label, "yes");
    assert.equal(result.results["refund"]?.action, "auto");
    assert.deepEqual(result.usage, { input_tokens: 275, output_tokens: 20, cost: null });
  });

  it("reports an uncertain yes/no answer as review", () => {
    const questions: Record<string, Question> = { ok: { type: "noul", instructions: "?" } };
    const result = interpretResponse(testConfig(), questions, upstream(200, { answers: { ok: { type: "noul", noul: 0.5 } } }));
    assert.equal(result.results["ok"]?.label, "uncertain");
    assert.equal(result.results["ok"]?.action, "review");
    const reflected = interpretResponse(
      testConfig(),
      questions,
      upstream(200, { answers: { ok: { type: "noul", noul: 0.05 } } }),
    );
    assert.equal(reflected.results["ok"]?.label, "no");
    assert.equal(reflected.results["ok"]?.action, "auto");
  });
});

describe("interpretResponse fails closed", () => {
  const choice: Record<string, Question> = {
    team: { type: "choice", instructions: "?", criteria: { a: "a", b: "b" } },
  };
  const score: Record<string, Question> = { level: { type: "score", instructions: "?", criteria: ["lo", "mid", "hi"] } };
  const noul: Record<string, Question> = { ok: { type: "noul", instructions: "?" } };

  const cases: Array<{ name: string; questions: Record<string, Question>; body: unknown }> = [
    { name: "no answer for the question", questions: noul, body: { answers: {} } },
    { name: "no answers envelope at all", questions: noul, body: { model: "jev-1.13.0" } },
    { name: "probability out of range", questions: noul, body: { answers: { ok: { type: "noul", noul: 1.4 } } } },
    {
      name: "probabilities that do not sum to one",
      questions: choice,
      body: { answers: { team: { type: "choice", choice: "a", probabilities: { a: 0.5, b: 0.3 } } } },
    },
    {
      name: "a choice that is not the highest probability",
      questions: choice,
      body: { answers: { team: { type: "choice", choice: "b", probabilities: { a: 0.9, b: 0.1 } } } },
    },
    {
      name: "a choice outside the criteria",
      questions: choice,
      body: { answers: { team: { type: "choice", choice: "c", probabilities: { a: 0.6, b: 0.4 } } } },
    },
    {
      name: "probabilities that do not cover the criteria",
      questions: choice,
      body: { answers: { team: { type: "choice", choice: "a", probabilities: { a: 1 } } } },
    },
    {
      name: "a score outside the levels",
      questions: score,
      body: { answers: { level: { type: "score", score: 3.5, probabilities: { 0: 0, 1: 0, 2: 1 }, confidence: 0.9 } } },
    },
    {
      name: "a malformed confidence",
      questions: score,
      body: { answers: { level: { type: "score", score: 2, probabilities: { 0: 0, 1: 0, 2: 1 }, confidence: "0.9" } } },
    },
    { name: "an unsupported question type", questions: { x: { type: "ranking", instructions: "?" } }, body: { answers: { x: { type: "ranking", order: [] } } } },
  ];

  for (const testCase of cases) {
    it(`marks ${testCase.name} invalid_response with action review`, () => {
      const result = interpretResponse(testConfig(), testCase.questions, upstream(200, testCase.body));
      const verdict = Object.values(result.results)[0];
      assert.equal(verdict?.status, "invalid_response");
      assert.equal(verdict?.action, "review");
      assert.equal(verdict?.value, null);
      assert.equal(typeof verdict?.reason, "string");
      assert.equal(result.summary.invalid, 1);
      assert.equal(result.summary.auto, 0);
    });
  }
});
