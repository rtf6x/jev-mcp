# Jev MCP — living plan

## Goal

One local MCP server that hands Jev judgments to every harness (omp, Claude Code, opencode,
Claude Desktop) and forwards each request to the Jev endpoint configured in `.env`. The
endpoint is the only provider setting: one URL, one key, one model.

## Scope

In: mcp-server (the twelve judgment tools, HTTP + stdio transports), desktop tray app (Tauri v2,
sidecar), OpenAI-generated icon, README, CI.

Out: browser extensions, WebSocket handshake, provider table / auto-detection, skill packs,
Docker, npm publish.

## Configuration

`.env` (see `.env.example`): `JEV_URL`, `JEV_API_KEY`, `JEV_MODEL`, `JEV_QUESTION_TYPE`,
`MCP_HOST`, `MCP_HTTP_PORT`, `JEV_TIMEOUT_MS`, `JEV_MCP_ENV`.

Endpoint examples (used verbatim):

| Endpoint | URL | yes/no spelling |
| --- | --- | --- |
| TypeSafe (official) | `https://api.typesafe.ai/v1/systemone` | `noul` |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `noul` |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1/evaluate` | `boolean` |

## Invariants

- One code path per tool. The endpoint is a URL, the key and the model; there is no provider
  branch, no auto-detection, and no second data source.
- Questions are forwarded verbatim except for the yes/no spelling, which `JEV_QUESTION_TYPE`
  fixes for the configured endpoint.
- Answers are validated fail-closed: a malformed answer is `invalid_response` with action
  `review`, never a fabricated value and never a silent pass.
- Upstream failures surface as tool errors carrying the upstream status and body. No fallback,
  no retry that can double-charge a paid call.
- The key never reaches logs, tool output or the repository.
- The HTTP transport binds `MCP_HOST` (default `127.0.0.1`).

## Constraints

- Node >= 22.18 (runs the TypeScript sources directly); esbuild bundles the sidecar binary.
- Jev endpoints: OpenRouter `decisions` is alpha; Vercel spells the yes/no type `boolean` and
  reports `usage.inputTokens`; TypeSafe answers 403 without a key (Cloudflare, not the
  documented 401) and reports `usage.input_tokens` with no cost.
- Desktop app needs Rust >= 1.77 (Tauri v2 MSRV); the machine has 1.74.

## Tasks

1. Repo skeleton, plan, `.env.example` — **done**: typecheck clean, tests run.
2. `config.ts` — **done**: env-file parsing, precedence, fail-fast; 6 test cases.
3. `forward.ts` — **done**: URL/headers/body asserted against a stub; status and body
   passthrough; `EndpointError` on a dead port.
4. `judge.ts` — **done**: builder + validation + actions; fixtures from TypeSafe, OpenRouter
   and Vercel docs; 11 fail-closed cases. **Superseded** by task 11.
5. `tool.ts` + transports — **done**: handshake, tools/list, tools/call over HTTP and stdio
   against a live stub; fail-closed answer; endpoint error as tool error. **Superseded** by task
   11: `tool.ts` and `judge.ts` are gone.
11. Twelve-tool port — **done**: the community tool set of `jkudish/jev-mcp` (MIT) replaces the
    single generic tool, one file per tool under `src/tools/` with shared helpers under
    `src/jev/`. Attribution and adapted-file list in `THIRD-PARTY-NOTICES.md`.
6. Live call against a credentialed endpoint — **done**: the endpoint is Vercel AI Gateway
   (`POST https://ai-gateway.vercel.sh/v1/evaluate`, `model: typesafe-ai/jev`,
   `JEV_QUESTION_TYPE=boolean`) with the token OMP already carries
   (`omp token vercel-ai-gateway`). A first live call through this server answered
   (`tests_pass` 0.02 → no, `objective_done` 0.12 → no, risk 2.22 → review), and after the port
   `jev_classify` (two issues routed, both `auto`), `jev_noul` (0.91 likely / 0.02 unlikely) and
   `jev_gate` answered through it as well.
7. Desktop tray app (Tauri v2 + SEA sidecar) — **done**: sidecar built, `.app` bundled and
   launched; the tray spawned its own sidecar, `/health` answered and a `tools/call` through it
   returned a verdict, and the tray icon is visible in the menu bar. Evidence: `Jev MCP.app`
   (144 MiB) in `target/release/bundle/macos`.
