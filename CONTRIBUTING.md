# Contributing — including if you are an agent

This applies to coding agents as much as to people, and in one respect more: an
agent is likelier to fix a limitation by editing the copy in front of it, which
silently forks everybody's tool.

## The rule

**Change the application by pull request, never by editing the installed copy.**

Pull requests are welcome. What is ruled out is the private edit: changing the
copy that is running on your machine so one project works, where nobody reviews
it and the next update overwrites it.

If a board is missing something you need, you have three routes. The first two
need nobody's permission; the third is the normal way the tool gets better:

1. **Use what is there.** Most "I need a new type" turns out to be a section, a
   status, or a document with a body. Check [`docs/what-goes-here.md`](docs/what-goes-here.md)
   before concluding otherwise.
2. **Keep it in your own data.** Conventions in titles, sections and message
   text cost nothing and need no permission. A project that prefixes item titles
   with `[risk]` has invented a type without changing a line of code.
3. **Open a pull request.** Anything that changes behaviour for every user of
   this tool goes through a branch, a documented pull request and a review by a
   person. Open it early: a small pull request with a clear reason is easier to
   review than a finished feature nobody saw coming.

An agent that edits the working copy to add a feature has not improved the tool;
it has given one machine a private version that the next update overwrites and
nobody else can reproduce.

## Who may change the application

Anyone with **write access to this repository** may change the application, and
they are encouraged to. Write access is granted by the repository owner as a
GitHub collaborator; that list, not this file, is who the contributors are.

Contributors, and the agents working for them:

- **Pull requests change the tool, nothing else.** A pull request is an update
  to this application for every installation — its code, its contract, its
  docs. It never carries **project data or configuration**: no board items,
  projects, labels, sections, messages or documents; no database file
  (`workbench.db`) or export; no settings, ports, paths, remotes or
  environment values from a particular installation; no example data lifted
  from a real board. Those belong to the installation, in its own database and
  content repository, and change there without a pull request. If a change only
  makes sense for one project, it is data, not a pull request (see *The rule*).
- **Change it only by pull request into `main`.** Never push to `main`, and never
  change an installed copy to get a result the repository does not have.
- **Open pull requests early and often.** Draft pull requests are fine. A change
  that waits on your machine helps nobody and drifts from `main`.
- **Document every pull request twice** (see *How a pull request is
  documented* below). The description check refuses one that is missing either
  part.
- **Do not merge your own pull request.** The repository owner reviews and
  merges; the point is that a person who did not write the change decides what
  every other installation inherits.
- **Keep installation names out of it** — the rule under *What a good pull
  request contains* applies to contributors exactly as it does to agents.

## How a pull request is documented

Every pull request description has these two sections, filled in. The template
in `.github/pull_request_template.md` puts them there; the `pr-description`
check fails a pull request where either is missing, empty, or still the
template's placeholder text.

**`## Detail (for an agent)`** — written for the next agent or engineer who
has to understand, review or extend the change without asking you. What
changed and why, file by file where it matters; any route, field, status or
rule added or changed, with its exact shape; whether the contract version
moved; migrations and how an old database opens; the tests that prove it and
what they do not prove; anything left undone.

**`## Summary (for a project manager)`** — plain words, no code. What someone
using the board will notice: what they can now do, what looks or behaves
differently, what they no longer need to do. If nothing a user sees changes,
say so in one sentence ("No visible change — this makes X safer to change
later"). Three to six short bullets is the right size.

## What needs a pull request

| Change | PR? |
|---|---|
| A new label, section, project, or naming convention | No — that is data |
| A new status in `STATUSES` | **Yes** — every board speaks this vocabulary |
| A new `bodyFormat` | **Yes** — the renderer and the contract both move |
| A schema column, table or index | **Yes**, and it must migrate (below) |
| A new API route or response field | **Yes** — `AGENTS.md` is a contract others rely on |
| Anything in `AGENTS.md`, `README.md` or `docs/` | **Yes** — that is the contract |
| A fix to your own local styling | No, but do not expect it to survive |

## How an agent opens one

```bash
git checkout -b <short-descriptive-branch>
# change, with tests
bun test
git add <explicit paths>          # never -A, never .
git commit
git push -u origin <branch>
gh pr create --base main     # the template supplies the two required sections
```

Then **stop and tell the human the PR is open.** Do not merge your own pull
request, and do not push to `main`. The point of this rule is that a person
decides what every other installation inherits; merging your own change defeats
it completely.

If you cannot push — no remote, no credentials, not your repository — say so and
leave the branch locally with a clear commit. Do not work around it.

## What a good pull request contains

- **A reason a stranger can evaluate.** What broke, or what could not be
  expressed. "It would be nice" is not a reason; "a 41-step walkthrough could
  not be stored because items had no body" is.
- **Tests for the behaviour, not the implementation.** The suite has no
  dependencies and runs in under a second; there is no excuse for skipping it.
- **A migration if the schema moved.** Additive only, guarded by a `PRAGMA
  table_info` check the way the existing columns are. People install this at
  different times and an old database must still open. Never drop or rename a
  column in place.
- **The contract updated in the same PR** if the API changed. An `AGENTS.md`
  that describes a version nobody is running is worse than no contract.
- **Comments that say why.** The existing code explains the reasoning behind
  decisions that look arbitrary — match that. A comment restating the code earns
  nothing.
- **No names from the board it was built for.** Commit messages and pull request
  text are published with the code and outlive every edit to them. Describe the
  failure in the tool's own terms: never a project, product, company, person,
  domain or URL from the installation where it came up. "A renamed product had
  no way to change its board's name" is enough.

## What will be refused

- A dependency, unless it does something genuinely hard. This installs with
  `bun run start` and no network; a Markdown renderer was written by hand rather
  than pulled from a CDN precisely because a document that needs the network to
  be readable is not a record.
- Authentication, accounts or multi-tenancy. It binds to `127.0.0.1` for one
  person. If you need a service, this is the wrong tool.
- Anything that sends data anywhere. Nothing here leaves the machine, and that
  is a feature rather than an oversight.
- A status that means "waiting on the human" under a different name. That
  mistake has already been made and corrected once.

## Extending without changing the code

Worth trying first, because it needs nobody's permission:

- **Types** — `labels`, or a title prefix. `Release 3`, `Findings`, `blocked on
  Ops` are labels in the reference board and were never a schema feature. A
  label costs nothing to invent and nothing to abandon.
- **Templates** — an agent posting a set of items with consistent titles and
  contexts is a document type. Keep the template in your own instructions.
- **Structured bodies** — `bodyFormat: "markdown"` holds tables, checklists and
  anything else you can write down, and reads back through the API as plain
  text.
