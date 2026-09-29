# Jev MCP

An MCP server that gives your coding agents a **judge**: it hands Jev a state and a set of
typed questions and comes back with a verdict per question — the chosen option or probability,
the full distribution, confidence, and an action (`auto` or `review`).

One URL, one key, one model. The endpoint is configuration, not code: the same server talks to
TypeSafe, OpenRouter, Vercel AI Gateway, or any other System One-compatible endpoint.

Jev is TypeSafe AI's System One decision model: state in, typed answers out, no generated text.
See the [TypeSafe docs](https://docs.typesafe.ai/) for the model itself.

## What it is not

It is not a chat model, not a browser tool, and not a wrapper around somebody's prompt pack. It
does not invent questions, it does not translate responses into its own vocabulary beyond
spelling the yes/no question the way your endpoint expects, and it never substitutes a value
for a malformed answer.

## Install

```bash
git clone git@github.com:rtf6x/jev-mcp.git
cd jev-mcp
npm install
cp .env.example .env      # then set JEV_URL and JEV_API_KEY
```

Requires Node 22.18 or newer. The server runs the TypeScript sources directly.

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

## Desktop app

`desktop-app/` is a tray app that runs the server for you: it spawns the sidecar on launch,
keeps it in the menu bar, and gives you the settings without a terminal.

```bash
npm run icons                       # once: draws the icon with OpenAI (needs OPENAI_API_KEY)
npm run sidecar -- aarch64-apple-darwin   # once per target: bundles the server into the app
npm run desktop                     # builds the .app
```

The tray shows the status and the configured endpoint, and offers Start/Stop, Launch at
startup, **Edit .env** and Open logs. Its `.env` is its own, in the app's config directory
(`~/Library/Application Support/cc.rootfox.jev-mcp-desktop/.env` on macOS); it is created from
`.env.example` on first launch and handed to the sidecar through `JEV_MCP_ENV`. The sidecar
carries Node inside it, so the app needs no Node installation on the machine it runs on.

## The tool

### `jev_judge`

| Argument | Required | Meaning |
| --- | --- | --- |
| `state` | yes | What the questions are judged against: string, JSON object, or JSON array. |
| `questions` | yes | Question id → `{ type, instructions, criteria }`. Every question is judged against the same state, independently — batch them into one call. |
| `model` | no | Overrides `JEV_MODEL` for this call. |
| `accept_at` | no | Action threshold, default `0.85`. |
| `margin_at` | no | Choice answers: winner-to-runner-up gap required for `auto`, default `0.5`. |

Question types follow the Jev primitives: `choice` (pick one of `criteria`), `score`
(position on an ordered `criteria` array), and a yes/no question — written as `noul`, `bool` or
`boolean`, and sent to the endpoint in whichever spelling `JEV_QUESTION_TYPE` names.

Result, per question:

```jsonc
{
  "type": "choice",
  "status": "ok",              // or invalid_response
  "reason": null,              // why an answer was rejected
  "value": "billing",          // option, level position (score), or yes-probability
  "label": "payments",         // option or level description; yes / no / uncertain for yes/no
  "probabilities": { "billing": 0.94, "technical": 0.06 },
  "confidence": 0.9,
  "margin": 0.88,              // choice only
  "action": "auto"             // or review
}
```

plus `endpoint`, `model`, `summary` (`questions`, `auto`, `review`, `invalid`), `usage`, and
`raw` — the endpoint's response exactly as received.

Actions come from thresholds, not from hope: a choice is `auto` only at
`top ≥ accept_at` **and** `margin ≥ margin_at`; a score only when its confidence clears
`accept_at`; a yes/no answer is `uncertain` (and `review`) between `1 - accept_at` and
`accept_at`. Tune the thresholds against your own data —
[confidence is not correctness](https://docs.typesafe.ai/confidence).

Fail-closed rules: a missing answer, a distribution that does not cover the criteria or does
not sum to one, a `choice` that is not the highest-probability option, a score outside the
levels, a malformed confidence, or an unsupported question type all come back
`status: "invalid_response"` with `action: "review"`. An endpoint error is a tool error
carrying the upstream status and body. There is no fallback and no retry: a paid call is never
silently repeated.

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

MIT
