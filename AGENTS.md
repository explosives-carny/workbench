# Workbench — agent contract

**Contract v26.** Vendor-neutral. Base URL `http://localhost:4317` (`WORKBENCH_PORT`
overrides). `GET /api` returns the version the server speaks; if it is not `26`,
re-read this file — and if it is newer than the one your project was last
worked under, run `wb audit <slug>` and bring your items into spec (see *When
the contract version moves*).

Read this file once per session, then use the board — never the web UI, which is
slower for you and invisible to the next session. The first screen is the whole
working contract; everything after it is the same rules with their reasons.

## Cheat sheet

**Session start, in order.**

```bash
date -u                                       # 0. note the clock, and pick this session's id — 8 chars, once, sent as
                                              #    "session" on every write (wb: WB_SESSION, or your harness's session id)
wb resolve "$(git remote get-url origin)"     # 1. which project is mine (falls back: settings.defaultProject, then ask)
curl -s localhost:4317/api/settings           # 2. onboardedAt? agentNames? — sign as agentNames[<your tool>], else the tool name
wb board <slug>                               # 3. the actionable set: received + in-progress, last message each
```

Nothing at `received` → say so in one line. Never create items on a check-in.
Do not read the board again until the check-in word — or, for a scheduled worker, until the condition in *The check-in word, in full* holds again.

**Status is whose move it is.** An issue holds one of eight (so does a question
set, `kind: "questions"` — see *Question sets*); a document (`kind:
"document"`) holds `active` or `archived`, nothing else. (A project created
with `mode: "todo"` holds to-dos instead of issues — see **To-do projects**;
nothing below changes for any other project.)

| Status | Whose move | You set it when |
|---|---|---|
| `needs-decision` | theirs — choose | you ask |
| `needs-qa` | theirs — check built work | you finish something they must approve, **steps attached** |
| `received` | yours — answer landed, nobody started | automatic on their reply; or you hand it back unfinished |
| `in-progress` | yours — **claimed, working now** | **before** you start |
| `blocked` | nobody's until the blocker clears — **will be done** | it is waiting on other work (a deploy, a merge, another item); name it in `blockedBy` |
| `deferred` | nobody's, on purpose | agreed, with the trigger that brings it back |
| `complete` | done — **landed**, not typed | it is merged and running |
| `cancelled` | nobody's — **decided against**, will not be done | they say so, or you agree it; the reason goes in the thread |

**Calls.** The `wb` command encodes every rule below (version check, retry on
409, signature); use it when you have a shell. The HTTP under it is the contract
for everything else.

```bash
wb board <slug>                                    GET  /api/projects/<slug>?status=received,in-progress&messages=last
wb show <id|ref>                                   GET  /api/items/<id-or-ref>   — a ref (WB-DEMO-14) works anywhere an id does
                                                   GET  /i/<id-or-ref>  — 302 to the item's page, any project, former keys too; every ref the page renders links here (v26)
wb brief <id|ref>                                  GET  /api/items/<id-or-ref>/brief — the item as a self-contained Markdown brief for a second opinion; reads only
wb audit [slug]                                    GET  /api/projects/<slug>/audit (no slug: GET /api/audit) — live items out of spec, rule + fix each
wb ask <slug> '[{"title":"…?","context":"…","options":["A","B"],"recommended":["B"],"labels":["…"],"clientId":"…"}]'
                                                   POST /api/projects/<slug>/items     — an array files a set; clientId makes a retry safe
wb claim <id> "what I am about to do"              PATCH /api/items/<id> {"status":"in-progress","actor":"<you>","session":"<id>","ifVersion":N} + a message
wb reply <id> "…"                                  POST /api/items/<id>/messages {"who":"agent","actor":"<you>","session":"<id>","text":"…"}
wb reply <id> "Landed: …" --status complete        …same, with "status" — a reply that FINISHES work must carry one
wb status <id> <status>                            PATCH /api/items/<id> {"status":"…","actor":"<you>","ifVersion":N}
wb block <id|ref> "what it waits on"               PATCH /api/items/<id> {"status":"blocked","blockedBy":"…","actor":"<you>","ifVersion":N}
wb due <id|ref> 2026-10-31|none                    PATCH /api/items/<id> {"dueAt":"2026-10-31"}   — to-do projects only; null clears
wb priority <id|ref> high|medium|low|none          PATCH /api/items/<id> {"priority":"high"}      — to-do projects only; stored and returned as p1/p2/p3; null clears
wb todo <slug> "title" --due 2026-10-31 --priority high   POST /api/projects/<slug>/items {"title":"…","kind":"todo","dueAt":"…","priority":"…"} — to-do projects only
wb todos [slug] [--all]                            open to-dos on every to-do project (or one), due first — what `wb board` cannot show
wb check <id> <step> pass|fail|skip --note "…"     PATCH /api/items/<id>/checks/<step> {"result":"…","note":"…","actor":"<you>"}
                                                   — define steps as checks:[{"label":"…","owner":"human"|"agent"},…]
wb questions <id|ref>                              GET  /api/items/<id-or-ref> — a question set's questions and their state, open ones first
wb answer <id|ref> <qid> --choice "…" --note "…" --relay   PATCH /api/items/<id-or-ref>/questions/<qid> {"choice":"…","answer":"…","relay":true,"actor":"<you>"}
                                                   — the person answers on the page; an agent records one only as a relay. File a set with kind:"questions","questions":[{"id":"s1","label":"…","ask":"…","options":[…],"recommended":[…]},…]
wb attach <id|ref> <file>... [--text "…"]           POST /api/images (the file) → POST /api/items/<id>/messages with ![shot](/api/images/<sha256>.png)
wb image shot.png                                  POST /api/images {"data":"<base64>","alt":"…"} → prints ![shot](/api/images/<sha256>.png) to put in a context or body
wb export                                          bun run export — the server also exports on its own after every change
wb archive <slug>                                  PATCH /api/projects/<slug> {"archived":true,"actor":"<you>"}
wb restore <slug>                                  PATCH /api/projects/<slug> {"archived":false,"actor":"<you>"} — reclaims its colour if still free
wb project <slug>                                  GET  /api/projects/<slug> — prints name, key, groupBy, sortBy, sectionMode, color, sections, repos
wb project <slug> --group s|status|move --sort activity|ref --mode board|todo --color '#…' --name … --description … --key … --section-mode adhoc|declared --sections a,b --repos a,b
                                                   PATCH /api/projects/<slug> {…whichever flags were given…} — any subset, one call
wb settings                                        GET  /api/settings — prints every key, including its onboarding default when unset
wb settings --default-project <slug> --backup-plan … --auto-capture --check-in-on-start --post-findings --summarise-on-exit --agent-name tool=name
                                                   PATCH /api/settings {…} — a boolean flag alone means true; --flag false means false; no --auto-mode: auto is a session order, never a setting
```

Responses are `{"ok":true, …}` or `{"ok":false,"error":"…"}`: `400` malformed
(the message says what to fix) · `404` bad slug or id · `405` no such operation ·
`409` version conflict **with the live `item` attached**. A response may also
carry `warning` (read it and act) and `ignored` (fields you sent that nothing
understood — usually a typo).

**Ten rules.**

