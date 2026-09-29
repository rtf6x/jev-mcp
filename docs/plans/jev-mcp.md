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
8. Icon — **done**, and now the owner's art: `npm run icons` prepares the app icon from
   `desktop-app/icons-src/icon-source.svg` (his delivery; `.png` is accepted too) and renders the
   menu-bar glyph from `desktop-app/icons-src/tray.svg`. `npm run icons:draw` is the image-model
   path that draws a new art (`openai/gpt-image-2` through Vercel AI Gateway, no OpenAI key
   required). Sources and the rules behind each are in `desktop-app/icons-src/README.md`.
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
- 2026-09-30: the first signed run got as far as Apple would let it. `v0.1.2`'s macOS job signed
  the app, its main binary and the zipped bundle with the team's Developer ID and then **failed
  notarization with `HTTP status code: 401. Invalid credentials`** — Apple rejects the
  `APPLE_ID` + `APPLE_PASSWORD` pair that was configured, so nothing is wrong with the certificate
  or the workflow. The run published nothing, and its `v0.1.2` tag exists without a release; the
  next dispatch bumps to `0.1.3` (a rerun of the same run would fail at `git tag`, which already
  exists). Once the credentials are valid the tag can be deleted, and the check that settles which
  half is wrong is `xcrun notarytool history --apple-id <id> --password <app-specific password>
  --team-id Q4KD7AC52U` — 401 there means the pair is wrong, an empty history means it is right.
  The App Store Connect key trio (`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8`) is the
  other path the workflow already accepts.
- 2026-09-30: the macOS release path signs and notarizes. The certificate is the team's own
  Developer ID Application — `Aleksandr Vopilovskii pr RootFox`, team `Q4KD7AC52U`, valid to
  2031-09-17 — made for Tail MCP and kept in `~/tail-mcp-signing/`, whose `export/` copy carries
  the `.p12`, its password, the checksums and the recipe. It signs any app of the team, so both
  projects share it; the GitHub secrets it feeds are not readable back, which makes that folder
  the only backup. `release.yml` ports Tail MCP's step: the signing identity is read out of the
  certificate instead of detected, a certificate **without** notarization credentials fails the
  run on purpose (signed-but-unnotarized still trips Gatekeeper), and the bundle is verified
  afterwards — `codesign --verify --deep --strict`, the sidecar's `allow-jit` entitlement, both
  binaries sharing a team, `stapler validate` on the app and on the dmg. Without the secrets the
  build stays ad-hoc and says so. Releases up to `v0.1.1` are ad-hoc; the first notarized one is
  still to be published — the certificate half is proven in CI, the credentials half is not.
- 2026-09-30: the community key is out of every config on this machine. It was never in a file:
  a value search across the home found it only in the run records of my own throwaway daemons
  (removed) and in session transcripts (inert). It survives as an exported `JEV_API_KEY` in the
  environment that launched the session — a clean login shell carries none, and `ps` cannot show
  it — which is why a probe inherited it and the endpoint answered 401. Every command that starts
  the server from a shell shields itself with `env -u JEV_API_KEY`. The last live consumer of the
  community endpoint is not on this machine at all: `rootfox.cc-infra` gives gomodel's MCP gateway
  a `jev` upstream at `https://www.jevai.org/api/mcp` with `Bearer ${JEV_API_KEY}` (both copies of
  `config.yaml`, line 75), and the key itself lives in that deployment's environment. Our twelve
  tools carry different names from the community's six, so re-pointing that upstream is a change
  of its clients' tool names.
