# Working with the workbench

This file is the contract. Any coding agent, any vendor, any session can follow
it — the interface is plain HTTP and JSON, and nothing here depends on which
model you are or which tool is driving you.

Base URL: `http://localhost:4317` (override with `WORKBENCH_PORT`).

## What this is for

You are usually asking a human for decisions inside a conversation. That has two
failure modes and this tool exists to remove both.

The first is that questions get lost. A long session scrolls, and a question
asked forty tool calls ago is gone even though it is still unanswered. Here, an
open item stays open and visible until somebody closes it.

The second is cost and continuity. Re-reading a large document to change one
line is expensive, and the next session cannot read your conversation at all.
Items are small, addressable and durable — you read only what you need, and a
decision made on Monday is still readable by a different agent on Friday.

## The model

**Project** — one body of work. `slug` is its address.
**Item** — one thing needing a decision, an answer or a status. It holds a
title, context, optional choice buttons, a status, and a thread.
**Message** — one turn in that thread, from `you` (the human) or an `agent`.

### Status vocabulary

Four states, chosen so that no two overlap. Each answers one question: **whose
move is it?**

`received` exists because "open" and "closed" cannot express the thing that
actually goes wrong — a human answering and nobody knowing whether the answer
was read.

| Status | Means | Who sets it |
|---|---|---|
| `needs-you` | Waiting on the human. | An agent, when it asks. |
| `received` | The human answered. | Set automatically when the human replies. |
| `deferred` | Parked on purpose — waiting on neither of us. | Either side, with a reason in the thread. |
| `complete` | Done; nothing outstanding. | Usually the agent, once the work landed. |

Setting `complete` is a claim that the work is finished, not that you asked. Do
not set it when you post a question.

Do not reach for `deferred` to mean "still waiting on them" — that is
`needs-you`. It means the decision was consciously parked, and the thread should
say what would bring it back.

## The calls

Create a project (idempotent by slug — re-running your own setup is safe):

```bash
curl -s localhost:4317/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"Acme Site","description":"Dispatch and inventory tooling"}'
```

Add items. **Post an array to create a whole set in one call** — this is the
shape you want at the start of a piece of work, and doing it one request at a
time is how half-built lists happen when something fails in the middle:

```bash
curl -s localhost:4317/api/projects/acme-site/items \
  -H 'content-type: application/json' \
  -d '[
    {"title":"Deploy to production","context":"Prod is 200 commits behind.","options":["Do it","Hold"],"section":"Ship it"},
    {"title":"Branches to delete","context":"Eight are contained in test; two are yours.","options":["Delete both","Keep both"],"section":"Ship it"}
  ]'
```

Read what is waiting. This is the call to make at the **start of a session** —
it is small, and it tells you what the human has answered since you last ran:

```bash
curl -s localhost:4317/api/projects/acme-site
```

Reply in a thread, and acknowledge:

```bash
curl -s localhost:4317/api/items/<id>/messages \
  -H 'content-type: application/json' \
  -d '{"who":"agent","author":"forge","text":"Deployed as revision 00225. Verified the served bundle matches the commit."}'
```

Change status or record the decision you acted on:

```bash
curl -s -X PATCH localhost:4317/api/items/<id> \
  -H 'content-type: application/json' \
  -d '{"status":"complete","actor":"forge","ifVersion":4}'
```

Record one step of a checklist (see `docs/what-goes-here.md` for when to build
one):

```bash
curl -s -X PATCH localhost:4317/api/items/<id>/checks/step-7 \
  -H 'content-type: application/json' \
  -d '{"result":"fail","note":"what happened","by":"sam"}'
```

## Concurrency — read this before you write

**Assume you are not the only session.** Another agent, another terminal, and
the human's browser may all be working on the same project at the same moment.

- **Messages are append-only and never conflict.** Posting one is always safe.
  Prefer a message over editing an item when you are recording something that
  happened.
