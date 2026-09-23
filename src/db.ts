// Storage for the workbench: projects, the items inside them, and the threaded
// conversation on each item.
//
// bun:sqlite rather than a JSON file, and rather than a dependency. Two reasons
// that matter in practice: an item's thread is appended to constantly from two
// sides — an agent writing an update while the human is typing a reply — and a
// read-modify-write of one big JSON blob loses one of them every time. And a
// single file with real transactions is the whole install: `bun run start` and
// it exists, nothing to provision and nothing to keep running between sessions.
import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

// The states an item can be in, and the vocabulary the whole tool speaks. They
// are chosen so that no two of them overlap, which has taken two corrections.
//
// The first: an earlier set had `needs-you` and `needs-more` side by side and
// both meant "the human owes something". The only difference was whether it was
// the first ask or a follow-up — provenance, which the thread already shows.
//
// The second: `needs-you` then covered two genuinely different asks. "Choose
// between these options so I can proceed" and "I have finished the work, check
// it" are not the same request, do not take the same amount of the human's
// attention, and cannot be triaged together. A board where a five-second yes/no
// sits in the same bucket as a forty-one step walkthrough teaches people to scan
// past both.
//
// The third correction: a specification, a review or a history is not a task at
// all. It is never "waiting on" anybody and it is never "done" — it is either
// the current reference or it has been superseded. Forced through a task
// vocabulary, every document on the board had to be filed as `complete`, which
// hid it behind the completed filter on the day it was written and made the
// board's most-read material its least visible.
//
// What the seven now answer is "whose move is it, and what KIND of thing is it":
//   needs-decision  the human's, and it is a decision — nothing is built yet
//   needs-qa        the human's, and the work is done — it needs checking
//   received        the agent's — the answer has landed, nobody has started
//   in-progress     the agent's — somebody has CLAIMED it and is working now
//   deferred        nobody's, on purpose; revisit when something changes
//   active          not a task: a document that is current and still referenced
//   archived        not a task: a document superseded, kept for the record
//   complete        done
//
// `received` exists because a flat open/closed cannot express the thing that
// actually goes wrong: the human answers and cannot tell whether the answer was
// read. It is the agent's acknowledgement to give, never the human's.
//
// `in-progress` exists because of the failure after that one. `received` was
// carrying two meanings — "the answer arrived" and "somebody is working on it" —
// and the only thing that ever started the work was a human reply arriving in a
// live session. Lose the session to an outage, a crash or a context reset and
// that trigger is gone with it: the item still says `received`, nobody is on it,
// and nothing on the board says so. Splitting the two makes an abandoned claim
// visible, because an item sitting at `in-progress` with an `updatedAt` older
// than your session began is a claim whose owner is gone.
//
// `cancelled` (added in contract v4) is the honest end for an issue that will
// not be done. Before it, such an issue had three wrong homes: `complete`
// claims the work landed, `deferred` claims it comes back, `archived` belongs to
// documents. It sits with the finished work in the Archived group — kept, not
// current — and the thread carries the reason.
export const STATUSES = ['needs-decision', 'needs-qa', 'received', 'in-progress', 'deferred', 'active', 'archived', 'complete', 'cancelled'] as const;
export type Status = (typeof STATUSES)[number];

// Display labels. Short on purpose: these sit in a chip, a filter button and a
// dropdown at once, and "Needs decision" wrapped to two lines in the chip. The
// word "Needs" carried nothing the group heading and the colour did not already
// say. The IDs keep the longer name — they are the agent contract.
export const STATUS_LABELS: Record<Status, string> = {
  'needs-decision': 'Decision',
  'needs-qa': 'QA',
  received: 'Received',
  'in-progress': 'Working',
  'deferred': 'Deferred',
  active: 'Active',
  archived: 'Archived',
  complete: 'Complete',
  cancelled: 'Cancelled',
};

/**
 * The statuses a document carries, as opposed to a task.
 *
 * Exported because the distinction matters to more than the grouping: an agent
 * deciding what to set, and a human reading why a thing is where it is, both
 * need to know these two are a pair and not two more points on the task scale.
 */
export const DOCUMENT_STATUSES: Status[] = ['active', 'archived'];

/** The six a task moves through. The complement of DOCUMENT_STATUSES. */
export const ISSUE_STATUSES: Status[] = STATUSES.filter((s) => !DOCUMENT_STATUSES.includes(s));

/**
 * What an item IS, which decides which statuses it may hold.
 *
 *   issue    — something to decide or do: the five task states
 *   document — something to read or work through: active or archived
 *
 * Stored rather than inferred. It was briefly inferred from whether the item
 * carried a body, which is wrong in both directions: a decision can arrive with
 * a long explanation attached, and a document can be a stub that grows later.
 * Getting it wrong lets a specification be set to "Received", which is the
 * exact confusion the two status sets exist to prevent.
 */
export type Kind = 'issue' | 'document';
export const KINDS = ['issue', 'document'] as const;

/** The statuses this kind of item is allowed to hold. */
export function statusesFor(kind: Kind): Status[] {
  return kind === 'document' ? DOCUMENT_STATUSES : ISSUE_STATUSES;
}

export function isStatusAllowed(kind: Kind, status: Status): boolean {
  return statusesFor(kind).includes(status);
}

/** The status a kind falls back to when it has none, or an incompatible one. */
export function defaultStatusFor(kind: Kind): Status {
  return kind === 'document' ? 'active' : 'needs-decision';
}

/**
 * Old status spellings, accepted on input and mapped forward.
 *
 * `needs-you` was the single "waiting on the human" state before it split. It is
 * written into agent instructions, earlier exports, and any session running from
 * a cached copy of the contract — so refusing it would break writers that are
 * not wrong, merely older. It maps to `needs-decision`, which is what it meant
 * in every case that predates the split.
 */
export const STATUS_ALIASES: Record<string, Status> = {
  'needs-you': 'needs-decision',
};

/** A status string from any writer, current spelling or old, or null. */
export function asStatusValue(value: unknown): Status | null {
  if (typeof value !== 'string') return null;
  if ((STATUSES as readonly string[]).includes(value)) return value as Status;
  return STATUS_ALIASES[value] ?? null;
}

export type SectionMode = 'adhoc' | 'declared';

export type GroupBy = 'section' | 'status';

/**
 * The status groups, in board order, when a project groups by status.
 *
 * Open is deliberately every TASK status that is still live — the two waiting on
 * a person and the one waiting on an agent. Splitting them here would put the same
 * piece of work in a different group every time it changed hands, which is
 * exactly the churn the grouping is meant to absorb; the per-row status chip
 * still says which it is, in its own colour.
 */
export const STATUS_GROUPS: { id: string; label: string; statuses: Status[] }[] = [
  { id: 'open', label: 'Open', statuses: ['needs-decision', 'needs-qa', 'received', 'in-progress'] },
  { id: 'deferred', label: 'Deferred', statuses: ['deferred'] },
  // Documents sit above Archived and below the work, because a current
  // reference is something you reach for while working rather than something
  // waiting on you. An archived document joins finished work in the last group:
  // both are "kept, not current", and separating them would give the board two
  // graveyards.
  { id: 'documents', label: 'Documents', statuses: ['active'] },
  // Cancelled joins them: decided against is as finished as done, for the
  // purpose of what the board shows by default.
  { id: 'archived', label: 'Archived', statuses: ['archived', 'complete', 'cancelled'] },
];

