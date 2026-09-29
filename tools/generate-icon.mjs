#!/usr/bin/env node
// Draw the app icon with an image model and turn it into the icon set Tauri bundles.
//
// Usage:
//   IMAGE_API_KEY=... node tools/generate-icon.mjs
//   IMAGE_API_KEY="$(omp token vercel-ai-gateway)" node tools/generate-icon.mjs   # Vercel AI Gateway
//   IMAGE_API_KEY=sk-... IMAGE_API_BASE_URL=https://api.openai.com/v1 node tools/generate-icon.mjs
//
// The endpoint is OpenAI-compatible `/images/generations`; the model defaults to an image-only
// model on Vercel AI Gateway. The result is committed to desktop-app/icons-src/ together with
// the prompt that produced it, so the icon can be reproduced or redrawn deliberately.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(repo, "desktop-app", "icons-src");
const sourcePath = join(sourceDir, "icon.png");

const baseUrl = (process.env.IMAGE_API_BASE_URL ?? "https://ai-gateway.vercel.sh/v1").replace(/\/$/, "");
const model = process.env.IMAGE_MODEL ?? "openai/gpt-image-2";
const apiKey = process.env.IMAGE_API_KEY ?? process.env.AI_GATEWAY_API_KEY ?? "";

const PROMPT = [
  "App icon for a developer tool that judges decisions, called Jev MCP.",
  "One bold centered glyph: a balance scale whose beam is a decision fork — two straight arms",
  "meeting at a single solid dot, each arm ending in a short square terminal.",
  "Flat vector, geometric, even stroke weight, a solid dark silhouette on a fully transparent",
  "background (macOS renders it as a monochrome template image in the menu bar, so the shape has",
  "to read from its outline alone), generous margin, no text, no letters, no numbers, no",
  "gradients, no shadow, no 3D, no photographic elements.",
  "It must stay legible at 16 by 16 pixels.",
].join(" ");

if (apiKey === "") {
  console.error("IMAGE_API_KEY is not set. For Vercel AI Gateway: IMAGE_API_KEY=\"$(omp token vercel-ai-gateway)\"");
  process.exit(1);
}

console.log(`[icon] asking ${model} at ${baseUrl}…`);
const ATTEMPTS = 3;
let base64 = "";
for (let attempt = 1; attempt <= ATTEMPTS && base64 === ""; attempt += 1) {
  const response = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt: PROMPT, size: "1024x1024", background: "transparent", n: 1 }),
  });
  const payload = await response.json();
  const image = payload?.data?.[0]?.b64_json;
  if (response.ok && typeof image === "string") {
    base64 = image;
    break;
  }
  // The content classifier rejects a benign prompt at random; a fresh attempt usually passes.
  const message = JSON.stringify(payload).slice(0, 300);
  console.error(`[icon] attempt ${attempt}/${ATTEMPTS} failed: HTTP ${response.status} ${message}`);
  if (response.status !== 400) break;
}

if (base64 === "") {
  console.error("[icon] no image after every attempt; nothing written");
  process.exit(1);
}

mkdirSync(sourceDir, { recursive: true });
writeFileSync(sourcePath, Buffer.from(base64, "base64"));
writeFileSync(join(sourceDir, "prompt.txt"), `model: ${model}\n\n${PROMPT}\n`);
console.log(`[icon] wrote ${sourcePath}`);

console.log("[icon] generating the Tauri icon set…");
execFileSync("npx", ["--yes", "@tauri-apps/cli", "icon", sourcePath], {
  cwd: join(repo, "desktop-app"),
  stdio: "inherit",
  shell: process.platform === "win32",
});
console.log("[icon] done: desktop-app/src-tauri/icons");
