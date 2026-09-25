# Workbench — agent contract

**Contract v13.** Vendor-neutral. Base URL `http://localhost:4317` (`WORKBENCH_PORT`
overrides). `GET /api` returns the version the server speaks; if it is not `13`,
re-read this file.

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
Do not read the board again until the check-in word.

**Status is whose move it is.** An issue holds one of eight; a document (`kind:
"document"`) holds `active` or `archived`, nothing else.

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
wb ask <slug> '[{"title":"…?","context":"…","options":["A","B"],"labels":["…"],"clientId":"…"}]'
                                                   POST /api/projects/<slug>/items     — an array files a set; clientId makes a retry safe
wb claim <id> "what I am about to do"              PATCH /api/items/<id> {"status":"in-progress","actor":"<you>","session":"<id>","ifVersion":N} + a message
wb reply <id> "…"                                  POST /api/items/<id>/messages {"who":"agent","actor":"<you>","session":"<id>","text":"…"}
wb reply <id> "Landed: …" --status complete        …same, with "status" — a reply that FINISHES work must carry one
wb status <id> <status>                            PATCH /api/items/<id> {"status":"…","actor":"<you>","ifVersion":N}
wb block <id|ref> "what it waits on"               PATCH /api/items/<id> {"status":"blocked","blockedBy":"…","actor":"<you>","ifVersion":N}
wb check <id> <step> pass|fail|skip --note "…"     PATCH /api/items/<id>/checks/<step> {"result":"…","note":"…","actor":"<you>"}
wb export                                          bun run export — the server also exports on its own after every change
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
6. **One item per question**, context answerable without you in the room:
   tradeoff, recommendation, cost of being wrong. Documents are `kind:
   "document"`; a document that asks for something is two items.
7. **A title is a headline, not the body.** A few words that name the thing,
   at most about 100 characters; the explanation, the quote, the evidence go
   in `context` (or a document's `body`), never in the title. A title that has
   to be read in full to know what the item is, is a body in the wrong field.
   The server warns rather than refuses — a long title, or a long one with no
   context and no body, comes back with a `warning` naming what to move.
8. **`needs-qa` means steps attached.** Define steps with `checks:[…]` on the
   item; record results one step at a time. When every step has a result the
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
    `options` (`PATCH /api/items/<id> {"options":[…]}`), or becomes its own
    item; a message alone asks nothing anyone can click. **The report asks
    nothing**: it names item ids and their statuses. A question mark in a round
    report is a decision that is not on the board.
11. **Reports and replies name items by ref first.** Once a project has a
    `key`, every item on it has a `ref` — say `WB-DEMO-14`, never the UUID and
    never a truncated one. Fall back to the UUID's first eight characters only
    when the project has no key at all. See **References** below.

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

### Where the answer is

`choice` holds the button they clicked, if you offered `options`. Their words
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
references match the ones already quoted against it.

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
ascending) and `project.sectionMode` (`adhoc`
warns on near-duplicates, `declared` refuses unlisted sections) are the
human's calls; never switch them yourself. No good fit → leave `section`
empty. Reasoning and failure modes: `docs/what-goes-here.md`.

### Payload

`GET /api/projects/<slug>` takes `?status=a,b` (only those rows),
`?messages=all|last|none` (how much thread rides along; `messageCount` is always
set) and returns compact JSON to anything that is not a browser (`?pretty=1`
forces indentation). `body` is never in a list — `bodyLength` says one is
there; `GET /api/items/<id>` or `/body` for the text. Ask for what you need.

### The check-in word, in full

The board is read at session start and on the check-in word — **not
otherwise**. Do not poll; do not answer an item the moment you notice an
answer. They are still typing, and an agent that reacts to each reply as it
lands turns one round of decisions into a dozen half-plans, each a full pass
over the work. A reply is not a task; being asked to tidy a status is not a
reason to sweep the board. Only the check-in word opens the round.

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

### Versioning

`GET /api` → `{contractVersion, agentsMd, routes}`. The version bumps in the
same pull request as any route, field or rule change (`CONTRIBUTING.md`). Old
spellings stay accepted; the number tells you to re-read, not the server to
refuse.

## Further reading

- `docs/what-goes-here.md` — what to create and when, how to segment projects,
  the four kinds of item, writing QA steps, and the failures behind each rule.
- `docs/onboarding.md` — the setup questions and the board layouts.
- `docs/integrations/README.md` — the one portable wiring block, plus vendor notes.
- `CONTRIBUTING.md` — who may change the application, how a pull request is
  documented, and what you can do without one.
