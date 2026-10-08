// A second-opinion brief: one item written out as plain Markdown that makes
// sense to somebody with no access to the board (another model, a colleague
// in chat), so the person can ask "what would you choose?" without
// re-explaining the project.
//
// One generator, served at GET /api/items/<id-or-ref>/brief and used by the
// item page's "Get a 2nd opinion" button, so what an agent fetches and what a
// person copies cannot drift apart. It reads the item and never writes.
//
// The brief is pasted outside the machine by a person. Nothing here sends it
// anywhere, and it carries only what the item already says: no database path,
// no repository list, no board URL (a localhost link means nothing to the
// reader). Text that looks like a credential is replaced on the way out, and a
// home-directory prefix is shortened to `~`, because a pasted thread is where a
// token quoted in an agent's reply leaves the machine without anyone noticing.
import { STATUS_LABELS, type Item, type Message, type Project, type Status } from './db.ts';

/** What each status means to somebody who has never seen the board. */
const STATUS_MEANING: Record<Status, string> = {
  'needs-decision': 'waiting on the person to choose; nothing is built yet',
  'needs-qa': 'built, and waiting on a check before it is signed off',
  received: 'the person has answered; the agent has not started on it',
  'in-progress': 'an agent is working on it now',
  blocked: 'committed work that cannot start until something else is done',
  todo: "open on the person's own to-do list",
  deferred: 'parked on purpose; it may or may not come back',
  active: 'a reference document people still work from',
  archived: 'a document kept as history',
  complete: 'done and landed',
  cancelled: 'decided against; it will not be done',
};

const PRIORITY_WORD: Record<string, string> = { p1: 'High', p2: 'Medium', p3: 'Low' };

/** Limits that keep a brief pasteable into a chat box. */
export const BRIEF_LIMITS = {
  /** Context and a document body are cut past this many characters. */
  section: 6000,
  /** One message is cut past this many characters. */
  message: 800,
  /** A thread longer than this keeps its opening and its newest messages. */
  messages: 12,
  /** How many of the oldest messages a long thread keeps. */
  head: 2,
};

const REDACTED = '[redacted]';

