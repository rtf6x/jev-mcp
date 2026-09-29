import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.ts";
import { EndpointError, postToEndpoint } from "./forward.ts";
import { buildRequestBody, DEFAULT_ACCEPT_AT, DEFAULT_MARGIN_AT, interpretResponse, type Question } from "./judge.ts";

export const JUDGE_TOOL_NAME = "jev_judge";

const questionSchema = z
  .object({
    type: z.string().describe("choice, score, or a yes/no question (noul, bool or boolean)."),
    instructions: z
      .unknown()
      .describe("The question, or a structured object holding the question plus the data it refers to."),
    criteria: z
      .unknown()
      .optional()
      .describe(
        "choice: map of option -> rubric description. score: ordered array of levels, lowest first. yes/no: optional {true, false} descriptions.",
      ),
  })
  .passthrough();

export const judgeInputShape = {
  state: z
    .union([z.string(), z.record(z.unknown()), z.array(z.unknown())])
    .describe("What the questions are judged against: a string, a JSON object, or a JSON array."),
  questions: z
    .record(questionSchema)
    .describe(
      "Question id -> question. Each question is judged against the same state, independently, so batch every question about one state into a single call. Sent to the endpoint as written.",
    ),
  model: z.string().optional().describe("Model id for this call; overrides JEV_MODEL."),
  accept_at: z
    .number()
    .min(0.5)
    .max(1)
    .optional()
    .describe(`Action threshold (default ${DEFAULT_ACCEPT_AT}). At or above it an answer is decisive.`),
  margin_at: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      `Choice answers only: the winner-to-runner-up gap required for action auto (default ${DEFAULT_MARGIN_AT}).`,
    ),
};

const DESCRIPTION = [
  "Judge a state against typed questions with the Jev endpoint this server is configured for (JEV_URL).",
  "Posts {model, state, questions} to that endpoint and returns one verdict per question: the chosen option, level position or yes-probability, the full probability distribution, confidence, and an action — auto when the answer is decisive at the thresholds, review otherwise.",
  "Answers are validated fail-closed: a missing or malformed answer comes back status invalid_response with action review, never a guessed value.",
  "Questions are forwarded verbatim, except that a yes/no question is spelled the way the endpoint expects.",
  "Jev does not execute anything: probabilities are signals, not authorization — keep irreversible actions behind your own approval.",
].join(" ");

export function registerJudgeTool(server: McpServer, config: Config): void {
  server.registerTool(
    JUDGE_TOOL_NAME,
    {
      title: "Jev judge",
      description: DESCRIPTION,
      inputSchema: judgeInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const questions = args.questions as Record<string, Question>;
      const body = buildRequestBody(config, { state: args.state, questions, model: args.model });

      let upstream;
      try {
        upstream = await postToEndpoint(config, body);
      } catch (error) {
        const message = error instanceof EndpointError ? error.message : String(error);
        return { isError: true, content: [{ type: "text" as const, text: `Jev endpoint unreachable: ${message}` }] };
      }

      if (!upstream.ok) {
        const detail = upstream.text.trim() === "" ? "(empty body)" : upstream.text.trim();
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Jev endpoint returned HTTP ${upstream.status}: ${detail}` }],
          structuredContent: { ok: false, status: upstream.status, body: upstream.body },
        };
      }

      const result = interpretResponse(config, questions, upstream, {
        acceptAt: args.accept_at,
        marginAt: args.margin_at,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );
}
