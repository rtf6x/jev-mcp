# Jev MCP — living plan

## Goal

One local MCP server that hands Jev judgments to every harness (omp, Claude Code, opencode,
Claude Desktop) and forwards each request to the Jev endpoint configured in `.env`. The
endpoint is the only provider setting: one URL, one key, one model.

## Scope

In: mcp-server (judge tool, HTTP + stdio transports), desktop tray app (Tauri v2, sidecar),
OpenAI-generated icon, README, CI.

Out: browser extensions, WebSocket handshake, provider table / auto-detection, skill packs,
named judgment tools with authored question templates, Docker, npm publish.

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
   and Vercel docs; 11 fail-closed cases.
5. `tool.ts` + transports — **done**: handshake, tools/list, tools/call over HTTP and stdio
   against a live stub; fail-closed answer; endpoint error as tool error.
6. Live call against each credentialed endpoint — **blocked on keys** (none present).
7. Desktop tray app (Tauri v2 + SEA sidecar) — pending.
8. Icon via OpenAI images — pending (`OPENAI_API_KEY` needed).
9. Harness wiring (omp/Claude Code over HTTP, Claude Desktop over stdio) — pending.
10. CI workflows, release workflow — pending.

## Ledger

- 2026-09-29 Tasks 1-5: server built and exercised. Evidence: `npm run typecheck` clean;
  `npm test` 34/34; real process smoke — `/health` answered, `tools/list` listed `jev_judge`,
  `tools/call` returned verdicts with action `auto`, a caller's `bool` reached the endpoint as
  `boolean`, a question with no answer came back `invalid_response`/`review`, a dead endpoint
  came back `is_error` with the message, and stdio answered `initialize` and `tools/list`.
- 2026-09-29: precedence proven live — the endpoint URL came from `.env` while the key came
  from the environment, which wins over the file.

## Loose ends

- **Named judgment tools** (`jev_verify`-style: verify / screen / find / rerank / classify /
  decide / compare / extract / audit / review / gate). They exist in third-party MIT servers
  and carry authored question templates; the owner's scope excludes authored prompts, so the
  server ships one generic `jev_judge` instead. Decision pending.
- Live verification of any endpoint needs a key. No `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY` or
  `AI_GATEWAY_API_KEY` is present in the environment.
- Vercel reports cost as a string under `providerMetadata.gateway.cost`; `usage.cost` stays
  `null` there. Revisit if cost matters.
- `src/version.ts` and `package.json` carry the version twice; the release script must keep
  them in step.
