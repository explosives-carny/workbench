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

## How a board is organised

**The default, and what a new project gets:**

| Field | Answers | How many |
|---|---|---|
| `status` | whose move is it | exactly one — and it groups the board |
| `kind` | is this a task or something to read | exactly one |
| `labels` | how does this relate to other items | any number, including none |

Rows group by status: **Open · Deferred · Documents · Archived**. Newest activity
first within each group, and a group with nothing visible does not appear at all.

That is deliberately the shape of the question a board is for. "What is waiting
on me" is answered by the layout itself rather than by reading down a list, and
nobody has to invent a taxonomy on their first day to get there.

**Labels do the relating.** They are the field for the things one axis cannot
express — three items that are one release, two blocked on the same person, the
four that all touch one subsystem. Any number per item, nothing governs them on
the way in beyond trimming and case-folding, and a label exists exactly as long
as an item carries it.

Reuse before you invent: `GET /api/projects/<slug>` returns `labels` with counts
for exactly that reason. Because nothing polices them, they rot faster than
sections do, and the repair (`PATCH /api/projects/<slug>/labels`) is not an
afterthought — merging two labels that turned out to be one is normal
maintenance, not an admission of failure.

### Sections, if you want the board grouped by area of work instead

Fully supported, and the right answer for some work — an agency board where the
client is the first thing you need to see, a repository where the subsystem
matters more than the state. Switch with
`PATCH /api/projects/<slug> {"groupBy":"section"}`.

Everything below applies when you do.

**A section is the AREA OF WORK. Never the kind of item, never its state.**

This is the rule that has to be stated, because it is the one that decays. Three
different agents on the same board will each reach for a different axis, and
after a month the field means nothing. On the reference board it went wrong
exactly that way: decisions were filed by topic ("Ship it", "Design"), imported
material by kind ("Documents", "Design records"), and migrated history by state
("Settled", "Shipped") — three axes in one field, two of which duplicated
information the item already carried.

They duplicated it because:

| Tempting section | Already answered by |
|---|---|
| "Documents", "Specs", "Notes" | `kind` — it is a document or it is not |
| "Checklists" | `checks` — it has steps or it does not |
| "Done", "Shipped", "Settled", "Archive" | `status` |
| "Waiting on Billy", "Blocked" | `status` |
| "Release 3", "blocked on Ops" | `labels` — that is what they are for |
| "Urgent" | say so in the context, or do it |

So: **name the part of the work, not the shape or the stage of the item.**
Good sections read like the areas somebody would say out loud — `Ship it`,
`Design`, `People and access`, `Housekeeping`, `Cycle count`, `Magazine flip`.

### Two modes, because this is genuinely a preference

Neither answer is right for everybody, so the human picks at onboarding and the
project records it.

**Loose (`adhoc`, the default).** Any section is accepted. When a new one looks
like a near-duplicate of one already in use, the response carries a `warning`
naming the likely intended section. Nothing is blocked.

Right when the work is new. You rarely know the areas on day one, and a
taxonomy guessed up front is usually wrong in a way that is then expensive to
admit. Let it emerge over a fortnight and tidy it once the shape is obvious.

**Fixed (`declared`).** Only the project's declared sections are accepted;
anything else is refused with the allowed list and instructions for proposing an
addition.

Right for long-running or shared work, where consistency is worth more than
convenience and several agents write to the same board. It is also the honest
choice if you have been burned once — the refusal is what actually stops drift,
where a warning only reports it.

```bash
PATCH /api/projects/<slug> {"sectionMode":"declared","sections":["Ship it","Design"]}
```

Switch whenever. Going loose→fixed does not retroactively refuse existing
sections; declare the ones you want to keep and merge the rest.

### Repair, in both modes

A vocabulary that cannot be repaired only gets worse, so the merge is part of the
design rather than an admin afterthought:

```bash
PATCH /api/projects/<slug>/sections {"from":"Deploys","to":"Ship it"}
```

Every item moves, each one's version bumps, and a declared list is updated to
match. Merging into `""` unsections the items rather than deleting them.

### Choosing one, as an agent

1. `GET /api/projects/<slug>` and read the sections already in use. **Reuse one.**
   A near-synonym ("Deploys" beside "Ship it") is the failure mode — you have
   split one area into two and neither list is complete now.
2. Only invent a section when the item genuinely belongs to no existing area,
   and then name it after the area, not the item.
3. Leave it empty rather than guessing. An unsectioned item sorts to the top and
   somebody will place it; a wrongly-sectioned one is filed and invisible.
