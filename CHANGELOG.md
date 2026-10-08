# Changelog

## Unreleased

- Any item can be handed to someone else for a second opinion. The "Get a 2nd
  opinion" button on an item's page copies a short write-up of it: the
  project, what the item is and why it exists, the question, the options with
  the recommended one marked, the discussion in order with who said what, where
  it stands, and a closing "What would you choose and why? What am I missing?".
  It is written to make sense to another AI or a person who has never seen the
  board. Anything that looks like a password or key is blanked out, and the
  write-up is shown on the page as well, so it can be copied by hand when the
  browser will not copy it. Agents get the same text from `wb brief`
  (contract v21). Nothing is sent anywhere and the item does not change.
- A to-do list sorted by due date now puts high priority before low among
  to-dos due the same day, and among those with no date, the same order
  `wb todos` already prints. Before, those ties fell back to most recent
  activity.
- To-do lists tell overdue, today and tomorrow apart at a glance. Overdue is
  a filled red chip marked "!" on a red-tinted row; due today is a bold orange
  chip on an orange-tinted row; due tomorrow is an amber chip with an amber
  row edge; due within the week is an outlined chip; anything later is plain.
  The due layout groups by the same bands. Done, cancelled and deferred to-dos
  show their date without any alarm. Nothing stored or sent changes.
- The board has a favicon: a rust tile with a checked list, in the board's
  own accent colour, with a lighter version for a dark browser.

- Decision explanations and replies now show formatted (lists, tables, bold),
  and the board warns agents who write a wall of text or an option that points
  at "the table above"; the audit lists the same (contract v20).
- Items waiting on QA now say who does it: each step is marked for a person
  or an agent, and the board shows the item as Human QA, Agent QA or Mixed QA,
  with each step tagged. The QA filter counts each kind, and the "whose move"
  layout puts QA the agent is running with the agent's work instead of yours.
  Steps without a mark count as yours (contract v17).
- A board can now list what is out of line with the current rules — decisions
  with no recommendation, QA with no steps or unmarked steps, blocked items that
  do not say why — so each project's agent can tidy its own items after an
  update (`wb audit`, contract v17).
- A project can now be created as a to-do list. Its items are your own
  to-dos: To do, Deferred, Complete or Cancelled, each with an optional due
  date and priority (P1, P2, P3). Open to-dos are highlighted by how close they
  are due: overdue, within 3 days, within 7 days, within 30 days, each in its
  own style in both themes. A to-do list can group or order by due date or
  priority. Replying on a to-do never moves it, and a passing due date never
  changes its status. Every other project works exactly as before and shows
  none of this. A project's kind can change only while it holds no decisions
  or to-dos, and restoring a backup never turns to-dos into decisions or the
  other way round (contract v18).
- To-do priorities now read High, Medium and Low on the page and in `wb`,
  instead of P1, P2 and P3. `wb priority` takes the words too. Nothing
  stored or sent through the API changes.
- Agents can now keep a to-do list for you: `wb todo` adds one in your
  words, `wb todos` lists what is open, due first, with how many days are left
  or overdue, and `wb projects` shows a to-do list by what it holds. The rules
  say an agent touches your list only on your word, turns "Friday" into a real
  date and says it back, and never closes a to-do because its date passed.
  Priority can be sent as high, medium or low (contract v19).
- A decision now shows which answer the agent recommends: that button carries
  a "Recommended" tag and a heavier border, instead of the agent writing
  "(Recommended)" into the answer text. Agents are expected to name at least one
  recommendation on any decision that offers buttons: for now the board accepts
  one without and tells the agent what to add, and the next contract version
  will turn it away. An answer written the old way, ending "(Recommended)", is
  converted into the tag automatically. Items filed before this change still
  work as before, including reopening them from the status menu (contract v16).
- When an old-style "(Recommended)" answer is converted, a decision that was
  already answered with it keeps showing that answer as chosen.
- Board settings now check what they are given: a setting with the wrong kind
  of value is refused with a message saying which one, and an unknown setting
  name is not saved and is reported back, instead of either being stored and
  breaking the settings panel (contract v15).
- Restoring a board from its backup now brings back each project's layout,
  sections, colour and archived state, not just its items and name. An archived
  project keeps the date it was archived.
- A document or item body sent without saying its format is now shown the right
  way: a whole web page renders as a page, and Markdown renders formatted,
  instead of either showing up as raw source. A format the writer names is
  always kept (contract v14).

## 0.2.0

- Project settings (how the board groups and orders rows, its name, description,
  key, section rules, and which repositories it belongs to) now have controls
  right on the project page, instead of only being reachable through the API.
- Board-wide settings (the onboarding answers, the default project, the backup
  plan, and agent names) now have the same kind of controls on the home page.
- Board rows always show the item's title now, even when it carries several
  labels or a long time-and-author signature; a long title clamps to two lines
  with the full text available on hover instead of crowding everything else off
  the row. The single-item page's heading is never clipped either.
- A title that is unusually long, or reads like the whole message rather than a
  short headline, now gets a gentle note saying so instead of just being
  accepted silently — nothing is refused.
- Projects on the home page are now ordered by how recently something happened
  in them, not by when they were created, and each one gets its own colour so
  they are easier to tell apart at a glance.
- Archived projects no longer sit in the main list; they collapse into their
  own "Archived projects" section with a one-click way to bring one back.
  Nothing about an archived project's history is hidden or blocked — it is
  read-only for adding new items, not for reading or replying to what is
  already there.
- Every one of the above is also available from the command line, alongside the
  existing commands for asking questions and replying to them.
