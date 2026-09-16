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
POST  /api/projects                      {"name":"Ops Guide","description":"..."}

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
- Always send `author` / `actor`. "Who changed this" is the first question asked.
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

`settings.onboardedAt` missing → ask once, in one message, with your
recommendation on each. Record every answer including refusals; a `false` is an
instruction that must outlive the session.

| Key | Question | Default |
|---|---|---|
| `autoCapture` | Put decisions on the board automatically? | `true` |
| `checkInOnStart` | Read the board every session unprompted? | `true` |
| `postFindings` | Defects and risks go on the board? | `true` |
| `summariseOnExit` | Post what you did before finishing? | `false` |
| `defaultProject` | Where do new items land? | ask, or infer from the repo |

```bash
PATCH /api/settings  {"onboardedAt":"<iso>","autoCapture":true,"...":"..."}
```

Then honour them. Asking and then behaving identically is worse than not asking.

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