- 2026-09-30: the harness wiring is live on the machine. omp (`~/.omp/agent/mcp.json`) and
  opencode (`~/.config/opencode/opencode.json`) carry `jev` → `http://127.0.0.1:18791/mcp`,
  Claude Code answers `Connected`, and Claude Desktop runs the stdio recipe
  (`/opt/homebrew/bin/node …/mcp-server/src/index.ts --stdio`, `JEV_MCP_ENV` pointing at the app's
  own `.env`) — verified by calling `jev_noul` through that exact command (0.19 → uncertain).
  opencode had **two** `jev` keys: the local one and a stale community one carrying
  `Authorization: Bearer {env:JEV_API_KEY}`; the last duplicate wins, so opencode had been talking
  to the community endpoint all along. The stale one is gone; the only other place that still
  points at that endpoint is gomodel's gateway in `rootfox.cc-infra` (see the entry above).
- 2026-09-30: neither the app nor the server carries the skill. `tools/list` is the whole
  interface (`prompts/list` and `resources/list` answer `Method not found`); the skill is a file in
  the skillset — `skills/jev` → `~/.agents/skills/jev` → linked into `~/.omp/agent/skills`,
  `~/.claude/skills` and `~/.config/opencode/skills`. Installing the released app therefore adds
  the twelve tools, not the skill.
- 2026-09-29: the app icon is the owner's own art. He delivered a decision diamond branching
  into a green check and a red cross (neon on black, 1536×1024, transparent background) and asked
  for a single-colour version where the design needs one; he then delivered a vector trace of the
  same mark (VTracer, flat fills, no glow), which the pipeline now takes as the source — the
  raster glow does not survive 32 pixels, the flat vector does, and the tile is rendered from it
  at 2× and scaled down. The app therefore carries two icons — the mark centred on the black
  background inside the macOS squircle (`tools/build-icons.mjs` → `icons-src/icon.png` → `tauri icon`; `sharp` is a root
  devDependency for the tile) — and `icons-src/tray.svg` → `src-tauri/icons/tray-template.png`,
  the menu-bar glyph, embedded with `include_image!` and drawn from its alpha alone. `tray-icon`
  renders any tray image at 18 pt tall and takes the width from the aspect ratio, so the glyph is
  a square 36×36. The glyph is the diamond and nothing else: rendered at 18 pt the arrows and
  verdict boxes merge into an "M" that no longer reads as a decision.
