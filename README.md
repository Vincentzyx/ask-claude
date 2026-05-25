# Ask Claude

Ask Claude lets Codex consult Claude Code for second opinions through MCP and ACP. It is packaged as both a Codex plugin marketplace entry and an npm MCP server.

## What It Provides

- `ask_claude`: start or continue a multi-turn Claude Code session for discussion, review, bug hunting, and disagreement resolution.
- `ask_claude_sessions`: list active and remembered Claude sessions with context, cost, age, and cache-cold hints.
- A Codex skill that teaches Codex when to ask Claude, how to reuse sessions, and how to challenge questionable findings.
- Configurable Claude model, reasoning effort, permission policy, and timeouts through tool arguments or environment variables.

## Requirements

- Node.js 20 or newer.
- Claude Code installed and authenticated on the same machine.
- Codex with plugin or stdio MCP support.

## Install As A Codex Plugin

In the Codex app, open **Add marketplace** and use:

- Source: `Vincentzyx/ask-claude`
- Git ref: `main`
- Sparse paths: leave empty, or use both `.agents/plugins` and `plugins/ask-claude`

Then install **Ask Claude** from that marketplace.

The equivalent CLI flow is:

```bash
codex plugin marketplace add Vincentzyx/ask-claude --ref main \
  --sparse .agents/plugins \
  --sparse plugins/ask-claude
codex plugin add ask-claude@ask-claude
```

The plugin launches the MCP server with:

```bash
npx -y ask-claude
```

## Manual MCP Setup

If you only want the MCP server, register it directly:

```bash
codex mcp add ask-claude -- npx -y ask-claude
```

For a source checkout:

```bash
git clone https://github.com/Vincentzyx/ask-claude.git
cd ask-claude/plugins/ask-claude
npm install
codex mcp add ask-claude -- node /absolute/path/to/ask-claude/plugins/ask-claude/server.mjs
```

For long Claude reviews, configure the Codex-side tool timeout:

```toml
[mcp_servers.ask-claude]
command = "npx"
args = ["-y", "ask-claude"]
startup_timeout_sec = 60
tool_timeout_sec = 900
```

The server does not read any extra config file. It inherits the environment supplied by the MCP client and passes that environment to the Claude ACP adapter. If your network requires proxy variables, configure them in the MCP client environment:

```toml
[mcp_servers.ask-claude.env]
HTTPS_PROXY = "http://proxy.example:8080"
HTTP_PROXY = "http://proxy.example:8080"
NO_PROXY = "localhost,127.0.0.1"
```

Restart Codex after changing MCP config so the stdio server is relaunched with the new environment.

## Tools

| Tool | Purpose |
| --- | --- |
| `ask_claude` | Start or continue a Claude Code ACP session for discussion, review, bug hunting, or follow-up disagreement resolution. |
| `ask_claude_sessions` | List active and remembered sessions, including context usage, cost, last activity, and cache-cold hints. |

Key `ask_claude` arguments:

| Argument | Use |
| --- | --- |
| `prompt` | The message for Claude. Include the current question, review focus, relevant paths, and what you want Claude to inspect. |
| `cwd` | Workspace directory Claude Code should operate in. |
| `session_key` | Stable reusable key such as `review:<repo>:<branch>` or `discuss:<topic>`. |
| `session_id` | Exact remembered session id when continuing a specific session. |
| `reuse_policy` | `auto`, `always`, or `never`. |
| `model` / `effort` | Per-call override for Claude model and reasoning effort. |
| `permission_policy` | MCP-side permission handling. Defaults to `readonly`. |
| `timeout_ms` | Per-call bridge timeout for `session/prompt`. |

Example review prompt:

```text
Review the current git diff for correctness bugs only. Please inspect the relevant files yourself from this workspace. Do not edit files. Return findings first, ordered by severity, with file paths and line references.
```

Example follow-up:

```text
I disagree with finding #2. In src/session.ts, createSession checks expiration before writing the token. Please re-check that control flow and either refine or withdraw the finding.
```

## Timeouts

The bridge defaults long Claude prompts and internal session restores to 15 minutes. You can override them with environment variables:

```bash
ASK_CLAUDE_PROMPT_TIMEOUT_MS=15m
ASK_CLAUDE_RESUME_TIMEOUT_MS=15m
ASK_CLAUDE_LOAD_TIMEOUT_MS=15m
ASK_CLAUDE_INIT_TIMEOUT_MS=60s
ASK_CLAUDE_CONFIG_TIMEOUT_MS=60s
```

Numeric values are treated as milliseconds. Values with `ms`, `s`, `m`, or `h` suffixes are also accepted.

`RESUME` and `LOAD` are not public tools. They are internal ACP methods used when `ask_claude` continues a remembered session:

- `session/resume`: the preferred ACP method when the Claude adapter advertises resume support.
- `session/load`: compatibility path for adapters that expose loading rather than resume, and as a fallback when resume is unavailable.

Most users can set `ASK_CLAUDE_RESUME_TIMEOUT_MS` and `ASK_CLAUDE_LOAD_TIMEOUT_MS` to the same value.

You can also pass `timeout_ms` to `ask_claude` for a single call. This only controls the bridge's ACP request wait time; your MCP client may still enforce its own tool-call timeout, such as Codex's `tool_timeout_sec`.

## Configuration

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ASK_CLAUDE_DEFAULT_CWD` | MCP server process cwd | Default workspace when `ask_claude` omits `cwd`. |
| `ASK_CLAUDE_REGISTRY_DIR` | `$HOME/.codex/ask-claude` | Local session registry directory. |
| `ASK_CLAUDE_DEFAULT_MODEL` | unset | Default Claude model, such as `opus`, `sonnet[1m]`, `haiku`, or `default`. |
| `ASK_CLAUDE_DEFAULT_EFFORT` | unset | Default reasoning effort, such as `low`, `medium`, `high`, `xhigh`, `max`, or `default`. |
| `ASK_CLAUDE_DEFAULT_MODE` | unset | Default Claude Code mode, such as `default`, `plan`, or `acceptEdits`. |
| `ASK_CLAUDE_DEFAULT_PERMISSION_POLICY` | `readonly` | Default MCP-side permission policy. |
| `CLAUDE_ACP_COMMAND` | bundled adapter | Override command used to start the Claude ACP adapter. |
| `CLAUDE_ACP_ARGS` | bundled adapter entrypoint | JSON array of adapter args. If `CLAUDE_ACP_COMMAND` is set and this is omitted, no extra args are passed. |

Example Codex defaults:

```toml
[mcp_servers.ask-claude.env]
ASK_CLAUDE_DEFAULT_MODEL = "opus"
ASK_CLAUDE_DEFAULT_EFFORT = "high"
ASK_CLAUDE_DEFAULT_PERMISSION_POLICY = "readonly"
```

## Permissions And Privacy

The default `readonly` permission policy rejects Claude Code edit and shell-command permission requests while allowing normal read-oriented context gathering. Use broader policies only when you deliberately want Claude Code to edit files or run commands:

- `allow_edits`
- `allow_commands`
- `allow_edits_and_commands`
- `allow_all`

The session registry stores short prompt and answer previews on the local machine. It is intended for session selection and should not be committed or shared.

## Development

The MCP package lives in `plugins/ask-claude`.

```bash
cd plugins/ask-claude
npm install
npm run smoke
```

The smoke test starts the MCP server, lists its tools, and calls `ask_claude_sessions`. It does not send a prompt to Claude.
