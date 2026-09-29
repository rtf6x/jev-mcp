// Ported from jkudish/jev-mcp src/index.ts (MIT). See THIRD-PARTY-NOTICES.md.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { validateChoiceAnswer, validateNoulAnswer } from "../jev/answers.ts";
import { callJev, toolResult } from "../jev/call.ts";
import { MAX_CANDIDATES, MAX_CANDIDATE_CHARS } from "../jev/limits.ts";
import { existsVerdict, rankCandidates } from "../jev/policy.ts";
import { choiceQuestion, yesNoQuestion } from "../jev/questions.ts";
import { ensureUniqueIds, truncate } from "../jev/text.ts";
import { candidatesSchema, strictShape } from "./schema.ts";

export function registerFindTool(server: McpServer, config: Config): void {
  server.registerTool(
    "jev_find",
    {
      title: "Semantic search over candidates",
      description:
        "Rank candidates against a plain-language query with TypeSafe Jev — no embeddings needed. " +
        "One Choice scores every candidate id by how well it answers the query, plus a Noul checks whether " +
        "any candidate addresses the query at all (so a confident 'top hit' cannot masquerade as an answer). " +
        "Pattern: docs.typesafe.ai/cookbooks/semantic_find. Use for 'which file/note/line covers X' across up to " +
        `${MAX_CANDIDATES} candidates.`,
      inputSchema: strictShape({
        query: z.string().min(1).describe("What you are looking for, in natural language."),
        candidates: candidatesSchema,
        top_k: z.number().int().min(1).max(50).optional().describe("How many ranked candidates to return. Default 5."),
      }),
    },
    async ({ query, candidates: rawCandidates, top_k }) => {
      const topK = top_k ?? 5;
      const { items: candidates } = ensureUniqueIds(
        rawCandidates.map((c) => ({ id: c.id ?? "", text: truncate(c.text, MAX_CANDIDATE_CHARS) })),
        "candidate",
      );

      const criteria: Record<string, string | null> = Object.fromEntries(
        candidates.map((c): [string, null] => [c.id, null]),
      );
      const questions: Record<string, unknown> = {
        best: choiceQuestion(`Which candidate contains the best answer to: "${query}"?`, criteria),
        exists: yesNoQuestion(config, `Does any candidate address or answer: "${query}"?`, {
          true: "At least one candidate states or directly implies the answer",
          false: "No candidate addresses this",
        }),
      };

      const state = { query, candidates };
      const call = await callJev(config, state, questions);
      if (!call.ok) return call.result;
      const { answers, usage, provider, model } = call.reply;

      const exists = validateNoulAnswer(answers["exists"]);
      const best = validateChoiceAnswer(
        answers["best"],
        candidates.map((c) => c.id),
      );
      if (exists === null || best === null) {
        // A missing exists/best answer must not be read as "no match" (exists ?? 0)
        // or "no ranking": surface the protocol failure instead.
        return toolResult({
          tool: "jev_find",
          model,
          provider,
          query,
          status: "invalid_response",
          exists,
          exists_verdict: null,
          top: [],
          reason: "missing or malformed best or exists answer; cannot rank safely",
          usage,
        });
      }
      const ranked = rankCandidates(candidates, best.probabilities).slice(0, topK);

      return toolResult({
        tool: "jev_find",
        model,
        provider,
        query,
        exists,
        exists_verdict: existsVerdict(exists),
        top: ranked.map((c) => ({ id: c.id, probability: Number(c.probability.toFixed(4)), text: c.text })),
        usage,
      });
    },
  );
}
