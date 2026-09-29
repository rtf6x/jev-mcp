// Ported from jkudish/jev-mcp src/index.ts (MIT).
// Question design adapted from burnigtm/jev-mcp (MIT) via PR #2 by rimusz.
// See THIRD-PARTY-NOTICES.md.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { callJev, toolResult } from "../jev/call.ts";
import {
  DEFAULT_COMPOSITE_FLOOR,
  MAX_REVIEW_DOC_CHARS,
  MAX_REVIEW_FILES,
  MAX_REVIEW_FILES_TOTAL_CHARS,
  MAX_REVIEW_FILE_PATH_CHARS,
  REVIEW_WEIGHTS,
} from "../jev/limits.ts";
import { resolvePolicyThresholds } from "../jev/policy.ts";
import { truncate } from "../jev/text.ts";
import {
  composePerFileReview,
  fileAnswers,
  fileScope,
  projectReviewHalf,
  reviewQuestions,
} from "./patch-review.ts";
import { strictShape } from "./schema.ts";

export function registerReviewTool(server: McpServer, config: Config): void {
  server.registerTool(
    "jev_review",
    {
      title: "Review a proposed patch",
      description:
        "Score a proposed diff against the request with TypeSafe Jev before the task is called done. " +
        "Returns 0..2 rubric scores for correctness, spec match, test gap, and blast radius (the last two lower the " +
        "weighted composite), a safe_to_apply probability, and an auto | review | escalate action. Auto requires " +
        "safe_to_apply and min score confidence at auto_accept and the composite at composite_floor; truncated or " +
        "malformed input never returns auto. Does not apply the patch or run tests. " +
        "For a multi-file change, pass files instead of diff: the rubric is asked once per file in the same request " +
        "and the action composes in code (auto only when every file is auto). " +
        "Use jev_gate to also verify completion claims against evidence in the same call.",
      inputSchema: strictShape({
        request: z
          .string()
          .min(1)
          .describe("What the user asked for; this frames the review, it is not proof of anything."),
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
              `the whole change is auto only when every file is auto, and the result names the limiting file and rubric. ` +
              `Each diff is truncated at ${MAX_REVIEW_DOC_CHARS} chars; up to ${MAX_REVIEW_FILES} files, and request + ` +
              `tests + all diffs together must stay within ${MAX_REVIEW_FILES_TOTAL_CHARS.toLocaleString("en-US")} chars. Provide exactly one of diff or files.`,
          ),
        tests: z.string().optional().describe("Reported test output, if any. Truncated at the same cap."),
        auto_accept: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("safe_to_apply and min score confidence at or above this may stand automatically. Default 0.8."),
        review_at: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Min score confidence or safe_to_apply below this escalates. Must be <= auto_accept. Default min(0.5, auto_accept)."),
        composite_floor: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Weighted composite at or above this is required for auto. Default 0.7."),
      }),
    },
    async ({ request, diff, files, tests, auto_accept, review_at, composite_floor }) => {
      const { autoAccept, reviewAt } = resolvePolicyThresholds(auto_accept ?? 0.8, review_at);
      const compositeFloor = composite_floor ?? DEFAULT_COMPOSITE_FLOOR;
      const perFile = files ?? null;
      if ((perFile === null) === (diff === undefined)) {
        return {
          ...toolResult({
            tool: "jev_review",
            error: "provide exactly one of diff (whole-change review) or files (per-file review).",
          }),
          isError: true,
        };
      }
      // The exactly-one check above proves that a whole-change review carries a diff.
      const wholeDiff = diff as string;
      if (perFile) {
        // Combined-state budget: request + tests + every file diff together, so
        // one request stays comfortably inside Jev's documented state limits.
        const stateChars = request.length + (tests?.length ?? 0) + perFile.reduce((sum, file) => sum + file.diff.length, 0);
        if (stateChars > MAX_REVIEW_FILES_TOTAL_CHARS) {
          return {
            ...toolResult({
              tool: "jev_review",
              error: `request, tests, and files together exceed the ${MAX_REVIEW_FILES_TOTAL_CHARS.toLocaleString("en-US")}-character combined budget; split the review or trim the inputs.`,
            }),
            isError: true,
          };
        }
      }
      // Truncation is per-file: a file's projection is demoted only for its own
      // truncated diff (plus the shared request/tests context); an intact file
      // is never marked incomplete for a fat sibling.
      const contextTruncated = request.length > MAX_REVIEW_DOC_CHARS || (tests?.length ?? 0) > MAX_REVIEW_DOC_CHARS;
      const truncated =
        contextTruncated ||
        (perFile ? perFile.some((file) => file.diff.length > MAX_REVIEW_DOC_CHARS) : wholeDiff.length > MAX_REVIEW_DOC_CHARS);

      const state = perFile
        ? {
            purpose: "Review each file's diff against the request; tests is reported test output.",
            request: truncate(request, MAX_REVIEW_DOC_CHARS),
            files: perFile.map((file) => ({ path: file.path, diff: truncate(file.diff, MAX_REVIEW_DOC_CHARS) })),
            tests: tests ? truncate(tests, MAX_REVIEW_DOC_CHARS) : null,
          }
        : {
            purpose: "Review the proposed diff against the request; tests is reported test output.",
            request: truncate(request, MAX_REVIEW_DOC_CHARS),
            diff: truncate(wholeDiff, MAX_REVIEW_DOC_CHARS),
            tests: tests ? truncate(tests, MAX_REVIEW_DOC_CHARS) : null,
          };

      const questions: Record<string, unknown> = {};
      if (perFile) {
        perFile.forEach((file, i) => Object.assign(questions, reviewQuestions(config, "", fileScope(i), `file_${i}_`)));
      } else {
        Object.assign(questions, reviewQuestions(config));
      }
      const call = await callJev(config, state, questions);
      if (!call.ok) return call.result;
      const { answers, usage, provider, model } = call.reply;

      if (perFile) {
        const fileResults = perFile.map((file, i) => ({
          path: file.path,
          ...projectReviewHalf(
            fileAnswers(answers, i),
            { autoAccept, reviewAt, compositeFloor },
            contextTruncated || file.diff.length > MAX_REVIEW_DOC_CHARS,
          ),
        }));
        return toolResult({
          tool: "jev_review",
          model,
          provider,
          truncated,
          mode: "per-file",
          ...composePerFileReview(fileResults, { ...REVIEW_WEIGHTS }, {
            auto_accept: autoAccept,
            review_at: reviewAt,
            composite_floor: compositeFloor,
          }),
          files: fileResults,
          usage,
        });
      }

      return toolResult({
        tool: "jev_review",
        model,
        provider,
        truncated,
        ...projectReviewHalf(answers, { autoAccept, reviewAt, compositeFloor }, truncated),
        usage,
      });
    },
  );
}