4. Six to eight sections is a working board. Past a dozen, the grouping has
   become a second status field and needs collapsing.

**Sections, not projects, are for grouping inside a body of work.** A project per
section produces a gallery nobody scans and a decision nobody finds.

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

**Give it `active` or `archived`, never `complete`.** A document is not a task:
it is never waiting on anybody and never finished, only current or superseded.
Filing one as `complete` puts it behind the completed filter on the day it is
written, which is how a board ends up hiding the material people actually read.

`active` while somebody still works from it. `archived` once the thing it
describes has shipped, or a newer document has replaced it. Moving one to
`archived` is not a demotion — it is how the board says "this is history",
which is a useful thing for it to be able to say.

A walkthrough, a specification, a review, a proposal. It has a `body` and
usually little context.

Prefer `bodyFormat: "markdown"`. It renders in the board, reads fine as plain
text through the API, diffs in a content repository, and costs nothing to
produce. Use `html` only for something that genuinely needs its own design —
imported HTML is rendered in a sandbox with scripts disabled, so anything that
builds itself at runtime will show up blank.

Split a document into items only if each part is separately actionable. A
41-step walkthrough is one document; the two defects it uncovered are two items.

### 2b. A checklist — steps on the thing they verify

**QA steps belong on the item that is in QA, not in a runbook of their own.**

When you finish work somebody must approve, set that item to `needs-qa`, attach
its `checks`, and say in the thread what changed. Another person — or another
agent — can then open the board, find it, and work it without reading anything
else.

The old pattern was a standalone QA document covering everything at once. It
failed in three ways, all of which showed up on the first real run: a forty-one
step walkthrough went stale the moment one of the eight things it covered
changed; twenty-four of its steps were blocked by an environment assumption
baked into step one; and every item on the board pointed at the runbook instead
of saying anything itself. Steps on the item avoid all three, because each set
is small, current, and owned by the change it belongs to.

A standalone checklist is still right for something that genuinely is one
procedure — a release runbook, an audit with a single sign-off. It is not right
for "here is everything we did this week".

#### Writing a step somebody else can actually execute

This is the part that goes wrong, and it goes wrong the same handful of ways
every time. Two rounds of real QA on the reference board produced 30 skipped and
4 falsely-failed steps, and **not one of them was a defect in the product.** Every
one was a defect in the instruction.

A QA worker has your item and nothing else. Not your session, not your terminal,
not the conversation where you decided any of this.

**State the precondition, or make step 1 reach it.** The single biggest cost:
one walkthrough assumed a second signed-in identity that no step told anybody to
create, and twenty steps were unrunnable because of it. If three steps share a
setup, that setup is step 1 — with the command, the URL and how to tell it
worked.

**Never write a step the system's own rules make unreachable.** One step asked
the worker to assign a recount and then take it themselves; the next step
asserted the system refuses assigning a recount to that person. The two tested
the same wall from opposite sides and one could not be reached. Walk your own
preconditions against your own rules before you write the step.

**Name what will be on screen.** "Confirm it works" and "nothing changed
visually" cannot be answered — there is no baseline in the worker's head. Give
the string, the number, the row: *"the banner reads 'Lot saved'"*, *"Record 0 /
Counted 3 / Delta 3"*, *"the thumb is dark against the orange track"*.

**When a refusal is the pass, say so in the step.** Otherwise a correct refusal
gets recorded as a failure, which is the most expensive mistake on this list —
somebody goes looking for a bug that is working.

**Ask only for what the worker controls.** Not the operating system's appearance
setting. Not a second person. Not a device they do not have. If the check needs
it, say what to do when it is unavailable, so the step records a reason rather
than a shrug.

**Never ask QA to touch production, and never ask them to edit source.** "Run a
production deploy" is not a QA step, it is a production action. "Add a duplicate
and confirm the test fails" is not a QA step either — that is a unit test, and it
belongs in the suite where it runs every time rather than once, by hand, on
somebody's afternoon.

**Say how to know the environment is current.** A QA environment that can serve
yesterday's build manufactures findings. If a rebuild, a restart or a pull is
required, that is step 1 — and the step says how to confirm it took.

**Delete steps when the feature goes.** A step testing something that has been
removed is worse than no step: it reads as a real gap and costs a real
investigation.

**One step, one observation.** If answering it needs three things to be true
first, those are three steps.

#### The mechanics either way