- **Item edits can conflict.** Pass `ifVersion` with the `version` you last read.
  If the item moved on, you get `409` with `conflict: true` and the **current
  item attached** — merge onto that and retry. Do not re-read and blind-write;
  that is the same race with extra steps.
- Omitting `ifVersion` is allowed and means last-write-wins. Only do that when
  you are the one who just created the item.
- Identify yourself with `author` on messages and `actor` on edits. When two
  sessions are working, "who changed this" is the first question a human asks.

## First use in a session — ask, then remember

**Before anything else, read the settings:**

```bash
curl -s localhost:4317/api/settings
```

If `onboardedAt` is absent, this human has never been asked how they want this
used. Ask — once, in the conversation, in one short message — and record the
answers. Do not assume, and do not ask again in a later session.

Offer these, with your recommendation, and accept "all of it" or "none of it" as
answers:

| Setting | The question | Default if they do not care |
|---|---|---|
| `autoCapture` | Should I put decisions on the board automatically, or only when you ask? | `true` — automatic |
| `checkInOnStart` | Should I read the board at the start of every session without being asked? | `true` |
| `postFindings` | Should defects and risks I discover go on the board, or stay in conversation? | `true` |
| `summariseOnExit` | Should I post what I did before I finish? | `false` |
| `defaultProject` | Which project should new items land in? | ask, or infer from the repository |

Record what they said, including the refusals — a `false` is an instruction and
must survive the session as clearly as a `true`:

```bash
curl -s -X PATCH localhost:4317/api/settings \
  -H 'content-type: application/json' \
  -d '{"onboardedAt":"2026-09-16T20:15:00Z","autoCapture":true,"checkInOnStart":true,"postFindings":true,"summariseOnExit":false,"defaultProject":"acme-site"}'
```

Then **honour them**. An agent that asks the question and then behaves the same
way regardless has made the onboarding worse than useless: it spent the human's
attention and changed nothing.

If `onboardedAt` is present, say nothing about setup. Read the settings, follow
them, and get on with the work.

## The check-in word

The human says **`workbench`** (or `wb`) and it means exactly one thing:

> Read every project I am working on, find items where the last word was mine,
> act on them, and reply underneath what you did.

Concretely:

```bash
curl -s localhost:4317/api/projects
curl -s localhost:4317/api/projects/<slug>
```

For each item whose newest message has `who: "you"`, or whose `choice` changed
and has no agent reply after it: do the work, post a message saying what you
did, and set the status. Report back a one-line summary per item — not the full
threads, which they just wrote.

If nothing is waiting, say so in one line. Do not create new items on a
check-in; it is a command to catch up, not to ask.

This word exists because the alternative is the human re-typing a decision they
already recorded, which is the exact failure the board removes.

## Rules that keep this useful

1. **Ask once, in one item.** Do not restate a pending question in conversation;
   the point is that it lives here.
2. **Write context the human can act on without you.** They may read it hours
   later in a different session. Name the tradeoff and give a recommendation.
3. **Answer underneath.** When you act on a decision, post a message saying what
   you did. The thread is the record.
4. **Do not invent a human reply.** Only post `who: "you"` when relaying
   something the human actually said, and say so in the text.
5. **Close what you finish.** An item left at `received` forever is as bad as a
   lost question.
6. **Do not change this application to add a feature.** A limitation is a pull
   request, not an edit to the copy in front of you — see
   [`CONTRIBUTING.md`](CONTRIBUTING.md). Most "I need a new type" is a section,
   a status or a document body; [`docs/what-goes-here.md`](docs/what-goes-here.md)
   says which.

## Deciding what to create

[`docs/what-goes-here.md`](docs/what-goes-here.md) is the companion to this
file: what belongs on a board, the four kinds of item, when to create one and
when not to, and how to segment projects rather than splitting them so finely
that nobody scans the gallery. Read it once before your first write.

## Errors

Every failure is `{"ok": false, "error": "..."}` with a real HTTP status. The
message is written to be read by whoever sent the request, which is usually you:
`400` is a malformed request, `404` is a bad slug or id, `409` is a version
conflict.