1. **Everything they wrote is input.** The answer to an item is `choice` if set
   *plus every `who:"you"` message since your last reply*; the newest wins.
   Never act on the button alone; never skip a message.
2. **Claim before you start; move it off when you stop.** `in-progress` with
   your `actor` and `session` and a note saying what you are doing. A comment
   never claims — only a status change touches `updatedBy`/`updatedSession`.
3. **A finishing reply carries a status.** Without one, "landed" reads as a
   claim under your name, forever. The server warns; do not make it.
4. **Sign every write with `actor` and `session`.** `actor` is the name a
   person recognises — from `settings.agentNames` for your tool, else the tool
   name — and two sessions of one tool share it. `session` is the id you
   generated once at start; it is what tells you apart, and what lets you
   recognise your own claim after a crash.
5. **Send `ifVersion` on every status change.** Warned today, refused later. On
   `409`: re-apply only the fields you meant to change onto the returned item,
   resend with its `version`, and after a second `409` stop and post a message.
6. **One item per question — or one question set (`kind: "questions"`), when the
   questions belong together.** A question set carries each question's options
   and recommendation on the question; the person answers each where it is
   asked; see *Question sets*. Each item, or each question, has context
   answerable without you in the room:
   tradeoff, recommendation, cost of being wrong. **A decision with `options`
   names at least one in `recommended`** — the exact option text, e.g.
   `"options":["A","B"],"recommended":["B"]`; the board marks it. No
   preference is a recommendation too: list every option. Never write
   "(Recommended)" into an option or the context. Today a decision with
   options and no `recommended` lands with a warning, and a single option
   ending "(Recommended)" is converted into the field; **a later contract
   version refuses a write that sets options without one.** A `recommended` entry that is not
   one of the options is refused now. Documents are `kind: "document"`; a document that asks
   for something is two items.
