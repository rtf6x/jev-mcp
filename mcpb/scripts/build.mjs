/**
 * Builds the MCPB payload in `dist/`: the stdio bridge bundled into a single file, plus a manifest
 * stamped with the repository version (the single source of truth — `mcpb/package.json`
 * deliberately carries a placeholder version).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..");
const outDir = resolve(packageRoot, "dist");

const { version } = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));

await rm(outDir, { recursive: true, force: true });
await mkdir(resolve(outDir, "server"), { recursive: true });

await build({
  entryPoints: [resolve(packageRoot, "server/bridge.ts")],
  outfile: resolve(outDir, "server/index.mjs"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  define: { __JEV_MCP_VERSION__: JSON.stringify(version) },
});

const manifest = JSON.parse(await readFile(resolve(packageRoot, "manifest.json"), "utf8"));
manifest.version = version;
await writeFile(resolve(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`mcpb: built dist/server/index.mjs and dist/manifest.json for v${version}`);
