# Workbench — agent contract

**Contract v2.** Vendor-neutral. Base URL `http://localhost:4317` (`WORKBENCH_PORT`
overrides). `GET /api` returns the version the server speaks; if it is not `2`,
re-read this file.

Read this file once per session, then use the board — never the web UI, which is
slower for you and invisible to the next session. The first screen is the whole
working contract; everything after it is the same rules with their reasons.

## Cheat sheet

**Session start, in order.**

```bash
date -u                                       # 0. note the clock: the stale-claim rule compares against it
wb resolve "$(git remote get-url origin)"     # 1. which project is mine (falls back: settings.defaultProject, then ask)
curl -s localhost:4317/api/settings           # 2. onboardedAt? agentNames? — sign as agentNames[<your tool>], else the tool name
wb board <slug>                               # 3. the actionable set: received + in-progress, last message each
```

Nothing at `received` → say so in one line. Never create items on a check-in.
Do not read the board again until the check-in word.

**Status is whose move it is.** An issue holds one of five; a document (`kind:
"document"`) holds `active` or `archived`, nothing else.

| Status | Whose move | You set it when |
|---|---|---|
| `needs-decision` | theirs — choose | you ask |
| `needs-qa` | theirs — check built work | you finish something they must approve, **steps attached** |
| `received` | yours — answer landed, nobody started | automatic on their reply; also "written, PR open, not merged" |
| `in-progress` | yours — **claimed, working now** | **before** you start |
| `deferred` | nobody's, on purpose | agreed, with the trigger that brings it back |
| `complete` | done — **landed**, not typed | it is merged and running |

**Calls.** The `wb` command encodes every rule below (version check, retry on
409, signature); use it when you have a shell. The HTTP under it is the contract
for everything else.

```bash
wb board <slug>                                    GET  /api/projects/<slug>?status=received,in-progress&messages=last
wb show <id>                                       GET  /api/items/<id>
wb ask <slug> '[{"title":"…?","context":"…","options":["A","B"],"labels":["…"],"clientId":"…"}]'
                                                   POST /api/projects/<slug>/items     — an array files a set; clientId makes a retry safe
wb claim <id> "what I am about to do"              PATCH /api/items/<id> {"status":"in-progress","actor":"<you>","ifVersion":N} + a message
wb reply <id> "…"                                  POST /api/items/<id>/messages {"who":"agent","actor":"<you>","text":"…"}
wb reply <id> "Landed: …" --status complete        …same, with "status" — a reply that FINISHES work must carry one
wb status <id> <status>                            PATCH /api/items/<id> {"status":"…","actor":"<you>","ifVersion":N}
wb check <id> <step> pass|fail|skip --note "…"     PATCH /api/items/<id>/checks/<step> {"result":"…","note":"…","actor":"<you>"}
wb export                                          bun run export — the server also exports on its own after every change
```

Responses are `{"ok":true, …}` or `{"ok":false,"error":"…"}`: `400` malformed
(the message says what to fix) · `404` bad slug or id · `405` no such operation ·
`409` version conflict **with the live `item` attached**. A response may also
carry `warning` (read it and act) and `ignored` (fields you sent that nothing
understood — usually a typo).

**Eight rules.**

1. **Everything they wrote is input.** The answer to an item is `choice` if set
   *plus every `who:"you"` message since your last reply*; the newest wins.
   Never act on the button alone; never skip a message.
2. **Claim before you start; move it off when you stop.** `in-progress` with
   your `actor` and a note saying what you are doing. A comment never claims —
   only a status change touches `updatedBy`.
3. **A finishing reply carries a status.** Without one, "landed" reads as a
   claim under your name, forever. The server warns; do not make it.
4. **Sign every write with `actor`** — the name from `settings.agentNames` for
   your tool, else the tool name. One name, every session.
5. **Send `ifVersion` on every status change.** Warned today, refused later. On
   `409`: re-apply only the fields you meant to change onto the returned item,
   resend with its `version`, and after a second `409` stop and post a message.
6. **One item per question**, context answerable without you in the room:
   tradeoff, recommendation, cost of being wrong. Documents are `kind:
   "document"`; a document that asks for something is two items.
