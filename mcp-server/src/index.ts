import { ConfigError, loadConfig } from "./config.ts";
import { startHttpServer } from "./server.ts";
import { serveStdio } from "./stdio.ts";

async function main(): Promise<void> {
  const mode = process.argv.includes("--stdio") ? "stdio" : "http";

  // The tray app pipes our stdin and sets this flag. When the app goes away the pipe closes,
  // and the server leaves with it instead of holding the port as an orphan that makes the next
  // launch fail on EADDRINUSE. Off by default: a host started under launchd or systemd has no
  // parent pipe at all and must keep running.
  if (process.env["JEV_MCP_EXIT_WITH_PARENT"] === "1") {
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
    process.stdin.on("error", () => process.exit(0));
  }

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
    return;
  }
  await startHttpServer(config, (message) => console.log(message));
}

// No top-level await: the sidecar bundle is CommonJS.
main().catch((error: unknown) => {
  console.error(`jev-mcp: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
