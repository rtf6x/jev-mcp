# Wiring the server into a harness

The server exposes **only tools**. `tools/list` is the whole interface: `prompts/list` and
`resources/list` answer `Method not found`, so nothing about how to use Jev can be delivered over
MCP — this skill is a file in the skillset, installed separately from the app.

Two transports, picked by the host:

```json
// Streamable HTTP: omp, Claude Code, opencode (its own key: "mcp", type "remote"), any HTTP client
{ "mcpServers": { "jev": { "type": "http", "url": "http://127.0.0.1:18791/mcp" } } }
```

```json
// stdio: Claude Desktop and other hosts that can only spawn a process
{ "mcpServers": { "jev": {
  "command": "node",
  "args": ["/absolute/path/to/jev-mcp/mcp-server/src/index.ts", "--stdio"],
  "env": { "JEV_MCP_ENV": "/absolute/path/to/the/app/.env" } } } }
```

`JEV_MCP_ENV` points at the `.env` the tray app owns (`~/Library/Application Support/<bundle id>/.env`
on macOS); the repository itself needs no `.env`.

## Traps

- **A second `jev` key in the same JSON.** An object keeps the last duplicate key, so a stale entry
  silently wins while the file still looks right — the client keeps talking to the old endpoint.
  Replace the entry, never add one beside it, and check: `grep -c '"jev"' <config>`.
- **The server has to be running.** The tray app is the intended host: it spawns the sidecar and
  holds `127.0.0.1:18791`. A client that starts its own stdio process does not need it; a client
  pointed at HTTP does, and "failed to connect" is usually this, not a wrong URL. A second tray
  instance fails on the port on purpose — the sidecar exits with its parent.
- **A real environment variable beats `.env`.** An exported `JEV_API_KEY` or `JEV_URL` overrides the
  app's own configuration, so a `401` from the endpoint usually means the shell's value won, not that
  the endpoint is broken — an *official* `jev_…` key exported in a session that talks to the Vercel
  gateway answers `401 Authentication failed` exactly like a stale key would. `open` hands the
  calling shell's environment to the app, so launch it as
  `env -u JEV_API_KEY -u JEV_URL open "<path>/Jev MCP.app"`, or drop the variable. Two checks tell
  the two cases apart in seconds: `/health` names the endpoint and model actually in force, and the
  key's prefix names its provider (`vck_…` the AI Gateway, `jev_…` the official API, `sk-or-v1_…`
  OpenRouter) — against the gateway a malformed body answers `400` while wrong credentials answer
  `401`, so the same key posted once separates "wrong key" from "wrong request".

## Checking what is actually configured

```bash
curl -sS http://127.0.0.1:18791/health
# {"status":"ok","version":"0.1.1","endpoint":"https://…/v1/evaluate","model":"typesafe-ai/jev"}
```

The endpoint and the model in that answer are the ones in force — faster than reading config files,
and it settles "which provider am I actually talking to" before any judgment call.