// Patterns for things that should not leave the machine in a pasted brief.
// Specific vendor shapes first, then the generic `name = value` and long mixed
// strings. A false positive costs a word in a brief; a false negative costs a
// credential in somebody else's chat history, so the generic rules lean wide.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, `$1 ${REDACTED}`],
  // user:password@ in a URL keeps the user and the host.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi, `$1:${REDACTED}@`],
  // api_key=…, "password": "…", ?access_token=…: the name stays, so the reader
  // still knows a value was there.
  [/\b([A-Za-z0-9_-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|private[_-]?key)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*)(["']?)([^\s"'&,;[]{6,})/gi, `$1$2$3${REDACTED}`],
  // A long run of letters and digits in both cases is a key far more often
  // than a word. Hex hashes and UUIDs are one case only and survive.
  [/\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{40,}\b/g, REDACTED],
];

/** Replace anything that looks like a credential. Returns the text and how many were replaced. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      count++;
      return match.replace(new RegExp(pattern.source, pattern.flags.replace('g', '')), replacement);
    });
  }
  return { text: out, count };
}

/** `/Users/<name>/…` and `/home/<name>/…` become `~/…`: the reader needs the shape of a path, not the account name. */
export function shortenHomePaths(text: string): string {
  return text
    .replace(/(^|[\s(`'"=:])\/(?:Users|home)\/[^/\s`'")]+(?=\/|[\s`'")]|$)/g, '$1~')
    .replace(/(^|[\s(`'"=:])[A-Za-z]:\\Users\\[^\\\s`'")]+(?=\\|[\s`'")]|$)/g, '$1~');
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit).trimEnd() + `\n\n_(cut here: ${text.length - limit} more characters on the board)_`;
}

function when(iso: string): string {
  // ISO in UTC, minute precision: the reader may be anywhere, and "3 hours
  // ago" is wrong by the time it is read.
  return iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : '';
}

function quote(text: string): string {
  return text.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
}

function whoSaid(message: Message): string {
  return message.who === 'you' ? 'The person' : `Agent "${message.author || 'agent'}"`;
}

function itemName(item: Item): string {
  // Rule 11: the ref first; the UUID's first eight only without a key.
  return item.ref || item.id.slice(0, 8);
}

function kindWord(item: Item): string {
  return item.kind === 'document' ? 'a document' : item.kind === 'todo' ? 'a to-do' : 'an issue (something to decide or do)';
}

function theQuestion(item: Item): string[] {
  const asked = quote(item.title);
  if (item.kind === 'document') {
    return [asked, '', 'This is a reference document, not a decision. Is it sound, and what is missing or wrong?'];
  }
  if (item.kind === 'todo') {
    return [asked, '', "This is a task on the person's own to-do list. Is it worth doing, and what is the best way to do it?"];
  }
  if (item.status === 'needs-qa' || item.checks.length) {
    return [asked, '', 'Built work is waiting for a check. Is it ready to sign off, and what should the check look at?'];
  }
  if (item.options.length) {
    return [asked, '', 'Pick one of the options below, or say that none of them fits and what would.'];
  }
  return [asked, '', 'No fixed options were offered, so the answer is open.'];
}

function optionsSection(item: Item): string[] {
  if (!item.options.length) return [];
  const recommended = item.options.filter((o) => item.recommended.includes(o));
  const noPreference = item.options.length > 1 && recommended.length === item.options.length;
  const lines = ['## The options', ''];
  item.options.forEach((option, n) => {
    const marks: string[] = [];
    if (!noPreference && recommended.includes(option)) marks.push('**recommended by the agent**');
    if (item.choice === option) marks.push('**chosen so far**');
    lines.push(`${n + 1}. ${option}${marks.length ? ` (${marks.join(', ')})` : ''}`);
  });
  lines.push('');
  if (noPreference) lines.push('The agent marked every option as recommended: it has no preference.');
  else if (!recommended.length) lines.push('The agent did not mark a recommendation.');
  if (item.choice && !item.options.includes(item.choice)) lines.push(`Chosen so far: ${item.choice}`);
  return lines;
}

function checksSection(item: Item): string[] {
  if (!item.checks.length) return [];
  const done = item.checks.filter((c) => c.result).length;
  const lines = ['## Checks', '', `${done} of ${item.checks.length} steps have a result.`, ''];
  for (const c of item.checks) {
    const owner = c.owner === 'agent' ? 'agent' : 'person';
    const result = c.result ? c.result.toUpperCase() : 'OPEN';
    lines.push(`- [${result}] (${owner}) ${c.label}${c.note ? `. Note: ${c.note}` : ''}`);
  }
  return lines;
}

function bodySection(item: Item): string[] {
  if (!item.body) return [];
  const heading = item.kind === 'document' ? '## The document' : '## Attached material';
  if (item.bodyFormat === 'html') {
    const kb = Math.max(1, Math.round(item.body.length / 1024));
    return [heading, '', `An HTML page (${kb} KB) is attached on the board. It is not copied here; ask for the parts that matter.`];
  }
  return [heading, '', cut(item.body, BRIEF_LIMITS.section)];
}

function threadSection(messages: Message[]): string[] {
  if (!messages.length) return ['## The discussion', '', 'Nobody has replied yet.'];
  const lines = ['## The discussion', '', `${messages.length} message${messages.length === 1 ? '' : 's'}, oldest first. When two messages disagree, the newest one wins.`, ''];
  let shown: (Message | number)[] = messages;
  if (messages.length > BRIEF_LIMITS.messages) {
    const tail = BRIEF_LIMITS.messages - BRIEF_LIMITS.head;
    const left = messages.length - BRIEF_LIMITS.messages;
    // The opening says what was asked; the newest say what holds now. The
    // middle is what a reader can most afford to lose.
    shown = [...messages.slice(0, BRIEF_LIMITS.head), left, ...messages.slice(-tail)];
  }
  shown.forEach((entry) => {
    if (typeof entry === 'number') {
      lines.push(`_(${entry} message${entry === 1 ? '' : 's'} in the middle left out)_`, '');
      return;
    }
    const n = messages.indexOf(entry) + 1;
    lines.push(`**${n}. ${whoSaid(entry)}, ${when(entry.createdAt)}**`, quote(cut(entry.text, BRIEF_LIMITS.message)), '');
  });
  return lines;
}

function standing(item: Item): string[] {
  const lines = ['## Where it stands', '', `- **Status:** ${STATUS_LABELS[item.status]}: ${STATUS_MEANING[item.status]}.`];
  if (item.status === 'blocked') lines.push(`- **Blocked by:** ${item.blockedBy || 'not stated'}`);
  else if (item.blockedBy) lines.push(`- **Was blocked by:** ${item.blockedBy}`);
  if (item.choice) {
    lines.push(`- **Chosen so far:** ${item.choice}. A message from the person after that click overrides it.`);
  }
  if (item.kind === 'todo') {
    if (item.dueAt) lines.push(`- **Due:** ${item.dueAt}`);
    if (item.priority) lines.push(`- **Priority:** ${PRIORITY_WORD[item.priority] || item.priority}`);
  }
  if (item.updatedBy) lines.push(`- **Last moved by:** ${item.updatedBy === 'you' ? 'the person' : item.updatedBy}, ${when(item.updatedAt)}`);
  if (['complete', 'cancelled', 'archived'].includes(item.status)) {
    lines.push('- This item is already closed, so an opinion now is a look back.');
  }
  return lines;
}

/**
 * The brief for one item, as Markdown. `project` is the item's own project;
 * `now` is when the brief was made (passed in so tests are exact).
 */
export function itemBrief(item: Item, project: Project, now: Date = new Date()): string {
  const messages = item.messages || [];
  const facts = [
    `- **Project:** ${project.name}${project.description ? `: ${project.description}` : ''}`,
    `- **Item:** ${itemName(item)}, ${kindWord(item)}, raised ${when(item.createdAt)}`,
  ];
  if (item.section) facts.push(`- **Area:** ${item.section}`);
  if (item.labels.length) facts.push(`- **Labels:** ${item.labels.join(', ')}`);

  const parts: string[][] = [
    [
      `# Second opinion: ${item.title}`,
      '',
      'I would like an outside view on one item from my project decision board. You have no other context, so everything known about it is below.',
      '',
      ...facts,
    ],
    ['## The question', '', ...theQuestion(item)],
    ['## Why it exists', '', item.context.trim() ? cut(item.context.trim(), BRIEF_LIMITS.section) : 'No background was written for this item.'],
    optionsSection(item),
    checksSection(item),
    bodySection(item),
    threadSection(messages),
    standing(item),
    ['## What I need from you', '', 'What would you choose and why? What am I missing?'],
  ];

  const raw = parts.filter((p) => p.length).map((p) => p.join('\n').trimEnd()).join('\n\n');
  const { text, count } = redactSecrets(shortenHomePaths(raw));
  const footer = [`_Brief made ${when(now.toISOString())} from ${itemName(item)}._`];
  if (count) footer.push(`_${count} value${count === 1 ? '' : 's'} that looked like a secret ${count === 1 ? 'was' : 'were'} replaced with ${REDACTED}._`);
  return text + '\n\n---\n\n' + footer.join('\n') + '\n';
}
