# Ask Claude

Ask Claude 让 Codex 通过 MCP 和 ACP 向本机 Claude Code 请教问题。它既可以作为 Codex plugin 安装，也可以作为独立的 npm MCP server 使用。

[English README](README.md)

## 提供什么

- `ask_claude`：启动或继续一个 Claude Code 多轮会话，用于讨论、代码 review、bug hunting 和分歧复核。
- `ask_claude_sessions`：列出活跃和历史 Claude 会话，包括上下文、成本、会话年龄和 prefix cache 是否可能已经冷掉。
- 一个 Codex skill，告诉 Codex 什么时候该问 Claude、如何复用会话、以及如何反驳或复核 Claude 的可疑结论。
- 支持通过 tool 参数或环境变量配置 Claude 模型、reasoning effort、权限策略和超时时间。

## 前置要求

- Node.js 20 或更新版本。
- 同一台机器上已经安装并登录 Claude Code。
- Codex 支持 plugin 或 stdio MCP。

## 作为 Codex Plugin 安装

在 Codex app 中打开 **Add marketplace**，填写：

- Source: `Vincentzyx/ask-claude`
- Git ref: `main`
- Sparse paths: 可以留空，或者填写 `.agents/plugins` 和 `plugins/ask-claude`

然后在这个 marketplace 里安装 **Ask Claude**。

等价的 CLI 流程是：

```bash
codex plugin marketplace add Vincentzyx/ask-claude --ref main \
  --sparse .agents/plugins \
  --sparse plugins/ask-claude
codex plugin add ask-claude@ask-claude
```

plugin 会用下面的命令启动 MCP server：

```bash
npx -y ask-claude
```

Codex 目前可能不会给 plugin 自带的 MCP server 显示设置按钮。如果你需要设置 Claude 默认模型、reasoning effort、代理或更长的 tool timeout，可以在 `~/.codex/config.toml` 里添加一条显式 MCP 配置：

```toml
[mcp_servers.ask-claude]
command = "npx"
args = ["-y", "ask-claude"]
startup_timeout_sec = 60
tool_timeout_sec = 900

[mcp_servers.ask-claude.env]
ASK_CLAUDE_DEFAULT_MODEL = "opus"
ASK_CLAUDE_DEFAULT_EFFORT = "high"
HTTPS_PROXY = "http://proxy.example:8080"
HTTP_PROXY = "http://proxy.example:8080"
ALL_PROXY = "http://proxy.example:8080"
```

修改 `~/.codex/config.toml` 后需要重启 Codex，让 MCP server 用新的环境变量重新启动。

## 手动 MCP 安装

如果只需要 MCP server，可以直接注册：

```bash
codex mcp add ask-claude -- npx -y ask-claude
```

如果从源码启动：

```bash
git clone https://github.com/Vincentzyx/ask-claude.git
cd ask-claude/plugins/ask-claude
npm install
codex mcp add ask-claude -- node /absolute/path/to/ask-claude/plugins/ask-claude/server.mjs
```

长时间 Claude review 建议配置 Codex 侧 tool timeout：

```toml
[mcp_servers.ask-claude]
command = "npx"
args = ["-y", "ask-claude"]
startup_timeout_sec = 60
tool_timeout_sec = 900
```

server 不读取额外配置文件。它继承 MCP client 提供的环境变量，并把这些环境变量传给 Claude ACP adapter。如果你的网络需要代理，在 MCP client 环境里配置即可：

```toml
[mcp_servers.ask-claude.env]
ASK_CLAUDE_DEFAULT_MODEL = "opus"
ASK_CLAUDE_DEFAULT_EFFORT = "high"
HTTPS_PROXY = "http://proxy.example:8080"
HTTP_PROXY = "http://proxy.example:8080"
ALL_PROXY = "http://proxy.example:8080"
NO_PROXY = "localhost,127.0.0.1"
```

改完 MCP 配置后重启 Codex，让 stdio server 用新的环境变量重新启动。

## Tools

| Tool | 用途 |
| --- | --- |
| `ask_claude` | 启动或继续一个 Claude Code ACP 会话，用于讨论、review、找 bug 或继续复核分歧。 |
| `ask_claude_sessions` | 列出活跃和历史会话，包括上下文使用量、成本、最近活跃时间和 cache-cold 提示。 |

`ask_claude` 的关键参数：