export type Project = {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** Human-readable project namespace. Null until somebody deliberately sets it. */
  key: string | null;
  /** Keys this project previously displayed, kept so quoted references continue working. */
  oldKeys: string[];
  /** The next per-project item sequence number reserved for creation. */
  nextSeq: number;
  sectionMode: SectionMode;
  /** Declared vocabulary. Advisory in adhoc mode, enforced in declared mode. */
  sections: string[];
  /**
   * What the board groups its rows by.
   *
   *   section — one group per area of work (the original behaviour)
   *   status  — Open, Deferred, Documents, Archived
   *
   * `status` is the default for a new project: it answers the question a board
   * exists for — what is waiting, what is parked, what is done — and leaves
   * `labels` to carry the relationships that sections used to. `section` remains
   * fully supported for anyone who wants the board grouped by area of work
   * instead, and any project created before this default keeps what it holds.
   */
  groupBy: GroupBy;
  /**
   * The repositories this project is about, so a session can find its board
   * from where it is standing. Each entry is a remote (`owner/name`, or a full
   * git URL) or a directory path; a trailing `*` on a path matches every
   * worktree under that prefix. Without this, a session with two projects on
   * the board had no rule for which one was "mine" and read both, or guessed.
   */
  repos: string[];
  createdAt: string;
  archivedAt: string | null;
};

/**
 * One spelling for a repository reference, so `git@github.com:acme/site.git`,
 * `https://github.com/acme/site` and `acme/site` are the same project. Paths
 * keep their shape (lower-cased, `~` expanded, trailing slash dropped).
 */
export function normaliseRepoRef(value: string, home = ''): string {
  let ref = String(value).trim();
  if (!ref) return '';
  const m = ref.match(/^(?:git@[^:]+:|https?:\/\/[^/]+\/|ssh:\/\/[^/]+\/)(.+?)(?:\.git)?\/?$/i);
  if (m) return m[1].toLowerCase();
  if (home && ref.startsWith('~')) ref = home + ref.slice(1);
  return ref.replace(/\/+$/, '').toLowerCase();
}

/** Does `ref` (already normalised) match the project's `repos` entry? */
export function repoMatches(entry: string, ref: string, home = ''): boolean {
  const e = normaliseRepoRef(entry, home);
  if (!e || !ref) return false;
  if (e.endsWith('*')) return ref.startsWith(e.slice(0, -1));
  return e === ref;
}

// Near-duplicate detection. The way a section vocabulary actually rots is not
// somebody inventing a wild new name — it is "Deploys" appearing beside "Ship
// it", or "Design" becoming "design" and "Designs". Both lists then look
// complete and neither is.
//
// Deliberately crude and explainable: case, punctuation and a trailing plural
// are noise; everything else is a real difference. A warning, never a refusal,
// because the tool cannot know that "Deploy" and "Release" are the same area in
// this project and the human can.
export function normaliseSection(name: string): string {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/s\b/g, '');
}

/**
 * Clean a label set: trimmed, de-duplicated case-insensitively, order kept.
 *
 * Deliberately permissive about WHAT a label says — unlike a section, which is
 * one axis with a governed vocabulary, labels are the free field and policing
 * them would defeat the point. What is not permissive is the SHAPE: a trailing
 * space or a stray capital produces two labels that look identical in the
 * filter list and match different items, which is the only way a free-text
 * field silently lies.
 *
 * First spelling wins on a case clash, so whoever used it first sets the
 * casing and later writers join that label rather than forking it.
 */
export function normaliseLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const label = raw.trim().replace(/\s+/g, ' ');
    if (!label || label.length > 60) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

function parseLabels(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    return normaliseLabels(JSON.parse(raw));
  } catch {
    // Same reasoning as options: a malformed blob on one item must not take the
    // list down with it. An item with no labels is still readable.
    return [];
  }
}

export function findSimilarSection(name: string, existing: string[]): string | null {
  const target = normaliseSection(name);
  if (!target) return null;
  for (const candidate of existing) {
    if (candidate === name) return null; // exact match is not a duplicate
    const other = normaliseSection(candidate);
    if (!other) continue;
    if (other === target) return candidate;
    // One wholly inside the other, at a length where that is meaningful.
    if (target.length > 3 && other.length > 3 && (other.includes(target) || target.includes(other))) return candidate;
  }
  return null;
}

export type Message = {
  id: string;
  itemId: string;
  who: 'you' | 'agent';
  author: string;
  /**
   * Which SESSION of that author wrote this. `author` is the name a person
   * recognises (spike, codex); two sessions of the same tool carry the same
   * name and are two workers. The session id is what tells them apart — and
   * what lets a session tell its own abandoned claim from a sibling's live one.
   * Generated once per session by the writer, '' when a writer sends none.
   */
  session: string;
  text: string;
  createdAt: string;
};

export type Check = {
  id: string;
  label: string;
  /** '' means not yet answered — distinct from a recorded failure. */
  result: '' | 'pass' | 'fail' | 'skip';
  note: string;
  by: string;
  at: string;
};

export type Item = {
  id: string;
  projectId: string;
  /** Per-project sequence, assigned once and never reused. */
  seq: number;
  /** Human-readable display reference, or null while the project has no key. */
  ref: string | null;
  title: string;
  context: string;
  options: string[];
  choice: string;
  status: Status;
  /** What this item is, which decides which statuses it may hold. */
  kind: Kind;
  section: string;
  /**
   * How this item relates to others, crosswise to everything else.
   *
   * A `section` answers "which area of work"; exactly one, chosen from a
   * vocabulary. Labels answer "what does this have in common with that", any
   * number of them, and an item can carry none. They are the field for the
   * relationships a single axis cannot express — the three items that are all
   * one release, the two that both wait on the same person.
   */
  labels: string[];
  position: number;
  version: number;
  updatedBy: string;
  /** The session of `updatedBy` — the exact holder of a claim. '' when unknown. */
  updatedSession: string;
  body: string;
  bodyFormat: 'text' | 'markdown' | 'html';
  checks: Check[];
  /** Caller-chosen id for idempotent creates; '' when none was given. */
  clientId: string;
  createdAt: string;
  updatedAt: string;
  messages?: Message[];
  /** Set by list views: how many messages the thread holds, however many were sent. */
  messageCount?: number;
};

export type ItemInput = {
  title: string;
  context?: string;
  options?: string[];
  choice?: string;
  status?: Status;
  kind?: Kind;
  section?: string;
  body?: string;
  bodyFormat?: 'text' | 'markdown' | 'html';
  checks?: Check[];
  labels?: string[];
  /**
   * Idempotency key, unique per project. A create that names a clientId already
   * present on the project returns the existing item rather than a second copy.
   * Exists for the retry after a timeout: the write may have landed and the
   * caller cannot know, and a batch of ten re-sent blindly is twenty items.
   */
  clientId?: string;
  /**
   * When this thing actually came into being, for an import carrying history.
   *
   * Only honoured on create, and only when it is a real past instant. Everything
   * created through the board leaves it out and gets the clock. It exists
   * because migrating a body of work stamps every item with the moment of the
   * import — so a board restored from an export, or brought over from somewhere
   * else, shows forty items that all appeared in the same second and no sense of
   * what came first.
   */
  createdAt?: string;
  /** An imported sequence is retained when unused in the destination project. */
  seq?: number;
};

