# Jev MCP

An MCP server that gives your coding agents a **judge**: twelve purpose-built tools that hand Jev
a state and a set of typed questions and come back with a verdict — the chosen option or
probability, the full distribution, confidence, and an action (`auto`, `review` or `escalate`).

One URL, one key, one model. The endpoint is configuration, not code: the same server talks to
TypeSafe, OpenRouter, Vercel AI Gateway, or any other System One-compatible endpoint.

Jev is TypeSafe AI's System One decision model: state in, typed answers out, no generated text.
See the [TypeSafe docs](https://docs.typesafe.ai/) for the model itself.

## What it is not

It is not a chat model, not a browser tool, and not a wrapper around somebody's prompt pack. The
question design lives in the tools, not in your prompt: it does not translate answers into its own
vocabulary beyond spelling the yes/no question the way your endpoint expects, and it never
substitutes a value for a malformed answer.

## Install from scratch

A machine with nothing installed. Five steps; the details live in the sections below, so nothing is
written twice.

### 1. Get the server running

**Desktop app — no Node needed.** Take the installer from
[Releases](https://github.com/rtf6x/jev-mcp/releases) and drag it to Applications. The tray then owns
the server: Start/Stop, **Edit .env**, Open logs. Signature, notarization and the first-launch
confirmation are covered under [Desktop app](#desktop-app).

**From source — Node 22.18 or newer.** The server runs the TypeScript sources directly.

```bash
git clone git@github.com:rtf6x/jev-mcp.git
cd jev-mcp
npm install
cp .env.example .env      # then set JEV_URL and JEV_API_KEY
npm start                 # MCP over HTTP on http://127.0.0.1:18791/mcp
```

**A host that spawns a process** — Claude Desktop and other stdio-only hosts: run `npm run stdio`,
wired as in [Harnesses](#harnesses).

### 2. Point it at a provider

`JEV_URL`, `JEV_API_KEY`, and the model and yes/no spelling that endpoint expects: the table and the
key pages are in [Configure](#configure). The tray app keeps its own `.env` in its config directory;
a server started by hand reads the repository's.

### 3. Wire your harness

One command for Claude Code, a JSON block for omp, opencode and any other Streamable-HTTP client:
[Harnesses](#harnesses).

### 4. Install the skill

The server registers twelve tools; the skill is what makes an agent call them instead of answering
from its own reading. `skills/jev/` ships here as a copy — copy it into the directory your client
reads:

```bash
cp -R skills/jev ~/.claude/skills/            # Claude Code (or .claude/skills in one project)
cp -R skills/jev ~/.config/opencode/skills/   # opencode
cp -R skills/jev ~/.agents/skills/            # omp, Codex, generic agents
```

Claude Desktop loads plugins rather than skill directories, so the skill does not reach it this way;
there the server is what matters.

### 5. Check that it works

```bash
curl -sS http://127.0.0.1:18791/health        # the endpoint and the model actually in force
claude mcp list                               # jev ... Connected
```

Then call one tool — in a harness, or over HTTP with an `initialize` first. A first call that comes
back with a verdict, probabilities and a usage block is the whole chain working.

### When it does not work

- **`401 Authentication failed`** — a real environment variable beats `.env`, so a key exported in
  the shell the app was launched from wins over the app's own file. `/health` names the endpoint and
  the model in force, and the key's prefix says which provider it belongs to (`vck_` Vercel AI
  Gateway, `jev_` TypeSafe, `sk-or-v1_` OpenRouter). Launch the tray app from a clean environment:
  `env -u JEV_API_KEY open "/Applications/Jev MCP.app"`.
- **Nothing listens on the port** — the sidecar is not running. Start it in the tray (or `npm start`
  in the checkout) and read Open logs.
- **`"Jev MCP.app" is damaged and cannot be opened`** — an ad-hoc build rather than a broken
  download: `xattr -dr com.apple.quarantine "/Applications/Jev MCP.app"`.
- **Launch at startup records a temporary path** — a quarantined app runs from a randomized
  `AppTranslocation` copy. Launch it once from `/Applications` first.

## Configure

| Variable | Default | Meaning |
| --- | --- | --- |
| `JEV_URL` | — | Endpoint that receives the request. Used verbatim. |
| `JEV_API_KEY` | — | Bearer key for that endpoint. |
| `JEV_MODEL` | `jev-latest` | Model id sent in the request body. |
| `JEV_QUESTION_TYPE` | `noul` | Spelling of a yes/no question: `noul` or `boolean`. |
| `MCP_HOST` | `127.0.0.1` | Interface the HTTP transport binds. |
| `MCP_HTTP_PORT` | `18791` | Port for the HTTP transport. |
| `JEV_TIMEOUT_MS` | `60000` | Whole-request deadline for the upstream call. |
| `JEV_MCP_ENV` | `<cwd>/.env` | Path of the env file to read. |
| `JEV_MCP_EXIT_WITH_PARENT` | `0` | `1` makes the server exit when its stdin closes: the tray app pipes stdin, so the server leaves when the app does instead of holding the port as an orphan. Leave it off for a host that runs without a parent pipe. |

Real environment variables win over `.env` entries; the file only fills what the environment
does not carry. No keys are read from anywhere else.

Known endpoints:

| Provider | `JEV_URL` | `JEV_MODEL` | `JEV_QUESTION_TYPE` |
| --- | --- | --- | --- |
| TypeSafe (official) | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `noul` |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` | `noul` |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1/evaluate` | `typesafe-ai/jev` | `boolean` |

Key pages: [console.typesafe.ai/keys](https://console.typesafe.ai/keys),
[openrouter.ai/settings/keys](https://openrouter.ai/settings/keys),
Vercel AI Gateway API keys.

## Run

```bash
npm start          # MCP over Streamable HTTP: http://127.0.0.1:18791/mcp (+ /health)
npm run stdio      # MCP over stdio, for hosts that spawn a process
```

### Harnesses

omp, Claude Code, opencode and any other Streamable-HTTP client:

```json
{
  "mcpServers": {
    "jev": { "type": "http", "url": "http://127.0.0.1:18791/mcp" }
  }
}
```

Claude Desktop and other stdio-only hosts:

```json
{
  "mcpServers": {
    "jev": {
      "command": "node",
      "args": ["/absolute/path/to/jev-mcp/mcp-server/src/index.ts", "--stdio"],
      "env": { "JEV_MCP_ENV": "/absolute/path/to/jev-mcp/.env" }
    }
  }
}
```

A config that already carries a `jev` entry gets that entry **replaced**, never a second one: a
JSON object keeps the last duplicate key, so the stale entry wins and the client keeps talking to
the old endpoint while the file still looks right. The server answers `tools/list` only — no
prompts and no resources; the skill that tells an agent which tool to call ships here as
`skills/jev/`, a copy of `ai-skillset/skills/jev`, which stays the source of truth.

## Desktop app

`desktop-app/` is a tray app that runs the server for you: it spawns the sidecar on launch,
keeps it in the menu bar, and gives you the settings without a terminal.

```bash
npm run icons                       # once: prepares the icon set from desktop-app/icons-src/
npm run sidecar -- aarch64-apple-darwin   # once per target: bundles the server into the app
npm run desktop                     # builds the .app
```

The tray shows the status and the configured endpoint, and offers Start/Stop, Launch at
startup, **Edit .env** and Open logs. Its `.env` is its own, in the app's config directory
(`~/Library/Application Support/cc.rootfox.jev-mcp-desktop/.env` on macOS); it is created from
`.env.example` on first launch and handed to the sidecar through `JEV_MCP_ENV`. The sidecar
carries Node inside it, so the app needs no Node installation on the machine it runs on.

The app carries two icons, because macOS wants two different things: the colour app icon (a
square tile the system shows in the Finder and the installer) and the menu-bar glyph, drawn
from its alpha alone and repainted by the system for a light, dark or highlighted bar.
`desktop-app/icons-src/README.md` holds the sources and how to rebuild them.

### Install a release

Downloads are signed with the team's **Developer ID Application** certificate and notarized by
Apple, so the `.dmg` opens with a plain double-click and the old «"Jev MCP.app" is damaged and
cannot be opened» is gone. The release workflow takes the certificate and the notarization
credentials from the repository secrets — `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_TEAM_ID`, `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password; or `APPLE_API_KEY`,
`APPLE_API_ISSUER`, `APPLE_API_KEY_P8` instead of the last three). The certificate itself is the
team's, reused from Tail MCP; the material and the recipe live in `~/tail-mcp-signing/`.

macOS may still ask you to confirm the **first** launch of a downloaded copy («… is an app
downloaded from the internet. Are you sure you want to open it?»). That is the standard
quarantine confirmation, not a signature problem — click **Open** once and later launches are
silent. While that flag is present macOS may also run the app from a randomized read-only copy
instead of `/Applications` (`ps xw | grep "Jev MCP"` shows a
`/private/var/folders/…/AppTranslocation/…` path). The app itself does not care, but **Launch at
startup** does: the login item would record that temporary path. Launch the app once from
`/Applications` before enabling it, or clear the flag:

```bash
xattr -dr com.apple.quarantine "/Applications/Jev MCP.app"
```

With **no certificate** the build falls back to an ad-hoc signature — and then macOS answers
«"Jev MCP.app" is damaged and cannot be opened», with that line as the only way in. A certificate
present **without** notarization credentials stops the release on purpose: a
signed-but-unnotarized build still trips Gatekeeper, so shipping it would only move the problem.
Releases up to `v0.1.1` are ad-hoc and need the line above; `v0.1.4` is the first notarized one.

## The tools

The server exposes twelve community judgment tools (ported from
[jkudish/jev-mcp](https://github.com/jkudish/jev-mcp), MIT — see `THIRD-PARTY-NOTICES.md`). Each
one turns a state into typed questions, posts **one** request to `JEV_URL`, and validates the
answers fail-closed.

| Tool | What it answers | Arguments (defaults in brackets) |
| --- | --- | --- |
| `jev_verify` | How the evidence relates to each claim: `verified` / `contradicted` / `unsupported` | `claims`, `evidence`, `auto_accept` [0.8] |
| `jev_screen` | Whether fetched text is safe to read: injection, substance, relevance → `pass` / `review` / `block` / `skip` | `text`, `purpose`, `block_at` [0.75], `review_at` [0.25] |
| `jev_noul` | A calibrated probability per proposition (`likely` / `unlikely` / `uncertain`) | `propositions`, `context`, `auto_accept` [0.85] |
| `jev_find` | Which candidate best answers a query, and whether any candidate does | `query`, `candidates`, `top_k` [5] |
| `jev_rerank` | Every candidate's relevance, sorted | `query`, `candidates`, `top_k` [all] |
| `jev_classify` | One class per item from a shared catalog, with a margin-gated decision | `items`, `classes`, `purpose`, `context`, `auto_accept` [0.85], `minimum_margin` [0.5] |
| `jev_decide` | Which bounded alternative fits the evidence and priorities: escape hatches (`ask_user` / `investigate` / `none`) plus a per-requirement check | `decision`, `evidence`, `priorities`, `candidates`, `requirements`, `escape_hatches` [true], `escalate_on_contradiction` [false] |
| `jev_compare` | `same_fact` / `contradicts` / `different_facts` for two passages, optionally per named aspect | `passage_a`, `passage_b`, `aspects`, `purpose`, `auto_accept` [0.85], `minimum_margin` [0.5] |
| `jev_extract` | Which regex candidate is the field's true value, returned verbatim | `document`, `fields` (`id`, `pattern`, `flags`, `description`), `auto_accept` [0.85], `minimum_margin` [0.5] |
| `jev_audit` | Whether an extracted value is wrong: hallucinated, off-target, incomplete, wrong format, or wrongly omitted | `source`, `records`, `wrong_at` [0.7] |
| `jev_review` | Whether a proposed patch may be applied: four 0..2 rubric scores → `auto` / `review` / `escalate` | `request`, one of `diff` or `files`, `tests`, `auto_accept` [0.8], `review_at` [min(0.5, auto_accept)], `composite_floor` [0.7] |
| `jev_gate` | A patch review **and** completion claims against evidence, in one call | `request`, one of `diff` or `files`, `claims`, `evidence`, `tests`, the `jev_review` thresholds |

### Question types

Every question is one of the Jev primitives: `choice` (pick one of the criteria), `score`
(position on an ordered rubric) and a yes/no question. The yes/no question is written in
whichever spelling the configured endpoint expects — `JEV_QUESTION_TYPE=noul` or `boolean` — so
the same server talks to TypeSafe, OpenRouter and Vercel AI Gateway with no provider branch. The
answer readers accept `noul`, `probability` or `bool` for the yes/no probability, whichever the
endpoint reports.

### Results

Each tool returns one JSON text block: `tool`, `model`, `provider` (`endpoint`, or `none` when no
call was needed), `usage` (`input_tokens` / `output_tokens` / `cost`, read from either the
snake_case or the camelCase spelling, `null` when the endpoint reported none), plus the tool's own
fields — usually a `status`, one or more actions, and per-item results:

```jsonc
{
  "tool": "jev_classify",
  "summary": { "items": 2, "auto": 1, "review": 1, "invalid_response": 0, "by_class": { "billing": 1 } },
  "thresholds": { "auto_accept": 0.85, "minimum_margin": 0.5 },
  "results": [
    { "id": "refund", "classification": "billing", "probabilities": { "billing": 0.95, "technical": 0.05 },
      "confidence": 0.9, "margin": 0.9, "top_probability": 0.95, "decision": "auto" }
  ],
  "usage": { "input_tokens": 120, "output_tokens": 24, "cost": null }
}
```

### Fail-closed rules

An action comes from thresholds, never from hope, and every tool exposes its thresholds per call:
`auto` requires the top probability to clear `auto_accept` at `jev_verify` (where it is the answer
confidence), `jev_noul` and `jev_find`, the winner-to-runner-up margin to clear `minimum_margin`
as well at `jev_classify`, `jev_compare` and `jev_extract`, and `jev_screen` routes on
`block_at` / `review_at` instead. `jev_review` and `jev_gate` require `safe_to_apply` and the
rubric confidence at `auto_accept` with the weighted composite at `composite_floor`; `jev_audit`
escalates the whole audit when any value's max-gated P(wrong) reaches `wrong_at`. Everything else
is `review` (or `escalate` in the review family), and truncated or incomplete input can only make
an action stronger — never `auto`.

A missing or malformed answer is `status: "invalid_response"` with action `review`, never a
guessed value: a distribution that does not cover the criteria or does not sum to one, a `choice`
that is not the highest-probability option, a score outside the rubric, a confidence that is
present but malformed, a regex that timed out, a candidate universe that was capped, or an answer
that is simply absent. An endpoint failure — transport, or an HTTP error status — is a tool error
carrying the upstream status and body. There is no fallback and no retry: a paid call is never
silently repeated.

Tune the thresholds against your own data —
[confidence is not correctness](https://docs.typesafe.ai/confidence).

## Development

```bash
npm test           # unit and end-to-end tests against a stub endpoint, no key needed
npm run typecheck  # tsc --noEmit
npm run build      # esbuild bundle: mcp-server/dist/jev-mcp.cjs
npm run sidecar -- <rust-target-triple>   # SEA executable for the tray app
npm run desktop:dev                       # tray app in dev mode
```

The living plan is `docs/plans/jev-mcp.md`.

The tray app compiles with a Rust toolchain of 1.77 or newer (Tauri v2's minimum). On a machine
where Homebrew's `rust` shadows a newer rustup toolchain, put rustup's first:
`PATH="$HOME/.cargo/bin:$PATH" npm run desktop`.

## Licence

MIT. The twelve tools are ported from [jkudish/jev-mcp](https://github.com/jkudish/jev-mcp) (MIT);
see `THIRD-PARTY-NOTICES.md` for the upstream commit, the adapted files and the licence texts.
