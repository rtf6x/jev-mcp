// Ported from jkudish/jev-mcp src/index.ts (MIT). See THIRD-PARTY-NOTICES.md.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { validateNoulAnswer } from "../jev/answers.ts";
import { callJev, toolResult } from "../jev/call.ts";
import { MAX_CANDIDATE_CHARS, MAX_RERANK_CANDIDATES, MAX_RERANK_TOTAL_CHARS } from "../jev/limits.ts";
import { rerankByScore } from "../jev/policy.ts";
import { yesNoQuestion } from "../jev/questions.ts";
import { truncate } from "../jev/text.ts";
import { candidatesSchema, strictShape } from "./schema.ts";

export function registerRerankTool(server: McpServer, config: Config): void {
  server.registerTool(
    "jev_rerank",
    {
      title: "Score every candidate's relevance and return them sorted",
      description:
        "Rerank candidates against a query with TypeSafe Jev: one independent relevance probability per candidate, " +
        "all in a single request, then sorted by score. Unlike jev_find (which picks one best answer), rerank scores " +
        "every candidate so the full ordering survives. TypeSafe's rerank cookbook reports that on the CLERC benchmark " +
        "this pattern lifted top-1 from 5% to 18% and top-10 from 38% to 62% (docs.typesafe.ai/cookbooks). " +
        `Use for retrieval ordering, dedup triage, or feed ranking across up to ${MAX_RERANK_CANDIDATES} candidates.`,
      inputSchema: strictShape({
        query: z.string().min(1).max(2000).describe("What relevance is measured against, in natural language."),
        candidates: candidatesSchema,
        top_k: z.number().int().min(1).max(250).optional().describe("How many ranked candidates to return. Default: all."),
      }),
    },
    async ({ query, candidates: rawCandidates, top_k }) => {
      const topK = top_k ?? null;

      // Caller IDs are preserved verbatim; opaque wire keys (classify pattern).
      // Duplicate supplied IDs are rejected rather than silently renamed, and
      // generated fallbacks avoid every supplied or already-used ID so an
      // omitted id can never collide with an explicit one.
      const suppliedIds = new Set<string>();
      for (const c of rawCandidates) {
        if (c.id != null) {
          if (suppliedIds.has(c.id)) throw new Error(`Duplicate candidate id: ${c.id}`);
          suppliedIds.add(c.id);
        }
      }
      const usedIds = new Set(suppliedIds);
      const candidates = rawCandidates.map((c, i) => {
        let external: string;
        if (c.id != null) {
          external = c.id;
        } else {
          external = `candidate${i}`;
          let suffix = 2;
          while (usedIds.has(external)) external = `candidate${i}_${suffix++}`;
        }
        usedIds.add(external);
        return { external, key: `c${i}`, text: truncate(c.text, MAX_CANDIDATE_CHARS) };
      });
      const totalChars = candidates.reduce((n, c) => n + c.text.length, 0);
      if (totalChars > MAX_RERANK_TOTAL_CHARS) {
        throw new Error(
          `Batch too large: ${totalChars} candidate characters exceeds the ${MAX_RERANK_TOTAL_CHARS} character budget. Split the batch.`,
        );
      }

      // The query lives once in shared state; each question carries only its own
      // candidate text, so request size scales with candidates, not pairs.
      const state = { query };
      const questions: Record<string, unknown> = {};
      candidates.forEach((c, i) => {
        questions[`rel_${i}`] = yesNoQuestion(
          config,
          `Is candidate ${c.key} relevant to the query in the state? Candidate ${c.key}: ${c.text}`,
          {
            true: "The candidate addresses the subject the query asks about, or provides what it seeks",
            false: "The candidate is about a different subject, or only shares vocabulary with the query",
          },
        );
      });

      const call = await callJev(config, state, questions);
      if (!call.ok) return call.result;
      const { answers, usage, provider, model } = call.reply;

      // One invalid Noul makes the whole ordering untrustworthy; never sort a
      // missing answer as a confident zero.
      const scores: number[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const value = validateNoulAnswer(answers[`rel_${i}`]);
        if (value === null) {
          return toolResult({
            tool: "jev_rerank",
            model,
            provider,
            query,
            status: "invalid_response",
            ranked: null,
            usage,
          });
        }
        scores.push(value);
      }

      const ranked = rerankByScore(
        candidates.map((c) => ({ id: c.external, text: c.text })),
        scores,
      );
      const returned = topK ? ranked.slice(0, topK) : ranked;

      return toolResult({
        tool: "jev_rerank",
        model,
        provider,
        query,
        summary: {
          candidates: candidates.length,
          returned: returned.length,
        },
        ranked: returned.map((c, rank) => ({
          rank: rank + 1,
          id: c.id,
          relevance: Number(c.relevance.toFixed(4)),
          text: c.text,
        })),
        usage,
      });
    },
  );
}
