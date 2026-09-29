#!/usr/bin/env node
import { ConfigError, loadConfig } from "./config.ts";
import { startHttpServer } from "./server.ts";
import { serveStdio } from "./stdio.ts";

const mode = process.argv.includes("--stdio") ? "stdio" : "http";

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`jev-mcp: ${error.message}`);
    console.error("jev-mcp: copy .env.example to .env, then set JEV_URL and JEV_API_KEY.");
    process.exit(1);
  }
  throw error;
}

if (mode === "stdio") {
  await serveStdio(config, (message) => console.error(message));
} else {
  await startHttpServer(config, (message) => console.log(message));
}
