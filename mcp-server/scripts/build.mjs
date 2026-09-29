#!/usr/bin/env node
// Bundle the server into one self-contained file: `dist/jev-mcp.cjs` (CommonJS, so the SEA
// sidecar can carry it). The bundle is what npm ships and what the tray app spawns.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const serverDir = dirname(dirname(fileURLToPath(import.meta.url)));

export async function bundle() {
  const outfile = join(serverDir, "dist", "jev-mcp.cjs");
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [join(serverDir, "src", "index.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    banner: { js: "#!/usr/bin/env node" },
    logLevel: "info",
  });
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await bundle();
