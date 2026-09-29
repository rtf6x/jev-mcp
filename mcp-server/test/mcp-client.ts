import { z } from "zod";

const contentBlock = z.object({ type: z.string(), text: z.string().optional() });

export const toolResultSchema = z.object({
  content: z.array(contentBlock).optional(),
  structuredContent: z.record(z.unknown()).optional(),
  isError: z.boolean().optional(),
});

export type ToolResult = z.infer<typeof toolResultSchema>;

const envelopeSchema = z.object({
  jsonrpc: z.string(),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

export type RpcEnvelope = z.infer<typeof envelopeSchema>;

export const toolsListSchema = z.object({
  tools: z.array(z.object({ name: z.string(), inputSchema: z.record(z.unknown()).optional() })),
});

/** POST one JSON-RPC message to the server and parse the envelope. */
export async function rpc(port: number, payload: unknown): Promise<{ status: number; json: RpcEnvelope }> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, json: envelopeSchema.parse(await response.json()) };
}

/** The `result` of a tool call, or a thrown error for a JSON-RPC failure. */
export function toolResult(response: RpcEnvelope): ToolResult {
  if (response.error !== undefined) throw new Error(`JSON-RPC error: ${JSON.stringify(response.error)}`);
  return toolResultSchema.parse(response.result);
}

/** Text of the first content block. */
export function toolText(result: ToolResult): string {
  const text = result.content?.[0]?.text;
  if (text === undefined) throw new Error("tool result carries no text block");
  return text;
}

const requestBodySchema = z.object({
  model: z.string(),
  state: z.unknown(),
  questions: z.record(z.object({ type: z.string() }).passthrough()),
});

export type RequestBody = z.infer<typeof requestBodySchema>;

/** The endpoint body a tool call was forwarded as. */
export function requestBody(request: { body: unknown } | undefined): RequestBody {
  return requestBodySchema.parse(request?.body);
}
