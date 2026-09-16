# Workbench — agent contract

Vendor-neutral. Plain HTTP and JSON. Base URL `http://localhost:4317`
(`WORKBENCH_PORT` overrides).

**Read this file once per session, then use the API.** Do not open the web UI to
find something out — every fact below comes back from one call, and browsing is
slower for you and invisible to the next session.

## Session start, in order

```bash
curl -s localhost:4317/api/settings          # 1. how this human wants it used
curl -s localhost:4317/api/projects          # 2. what exists, with counts
curl -s localhost:4317/api/projects/<slug>   # 3. one project: items + threads
```

1. `settings.onboardedAt` missing → ask the onboarding questions once (below),
   record the answers, proceed. Present → say nothing about setup.
2. Act on every item at `received` **before** creating anything new.
3. `counts["needs-decision"]` + `counts["needs-qa"]` is what is waiting on the human.

**Read once, here.** After this, the board is read again only on the check-in
word — see below for why, and for how to plan a round once you have one.

## Objects

| Object | Is | Key fields |
|---|---|---|
| Project | one body of work | `slug` (its address), `name` |
| Item | one thing needing a person | `title`, `context`, `options[]`, `choice`, `status`, `section`, `labels[]`, `version` |
| Message | one turn in a thread | `who` (`you`\|`agent`), `author`, `text` |
| Check | one step of a checklist | `id`, `label`, `result`, `note` |

Every item and message carries `createdAt`. It is set for you. Send one **only**
when you are importing history that already happened — a past ISO instant;
anything unparseable or in the future is ignored and the clock is used instead.
Never send one to make a fresh item look older.

`body` + `bodyFormat` (`text`\|`markdown`\|`html`) hold long-form content.
**`body` is stripped from list responses** — `GET /api/items/<id>` for the full
text; `bodyLength` in a list tells you one is there.

## Status — whose move is it

Five are work. Two are documents. They are not one scale.

| Status | Whose move | Set by |
|---|---|---|
| `needs-decision` | the human's — they must choose | you, when you ask |
| `needs-qa` | the human's — the work is built, it needs checking | you, when you finish something they must approve — **with the steps attached** |
| `received` | yours — you have the answer | automatic when the human replies |
| `deferred` | nobody's, on purpose | either, with a reason in the thread |
| `complete` | done | you, once the work landed |

**Setting `needs-qa` without steps is incomplete.** Attach `checks` to that item
— the specific things somebody must do to satisfy themselves the work is right —
and post a message saying what changed. Anyone on the board can then pick it up
and record a result per step, without you in the room.

```bash
PATCH /api/items/<id> {"status":"needs-qa","actor":"<you>","ifVersion":7,
  "checks":[{"id":"s1","label":"1. Turn a switch on; the thumb is visible in both themes"},
            {"id":"s2","label":"2. Helper text under a field is sentence case, not caps"}]}
```

Do **not** write a separate QA runbook document any more. A standalone
walkthrough covering eight changes at once goes stale the moment one of them
moves, cannot be worked by two people, and leaves every item on the board saying
"see the runbook" — which is how a board stops being the record. Steps belong on
the thing they verify.

Write a step as something to do and a result to expect, numbered. Three precise
steps beat twenty vague ones.

`needs-decision` and `needs-qa` are both "waiting on them" and they are **not**
interchangeable. "Choose between these options" and "I finished, check it" take
different amounts of a person's attention and cannot be triaged together. If
nothing is built yet, it is a decision; if something is built and needs their
eyes, it is QA.

**Documents are not tasks**, and `kind` is what says so. Set it on create.

| `kind` | Is | Statuses it may hold |
|---|---|---|
| `issue` (default) | something to decide or do | the five above |
| `document` | something to read or work through | `active` · `archived` |

| Status | Means |
|---|---|
| `active` | the current reference, still worth reading |
| `archived` | superseded or shipped; kept for the record |

The two sets do not overlap and the board enforces it: a status the kind cannot
hold is replaced with that kind's default, and naming both a `kind` and an
impossible `status` in one call is a `400`.

Never file a document as `complete` to get it off the board. That hides the
board's most-read material behind the completed filter on the day it is written.