7. **A title is a headline, not the body.** A few words that name the thing,
   at most about 100 characters; the explanation, the quote, the evidence go
   in `context` (or a document's `body`), never in the title. A title that has
   to be read in full to know what the item is, is a body in the wrong field.
   The server warns rather than refuses — a long title, or a long one with no
   context and no body, comes back with a `warning` naming what to move.
8. **`needs-qa` means steps attached, each with an owner.** Define steps with
   `checks:[…]` on the item, each `"owner":"human"` or `"agent"` — who runs
   it. The board shows the item as Human QA, Agent QA or Mixed QA from them. A
   step whose setup or result a later human step depends on is `human`, even if
   an agent could run it, so the sequence stays in one pair of hands. Record
   results one step at a time. When every step has a result the
   round is finished and the item goes back at `received`: signed off if all
   passed, otherwise for the builder to review the notes.
9. **Change this application by pull request — never by editing the running copy.**
   Branch, change it with tests, open a pull request documented in two
   registers (detail for an agent, a plain summary for a project manager),
   tell them it is open. Pull requests are welcome and early ones are better
   than late ones. **A pull request changes the tool, never a project**: no
   board contents, project data, labels, settings, paths, ports or other
   installation configuration go into the repository — those live in the
   installation's own data. What is ruled out is the private edit: a change made to the
   installed copy that no one reviewed and the next update overwrites. See
   `CONTRIBUTING.md`.
10. **A report is not finished while it names work that is not on the board.**
    Before you report a round, every "your call", "left for you", "not
    confirmed" and follow-up in it is already an item — a decision with options,
    or QA with steps. Chat is where those go to be forgotten. **A question is a
    decision.** A clarifying question on an existing item goes on that item as
    `options` (`PATCH /api/items/<id> {"options":[…],"recommended":[…]}`), or becomes its own
    item; a message alone asks nothing anyone can click. **The report asks
    nothing**: it names item ids and their statuses. A question mark in a round
    report is a decision that is not on the board.
11. **Reports and replies name items by ref first.** Once a project has a
    `key`, every item on it has a `ref` — say `WB-DEMO-14`, never the UUID and
    never a truncated one. Fall back to the UUID's first eight characters only
    when the project has no key at all. **Write the ref bare: the page draws
    every ref as a link to its item**, on any project and under a former key
    (v26). Never build the link yourself (`[WB-DEMO-14](/p/demo/i/…)`): the
    server warns and the audit lists it. See **References** below.
12. **Write for the page.** Context, messages and document bodies render as
    Markdown. Lead with one sentence, then short paragraphs, bullet lists and
    tables. A wall of text is a warning. An option stands on its own — never
    "the table above"; what an option cites is in the context, formatted. See
    **Formatting** below.

**When they correct you against this contract, keep the correction.** A
correction is a fact about how you work, and it is the one fact most likely to
be lost: it arrives mid-session, in chat, after the work. Write it wherever your
harness keeps facts across sessions — a memory file, project instructions, notes
your tool reloads — in your own words, with what you did, what they said, and
the check that would have caught it. Then, if the contract let you miss it, open
a pull request so the next agent does not have to be corrected the same way.
The board holds their decisions; your memory holds theirs about you.

**The check-in word.** `wb` / `workbench` → read the board once (scoped
project only, if scoped), act on everything at `received` plus any stale claim,
plan the set before touching it, reply under each, one line each. Flags are
working orders for *this session*, never settings:

| Said | Means |
|---|---|
| `wb` | one round, then stop |
| `wb --auto` | keep folding new answers in at each natural boundary until `wb --auto off` — never a timer |
| `wb --scope <slug>` | this session works ONLY that project; other projects are not read for work or touched |

Say once, in one line, when you are in auto and what you are scoped to.

**Board not answering** (`ECONNREFUSED`): first **wait and retry — three
tries over about ten seconds.** A deploy restarts the service and the port is
silent for a couple of seconds; that is not "down", and starting a second server
into it is worse than waiting. `wb` retries on its own. **Then check whether
anything is listening:** `lsof -nP -iTCP:4317 -sTCP:LISTEN`. If a process is
listening, the board is up and *your shell* is blocked — typically a sandbox
with networking off, where every connection fails "after 0 ms". **Never restart
the service from that state**: it does not fix your connection and it
disconnects every other session. Re-run the call with network access (in a
sandboxed agent, ask to run it outside the sandbox). `wb` makes this check
itself and exits `3` with that message; exit `2` means nothing is listening.
Refused and nothing listening after the retries → it is really down: `launchctl kickstart -k gui/$(id -u)/dev.workbench.server`
if the service is installed, else `cd <workbench repo> && bun run start` in
the background; wait for `GET /api`; continue. Never fall back to asking in
chat, and never drop results you were about to record — hold them and retry.
`bun run install-service` keeps the board running across reboots.

---

## The rules, with their reasons

### Whose move it is

`needs-decision` and `needs-qa` are both "waiting on them" and are **not**
interchangeable: a five-second choice and a forty-step walkthrough cannot be
triaged in one bucket. Nothing built → decision; built and needs eyes → QA.

`complete` claims the work **landed**. Written but not landed is one of two
things, and the difference is *whose hand it waits on*. If **they** merge or
deploy — the normal case for a pull request into their repository — it is
`needs-qa`: built, and the steps attached are "merge it, then see X". A
worker who cannot merge records that step as `skip` with a note; the round
still finishes and comes back at `received`, and the builder asks for the
merge from there. If **you**
still own landing it (CI is running, you will deploy after lunch), it is
`received`, and the thread says what it waits on. Twenty-two built items were
once filed at `received` under the old wording, and the board read as though
nothing had happened.

`deferred` never means "still waiting on them". Say in the thread what brings
it back, or it is a question you gave up on.

`blocked` is the status for committed work that cannot start yet because it
waits on something else — a deploy, a merge, another item. Set it with
`blockedBy` saying what (`wb block <id|ref> "WB-DEMO-14 merged"`; a ref to an item
on this board is linked on screen). The difference from `deferred` is the whole
point: blocked work **will be done**, deferred work is parked and may not come
back. Filing blocked work as deferred makes it read as abandoned. Setting
`blocked` with no `blockedBy` is accepted with a `warning`.

`cancelled` is the end for an issue that **will not be done** — they decided
against it, or the need went away. Before it existed such an issue had three
wrong homes: `complete` claims the work landed, `deferred` claims it comes back,
`archived` belongs to documents. Set it when they say so (or when you agree it
with them), put the reason in the thread, and never use it to make a question
disappear that they have not answered.

| Situation | Status |
|---|---|
| You need them to choose | `needs-decision` |
| You built it; they must approve it | `needs-qa` |
| They answered; you have not started | `received` |
| You have started | `in-progress` — claim first |
| Built; they merge or deploy it | `needs-qa` — steps: merge, then what to see |
| Built; you still land it (CI, your deploy) | `received` — and say what it waits on |
| Merged and running | `complete` |
| They are doing it, not you | `needs-decision` |
| Waiting on other work, will be done | `blocked` — `blockedBy` names it |
| Parked by agreement, may not come back | `deferred` |
| Decided against — will not be done | `cancelled` — reason in the thread |
| A document people still work from | `active` |
| A document overtaken by events | `archived` |

**Documents are not tasks.** `kind: "document"` is set on create and decides
the statuses an item may hold; the two sets do not overlap and the board
enforces it — a status the kind cannot hold is replaced with that kind's
default, and naming both a `kind` and an impossible `status` in one call is a
`400`. Never file a document as `complete` to get it off the board; that hides
the most-read material behind the completed filter on the day it is written.
`archived` is how the board says "this is history". Changing `kind` later is
fine; the status follows.

`needs-you` is still accepted on input and stored as `needs-decision`.

### Claiming, and recovering a claim

A human reply moves an item to `received`. If the only trigger for the work is
that reply arriving in a live session, an outage, a crash or a context reset
takes the trigger with it: the item still says `received`, nobody is on it,
nothing says so. The claim — `in-progress`, your `actor`, a message saying what
you are about to do — is the only thing that survives losing your session. The
message is the note your replacement reads, which may be you with none of the
context you have now.

Move it off when you stop, whichever way it went. A claim nobody is honouring
is worse than no claim.

**A comment does not touch a claim.** A message that leaves the status where it
is writes only the thread; `updatedBy`/`updatedSession`/`updatedAt` still name
whoever last *moved* the item. So you can add context to somebody else's item without
appearing to take it — and cannot take it by commenting. (Every message used to
repaint `updatedBy`; three stand-down notes on another agent's items once made
them read as the commenter's.)

On a check-in, an item at `in-progress` is one of these. `updatedSession` makes
the first two exact; `updatedAt` against the clock you noted at session start
settles the rest:

| What you see | What it is | Do |
|---|---|---|
| `updatedSession` is this session | your own work | carry on |
| `updatedBy` is your name, `updatedSession` is not this session | **your earlier session crashed — or a sibling session is on it** | read the thread; a live sibling says so in recent messages; otherwise resume or hand back |
| another name, `updatedAt` older than your session began | **stale claim** | say so in the thread, reclaim, name whose claim you took |
| another name, recent | somebody is on it | leave it alone |
| `updatedSession` empty | an older writer | fall back to the clock rule |

No fixed timeout, deliberately: "older than my session began" needs no clock
everyone agrees on, and it is the real question — is anybody still here. The
session id exists because the name alone could not answer the first question:
two sessions of the same tool, signing the same name, are two workers, and
without it neither could tell whose claim it was looking at.

**Correct your own status when you get it wrong**, with a message saying what
and why. A wrong status is worse than a stale one, because somebody trusts it.

### Replies, edits and the two things that go wrong

**A reply claims what it answers.** An agent message on an item at `received`
moves it to `in-progress` with you as the actor — one call, no second one to
forget. It is narrow on purpose: `received` is the one status that
unambiguously means "yours, nobody has started". A reply on a `needs-*` item
leaves the move where it is.

**A finishing reply must carry a status.** "Landed, PR merged" with no `status`
leaves the item at `in-progress` under your name. The server returns a
`warning` when a reply sounds finished and carries none; it will not guess
whether the work landed. `complete` if it did; `needs-qa` if it needs their
eyes; `needs-decision` if it is their call now.

**Messages never conflict; edits can.** Record what happened as a message.
Send `ifVersion` from the copy you read on any edit that changes status —
today the server warns when you do not, and names the version to send; a later
contract refuses it. On `409` the response carries the live item: re-apply
only the fields you meant to change, resend with its `version`. A second `409`
means two writers are on it — stop and post a message rather than a third
blind write. `wb status` and `wb claim` do this for you.

**Retries duplicate unless you say who you are.** A batch `POST` that times out
after the write leaves you not knowing whether it landed. Give each item a
`clientId` (unique per project, any string) and the re-send returns the
existing items instead of a second set. Without one, re-read the board before
retrying.

**Unknown fields are reported.** `ignored: ["lables"]` on a response means the
board dropped a field you sent. Fix the spelling; the write otherwise landed.

**There is no delete.** `DELETE /api/items/<id>` is refused (`405`). The board
is a record: archive a document, complete an issue. `position` is the UI's
reorder handle, not yours.

### Checks — QA on the item it verifies

Set `needs-qa` **with the steps attached**, and post a message saying what
changed. No separate QA runbook document: one walkthrough covering eight
changes goes stale when one moves, cannot be worked by two people, and leaves
every item saying "see the runbook".

Two operations, two shapes. **Define** the steps by sending `checks:[…]` on the
item — the whole list, only while no results are recorded. **Record** a result
with `PATCH /api/items/<id>/checks/<step>`, one step per call, never by
re-sending the array, which would overwrite a result somebody else just typed.
A `fail` or `skip` needs a `note`; `pass` does not.

**Every step has an owner**: `"owner":"human"` for the person, `"agent"` for a
model. A step with none counts as human (what `needs-qa` meant before owners)
and the write comes back with a warning naming how many. The item reads back
`qa` — `human`, `agent` or `mixed`, from the owners — and `qaWaitingOn`, the
owner of the open steps (the person first), which the board uses to put Agent
QA with the agent's work. An agent runs and records its own steps; the
person's are left for them. Give a step to the agent only when nothing the
person does later depends on how or when it ran: "restart the server, then
sign in" is one human step, not an agent step followed by a human one. An
owner changes with `PATCH /api/items/<id>/checks/<step> {"owner":"…"}` until
the step has a result; after that it is part of the record.

**The server enforces the first half.** Sending `checks` onto an item whose
steps already carry results is a `409` with `conflict: "checks"` and the step
ids named. A QA record is evidence; a requeue that wanted fresh steps once wiped
seven recorded results with a `200`. To redefine steps and knowingly discard the
results, send `"replaceChecks": true` — and say in the thread why. A fresh QA
round is usually a new item.

**A finished round goes back at `received`.** When the last empty step gets a
result, the round is over. If every step passed, the board posts "All N steps
passed — signed off by <actor>"; whoever recorded the passes — a person, or a
model doing the QA — is the sign-off, and you land and close. If any step is
`fail` or `skip`, the board posts "QA round finished by <actor>: P pass, F fail,
S skip. Not signed off." and you review the notes on the steps. Either way the
item comes back to you. A round with an empty step stays at `needs-qa`. It
once stayed at QA on any skip, and finished rounds read as unchecked work.

**A fail that blocks the rest ends the round.** If a failed step makes later
steps impossible (nothing to click, nothing to judge), record each of those
steps as `skip` with a note naming the step that failed. The round then ends
and goes back at `received`. **The worker reports and the builder
diagnoses.** The fail note says what was seen, what was tried, and any cheap
fact that bears on it. Chasing the cause belongs to the builder at
`received`, not to a QA round held open while the worker investigates. A
round was once held open that way: the person running the steps was asked for
settings and console output while the item still read QA, and had to ask why
the builder had not picked it up.

The worker has your item and nothing else. Three precise steps beat twenty
vague ones: each step names its precondition or reaches it, names what will be
on screen, says when a refusal is the pass, asks only for what the worker
controls, never touches production or source, and says how to know the
environment is current. The full rule set and the failures each came from:
`docs/what-goes-here.md` → *Writing a step somebody else can execute*.

### Question sets (v23)

A question set is one item (`kind: "questions"`) that carries several
questions. Each question has its own options, recommendation and answer slot,
so the person answers each where it is asked, on one page, with the shared
context above them. Agents read the answers as fields.

```json
{"title":"Packing review","kind":"questions","context":"Shared facts…",
 "questions":[
   {"id":"s1","label":"Packing location","ask":"Where do the cases go?\n\n- Bay A is 40 ft from the dock","options":["Bay A","Bay B"],"recommended":["Bay A"]},
   {"id":"s2","label":"Notes","ask":"Anything the crew should know?"}]}
```

- **The shape.** A question is `{id, label, ask, options, recommended}`. `id`
  is stable and unique inside the item (default `q1`, `q2`…); `ask` is Markdown;
  `options` may be empty, which makes the question free text only;
  `recommended` is a subset of the question's `options`, exact text. The item
  itself carries no `options`, `recommended` or `choice` — sending any is a
  `400`. Held to the decision bar, per question: a question with options and
  no `recommended` comes back with a warning naming its id, and the audit lists it.
- **Read it back as fields.** Each question reads `choice`, `answer` (a note, or
  the whole answer when it has no options), `by`, `at` and `relayed`. The item
  reads `questionCount` and `answered`; list rows carry those two and never the
  array. A question counts as answered when it has a `choice` or a non-blank
  `answer`.
- **One PATCH per question.** `PATCH /api/items/<id-or-ref>/questions/<qid>`
  with `{choice?, answer?, clear?, relay?, actor, session}`. A `choice` must be
  one of that question's options (the error names them). An empty save records
  nothing and erases nothing: `400 nothing to record`. `"clear": true` empties
  the question. Recording does not touch `updatedBy`: an answer is not a claim.
- **Answers are the person's.** An agent may record one only as a relay, with
  `"relay": true`, when the person told it the answer somewhere other than the
  page. Without it an `actor` other than `you` is a `400`. A relayed answer is
  stored with `relayed: true` and the page says so. Do not edit the person's
  words into the `answer`; write them down as they were said.
- **The last answer hands the item back.** When every question is answered and
  the item is at `needs-decision`, the board posts "All N questions answered"
  and the item moves to `received`, as a reply would. A set with open questions
  is the person's move and counts as waiting on them. A reply still moves a set
  exactly as it moves an issue (their reply → `received`; yours on `received` →
  claims it). Answering an item at any other status records and moves nothing.
- **Redefining the questions.** Send `questions:[…]` on a PATCH: questions merge
  **by id**. A question whose id already exists is updated in place and keeps
  its recorded answer even when its ask or label changes; a new id is added
  after the existing ones; **every existing question the list does not name
  stays** (v27). So adding one question is a PATCH carrying that one question.
  Changing a question's options so the recorded `choice` is no longer offered
  clears that choice, and the write says so. To remove questions, send the
  whole list with `"replaceQuestions": true` — that is the only way anything
  is dropped, answered or not, and say in the thread why. (Before v27 the
  list was read as the whole set, and a PATCH carrying one new question
  silently dropped every unanswered one it did not name.) One write may turn
  an existing issue into a question set: send `"kind":"questions"`,
  `"options":[]`, `"recommended":[]`, `"choice":""` and the `questions`
  together; leaving the kind drops the questions and needs the same word when
  any holds an answer (`409`, `conflict: "questions"`, `answeredIds`).
- **Cite a question as `WB-DEMO-14/q3`**: the item's ref, a slash, the
  question's id; the page draws it as a link to that question (v26). When an
  answer starts separate work, file that work as its own item and link it back
  by that citation.
- **A set does not nest.** A question that grows a second question of its own
  becomes a new item, linked back by `ref/qid`.

**When questions belong in one set, and when they are their own items.** The
default is to keep them together. Make a question its own item when any right
column below is true of it.

| Keep in one set when | Make it its own item when |
|---|---|
| The same person answers all of them | A different person answers it |
| They are answered against one context or document | It needs none of the shared reading to answer |
| Its answer changes how another question in the set is read | It belongs on another project's board |
| They would be answered in one sitting, in any order | It blocks work on its own schedule: you need it now, the rest can wait |
| The answers are acted on in one build or one design revision | Its answer starts separate work with its own PR and its own QA |
| Splitting would mean copying the context into each item | Another item must name it in `blockedBy` (a question inside a set cannot be a blocker) |
| The set stays within about twelve questions (a hint, not a limit) | Its answer is a physical or device fact somebody must go and test |
| — | It needs its own cost-of-being-wrong paragraph: it is a decision in its own right |

**Why this exists (2026-10-09, the person's words):** "I'm finding it hard to
answer questions on a multi-question issue effectively. I don't like the idea of
breaking this up into multiple items because it's good to keep the context
together on one page." Questions numbered inside one issue's context could only
be answered in one long reply, with nothing recording which were done. The audit
flags an issue at `needs-decision` whose context holds four or more numbered
questions (`issue-reads-like-a-question-set`); file those as a set. More than
about twelve questions in one set is a hint on the write, never a refusal and
never an audit finding.

### Where the answer is

`choice` holds the button they clicked, if you offered `options`; it may or
may not be one you listed in `recommended`. Their words
are messages with `who:"you"`. The answer is **both**, from your last reply
onward, and the newest wins — a person who clicks a button and then types a
correction underneath meant the correction. `wb board` shows the last message;
`wb show <id>` shows the thread. Read it.

### Names

Every write carries `actor`. (`author` on messages and `by` on checks are read
as aliases for older writers; `actor` wins.) Omit it and the board records the
literal `agent`, and the "who spoke last" column stops answering with two
agents on one board. `who` (`you`|`agent`) separates a person from a machine;
`actor` says which machine.

**Your name is `settings.agentNames[<tool>]`** — for example
`{"claude-code":"the name they call you","codex":"codex"}`, set by the human on
their install, never written into this contract or this code — else the tool
name. One rule; the earlier
one offered two ("the tool you run as, or the name they call you") and the
reference board reached one agent under two names.

**Your identity is the name plus your `session`.** The name is not the identity
— it cannot be, once two sessions of one tool work the same board. Generate a
short id once when the session starts (eight characters; `wb` uses `WB_SESSION`
or the first eight of your harness's own session id), send it on every write,
and the board keeps it on each message and on the item as `updatedSession`. A
person sees the name; the tag beside it says which session; claim recovery
compares sessions instead of guessing from the clock. Never reuse another
session's id and never change yours mid-session. Repair an existing split
with `PATCH /api/projects/<slug>/authors {"from":"…","to":"…","actor":"…"}` —
it renames signatures and last-actor without freshening `updatedAt`, so a
rename cannot revive a stale claim.

Never fake a human reply. `who:"you"` only when relaying something they
actually said, and say in the text that it is relayed.

### Projects, and which one is yours

One project per thing a person thinks of as one thing — usually one repository.
`project.repos` lists the remotes (`owner/name` or a git URL, any spelling) and
directory paths (a trailing `*` covers every worktree under a prefix) it is
about; `GET /api/projects?repo=<remote-or-path>` — `wb resolve` — returns the
one that claims yours. Resolve from the repo first, then
`settings.defaultProject`, then ask. Never read every board to find your own,
and never file on a board you did not resolve to. Set `repos` at creation or
with `PATCH /api/projects/<slug> {"repos":[…]}`. A project that is renamed
keeps its slug: `PATCH /api/projects/<slug> {"name":"…","description":"…"}`
changes what people read, and add the new remote to `repos` so `wb resolve`
still finds it.

`GET /api/projects` orders the list by `lastActivityAt` DESC (the latest of
the project's own creation, any item touched, any message sent), not by
creation order — the gallery, and `wb resolve`'s "first match wins", both read
as "whichever of mine moved most recently". Each project also carries `color`,
one of twelve fixed values (`PROJECT_COLORS` in `src/db.ts`), assigned on
create so no two unarchived projects share one; `PATCH /api/projects/<slug>
{"color":"#…"}` changes it, refused with `400` if the value is not one of the
twelve. Archiving a project frees its colour for reuse; restoring it reclaims
the same one if nothing else took it meanwhile. Never a setting to switch on
somebody's behalf — like `groupBy` and the others above, it is the human's
call.

### References

Every item has a UUID (`id`) forever, and — once its project has a `key` —
also a short display reference: `WB-<KEY>-<n>`, for example `WB-DEMO-14`.
`key` is 2-5 characters matching `^[A-Z][A-Z0-9]{1,4}$`, unique across every
project on this board (current **and** former); `n` is a per-project counter
assigned once at creation, gapless from 1, never reused and never changed —
moving an item's section, status or project details never touches it. Every
item response and every row `GET /api/projects/<slug>` returns carries `ref`
(`null` until the project has a key) and `seq` (always set, whether or not a
key exists).

**Name items by ref, not id.** A report, a reply, a commit message or a pull
request title says `WB-DEMO-14`, never the UUID and never a truncated one —
the whole reason the ref exists is that a person can read it back and retype
it correctly. Fall back to the UUID's first eight characters only when the
project has no key at all.

**Every place an item id is accepted, a ref works too, case-insensitively:**
`GET /api/items/<id-or-ref>`, its `PATCH`, `/messages`, `/checks/<checkId>`,
and `wb show|reply|claim|status|check`.

**Every ref the page renders is a link to its item (v26).** In a context, a
message, a document body, a question's ask or answer, a title, a QA step's
label, a question's label and a `blockedBy` line, `WB-DEMO-14` is drawn as a
link to that item — on whichever project it lives, and under a former key as
well as the current one. `WB-DEMO-14/q3` links to that question on the set.
The address behind every such link is `GET /i/<ref>`, a `302` to the item's
page (`/p/<slug>/i/<ref>`); it takes an id too, and answers `404` text for a
ref no project holds. A ref whose key no project on this board holds stays
text, so a look-alike never becomes a dead link. Refs inside an option button
stay text (a link inside a button is not a thing), and so do refs inside a
fenced code block; refs in inline code are linked.

So: **write the ref bare and nothing else.** A hand-built Markdown link to an
item — `[WB-DEMO-14](/p/demo/i/<uuid>)`, or a ref used as the text of a link
to something else — comes back with a `warning` (`ref-written-as-link`) and
is listed by `wb audit`. The link rots (it names a slug or a UUID, and
survives a key change wrongly) and the page already draws the right one.

**Set a key** with `PATCH /api/projects/<slug> {"key":"demo","actor":"…"}` or
`wb key <slug> <KEY>` — lowercase is accepted and stored uppercased. A bad
pattern is `400`; a key already in use by another project — as its current key
or a former one — is `409` (`conflict: "key"`). `POST /api/projects` also
takes `key`, but only on the create it actually performs: a repeat POST that
finds an existing project by slug never renames it, and returns a `warning`
instead if a different key was sent.

Changing an established project's key is allowed: every item's `ref` moves to
the new key, the numbers do not, and the response carries a `warning` that a
ref already quoted elsewhere under the old key still resolves here — the old
key is retained on the project and stays reserved, never handed to another
project, and a project can reclaim its own former key later. A key cannot be
removed once set (`key: null` in a `PATCH` body is `400`); set a different one
instead — there is no state for "used to have references, now has none".

Export and import round-trip `key`, the retained former keys, each item's
`seq`, and the project's next-sequence counter, so a restored board's
references match the ones already quoted against it. They also round-trip the
project's `groupBy`, `sortBy`, `sectionMode`, `sections`, `color` and archived
state with its original date; a value in the file that the PATCH route would refuse is logged and
skipped, and the rest still restores (v15).

### Sections, labels, grouping

`labels` (any number per item) say how items **relate** — one release, one
blocker, one subsystem. `section` (at most one) is the **area of work**, never
the kind or the state of the item. `GET /api/projects/<slug>` returns both
vocabularies with counts (`GET /api/projects/<slug>/labels` returns the labels
alone): **reuse a name**; a near-synonym splits one list into two that both
look complete, and a filter on either misses half the work. A label that looks
like a duplicate of one in use — case, punctuation, a trailing plural — comes
back as a `warning` on the write, naming the existing label: reuse it, or merge
the two. Repairs: `PATCH …/labels` and `PATCH …/sections` `{"from","to","actor"}`
(empty `to` removes a label). `project.groupBy`
(`status`, the default, `section`, or `move` — Open split into Your move /
With your agent / Waiting on something), `project.sortBy` (`activity`, the
default, newest first; or `ref` to order every group by reference number
ascending) — plus `due` and `priority` for both on a to-do project only —
and `project.sectionMode` (`adhoc`
warns on near-duplicates, `declared` refuses unlisted sections) are the
human's calls; never switch them yourself. No good fit → leave `section`
empty. Reasoning and failure modes: `docs/what-goes-here.md`.

### To-do projects

A project created with `"mode":"todo"` (`POST /api/projects`, or `PATCH
/api/projects/<slug> {"mode":"todo"}`) is a person's to-do list, kept on the
same board as their decisions. It is opt-in, and it is the only place any of
this applies. A project without it is a board, `mode: "board"`, and every rule
above holds there unchanged.

- **Its items are to-dos**, `kind: "todo"`, holding `todo`, `deferred`,
  `complete` or `cancelled`. A create on a to-do project is a to-do unless it
  says `kind: "document"` (documents live on either). The whose-move statuses,
  options, QA and `blocked` are a board's: `kind: "issue"` or a status like
  `needs-decision` on a to-do project is a `400`, and `kind: "todo"` on a
  board is a `400`.
- **A message never moves a to-do.** Nobody asked anybody anything, so a
  person's note does not make it `received` and an agent's reply claims
  nothing. A message with an explicit `status` still moves it, within the set;
  a status outside the set lands the message, leaves the status, and comes
  back as a `warning` naming the set.
- **`dueAt` and `priority` exist on to-dos only.** `dueAt` is a calendar day,
  `"YYYY-MM-DD"` (`"2026-10-31"`), never a timestamp; anything else — a
  date-time, `"10/31/2026"`, `"2026-02-30"` — is a `400` naming the shape.
  `priority` is sent as `"high"`, `"medium"` or `"low"` (or `"p1"`–`"p3"`),
  any case, and stored and returned as `"p1"` (high), `"p2"`, `"p3"`; the page
  and `wb` show the words (v19). `null` or `""`
  clears; left out keeps. On a board item either field is a `400` saying they
  belong to to-do projects; board items carry neither field at all.
- **Dates never move a status.** The page highlights an open to-do by due band
  against the viewer's today — overdue, today, tomorrow, within a week (2 to
  6 days out), later — and
  `groupBy`/`sortBy` take `due` and `priority` on a to-do project (a board
  refuses them). Bands are computed on the page, never stored.
- **The mode changes only while the project holds no work.** Once it holds an
  issue or a to-do, a switch is a `409` with `conflict: "mode"`: items are
  never converted, because a `received` decision has no to-do equivalent and a
  to-do has no whose-move answer. Start a new project instead. Leaving to-do
  mode puts a `due`/`priority` layout back to the defaults. A refused `PATCH`
  applies none of its fields. Import never converts either: a file whose mode
  differs from an existing project of the same slug restores nothing into it,
  and the import log says so.

Set a date or priority only when the person gave one; an invented deadline
reads exactly like a real one. To-dos are theirs: do not file your own work as
to-dos to get it off a board — that is what the board's statuses are for (v18).

#### Working a to-do list (v19)

An agent works a to-do list only on the person's word: "add …", "what is on
my list", "that's done", "push it to Friday". A to-do is never a request to
you. If they want an agent to do the thing, it is work, and it goes on a board
as an issue.

- **Which list.** `wb projects` (`GET /api/projects`, each with `mode`)
  names the to-do lists. Use the one the person named. If they named none and
  there is exactly one, use that one. If there are several, use the one whose
  name matches what the to-do is about, and say which one in your answer. If
  there is none, do not create one for them: tell them the board has no to-do
  list, and `wb project <slug> --mode todo` makes a new, empty project into one.
- **Adding.** Use `wb todo <slug> "title"`, or POST with `"kind":"todo"`
  (named, so that a board refuses the write instead of filing a decision). The
  title is in the person's words, short, and a headline (rule 7). If they gave
  more, it goes in `context`. Give a `clientId` when you might retry. Several
  at once go as one array.
- **Dates come from the person, resolved by you.** Turn "Friday", "next week"
  or "the 31st" into a `YYYY-MM-DD` day against the person's own today, in
  their time zone, not the server's and not UTC. Say the day back to them
  ("due Fri 2026-10-09"), so a wrong guess is caught while they are still
  there. If a word does not name a day ("soon", "later"), set no date. Never
  invent one.
- **Priority is high, medium or low** when they say so ("urgent" and "ASAP"
  mean high), and none otherwise.
- **Reading the list.** `wb todos [slug]` lists open to-dos due first, then by
  priority, with "overdue 2d" or "due in 3d" against today. `wb board` shows
  nothing here: it lists `received` and `in-progress`, and a to-do holds
  neither. Over HTTP, use `GET /api/projects/<slug>?status=todo`.
- **Changing one.** Mark it done (`wb reply <ref> "Done" --status complete`),
  drop it (`cancelled`), park it (`deferred`), or move its date or priority
  only when the person says so. "Done" with no item named is the one they
  were just talking about; if it could be either of two, name both refs and
  ask. Never close a to-do because its date passed or because it looks stale.
- **On a check-in round** a to-do project has no actionable set, and the round
  changes nothing on it. If the session is scoped to that project, or the
  person asked about it, the report may add one line: the refs that are
  overdue or due within 3 days.

### Formatting — what the page renders (v20)

`context`, every message and a `markdown` body render as Markdown on the item
page and the project page: headings, bold, italic, `code`, links (http/https or
board paths only), bullet and numbered lists, tables (a header row plus a
`|---|` separator row), quotes and fenced code. HTML is escaped, never
rendered. Images render too, when they are the board's own (see **Images**
below). A single newline in a context or message is a line break, as in a
chat reply; a document body joins lines into paragraphs as Markdown does.

The shape of a decision context:

```markdown
Which review outcomes should post an adjustment?

- **What:** two outcomes can post today; the third waits for a person.
- **Why:** posting without review has twice written a wrong count.

| Outcome | Posts? | Reviewed by |
|---|---|---|
| Matches | No | n/a |
| Differs | Yes | A person |

**Recommendation:** B — post only reviewed differences.
**Cost of being wrong:** one wrong adjustment, reversible in a minute.
```

- **Options** are short, self-contained, and the answer itself. Inline Markdown
  is allowed. Never positional ("above", "below", "the table"): name the thing.
- Over about 1,500 characters of reference material goes in a document
  (`kind:"document"`, `bodyFormat:"markdown"`), with its ref linked from the
  context.

The write still lands; the warning rides in `warning`/`warnings`, and the audit
lists live items that break the same rules.

| Warning | Trigger | Fix |
|---|---|---|
| Wall of text | any line — paragraph, bullet or heading — over 400 characters in `context` or an agent message (table rows and fenced code excepted) | Short paragraphs, a list or a table |
| Escaped newlines | two or more literal `\n` and no real line break | Send real line breaks |
| Pointer option | an option points by position: "(see below)", "the table above;" — not a comparison like "below 10" | Name what it means; keep that content in the context |
| Table option | an option points at a table and no Markdown table is in the context or body | Put the table in the context, formatted |
| Ref written as a link | a Markdown link whose target is an item page (`/p/<slug>/i/…`, `/i/…`) or whose text is a bare ref, in a context, body, ask or agent message (fenced code excepted) | Write the ref bare; the page links it (v26) |

Why: on 2026-10-06 a 2,128-character decision context with a nine-row table and
bulleted reasons was shown as one paragraph of pipes and asterisks, and its
recommended option pointed at "the table above". The person: "I never want to
see this kind of unformatted response again." The page renders it now; the
warnings stop the next one at write time; and because `wb audit` lists the
same findings, the move to v20 has every session reformat its own live items.

### Second opinion brief (v21)

`GET /api/items/<id-or-ref>/brief` (`wb brief <id|ref>`) returns one item as
`text/markdown`, written for a reader who has never seen the board: another
model, or a colleague in chat. The item page's **Get a 2nd opinion** button
copies the same text, from the same route, so what a person pastes and what an
agent fetches never differ.

- **What it holds:** the project's name and description; the item's ref (the
  id's first eight characters without a key), title, kind, section and labels;
  the context; the question (the title, with what kind of answer is wanted);
  the options, with `recommended` and `choice` marked; QA steps and results; a
  Markdown or text body (an HTML body is named, not copied); the thread
  oldest first with who said each message, noting that the newest wins; the
  status, what it is blocked by, due and priority on a to-do; and a closing
  ask: "What would you choose and why? What am I missing?"
- **What it leaves out:** the project's `repos`, the board's address, ids
  beyond the ref, and anything else about the installation. Values that look
  like credentials (API keys, tokens, `password=…`, `user:pass@` in a URL,
  private keys) are replaced with `[redacted]` and counted in the footer (an
  all-hex secret is caught only when its name says what it is, as in
  `token=…`), and
  `/Users/<name>/` or `/home/<name>/` becomes `~/`. Long sections and messages
  are cut, and a thread over 12 messages keeps the first 2 and the newest 10.
- **It reads, never writes.** Fetching a brief changes no status, version or
  signature. Any other method is a `400`.

An outside opinion is advice for the person, not their answer. If they paste
one into the thread, it arrives as their message: act on the parts they say
they agree with, and ask (as `options`, rule 10) when that is unclear.

### Images (v22)

A picture goes on an item as Markdown text that names a file the board holds:
`![what it shows](/api/images/<sha256>.<ext>)`. It works anywhere Markdown
renders: a context, a message, a Markdown document body. The page shows it
inline, at most about 420px tall, and a click enlarges it.

1. **Upload** with `POST /api/images`, one image per call, sent any of three
   ways: the raw bytes with an image `content-type`; a multipart form with the
   image in field `file` (`curl -F file=@shot.png`); or JSON
   `{"data":"<base64, or a data: URL>","alt":"…"}`. `?alt=` sets the alt
   text on any of them. `201` returns
   `{"image":{"name","hash","type","bytes","url","markdown","existed"}}`;
   `markdown` is ready to paste. The same bytes again return `200` with the
   same `url` and `existed: true`, so a retry never makes a second file.
2. **Reference** it by putting `markdown` (or your own `![alt](url)`) in the
   text you write next: `context` on a create or `PATCH`, a message, or a
   `markdown` body. Uploading posts nothing on its own. `wb attach` does both
   steps as one reply; `wb image` uploads and prints the Markdown.
3. **Write alt text that says what the picture shows** ("login page, error
   banner under the password field"), not "screenshot". The second-opinion
   brief and anyone reading the raw text see only the alt.

- **Types and limits:** PNG, JPEG, GIF, WebP and SVG, up to 10 MB each. The
  type is read from the bytes, never the file name; anything else is a `400`
  naming the allowed set. **A HEIC or HEIF** (a phone photo, v24) is accepted and
  stored as a JPEG, so the response names a `.jpg` and every browser draws
  it; the board converts with a tool the machine already has (macOS `sips`,
  ImageMagick `magick`, or libheif `heif-convert`), and a machine with none
  answers `400` saying to export the photo as JPEG. An SVG stays inert because of how it is
  served (a sandboxing CSP) and shown (through `<img>`), not because of an
  upload filter. As a second line, common active content is refused at upload
  with a `400` (script elements, event handlers, `javascript:` and other
  non-image URL schemes, entity-encoded attribute values, `foreignObject`,
  embedded documents, outside references); that check is not a sanitizer.
  Export the SVG plain or send a PNG.
- **Only the board's own images render.** `![…](https://…)` stays literal text:
  a page that fetched pictures from elsewhere would send requests off the
  machine every time it renders. Upload the file instead.
- **Served safely:** `GET /api/images/<sha256>.<ext>` returns the file with its
  real `content-type`, `nosniff`, and a sandboxing CSP, so an SVG opened on its
  own runs nothing. Names are the SHA-256 of the bytes, so a URL never points
  at different content later.
- **Stored beside the database,** in an `images/` folder
  (`WORKBENCH_IMAGES` overrides), never inside it, and never in the JSON
  export: the export copies the files to `<content dir>/images/`, and import
  copies them back, skipping any file whose bytes do not match its name.
- **No delete.** `DELETE /api/images/…` is `405`, as for items: a message that
  showed a picture keeps showing it.
- **The brief** (`/brief`) replaces each image with `[image: <alt> (on the
  board, not included)]`, since the reader it is pasted to cannot fetch it.

**Back-compat:** no route, field or status changed, and no schema moved.
The one rendering change: text that already contained
`![…](/api/images/<64 hex>.<ext>)` now shows as an image (a broken one if no
such file exists). Every other `![…](…)` renders exactly as before. An old
server answers `404` on `/api/images`; an agent that sees `contractVersion`
below `22` should describe the picture in words instead.

### Payload

`GET /api/projects/<slug>` takes `?status=a,b` (only those rows),
`?messages=all|last|none` (how much thread rides along; `messageCount` is always
set) and returns compact JSON to anything that is not a browser (`?pretty=1`
forces indentation). `body` is never in a list — `bodyLength` says one is
there; `GET /api/items/<id>` or `/body` for the text. Ask for what you need.

A write that arrives from a browser page carries an `Origin` header, and the
board takes those only from its own pages (or the origins in
`WORKBENCH_ORIGINS`): anything else is `403`. A page on some other site open in
the same browser could otherwise file items or post messages on a board that
has no delete. Requests with no `Origin` — `wb`, curl, an agent — are not
affected; reads never are.

Name a body's `bodyFormat` (`text`, `markdown`, `html`). Left out, it is guessed
from the body: a leading `<!doctype html>` or `<html>` is `html`, a Markdown
heading, list or quote is `markdown`, anything else `text`; an edit guesses only
while the item is still `text` (v14, `docs/what-goes-here.md`).

### The check-in word, in full

The board is read at session start and on the check-in word — **not
otherwise**. Do not poll; do not answer an item the moment you notice an
answer. They are still typing, and an agent that reacts to each reply as it
lands turns one round of decisions into a dozen half-plans, each a full pass
over the work. A reply is not a task; being asked to tidy a status is not a
reason to sweep the board.

**A round opens on a condition (v25).** The rule above protects one thing:
never react while a person is still typing. The check-in word is one way to
show that is not happening; it is not the only one. A round may open when all
of these hold:

- an item is the agent's move: one at `received`, a stale claim, a `blocked`
  item whose blocker has cleared, or open agent-owned QA steps;
- no person has written on the project, and no other agent has moved an item
  on it, inside the installation's quiet window; and
- no live session holds the project.

A person saying the check-in word satisfies the condition for that person's
session. A scheduled worker satisfies it unattended. Short of the condition,
the rule stands: do not react to each reply as it lands.

#### Scheduled workers

A scheduled worker is a session like any other. It generates its own `session`
id for each run and signs every write with it. It claims an item before it
starts the work. It never opens a round inside the quiet window. It honours
holds.

A **hold** is one session's claim on a whole project, recorded where the
installation keeps it. Every session, interactive or scheduled, checks for a
hold before it writes and stops if another session has one. The length of the
quiet window is set by the installation, never by this contract.

1. Read the scoped project (or every project when unscoped). **Read everything
   before doing anything.**
2. **The actionable set is every item at `received`, plus any stale claim at
   `in-progress`.** Nothing else — a human replying moves an issue to
   `received` automatically, so the status is the signal. A document never
   reaches `received`; a comment on one is never itself actionable. Also
   look at `blocked` items: one whose blocker has cleared (the item it names
   is `complete`, the PR merged, the deploy live) is yours to move on.
3. **Plan across the set.** Find the shared work (three items touching one
   file are one edit and one test run). Order by what unblocks what. Separate
   the answerable from the buildable and do the answers first — they are cheap
   and may change what you build. Name what you are not doing and why. **Say
   the plan in a few lines before executing it**; redirecting a plan costs far
   less than redirecting finished work.
4. Report the plan, then the outcome, one line per item. The report points
   at items; it asks nothing. A question you find yourself typing here is a
   decision — file it, with options, then report the id (rule 10).
5. **Re-read the set you worked.** Anything still at `received` was answered in
   the transcript and not on the board, and the board is the only half that
   survives the session.

**`wb --auto`** means: at each natural boundary — a piece of work finished,
about to report — re-read the board and fold anything now at `received` into
the next round. Never a timer. Turn it off yourself when three rounds in a row
find one small item each; say so. **`wb --scope <slug>`** confines the session
to one project: other projects are not read for work and not touched, not even
at `received`. Two sessions on one board are normally split exactly so, and a
session that "helpfully" answers on the other takes work out from under the
agent that owns it. "You are scoped to X" in words is the same order. Both flags
are working orders for *this session*, held in your own state; they used to be
persisted as a setting, and one session's auto put every session into auto.

**Delegating a round.** Parallel agents finish sooner, cost substantially more,
and everything they produce must be read and verified by you anyway. Delegate
only when the parts touch different files, each is bigger than fifteen minutes
inline, and you can state each part's done condition precisely. Otherwise work
inline. Say which you chose and why in one line before you start; if the scope
grows past what you announced, say so and re-decide. When it is genuinely
unclear, put the choice to them with a rough cost — they are paying for it.

### Onboarding

`settings.onboardedAt` missing → put the seven setup questions on the board
(label `Setup`), say one line in chat, record the answers to settings when they
come back, close the items, and honour them — including `"none"` for
`backupPlan`, which is a real answer never to be raised again. The questions,
the settings they map to and the three board layouts: `docs/onboarding.md`.
`onboardedAt` present → say nothing about setup.

`PATCH /api/settings` takes only the known keys: `onboardedAt` (ISO date-time),
`defaultProject` (an existing slug), `backupPlan` (string), `agentNames`
(`{tool: name}`), and the booleans `autoCapture`, `checkInOnStart`,
`postFindings` and `summariseOnExit`. A wrong type is a `400` naming the key;
`null` clears a string setting. Any other key is not stored and comes back in
`ignored`. `actor` and `session` are the signature, never settings (v15).

### Backup

The server exports every project to `WORKBENCH_CONTENT` (default
`~/workbench-content`) a few seconds after any change, one readable JSON file
per project, and commits if that directory is a git repository. Pushing is a
deliberate act — yours or theirs — not the server's. `bun run export` does the
same on demand; `bun run import` restores. `WORKBENCH_AUTO_EXPORT=0` turns the
automatic export off.

### When you are corrected

Every rule in this file was written after somebody was corrected. The rules
survive because they were written down where the next session reads them; the
corrections that were only heard did not, and the same person had to say the
same thing again — three times, for the rule above this one.

So a correction against this contract has two homes, and needs both:

- **Your memory**, whatever form your harness gives it. This file cannot know
  whether that is a memory directory, a notes file the tool reloads, project
  instructions, or a store your orchestrator keeps for you — it only knows
  that capable tools have one, and that a correction which lives only in the
  transcript is gone at the next compaction. Record it the way you would want to
  read it cold: what you did, what they said (their words), and the concrete
  check that would have caught it before they had to. A rule with its failure
  attached is remembered; a rule alone is re-derived, slowly, by being corrected
  again.
- **The contract**, when the miss was possible because the rule was unclear or
  absent. Branch, edit, pull request (`CONTRIBUTING.md`). Write the failure into
  `docs/what-goes-here.md` next to the rule, dated, in the person's words. The
  rules here are not principles; they are scar tissue, and the scar is what
  makes the next reader believe the rule.

Neither replaces the other. The contract corrects every agent from now on; your
memory corrects you today, before the contract is merged, and for the part of
the correction that was about how *you* miss things rather than what the rule
says.

### When the contract version moves

A new version can put items already on the board out of spec: a decision
filed before `recommended`, QA steps filed before owners. Writes under the old
rules were accepted, so nothing forces them into line. **On the first session
after the version moves, audit your project and conform it** — before the
round, as part of session start.

`wb audit <slug>` (`GET /api/projects/<slug>/audit`) lists every live item
out of spec, each with the rule it breaks and the fix. It reads; it never
writes. Finished work — complete, cancelled, archived — is not audited: it was
right under the contract it was filed under, and changing it would falsify the
record.

- **Fix what you can decide.** A recommendation on a decision you raised, an
  owner on a QA step you wrote, a `blockedBy` you know, a title you can
  shorten. One PATCH per item, signed and with `ifVersion`, and no message
  needed unless the change is not obvious from the item.
- **Leave what you cannot**, and say so on the item: a decision someone else
  raised whose recommendation you would be guessing, a step whose owner
  depends on how the person works. The audit will keep listing it; that is
  the point.
- **Your project only.** `GET /api/audit` shows every project, but each one is
  conformed by the session that works it, at its own next session start — the
  same scope rule as a round. An audit of someone else's project is
  information, never a reason to edit it.
- Say it in the round report as one line: `audit: N fixed, M left (refs)`.

### Versioning

`GET /api` → `{contractVersion, agentsMd, routes}`. The version bumps in the
same pull request as any route, field or rule change (`CONTRIBUTING.md`). Old
spellings stay accepted; the number tells you to re-read, not the server to
refuse.

## Further reading

- `docs/what-goes-here.md` — what to create and when, how to segment projects,
  the kinds of item, writing QA steps, and the failures behind each rule.
- `docs/onboarding.md` — the setup questions and the board layouts.
- `docs/integrations/README.md` — the one portable wiring block, plus vendor notes.
- `CONTRIBUTING.md` — who may change the application, how a pull request is
  documented, and what you can do without one.
