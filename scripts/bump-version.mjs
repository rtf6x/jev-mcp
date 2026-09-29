#!/usr/bin/env node
// Set the version everywhere it is carried: the three package manifests, the server's
// VERSION constant and the Tauri config. Run by the release workflow, and usable by hand.
//
// Usage: node scripts/bump-version.mjs 1.2.3   (or with no argument: bump the patch)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const current = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
const [argument] = process.argv.slice(2);
const next =
  argument ??
  (() => {
    const [major, minor, patch] = current.split(".").map(Number);
    return `${major}.${minor}.${(patch ?? 0) + 1}`;
  })();

if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`usage: node scripts/bump-version.mjs <major.minor.patch> (current ${current})`);
  process.exit(1);
}

const targets = [
  { path: "package.json", pattern: /"version":\s*"[^"]+"/, replacement: `"version": "${next}"` },
  { path: "mcp-server/package.json", pattern: /"version":\s*"[^"]+"/, replacement: `"version": "${next}"` },
  {
    path: "mcp-server/src/version.ts",
    pattern: /export const VERSION = "[^"]+"/,
    replacement: `export const VERSION = "${next}"`,
  },
  { path: "desktop-app/package.json", pattern: /"version":\s*"[^"]+"/, replacement: `"version": "${next}"` },
  {
    path: "desktop-app/src-tauri/Cargo.toml",
    pattern: /^version = "[^"]+"$/m,
    replacement: `version = "${next}"`,
  },
  {
    path: "desktop-app/src-tauri/tauri.conf.json",
    pattern: /"version":\s*"[^"]+"/,
    replacement: `"version": "${next}"`,
  },
];

for (const target of targets) {
  const path = join(repo, target.path);
  const before = readFileSync(path, "utf8");
  if (!target.pattern.test(before)) {
    console.error(`[bump] ${target.path}: no version to replace, refusing to continue`);
    process.exit(1);
  }
  writeFileSync(path, before.replace(target.pattern, target.replacement));
  console.log(`[bump] ${target.path}`);
}

console.log(`${current} → ${next}`);
