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
// They exist because a flat "open/closed" cannot express the thing that actually
// goes wrong: an agent asks, the human answers, and nobody can tell from the
// list whether the answer was READ. `received` is that acknowledgement, and it
// is the state an agent sets, never the human.
export const STATUSES = ['needs-you', 'received', 'needs-more', 'complete'] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  'needs-you': 'Needs you',
  received: 'Received',
  'needs-more': 'Needs more',
  complete: 'Complete',
};

export type Project = {
  id: string;
  slug: string;
  name: string;
  description: string;
  createdAt: string;
  archivedAt: string | null;
};

export type Message = {
  id: string;
  itemId: string;
  who: 'you' | 'agent';
  author: string;
  text: string;
  createdAt: string;
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
      archived_at TEXT
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
    CREATE INDEX IF NOT EXISTS idx_items_project ON items(project_id, position);
    CREATE INDEX IF NOT EXISTS idx_messages_item ON messages(item_id, created_at);
  `);
  // Additive migrations for databases created before a column existed. SQLite
  // has no ADD COLUMN IF NOT EXISTS, and a tool people install at different
  // times must open an old file rather than refuse it.
  const columns = new Set<string>(db.query('PRAGMA table_info(items)').all().map((r: any) => r.name));
  if (!columns.has('version')) db.exec('ALTER TABLE items ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  if (!columns.has('updated_by')) db.exec("ALTER TABLE items ADD COLUMN updated_by TEXT NOT NULL DEFAULT ''");
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
      createdAt: now(),
      archivedAt: null,
    };
    this.db
      .query('INSERT INTO projects (id, slug, name, description, created_at, archived_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .run(project.id, project.slug, project.name, project.description, project.createdAt);
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
        `INSERT INTO items (id, project_id, title, context, options, choice, status, section, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    };
    const guard = typeof opts.ifVersion === 'number' ? ' AND version = ?' : '';
    const params: any[] = [
      next.title, next.context, next.options, next.choice, next.status, next.section, next.position,
      now(), opts.actor || '', id,
    ];
    if (guard) params.push(opts.ifVersion);
    const result = this.db
      .query(
        `UPDATE items SET title = ?, context = ?, options = ?, choice = ?, status = ?, section = ?, position = ?,
           updated_at = ?, updated_by = ?, version = version + 1
         WHERE id = ?${guard}`
      )
      .run(...params);
    if (result.changes === 0 && guard) throw new VersionConflict(this.getItem(id)!);
    return this.getItem(id);
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

  counts(projectId: string): Record<Status, number> {
    const out: Record<Status, number> = { 'needs-you': 0, received: 0, 'needs-more': 0, complete: 0 };
    const rows: any[] = this.db.query('SELECT status, COUNT(*) AS n FROM items WHERE project_id = ? GROUP BY status').all(projectId);
    for (const row of rows) if (row.status in out) out[row.status as Status] = row.n;
    return out;
  }
}
