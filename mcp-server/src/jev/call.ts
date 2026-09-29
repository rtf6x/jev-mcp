// Ported from jkudish/jev-mcp src/index.ts (MIT), where this boundary was their provider
// transport; ours is forward.ts. See THIRD-PARTY-NOTICES.md.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.ts";
import { EndpointError, postToEndpoint } from "../forward.ts";
import { isRecord } from "../guards.ts";

/** Token counters the endpoint reported for a call. */
export type JevUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
};

/** What one call to the configured endpoint produced. */
export type JevReply = {
  /** The endpoint's answers, keyed by question id. Every value is validated before use. */
  readonly answers: Record<string, unknown>;
  /** `null` when this tool call never reached the endpoint. */
  readonly usage: JevUsage | null;
  readonly model: string;
  /** Which transport answered: this server has exactly one endpoint, or none was called. */
  readonly provider: "endpoint" | "none";
};

export type JevOutcome = { ok: true; reply: JevReply } | { ok: false; result: CallToolResult };

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Usage counters, accepting both the snake_case names the Jev API documents and the camelCase
 * ones some gateways report. `null` when the endpoint reported no usage at all.
 */
function readUsage(raw: unknown): JevUsage | null {
  if (!isRecord(raw)) return null;
  return {
    input_tokens: readNumber(raw["input_tokens"] ?? raw["inputTokens"]),
    output_tokens: readNumber(raw["output_tokens"] ?? raw["outputTokens"]),
    cost: readNumber(raw["cost"]),
  };
}

/** The MCP result every tool returns on success: the payload as JSON text. */
export function toolResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/** A tool error: the message explains what failed, and nothing was decided. */
export function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * The reply for a tool call that decided not to reach the endpoint at all (nothing to ask).
 */
export function skippedCall(config: Config): JevReply {
  return { answers: {}, usage: null, model: config.model, provider: "none" };
}

/**
 * One request per tool call: `{ model, state, questions }` POSTed to the configured endpoint.
 * The endpoint's HTTP error status and body, and a transport failure, come back as a tool error;
 * there is no retry and no fallback, so a malformed response can never masquerade as a verdict.
 */
export async function callJev(
  config: Config,
  state: unknown,
  questions: Record<string, unknown>,
): Promise<JevOutcome> {
  let upstream;
  try {
    upstream = await postToEndpoint(config, { model: config.model, state, questions });
  } catch (error) {
    const message = error instanceof EndpointError ? error.message : String(error);
    return { ok: false, result: toolError(`Jev endpoint unreachable: ${message}`) };
  }

  if (!upstream.ok) {
    const detail = upstream.text.trim() === "" ? "(empty body)" : upstream.text.trim();
    return {
      ok: false,
      result: toolError(`Jev endpoint returned HTTP ${upstream.status}: ${detail}`),
    };
  }

  const body = isRecord(upstream.body) ? upstream.body : {};
  const model = body["model"];
  return {
    ok: true,
    reply: {
      answers: isRecord(body["answers"]) ? body["answers"] : {},
      usage: readUsage(body["usage"]),
      model: typeof model === "string" ? model : config.model,
      provider: "endpoint",
    },
  };
}
