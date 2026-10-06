// The rules the contract states about an item's shape, in one place, so the
// warnings a write gets and the audit of what is already stored cannot drift
// apart. Pure functions over an item; nothing here reads or writes the store.
import { normaliseRecommended, type Item, type Kind, type Status } from './db.ts';

// A blocked item with nothing named reads exactly like the failure blocked
// exists to fix: work that looks abandoned. Warned, not refused — refusing the
// status over a missing reason would lose the more important fact, that the
// item is blocked at all, and the caller may be about to say what in the next
// message. Checked against the item as it actually landed, not the patch alone,
// so an item that already carries a blockedBy from an earlier block does not
// warn on a status-only PATCH that leaves it unset.
export function blockedWithoutReason(item: { status: Status; blockedBy: string }): string | undefined {
  if (item.status !== 'blocked' || item.blockedBy.trim()) return undefined;
  return 'status is "blocked" with no blockedBy — say what it is waiting on (an item ref, a PR, or "deploy of X") with {"blockedBy":"..."}.';
}

// A title is a headline, not the body (AGENTS.md rule 7). Warned, not refused
// — refusing would lose the item entirely over a formatting mistake, and the
// caller may fix it or may not care. The failure this answers (2026-09-25): a
// real board had 25 of ~350 items with titles over 100 characters, five of
// those with no context and no body at all — the whole message pasted into
// the one field POST requires.
export function titleWarning(item: { title: string; context: string; body: string }): string | undefined {
  const len = item.title.length;
  if (len > 120) {
    return `title is ${len} characters — keep it to a short headline and move the rest into context`;
  }
  if (len > 100 && !item.context.trim() && !item.body.length) {
    return `title reads like a body and the item has no context — move the explanation into context`;
  }
  return undefined;
}

// A decision says which option the agent would pick (AGENTS.md rule 6). The
// person is paying for the recommendation; "here are four options" hands the
// thinking back to them. It used to live as "Recommended." in the context or
// "(Recommended)" in an option's text, which nothing could display, check or
// keep out of `choice` once clicked. Now it is the `recommended` field.
//
// A recommendation that names no option is refused: only a writer that knows
// the field sends it, so refusing breaks nobody. A MISSING one is warned in
// contract v16 and refused by a later version on a write that sets options — the same
// warn-then-refuse the ifVersion rule took, so a writer still on v15 is told
// before it is turned away. A status change alone (the board's status select
// reopening an older decision) is only ever warned: it cannot add a
// recommendation, and refusing it would strand the item. The store's own
// status moves and import never pass through here.
export function recommendationRefusal(options: string[], recommended: string[] | undefined): string | undefined {
  const bad = (recommended || []).find((o) => !o.trim() || !options.includes(o));
  if (bad === undefined) return undefined;
  if (!bad.trim()) return 'recommended entries must be non-empty option text';
  return `recommended "${bad}" is not one of the options — use the exact option text`;
}

export type DecisionShape = { kind: Kind; status: Status; options: string[]; recommended?: string[] };
export function lacksRecommendation(next: DecisionShape): boolean {
  if (next.kind !== 'issue' || next.status !== 'needs-decision' || !next.options.length) return false;
  return normaliseRecommended(next.recommended, next.options).length === 0;
}
export const MISSING_RECOMMENDATION =
  'a decision with options has no recommended — add "recommended":["<one of the options>"]; a later contract version refuses this';

// The old convention, accepted for one contract version: exactly one option
// ending "(Recommended)" and no `recommended` sent becomes that option, with
// the suffix taken off the text. Two or more such options, or a stripped text
// that collides with another option, is left alone and warned about.
//
// An answer already given follows the rename: an item answered "B
// (Recommended)" whose option becomes "B" would otherwise show no button
// pressed. `currentChoice` is the stored answer on a PATCH; a choice sent in
// the same write is the caller's and is renamed only if it names the old text.
const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/i;
export function convertRecommendedSuffix(
  input: { options?: string[]; recommended?: string[]; choice?: string },
  currentChoice?: string
): string | undefined {
  if (!input.options || input.recommended !== undefined) return undefined;
  const marked = input.options.filter((o) => RECOMMENDED_SUFFIX.test(o));
  if (marked.length !== 1) return undefined;
  const plain = marked[0].replace(RECOMMENDED_SUFFIX, '');
  if (!plain.trim() || input.options.includes(plain)) return undefined;
  input.options = input.options.map((o) => (o === marked[0] ? plain : o));
  input.recommended = [plain];
  if ((input.choice ?? currentChoice) === marked[0]) input.choice = plain;
  return `option "${marked[0]}" was stored as "${plain}" with "recommended":["${plain}"] — send the field instead of the suffix`;
}

// Warned, not refused: default status for an issue is needs-decision, so
// refusing an option-less one would refuse every plain create. Only on a write
// that named needs-decision explicitly, or emptied a decision's options.
export function noOptionsWarning(item: { kind: Kind; status: Status; options: string[] }): string | undefined {
  if (item.kind !== 'issue' || item.status !== 'needs-decision' || item.options.length) return undefined;
  return 'a decision with no options gives nothing to click — add "options" and mark at least one in "recommended"';
}

