# Contributing — including if you are an agent

This applies to coding agents as much as to people, and in one respect more: an
agent is likelier to fix a limitation by editing the copy in front of it, which
silently forks everybody's tool.

## The rule

**Do not change the installed application to make one project work.**

If a board is missing something you need, you have three options, in order:

1. **Use what is there.** Most "I need a new type" turns out to be a section, a
   status, or a document with a body. Check [`docs/what-goes-here.md`](docs/what-goes-here.md)
   before concluding otherwise.
2. **Keep it in your own data.** Conventions in titles, sections and message
   text cost nothing and need no permission. A project that prefixes item titles
   with `[risk]` has invented a type without changing a line of code.
3. **Open a pull request.** Anything that changes behaviour for every user of
   this tool goes through a branch and a review — by a person.

An agent that edits the working copy to add a feature has not improved the tool;
it has given one machine a private version that the next update overwrites and
nobody else can reproduce.

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
gh pr create --base main
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
