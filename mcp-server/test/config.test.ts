import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfigError, loadConfig, parseEnvFile } from "../src/config.ts";

function writeEnv(contents: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "jev-mcp-config-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents);
  return { dir, path };
}

describe("parseEnvFile", () => {
  it("reads plain, quoted and export-prefixed lines and skips comments", () => {
    const values = parseEnvFile(
      ["# comment", "", "JEV_URL=https://api.typesafe.ai/v1/systemone", 'JEV_API_KEY="ts_quoted"', "export JEV_MODEL='jev-latest'", "broken line"].join(
        "\n",
      ),
    );
    assert.deepEqual(values, {
      JEV_URL: "https://api.typesafe.ai/v1/systemone",
      JEV_API_KEY: "ts_quoted",
      JEV_MODEL: "jev-latest",
    });
  });
});

describe("loadConfig", () => {
  const base = ["JEV_URL=https://api.typesafe.ai/v1/systemone", "JEV_API_KEY=ts_test"].join("\n");

  it("applies defaults for optional settings", () => {
    const { dir } = writeEnv(base);
    const config = loadConfig({}, dir);
    assert.equal(config.model, "jev-latest");
    assert.equal(config.questionType, "noul");
    assert.equal(config.httpHost, "127.0.0.1");
    assert.equal(config.httpPort, 18791);
    assert.equal(config.timeoutMs, 60_000);
  });

  it("lets the environment override the file", () => {
    const { dir } = writeEnv([base, "JEV_MODEL=from-file"].join("\n"));
    assert.equal(loadConfig({ JEV_MODEL: "from-env" }, dir).model, "from-env");
    assert.equal(loadConfig({}, dir).model, "from-file");
  });

  it("honours JEV_MCP_ENV as the file path", () => {
    const { dir, path } = writeEnv(base);
    const config = loadConfig({ JEV_MCP_ENV: path }, dir);
    assert.equal(config.apiKey, "ts_test");
    assert.equal(config.envPath, path);
  });

  it("fails when the endpoint or the key is missing", () => {
    const { dir } = writeEnv("JEV_API_KEY=ts_test");
    assert.throws(() => loadConfig({}, dir), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /JEV_URL is not set/);
      return true;
    });
    const other = writeEnv("JEV_URL=https://api.typesafe.ai/v1/systemone");
    assert.throws(() => loadConfig({}, other.dir), /JEV_API_KEY is not set/);
  });

  it("rejects a relative or non-http endpoint and a bad question type", () => {
    assert.throws(() => loadConfig({ JEV_URL: "/v1/systemone", JEV_API_KEY: "k" }, "/nonexistent"), /absolute URL/);
    assert.throws(() => loadConfig({ JEV_URL: "ftp://example.com", JEV_API_KEY: "k" }, "/nonexistent"), /http or https/);
    assert.throws(
      () => loadConfig({ JEV_URL: "https://example.com", JEV_API_KEY: "k", JEV_QUESTION_TYPE: "yesno" }, "/nonexistent"),
      /JEV_QUESTION_TYPE must be/,
    );
  });

  it("rejects malformed numbers", () => {
    assert.throws(
      () => loadConfig({ JEV_URL: "https://example.com", JEV_API_KEY: "k", MCP_HTTP_PORT: "0" }, "/nonexistent"),
      /MCP_HTTP_PORT must be an integer in 1\.\.65535/,
    );
  });
});
