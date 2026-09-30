# Wiring the server into a harness

The server exposes **tools**, plus one `instructions` string in the `initialize` result.
`tools/list` is otherwise the whole interface: `prompts/list` and `resources/list` answer
`Method not found`.

Two channels carry "how to use Jev", and only one of them can be relied on:

- **The skill's `description`** — the only text a harness keeps in context *before* the skill is
  opened. That is why the line reads as a mandate ("judgment goes through these tools, not your own
  reading") and not as a catalogue of capabilities: a rule that lives in the body is read only after
  the model has already decided to open the skill, which is exactly the decision the rule exists to
  change. The situation words stay in that line — they are what the harness routes on.
- **`InitializeResult.instructions`** — the standard MCP channel, and this server sends it. Claude
  Code does not pass it to the model (open issues `anthropics/claude-code#23808`, `#41834` for HTTP
  servers, `#43749` for Desktop; verified on our own server with a stdio probe), so it is a bonus
  for the clients that read it, never the reason a call happens. When an agent never reaches for the
  tools, look at the skill, not at the server.

Two transports, picked by the host:

```json
// Streamable HTTP: omp, Claude Code, opencode (its own key: "mcp", type "remote"), any HTTP client
{ "mcpServers": { "jev": { "type": "http", "url": "http://127.0.0.1:18791/mcp" } } }
```

```json
// stdio: a host that can only spawn a process (Claude Desktop) — the bridge, which forwards to the
// app; `mcpb/dist/server/index.mjs` after `npm run pack:mcpb`. Without the bridge the host spawns
// the server itself: `node …/mcp-server/src/index.ts --stdio` with `JEV_MCP_ENV` pointing at a .env.
{ "mcpServers": { "jev": { "command": "node",
  "args": ["/absolute/path/to/jev-mcp/mcpb/dist/server/index.mjs"] } } }
```

Claude Desktop has no URL transport, so it takes the bridge — one process per session that forwards
to the app and starts nothing of its own. The released `jev-mcp-desktop-<version>.mcpb` installs the
same bridge into Desktop's extensions; a checkout wires it by hand as above. Either way the server,
its `.env` and its port stay the app's.

The raw stdio recipe names its `.env` through `JEV_MCP_ENV`; the app owns its own at
`~/Library/Application Support/<bundle id>/.env` on macOS, and the repository itself needs no `.env`.

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
