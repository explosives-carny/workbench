# Codex / GPT-based agents

## One-time wiring

Codex reads `AGENTS.md` from the working directory, which is the same file this
repository already uses as its contract — so if you are working *in* the
workbench repo there is nothing to do.

For any other repository, add this to that repository's `AGENTS.md`:

```markdown
## Decisions go to the workbench

A local decision board runs at http://localhost:4317. Full contract:
<path-to-workbench>/AGENTS.md.

- Read `GET /api/projects/<slug>` at the start of a task. Anything at `received`
  has an answer waiting for you to act on.
- Create an item instead of asking a question you cannot persist. POST an array
  to create several at once.
- Post a message when you act, and set the status. Identify yourself with
  `author`.
- Other sessions write here too: pass `ifVersion` on edits, merge on 409, and
  prefer a message over an edit.
```

## Sandboxing

Codex runs with a sandbox that restricts network access by default. The board is
on `127.0.0.1`, but a strict sandbox may still block it. Either run with
workspace-write and local network permitted, or have the orchestrating process
do the reads and writes and hand the results to the agent in its prompt.

If you cannot open the socket at all, the fallback is the file-based route: the
orchestrator runs `bun run export`, passes the JSON, and applies any changes back
with `bun run import`. That loses live updates and should be a last resort.

## For plain ChatGPT or an API-driven agent with no shell

There is no localhost from a hosted model, so the pattern inverts: your own code
reads the board and puts the open items into the prompt, and writes any decisions
back afterwards. The board stays the record; the model never touches it directly.

```
Open items needing a decision:
1. [id abc123] Deploy to production — Production is 40 commits behind. Options: Do it / Hold
2. [id def456] Branches to delete — Two are from an earlier session. Options: Delete both / Keep both

Answer each as: <id> :: <option or free text>
```

Then post each answer as a message with `who: "you"` — and say in the text that
it was relayed, because the contract forbids inventing a human reply and a
relayed answer should be distinguishable from one typed into the board.