export const REF_PREFIX = 'WB';

/** Format the stable display shape in one place so callers cannot drift. */
export function formatRef(key: string, seq: number): string {
  return `${REF_PREFIX}-${key}-${seq}`;
}

/** Parse only complete, positive references; malformed input is not a lookup. */
export function parseRef(text: string): { key: string; seq: number } | null {
  const match = String(text).trim().match(new RegExp(`^${REF_PREFIX}-([A-Z][A-Z0-9]{1,4})-([1-9][0-9]*)$`, 'i'));
  if (!match) return null;
  const seq = Number(match[2]);
  return Number.isSafeInteger(seq) ? { key: match[1].toUpperCase(), seq } : null;
}

/** A bad key is input validation, not a database constraint failure. */
export class InvalidProjectKey extends Error {
  readonly statusCode = 400;

  constructor(value: unknown) {
    super(`project key must be 2-5 characters matching ^[A-Z][A-Z0-9]{1,4}$; received ${JSON.stringify(value)}`);
    this.name = 'InvalidProjectKey';
  }
}

/** A current or former key belongs to exactly one project forever. */
export class ProjectKeyTaken extends Error {
  readonly statusCode = 409;

  constructor(public conflictingSlug: string, public key: string) {
    super(`project key ${key} is already reserved by project ${conflictingSlug}`);
    this.name = 'ProjectKeyTaken';
  }
}

/** Trim and uppercase at the boundary so stored keys have one canonical spelling. */
export function normaliseProjectKey(value: string): string {
  const key = String(value).trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,4}$/.test(key)) throw new InvalidProjectKey(value);
  return key;
}

/**
 * An ISO instant that is safe to trust as a creation date, or null.
 *
 * Rejects anything unparseable, and anything in the future: a date later than
 * now is either a clock problem or a caller inventing history, and an item that
 * claims to have been created tomorrow sorts above everything real forever.
 * A date before the epoch is the same class of nonsense in the other direction.
 */
export function asHistoricInstant(value: unknown, nowMs = Date.now()): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms > nowMs || ms < 0) return null;
  return new Date(ms).toISOString();
}

function now(): string {
  return new Date().toISOString();
}

