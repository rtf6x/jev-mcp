// Ported from jkudish/jev-mcp src/index.ts (MIT), where this boundary was their provider
// transport; ours is forward.ts. See THIRD-PARTY-NOTICES.md.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.ts";
import { EndpointError, postToEndpoint } from "../forward.ts";
import type { EndpointResponse } from "../forward.ts";
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
 * Statuses that mean the request was not served, so asking again cannot double-charge: the
 * provider never started work it would bill. Anything else — 400, 422, a 200 — is returned as is.
 */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * Socket errors that prove the request never reached a served response. A deadline is absent
 * on purpose: the answer may exist, unread, and repeating it could pay twice.
 */
const RETRYABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isRetryableFailure(error: EndpointError): boolean {
  if (error.timedOut) return false;
  return error.code !== null && RETRYABLE_CODES.has(error.code);
}

/** Exponential backoff with ±20% jitter, so parallel calls do not retry in lockstep. */
function backoffMs(baseDelayMs: number, retryIndex: number): number {
  const raw = baseDelayMs * 2 ** (retryIndex - 1);
  const jitter = raw * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * One request per attempt: `{ model, state, questions }` POSTed to the configured endpoint, and
 * repeated only while the provider says the request was not served. A transport failure that
 * proves nothing was served is retried too; a deadline is not, and no answer is ever invented.
 * The endpoint's HTTP error status and body, and a final transport failure, come back as a tool
 * error, so a malformed response can never masquerade as a verdict.
 */
async function postWithRetry(
  config: Config,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<EndpointResponse> {
  let lastResponse: EndpointResponse | null = null;
  let lastFailure: EndpointError | null = null;

  for (let attempt = 1; attempt <= config.retryAttempts; attempt += 1) {
    if (attempt > 1) await sleep(backoffMs(config.retryBaseDelayMs, attempt - 1));
    try {
      const response = await postToEndpoint(config, body, fetchImpl);
      if (!RETRYABLE_STATUS.has(response.status)) return response;
      lastResponse = response;
      lastFailure = null;
    } catch (error) {
      const failure = error instanceof EndpointError ? error : new EndpointError(String(error));
      if (!isRetryableFailure(failure)) throw failure;
      lastFailure = failure;
      lastResponse = null;
    }
  }

  if (lastFailure !== null) throw lastFailure;
  if (lastResponse !== null) return lastResponse;
  throw new EndpointError("no attempt was made (retryAttempts is 0)");
}

export async function callJev(
  config: Config,
  state: unknown,
  questions: Record<string, unknown>,
): Promise<JevOutcome> {
  let upstream;
  try {
    upstream = await postWithRetry(config, { model: config.model, state, questions });
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
