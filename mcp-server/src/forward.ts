import type { Config } from "./config.ts";
import { isRecord } from "./guards.ts";

export type EndpointResponse = {
  readonly status: number;
  readonly ok: boolean;
  /** Raw response body as received. */
  readonly text: string;
  /** Parsed JSON body, or `null` when the body is not JSON. */
  readonly body: unknown;
};

/**
 * Transport failure: the endpoint was never reached (or the deadline expired). `code` is the
 * underlying socket error code when there is one; `timedOut` marks the deadline, where the
 * request may have been served even though no answer was read.
 */
export class EndpointError extends Error {
  override readonly name = "EndpointError";
  readonly status = 0;
  readonly code: string | null;
  readonly timedOut: boolean;

  constructor(message: string, options: { code?: string | null; timedOut?: boolean } = {}) {
    super(message);
    this.code = options.code ?? null;
    this.timedOut = options.timedOut ?? false;
  }
}

/**
 * What kind of transport failure this is. A deadline is separated from a refused or reset
 * connection because only the latter proves the request was never served.
 */
function describeFetchFailure(error: unknown): { code: string | null; timedOut: boolean } {
  if (!(error instanceof Error)) return { code: null, timedOut: false };
  const cause = (error as { cause?: unknown }).cause;
  const names = [error.name, cause instanceof Error ? cause.name : null];
  if (names.includes("TimeoutError") || names.includes("AbortError")) {
    return { code: null, timedOut: true };
  }
  const code = isRecord(cause) && typeof cause["code"] === "string" ? cause["code"] : null;
  return { code, timedOut: false };
}

/**
 * POST a request body to the configured endpoint. The URL is used verbatim, the key travels
 * as a bearer token, and the response — status, raw text and parsed body — comes back
 * untouched. HTTP error statuses are returned, not thrown: the caller decides what they mean.
 */
export async function postToEndpoint(
  config: Config,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<EndpointResponse> {
  let response: Response;
  try {
    response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EndpointError(`POST ${config.url} failed: ${reason}`, describeFetchFailure(error));
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // Non-JSON bodies stay available to the caller as `text`.
  }
  return { status: response.status, ok: response.ok, text, body: parsed };
}