export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  // WAL so a reader (the browser polling) never blocks a writer (an agent
  // posting an update), which is the normal state of this tool.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      slug        TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      key         TEXT,
      -- Former keys are an item-owned, small history rather than a second table:
      -- they are only read while resolving one reference and must travel in export.
      old_keys    TEXT NOT NULL DEFAULT '[]',
      next_seq    INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      archived_at TEXT,
      -- How this project governs its section vocabulary.
      --   adhoc    — any section accepted; near-duplicates are reported back
      --   declared — only the listed sections accepted; anything else refused
      -- Default adhoc, because a project usually does not know its areas on day
      -- one and being forced to guess produces a worse taxonomy than letting one
      -- emerge and tidying it later.
      section_mode TEXT NOT NULL DEFAULT 'adhoc',
      sections     TEXT NOT NULL DEFAULT '[]',
      -- What the board groups rows by: 'section' or 'status'. The COLUMN default
      -- is section, deliberately different from the default for a NEW project:
      -- this value is what an existing row gets when the column is added, and
      -- regrouping a board somebody already uses is a surprise, not a default.
      -- createProject sets 'status' for anything made from now on.
      group_by     TEXT NOT NULL DEFAULT 'section',
      -- Repositories this project is about (JSON array), so a session resolves
      -- its board from the directory or remote it is standing in.
      repos        TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS items (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      context    TEXT NOT NULL DEFAULT '',
      options    TEXT NOT NULL DEFAULT '[]',
      choice     TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'needs-decision',
      section    TEXT NOT NULL DEFAULT '',
      position   INTEGER NOT NULL DEFAULT 0,
      -- Concurrency. Several sessions and several people may hold this item open
      -- at once, and "last write wins" silently discards somebody's decision.
      -- Every update bumps this; a writer that read version N may pass ifVersion
      -- N and be refused rather than overwrite a change it never saw.
      version    INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT NOT NULL DEFAULT '',
      -- The session of updated_by: exact identity of whoever last moved the
      -- item, so a claim can be told apart from a sibling session's.
      updated_session TEXT NOT NULL DEFAULT '',
      -- Long-form content: a QA walkthrough, a design specification, anything
      -- that is a document rather than a question. Kept on the item rather than
      -- in a second table because it belongs to exactly one item and is read
      -- only when that item is opened. It is stripped from list responses so a
      -- 150KB specification never rides along in a payload somebody asked a
      -- summary from. (No backticks in this comment: the whole schema is a
      -- JavaScript template literal and one would end it.)
      body        TEXT NOT NULL DEFAULT '',
      body_format TEXT NOT NULL DEFAULT 'text',
      -- A checklist: steps that are each separately answerable, on ONE item.
      -- Forty-one steps as forty-one items would bury every other decision on
      -- the board, and they share one context and one sign-off. JSON because
      -- the shape is a list the item owns, never queried across items.
      checks      TEXT NOT NULL DEFAULT '[]',
      -- Labels: any number per item, crosswise to section and status. JSON
      -- because the set is small, owned by the item, and only ever read with it.
      labels      TEXT NOT NULL DEFAULT '[]',
      -- issue or document. Decides which statuses this item may hold.
      kind        TEXT NOT NULL DEFAULT 'issue',
      -- A caller-chosen id, unique per project, so a batch that timed out after
      -- the write can be re-sent and find its items instead of duplicating
      -- them. Empty for everything created without one.
      client_id   TEXT NOT NULL DEFAULT '',
      seq         INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      who        TEXT NOT NULL,
      author     TEXT NOT NULL DEFAULT '',
      -- Which session of the author wrote it; '' when the writer sent none.
      session    TEXT NOT NULL DEFAULT '',
      text       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    -- Preferences the human sets once and every later session reads, so an
    -- agent never re-asks a question already answered. Key/value rather than
    -- columns: the set of things worth asking will change, and a schema
    -- migration per preference is a bad trade for a single-user tool.
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_items_project ON items(project_id, position);
    CREATE INDEX IF NOT EXISTS idx_messages_item ON messages(item_id, created_at);
  `);
  // Additive migrations for databases created before a column existed. SQLite
  // has no ADD COLUMN IF NOT EXISTS, and a tool people install at different
  // times must open an old file rather than refuse it.
  const pcols = new Set<string>(db.query('PRAGMA table_info(projects)').all().map((r: any) => r.name));
  if (!pcols.has('section_mode')) db.exec("ALTER TABLE projects ADD COLUMN section_mode TEXT NOT NULL DEFAULT 'adhoc'");
  if (!pcols.has('sections')) db.exec("ALTER TABLE projects ADD COLUMN sections TEXT NOT NULL DEFAULT '[]'");
  if (!pcols.has('group_by')) db.exec("ALTER TABLE projects ADD COLUMN group_by TEXT NOT NULL DEFAULT 'section'");
  if (!pcols.has('repos')) db.exec("ALTER TABLE projects ADD COLUMN repos TEXT NOT NULL DEFAULT '[]'");
  if (!pcols.has('key')) db.exec('ALTER TABLE projects ADD COLUMN key TEXT');
  if (!pcols.has('old_keys')) db.exec("ALTER TABLE projects ADD COLUMN old_keys TEXT NOT NULL DEFAULT '[]'");
  if (!pcols.has('next_seq')) db.exec('ALTER TABLE projects ADD COLUMN next_seq INTEGER NOT NULL DEFAULT 1');
  const columns = new Set<string>(db.query('PRAGMA table_info(items)').all().map((r: any) => r.name));
  if (!columns.has('seq')) db.exec('ALTER TABLE items ADD COLUMN seq INTEGER');
  if (!columns.has('client_id')) db.exec("ALTER TABLE items ADD COLUMN client_id TEXT NOT NULL DEFAULT ''");
  if (!columns.has('updated_session')) db.exec("ALTER TABLE items ADD COLUMN updated_session TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_items_client ON items(project_id, client_id)');
  const mcols = new Set<string>(db.query('PRAGMA table_info(messages)').all().map((r: any) => r.name));
  if (!mcols.has('session')) db.exec("ALTER TABLE messages ADD COLUMN session TEXT NOT NULL DEFAULT ''");
  if (!columns.has('version')) db.exec('ALTER TABLE items ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  if (!columns.has('updated_by')) db.exec("ALTER TABLE items ADD COLUMN updated_by TEXT NOT NULL DEFAULT ''");
  if (!columns.has('body')) db.exec("ALTER TABLE items ADD COLUMN body TEXT NOT NULL DEFAULT ''");
  if (!columns.has('body_format')) db.exec("ALTER TABLE items ADD COLUMN body_format TEXT NOT NULL DEFAULT 'text'");
  if (!columns.has('checks')) db.exec("ALTER TABLE items ADD COLUMN checks TEXT NOT NULL DEFAULT '[]'");
  if (!columns.has('labels')) db.exec("ALTER TABLE items ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'");
  if (!columns.has('kind')) {
    db.exec("ALTER TABLE items ADD COLUMN kind TEXT NOT NULL DEFAULT 'issue'");
    // Backfill: anything carrying long-form content is a document. That is the
    // best signal available on an existing board and it is right far more often
    // than it is wrong; the ones it gets wrong are visible immediately, because
    // their status will not match their kind and the next line fixes that.
    db.exec("UPDATE items SET kind = 'document' WHERE length(body) > 0");
  }
  // Any item whose status does not belong to its kind is corrected to that
  // kind's default. This runs on every open, not only on the backfill: it is the
  // guard that stops a stored value the UI can no longer produce from sitting
  // there forever after a hand-edit or an older writer.
  db.exec("UPDATE items SET status = 'active' WHERE kind = 'document' AND status NOT IN ('active','archived')");
  db.exec("UPDATE items SET status = 'needs-decision' WHERE kind = 'issue' AND status IN ('active','archived')");
  // `needs-you` split into `needs-decision` and `needs-qa`. Every existing row
  // predates the split and therefore predates the distinction, so it becomes
  // `needs-decision` — the meaning it actually had. Nothing is guessed as QA:
  // an item nobody has marked as finished work is not finished work.
  //
  // Rewritten in place rather than translated on read, so the stored value and
  // the vocabulary never disagree. A row already migrated matches nothing and
  // the statement is a no-op, which is what makes reopening an old file safe.
  db.exec("UPDATE items SET status = 'needs-decision' WHERE status = 'needs-you'");
  // Sequence backfill is transactional and ordered by the same two fields the
  // board uses for deterministic history. Reopening after it ran sees no NULL
  // sequences, so it changes neither existing numbers nor the counter.
  const backfillSequences = db.transaction(() => {
    const projects = db.query('SELECT id, next_seq FROM projects').all() as any[];
    for (const project of projects) {
      const maximum: any = db.query('SELECT MAX(seq) AS max_seq FROM items WHERE project_id = ?').get(project.id);
      let next = Math.max(1, Number.isSafeInteger(maximum?.max_seq) ? maximum.max_seq + 1 : 1);
      const missing = db.query('SELECT id FROM items WHERE project_id = ? AND seq IS NULL ORDER BY created_at ASC, id ASC').all(project.id) as any[];
      for (const item of missing) {
        db.query('UPDATE items SET seq = ? WHERE id = ?').run(next, item.id);
        next += 1;
      }
      const after: any = db.query('SELECT MAX(seq) AS max_seq FROM items WHERE project_id = ?').get(project.id);
      const maxSeq = Number.isSafeInteger(after?.max_seq) ? after.max_seq : 0;
      const storedNext = Number.isSafeInteger(project.next_seq) ? project.next_seq : 1;
      db.query('UPDATE projects SET next_seq = ? WHERE id = ?').run(Math.max(1, storedNext, maxSeq + 1), project.id);
    }
  });
  backfillSequences();
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_key ON projects(key) WHERE key IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_items_project_seq ON items(project_id, seq)');
  return db;
}

/**
 * Thrown when a writer sends a whole `checks` array onto an item whose steps
 * already carry results. The contract said "define steps only while no results
 * are recorded" and nothing enforced it: a requeue on the reference board
 * answered 200 and seven recorded results (5 pass, 1 fail, 1 skip) were gone
 * from the item and, seconds later, from the export. Replacing a QA record must
 * be an explicit act — `replaceChecks: true` — never a side effect of an edit.
 */
export class ChecksLocked extends Error {
  constructor(public current: Item, public stepsWithResults: string[]) {
    super(`item ${current.id} has recorded results on ${stepsWithResults.length} step(s): ${stepsWithResults.join(', ')}. ` +
      `Record results with PATCH /api/items/${current.id}/checks/<step>; to redefine the steps and discard those results send "replaceChecks": true.`);
    this.name = 'ChecksLocked';
  }
}

// Thrown when a writer's `ifVersion` no longer matches. The current item is
// attached so the caller can merge rather than re-read and race again.
export class VersionConflict extends Error {
  constructor(public current: Item) {
    super(`item ${current.id} has moved on (current version ${current.version}); re-read and retry`);
    this.name = 'VersionConflict';
  }
}

function rowToProject(r: any): Project {
  const oldKeys = (() => {
    try {
      const parsed = JSON.parse(r.old_keys ?? '[]');
      return Array.isArray(parsed)
        ? [...new Set(parsed.filter((key) => typeof key === 'string' && /^[A-Z][A-Z0-9]{1,4}$/.test(key)))]
        : [];
    } catch { return []; }
  })();
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    key: typeof r.key === 'string' && /^[A-Z][A-Z0-9]{1,4}$/.test(r.key) ? r.key : null,
    oldKeys,
    nextSeq: Number.isSafeInteger(r.next_seq) && r.next_seq > 0 ? r.next_seq : 1,
    sectionMode: (r.section_mode === 'declared' ? 'declared' : 'adhoc') as SectionMode,
    sections: (() => {
      try {
        const parsed = JSON.parse(r.sections ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
      } catch { return []; }
    })(),
    groupBy: (r.group_by === 'status' ? 'status' : 'section') as GroupBy,
    repos: (() => {
      try {
        const parsed = JSON.parse(r.repos ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string' && x.trim()) : [];
      } catch { return []; }
    })(),
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

function rowToItem(r: any): Item {
  let options: string[] = [];
  try {
    const parsed = JSON.parse(r.options);
    if (Array.isArray(parsed)) options = parsed.filter((o) => typeof o === 'string');
  } catch {
    // A malformed options blob must not take the whole list down with it. An
    // item with no buttons is still readable and still answerable in the thread.
    options = [];
  }
  return {
    id: r.id,
    projectId: r.project_id,
    seq: Number.isSafeInteger(r.seq) ? r.seq : 0,
    ref: typeof r.project_key === 'string' && Number.isSafeInteger(r.seq) ? formatRef(r.project_key, r.seq) : null,
    title: r.title,
    context: r.context,
    options,
    choice: r.choice,
    status: r.status as Status,
    section: r.section,
    position: r.position,
    version: r.version ?? 1,
    updatedBy: r.updated_by ?? '',
    updatedSession: r.updated_session ?? '',
    checks: (() => {
      try {
        const parsed = JSON.parse(r.checks ?? '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    })(),
    labels: parseLabels(r.labels),
    kind: (r.kind === 'document' ? 'document' : 'issue') as Kind,
    clientId: r.client_id ?? '',
    body: r.body ?? '',
    bodyFormat: (r.body_format ?? 'text') as 'text' | 'markdown' | 'html',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToMessage(r: any): Message {
  return {
    id: r.id,
    itemId: r.item_id,
    who: r.who === 'you' ? 'you' : 'agent',
    author: r.author,
    session: r.session ?? '',
    text: r.text,
    createdAt: r.created_at,
  };
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'project';
}

export class Store {
  constructor(private db: Database) {}

  /** A former key is a reservation too, so lookup checks both project fields. */
  private keyOwner(key: string, exceptProjectId?: string): { slug: string; id: string } | null {
    for (const row of this.db.query('SELECT id, slug, key, old_keys FROM projects').all() as any[]) {
      if (row.id === exceptProjectId) continue;
      const oldKeys = (() => {
        try {
          const parsed = JSON.parse(row.old_keys ?? '[]');
          return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
      })();
      if (row.key === key || oldKeys.includes(key)) return { id: row.id, slug: row.slug };
    }
    return null;
  }

  private assertKeyAvailable(key: string, exceptProjectId?: string): void {
    const owner = this.keyOwner(key, exceptProjectId);
    if (owner) throw new ProjectKeyTaken(owner.slug, key);
  }

  listProjects(includeArchived = false): Project[] {
    const sql = includeArchived
      ? 'SELECT * FROM projects ORDER BY created_at DESC'
      : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at DESC';
    return this.db.query(sql).all().map(rowToProject);
  }

  getProject(slug: string): Project | null {
    const row = this.db.query('SELECT * FROM projects WHERE slug = ?').get(slug);
    return row ? rowToProject(row) : null;
  }

  /**
   * The project a repository reference belongs to, or null. `ref` is a remote
   * URL, `owner/name`, or a directory path; see normaliseRepoRef. First match
   * wins in creation order, newest first — the same order the gallery shows.
   */
  resolveProject(ref: string, home = ''): Project | null {
    const target = normaliseRepoRef(ref, home);
    if (!target) return null;
    for (const project of this.listProjects(false)) {
      if (project.repos.some((entry) => repoMatches(entry, target, home))) return project;
    }
    return null;
  }

  createProject(input: { name: string; slug?: string; description?: string; repos?: string[]; key?: string }): Project {
    const slug = slugify(input.slug || input.name);
    const existing = this.getProject(slug);
    // Idempotent by slug. An agent that re-runs its own setup should find its
    // project, not collide with it or silently make a second one. A supplied
    // key is deliberately ignored here: idempotent setup must never rename an
    // established project's public references as a side effect.
    if (existing) return existing;
    const key = input.key === undefined ? null : normaliseProjectKey(input.key);
    if (key) this.assertKeyAvailable(key);
    const project: Project = {
      id: randomUUID(),
      slug,
      name: input.name,
      description: input.description || '',
      key,
      oldKeys: [],
      nextSeq: 1,
      sectionMode: 'adhoc',
      sections: [],
      // The default for anything created from now on. A board exists to answer
      // "what is waiting on me", and status grouping answers it directly, where
      // sections answer "what area is this" — useful, but a second question.
      // Labels carry the relating that sections used to, without forcing one
      // axis on every item.
      //
      // Existing projects are untouched: they already hold a stored value, and
      // silently regrouping somebody's board under them is not a default, it is
      // a surprise.
      groupBy: 'status',
      repos: normaliseLabels(input.repos),
      createdAt: now(),
      archivedAt: null,
    };
    this.db
      .query('INSERT INTO projects (id, slug, name, description, key, old_keys, next_seq, section_mode, sections, group_by, repos, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
      .run(project.id, project.slug, project.name, project.description, project.key, JSON.stringify(project.oldKeys), project.nextSeq, project.sectionMode, JSON.stringify(project.sections), project.groupBy, JSON.stringify(project.repos), project.createdAt);
    return project;
  }

  /**
   * Change a project's display key without invalidating references already
   * quoted elsewhere. Null is intentionally not accepted: removal cannot make
   * an existing public identifier stop resolving.
   */
  setProjectKey(slug: string, key: string): { project: Project; changed: boolean; previousKey: string | null } | null {
    // Take the write lock before reading identity fields, avoiding lock upgrades between writers.
    const set = this.db.transaction(() => {
      const project = this.getProject(slug);
      if (!project) return null;
      const nextKey = normaliseProjectKey(key);
      if (project.key === nextKey) return { project, changed: false, previousKey: project.key };
      this.assertKeyAvailable(nextKey, project.id);
      const oldKeys = project.oldKeys.filter((oldKey) => oldKey !== nextKey);
      if (project.key && !oldKeys.includes(project.key)) oldKeys.push(project.key);
      this.db.query('UPDATE projects SET key = ?, old_keys = ? WHERE id = ?').run(nextKey, JSON.stringify(oldKeys), project.id);
      return { project: this.getProject(slug)!, changed: true, previousKey: project.key };
    });
    return set.immediate();
  }

  /**
   * Restore exported identity fields without allowing an import to roll the
   * sequence counter back below numbers this database already issued.
   */
  restoreProjectIdentity(slug: string, identity: { key: string | null; oldKeys: string[]; nextSeq: number }): Project | null {
    // Take the write lock before reading identity fields, avoiding lock upgrades between writers.
    const restore = this.db.transaction(() => {
      const project = this.getProject(slug);
      if (!project) return null;
      const key = identity.key === null ? null : normaliseProjectKey(identity.key);
      const oldKeys = [...new Set(identity.oldKeys.map((oldKey) => normaliseProjectKey(oldKey)))].filter((oldKey) => oldKey !== key);
      for (const reserved of [key, ...oldKeys]) if (reserved) this.assertKeyAvailable(reserved, project.id);
      const maxRow: any = this.db.query('SELECT MAX(seq) AS max_seq FROM items WHERE project_id = ?').get(project.id);
      const maxSeq = Number.isSafeInteger(maxRow?.max_seq) ? maxRow.max_seq : 0;
      const importedNext = Number.isSafeInteger(identity.nextSeq) && identity.nextSeq > 0 ? identity.nextSeq : 1;
      const nextSeq = Math.max(project.nextSeq, importedNext, maxSeq + 1, 1);
      this.db.query('UPDATE projects SET key = ?, old_keys = ?, next_seq = ? WHERE id = ?')
        .run(key, JSON.stringify(oldKeys), nextSeq, project.id);
      return this.getProject(slug);
    });
    return restore.immediate();
  }

  archiveProject(slug: string, archived: boolean): Project | null {
    const project = this.getProject(slug);
    if (!project) return null;
    this.db.query('UPDATE projects SET archived_at = ? WHERE id = ?').run(archived ? now() : null, project.id);
    return this.getProject(slug);
  }

  /**
   * The items of a project, body stripped.
   *
   * `messages` decides how much of each thread rides along: `'all'` (the
   * browser's need — it renders the threads), `'last'` (an agent's check-in
   * need — who spoke last and what they said), or `'none'`. `messageCount` is
   * set in every mode so a caller that received one message, or none, still
   * knows how long the thread is. The reference board was 62 items and 153
   * messages, all of them shipped on every check-in that wanted three rows.
   */
  listItems(projectId: string, messages: boolean | 'all' | 'last' | 'none' = 'all'): Item[] {
    const mode = messages === true ? 'all' : messages === false ? 'none' : messages;
    const items = this.db
      .query('SELECT items.*, projects.key AS project_key FROM items JOIN projects ON projects.id = items.project_id WHERE items.project_id = ? ORDER BY items.position ASC, items.created_at ASC')
      .all(projectId)
      .map(rowToItem);
    // The list never carries body text. A project holding a 150KB specification
    // would otherwise put it in every response the board polls for, five seconds
    // apart. `bodyLength` is kept so a list view can still say a document is
    // there and offer a way in.
    for (const item of items) {
      (item as any).bodyLength = item.body.length;
      item.body = '';
      // checks stay: they are small, and a row shows "12 of 41" from them.
    }
    const counts = new Map<string, number>();
    for (const row of this.db
      .query('SELECT item_id, COUNT(*) AS n FROM messages WHERE item_id IN (SELECT id FROM items WHERE project_id = ?) GROUP BY item_id')
      .all(projectId) as any[]) counts.set(row.item_id, row.n);
    for (const item of items) {
      item.messageCount = counts.get(item.id) ?? 0;
      if (mode === 'all') item.messages = this.listMessages(item.id);
      else if (mode === 'last') {
        const last = this.db.query('SELECT * FROM messages WHERE item_id = ? ORDER BY created_at DESC LIMIT 1').get(item.id);
        item.messages = last ? [rowToMessage(last)] : [];
      }
    }
    return items;
  }

  getItem(id: string): Item | null {
    const row = this.db.query('SELECT items.*, projects.key AS project_key FROM items JOIN projects ON projects.id = items.project_id WHERE items.id = ?').get(id);
    if (!row) return null;
    const item = rowToItem(row);
    item.messages = this.listMessages(item.id);
    return item;
  }

  /** Resolve UUIDs first, then current and former display references. */
  resolveItem(idOrRef: string): Item | null {
    const byId = this.getItem(idOrRef);
    if (byId) return byId;
    const parsed = parseRef(idOrRef);
    if (!parsed) return null;
    for (const project of this.listProjects(true)) {
      if (project.key !== parsed.key && !project.oldKeys.includes(parsed.key)) continue;
      const row = this.db.query('SELECT id FROM items WHERE project_id = ? AND seq = ?').get(project.id, parsed.seq) as any;
      if (row) return this.getItem(row.id);
    }
    return null;
  }

  createItem(projectId: string, input: ItemInput): Item {
    // Take the write lock before reading counters, avoiding lock upgrades between writers.
    const create = this.db.transaction(() => {
      const at = now();
      // `updatedAt` stays the clock even when a creation date is supplied: the row
      // WAS written now, and an import that backdated both would look like an item
      // nobody has touched in months the moment it arrived.
      const createdAt = asHistoricInstant(input.createdAt) || at;
      // The kind decides which statuses are legal, so it is resolved first and the
      // status is checked against it. A status that does not belong to the kind is
      // replaced rather than refused: the caller told us what the thing IS, which
      // is the more reliable half of the pair, and refusing the whole create over
      // a status an older writer could not have known about loses the item.
      const kind: Kind = input.kind === 'document' ? 'document' : 'issue';
      const status = input.status && isStatusAllowed(kind, input.status) ? input.status : defaultStatusFor(kind);
      // A retry returns before reading or advancing next_seq. Keeping this in
      // the same transaction as the insert closes the only sequence race.
      const clientId = typeof input.clientId === 'string' ? input.clientId.trim().slice(0, 120) : '';
      if (clientId) {
        const existing: any = this.db.query('SELECT id FROM items WHERE project_id = ? AND client_id = ?').get(projectId, clientId);
        if (existing) return this.getItem(existing.id)!;
      }
      const project: any = this.db.query('SELECT next_seq FROM projects WHERE id = ?').get(projectId);
      if (!project) throw new Error(`cannot create item: project ${projectId} does not exist`);
      const maxRow: any = this.db.query('SELECT MAX(position) AS m, MAX(seq) AS max_seq FROM items WHERE project_id = ?').get(projectId);
      const position = (maxRow?.m ?? -1) + 1;
      const maxSeq = Number.isSafeInteger(maxRow?.max_seq) ? maxRow.max_seq : 0;
      const storedNext = Number.isSafeInteger(project.next_seq) && project.next_seq > 0 ? project.next_seq : 1;
      const freshSeq = Math.max(1, storedNext, maxSeq + 1);
      const requestedSeq = Number.isSafeInteger(input.seq) && input.seq! > 0 ? input.seq : null;
      const requestedInUse = requestedSeq === null ? true : Boolean(this.db.query('SELECT 1 FROM items WHERE project_id = ? AND seq = ?').get(projectId, requestedSeq));
      const seq = requestedSeq !== null && !requestedInUse ? requestedSeq : freshSeq;
      const id = randomUUID();
      this.db
        .query(
          `INSERT INTO items (id, project_id, title, context, options, choice, status, section, position, body, body_format, checks, labels, kind, client_id, seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          projectId,
          input.title,
          input.context || '',
          JSON.stringify(input.options || []),
          input.choice || '',
          status,
          input.section || '',
          position,
          input.body || '',
          input.bodyFormat || 'text',
          JSON.stringify(input.checks || []),
          JSON.stringify(normaliseLabels(input.labels)),
          kind,
          clientId,
          seq,
          createdAt,
          at
        );
      this.db.query('UPDATE projects SET next_seq = ? WHERE id = ?').run(Math.max(storedNext, maxSeq + 1, seq + 1), projectId);
      return this.getItem(id)!;
    });
    return create.immediate();
  }

  // `ifVersion` is optional so a casual writer stays simple, and enforced when
  // given so a careful one cannot clobber. The UPDATE itself carries the version
  // in its WHERE clause, which is what makes the check atomic — testing the
  // version in JavaScript first would leave a window between the read and the
  // write exactly wide enough for the problem it is meant to prevent.
  updateItem(
    id: string,
    patch: Partial<ItemInput> & { position?: number },
    opts: { ifVersion?: number; actor?: string; session?: string; replaceChecks?: boolean } = {}
  ): Item | null {
    const current = this.getItem(id);
    if (!current) return null;
    if (patch.checks !== undefined && !opts.replaceChecks) {
      const recorded = current.checks.filter((c) => c.result).map((c) => c.id);
      if (recorded.length) throw new ChecksLocked(current, recorded);
    }
    // Kind and status move together. Changing the kind of an existing item is
    // legitimate — a decision that turns out to be a specification, or the other
    // way round — but it cannot leave the item holding a status its new kind
    // does not have, so the status follows unless the same patch sets a valid one.
    const kind: Kind = patch.kind === undefined ? current.kind : (patch.kind === 'document' ? 'document' : 'issue');
    const wanted = patch.status ?? current.status;
    const status = isStatusAllowed(kind, wanted) ? wanted : defaultStatusFor(kind);
    const next = {
      title: patch.title ?? current.title,
      context: patch.context ?? current.context,
      options: JSON.stringify(patch.options ?? current.options),
      choice: patch.choice ?? current.choice,
      status,
      kind,
      section: patch.section ?? current.section,
      position: patch.position ?? current.position,
      body: patch.body ?? current.body,
      bodyFormat: patch.bodyFormat ?? current.bodyFormat,
      checks: JSON.stringify(patch.checks ?? current.checks),
      labels: JSON.stringify(patch.labels === undefined ? current.labels : normaliseLabels(patch.labels)),
    };
    const guard = typeof opts.ifVersion === 'number' ? ' AND version = ?' : '';
    const params: any[] = [
      next.title, next.context, next.options, next.choice, next.status, next.kind, next.section, next.position,
      next.body, next.bodyFormat, next.checks, next.labels, now(), opts.actor || '', opts.session || '', id,
    ];
    if (guard) params.push(opts.ifVersion);
    const result = this.db
      .query(
        `UPDATE items SET title = ?, context = ?, options = ?, choice = ?, status = ?, kind = ?, section = ?, position = ?,
           body = ?, body_format = ?, checks = ?, labels = ?, updated_at = ?, updated_by = ?, updated_session = ?, version = version + 1
         WHERE id = ?${guard}`
      )
      .run(...params);
    if (result.changes === 0 && guard) throw new VersionConflict(this.getItem(id)!);
    return this.getItem(id);
  }

  // One step at a time, read-modify-write inside the same transaction as the
  // version bump. Answering step 12 while another session answers step 13 must
  // not lose either, and sending the whole array back would do exactly that.
  setCheck(
    itemId: string,
    checkId: string,
    patch: { result?: Check['result']; note?: string; by?: string; session?: string }
  ): Item | null {
    const current = this.getItem(itemId);
    if (!current) return null;
    const checks = current.checks.map((c) =>
      c.id === checkId
        ? {
            ...c,
            result: patch.result ?? c.result,
            note: patch.note ?? c.note,
            by: patch.by ?? c.by,
            at: now(),
          }
        : c
    );
    if (!checks.some((c) => c.id === checkId)) return current;
    // A pass needs no explanation; anything else does. "Failed" with no note is
    // the least useful record a checklist can produce — somebody reading the
    // sign-off later cannot tell what went wrong, and the person who knew has
    // moved on. Enforced here rather than only in the browser, because an agent
    // recording a result must meet the same bar as a person.
    const next = checks.find((c) => c.id === checkId)!;
    if (next.result && next.result !== 'pass' && !String(next.note || '').trim()) {
      const error: any = new Error(`step "${next.label}" was recorded as ${next.result}; a note is required for anything other than a pass`);
      error.statusCode = 400;
      throw error;
    }
    this.db
      .query('UPDATE items SET checks = ?, updated_at = ?, updated_by = ?, updated_session = ?, version = version + 1 WHERE id = ?')
      .run(JSON.stringify(checks), now(), patch.by || '', patch.session || '', itemId);
    // The last pass signs the item off. QA used to end in a status nobody had
    // set: every step recorded pass and the item sat at `needs-qa`, reading as
    // waiting on the human, until somebody noticed and moved it by hand. Sign-off
    // is whoever recorded the last pass — a person or a model doing the QA — so
    // the board says so and hands the item back to the agent that built it, at
    // `received`, to land and close. A fail or a skip anywhere leaves it at QA
    // with the note on the step; nothing is signed off with an open question.
    const allPass = checks.length > 0 && checks.every((c) => c.result === 'pass');
    if (allPass && current.kind === 'issue' && current.status === 'needs-qa') {
      const by = patch.by || 'you';
      this.addMessage(itemId, {
        who: by === 'you' ? 'you' : 'agent',
        author: by,
        session: patch.session,
        status: 'received',
        text: `All ${checks.length} steps passed — signed off by ${by}. Back to the builder to land and close.`,
      });
    }
    return this.getItem(itemId);
  }

  deleteItem(id: string): boolean {
    const result = this.db.query('DELETE FROM items WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listMessages(itemId: string): Message[] {
    return this.db
      .query('SELECT * FROM messages WHERE item_id = ? ORDER BY created_at ASC')
      .all(itemId)
      .map(rowToMessage);
  }

  // Appending a message is the one write both sides do constantly, so it also
  // carries the status transition rather than leaving it to a second call that
  // can fail on its own. A human reply means the agent has not seen it yet
  // (a needs-* status would be a lie, `received` is the agent's word to give), so
  // the human's own post moves it OFF the needs-* states and the agent's reply marks
  // it received. Callers can still override explicitly.
  addMessage(itemId: string, input: { who: 'you' | 'agent'; text: string; author?: string; session?: string; status?: Status; createdAt?: string }): Message | null {
    const item = this.getItem(itemId);
    if (!item) return null;
    const message: Message = {
      id: randomUUID(),
      itemId,
      who: input.who,
      author: input.author || (input.who === 'you' ? 'you' : 'agent'),
      session: (input.session || '').trim().slice(0, 40),
      text: input.text,
      // Same rule as an item's: supplied only by an import replaying history,
      // and only when it is a real past instant. Without it a restored board
      // has every thread collapsed into the second the import ran, in an
      // interface whose whole job is showing who spoke last and when.
      createdAt: asHistoricInstant(input.createdAt) || now(),
    };
    this.db
      .query('INSERT INTO messages (id, item_id, who, author, session, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(message.id, message.itemId, message.who, message.author, message.session, message.text, message.createdAt);

    // A document has no "the agent is working on it" state, so a human replying
    // on one must not drag it to `received` — that is a task transition and it
    // would put a specification into a status its own dropdown cannot show.
    // Documents keep whatever they hold; only an explicit status moves them.
    //
    // The two sides of the handshake are now symmetric, and they were not.
    //
    // A human reply has always moved an issue to `received` automatically. An
    // agent reply moved nothing — so an agent that answered an item and forgot
    // the separate status call left it reading `received`, identical to an item
    // nobody had touched. The contract said "post a message, set the status",
    // and only one of those two was ever enforced by anything. Memory is what
    // fails under load, across a context reset, and at the end of a long round;
    // that is exactly when the board most needs to be true.
    //
    // So an agent replying to an item at `received` claims it. Narrow on
    // purpose: `received` is the one status meaning "yours, nobody has started",
    // so a reply there is unambiguous. An agent adding context to a question
    // still waiting on the human (`needs-decision`, `needs-qa`) leaves the move
    // where it is, and anything else needs an explicit status — which a caller
    // can always pass, and should whenever the reply hands the item back.
    const autoClaim = item.kind === 'issue' && input.who === 'agent' && item.status === 'received';
    const wanted: Status = input.status
      ?? (item.kind === 'issue' && input.who === 'you' ? 'received' : (autoClaim ? 'in-progress' : item.status));
    const status: Status = isStatusAllowed(item.kind, wanted) ? wanted : item.status;
    // Messages are append-only and never conflict, so posting one is always
    // safe from any number of sessions at once. Only the status it carries
    // touches the item row, and it bumps the version so a concurrent editor
    // holding an older copy is refused rather than silently reverting it.
    //
    // A message that does NOT move the status leaves the item row alone
    // entirely. It used to rewrite `updated_by`/`updated_at` on every message,
    // which meant any comment by anyone repainted who holds the claim — and
    // `updatedBy`/`updatedAt` on an `in-progress` item is the *only* thing
    // "Recovering an abandoned claim" has to tell your own crashed session from
    // somebody else's live one. One passing remark and the item read as though
    // the commenter had taken it. The claim belongs to whoever changed the
    // status, so only a status change may rewrite it.
    if (status !== item.status) {
      this.db
        .query('UPDATE items SET status = ?, updated_at = ?, updated_by = ?, updated_session = ?, version = version + 1 WHERE id = ?')
        .run(status, now(), message.author, message.session, itemId);
    }
    return message;
  }

  getSettings(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of this.db.query('SELECT key, value FROM settings').all() as any[]) {
      try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = row.value; }
    }
    return out;
  }

  setSettings(patch: Record<string, unknown>): Record<string, unknown> {
    const at = now();
    for (const [key, value] of Object.entries(patch)) {
      this.db
        .query('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run(key, JSON.stringify(value), at);
    }
    return this.getSettings();
  }

  /** The vocabulary actually in use, plus anything declared but unused. */
  sectionsInUse(project: Project): { name: string; count: number; declared: boolean }[] {
    const rows: any[] = this.db
      .query("SELECT section AS name, COUNT(*) AS n FROM items WHERE project_id = ? AND section <> '' GROUP BY section ORDER BY n DESC")
      .all(project.id);
    const out = rows.map((r) => ({ name: r.name, count: r.n, declared: project.sections.includes(r.name) }));
    for (const declared of project.sections) {
      if (!out.some((s) => s.name === declared)) out.push({ name: declared, count: 0, declared: true });
    }
    return out;
  }

  setProjectSections(slug: string, patch: { name?: string; description?: string; sectionMode?: SectionMode; sections?: string[]; groupBy?: GroupBy; repos?: string[] }): Project | null {
    const project = this.getProject(slug);
    if (!project) return null;
    // The slug is deliberately not editable: it is the key in URLs, exports
    // and every agent's notes. A rebrand changes the name people read.
    const name = patch.name === undefined ? project.name : patch.name.trim();
    const description = patch.description === undefined ? project.description : patch.description;
    const mode = patch.sectionMode ?? project.sectionMode;
    const sections = patch.sections ?? project.sections;
    const groupBy = patch.groupBy ?? project.groupBy;
    const repos = patch.repos === undefined ? project.repos : normaliseLabels(patch.repos);
    this.db
      .query('UPDATE projects SET name = ?, description = ?, section_mode = ?, sections = ?, group_by = ?, repos = ? WHERE id = ?')
      .run(name, description, mode, JSON.stringify(sections), groupBy, JSON.stringify(repos), project.id);
    return this.getProject(slug);
  }

  /**
   * Every label in use on this project, commonest first.
   *
   * Read for the same reason `sectionsInUse` is: so a writer reuses a label
   * rather than inventing a near-synonym beside it. Computed rather than stored
   * — a label exists exactly as long as an item carries it, and a list that
   * outlives its last item is a list nobody trusts.
   */
  labelsInUse(projectId: string): { name: string; count: number }[] {
    const counts = new Map<string, { name: string; count: number }>();
    for (const row of this.db.query('SELECT labels FROM items WHERE project_id = ?').all(projectId) as any[]) {
      for (const label of parseLabels(row.labels)) {
        const key = label.toLowerCase();
        const seen = counts.get(key);
        if (seen) seen.count += 1;
        else counts.set(key, { name: label, count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  /**
   * Rename or merge a label across every item that carries it, or remove it
   * when `to` is empty. Same reasoning as renameSection: a vocabulary that
   * cannot be repaired only gets worse, and labels rot faster than sections
   * because nothing governs them on the way in.
   */
  renameLabel(projectId: string, from: string, to: string, actor = ''): number {
    const target = normaliseLabels([to])[0] ?? '';
    const key = String(from).trim().toLowerCase();
    if (!key) return 0;
    let changed = 0;
    const rows: any[] = this.db.query('SELECT id, labels FROM items WHERE project_id = ?').all(projectId);
    for (const row of rows) {
      const labels = parseLabels(row.labels);
      if (!labels.some((label) => label.toLowerCase() === key)) continue;
      // Map then re-normalise: renaming onto an existing label merges rather
      // than producing the same label twice on one item.
      const next = normaliseLabels(labels.map((label) => (label.toLowerCase() === key ? target : label)).filter(Boolean));
      this.db
        .query('UPDATE items SET labels = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?')
        .run(JSON.stringify(next), now(), actor, row.id);
      changed += 1;
    }
    return changed;
  }

  /**
   * Rename or merge a section across every item that uses it. Without this,
   * drift is permanent: somebody notices "Deploys" and "Ship it" are the same
   * area and has no way to say so except editing items one at a time.
   */
  renameSection(projectId: string, from: string, to: string, actor = ''): number {
    const result = this.db
      .query('UPDATE items SET section = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE project_id = ? AND section = ?')
      .run(to, now(), actor, projectId, from);
    return result.changes;
  }

  /**
   * Rename an author across one project: every message they signed and every
   * item they last touched. Exact match, case-insensitive.
   *
   * Exists because the contract's naming rule once offered two answers and the
   * reference board duly ended up with one agent under two names. Without a
   * repair the "who spoke last" column stays wrong forever.
   *
   * `updated_at` is deliberately NOT touched: it is what the stale-claim rule
   * reads, and a rename must not make an abandoned claim look fresh. The version
   * bumps so an editor holding an older copy is refused rather than writing the
   * old name back over the new one.
   */
  renameAuthor(projectId: string, from: string, to: string): { messages: number; items: number } {
    const key = String(from).trim().toLowerCase();
    const target = String(to).trim();
    if (!key || !target) return { messages: 0, items: 0 };
    const messages = this.db
      .query('UPDATE messages SET author = ? WHERE lower(author) = ? AND item_id IN (SELECT id FROM items WHERE project_id = ?)')
      .run(target, key, projectId);
    const items = this.db
      .query('UPDATE items SET updated_by = ?, version = version + 1 WHERE lower(updated_by) = ? AND project_id = ?')
      .run(target, key, projectId);
    return { messages: messages.changes, items: items.changes };
  }

  counts(projectId: string): Record<Status, number> {
    const out: Record<Status, number> = { 'needs-decision': 0, 'needs-qa': 0, received: 0, 'in-progress': 0, 'deferred': 0, active: 0, archived: 0, complete: 0, cancelled: 0 };
    const rows: any[] = this.db.query('SELECT status, COUNT(*) AS n FROM items WHERE project_id = ? GROUP BY status').all(projectId);
    for (const row of rows) if (row.status in out) out[row.status as Status] = row.n;
    return out;
  }
}
