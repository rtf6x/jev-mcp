#!/usr/bin/env node
// Draw the app icon with OpenAI's image model and turn it into the icon set Tauri bundles.
//
// Usage: OPENAI_API_KEY=sk-... node tools/generate-icon.mjs
//
// The generated source image is committed to desktop-app/icons-src/ together with the prompt
// that produced it, so the icon can be reproduced or redrawn deliberately.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(repo, "desktop-app", "icons-src");
const sourcePath = join(sourceDir, "icon.png");
const desktopDir = join(repo, "desktop-app");

const PROMPT = [
  "App icon for a developer tool that judges decisions, called Jev MCP.",
  "One bold centered glyph: a balance scale whose beam is a decision fork — two straight arms",
  "meeting at a single solid dot, each arm ending in a short square terminal.",
  "Flat vector, geometric, even 2-pixel-weight strokes, a solid silhouette on a fully",
  "transparent background (macOS renders it as a monochrome template image in the menu bar, so",
  "the shape has to read from its outline alone), generous margin, no text, no letters, no",
  "numbers, no gradients, no shadow, no 3D, no photographic elements.",
  "It must stay legible at 16 by 16 pixels.",
].join(" ");

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY is not set; the icon is drawn with OpenAI's image model.");
  process.exit(1);
}

console.log("[icon] asking the image model…");
const response = await fetch("https://api.openai.com/v1/images/generations", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    model: "gpt-image-1",
    prompt: PROMPT,
    size: "1024x1024",
    quality: "high",
    background: "transparent",
    output_format: "png",
    n: 1,
  }),
});

const payload = await response.json();
if (!response.ok) {
  console.error(`[icon] the image model refused: HTTP ${response.status} ${JSON.stringify(payload)}`);
  process.exit(1);
}

const base64 = payload?.data?.[0]?.b64_json;
if (typeof base64 !== "string") {
  console.error(`[icon] no image in the response: ${JSON.stringify(payload).slice(0, 500)}`);
  process.exit(1);
}

mkdirSync(sourceDir, { recursive: true });
writeFileSync(sourcePath, Buffer.from(base64, "base64"));
writeFileSync(join(sourceDir, "prompt.txt"), `${PROMPT}\n`);
console.log(`[icon] wrote ${sourcePath}`);

console.log("[icon] generating the Tauri icon set…");
execFileSync("npx", ["--yes", "@tauri-apps/cli", "icon", sourcePath], {
  cwd: desktopDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});
console.log("[icon] done: desktop-app/src-tauri/icons");
