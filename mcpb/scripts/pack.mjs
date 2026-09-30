/**
 * Validates the built payload with the official MCPB CLI and packs it into
 * `jev-mcp-desktop-<version>.mcpb` at the repository root, next to the desktop installers.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..");
const distDir = resolve(packageRoot, "dist");

// npm workspaces hoist the binary to the repository root; a nested install keeps it here.
const cli = [
  resolve(packageRoot, "node_modules/.bin/mcpb"),
  resolve(repoRoot, "node_modules/.bin/mcpb"),
].find((candidate) => existsSync(candidate));
if (cli === undefined) {
  throw new Error("mcpb CLI not installed — run `npm install` at the repository root");
}

const { version } = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
const target = resolve(repoRoot, `jev-mcp-desktop-${version}.mcpb`);

const { stdout } = await run(cli, ["validate", distDir]);
process.stdout.write(stdout);

await run(cli, ["pack", distDir, target], { maxBuffer: 16 * 1024 * 1024 });
console.log(`mcpb: packed ${target}`);