**A document that asks for something is two items.** The document is `active`;
the ask is its own `issue`. A decision buried in a specification is a decision
nobody can answer, because the document has nowhere to put the answer.

Changing `kind` later is fine — a decision that turns out to be a specification,
or the reverse. The status follows it automatically unless you set a valid one
in the same call.

`needs-you` is still accepted on input and stored as `needs-decision`.

`complete` claims the work **landed**, not that you finished typing. Work that is
written but sitting in an unmerged pull request, an undeployed branch or a queue
is still `received` — you own it, it is not done. Say in the thread what it is
waiting on, so "received" does not read as "forgotten".

`deferred` never means "still waiting on them" — that is `needs-decision` or `needs-qa`.

Set the status to whose move it actually is, not to how much effort you spent:

| Situation | Status |
|---|---|
| You need them to choose | `needs-decision` |
| You built it; they must approve it | `needs-qa` |
| They answered, you are working | `received` |
| Written, PR open, not merged | `received` — and say so |
| Merged and running | `complete` |
| They are doing it, not you | `needs-decision` |
| Parked by agreement | `deferred` |
| A document people still work from | `active` |
| A document overtaken by events | `archived` |

**Correct your own status when you get it wrong.** A status that misdescribes
the state is worse than a stale one, because somebody trusts it. Post a message
saying what you are correcting and why, and change it — do not quietly flip it.

## Calls

```bash
# create a project (idempotent by slug)
POST  /api/projects                      {"name":"Acme Site","description":"..."}

# create items — POST AN ARRAY for a whole set in one call
POST  /api/projects/<slug>/items         [{"title":"...","context":"...","options":["Do it","Hold"],"labels":["Ship it"]}]

# labels in use on a project come back with the board (GET above), like sections
# rename or merge a label everywhere; "to":"" removes it
PATCH /api/projects/<slug>/labels        {"from":"Deploys","to":"Ship it","actor":"<you>"}

# how the board groups its rows: "section" (default) or "status"
PATCH /api/projects/<slug>                {"groupBy":"status"}

# reply, and acknowledge
POST  /api/items/<id>/messages           {"who":"agent","author":"<you>","text":"..."}

# record a decision you acted on
PATCH /api/items/<id>                    {"status":"complete","actor":"<you>","ifVersion":4}

# one checklist step — never the whole array
PATCH /api/items/<id>/checks/<checkId>   {"result":"fail","note":"required unless pass","by":"<name>"}

# a document in full
GET   /api/items/<id>                    → item.body
GET   /api/items/<id>/body               → raw, correct content-type

# preferences
GET | PATCH /api/settings
```

Errors are `{"ok":false,"error":"..."}` — `400` malformed · `404` bad id or slug
· `409` version conflict, with the current item attached.

## Concurrency

- **Messages never conflict.** Append one rather than editing an item whenever
  you are recording something that happened.
- **Item edits can.** Send `ifVersion` from the copy you read. On `409`, merge
  onto the item in the response and retry — do not re-read and blind-write.
- Omit `ifVersion` only for an item you just created.
- **Always send `author` on messages and `actor` on edits.** Omit them and the
  board records the literal string `agent` — so every row reads the same and the
  "who answered last" column is useless exactly when it matters, with two agents
  working. Use a short, stable name a human will recognise: the tool you run as
  (`claude-code`, `codex`, `cursor`), or the name they call you. Keep it the same
  between sessions; a name that changes is no better than none.
- Checklist steps: one `PATCH` per step. Sending the array loses concurrent
  answers.

## The check-in word

**The board is read on the check-in word, and at session start. Not otherwise.**

Between check-ins, do not poll it, do not re-read it to see whether they have
replied, and do not answer an item the moment you notice an answer. They are
still typing. An agent that reacts to each reply as it lands turns one round of
decisions into a dozen half-plans, and each one costs a full pass over the work.
Their answers keep. Read them all at once.

Human says **`workbench`** or **`wb`** →

1. `GET /api/projects`, then each project. **Read everything before doing
   anything.**
2. Collect every actionable: newest message is `who: "you"`, or a `choice` with
   no agent reply after it, or an item at `received` you have not acted on.
