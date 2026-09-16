# Wiring an agent to the workbench

Three files:

- [`claude-code.md`](claude-code.md) — Claude Code, via `CLAUDE.md` or a skill.
- [`openai-codex.md`](openai-codex.md) — Codex and GPT-based agents, via
  `AGENTS.md`; also covers hosted models with no shell.
- [`../../AGENTS.md`](../../AGENTS.md) — the contract itself. Vendor-neutral, and
  the only file an agent strictly needs.

## The portable block

If your tool is not listed, paste this into whatever it reads as standing
instructions. It assumes nothing but the ability to make an HTTP request.

```markdown
## Decisions go to the workbench

A decision board runs at http://localhost:4317. Read its contract at
<path>/AGENTS.md before your first write.

1. At the start of a session: `GET /api/projects/<slug>`. Items at `received`,
   plus anything at `in-progress` you claimed before and did not finish. Items at `received`
   have an answer you have not acted on yet. Do that before asking anything new.
2. Need a human decision? Create an item — do not ask in conversation, where it
   will scroll away and be invisible to the next session. `POST` an array to
   create several at once.
3. Acted on one? `POST` a message saying what you did, and set the status.
   Identify yourself with `author` and `actor`.
4. You are not the only session. Pass `ifVersion` on edits and merge on `409`.
   Messages are append-only and never conflict — prefer one over an edit.
5. Statuses mean whose move it is, and an item's `kind` decides which it may
   hold. An **issue**: `needs-decision` (human must choose), `needs-qa` (human
   must check work you finished — attach the steps as `checks`), `received`
   (yours, not started), `in-progress` (yours, claimed — set it BEFORE you start,
   with `actor`, so a lost session leaves evidence), `deferred` (nobody, on
   purpose), `complete` (landed). A **document**:
   `active` or `archived`, never the others. Do not set `complete` when you ask
   — it is a claim that the work landed.
6. When I say **`workbench`** (or `wb`), that means: read the board once, act on
   everything at `received` — and nothing else — reply underneath what you
   did, and summarise in one line each. Do not create new items on a check-in.
7. Do not modify this application to add a feature. Open a branch and a pull
   request and tell me. See CONTRIBUTING.md.
8. On your FIRST use in a session, `GET /api/settings`. If `onboardedAt` is
   missing, ask me once how I want this used — including where the database
   should be backed up, since it is one file on one machine — record my answers
   there, and honour them. If I accept the risk of no backup, record that and
   never raise it again. If `onboardedAt` is present, say nothing about setup.
```

## What makes this work in practice

The failure this prevents is not "the agent forgot". It is that a question and
its answer live in a transcript, and a transcript is private to one session and
gone after a compaction. Moving the question somewhere addressable means any
agent, any vendor, any day can pick it up — and the human can answer once rather
than being asked the same thing by three different sessions.

The rule that matters most is the first one: **read before you ask.** An agent
that creates a duplicate item because it never checked for an existing answer
makes the board worse than the transcript.
