import type { Config } from "./config.ts";

export type EndpointResponse = {
  readonly status: number;
  readonly ok: boolean;
  /** Raw response body as received. */
  readonly text: string;
  /** Parsed JSON body, or `null` when the body is not JSON. */
  readonly body: unknown;
};

/** Transport failure: the endpoint was never reached (or the deadline expired). */
export class EndpointError extends Error {
  override readonly name = "EndpointError";
  readonly status = 0;
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
    throw new EndpointError(`POST ${config.url} failed: ${reason}`);
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