3. **Plan across the whole set, not item by item.** Then execute the plan.
4. Report the plan, then the outcome. Nothing waiting → say so in one line.

Never create items on a check-in. It means catch up, not ask.

### Planning the set

The point of batching is that the set tells you things no single item does.

- **Find the shared work.** Three items touching one file are one edit and one
  test run, not three. Two that need the same measurement need it once.
- **Order by what unblocks what.** An item that changes an interface comes before
  the items that use it. Say so rather than discovering it halfway.
- **Separate the answerable from the buildable.** A question you can answer in a
  paragraph is not the same job as a change that needs a branch and CI. Do the
  answers first — they are cheap and they may change what you build.
- **Name what you are NOT doing and why.** An item you are deferring to the next
  round is a decision, and it belongs in the plan rather than in silence.
- **Say the plan before executing it**, in a few lines. They may redirect it, and
  redirecting a plan costs far less than redirecting finished work.

### Whether to delegate

Some rounds are worth spreading across subagents; most are not. This is a real
tradeoff — parallel agents finish sooner and cost substantially more, and every
agent's output has to be read and verified by you anyway.

Delegate when **all** of these hold:

- the work splits into parts that do not touch the same files
- each part is big enough to be worth an agent's startup cost — roughly, more
  than you would finish inline in fifteen minutes
- you can state each part's done condition precisely enough to verify without
  redoing it

Do it inline when any of these hold:

- the parts share files, or one part's result changes another's shape
- the whole round is small, or is mostly answering questions
- verifying the result means reading everything the agent read

**Say which you chose and why, in one line, before you start** — "inline: four
items, same two files, one test run" or "three agents: independent subsystems,
~40 min each". If the scope grows past what you announced, say so and re-decide
rather than quietly continuing.

When the balance is genuinely unclear, put the choice to them with a rough cost
rather than guessing. They are paying for it.

## Onboarding — first use in a session only

`settings.onboardedAt` missing → **put the setup questions on the board rather
than asking in chat.** It is the shortest possible introduction to the tool: the
human answers their first items in the interface they will use from then on, and
the answers are already recorded where every later session can read them.

Create a `Setup` section in the project you are working in (or a `Workbench
setup` project if there is none yet), then say one line in chat: *"I have put
six setup questions on the board — answer them there and I will pick them up."*

```bash
POST /api/projects/<slug>/items
[
 {"section":"Setup","title":"Should I put decisions on the board automatically?",
  "context":"Automatic means anything needing your call becomes an item without you asking. Recommended.",
  "options":["Automatic","Only when I ask"]},
 {"section":"Setup","title":"Should I read the board at the start of every session?",
  "context":"So a decision you make today is acted on tomorrow without you re-raising it. Recommended.",
  "options":["Yes","Only when I say so"]},
 {"section":"Setup","title":"Should defects and risks I find go on the board?",
  "context":"Otherwise they live in the transcript and disappear with it. Recommended.",
  "options":["Put them on the board","Tell me in chat"]},
 {"section":"Setup","title":"Should I post a summary before I finish a session?",
  "context":"Useful if somebody else picks the work up; noise if it is only you.",
  "options":["Yes","No"]},
 {"section":"Setup","title":"Where should the database be backed up?",
  "context":"It is one file on one machine. Nothing here replicates it. `bun run export <dir>` writes one JSON file per project — point it at a private git repository. Declining is a legitimate answer and I will not ask again.",
  "options":["A private git repo","Somewhere else I already back up","Accept the risk, no backup"]},
 {"section":"Setup","title":"Where should new items land by default?",
  "context":"If you work across several projects, name the one that should catch anything I do not place explicitly.",
  "options":["This project","I will say each time"]},
 {"section":"Setup","title":"How should we organise sections?",
  "context":"A section is the area of work — Ship it, Design, Infrastructure. Loose: I use my judgement, reuse what is there, and flag anything that looks like a duplicate. Fixed: we agree the list now and I am refused anything outside it. Loose is recommended; you rarely know the areas on day one, and we can fix the list later once the shape is obvious.",
  "options":["Loose — let it emerge","Fixed — let's agree the list now"]}
]
```

When they answer, write the results to settings and **close the items** — a
setup question left open forever is noise on a board meant to show what is
outstanding:

