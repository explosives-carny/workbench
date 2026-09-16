# Claude Code

## One-time wiring

Add this to your `CLAUDE.md` — the project one if the workbench is for a single
repository, or `~/.claude/CLAUDE.md` if you want every session to use it.

```markdown
## Decisions go to the workbench, not the transcript

There is a local decision board at http://localhost:4317. Its contract is in
`AGENTS.md` in the workbench repository; read it once per session before using
the API.

- At the START of a session, read what the human has answered since you last
  ran: `curl -s localhost:4317/api/projects/<slug>`. Act on anything at
  `received` before asking anything new.
- When you need a decision, create an item rather than asking in conversation.
  Questions asked in the transcript scroll away and the next session cannot see
  them. Post an array to create several at once.
- When you act on a decision, post a message on that item saying what you did,
  then set the status. The thread is the record.
- Assume other sessions are writing at the same time. Pass `ifVersion` on edits
  and merge on 409. Prefer appending a message over editing an item.
```

Replace `<slug>` with the project you created, or drop the slug and let the
session look it up from `/api/projects`.

## As a skill

If you prefer it explicit rather than ambient, put the same thing in
`~/.claude/skills/Workbench/SKILL.md` and invoke it by name. A skill keeps the
instructions out of every prompt and loads them when you actually need them.

## Permissions

The calls are plain `curl` to `localhost`. If your setup prompts on every shell
command, allow-list the base URL once rather than approving each call — being
asked fourteen times to post fourteen items is how people stop using the tool.

## Notes specific to this harness

- Claude Code sessions are frequently compacted. That is the strongest reason to
  use the board: a question you asked before a compaction is gone from your
  context, but it is still on the board and still unanswered.
- A background or delegated agent can write to the board too. Give it a distinct
  `author` so the thread shows which one spoke.
