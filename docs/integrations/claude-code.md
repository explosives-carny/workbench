# Claude Code — vendor notes

Paste [the portable block](README.md#the-portable-block) into `CLAUDE.md` — the
project one if the workbench is for a single repository, `~/.claude/CLAUDE.md`
if every session should use it. Nothing in this file is a rule; the rules are in
`AGENTS.md`.

## As a skill

A skill keeps the wiring out of every prompt and loads it when it is needed.
Make it a **pointer, not a copy**: the skill reads `AGENTS.md` from the
workbench repository at invocation, so every model on the machine follows one
source and a contract change never leaves a stale copy behind.

```markdown
---
name: Workbench
description: Pointer to the local decision board and its vendor-neutral contract. USE WHEN wb, workbench, check-in, decision board.
---
1. Read <path-to-workbench>/AGENTS.md now. Do not work from memory of it.
2. Follow its cheat sheet. `wb` = one round; `wb --auto` / `wb --scope <slug>` are session working orders.
3. Sign as settings.agentNames["claude-code"], else `claude-code`.
```

## Permissions

The calls are `curl` or `bun run wb` against `localhost`. If your setup prompts
on every shell command, allow-list the base URL once rather than approving each
call — being asked fourteen times to post fourteen items is how people stop
using the tool.

## Harness notes

- Sessions are frequently compacted. That is the strongest reason to use the
  board: a question asked before a compaction is gone from your context, still
  on the board, still unanswered — and the claim you set before starting is the
  only evidence a compacted session leaves.
- A background or delegated agent can write to the board too. Give it its own
  entry in `settings.agentNames` (or `WB_ACTOR`) so the thread shows which one
  spoke. Two agents on one board should be scoped to different projects
  (`wb --scope <slug>`); a comment on the other agent's item never claims it,
  but answering there takes work out from under them.
- `WB_TOOL` is detected as `claude-code` when the `CLAUDECODE` environment
  variable is set, so `bun run wb` signs correctly without configuration.
