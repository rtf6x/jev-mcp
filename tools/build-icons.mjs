#!/usr/bin/env node
// Build the icon set Tauri bundles from `desktop-app/icons-src/icon-source.png`, and the
// menu-bar template glyph from `desktop-app/icons-src/tray.svg`.
//
//   npm run icons
//
// The app icon is the delivered art placed inside the macOS squircle: the tile is the art's own
// background, the mark is centred and scaled to the icon grid's inner square, and everything
// outside the squircle is transparent. `tauri icon` then turns that one 1024 tile into the
// `.icns` / `.ico` / PNG set in `desktop-app/src-tauri/icons/`.
//
// The tray glyph is a separate, monochrome drawing. macOS repaints a template image from its
// alpha, so a colour icon cannot serve as the menu-bar glyph, and `tray-icon` draws whatever it
// is given at 18 pt tall — the PNG is rendered at 36×36 for a 1:1 pixel map on a Retina display.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(repo, "desktop-app", "icons-src");
const artPath = join(sourceDir, "icon-source.png");
const tilePath = join(sourceDir, "icon.png");
const traySvgPath = join(sourceDir, "tray.svg");
const trayPngPath = join(repo, "desktop-app", "src-tauri", "icons", "tray-template.png");

const TILE = 1024;
/** The icon grid: the mark occupies the inner square, the rest is the tile's own background. */
const MARK_RATIO = 0.78;
/** Superellipse exponent for the macOS icon shape (~r 230/1024 at the corners). */
const SQUIRCLE_N = 3.4;
const SUPERSAMPLE = 4;
/** Alpha above which a source pixel counts as part of the mark. */
const MARK_ALPHA = 8;

/** Coverage of the macOS squircle inside each pixel, sampled `SUPERSAMPLE²` times per pixel. */
function squircleCoverage(x, y) {
  let hits = 0;
  for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
    for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
      const nx = ((x + (sx + 0.5) / SUPERSAMPLE) / TILE) * 2 - 1;
      const ny = ((y + (sy + 0.5) / SUPERSAMPLE) / TILE) * 2 - 1;
      if (Math.abs(nx) ** SQUIRCLE_N + Math.abs(ny) ** SQUIRCLE_N <= 1) hits += 1;
    }
  }
  return hits / (SUPERSAMPLE * SUPERSAMPLE);
}

/** The mark's box in the art, plus the colour the art sits on (read from its corners). */
function inspectArt({ data, info }) {
  const { width, height, channels } = info;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * channels + 3] > MARK_ALPHA) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) throw new Error(`${artPath} has no opaque pixels`);

  // The tile continues whatever the art's own background is: averaging every near-transparent
  // pixel instead would pick up the colours hiding under the glow and tint the whole tile.
  const patch = Math.max(8, Math.round(Math.min(width, height) * 0.02));
  const sums = { r: 0, g: 0, b: 0 };
  let samples = 0;
  for (const [ox, oy] of [
    [0, 0],
    [width - patch, 0],
    [0, height - patch],
    [width - patch, height - patch],
  ]) {
    for (let y = oy; y < oy + patch; y += 1) {
      for (let x = ox; x < ox + patch; x += 1) {
        const i = (y * width + x) * channels;
        if (data[i + 3] > 2) continue;
        sums.r += data[i];
        sums.g += data[i + 1];
        sums.b += data[i + 2];
        samples += 1;
      }
    }
  }
  if (samples === 0) throw new Error(`${artPath} has no transparent corners to read a background from`);
  return {
    box: { left, top, width: right - left + 1, height: bottom - top + 1 },
    background: {
      r: Math.round(sums.r / samples),
      g: Math.round(sums.g / samples),
      b: Math.round(sums.b / samples),
      alpha: 1,
    },
  };
}

async function buildAppIcon() {
  const art = await sharp(artPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { box, background } = inspectArt(art);
  const scale = (TILE * MARK_RATIO) / Math.max(box.width, box.height);
  const markWidth = Math.round(box.width * scale);
  const markHeight = Math.round(box.height * scale);

  const mark = await sharp(artPath)
    .ensureAlpha()
    .extract(box)
    .resize(markWidth, markHeight, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();

  const mask = Buffer.alloc(TILE * TILE * 4);
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      const i = (y * TILE + x) * 4;
      mask[i + 3] = Math.round(squircleCoverage(x, y) * 255);
    }
  }

  await sharp({ create: { width: TILE, height: TILE, channels: 4, background } })
    .composite([
      { input: mark, left: Math.round((TILE - markWidth) / 2), top: Math.round((TILE - markHeight) / 2) },
      { input: mask, raw: { width: TILE, height: TILE, channels: 4 }, blend: "dest-in" },
    ])
    .png()
    .toFile(tilePath);

  console.log(
    `[icons] ${artPath.split("/").pop()}: mark ${box.width}×${box.height} at ${box.left},${box.top}` +
      ` → tile ${TILE}×${TILE}, mark ${markWidth}×${markHeight}, background rgb(${background.r},${background.g},${background.b})`,
  );
  console.log(`[icons] wrote ${tilePath}`);
}

async function buildTrayGlyph() {
  const svg = readFileSync(traySvgPath);
  const png = await sharp(svg, { density: 576 })
    .resize(36, 36, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
  writeFileSync(trayPngPath, png);
  console.log(`[icons] wrote ${trayPngPath} (36×36, drawn at 18 pt as a template image)`);
}

await buildAppIcon();
await buildTrayGlyph();

console.log("[icons] generating the Tauri icon set…");
execFileSync("npx", ["--yes", "@tauri-apps/cli", "icon", tilePath], {
  cwd: join(repo, "desktop-app"),
  stdio: "inherit",
  shell: process.platform === "win32",
});
console.log("[icons] done: desktop-app/src-tauri/icons");
