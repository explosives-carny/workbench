# Onboarding — first use on a fresh install

`GET /api/settings` with no `onboardedAt` means nobody has been asked how they
want the board used. **Put the setup questions on the board rather than asking
in chat.** It is the shortest introduction to the tool: the human answers their
first items in the interface they will use from then on, and the answers are
recorded where every later session can read them.

Label them `Setup` in the project you are working in (or a `Workbench setup`
project if there is none yet), then say one line in chat: *"I have put seven
setup questions on the board — answer them there and I will pick them up."*

A label rather than a section, because the default grouping is by status and a
section would file them where nothing displays.

```bash
POST /api/projects/<slug>/items
[
 {"labels":["Setup"],"clientId":"setup-1","title":"Should I put decisions on the board automatically?",
  "context":"Automatic means anything needing your call becomes an item without you asking. Recommended.",
  "options":["Automatic","Only when I ask"]},
 {"labels":["Setup"],"clientId":"setup-2","title":"Should I read the board at the start of every session?",
  "context":"So a decision you make today is acted on tomorrow without you re-raising it. Recommended.",
  "options":["Yes","Only when I say so"]},
 {"labels":["Setup"],"clientId":"setup-3","title":"Should defects and risks I find go on the board?",
  "context":"Otherwise they live in the transcript and disappear with it. Recommended.",
  "options":["Put them on the board","Tell me in chat"]},
 {"labels":["Setup"],"clientId":"setup-4","title":"Should I post a summary before I finish a session?",
  "context":"Useful if somebody else picks the work up; noise if it is only you.",
  "options":["Yes","No"]},
 {"labels":["Setup"],"clientId":"setup-5","title":"Where should the database be backed up?",
  "context":"It is one file on one machine. The server exports every project as JSON to ~/workbench-content after each change and commits if that directory is a git repository; nothing pushes it anywhere. Point WORKBENCH_CONTENT at a private repository you push, or somewhere you already back up. Declining is a legitimate answer and I will not ask again.",
  "options":["A private git repo","Somewhere else I already back up","Accept the risk, no backup"]},
 {"labels":["Setup"],"clientId":"setup-6","title":"Which repositories is this project about?",
  "context":"So a session finds this board from the repository it is standing in. Remotes (owner/name or a git URL) and directory paths; a trailing * covers every worktree under a path. If you work across several projects, also name the one that should catch anything I do not place explicitly.",
  "options":["This repository only","Several — I will list them","I will say each time"]},
 {"labels":["Setup"],"clientId":"setup-7","title":"How should the board be organised?",
  "context":"THE STANDARD FRAMEWORK, recommended, and already the default: rows group by Open / Deferred / Documents / Archived, and labels carry how items relate to each other — a release, a person they are blocked on, a subsystem. It answers the question a board is for, 'what is waiting on me', without you deciding a taxonomy on day one. BY AREA OF WORK: rows group by section instead — Ship it, Design, Infrastructure — one per item, and we agree either to let the list emerge or to fix it now. SOMETHING ELSE: tell me how you want to work and I will propose a configuration; the statuses themselves are fixed, but grouping, labels and sections are all yours to arrange.",
  "options":["The standard framework","By area of work","Something else — let's talk"]}
]
```

When they answer, write the results to settings and **close the items** — a
setup question left open forever is noise on a board meant to show what is
outstanding:

```bash
PATCH /api/settings {"onboardedAt":"<iso>","autoCapture":true,"checkInOnStart":true,
                     "postFindings":true,"summariseOnExit":false,
                     "backupPlan":"<path|repo|none>","defaultProject":"<slug>",
                     "agentNames":{"<your tool>":"<the name they call you, or the tool>"}}
PATCH /api/projects/<slug> {"repos":["owner/name","~/code/name*"]}
PATCH /api/items/<id> {"status":"complete","actor":"<you>","ifVersion":N}
```

| Key | From | Default if they never answer |
|---|---|---|
| `autoCapture` | question 1 | `true` |
| `checkInOnStart` | question 2 | `true` |
| `postFindings` | question 3 | `true` |
| `summariseOnExit` | question 4 | `false` |
| `backupPlan` | question 5 | ask again next session; never assume `"none"` |
| `project.repos`, `defaultProject` | question 6 | infer `repos` from the repository you are in |
| project `groupBy` | question 7 | `status` — the standard framework |
| `agentNames` | — | the tool name; ask what they call you if they use one |

**The standard framework** is the default, so choosing it means doing nothing.
Say what they have, once, rather than staying silent — most people have never
seen this tool before:

> Rows group by Open, Deferred, Documents and Archived. Labels relate items
> across those groups. Newest activity sits at the top of each group, and a
> group with nothing in it does not appear.

**By area of work** switches the grouping and then needs the loose-or-fixed
conversation, which is the one thing worth getting right up front:

```bash
PATCH /api/projects/<slug> {"groupBy":"section"}
```

Loose (`adhoc`, the default) accepts any section and warns on a near-duplicate.
Fixed (`declared`) refuses anything unlisted. Loose is the better answer on day
one — you rarely know the areas yet, and a taxonomy guessed early is expensive to
admit was wrong. For fixed, agree six to eight first:

```bash
PATCH /api/projects/<slug> {"groupBy":"section","sectionMode":"declared","sections":["Ship it","Design"]}
```

**Something else** is a real conversation, not a menu. Ask how they actually
work, what they need to see first thing in the morning, and whether anything
else reads this board. Then propose a configuration and set it.

What is arrangeable: the grouping (`status` or `section`), the section
vocabulary and whether it is enforced, and labels — which need no configuration
at all and cost nothing to start using.

What is **not**: the status vocabulary itself. Those are fixed, and that is
deliberate — they are the contract every agent writing to this board speaks, and
a set that varies per install means no instruction about status can ever be
written down. If the framework does not fit their work, that is a pull request
against this repository, not a local setting. See `CONTRIBUTING.md`.

`"none"` for `backupPlan` is a real answer. Record it and **never raise backups
again** — nagging about a knowingly accepted risk is how people stop reading
what you write.

Then honour all of it. Asking and then behaving identically is worse than not
asking.

## Settings panels on the page

Every setting in the table above, plus a project's `groupBy`, `sortBy`,
`sectionMode`, `sections` and `repos`, now has a control on the page itself —
a person does not have to know the API to change them. Board settings are a
collapsed **Board settings** panel on the home page; a project's own settings
are a collapsed **Project settings** panel on its page, under the masthead.
Both save each control as it changes; nothing here needs an agent to set it,
though an agent still may. `autoMode` and scope are never among them — those
are a session's working orders, not a setting, and have no place on this page
or in `settings` at all.