- 2026-09-29: the CI icon guard is gone with it. `build.yml` skipped the desktop steps while
  `icons-src/icon.png` was missing and `release.yml` asserted the file — but the icon set has been
  committed since task 8, so the skipping branch could not run and the assert could not fire.
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
- 2026-09-29: `release.yml` is no longer undischarged, and its first runs paid for the two things a
  workflow nobody has run hides. GitHub now deprecates the action versions it used
  (`actions/checkout@v4`, `setup-node@v4`, `upload-artifact@v4`, `download-artifact@v4`,
  `gh-release@v2`), so every job printed a Node-24 warning; they are the current majors now, and
  `build.yml` run 36638974540 is green on all four jobs. The secrets were a second surprise: the
  names existed and the values did not — `APPLE_CERTIFICATE_PASSWORD` was missing next to a
  present `APPLE_CERTIFICATE`, `APPLE_ID` was empty, `APPLE_PASSWORD` a one-character stub — which
  Tauri reports as `No Keychain password item found`. With `APPLE_ID` set to the account's email
  the notarization inside `tauri build` succeeded (the log's own `The validate action worked!`),
  and the run then failed on the verification step: it asked `xcrun stapler validate` for a ticket
  on the `.dmg`, where Tauri staples the `.app` and the image carries none of its own. That check
  was wrong, not the build; it now mounts the image and validates the app copy inside it, which is
  the one the user opens.
- 2026-09-30: the release work went back into the skillset, not only into this repository.
  `skills/macos-app-distribution` is new — quarantine versus ad-hoc signature, the `.p12` that the
  keychain never lists, the Developer-ID-versus-Apple-Distribution distinction, the CI rules
  (export only the secrets that exist, pin the identity from the certificate's CN, fail on a
  certificate without notarization), the `allow-jit` entitlement a Node sidecar needs, and the
  artifact checks — with the Tauri specifics in `references/tauri.md`. The `.dmg` correction above
  and the fact that both halves of an Apple ID pair fail alike were folded back into it before
  shipping (`3d99c05`, `0d92d36`). `ci-cd-and-automation` was patched with the action-version and
  runner-image rules, and `skills/jev/` gained `reference/harnesses.md` (how the server is wired
  into a host, what it exposes, and the config traps).
- 2026-09-30: the state-snapshot traps met while refreshing the infra repository's snapshots —
  `state/` is pull-only, a pull re-vaults every secret file so its diff is ciphertext churn to
  revert, and `inspect.json` blanks secret values so a value reading `REDACTED` is that blanking
  rather than an eight-character credential — are recorded in `rootfox.cc-infra`'s `AGENTS.md`
  (`1fada76`).
- 2026-09-30: the release is green end to end and the artifact was checked the way a user meets it
  rather than the way a builder does. `codesign -dv` reports `Developer ID Application: Aleksandr
  Vopilovskii pr RootFox (Q4KD7AC52U)`; `codesign --verify --deep --strict` passes on the bundle
  and on the nested `mcp-server`; `spctl -a -vvv -t exec` answers `accepted, source=Notarized
  Developer ID`; `xcrun stapler validate` passes on the app in `/Applications` and on the copy
  inside the mounted image; both binaries carry `allow-jit` and
  `allow-unsigned-executable-memory`; and installed from the image the app serves `/health` with
  `version 0.1.4`. Two behaviours are worth keeping, both macOS-side and documented in the README:
  macOS may run a quarantined copy from `/private/var/folders/…/AppTranslocation/…` (harmless to
  the app, fatal to the login item, which records that temporary path — hence "launch it once from
  `/Applications` before enabling Launch at startup"), and a first run that carries a *real*
  quarantine event on a machine whose Gatekeeper assessments are disabled raises the consent
  dialog, which `syspolicyd` converts into `Terminating process due to Gatekeeper rejection` when
  nobody answers it. The second one is the only thing left to confirm under the default setting.
- 2026-09-30: `v0.1.4` is published — the draft flag was lifted on the owner's word, and the
  published image was re-verified after the fact: its `sha256` matches the digest GitHub reports
  for the asset, `spctl` still answers `accepted, source=Notarized Developer ID` and the stapled
  ticket validates. The repository is **private**, so the release is reachable by anyone with
  access to it and by nobody else; a user-facing download needs a public repository, a token, or a
  mirror — the owner's call, not a defect. The machine's `/Applications/Jev MCP.app` was replaced
  with this build (quarantine cleared, launched from `/Applications`, `/health` answers `0.1.4` and
  `tools/list` serves the twelve tools), so the tray and the harnesses now run from the notarized
  build instead of the ad-hoc `0.1.1`.

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
- The first `release.yml` runs exercised the version bump, the tag and the artifact set, and the
  bump half works: every dispatch rewrites `main` with `Release <version>` and pushes the tag. A
  run that fails after the bump leaves a tag with no release behind it, which is what `v0.1.2` and
  `v0.1.3` are — the bump commits of the two notarization failures. They are inert (the next
  dispatch bumps to a fresh patch), and removing them is the owner's call:
  `git push --delete origin v0.1.2 v0.1.3`.
- Windows and Linux desktop builds are configured but unverified on this machine.
- Editing `generate_image.enabled` needed an approval that expired, so the harness's own
  image tool stays off; the icon is drawn through the AI Gateway's images endpoint instead.
- The release lives in a **private** repository, and its assets follow that rule: a download link
  that works for someone outside the repository (a public repository, a token, or a mirror) is a
  decision the owner has not taken. Until then "published" means "available to whoever has
  repository access".
- The one macOS behaviour left to confirm under a default setting: a first launch that carries a
  real quarantine event on a machine with Gatekeeper assessments *enabled* — this machine has them
  disabled, so the consent dialog observed there is not proof of what an ordinary machine shows.
  The owner's own download is the cheapest way to settle it.