// Whatever the suffix conversion did not take, caught so it does not linger.
export function recommendedInTextWarning(options: string[] | undefined): string | undefined {
  const marked = (options || []).find((o) => /recommend/i.test(o));
  if (!marked) return undefined;
  return `option "${marked}" says recommended in its text — take it out and list the option in "recommended" instead`;
}

// A QA step says who runs it (AGENTS.md rule 8). Warned, not refused: a step
// without one still reads as the person's, which is what needs-qa meant before
// owners existed, so nothing is lost — but the board cannot tell the person
// which QA is theirs until every step says.
export function unownedStepsWarning(item: { kind: Kind; status: Status; checks: { owner: string }[] }): string | undefined {
  if (item.kind !== 'issue' || item.status !== 'needs-qa') return undefined;
  const unowned = item.checks.filter((c) => !c.owner).length;
  if (!unowned) return undefined;
  return `${unowned} of ${item.checks.length} steps have no owner and count as human QA — set "owner":"human" or "agent" on each`;
}



// Formatting (AGENTS.md rule 12, contract v20). Context, messages and bodies
// render as Markdown, so one long paragraph with a table squashed into it shows
// as a wall of pipes. Warned, never refused: the text is still the record.
export function wallOfTextWarning(field: string, text: string | undefined): string | undefined {
  if (!text || text.length <= 400 || /\n/.test(text)) return undefined;
  return `${field} is one ${text.length}-character paragraph — it renders as Markdown: break it into short paragraphs, a list or a table`;
}

// Two or more literal backslash-n pairs and no real break: the writer
// double-escaped, and the page would show the escapes instead of lines.
export function escapedNewlineWarning(field: string, text: string | undefined): string | undefined {
  if (!text || /\n/.test(text)) return undefined;
  if ((text.match(/\\n/g) || []).length < 2) return undefined;
  return `${field} contains literal "\\n" — send real line breaks; the escapes show on the page`;
}

function hasMarkdownTable(text: string | undefined): boolean {
  if (!text) return false;
  const lines = text.split('\n').map((l) => l.trim());
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].startsWith('|') && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(lines[i + 1]) && lines[i + 1].includes('|')) return true;
  }
  return false;
}

// An option is read on its own, so it cannot point at its neighbours. Returns
// every finding; callers that want one warning take the first of each kind.
export function pointerOptionWarnings(options: string[] | undefined, context: string | undefined, body: string | undefined): { rule: string; message: string }[] {
  const out: { rule: string; message: string }[] = [];
  const opts = options || [];
  const pointer = opts.find((o) => /\b(above|below)\b/i.test(o));
  if (pointer) {
    out.push({ rule: 'option-points-elsewhere', message: `option "${pointer}" points "above" — an option is read on its own, apart from the context; name what it means (for example "the posting table") and keep that content in the context` });
  }
  const tabled = opts.find((o) => /\btable\b/i.test(o));
  if (tabled && !hasMarkdownTable(context) && !hasMarkdownTable(body)) {
    out.push({ rule: 'option-names-missing-table', message: `option "${tabled}" names a table, but this item has no Markdown table in its context or body` });
  }
  return out;
}

export function pointerOptionWarning(options: string[] | undefined, context: string | undefined, body: string | undefined): string | undefined {
  const found = pointerOptionWarnings(options, context, body);
  return found.length ? found.map((f) => f.message).join(' | ') : undefined;
}

// ---------------------------------------------------------------------------
// Audit: the same rules, applied to what is already on the board.
//
// A contract change makes items filed under the old one out of spec — a
// decision from before `recommended`, QA steps from before owners. Writes are
// only warned, so nothing forces them into line; this lists them so the agent
// that owns the project can. Finished work (complete, cancelled, archived) is
// history and is not audited: it was right under the contract it was filed
// under, and rewriting it would falsify the record.
export type Finding = { rule: string; message: string };
const FINISHED: Status[] = ['complete', 'cancelled', 'archived'];

export function auditItem(item: Item): Finding[] {
  if (FINISHED.includes(item.status)) return [];
  const out: Finding[] = [];
  const add = (rule: string, message: string | undefined) => { if (message) out.push({ rule, message }); };
  if (lacksRecommendation(item)) add('decision-without-recommendation', MISSING_RECOMMENDATION);
  add('recommended-in-text', recommendedInTextWarning(item.options));
  if (item.kind === 'issue' && item.status === 'needs-qa' && !item.checks.length) {
    add('qa-without-steps', 'needs-qa with no steps — attach checks:[{"label":"…","owner":"human"|"agent"}]');
  }
  add('qa-unowned-steps', unownedStepsWarning(item));
  add('blocked-without-reason', blockedWithoutReason(item));
  add('title-reads-like-a-body', titleWarning(item));
  add('context-wall-of-text', wallOfTextWarning('context', item.context));
  add('context-escaped-newlines', escapedNewlineWarning('context', item.context));
  for (const f of pointerOptionWarnings(item.options, item.context, item.body)) add(f.rule, f.message);
  return out;
}

export function auditItems(items: Item[]) {
  return items
    .map((item) => ({ id: item.id, ref: item.ref, title: item.title, status: item.status, updatedBy: item.updatedBy, findings: auditItem(item) }))
    .filter((row) => row.findings.length);
}
