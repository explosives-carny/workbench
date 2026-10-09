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
//
// Every pattern must run in linear time: item text is written by any agent, and
// a regex that backtracks over a long run blocks the server for every board.
// The two generic rules therefore match a whole run once and decide in `keep`
// whether it is a secret, instead of testing it with lookaheads at each start.
type SecretRule = { re: RegExp; replace: (match: string, ...groups: string[]) => string | null };

const always = (replacement: string): SecretRule['replace'] => () => replacement;
const SECRET_NAME = /api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|private[_-]?key/i;

const SECRET_RULES: SecretRule[] = [
  // A key block with no END marker (pasted in part) is redacted to the end.
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*$)/g, replace: always(REDACTED) },
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: always(REDACTED) },
  { re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, replace: always(REDACTED) },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, replace: always(REDACTED) },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: always(REDACTED) },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: always(REDACTED) },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: always(REDACTED) },
  { re: /\bAIza[0-9A-Za-z_-]{35}/g, replace: always(REDACTED) },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: always(REDACTED) },
  { re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi, replace: (_m, word) => `${word} ${REDACTED}` },
  // "Basic" is an ordinary word, so only a base64-looking value with a digit
  // or padding in it counts ("Basic responsibilities" is prose).
  { re: /\b(Basic)\s+([A-Za-z0-9+/]{16,}={0,2})(?![A-Za-z0-9+/=])/g, replace: (_m, word, value) => (/[0-9=]/.test(value) ? `${word} ${REDACTED}` : null) },
  // user:password@ in a URL keeps the user and the host. The scheme starts only
  // where a run of scheme characters starts (not `\b`, which also falls after
  // every `-` and `.`, and would rescan the run from each one).
  { re: /((?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi, replace: (_m, head) => `${head}:${REDACTED}@` },
  // api_key=…, "password": "…", ?access_token=…: the name stays, so the reader
  // still knows a value was there. The name is taken as a whole run (the
  // lookahead-and-backreference makes it atomic, so no backtracking into it)
  // and checked for a secret-ish word afterwards. A quoted value is taken to
  // its closing quote, spaces and all.
  {
    re: /(?<![A-Za-z0-9_-])(?=([A-Za-z0-9_-]+))\1(["']?\s*[:=]\s*)("[^"\n]+"|'[^'\n]+'|[^\s"'&,;[]{6,})/g,
    replace: (_m, name, sep, value) => {
      if (!SECRET_NAME.test(name)) return null;
      const q = value[0] === '"' || value[0] === "'" ? value[0] : '';
      return `${name}${sep}${q}${REDACTED}${q}`;
    },
  },
  // A long run of letters and digits in both cases is a key far more often
  // than a word. Hex hashes and UUIDs are one case only and survive (so does an
  // all-hex secret; only its name, by the rule above, catches that).
  {
    re: /[A-Za-z0-9_-]{40,}/g,
    replace: (m) => (/[A-Z]/.test(m) && /[a-z]/.test(m) && /[0-9]/.test(m) ? REDACTED : null),
  },
];

/** Replace anything that looks like a credential. Returns the text and how many were replaced. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const { re, replace } of SECRET_RULES) {
    out = out.replace(re, (match: string, ...rest: unknown[]) => {
      // replace() passes the groups, then the offset (the first number).
      const groups = rest.slice(0, rest.findIndex((a) => typeof a === 'number')) as string[];
      const replaced = replace(match, ...groups);
      if (replaced === null) return match;
      count++;
      return replaced;
    });
  }
  return { text: out, count };
}

// A home path starts anywhere a path can, but not inside a longer word or URL
// path (`a/Users/x`, `example.com/Users/x`), and the account name ends at any
// character Markdown or prose puts after a path.
const PATH_END = '[\\s`\'"()\\[\\]<>|*,;]';

/** `/Users/<name>/…` and `/home/<name>/…` become `~/…`: the reader needs the shape of a path, not the account name. */
export function shortenHomePaths(text: string): string {
  return text
    .replace(new RegExp(`(?<![A-Za-z0-9_.~-])\\/(?:Users|home)\\/(?:(?!${PATH_END})[^/])+(?=\\/|${PATH_END}|$)`, 'g'), '~')
    .replace(new RegExp(`(?<![A-Za-z0-9_.~-])[A-Za-z]:\\\\Users\\\\(?:(?!${PATH_END})[^\\\\])+(?=\\\\|${PATH_END}|$)`, 'g'), '~');
}

/**
 * An image reference becomes a named placeholder (contract v22). The path is
 * the board's own address, which the brief leaves out, and the reader it is
 * pasted to cannot fetch it anyway; saying a picture was there, and what its
 * alt text says, tells them to ask for it if it matters.
 */
export function describeImages(text: string): string {
  return text.replace(/!\[([^\]]*)\]\(\/api\/images\/[0-9a-f]{64}\.(?:png|jpg|gif|webp|svg)\)/g, (_, alt) =>
    `[image${alt.trim() ? `: ${alt.trim()}` : ''} (on the board, not included)]`);
}

/** Redacts and shortens one piece of text, adding what it replaced to `tally`. */
function scrub(text: string, tally: { count: number }): string {
  const { text: out, count } = redactSecrets(shortenHomePaths(describeImages(text)));
  tally.count += count;
  return out;
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // Never end on the first half of a surrogate pair (an emoji at the limit).
  const end = /[\uD800-\uDBFF]/.test(text[limit - 1]) ? limit - 1 : limit;
  return text.slice(0, end).trimEnd() + `\n\n_(cut here: ${text.length - end} more characters on the board)_`;
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

function bodySection(item: Item, tally: { count: number }): string[] {
  if (!item.body) return [];
  const heading = item.kind === 'document' ? '## The document' : '## Attached material';
  if (item.bodyFormat === 'html') {
    const kb = Math.max(1, Math.round(item.body.length / 1024));
    return [heading, '', `An HTML page (${kb} KB) is attached on the board. It is not copied here; ask for the parts that matter.`];
  }
  return [heading, '', cut(scrub(item.body, tally), BRIEF_LIMITS.section)];
}

function threadSection(messages: Message[], tally: { count: number }): string[] {
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
    lines.push(`**${n}. ${whoSaid(entry)}, ${when(entry.createdAt)}**`, quote(cut(scrub(entry.text, tally), BRIEF_LIMITS.message)), '');
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
  // The long fields are scrubbed before they are cut: a cut can drop a key
  // block's END marker or shorten a token below its pattern, and what is left
  // would then leave unredacted. The whole text is scrubbed again at the end
  // for the short fields (title, options, notes).
  const tally = { count: 0 };
  const context = item.context.trim();
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
    ['## Why it exists', '', context ? cut(scrub(context, tally), BRIEF_LIMITS.section) : 'No background was written for this item.'],
    optionsSection(item),
    checksSection(item),
    bodySection(item, tally),
    threadSection(messages, tally),
    standing(item),
    ['## What I need from you', '', 'What would you choose and why? What am I missing?'],
  ];

  const raw = parts.filter((p) => p.length).map((p) => p.join('\n').trimEnd()).join('\n\n');
  const text = scrub(raw, tally);
  const count = tally.count;
  const footer = [`_Brief made ${when(now.toISOString())} from ${itemName(item)}._`];
  if (count) footer.push(`_${count} value${count === 1 ? '' : 's'} that looked like a secret ${count === 1 ? 'was' : 'were'} replaced with ${REDACTED}._`);
  return text + '\n\n---\n\n' + footer.join('\n') + '\n';
}