7. **`needs-qa` means steps attached.** Define steps with `checks:[…]` on the
   item; record results one step at a time. The last `pass` signs it off and
   hands it back at `received`.
8. **Never edit this application to add a feature.** Branch, PR, tell them.
   See `CONTRIBUTING.md`.

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

**Board not running** (`ECONNREFUSED`): `cd <workbench repo> && bun run start`
in the background, wait for `GET /api`, continue. Never fall back to asking in
chat. `bun run install-service` keeps it running across reboots.

---

## The rules, with their reasons

### Whose move it is

`needs-decision` and `needs-qa` are both "waiting on them" and are **not**
interchangeable: a five-second choice and a forty-step walkthrough cannot be
triaged in one bucket. Nothing built → decision; built and needs eyes → QA.

`complete` claims the work **landed**. Written but sitting in an unmerged PR or
an undeployed branch is `received` — you own it, it is not done — and the
thread says what it waits on, so `received` does not read as `forgotten`.

`deferred` never means "still waiting on them". Say in the thread what brings
it back, or it is a question you gave up on.

| Situation | Status |
|---|---|
| You need them to choose | `needs-decision` |
| You built it; they must approve it | `needs-qa` |
| They answered; you have not started | `received` |
| You have started | `in-progress` — claim first |
| Written, PR open, not merged | `received` — and say so |
| Merged and running | `complete` |
| They are doing it, not you | `needs-decision` |
| Parked by agreement | `deferred` |
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
is writes only the thread; `updatedBy`/`updatedAt` still name whoever last
*moved* the item. So you can add context to somebody else's item without
appearing to take it — and cannot take it by commenting. (Every message used to
repaint `updatedBy`; three stand-down notes on another agent's items once made
them read as the commenter's.)

On a check-in, an item at `in-progress` is one of these — `updatedBy` and
`updatedAt` say which, and the clock you noted at session start is the reference:

| What you see | What it is | Do |
|---|---|---|
| `updatedBy` is you, `updatedAt` after your session began | your own work | carry on |
| `updatedBy` is you, from before your session | **you crashed** | read the thread, resume or hand back |
| another agent, `updatedAt` older than your session began | **stale claim** | say so in the thread, reclaim, name whose claim you took |
| another agent, recent | somebody is on it | leave it alone |

No fixed timeout, deliberately: "older than my session began" needs no clock
everyone agrees on, and it is the real question — is anybody still here.

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

**The last `pass` signs the item off.** The board posts "All N steps passed —
signed off by <actor>" and hands the item back at `received` for you to land
and close. A `fail` or `skip` anywhere leaves it at `needs-qa` with the note on
the step. Whoever records the passes — a person, or a model doing the QA — is
the sign-off.

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

**Your name is `settings.agentNames[<tool>]`** — `{"claude-code":"spike",
"codex":"codex"}`, set by the human — else the tool name. One rule; the earlier
one offered two ("the tool you run as, or the name they call you") and the
reference board reached one agent under two names. Repair an existing split
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
with `PATCH /api/projects/<slug> {"repos":[…]}`.

### Sections, labels, grouping

`labels` (any number per item) say how items **relate** — one release, one
blocker, one subsystem. `section` (at most one) is the **area of work**, never
the kind or the state of the item. `GET /api/projects/<slug>` returns both
vocabularies with counts: **reuse a name**; a near-synonym splits one list into
two that both look complete. Repairs: `PATCH …/labels` and `PATCH …/sections`
`{"from","to","actor"}` (empty `to` removes a label). `project.groupBy`
(`status`, the default, or `section`) and `project.sectionMode` (`adhoc`
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
   reaches `received`; a comment on one is never itself actionable.
3. **Plan across the set.** Find the shared work (three items touching one
   file are one edit and one test run). Order by what unblocks what. Separate
   the answerable from the buildable and do the answers first — they are cheap
   and may change what you build. Name what you are not doing and why. **Say
   the plan in a few lines before executing it**; redirecting a plan costs far
   less than redirecting finished work.
4. Report the plan, then the outcome, one line per item.
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
- `CONTRIBUTING.md` — what needs a pull request and what you can do without one.