```bash
PATCH /api/settings {"onboardedAt":"<iso>","autoCapture":true,"checkInOnStart":true,
                     "postFindings":true,"summariseOnExit":false,
                     "backupPlan":"<path|repo|none>","defaultProject":"<slug>"}
PATCH /api/items/<id> {"status":"complete","actor":"<you>"}
```

| Key | From | Default if they never answer |
|---|---|---|
| `autoCapture` | question 1 | `true` |
| `checkInOnStart` | question 2 | `true` |
| `postFindings` | question 3 | `true` |
| `summariseOnExit` | question 4 | `false` |
| `backupPlan` | question 5 | ask again next session; never assume `"none"` |
| `defaultProject` | question 6 | infer from the repository |
| project `sectionMode` | question 7 | `adhoc` |

If they choose **Fixed**, have the conversation before setting it: ask what the
areas of this work actually are, propose a starting list from what you can see
in the repository, and agree six to eight. Then:

```bash
PATCH /api/projects/<slug> {"sectionMode":"declared","sections":["Ship it","Design","..."]}
```

If they choose **Loose**, do nothing — it is the default — and simply honour the
section rules below.

`"none"` for `backupPlan` is a real answer. Record it and **never raise backups
again** — nagging about a knowingly accepted risk is how people stop reading
what you write.

Then honour all of it. Asking and then behaving identically is worse than not
asking.

## Sections

`section` is the **area of work** — one axis, always. Not the kind of item
(`bodyLength` and `checks` say that), not its state (`status` says that).

`GET /api/projects/<slug>` returns `sections` — the vocabulary in use, with
counts. **Read it and reuse a name.** Do not derive it by scanning items and do
not invent a synonym; "Deploys" beside "Ship it" splits one area into two lists
and both then look complete.

Two modes, set per project by the human at onboarding:

| `project.sectionMode` | Behaviour |
|---|---|
| `adhoc` (default) | Any section accepted. A near-duplicate comes back as a `warning` on the response — read it and act on it. |
| `declared` | Only `project.sections` accepted. Anything else is a `400` listing what is allowed. |

Never switch the mode yourself; it is the human's call.

No good fit → **leave `section` empty.** An unsectioned item sorts to the top and
gets placed; a mis-sectioned one is filed and invisible.

Repair, when two names turn out to be one area:

```bash
PATCH /api/projects/<slug>/sections  {"from":"Deploys","to":"Ship it","actor":"<you>"}
```

Full reasoning and failure modes: `docs/what-goes-here.md`.

## Labels

`labels` is an array, any number per item, and it is the field for how items
**relate** — the three that are one release, the two blocked on the same person.
Crosswise to `section` (one area of work) and to `status` (whose move it is).

`GET /api/projects/<slug>` returns `labels` with counts, the same way it returns
`sections`. **Read it and reuse a name.** Nothing governs a label on the way in,
so they rot faster than sections do — trimmed and de-duplicated case-insensitively
on write, and nothing more.

Repair: `PATCH /api/projects/<slug>/labels {"from":"...","to":"...","actor":"..."}`.
An empty `to` removes the label; renaming onto an existing one merges.

## Grouping

`project.groupBy` decides what the board's headings are:

| `groupBy` | Groups |
|---|---|
| `section` (default) | one per area of work |
| `status` | Open · Deferred · Documents · Archived |

A group with nothing visible in it does not render at all. Rows sort newest
activity first within their group, so what just moved is at the top.

Never switch it yourself; it is the human's call.

## Rules

1. One item per question. Two questions in one item loses one.
2. Write context answerable without you present: name the tradeoff, recommend
   one, say what being wrong costs.
3. Post a message when you act. The thread is the record.
4. Never fake a human reply. `who: "you"` only when relaying something they
   actually said, and say that it is relayed.
5. Close what you finish.
6. Never edit this application to add a feature — branch and open a pull
   request. See `CONTRIBUTING.md`.

## Further reading

- `docs/what-goes-here.md` — what to create and when, how to segment projects,
  the item kinds, and the checklist template.
- `CONTRIBUTING.md` — what needs a pull request and what you can do without one.
