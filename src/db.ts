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
//   received        the agent's — it has the answer and is working
//   deferred        nobody's, on purpose; revisit when something changes
//   active          not a task: a document that is current and still referenced
//   archived        not a task: a document superseded, kept for the record
//   complete        done
//
// `received` exists because a flat open/closed cannot express the thing that
// actually goes wrong: the human answers and cannot tell whether the answer was
// read. It is the agent's acknowledgement to give, never the human's.
export const STATUSES = ['needs-decision', 'needs-qa', 'received', 'deferred', 'active', 'archived', 'complete'] as const;
export type Status = (typeof STATUSES)[number];

// Display labels. Short on purpose: these sit in a chip, a filter button and a
// dropdown at once, and "Needs decision" wrapped to two lines in the chip. The
// word "Needs" carried nothing the group heading and the colour did not already
// say. The IDs keep the longer name — they are the agent contract.
export const STATUS_LABELS: Record<Status, string> = {
  'needs-decision': 'Decision',
  'needs-qa': 'QA',
  received: 'Received',
  'deferred': 'Deferred',
  active: 'Active',
  archived: 'Archived',
  complete: 'Complete',
};

/**
 * The statuses a document carries, as opposed to a task.
 *
 * Exported because the distinction matters to more than the grouping: an agent
 * deciding what to set, and a human reading why a thing is where it is, both
 * need to know these two are a pair and not two more points on the task scale.
 */
export const DOCUMENT_STATUSES: Status[] = ['active', 'archived'];

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
  { id: 'open', label: 'Open', statuses: ['needs-decision', 'needs-qa', 'received'] },
  { id: 'deferred', label: 'Deferred', statuses: ['deferred'] },
  // Documents sit above Archived and below the work, because a current
  // reference is something you reach for while working rather than something
  // waiting on you. An archived document joins finished work in the last group:
  // both are "kept, not current", and separating them would give the board two
  // graveyards.
  { id: 'documents', label: 'Documents', statuses: ['active'] },
  { id: 'archived', label: 'Archived', statuses: ['archived', 'complete'] },
];

export type Project = {
  id: string;
  slug: string;
  name: string;
  description: string;
  sectionMode: SectionMode;
  /** Declared vocabulary. Advisory in adhoc mode, enforced in declared mode. */
  sections: string[];
  /**
   * What the board groups its rows by.
   *
   *   section — one group per area of work (the original behaviour)
   *   status  — Open, Deferred, Documents, Archived
   *
   * `status` answers the question a board exists for — what is waiting, what is
   * parked, what is done — and leaves `labels` to carry the relationships that
   * sections used to. `section` stays the default so an existing board does not
   * silently regroup under whoever opens it next.
   */
  groupBy: GroupBy;
  createdAt: string;
  archivedAt: string | null;
};

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
  title: string;
  context: string;
  options: string[];
  choice: string;
  status: Status;
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
  body: string;
  bodyFormat: 'text' | 'markdown' | 'html';
  checks: Check[];
  createdAt: string;
  updatedAt: string;
  messages?: Message[];
};

