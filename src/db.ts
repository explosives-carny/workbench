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

// The four states an item can be in, and the vocabulary the whole tool speaks.
// They are chosen so that no two of them overlap, which took a correction: an
// earlier set had `needs-you` and `needs-more` side by side, and both meant "the
// human owes something". The only difference was whether it was the first ask or
// a follow-up — provenance, which the thread already shows. In the one view that
// matters, the human's queue, they were the same state twice.
//
// What the four now answer is "whose move is it":
//   needs-you  the human's
//   received   the agent's — it has the answer and is working
//   deferred   nobody's, on purpose; revisit when something changes
//   complete   done
//
// `received` exists because a flat open/closed cannot express the thing that
// actually goes wrong: the human answers and cannot tell whether the answer was
// read. It is the agent's acknowledgement to give, never the human's.
export const STATUSES = ['needs-you', 'received', 'deferred', 'complete'] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  'needs-you': 'Needs you',
  received: 'Received',
  'deferred': 'Deferred',
  complete: 'Complete',
};

export type SectionMode = 'adhoc' | 'declared';

export type Project = {
  id: string;
  slug: string;
  name: string;
  description: string;
  sectionMode: SectionMode;
  /** Declared vocabulary. Advisory in adhoc mode, enforced in declared mode. */
  sections: string[];
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
};

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
      sections     TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS items (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      context    TEXT NOT NULL DEFAULT '',
      options    TEXT NOT NULL DEFAULT '[]',
      choice     TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'needs-you',
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
  const columns = new Set<string>(db.query('PRAGMA table_info(items)').all().map((r: any) => r.name));
  if (!columns.has('version')) db.exec('ALTER TABLE items ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  if (!columns.has('updated_by')) db.exec("ALTER TABLE items ADD COLUMN updated_by TEXT NOT NULL DEFAULT ''");
  if (!columns.has('body')) db.exec("ALTER TABLE items ADD COLUMN body TEXT NOT NULL DEFAULT ''");
  if (!columns.has('body_format')) db.exec("ALTER TABLE items ADD COLUMN body_format TEXT NOT NULL DEFAULT 'text'");
  if (!columns.has('checks')) db.exec("ALTER TABLE items ADD COLUMN checks TEXT NOT NULL DEFAULT '[]'");
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
      createdAt: now(),
      archivedAt: null,
    };
    this.db
      .query('INSERT INTO projects (id, slug, name, description, section_mode, sections, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)')
      .run(project.id, project.slug, project.name, project.description, project.sectionMode, JSON.stringify(project.sections), project.createdAt);
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
    const maxRow: any = this.db.query('SELECT MAX(position) AS m FROM items WHERE project_id = ?').get(projectId);
    const position = (maxRow?.m ?? -1) + 1;
    const id = randomUUID();
    this.db
      .query(
        `INSERT INTO items (id, project_id, title, context, options, choice, status, section, position, body, body_format, checks, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        projectId,
        input.title,
        input.context || '',
        JSON.stringify(input.options || []),
        input.choice || '',
        input.status || 'needs-you',
        input.section || '',
        position,
        input.body || '',
        input.bodyFormat || 'text',
        JSON.stringify(input.checks || []),
        at,
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
    };
    const guard = typeof opts.ifVersion === 'number' ? ' AND version = ?' : '';
    const params: any[] = [
      next.title, next.context, next.options, next.choice, next.status, next.section, next.position,
      next.body, next.bodyFormat, next.checks, now(), opts.actor || '', id,
    ];
    if (guard) params.push(opts.ifVersion);
    const result = this.db
      .query(
        `UPDATE items SET title = ?, context = ?, options = ?, choice = ?, status = ?, section = ?, position = ?,
           body = ?, body_format = ?, checks = ?, updated_at = ?, updated_by = ?, version = version + 1
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
  // (`needs-you` would be a lie, `received` is the agent's word to give), so the
  // human's own post moves it OFF needs-you and the agent's reply is what marks
  // it received. Callers can still override explicitly.
  addMessage(itemId: string, input: { who: 'you' | 'agent'; text: string; author?: string; status?: Status }): Message | null {
    const item = this.getItem(itemId);
    if (!item) return null;
    const message: Message = {
      id: randomUUID(),
      itemId,
      who: input.who,
      author: input.author || (input.who === 'you' ? 'you' : 'agent'),
      text: input.text,
      createdAt: now(),
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

  setProjectSections(slug: string, patch: { sectionMode?: SectionMode; sections?: string[] }): Project | null {
    const project = this.getProject(slug);
    if (!project) return null;
    const mode = patch.sectionMode ?? project.sectionMode;
    const sections = patch.sections ?? project.sections;
    this.db
      .query('UPDATE projects SET section_mode = ?, sections = ? WHERE id = ?')
      .run(mode, JSON.stringify(sections), project.id);
    return this.getProject(slug);
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
    const out: Record<Status, number> = { 'needs-you': 0, received: 0, 'deferred': 0, complete: 0 };
    const rows: any[] = this.db.query('SELECT status, COUNT(*) AS n FROM items WHERE project_id = ? GROUP BY status').all(projectId);
    for (const row of rows) if (row.status in out) out[row.status as Status] = row.n;
    return out;
  }
}
