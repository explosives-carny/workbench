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
3. `counts["needs-you"]` is what is waiting on the human.

## Objects

| Object | Is | Key fields |
|---|---|---|
| Project | one body of work | `slug` (its address), `name` |
| Item | one thing needing a person | `title`, `context`, `options[]`, `choice`, `status`, `section`, `version` |
| Message | one turn in a thread | `who` (`you`\|`agent`), `author`, `text` |
| Check | one step of a checklist | `id`, `label`, `result`, `note` |

`body` + `bodyFormat` (`text`\|`markdown`\|`html`) hold long-form content.
**`body` is stripped from list responses** — `GET /api/items/<id>` for the full
text; `bodyLength` in a list tells you one is there.

## Status — whose move is it

| Status | Whose move | Set by |
|---|---|---|
| `needs-you` | the human's | you, when you ask |
| `received` | yours — you have the answer | automatic when the human replies |
| `deferred` | nobody's, on purpose | either, with a reason in the thread |
| `complete` | done | you, once the work landed |

`complete` claims the work is finished, not that you asked. `deferred` never
means "still waiting on them" — that is `needs-you`.

## Calls

```bash
# create a project (idempotent by slug)
POST  /api/projects                      {"name":"Acme Site","description":"..."}

# create items — POST AN ARRAY for a whole set in one call
POST  /api/projects/<slug>/items         [{"title":"...","context":"...","options":["Do it","Hold"],"section":"Ship it"}]

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

Human says **`workbench`** or **`wb`** →

1. `GET /api/projects`, then each project.
2. Find items whose newest message is `who: "you"`, or whose `choice` has no
   agent reply after it.
3. Do the work. Post a message per item. Set the status.
4. Report one line per item. Nothing waiting → say so in one line.

Never create items on a check-in. It means catch up, not ask.

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