A QA walkthrough, a release runbook, an audit. It reads like a document but it
is *worked*: somebody goes step by step and records what happened to each one.

Use `checks` rather than `body` alone:

```bash
curl -s localhost:4317/api/projects/<slug>/items \
  -H 'content-type: application/json' \
  -d '{
    "title": "Release QA walkthrough",
    "context": "12 steps. Your sign-off becomes the record.",
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
  -d '{"result":"fail","note":"Column renders empty","by":"sam"}'
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

## Claiming, and why a status for it exists

There is a status for "somebody is working on this right now", and it is there
for one failure: **the work being triggered by a human reply landing in a live
session.**

That trigger is fine until the session ends badly. An outage, a crash, a context
reset, a laptop closing — and the reply has already been read, the item already
says `received`, and the thing that was going to act on it is gone. Nothing on
the board is wrong, exactly; it just quietly describes work nobody is doing.

So: **claim it before starting.** Set `in-progress` with your own name, and post
a message saying what you are about to do. The status makes the claim visible and
the message makes it recoverable — by somebody else, or by you after a reset,
with none of the context you had a minute ago.

Two properties do the work, and neither needs a lock table or a heartbeat:

- **`updatedBy` says who.** Without it, a survivor cannot tell an abandoned claim
  from somebody else's live work, and will either duplicate the effort or leave
  it forever.
- **`updatedAt` says when.** A claim older than your session began is a claim
  whose owner is not here any more.

There is deliberately no fixed timeout. "Older than my session started" is
answerable without a number everyone has to agree on, and it is the question
that actually matters: is anybody still around who could be doing this.

Reclaiming somebody's stale claim is normal. Doing it silently is not — say in
the thread whose claim you took and why, because the alternative is two agents
discovering each other through a merge conflict.

**And move it off when you stop**, whichever way it went. An item left at
`in-progress` by somebody who wandered away is worse than one never claimed: it
reads as covered.

## Status is whose move it is, not how hard you worked

The mistake is easy and it is always the same one: finishing a piece of work and
marking the item `complete` because *you* are done with it.

`complete` means it landed — merged, deployed, in the hands of whoever needed
it. Work sitting in an open pull request is `received`: you still own it, and
the person scanning the board needs to know it is not finished. Say what it
waits on in the thread, or `received` starts reading as `forgotten`.

The mirror of that mistake is leaving something at `received` when the human is
the one doing it. `received` claims you are working; if they are, the move is
theirs and the status is `needs-decision` or `needs-qa`, whether or not you
intend to help.

And when you notice you set the wrong one — say so and change it. A wrong status
is worse than a stale one, because people act on it. Quietly flipping it is
worse still: the thread is the record, and a correction is part of the record.

## Rhythm

- **Start of a session:** read the project. Act on everything at `received`
  before you create anything new — and check `in-progress` for a claim you left
  behind last time. An agent that asks a fresh question while
  ignoring yesterday's answer teaches people to stop answering.
- **Then stop reading it.** The board is read at session start and on the
  check-in word, and not in between. Answering each reply as it arrives means
  the human is still deciding while you are already building against half their
  decisions — and a round answered together is almost always a different, and
  smaller, piece of work than the same items answered one at a time.
- **On a check-in, the actionable set is everything at `received`.** Nothing
  else. A human replying to an issue moves it there automatically, so the status
  is the signal and hunting for others only finds work they have not finished
  asking for. `AGENTS.md` has how to plan a round and when delegating it is worth
  the cost.
- **`wb --auto` opts into the other behaviour**, for when they are working
  through a batch of answers and would rather not type `wb` after each one. It
  means "re-read at each natural boundary", never "poll on a timer" — the timer
  is the expensive habit, not the picking up. Say once that it is on, because a
  mode that changes what a session costs must never be silently running.
- **While working:** post a message when you act on a decision. The thread is
  the record of why the code looks the way it does.
- **End of a session:** make sure nothing you finished is still sitting at
  `received`, and nothing you are waiting on is still at `needs-decision` or
  `needs-qa` without the
  context somebody would need to answer it.

## Signing your work

Every message takes an `author` and every edit an `actor`. Send them.

The board falls back to the literal `agent`, which is honest but useless: a
board where six rows all say "agent" cannot answer the question the column
exists for. Pick a short stable name — the tool you run as, or whatever the
human calls you — and keep it identical across sessions. A name that drifts
between runs is no more useful than the default.

The human's own messages are recorded as `you` unless you pass something else,
and you should not: `who: "you"` with an invented author is a fabricated record.

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
