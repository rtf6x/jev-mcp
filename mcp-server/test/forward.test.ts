import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EndpointError, postToEndpoint } from "../src/forward.ts";
import { startStubEndpoint, testConfig } from "./helpers.ts";

const body = { model: "jev-latest", state: "hello", questions: { q: { type: "noul", instructions: "?" } } };

describe("postToEndpoint", () => {
  it("posts the body to the configured URL with a bearer token", async () => {
    const stub = await startStubEndpoint(() => ({ status: 200, body: { answers: {} } }));
    try {
      const response = await postToEndpoint(testConfig({ url: stub.url, apiKey: "ts_secret" }), body);
      assert.equal(response.ok, true);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { answers: {} });
      assert.equal(stub.requests.length, 1);
      assert.deepEqual(stub.requests[0]?.body, body);
      assert.equal(stub.requests[0]?.method, "POST");
      assert.equal(stub.requests[0]?.authorization, "Bearer ts_secret");
      assert.equal(stub.requests[0]?.contentType, "application/json");
    } finally {
      await stub.close();
    }
  });

  it("returns an error status instead of throwing, with the raw body kept", async () => {
    const stub = await startStubEndpoint(() => ({ status: 422, text: '{"error":{"message":"bad question"}}' }));
    try {
      const response = await postToEndpoint(testConfig({ url: stub.url }), body);
      assert.equal(response.ok, false);
      assert.equal(response.status, 422);
      assert.equal(response.text, '{"error":{"message":"bad question"}}');
      assert.deepEqual(response.body, { error: { message: "bad question" } });
    } finally {
      await stub.close();
    }
  });

  it("keeps a non-JSON body as text", async () => {
    const stub = await startStubEndpoint(() => ({ status: 502, text: "Bad Gateway" }));
    try {
      const response = await postToEndpoint(testConfig({ url: stub.url }), body);
      assert.equal(response.body, null);
      assert.equal(response.text, "Bad Gateway");
    } finally {
      await stub.close();
    }
  });

  it("raises EndpointError when nothing is listening", async () => {
    const stub = await startStubEndpoint(() => ({ status: 200 }));
    const url = stub.url;
    await stub.close();
    await assert.rejects(
      () => postToEndpoint(testConfig({ url, timeoutMs: 2_000 }), body),
      (error: unknown) => {
        assert.ok(error instanceof EndpointError);
        assert.match(error.message, /failed/);
        return true;
      },
    );
  });
});
