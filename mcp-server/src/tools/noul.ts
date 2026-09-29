// Ported from jkudish/jev-mcp src/index.ts (MIT). See THIRD-PARTY-NOTICES.md.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { validateNoulAnswer } from "../jev/answers.ts";
import { callJev, toolResult } from "../jev/call.ts";
import {
  MAX_NOUL_TOTAL_CHARS,
  MAX_PROPOSITION_CHARS,
  MAX_PROPOSITIONS,
} from "../jev/limits.ts";
import { yesNoQuestion } from "../jev/questions.ts";
import { ensureUniqueIds } from "../jev/text.ts";
import { evidenceSchema, strictShape } from "./schema.ts";

export function registerNoulTool(server: McpServer, config: Config): void {
  server.registerTool(
    "jev_noul",
    {
      title: "Calibrated probability for propositions",
      description:
        "Return a calibrated probability for each stated proposition with TypeSafe Jev, in one batched request: " +
        "high means likely, low means unlikely, middling means genuinely uncertain. Supplied context informs the " +
        "judgment but is not a proof guarantee; to test claims strictly against evidence, including whether the " +
        "evidence is merely silent, use jev_verify instead.",
      inputSchema: strictShape({
        propositions: z
          .array(z.string().min(1).max(MAX_PROPOSITION_CHARS))
          .min(1)
          .max(MAX_PROPOSITIONS)
          .refine((arr) => arr.every((p) => p.trim().length > 0), {
            message: "propositions must not be blank",
          })
          .describe(
            `Propositions to judge, each a single testable statement. Up to ${MAX_PROPOSITIONS} per call, ${MAX_PROPOSITION_CHARS} chars each.`,
          ),
        context: evidenceSchema
          .optional()
          .describe(
            "Optional context the propositions are judged against: one document or evidence items. When omitted, the model's own knowledge applies.",
          ),
        auto_accept: z
          .number()
          .gt(0.5)
          .max(1)
          .optional()
          .describe(
            "Decisiveness threshold: probability at or above this marks the proposition likely, at or below (1 - this) unlikely, between them uncertain. Must exceed 0.5. Default 0.85.",
          ),
      }),
    },
    async ({ propositions, context: rawContext, auto_accept }) => {
      const autoAccept = auto_accept ?? 0.85;

      const contextItems =
        typeof rawContext === "string"
          ? [{ id: "context", text: rawContext }]
          : Array.isArray(rawContext)
            ? rawContext
            : rawContext
              ? [rawContext]
              : [];
      const { items } = ensureUniqueIds(
        propositions.map((text) => ({ text })),
        "proposition",
      );
      const totalChars =
        items.reduce((n, p) => n + p.text.length, 0) + contextItems.reduce((n, c) => n + c.text.length, 0);
      if (totalChars > MAX_NOUL_TOTAL_CHARS) {
        throw new Error(
          `Batch too large: ${totalChars} proposition and context characters exceeds the ${MAX_NOUL_TOTAL_CHARS} character budget. Split the batch.`,
        );
      }

      // One Noul per proposition. The framing is about the proposition itself,
      // so a low probability means likely-not-true, not merely unevidenced;
      // evidence-relation judgments (including silence) belong to jev_verify.
      const questions: Record<string, unknown> = {};
      for (const p of items) {
        questions[`p_${p.id}`] = yesNoQuestion(config, `proposition \`${p.id}\`: ${p.text}`, {
          true: "The proposition is likely true, given the supplied context (when present) and general knowledge",
          false: "The proposition is likely not true",
        });
      }

      const state = { propositions: items, context: contextItems.length ? contextItems : null };
      const call = await callJev(config, state, questions);
      if (!call.ok) return call.result;
      const { answers, usage, provider, model } = call.reply;

      const rows = items.map((p) => ({
        id: p.id,
        proposition: p.text,
        probability: validateNoulAnswer(answers[`p_${p.id}`]),
      }));
      if (rows.some((r) => r.probability === null)) {
        // Fail closed: a missing or malformed probability must never surface as
        // a label or an auto classification, and no `auto: true` may appear.
        return toolResult({
          tool: "jev_noul",
          model,
          provider,
          status: "invalid_response",
          results: rows.map((r) => ({ ...r, label: null, auto: false })),
          invalid: rows.filter((r) => r.probability === null).map((r) => r.id),
          thresholds: { auto_accept: autoAccept },
          usage,
        });
      }
      const results = rows.map((r) => {
        const p = r.probability as number;
        // p + autoAccept <= 1 rather than p <= 1 - autoAccept: decimal
        // subtraction (1 - 0.9 = 0.0999...) would misclassify p = 0.1.
        const label = p >= autoAccept ? "likely" : p + autoAccept <= 1 ? "unlikely" : "uncertain";
        return { ...r, label, auto: label !== "uncertain" };
      });
      return toolResult({
        tool: "jev_noul",
        model,
        provider,
        status: "ok",
        results,
        thresholds: { auto_accept: autoAccept },
        usage,
      });
    },
  );
}
