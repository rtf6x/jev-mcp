// Ported from jkudish/jev-mcp src/index.ts (MIT). See THIRD-PARTY-NOTICES.md.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { validateChoiceAnswer } from "../jev/answers.ts";
import { callJev, toolResult } from "../jev/call.ts";
import { MAX_CLASSES, MAX_ITEM_CHARS, MAX_ITEMS } from "../jev/limits.ts";
import { classificationDecision } from "../jev/policy.ts";
import { choiceQuestion } from "../jev/questions.ts";
import { truncate } from "../jev/text.ts";
import { strictShape } from "./schema.ts";

export function registerClassifyTool(server: McpServer, config: Config): void {
  server.registerTool(
    "jev_classify",
    {
      title: "Classify items against a shared label set",
      description:
        "Assign each item to one class from a shared catalog with TypeSafe Jev, in one batched request: " +
        "the class catalog is sent once and every item becomes an independent Choice question. " +
        "Returns per item: the chosen class, the full distribution, confidence, winner-to-runner-up margin, " +
        "and an auto-versus-review decision. Auto requires both a high top probability (default 0.85) and a " +
        "clear margin (default 0.50); everything else is flagged for review. Include a manual_review class " +
        "in the catalog if you want an explicit escape hatch; the tool never invents one.",
      inputSchema: strictShape({
        items: z
          .array(z.object({ id: z.string().optional(), text: z.string() }).strict())
          .min(1)
          .max(MAX_ITEMS)
          .describe(
            `Items to classify. Text is truncated at ${MAX_ITEM_CHARS} characters; send bounded excerpts, not whole documents.`,
          ),
        classes: z
          .array(z.object({ id: z.string().optional(), description: z.string() }).strict())
          .min(2)
          .max(MAX_CLASSES)
          .describe(
            "Shared class catalog. Strong descriptions carry the decision: a precise definition, " +
              "what belongs, what does not, precedence over overlapping classes, and a short example.",
          ),
        purpose: z.string().optional().describe("What this classification is for; shared across all items."),
        context: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe("Shared context available to every item's judgment: policies, catalogs, anything stable."),
        auto_accept: z.number().min(0).max(1).optional().describe("Minimum top probability for auto. Default 0.85."),
        minimum_margin: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Minimum winner-to-runner-up gap for auto. Default 0.5."),
      }),
    },
    async ({ items: rawItems, classes: rawClasses, purpose, context, auto_accept, minimum_margin }) => {
      const autoAccept = auto_accept ?? 0.85;
      const minMargin = minimum_margin ?? 0.5;

      // Preserve caller IDs exactly; use opaque internal keys (i0/c0) for the
      // wire so sanitization can never rename or collide externally, and
      // reject duplicate supplied IDs rather than silently suffixing them.
      // Generated fallbacks (item0/class0 style) avoid every supplied or
      // already-used ID, so an omitted id can never collide with an explicit
      // one — the same two-phase pattern jev_rerank uses for candidate IDs.
      const suppliedItemIds = new Set<string>();
      for (const it of rawItems) {
        if (it.id != null) {
          if (suppliedItemIds.has(it.id)) throw new Error(`Duplicate item id: ${it.id}`);
          suppliedItemIds.add(it.id);
        }
      }
      const usedItemIds = new Set(suppliedItemIds);
      const items = rawItems.map((it, i) => {
        let external: string;
        if (it.id != null) {
          external = it.id;
        } else {
          external = `item${i}`;
          let suffix = 2;
          while (usedItemIds.has(external)) external = `item${i}_${suffix++}`;
        }
        usedItemIds.add(external);
        return { external, key: `i${i}`, text: truncate(it.text, MAX_ITEM_CHARS) };
      });
      const suppliedClassIds = new Set<string>();
      for (const c of rawClasses) {
        if (c.id != null) {
          if (suppliedClassIds.has(c.id)) throw new Error(`Duplicate class id: ${c.id}`);
          suppliedClassIds.add(c.id);
        }
      }
      const usedClassIds = new Set(suppliedClassIds);
      const classes = rawClasses.map((c, i) => {
        let external: string;
        if (c.id != null) {
          external = c.id;
        } else {
          external = `class${i}`;
          let suffix = 2;
          while (usedClassIds.has(external)) external = `class${i}_${suffix++}`;
        }
        usedClassIds.add(external);
        return { external, key: `c${i}`, description: truncate(c.description, MAX_ITEM_CHARS) };
      });
      if (items.length * classes.length > 8_000) {
        throw new Error(
          `Batch too large: ${items.length} items x ${classes.length} classes exceeds the 8,000 item-class budget. Split the batch.`,
        );
      }

      // The catalog lives once in shared state; each question carries only its
      // own item text in its instructions, and criteria are bare keys. Request
      // size scales with items + catalog, not items x catalog.
      const state = {
        purpose: purpose ?? "Assign each item to exactly one class.",
        context: context ?? null,
        classes: classes.map((c) => ({ id: c.key, description: c.description })),
      };
      const criteria: Record<string, null> = Object.create(null);
      for (const c of classes) criteria[c.key] = null;
      const questions: Record<string, unknown> = {};
      for (const item of items) {
        questions[item.key] = choiceQuestion(
          { task: "Which class does this item belong to?", item: { id: item.key, text: item.text } },
          criteria,
        );
      }

      const call = await callJev(config, state, questions);
      if (!call.ok) return call.result;
      const { answers, usage, provider, model } = call.reply;

      const keyToExternal = new Map(classes.map((c) => [c.key, c.external]));
      const results = items.map((item) => {
        const answer = validateChoiceAnswer(
          answers[item.key],
          classes.map((c) => c.key),
        );

        if (!answer) {
          return {
            id: item.external,
            status: "invalid_response" as const,
            classification: null,
            probabilities: null,
            confidence: null,
            margin: null,
            decision: "review" as const,
          };
        }

        const values = Object.values(answer.probabilities);
        const ranked = values.slice().sort((a, b) => b - a);
        const margin = ranked.length >= 2 ? (ranked[0] ?? 0) - (ranked[1] ?? 0) : 0;
        const topProbability = answer.probabilities[answer.choice] ?? 0;
        return {
          id: item.external,
          classification: keyToExternal.get(answer.choice) ?? answer.choice,
          probabilities: Object.fromEntries(classes.map((c) => [c.external, answer.probabilities[c.key] ?? 0])),
          confidence: answer.confidence,
          margin,
          top_probability: topProbability,
          decision: classificationDecision(topProbability, margin, autoAccept, minMargin),
        };
      });

      // Null prototype: a caller-supplied class id such as "__proto__" or
      // "constructor" must be tallied as its own key, not swallowed by (or
      // read from) Object.prototype.
      const byClass: Record<string, number> = Object.create(null);
      for (const r of results) {
        if (r.classification !== null) byClass[r.classification] = (byClass[r.classification] ?? 0) + 1;
      }

      return toolResult({
        tool: "jev_classify",
        model,
        provider,
        summary: {
          items: results.length,
          auto: results.filter((r) => r.decision === "auto").length,
          review: results.filter((r) => r.decision === "review" && r.status !== "invalid_response").length,
          invalid_response: results.filter((r) => r.status === "invalid_response").length,
          by_class: byClass,
        },
        thresholds: { auto_accept: autoAccept, minimum_margin: minMargin },
        results,
        usage,
      });
    },
  );
}
