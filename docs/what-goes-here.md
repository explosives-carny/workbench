# What belongs on the board, and when to put it there

`AGENTS.md` says how to call the API. This says what to create, when, and how to
divide it up — the part an agent has to get right for the board to stay useful
rather than becoming a second inbox nobody reads.

## The test for whether something belongs here

**Does a human have to see it, and would losing it cost something?**

If yes, it goes on the board. If it is a note to yourself, it belongs in your
own working notes. If it is a fact about the code, it belongs in the code.

The board is not a task tracker and not a log. It is the place where work waits
on a person.

## How to segment projects

**One project per thing a person thinks of as one thing.** Usually one
repository, one product, or one engagement. The test is whether a single "what
is waiting on me?" question makes sense across all of it.

Segment further only when the answer is genuinely different:

| Split into its own project when | Keep it as a section when |
|---|---|
| A different person answers it | The same person answers, different topic |
| It has its own lifecycle and end date | It ends when the parent ends |
| You would archive it separately | You would archive them together |
| The lists never need reading together | You triage them in one sitting |

**Sections, not projects, are for grouping inside a body of work.** "Ship it",
"Design", "People and access" are sections. A project per section produces a
gallery nobody scans and a decision nobody finds.

Signs you split too finely: projects with two items; a gallery that needs
scrolling; the same decision posted twice because it was unclear where it lived.

Signs you split too coarsely: one project where half the items are irrelevant to
whoever is looking; sections doing the work a project should.

## The four kinds of item

### 1. A decision — the core case

Something you cannot proceed on without a person choosing. Give it `options`
when the choice is genuinely closed, and leave them off when it is open.

Create one the moment you know you need it, not when you reach it. A decision
posted early can be answered while you work on something else; a decision posted
at the moment you are blocked makes the human the bottleneck.

**Write the context so it can be answered without you in the room.** Name the
tradeoff, name what you would do, and say what happens either way. "Which
database?" is not answerable. "Postgres or SQLite — SQLite unless you expect
more than one writer, which I do not; going the other way costs a day" is.

### 2. A document — a thing to read

A walkthrough, a specification, a review, a proposal. It has a `body` and
usually little context.

Prefer `bodyFormat: "markdown"`. It renders in the board, reads fine as plain
text through the API, diffs in a content repository, and costs nothing to
produce. Use `html` only for something that genuinely needs its own design —
imported HTML is rendered in a sandbox with scripts disabled, so anything that
builds itself at runtime will show up blank.

Split a document into items only if each part is separately actionable. A
41-step walkthrough is one document; the two defects it uncovered are two items.

### 2b. A checklist — a document whose steps are each answerable

A QA walkthrough, a release runbook, an audit. It reads like a document but it
is *worked*: somebody goes step by step and records what happened to each one.

Use `checks` rather than `body` alone:

```bash
curl -s localhost:4317/api/projects/<slug>/items \
  -H 'content-type: application/json' \
  -d '{
    "title": "Cycle Count QA walkthrough",
    "context": "41 steps. Your sign-off becomes the record.",
    "section": "Documents",
    "bodyFormat": "markdown",
    "body": "# Full instructions...\n",
    "checks": [
      {"id": "step-1", "label": "1. Check the ports are free"},
      {"id": "step-2", "label": "2. Start the review server"}
    ]
  }'
```

Each step records `result` (`pass` / `fail` / `skip` / empty), a `note`, who and
when. Answer one at a time:

```bash
curl -s -X PATCH localhost:4317/api/items/<id>/checks/step-7 \
  -H 'content-type: application/json' \
  -d '{"result":"fail","note":"Counted column shows dashes","by":"sam"}'
```

**One step at a time, never the whole array.** The endpoint exists precisely so
a person walking the checklist and an agent writing to the same item cannot
overwrite each other.

**When to reach for this instead of separate items:** the steps share one
context and one sign-off, and nobody would triage them individually. Forty-one
steps as forty-one items buries every real decision on the board. Conversely, if
two of those steps turn into defects somebody must schedule, *those* become
their own items — the checklist records what happened, the items carry the work.

Empty result is not the same as a failure. A step nobody reached must be
distinguishable from a step that was tried and failed, or the sign-off is a
guess.

### 3. A finding — something you discovered that they do not know

A defect, a risk, a surprise in production. It belongs here rather than in
conversation when it changes what somebody would decide, and when it will still
be true tomorrow.

State what is wrong, what it costs, and what you propose. If you already fixed
it, it is not a finding — it is a message on whatever item it belonged to.

### 4. A standing question — parked, not dead

Something real that nobody is acting on. Set it `deferred` and **say in the
thread what would bring it back**. A deferred item with no trigger is just a
question you gave up on, and it will be re-asked in three weeks.

## When to create, and when not to

**Create** when you need a decision; when you produce something to be read; when
you find something that changes the picture; when a question will outlive this
session.

**Do not create** for a question you can answer by reading the code; for
something you will resolve in the next five minutes; for progress narration —
that is what messages on an existing item are for; or for a decision already
made, which you should be *acting on*, not re-asking.

**One item per question.** Two decisions in one item means one of them gets
answered and the other is silently lost.

## Rhythm

- **Start of a session:** read the project. Act on everything at `received`
  before you create anything new. An agent that asks a fresh question while
  ignoring yesterday's answer teaches people to stop answering.
- **While working:** post a message when you act on a decision. The thread is
  the record of why the code looks the way it does.
- **End of a session:** make sure nothing you finished is still sitting at
  `received`, and nothing you are waiting on is still at `needs-you` without the
  context somebody would need to answer it.

## Writing for the person reading it

They may open this hours later, on a phone, having forgotten the conversation.

- The title is the question, not a topic. "Deploy to production?" beats
  "Deployment".
- Recommend something. "Here are four options" moves the work to them; "B,
  because X, unless you care about Y" leaves them a decision rather than a
  research task.
- Say what it costs to be wrong. That is usually the only thing that determines
  how long they think about it.
- Do not write "let me know if you have questions." They know.
