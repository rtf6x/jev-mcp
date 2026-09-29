import { createServer } from "node:http";
import type { Config } from "../src/config.ts";

/** A config pointed at a port nothing listens on, unless a test says otherwise. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: "http://127.0.0.1:1/v1/systemone",
    apiKey: "test-key",
    model: "jev-latest",
    questionType: "noul",
    httpHost: "127.0.0.1",
    httpPort: 0,
    timeoutMs: 5_000,
    envPath: "/tmp/jev-mcp-test/.env",
    ...overrides,
  };
}

export type StubRequest = {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: unknown;
};

export type StubReply = { status: number; body?: unknown; text?: string };

export type StubEndpoint = {
  readonly url: string;
  readonly requests: StubRequest[];
  readonly close: () => Promise<void>;
};

/** An HTTP endpoint standing in for a Jev provider: records requests, replies as scripted. */
export async function startStubEndpoint(reply: (request: StubRequest) => StubReply): Promise<StubEndpoint> {
  const requests: StubRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const request: StubRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: raw === "" ? null : (JSON.parse(raw) as unknown),
      };
      requests.push(request);
      const { status, body, text } = reply(request);
      const payload = text ?? JSON.stringify(body ?? {});
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub endpoint did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/v1/systemone`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
