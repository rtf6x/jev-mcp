# Icon sources

Two icons, drawn differently, because macOS asks for two different things.

| Source | Becomes | Used as |
| --- | --- | --- |
| `icon-source.svg` (or `.png`) | `icon.png` (1024×1024 tile) → the whole set via `tauri icon` | The app icon: Finder, the `.dmg`, the installer |
| `tray.svg` | `../src-tauri/icons/tray-template.png` (36×36) | The menu-bar glyph, embedded with `include_image!` |

Run `npm run icons` after changing either. It prepares the tile, renders the glyph and rebuilds
`../src-tauri/icons/` — before a release, not on every build.

## The app icon

`icon-source.svg` is the art the owner delivered (2026-09-29): a decision diamond branching into
a green check and a red cross, flat fills on a transparent background, 1536×1024. He also
delivered the neon-on-black raster it was traced from; the vector won because the glow does not
survive 32 pixels and the trace does. The pipeline
resolves `icon-source.svg` first and falls back to `icon-source.png`, so either form of the art
works; an SVG is rasterised at 2× its own size (`ART_DENSITY`) and then scaled down, which keeps
the tile crisp. `npm run icons` turns it into the tile macOS expects, so the art itself needs no
preparation:

- the mark (everything above alpha 8) is centred and scaled to 78% of the tile;
- the tile continues the art's own background, read from the four corners — averaging every
  near-transparent pixel instead picks up the colours hiding under a glow and tints the tile;
- the macOS squircle is applied as an alpha mask (superellipse, exponent 3.4, 4×4 supersampled),
  and everything outside it is transparent. macOS does not round an app icon for you.

`npm run icons:draw` asks an image model for a new art instead of using one you have: it needs
`IMAGE_API_KEY` (Vercel AI Gateway, or any OpenAI-compatible `/images/generations` endpoint) and
writes `icon-source.png` and `prompt.txt` before running the same pipeline.

## The menu-bar glyph

`tray.svg` is drawn by hand and is one shape on purpose. macOS paints a template image from its
alpha alone and recolours it for a light, dark and highlighted bar, so the glyph cannot carry
colour; and at 18 pt the app icon's arrows and verdict boxes merge into a single illegible blob
that reads as an "M" rather than a decision. The diamond alone still reads as the decision node —
it is the same mark the app icon is built around.

`tray-icon` draws whatever it is handed at 18 pt tall and derives the width from the aspect
ratio, so the PNG is rendered at 36×36: a 1:1 pixel map on a Retina display, and a square glyph
stays square whatever the bar's scale.