| 参数 | 用途 |
| --- | --- |
| `prompt` | 发给 Claude 的消息。建议包含当前问题、review 重点、相关路径，以及希望 Claude 检查什么。 |
| `cwd` | Claude Code 应该使用的工作目录。 |
| `session_key` | 稳定的复用 key，例如 `review:<repo>:<branch>` 或 `discuss:<topic>`。 |
| `session_id` | 继续某个精确历史会话时使用的 session id。 |
| `reuse_policy` | `auto`、`always` 或 `never`。 |
| `model` / `effort` | 本次调用覆盖 Claude 模型和 reasoning effort。 |
| `permission_policy` | MCP 侧权限处理策略，默认是 `readonly`。 |
| `timeout_ms` | 本次 `session/prompt` 的 bridge 等待超时。 |

review prompt 示例：

```text
Review the current git diff for correctness bugs only. Please inspect the relevant files yourself from this workspace. Do not edit files. Return findings first, ordered by severity, with file paths and line references.
```

追问或反驳示例：

```text
I disagree with finding #2. In src/session.ts, createSession checks expiration before writing the token. Please re-check that control flow and either refine or withdraw the finding.
```

## 超时配置

bridge 默认给长 Claude prompt 和内部会话恢复 15 分钟。可以用环境变量覆盖：

```bash
ASK_CLAUDE_PROMPT_TIMEOUT_MS=15m
ASK_CLAUDE_RESUME_TIMEOUT_MS=15m
ASK_CLAUDE_LOAD_TIMEOUT_MS=15m
ASK_CLAUDE_INIT_TIMEOUT_MS=60s
ASK_CLAUDE_CONFIG_TIMEOUT_MS=60s
```

纯数字会被当作毫秒。也支持 `ms`、`s`、`m`、`h` 后缀。

`RESUME` 和 `LOAD` 不是公开 tool。它们是继续历史会话时使用的内部 ACP 方法：

- `session/resume`：Claude adapter 声明支持 resume 时优先使用。
- `session/load`：adapter 暴露 load 而不是 resume 时的兼容路径，也是 resume 不可用时的 fallback。

大多数用户可以把 `ASK_CLAUDE_RESUME_TIMEOUT_MS` 和 `ASK_CLAUDE_LOAD_TIMEOUT_MS` 设置成同一个值。

也可以给 `ask_claude` 单次调用传 `timeout_ms`。它只控制 bridge 等待 ACP 请求的时间；MCP client 仍然可能有自己的 tool-call timeout，例如 Codex 的 `tool_timeout_sec`。

## 配置

常用环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ASK_CLAUDE_DEFAULT_CWD` | MCP server 进程 cwd | `ask_claude` 省略 `cwd` 时使用的默认工作目录。 |
| `ASK_CLAUDE_REGISTRY_DIR` | `$HOME/.codex/ask-claude` | 本机会话 registry 目录。 |
| `ASK_CLAUDE_DEFAULT_MODEL` | 未设置 | 默认 Claude 模型，例如 `opus`、`sonnet[1m]`、`haiku` 或 `default`。 |
| `ASK_CLAUDE_DEFAULT_EFFORT` | 未设置 | 默认 reasoning effort，例如 `low`、`medium`、`high`、`xhigh`、`max` 或 `default`。 |
| `ASK_CLAUDE_DEFAULT_MODE` | 未设置 | 默认 Claude Code mode，例如 `default`、`plan` 或 `acceptEdits`。 |
| `ASK_CLAUDE_DEFAULT_PERMISSION_POLICY` | `readonly` | 默认 MCP 侧权限策略。 |
| `CLAUDE_ACP_COMMAND` | bundled adapter | 覆盖启动 Claude ACP adapter 的命令。 |
| `CLAUDE_ACP_ARGS` | bundled adapter entrypoint | adapter 参数的 JSON 数组。如果设置了 `CLAUDE_ACP_COMMAND` 但省略这个变量，则不传额外参数。 |

Codex 默认值示例：

```toml
[mcp_servers.ask-claude.env]
ASK_CLAUDE_DEFAULT_MODEL = "opus"
ASK_CLAUDE_DEFAULT_EFFORT = "high"
ASK_CLAUDE_DEFAULT_PERMISSION_POLICY = "readonly"
```

## 权限和隐私

默认 `readonly` 权限策略会拒绝 Claude Code 的编辑和 shell 命令权限请求，但允许正常的只读上下文收集。只有在你明确希望 Claude Code 编辑文件或运行命令时，才使用更宽的策略：

- `allow_edits`
- `allow_commands`
- `allow_edits_and_commands`
- `allow_all`

session registry 会在本机保存简短的 prompt 和 answer preview，用于会话选择。它不应该被提交或分享。

## 开发

MCP package 位于 `plugins/ask-claude`。

```bash
cd plugins/ask-claude
npm install
npm run smoke
```

smoke test 会启动 MCP server、列出 tools，并调用 `ask_claude_sessions`。它不会向 Claude 发送 prompt。
