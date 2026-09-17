# Codex / GPT-based agents — vendor notes

Codex reads `AGENTS.md` from the working directory. Working *in* the workbench
repository, there is nothing to do — the contract is that file. For any other
repository, paste [the portable block](README.md#the-portable-block) into that
repository's `AGENTS.md`. Nothing in this file is a rule; the rules are in the
contract.

## Sandboxing

Codex restricts network access by default. The board is on `127.0.0.1`, but a
strict sandbox may still block it. Either run with workspace-write and local
network permitted, or have the orchestrating process do the reads and writes and
hand the results to the agent in its prompt.

If you cannot open the socket at all, the fallback is the file route: the
orchestrator runs `bun run export`, passes the JSON, and applies changes back
with `bun run import`. That loses live updates and is a last resort.

`WB_TOOL=codex` (or `WB_ACTOR=<name>`) makes `bun run wb` sign as the entry the
human set in `settings.agentNames`.

## For plain ChatGPT or an API-driven agent with no shell

There is no localhost from a hosted model, so the pattern inverts: your own code
reads the board (`GET /api/projects/<slug>?status=needs-decision&messages=last`)
and puts the open items into the prompt, then writes any decisions back. The
board stays the record; the model never touches it directly.

```
Open items needing a decision:
1. [id abc123] Deploy to production — Production is 40 commits behind. Options: Do it / Hold
2. [id def456] Branches to delete — Two are from an earlier session. Options: Delete both / Keep both

Answer each as: <id> :: <option or free text>
```

Post each answer as a message with `who: "you"` and say in the text that it was
relayed — the contract forbids inventing a human reply, and a relayed answer
should be distinguishable from one typed into the board.
