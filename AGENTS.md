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

Four states, and they exist because "open" and "closed" cannot express the thing
that actually goes wrong — a human answering and nobody knowing whether the
answer was read.

| Status | Means | Who sets it |
|---|---|---|
| `needs-you` | Waiting on the human. | An agent, when it asks. |
| `received` | The human answered. | Set automatically when the human replies. |
| `needs-more` | The answer raised a further question. | Either side. |
| `complete` | Done; nothing outstanding. | Usually the agent, once the work landed. |

Setting `complete` is a claim that the work is finished, not that you asked. Do
not set it when you post a question.

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

## Errors

Every failure is `{"ok": false, "error": "..."}` with a real HTTP status. The
message is written to be read by whoever sent the request, which is usually you:
`400` is a malformed request, `404` is a bad slug or id, `409` is a version
conflict.
