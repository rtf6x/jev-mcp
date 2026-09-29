# Working in this repository

## What it is

MCP server ("Jev MCP") that exposes Jev judgments to local harnesses and forwards each request
to the Jev endpoint configured in `.env`. One URL, one key, one model — no provider table.

## Commands

```bash
npm install            # installs the mcp-server and desktop-app workspaces
npm run typecheck      # tsc --noEmit (Node runs the TypeScript sources directly)
npm test               # node --test, no network, no key needed
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
- Questions are forwarded verbatim; only the yes/no spelling is rewritten per
  `JEV_QUESTION_TYPE`.
- Answers are validated fail-closed: malformed answers become `invalid_response` with action
  `review`. Never fabricate, never silently pass.
- Upstream errors are surfaced with the upstream status and body — no fallback, no retry that
  could double-charge.
- Secrets (`JEV_API_KEY`) never appear in logs, tool output, tests, or the repository.

## Plan

The living plan is `docs/plans/jev-mcp.md`: goal, invariants, task list, ledger, loose ends.
Update it in the same change as the work.
