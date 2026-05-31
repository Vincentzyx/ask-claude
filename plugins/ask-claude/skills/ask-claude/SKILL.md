---
name: ask-claude
description: Collaborate with Claude Code through the local ask-claude MCP server for second-opinion coding discussions, bug hunting, code review, and multi-turn disagreement resolution. Use when the user says to ask Claude, discuss with Claude, let Claude review, get Claude's opinion, compare Codex vs Claude reasoning, or run an independent Claude review of code/files/diffs.
---

# Ask Claude

Use the local `ask-claude` MCP server as a persistent bridge to Claude Code through ACP. Prefer this skill when Claude should act as a second reviewer or debate partner rather than as the primary editor.

## Core Workflow

1. Call `ask_claude_sessions` first unless the user clearly wants a fresh session.
2. Choose a stable `session_key` for the task, such as `review:<repo>:<branch>` or `discuss:<short-topic>`.
3. Reuse an active/recent Claude session when it matches the current task.
4. If an inactive session is older than 1 hour, treat provider prefix cache as likely cold. Resume it only when the saved history is valuable enough to justify the cost.
5. For review, use `ask_claude` and clearly prompt Claude to inspect the relevant files, git diff, or implementation area.
6. If the `ask_claude` tool call times out in Codex, call `ask_claude_sessions` and then `ask_claude_result` for the matching session; Claude may have completed in the background.
7. Compare Claude's findings against your own reading of the code. Do not blindly accept them.
8. If you disagree with a material point, call `ask_claude` again with the same `session_id` or `session_key`, and explain the disagreement with concrete code references.
9. Continue until there are no major unresolved disagreements, or until further debate is not adding signal.
10. Final answer should integrate both views and clearly mark which issues are confirmed, rejected, or uncertain.

## Tool Selection

- `ask_claude`: open or continue a discussion with Claude. Use it for review, bug hunts, second opinions, follow-up challenges, and disagreement resolution. Pass the current problem, relevant file paths, what you already inspected, and whether Claude should inspect the current diff.
- `ask_claude_sessions`: inspect active and remembered sessions, context usage, cost, last active time, and cache-cold recommendations.
- `ask_claude_result`: fetch a full stored answer for a previous Claude turn. Use it after client-side timeouts or when the session list preview is insufficient.

## Context And Cost

Read `usage` from tool results. Important fields:

- `used`: current Claude context tokens.
- `size`: Claude context window size.
- `remaining`: computed remaining context.
- `percent`: context utilization.
- `cost`: cumulative session cost when reported by the adapter.

Heuristics:

- Under 75%: normal.
- 75-90%: keep prompts focused.
- 90-95%: avoid adding large file dumps; consider summarizing or starting fresh.
- Over 95%: prefer a new session or explicit handoff summary.
- Older than 1 hour: assume prefix cache may be cold, even if the conversation can be resumed.
- Older than 1 hour and over 50k tokens: inspect `ask_claude_sessions` carefully before resuming.

## Review Discipline

For review prompts, ask Claude for concrete bugs first:

```text
Review the current change for concrete correctness issues, behavioral regressions, security risks, data loss, races, and missing tests. Please inspect the relevant files and git diff yourself. Do not edit files. Return findings first, ordered by severity, with file paths and line references.
```

When disagreeing, be specific:

```text
I disagree with finding #2. In path/to/file.py, line 123 already checks X before Y, so the null path seems unreachable. Can you re-evaluate that control flow and either refine or withdraw the finding?
```

Stop debating when:

- Claude withdraws or refines the questionable claim.
- You can confirm the issue locally.
- The remaining disagreement depends on missing runtime evidence; then run tests or inspect more code.

## Permissions

Default to `permission_policy: "readonly"` for review and discussion. This allows Claude to use normal read context but rejects edits and command execution permission requests. The MCP server may also be configured with `ASK_CLAUDE_DEFAULT_PERMISSION_POLICY=readonly`.

Only use edit-capable policies when the user explicitly asks Claude to patch:

- `allow_edits`: allow edit/write requests, still reject shell commands.
- `allow_commands`: allow command requests, reject edits.
- `allow_edits_and_commands` or `allow_all`: use only in isolated sandboxes.

When Claude proposes a patch, Codex should still inspect and apply the final change locally rather than treating Claude's edit as automatically correct.

## Reference

For MCP server details, ACP message shapes, timeout configuration, and troubleshooting notes, read `references/mcp-tools.md` only when needed.
