# Changelog

## Unreleased

- A decision now shows which answer the agent recommends: that button carries
  a "Recommended" tag and a heavier border, instead of the agent writing
  "(Recommended)" into the answer text. Agents are expected to name at least one
  recommendation on any decision that offers buttons: for now the board accepts
  one without and tells the agent what to add, and the next contract version
  will turn it away. An answer written the old way, ending "(Recommended)", is
  converted into the tag automatically. Items filed before this change still
  work as before, including reopening them from the status menu (contract v16).
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
