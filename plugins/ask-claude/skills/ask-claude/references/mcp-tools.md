# Ask Claude MCP Reference

Run the server from the cloned repository:

```bash
node /absolute/path/to/ask-claude/plugins/ask-claude/server.mjs
```

If published to npm, clients can run it with:

```bash
npx -y ask-claude
```

It exposes MCP tools backed by the bundled `@agentclientprotocol/claude-agent-acp` dependency.

## Tools

### `ask_claude`

Use for general discussion, code review, bug hunts, second opinions, and follow-up disagreement resolution.

Key arguments:

- `cwd`: absolute workspace path.
- `session_key`: stable task key for reuse.
- `session_id`: exact Claude session id when continuing a known session.
- `prompt`: message for Claude.
- `model`: `default`, `sonnet[1m]`, `opus`, or `haiku`.
- `effort`: `default`, `low`, `medium`, `high`, `xhigh`, or `max` if available for the selected model.
- `permission_policy`: normally `readonly`.
- `reuse_policy`: `auto`, `always`, or `never`.
- `timeout_ms`: optional per-call prompt timeout in milliseconds.

For reviews, put the review instructions directly in `prompt`, including relevant file paths, the current problem, and whether Claude should inspect the git diff. For follow-ups or disagreements, call `ask_claude` again with the same `session_id` or `session_key`.

### `ask_claude_result`

Use after an `ask_claude` call timed out in the MCP client but may have continued in the background, or when the session list preview is too short.

Key arguments:

- `session_id`: exact Claude session id from `ask_claude_sessions`.
- `session_key` plus `cwd`: locate the newest matching session by stable key.
- `turn_id`: exact stored turn id from `ask_claude_sessions`.
- `turn_offset`: `0` for latest, `1` for previous, and so on.
- `max_answer_chars`: optional cap for returned answer text. Defaults to the full stored answer.
- `include_prompt`: include the stored prompt preview.

### `ask_claude_sessions`

Use before deciding whether to resume a session. The response includes:

- `active`
- `last_active_at`
- `age_minutes`
- `cache_likely_cold`
- `large_context`
- `recommendation`
- `usage`
- recent turn previews, `turn_id`, answer length, and whether a full stored answer is available

If `recommendation` is `ask_before_resuming_large_cold_session`, do not resume casually. Resume only if the old context is genuinely valuable.

## Local Registry

The MCP server writes a lightweight session registry here by default:

```text
$HOME/.codex/ask-claude/sessions.json
```

Override the directory with `ASK_CLAUDE_REGISTRY_DIR`.

The registry stores session ids, keys, cwd, latest usage/cost, last active time, short turn previews, and full Claude answer text up to `ASK_CLAUDE_MAX_STORED_ANSWER_CHARS` characters per turn. It does not replace Claude's own conversation store; it is an index for Codex to make reuse decisions and recover answers after client-side timeouts.

## ACP Usage Updates

Claude ACP sends context/cost through:

```json
{
  "sessionUpdate": "usage_update",
  "used": 53000,
  "size": 200000,
  "cost": {
    "amount": 0.045,
    "currency": "USD"
  }
}
```

The MCP server computes `remaining` and `percent` before returning tool results.

## Streaming And Liveness

ACP streams partial Claude output during a turn through `session/update` messages:

```text
sessionUpdate: agent_message_chunk
```

The MCP server buffers those text chunks and only returns the final answer in the tool result. It does not put partial Claude text into Codex context.

For liveness, the server emits lightweight MCP progress/logging updates:

```text
Claude ask: started, 0 chars, 0s
Claude ask: waiting, 0 chars, 5s
Claude ask: streaming, 37 chars, context 29343/200000, 13s
Claude ask: completed, 157 chars, context 29799/200000, 15s
```

These updates include character count, elapsed seconds, tool count/title, and latest context usage. They intentionally omit response text.

MCP clients that pass `onprogress` / `resetTimeoutOnProgress` can show these updates and avoid treating a long Claude call as stuck. Clients without progress support still get the final answer normally.

## Timeout Defaults

The bridge defaults long Claude calls and internal session restores to 15 minutes:

- `session/prompt`: 15 minutes by default, override with tool input `timeout_ms`.
- `session/resume`: internal restore method, 15 minutes by default.
- `session/load`: internal compatibility/fallback restore method, 15 minutes by default.
- `initialize` and `session/set_config_option`: 60 seconds by default.

Environment overrides:

- `ASK_CLAUDE_PROMPT_TIMEOUT_MS`
- `ASK_CLAUDE_RESUME_TIMEOUT_MS`
- `ASK_CLAUDE_LOAD_TIMEOUT_MS`
- `ASK_CLAUDE_INIT_TIMEOUT_MS`
- `ASK_CLAUDE_CONFIG_TIMEOUT_MS`

Numeric values are treated as milliseconds. Values with `ms`, `s`, `m`, or `h` suffixes are also accepted, such as `900000`, `900s`, or `15m`.

`RESUME` and `LOAD` are not public tools. They are ACP methods used by `ask_claude` when continuing a remembered session. Most users can configure both restore timeouts to the same value.

These are bridge-level ACP request timeouts. A Codex-side MCP client can still enforce its own call timeout unless it supports progress notifications and resets that timeout while progress arrives. In Codex, set `tool_timeout_sec` for this MCP server when long reviews are expected.

## Default Model And Effort

`ask_claude` accepts per-call `model`, `effort`, `mode`, and `permission_policy`. The MCP server can also set defaults through environment variables:

```text
ASK_CLAUDE_DEFAULT_MODEL=opus
ASK_CLAUDE_DEFAULT_EFFORT=high
ASK_CLAUDE_DEFAULT_MODE=default
ASK_CLAUDE_DEFAULT_PERMISSION_POLICY=readonly
```

Per-call arguments override these environment defaults.

## Environment And Proxy

The server does not read a secondary config file. It inherits the MCP process environment and passes it to the Claude ACP adapter.

If Claude Code needs proxy variables on a user's machine, configure them in the MCP client/Codex server environment. Common variables are:

```text
HTTP_PROXY
HTTPS_PROXY
NO_PROXY
ALL_PROXY
http_proxy
https_proxy
no_proxy
all_proxy
```

For Codex, that usually means adding only the variables required by the machine:

```toml
[mcp_servers.ask-claude.env]
HTTPS_PROXY = "http://proxy.example:8080"
HTTP_PROXY = "http://proxy.example:8080"
NO_PROXY = "localhost,127.0.0.1"
```

Restart the MCP client after changing the server environment.

## Resume Policy

`reuse_policy: "auto"`:

- Reuse active sessions.
- Resume remembered sessions if they are recent.
- Resume old sessions automatically only when their context is large enough that reconstructing it would likely be expensive.

`reuse_policy: "always"`:

- Resume matching remembered sessions even if cache is probably cold.

`reuse_policy: "never"`:

- Start a fresh Claude session for the given key.

## Troubleshooting

If a Claude call returns `Failed to authenticate. API Error: 403 Request not allowed` while `claude auth status` shows a valid login, inspect the environment inherited by the MCP server.

Useful checks:

```bash
claude auth status
codex mcp get ask-claude
ps -ef | grep -E 'ask-claude|claude-agent-acp' | grep -v grep
```

After changing MCP env or updating the server code, stop old `ask-claude` processes or restart the MCP client so it launches the updated server.