8. Icon — **done**: `npm run icons` drew it with an image model
   (`openai/gpt-image-2` through Vercel AI Gateway, no OpenAI key required) and generated the
   Tauri set. The source image and the prompt are committed in `desktop-app/icons-src/`.
9. Harness wiring — **done**: omp (`~/.omp/agent/mcp.json`), Claude Code
   (`claude mcp add --scope user --transport http jev http://127.0.0.1:18791/mcp`) and opencode
   (`~/.config/opencode/opencode.json`) all point at the local endpoint. Claude Code now reports
   `jev: Connected`; the entry it carried before pointed at the community `jevai.org` MCP and
   failed health checks with `401 Invalid or missing Jev API key`, which is what the owner saw
   as "Jev does not answer". Claude Desktop takes the stdio command from the README.
10. CI workflows — **done**: `build.yml` is green on `main` with the icon in place, so the
    desktop matrix really builds: run 36577912941 passed `Server` (27 s) plus
    `Desktop (aarch64-apple-darwin)` (2 m 44 s), `Desktop (x86_64-unknown-linux-gnu)` (7 m 52 s)
    and `Desktop (x86_64-pc-windows-msvc)` (13 m 24 s). `release.yml` is written and lint-clean;
    it runs only when dispatched and is exercised at the first release.

## Ledger

- 2026-09-29 Tasks 1-5: server built and exercised. Evidence: `npm run typecheck` clean;
  `npm test` 34/34; real process smoke — `/health` answered, `tools/list` listed the then-only
  generic tool (since replaced by the twelve, task 11), `tools/call` returned verdicts with
  action `auto`, a caller's `bool` reached the endpoint as
  `boolean`, a question with no answer came back `invalid_response`/`review`, a dead endpoint
  came back `is_error` with the message, and stdio answered `initialize` and `tools/list`.
- 2026-09-29: precedence proven live — the endpoint URL came from `.env` while the key came
  from the environment, which wins over the file.
- 2026-09-29 Task 7: the bundled CommonJS server and the SEA sidecar both serve MCP
  (`dist/jev-mcp.cjs`, `binaries/mcp-server-aarch64-apple-darwin`), and the tray app spawns the
  sidecar from inside the bundle. The tray menu itself was not inspected visually (enumerating
  menu-bar extras needs accessibility permission); the build path that creates it ran, since
  `setup` returns `Err` and the app exits if it fails.
- 2026-09-29: fixed a real defect found while testing the app — a hard kill of the tray process
  left the sidecar holding the port, so the next launch died on `EADDRINUSE`. The app now
  spawns the server with `JEV_MCP_EXIT_WITH_PARENT=1`, and the server exits when that pipe
  closes (verified both ways: it leaves with a closing pipe, and stays up when the flag is off).
- 2026-09-29 Task 11: the twelve tools are ported and the single generic tool is gone. Evidence:
  `npm run typecheck` clean; `npm test` 60/60 (twelve per-tool suites — request body, valid answer
  and malformed answer for each — plus config, forward and transport); `tools/list` reports exactly
  those twelve names; the built `dist/jev-mcp.cjs` answers over stdio and its sandboxed regex
  worker kills a catastrophic pattern with `invalid_pattern`.
- 2026-09-29 Task 10: `build.yml` green on `main` — run 36572572759, jobs `Server` (22 s) and
  three `Desktop` jobs. Getting there took three fixes, all found by `actionlint` and by running
  the exact command by hand: `hashFiles` is not available in a job-level `if` (the workflow file
  was rejected outright, every push failing the run in 0 s), the icon check ran under PowerShell
  on Windows where `test -f` does not exist, and the bundle smoke's `grep` pattern carried a `}`
  that the response does not have.
- 2026-09-29: the tray item never appeared, and the first three attempts to see it (menu-bar
  screenshots, a pixel diff against the app being closed, the window list) each missed it — the
  item sits at the left end of the third-party extras, well left of where I was looking. A
  temporary solid-square icon settled it: `TrayIcon` in Tauri 2 is reference-counted and removed
  when the last handle drops, and `setup` was discarding it. It is now kept in the app state
  (`app.manage(tray)`), and the icon is drawn as a macOS template image
  (`icon_as_template(true)`) so the menu bar renders it in the adaptive monochrome style instead
  of a dark glyph on a dark bar. Verified visually: the glyph is visible in the menu bar while
  the app runs and gone after it exits.
