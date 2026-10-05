# Working in this repository

## What it is

MCP server ("Jev MCP") that exposes Jev judgments to local harnesses and forwards each request
to the Jev endpoint configured in `.env`. One URL, one key, one model — no provider table.

It offers the twelve tools of [jkudish/jev-mcp](https://github.com/jkudish/jev-mcp) (MIT; commit,
adapted files and licence texts in `THIRD-PARTY-NOTICES.md`): `jev_verify`, `jev_screen`,
`jev_noul`, `jev_find`, `jev_rerank`, `jev_classify`, `jev_decide`, `jev_compare`, `jev_extract`,
`jev_audit`, `jev_review`, `jev_gate`. Layout: one file per tool under `mcp-server/src/tools/`
(registered by `src/tools/index.ts`), shared question/answer/policy helpers under
`mcp-server/src/jev/`, and the single upstream call in `src/jev/call.ts` over `src/forward.ts`.

## Commands

```bash
npm install            # installs the mcp-server and desktop-app workspaces
npm run typecheck      # tsc --noEmit (Node runs the TypeScript sources directly)
npm test               # node --test, no network, no key needed
npm run bench          # compares evaluation models on labelled data (network + a real key)
npm start              # MCP over Streamable HTTP on MCP_HTTP_PORT (default 18791)
npm run stdio          # MCP over stdio (Claude Desktop and other stdio hosts)
npm run build          # esbuild bundle to mcp-server/dist/jev-mcp.cjs
npm run sidecar -- <rust-target-triple>   # SEA executable under desktop-app/src-tauri/binaries
npm run desktop        # tray app bundle (needs the icon set and a Rust >= 1.77 toolchain)
npm run icons          # redraws the icon set with OpenAI (needs OPENAI_API_KEY)
node scripts/bump-version.mjs [x.y.z]     # set the version in every place it is carried
```

The tray app keeps its own `.env` in the app config directory and passes it to the sidecar as
`JEV_MCP_ENV`; the template in the repository (`.env.example`) is embedded in the binary at
compile time, so a new `.env` always matches the shipped comments.

## Invariants

- The endpoint is configuration, never a code path: no provider list, no auto-detection, no
  per-provider branch. `JEV_URL` is used verbatim.
- The tool set is upstream's: twelve tools, their names, argument schemas and result shapes. One
  upstream request per tool call (`{ model, state, questions }` through `src/jev/call.ts`), never
  two. Each ported file keeps its one-line header naming the upstream file it came from.
- Questions are authored by the tools and sent as written; only the yes/no spelling is rewritten
  per `JEV_QUESTION_TYPE`, and the answer readers accept every documented spelling.
- Answers are validated fail-closed: malformed answers become `invalid_response` with action
  `review`. Never fabricate, never silently pass.
- Upstream errors are surfaced with the upstream status and body — no fallback, no retry that
  could double-charge.
- Secrets (`JEV_API_KEY`) never appear in logs, tool output, tests, or the repository.

## The skill

`skills/jev/` is a copy of `ai-skillset/skills/jev`. The skillset keeps the source of truth; this
copy exists so a machine that clones only this repository still learns when to call the tools. It is
not maintained here — when the skill changes in the skillset, copy the folder again.

## Plan

The living plan is `docs/plans/jev-mcp.md`: goal, invariants, task list, ledger, loose ends.
Update it in the same change as the work.