export type ItemInput = {
  title: string;
  context?: string;
  options?: string[];
  choice?: string;
  status?: Status;
  section?: string;
  body?: string;
  bodyFormat?: 'text' | 'markdown' | 'html';
  checks?: Check[];
  labels?: string[];
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
};

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
      -- What the board groups rows by: 'section' or 'status'. Defaults to
      -- section so an existing board keeps the shape its owner already knows.
      group_by     TEXT NOT NULL DEFAULT 'section'
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      item_id    TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      who        TEXT NOT NULL,
      author     TEXT NOT NULL DEFAULT '',
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
  const columns = new Set<string>(db.query('PRAGMA table_info(items)').all().map((r: any) => r.name));
  if (!columns.has('version')) db.exec('ALTER TABLE items ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  if (!columns.has('updated_by')) db.exec("ALTER TABLE items ADD COLUMN updated_by TEXT NOT NULL DEFAULT ''");
  if (!columns.has('body')) db.exec("ALTER TABLE items ADD COLUMN body TEXT NOT NULL DEFAULT ''");
  if (!columns.has('body_format')) db.exec("ALTER TABLE items ADD COLUMN body_format TEXT NOT NULL DEFAULT 'text'");
  if (!columns.has('checks')) db.exec("ALTER TABLE items ADD COLUMN checks TEXT NOT NULL DEFAULT '[]'");
  if (!columns.has('labels')) db.exec("ALTER TABLE items ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'");
  // `needs-you` split into `needs-decision` and `needs-qa`. Every existing row
  // predates the split and therefore predates the distinction, so it becomes
  // `needs-decision` — the meaning it actually had. Nothing is guessed as QA:
  // an item nobody has marked as finished work is not finished work.
  //
  // Rewritten in place rather than translated on read, so the stored value and
  // the vocabulary never disagree. A row already migrated matches nothing and
  // the statement is a no-op, which is what makes reopening an old file safe.
  db.exec("UPDATE items SET status = 'needs-decision' WHERE status = 'needs-you'");
  return db;
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
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    sectionMode: (r.section_mode === 'declared' ? 'declared' : 'adhoc') as SectionMode,
    sections: (() => {
      try {
        const parsed = JSON.parse(r.sections ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
      } catch { return []; }
    })(),
    groupBy: (r.group_by === 'status' ? 'status' : 'section') as GroupBy,
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
    title: r.title,
    context: r.context,
    options,
    choice: r.choice,
    status: r.status as Status,
    section: r.section,
    position: r.position,
    version: r.version ?? 1,
    updatedBy: r.updated_by ?? '',
    checks: (() => {
      try {
        const parsed = JSON.parse(r.checks ?? '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    })(),
    labels: parseLabels(r.labels),
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

  createProject(input: { name: string; slug?: string; description?: string }): Project {
    const slug = slugify(input.slug || input.name);
    const existing = this.getProject(slug);
    // Idempotent by slug. An agent that re-runs its own setup should find its
    // project, not collide with it or silently make a second one.
    if (existing) return existing;
    const project: Project = {
      id: randomUUID(),
      slug,
      name: input.name,
      description: input.description || '',
      sectionMode: 'adhoc',
      sections: [],
      groupBy: 'section',
      createdAt: now(),
      archivedAt: null,
    };
    this.db
      .query('INSERT INTO projects (id, slug, name, description, section_mode, sections, group_by, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)')
      .run(project.id, project.slug, project.name, project.description, project.sectionMode, JSON.stringify(project.sections), project.groupBy, project.createdAt);
    return project;
  }

  archiveProject(slug: string, archived: boolean): Project | null {
    const project = this.getProject(slug);
    if (!project) return null;
    this.db.query('UPDATE projects SET archived_at = ? WHERE id = ?').run(archived ? now() : null, project.id);
    return this.getProject(slug);
  }

  listItems(projectId: string, withMessages = true): Item[] {
    const items = this.db
      .query('SELECT * FROM items WHERE project_id = ? ORDER BY position ASC, created_at ASC')
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
    if (!withMessages) return items;
    for (const item of items) item.messages = this.listMessages(item.id);
    return items;
  }

  getItem(id: string): Item | null {
    const row = this.db.query('SELECT * FROM items WHERE id = ?').get(id);
    if (!row) return null;
    const item = rowToItem(row);
    item.messages = this.listMessages(item.id);
    return item;
  }

  createItem(projectId: string, input: ItemInput): Item {
    const at = now();
    // `updatedAt` stays the clock even when a creation date is supplied: the row
    // WAS written now, and an import that backdated both would look like an item
    // nobody has touched in months the moment it arrived.
    const createdAt = asHistoricInstant(input.createdAt) || at;
    const maxRow: any = this.db.query('SELECT MAX(position) AS m FROM items WHERE project_id = ?').get(projectId);
    const position = (maxRow?.m ?? -1) + 1;
    const id = randomUUID();
    this.db
      .query(
        `INSERT INTO items (id, project_id, title, context, options, choice, status, section, position, body, body_format, checks, labels, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        projectId,
        input.title,
        input.context || '',
        JSON.stringify(input.options || []),
        input.choice || '',
        input.status || 'needs-decision',
        input.section || '',
        position,
        input.body || '',
        input.bodyFormat || 'text',
        JSON.stringify(input.checks || []),
        JSON.stringify(normaliseLabels(input.labels)),
        createdAt,
        at
      );
    return this.getItem(id)!;
  }

  // `ifVersion` is optional so a casual writer stays simple, and enforced when
  // given so a careful one cannot clobber. The UPDATE itself carries the version
  // in its WHERE clause, which is what makes the check atomic — testing the
  // version in JavaScript first would leave a window between the read and the
  // write exactly wide enough for the problem it is meant to prevent.
  updateItem(
    id: string,
    patch: Partial<ItemInput> & { position?: number },
    opts: { ifVersion?: number; actor?: string } = {}
  ): Item | null {
    const current = this.getItem(id);
    if (!current) return null;
    const next = {
      title: patch.title ?? current.title,
      context: patch.context ?? current.context,
      options: JSON.stringify(patch.options ?? current.options),
      choice: patch.choice ?? current.choice,
      status: patch.status ?? current.status,
      section: patch.section ?? current.section,
      position: patch.position ?? current.position,
      body: patch.body ?? current.body,
      bodyFormat: patch.bodyFormat ?? current.bodyFormat,
      checks: JSON.stringify(patch.checks ?? current.checks),
      labels: JSON.stringify(patch.labels === undefined ? current.labels : normaliseLabels(patch.labels)),
    };
    const guard = typeof opts.ifVersion === 'number' ? ' AND version = ?' : '';
    const params: any[] = [
      next.title, next.context, next.options, next.choice, next.status, next.section, next.position,
      next.body, next.bodyFormat, next.checks, next.labels, now(), opts.actor || '', id,
    ];
    if (guard) params.push(opts.ifVersion);
    const result = this.db
      .query(
        `UPDATE items SET title = ?, context = ?, options = ?, choice = ?, status = ?, section = ?, position = ?,
           body = ?, body_format = ?, checks = ?, labels = ?, updated_at = ?, updated_by = ?, version = version + 1
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
    patch: { result?: Check['result']; note?: string; by?: string }
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
      .query('UPDATE items SET checks = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?')
      .run(JSON.stringify(checks), now(), patch.by || '', itemId);
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
  addMessage(itemId: string, input: { who: 'you' | 'agent'; text: string; author?: string; status?: Status; createdAt?: string }): Message | null {
    const item = this.getItem(itemId);
    if (!item) return null;
    const message: Message = {
      id: randomUUID(),
      itemId,
      who: input.who,
      author: input.author || (input.who === 'you' ? 'you' : 'agent'),
      text: input.text,
      // Same rule as an item's: supplied only by an import replaying history,
      // and only when it is a real past instant. Without it a restored board
      // has every thread collapsed into the second the import ran, in an
      // interface whose whole job is showing who spoke last and when.
      createdAt: asHistoricInstant(input.createdAt) || now(),
    };
    this.db
      .query('INSERT INTO messages (id, item_id, who, author, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(message.id, message.itemId, message.who, message.author, message.text, message.createdAt);

    const status: Status = input.status ?? (input.who === 'you' ? 'received' : item.status);
    // Messages are append-only and never conflict, so posting one is always
    // safe from any number of sessions at once. Only the status it carries
    // touches the item row, and it bumps the version so a concurrent editor
    // holding an older copy is refused rather than silently reverting it.
    this.db
      .query('UPDATE items SET status = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?')
      .run(status, now(), message.author, itemId);
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

  setProjectSections(slug: string, patch: { sectionMode?: SectionMode; sections?: string[]; groupBy?: GroupBy }): Project | null {
    const project = this.getProject(slug);
    if (!project) return null;
    const mode = patch.sectionMode ?? project.sectionMode;
    const sections = patch.sections ?? project.sections;
    const groupBy = patch.groupBy ?? project.groupBy;
    this.db
      .query('UPDATE projects SET section_mode = ?, sections = ?, group_by = ? WHERE id = ?')
      .run(mode, JSON.stringify(sections), groupBy, project.id);
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

  counts(projectId: string): Record<Status, number> {
    const out: Record<Status, number> = { 'needs-decision': 0, 'needs-qa': 0, received: 0, 'deferred': 0, active: 0, archived: 0, complete: 0 };
    const rows: any[] = this.db.query('SELECT status, COUNT(*) AS n FROM items WHERE project_id = ? GROUP BY status').all(projectId);
    for (const row of rows) if (row.status in out) out[row.status as Status] = row.n;
    return out;
  }
}
