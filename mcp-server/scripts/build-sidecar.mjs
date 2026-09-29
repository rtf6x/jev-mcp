#!/usr/bin/env node
// Build the tray app's sidecar: a single native executable carrying the server, so end users
// need no Node.js installed. Node's SEA support embeds the bundle in a copy of the node binary.
//
// Usage: node scripts/build-sidecar.mjs <rust-target-triple> [output-dir]
// Example: node scripts/build-sidecar.mjs aarch64-apple-darwin
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundle, serverDir } from "./build.mjs";

const [targetTriple, outDirArg = "../desktop-app/src-tauri/binaries"] = process.argv.slice(2);
if (!targetTriple) {
  console.error("Usage: node scripts/build-sidecar.mjs <rust-target-triple> [output-dir]");
  process.exit(1);
}

const outDir = join(serverDir, outDirArg);
mkdirSync(outDir, { recursive: true });

const buildDir = join(serverDir, ".sidecar-build");
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

console.log("[sidecar] bundling the server...");
const bundlePath = await bundle();

const blobPath = join(buildDir, "sea-prep.blob");
const seaConfigPath = join(buildDir, "sea-config.json");
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    { main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false },
    null,
    2,
  ),
);

console.log("[sidecar] generating the SEA blob...");
execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], { cwd: buildDir, stdio: "inherit" });

const isWindows = targetTriple.includes("windows");
const outExePath = join(outDir, `mcp-server-${targetTriple}${isWindows ? ".exe" : ""}`);

console.log(`[sidecar] copying the node binary to ${outExePath}...`);
copyFileSync(process.execPath, outExePath);

if (process.platform === "darwin") {
  execFileSync("codesign", ["--remove-signature", outExePath], { stdio: "inherit" });
} else if (isWindows) {
  try {
    execFileSync("signtool", ["remove", "/s", outExePath], { stdio: "ignore" });
  } catch {
    // Nothing to strip when the binary carries no signature.
  }
}

console.log("[sidecar] injecting the blob...");
const postjectArgs = [
  "postject",
  outExePath,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (process.platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA");
execFileSync("npx", postjectArgs, { cwd: serverDir, stdio: "inherit", shell: process.platform === "win32" });

if (process.platform === "darwin") {
  execFileSync("codesign", ["--sign", "-", outExePath], { stdio: "inherit" });
}

rmSync(buildDir, { recursive: true, force: true });
console.log(`[sidecar] built ${outExePath}`);