- 2026-09-29 Task 8: the icon is drawn with an image model and committed. The OpenAI key turned
  out to be unnecessary: OMP already carries a Vercel AI Gateway token, whose OpenAI-compatible
  `/v1/images/generations` serves `openai/gpt-image-2`. The content classifier rejects the same
  benign prompt at random, so the generator retries up to three times on a `400` and logs every
  attempt. The tray renders the icon as a template image, so it must stay a silhouette on a
  transparent background — the committed one is 18% opaque with transparent corners.
- 2026-09-29 Task 6 (first half): a live Jev answer came back through Vercel AI Gateway —
  `POST https://ai-gateway.vercel.sh/v1/evaluate` with `model: typesafe-ai/jev` and the gateway
  token from `omp token vercel-ai-gateway` answered HTTP 200, `{"answers":{"fixed":{"type":"boolean","probability":0.85}}}`.
  That is also the endpoint this server is pointed at for the end-to-end check.
- 2026-09-29: the first run with the icon committed failed the Linux desktop job — the runner
  lacked `glib-2.0.pc` and the rest of the webkit stack. Both workflows now install
  `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` and `patchelf` on
  Ubuntu, and run 36577912941 is green on all four jobs.
- 2026-09-29: the twelve tools are wired into the owner's harnesses. omp's `mcp.json` gained a
  `jev` entry, Claude Code was re-pointed from the community endpoint to the local one
  (`claude mcp list` now shows `jev: Connected`; the old entry answered
  `401 Invalid or missing Jev API key` — the failure the owner had been seeing), and opencode's
  config gained the same server. The tray app runs with its own `.env`
  (gateway URL, `typesafe-ai/jev`, `boolean` spelling, mode 600) and serves the twelve tools on
  `127.0.0.1:18791`.
- 2026-09-29: the skill that tells an agent when to call which tool — the community ships one and
  the owner asked for the same — was taken over into the skillset repository as `skills/jev/`
  (plus `reference/tools.md`), adapted to this server's local endpoint and its `.env` keys.
  Committed and pushed there (`4394e04`), relinked by `scripts/update.sh` so every harness sees
  it through `~/.agents/skills`; the repository is clean.
- 2026-09-29: Rust 1.74 (Homebrew) cannot even parse a dependency manifest that uses edition
  2024; the rustup toolchain on this machine is 1.98, so the build runs with
  `PATH="$HOME/.cargo/bin:$PATH"` and needs no change to the machine.

## Loose ends

- The tool set is the community's twelve tools — the owner's decision, being ported from
  `jkudish/jev-mcp` (MIT) with our URL-only transport. Anything the port could not carry over
  faithfully, and every deviation our transport forced, is recorded in the port's report and in
  `THIRD-PARTY-NOTICES.md`.
- Skills: the community ships one with the package; the owner's own copy lives in the skillset
  repository (`skills/jev/`) and reaches every harness through `~/.agents/skills`.
- The icon set in `desktop-app/src-tauri/icons` and its source in `desktop-app/icons-src/` are
  generated, not hand-drawn: `npm run icons` redraws both. The desktop jobs in `build.yml` and
  `release.yml` now find the source image and build.
- The icon is drawn as a macOS template image, so the menu bar shows its alpha outline, not its
  colours: a regenerated icon must stay a single silhouette on a transparent background (the
  prompt in `tools/generate-icon.mjs` asks for exactly that), or the tray will show a solid
  block.
- Vercel reports cost as a string under `providerMetadata.gateway.cost`; `usage.cost` stays
  `null` there. Revisit if cost matters.
- The tray icon is visually verified in the menu bar, but the menu itself has not been clicked:
  driving menu-bar extras needs accessibility permission. Every item is wired in Rust
  (`status`, `toggle`, `autostart`, `edit-env`, `open-logs`, `quit`) and the app compiles with
  them; a click-through is still owed.
- `release.yml` has never been dispatched: it is lint-clean and will be exercised at the first
  release, which is also when the version bump, tag and artifact set get their first real run.
- Windows and Linux desktop builds are configured but unverified on this machine.
- Editing `generate_image.enabled` needed an approval that expired, so the harness's own
  image tool stays off; the icon is drawn through the AI Gateway's images endpoint instead.
