# Wiring an agent to the workbench

One block, for every tool. The contract is `AGENTS.md` in the workbench
repository; nothing here restates a rule from it — a second copy is the thing
that drifts, and the Claude Code copy did, describing a two-call pattern the
contract had already retired.

- **The portable block** below goes into whatever your tool reads as standing
  instructions: `CLAUDE.md`, a repository's `AGENTS.md`, `.cursorrules`, custom
  instructions.
- **Vendor notes** — the bits that differ per tool — are one short file each:
  [`claude-code.md`](claude-code.md), [`openai-codex.md`](openai-codex.md).

## The portable block

```markdown
## Decisions go to the workbench

A decision board runs at http://localhost:4317. Its contract is
<path-to-workbench>/AGENTS.md. Read that file once per session before your first
write, and follow its first screen exactly — the cheat sheet is the whole
working contract. `GET /api` tells you the contract version; re-read the file
when it changes.

- Decisions I must make go on the board as items, not in this conversation,
  where they scroll away and the next session cannot see them.
- When I say `wb` (or `workbench`), that is the check-in word from the
  contract: read the board once, act on everything at `received`, reply under
  each, one line each. `wb --auto` and `wb --scope <slug>` are working orders
  for this session only.
- Sign every write as the name in `settings.agentNames` for your tool.
- Do not modify the workbench application to add a feature. Branch and open a
  pull request per its CONTRIBUTING.md, then tell me.
- If the board is not running, start it (`bun run start` in the workbench
  repository) rather than falling back to asking here.
```

If you have a shell, use the `wb` command (`bun run wb` in the workbench
repository, or put it on your PATH) — it encodes the contract's rules so the
common calls cannot be made wrong.

## What makes this work in practice

The failure this prevents is not "the agent forgot". It is that a question and
its answer live in a transcript, and a transcript is private to one session and
gone after a compaction. Moving the question somewhere addressable means any
agent, any vendor, any day can pick it up — and the human can answer once rather
than being asked the same thing by three different sessions.

The rule that matters most: **read before you ask.** An agent that creates a
duplicate item because it never checked for an existing answer makes the board
worse than the transcript.

## When the person corrects the agent

The contract asks every agent to keep a correction against it in its own
persistent memory (`AGENTS.md` → *When you are corrected*), and to fix the
contract when the rule was unclear. What "persistent memory" is depends on the
harness, and the contract deliberately does not prescribe it. Examples of where
tools tend to keep such facts, so the agent recognises its own:

- **Claude Code** — the per-project auto-memory directory (`MEMORY.md` plus one
  file per fact, type `feedback`), which is loaded into every session.
- **Codex** — notes in the repository's `AGENTS.md` or a file it is told to
  reload; there is no hidden store, so the file has to be one the next run reads.
- **Hosted or API-driven agents** — whatever store the orchestrating code keeps
  and prepends to the prompt; if there is none, the correction belongs in the
  contract PR alone, and the orchestrator should grow a store.

The shape of the record matters more than the place: what was done, what the
person said in their words, and the check that would have caught it. The
vendor notes below say one line each about where that lives.
