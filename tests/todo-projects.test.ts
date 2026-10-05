// To-do projects (contract v18). A project opts in with `mode: "todo"`; its
// items are to-dos (`kind: "todo"`) holding todo / deferred / complete /
// cancelled, and only they carry `dueAt` (YYYY-MM-DD) and `priority` (p1-p3).
// Every other project behaves exactly as before: no to-do kind, no dates, no
// due/priority grouping, and the whose-move statuses untouched.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { openDb, Store, isDueDate, normaliseDueAt, normalisePriority, statusesFor, STATUSES, STATUS_GROUPS, MOVE_GROUPS } from '../src/db.ts';
import { createHandler } from '../src/app.ts';
import { exportAll, importAll } from '../src/export.ts';
import { auditItems } from '../src/rules.ts';
import { El } from './helpers/page.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

let paths: string[];
let store: Store;
let handler: (req: Request) => Promise<Response>;

function tmpDb(tag: string): string {
  const p = join(tmpdir(), `workbench-todo-${tag}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(p);
  return p;
}

beforeEach(async () => {
  paths = [];
  store = new Store(openDb(tmpDb('main')));
  handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
  expect((await api('POST', '/api/projects', { name: 'Board', key: 'board' })).status).toBe(201);
  expect((await api('POST', '/api/projects', { name: 'List', key: 'list', mode: 'todo' })).status).toBe(201);
});

afterEach(() => {
  for (const p of paths) for (const s of ['', '-wal', '-shm']) { try { rmSync(p + s, { recursive: true }); } catch {} }
});

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await handler(new Request(`http://localhost${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}

const todo = (item: Record<string, unknown> = {}) => api('POST', '/api/projects/list/items', { title: 'Renew the permit', ...item });
const ask = (item: Record<string, unknown> = {}) => api('POST', '/api/projects/board/items', { title: 'Which one?', ...item });

describe('the project mode', () => {
  test('defaults to board, and a board project is unchanged', async () => {
    expect(store.getProject('board')!.mode).toBe('board');
    const item = (await ask()).json.items[0];
    expect([item.kind, item.status]).toEqual(['issue', 'needs-decision']);
    // No to-do fields on a board item: its API shape is what it was.
    expect('dueAt' in item).toBe(false);
    expect('priority' in item).toBe(false);
  });

  test('is set on create, and an unknown mode is refused', async () => {
    expect(store.getProject('list')!.mode).toBe('todo');
    const bad = await api('POST', '/api/projects', { name: 'Odd', mode: 'kanban' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("'board' or 'todo'");
  });

  test('can be switched while the project holds only documents, and the switch is refused once it holds work', async () => {
    await api('POST', '/api/projects', { name: 'Fresh' });
    await api('POST', '/api/projects/fresh/items', { title: 'Notes', kind: 'document', body: '# hi' });
    const on = await api('PATCH', '/api/projects/fresh', { mode: 'todo' });
    expect(on.status).toBe(200);
    expect(on.json.project.mode).toBe('todo');

    await todo();
    const off = await api('PATCH', '/api/projects/list', { mode: 'board' });
    expect(off.status).toBe(409);
    expect(off.json.conflict).toBe('mode');
    expect(off.json.error).toContain('to-do');
    expect(store.getProject('list')!.mode).toBe('todo');

    await ask();
    const toTodo = await api('PATCH', '/api/projects/board', { mode: 'todo' });
    expect(toTodo.status).toBe(409);
    expect(store.getProject('board')!.mode).toBe('board');
  });

  // Review finding 2: the mode used to switch before the key was checked, so
  // a request refused over its key still changed the mode.
  test('a request refused over its key leaves the mode unchanged', async () => {
    await api('POST', '/api/projects', { name: 'Fresh' });
    const res = await api('PATCH', '/api/projects/fresh', { mode: 'todo', key: 'list', name: 'Renamed' });
    expect(res.status).toBe(409);
    const after = store.getProject('fresh')!;
    expect([after.mode, after.key, after.name]).toEqual(['board', null, 'Fresh']);
  });

  test('a request refused over its mode leaves the key and name unchanged', async () => {
    await ask();
    const res = await api('PATCH', '/api/projects/board', { mode: 'todo', key: 'newk', name: 'Renamed' });
    expect(res.status).toBe(409);
    const after = store.getProject('board')!;
    expect([after.mode, after.key, after.name]).toEqual(['board', 'BOARD', 'Board']);
  });

  test('switching back to board resets a due or priority layout', async () => {
    await api('PATCH', '/api/projects/list', { groupBy: 'due', sortBy: 'priority' });
    const res = await api('PATCH', '/api/projects/list', { mode: 'board' });
    expect(res.status).toBe(200);
    expect([res.json.project.groupBy, res.json.project.sortBy]).toEqual(['status', 'activity']);
  });
});

describe('items in a to-do project', () => {
  test('are to-dos at "todo" by default, with dates and priority when sent', async () => {
    const res = await todo({ dueAt: '2026-10-31', priority: 'P1' });
    expect(res.status).toBe(201);
    const item = res.json.items[0];
    expect([item.kind, item.status, item.dueAt, item.priority]).toEqual(['todo', 'todo', '2026-10-31', 'p1']);
    expect(res.json.warnings).toBeUndefined();
    const plain = (await todo({ title: 'Plain' })).json.items[0];
    expect([plain.dueAt, plain.priority]).toEqual([null, null]);
  });

  test('hold only todo, deferred, complete and cancelled', async () => {
    expect(statusesFor('todo')).toEqual(['todo', 'deferred', 'complete', 'cancelled']);
    const id = (await todo()).json.items[0].id;
    for (const s of ['deferred', 'complete', 'cancelled', 'todo']) {
      expect((await api('PATCH', `/api/items/${id}`, { status: s, ifVersion: store.getItem(id)!.version })).json.item.status).toBe(s);
    }
    for (const s of ['needs-decision', 'received', 'in-progress', 'needs-qa', 'blocked']) {
      const res = await api('PATCH', `/api/items/${id}`, { status: s });
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('todo, deferred, complete, cancelled');
    }
    expect((await todo({ status: 'needs-decision' })).status).toBe(400);
  });

  test('a person replying does not move a to-do to received, and an agent reply claims nothing', async () => {
    const id = (await todo()).json.items[0].id;
    await api('POST', `/api/items/${id}/messages`, { who: 'you', text: 'remember the form' });
    expect(store.getItem(id)!.status).toBe('todo');
    await api('POST', `/api/items/${id}/messages`, { who: 'agent', actor: 'bot', text: 'noted' });
    expect(store.getItem(id)!.status).toBe('todo');
    // An explicit status on a message still works, within the to-do set.
    await api('POST', `/api/items/${id}/messages`, { who: 'you', text: 'done', status: 'complete' });
    expect(store.getItem(id)!.status).toBe('complete');
  });

  // Review finding 4: a board status on a to-do's message was dropped with a
  // 201 and no word, where the same status on PATCH is a 400.
  test('a message carrying a board status lands, keeps the to-do where it is, and warns', async () => {
    const id = (await todo()).json.items[0].id;
    const res = await api('POST', `/api/items/${id}/messages`, { who: 'you', text: 'on it', status: 'received' });
    expect(res.status).toBe(201);
    expect(res.json.item.status).toBe('todo');
    expect(res.json.warning).toContain('todo, deferred, complete, cancelled');
    expect(res.json.warning).toContain('"received"');
    // A status the to-do can hold carries no such warning.
    const ok = await api('POST', `/api/items/${id}/messages`, { who: 'you', text: 'done', status: 'complete' });
    expect(ok.json.warning).toBeUndefined();
  });

  test('a document gets the same warning for a status it cannot hold', async () => {
    const id = (await todo({ title: 'Ref', kind: 'document', body: 'x' })).json.items[0].id;
    const res = await api('POST', `/api/items/${id}/messages`, { who: 'agent', actor: 'bot', text: 'done', status: 'complete' });
    expect(res.status).toBe(201);
    expect(res.json.item.status).toBe('active');
    expect(res.json.warning).toContain('active, archived');
  });

  test('a decision cannot be filed on a to-do project, and a to-do cannot be filed on a board', async () => {
    const issue = await todo({ kind: 'issue' });
    expect(issue.status).toBe(400);
    expect(issue.json.error).toContain('to-do project');
    const wrong = await ask({ kind: 'todo' });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toContain('to-do projects');
  });

  test('documents still live on a to-do project, without dates', async () => {
    const doc = await todo({ title: 'Reference', kind: 'document', body: 'notes' });
    expect(doc.status).toBe(201);
    expect([doc.json.items[0].kind, doc.json.items[0].status]).toEqual(['document', 'active']);
    expect('dueAt' in doc.json.items[0]).toBe(false);
    const dated = await todo({ title: 'Dated doc', kind: 'document', dueAt: '2026-10-31' });
    expect(dated.status).toBe(400);
    expect(dated.json.error).toContain('to-dos');
  });

  test('a to-do raises no audit findings and no decision warnings', async () => {
    await todo({ title: 'x' });
    const items = store.listItems(store.getProject('list')!.id);
    expect(auditItems(items).filter((i: any) => i.findings.length)).toEqual([]);
  });
});

describe('dueAt and priority', () => {
  test('on a board item are a 400 that says they belong to to-do projects', async () => {
    for (const body of [{ dueAt: '2026-10-31' }, { priority: 'p1' }]) {
      const res = await ask(body);
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('to-do projects');
    }
    const id = (await ask()).json.items[0].id;
    const patch = await api('PATCH', `/api/items/${id}`, { dueAt: '2026-10-31' });
    expect(patch.status).toBe(400);
    expect(patch.json.error).toContain('to-do projects');
  });

  for (const bad of ['2026-02-30', '2026-13-01', '10/31/2026', '2026-10-31T09:00:00Z', '2026-1-5', 'tomorrow', 20261031, true]) {
    test(`refuses dueAt ${JSON.stringify(bad)} with a 400 naming the shape to send`, async () => {
      const res = await todo({ dueAt: bad });
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('YYYY-MM-DD');
      expect(res.json.error).toContain('null to clear');
    });
  }

  for (const bad of ['p0', 'p4', 'urgent', 'hi', 1, 'P 1']) {
    test(`refuses priority ${JSON.stringify(bad)} with a 400 listing the values`, async () => {
      const res = await todo({ priority: bad });
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('p1, p2, p3');
    });
  }

  test('priority takes the words a person says and stores p1/p2/p3 (v19)', async () => {
    for (const [word, stored] of [['High', 'p1'], ['medium', 'p2'], [' LOW ', 'p3']]) {
      const res = await todo({ priority: word });
      expect(res.status).toBe(201);
      expect(res.json.items[0].priority).toBe(stored);
    }
  });

  test('accepts 29 February only in a leap year', async () => {
    expect((await todo({ dueAt: '2028-02-29' })).status).toBe(201);
    expect((await todo({ dueAt: '2027-02-29' })).status).toBe(400);
  });

  test('a batch with one bad date lands nothing', async () => {
    const res = await api('POST', '/api/projects/list/items', [
      { title: 'fine', dueAt: '2026-11-01' },
      { title: 'broken', dueAt: '2026-11-31' },
    ]);
    expect(res.status).toBe(400);
    expect(store.listItems(store.getProject('list')!.id)).toHaveLength(0);
  });

  test('PATCH sets, keeps when left out, and clears with null or "" — through a ref too', async () => {
    await todo();
    let res = await api('PATCH', '/api/items/WB-LIST-1', { dueAt: '2026-12-01', priority: 'p3' });
    expect([res.json.item.dueAt, res.json.item.priority]).toEqual(['2026-12-01', 'p3']);
    res = await api('PATCH', '/api/items/WB-LIST-1', { title: 'Renew it early' });
    expect([res.json.item.dueAt, res.json.item.priority]).toEqual(['2026-12-01', 'p3']);
    res = await api('PATCH', '/api/items/WB-LIST-1', { dueAt: null, priority: '' });
    expect([res.json.item.dueAt, res.json.item.priority]).toEqual([null, null]);
  });

  test('a bad value on PATCH is refused and the stored one is untouched', async () => {
    const id = (await todo({ dueAt: '2026-10-31', priority: 'p1' })).json.items[0].id;
    expect((await api('PATCH', `/api/items/${id}`, { dueAt: '31 Oct' })).status).toBe(400);
    const item = store.getItem(id)!;
    expect([item.dueAt, item.priority, item.version]).toEqual(['2026-10-31', 'p1', 1]);
  });

  test('never move the status, and a status change leaves them alone', async () => {
    const id = (await todo({ dueAt: '2020-01-01', priority: 'p1' })).json.items[0].id;
    expect(store.getItem(id)!.status).toBe('todo');
    await api('PATCH', `/api/items/${id}`, { status: 'complete', ifVersion: 1 });
    const item = store.getItem(id)!;
    expect([item.status, item.dueAt, item.priority]).toEqual(['complete', '2020-01-01', 'p1']);
  });

  test('turning a to-do into a document drops its dates', async () => {
    const id = (await todo({ dueAt: '2026-10-31', priority: 'p2' })).json.items[0].id;
    const res = await api('PATCH', `/api/items/${id}`, { kind: 'document' });
    expect(res.status).toBe(200);
    expect(res.json.item.kind).toBe('document');
    expect(store.getItem(id)!.dueAt).toBeUndefined();
  });
});

describe('grouping and order', () => {
  test('a to-do project groups and sorts by due or priority', async () => {
    for (const [groupBy, sortBy] of [['due', 'priority'], ['priority', 'due']]) {
      const res = await api('PATCH', '/api/projects/list', { groupBy, sortBy });
      expect(res.status).toBe(200);
      expect([res.json.project.groupBy, res.json.project.sortBy]).toEqual([groupBy, sortBy]);
    }
  });

  test('a board project refuses due and priority layouts', async () => {
    for (const body of [{ groupBy: 'due' }, { sortBy: 'priority' }]) {
      const res = await api('PATCH', '/api/projects/board', body);
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('to-do projects');
    }
    expect((await api('PATCH', '/api/projects/board', { groupBy: 'deadline' })).json.error).toContain("'move'");
  });

  test('every status still lands in exactly one board group', () => {
    for (const groups of [STATUS_GROUPS, MOVE_GROUPS]) {
      const placed = groups.flatMap((g) => g.statuses);
      expect([...placed].sort()).toEqual([...STATUSES].sort());
    }
  });
});

describe('storage', () => {
  test('the validators agree with the contract', () => {
    expect(isDueDate('2026-10-31')).toBe(true);
    expect(isDueDate('2026-04-31')).toBe(false);
    expect(normaliseDueAt('nonsense')).toBeNull();
    expect(normalisePriority(' P1 ')).toBe('p1');
    expect(normalisePriority('p9')).toBeNull();
  });

  test('an old database opens: projects become boards, items keep their kinds', () => {
    const path = tmpDb('legacy');
    const raw = new Database(path, { create: true });
    raw.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT);
      CREATE TABLE items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, context TEXT NOT NULL, options TEXT NOT NULL, choice TEXT NOT NULL, status TEXT NOT NULL, section TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO projects VALUES ('p', 'old', 'Old', '', '2020-01-01T00:00:00.000Z', NULL);
      INSERT INTO items VALUES ('i', 'p', 'q', '', '[]', '', 'received', '', 0, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    `);
    raw.close();
    const migrated = new Store(openDb(path));
    expect(migrated.getProject('old')!.mode).toBe('board');
    const item = migrated.getItem('i')!;
    expect([item.kind, item.status, item.dueAt]).toEqual(['issue', 'received', undefined]);
    const again = new Store(openDb(path));
    expect(again.getItem('i')!.status).toBe('received');
  });

  test('a to-do whose stored status or dates are malformed reads safely', () => {
    const path = tmpDb('handedit');
    const s = new Store(openDb(path));
    const project = s.createProject({ name: 'Hand', mode: 'todo' });
    const id = s.createItem(project.id, { title: 'x' }).id;
    const raw = new Database(path);
    raw.query("UPDATE items SET due_at = '31/10/2026', priority = 'urgent', status = 'received' WHERE id = ?").run(id);
    raw.close();
    const reopened = new Store(openDb(path));
    const item = reopened.getItem(id)!;
    expect([item.status, item.dueAt, item.priority]).toEqual(['todo', null, null]);
  });

  test('export and import round-trip the mode, the to-dos and their dates', async () => {
    await todo({ dueAt: '2026-10-31', priority: 'p1' });
    await todo({ title: 'Undated', status: 'deferred' });
    await ask();
    await api('PATCH', '/api/projects/list', { groupBy: 'due', sortBy: 'priority' });
    const dir = mkdtempSync(join(tmpdir(), 'wb-todo-export-'));
    paths.push(dir);
    exportAll(store, dir);
    expect(readFileSync(join(dir, 'list.json'), 'utf8')).toContain('"dueAt": "2026-10-31"');
    expect(readFileSync(join(dir, 'board.json'), 'utf8')).not.toContain('dueAt');

    const target = new Store(openDb(tmpDb('target')));
    importAll(target, dir, () => {});
    const list = target.getProject('list')!;
    expect([list.mode, list.groupBy, list.sortBy]).toEqual(['todo', 'due', 'priority']);
    const items = target.listItems(list.id);
    const dated = items.find((i) => i.title === 'Renew the permit')!;
    expect([dated.kind, dated.status, dated.dueAt, dated.priority]).toEqual(['todo', 'todo', '2026-10-31', 'p1']);
    expect(items.find((i) => i.title === 'Undated')!.status).toBe('deferred');
    expect(target.getProject('board')!.mode).toBe('board');

    // An older export (no mode, no dates) and a bad value in a file both import.
    const file = join(dir, 'list.json');
    const old = JSON.parse(readFileSync(file, 'utf8'));
    old.items.push({ ...old.items[0], title: 'Bad date in file', dueAt: 'next week', priority: 'p7', seq: 99 });
    writeFileSync(file, JSON.stringify(old));
    const boardFile = join(dir, 'board.json');
    const oldBoard = JSON.parse(readFileSync(boardFile, 'utf8'));
    delete oldBoard.project.mode;
    writeFileSync(boardFile, JSON.stringify(oldBoard));
    const fresh = new Store(openDb(tmpDb('fresh')));
    importAll(fresh, dir, () => {});
    const bad = fresh.listItems(fresh.getProject('list')!.id).find((i) => i.title === 'Bad date in file')!;
    expect([bad.dueAt, bad.priority]).toEqual([null, null]);
    expect(fresh.getProject('board')!.mode).toBe('board');
  });
});

// Review finding 3: import is idempotent by slug, so a to-do list restored
// into an existing board of the same slug had its to-dos turned into
// decisions. A mode mismatch now skips that project's items, and says so.
describe('import into a project of the other mode', () => {
  async function exported(): Promise<string> {
    await todo({ dueAt: '2026-10-31', priority: 'p1' });
    await ask();
    const dir = mkdtempSync(join(tmpdir(), 'wb-todo-mismatch-'));
    paths.push(dir);
    exportAll(store, dir);
    return dir;
  }

  test('to-dos are not restored into a board, and the log says why', async () => {
    const dir = await exported();
    const target = new Store(openDb(tmpDb('mismatch')));
    target.createProject({ name: 'List' });                // a board with the same slug
    const lines: string[] = [];
    importAll(target, dir, (l) => lines.push(l));
    const list = target.getProject('list')!;
    expect(list.mode).toBe('board');
    expect(target.listItems(list.id)).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/list\.json: skipped.*mode/);
    // The other project in the same export still restores.
    expect(target.listItems(target.getProject('board')!.id)).toHaveLength(1);
  });

  test('board items are not restored into a to-do list either', async () => {
    const dir = await exported();
    const target = new Store(openDb(tmpDb('mismatch2')));
    target.createProject({ name: 'Board', mode: 'todo' });
    const lines: string[] = [];
    importAll(target, dir, (l) => lines.push(l));
    expect(target.listItems(target.getProject('board')!.id)).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/board\.json: skipped.*mode/);
  });
});

// The page's own helpers, run from public/app.js itself. The file only touches
// `document` inside functions, so loading it needs nothing but a `window`.
describe('due bands and ordering on the page (public/app.js)', () => {
  const win: any = {};
  new Function('window', readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'))(win);
  const WB = win.WB;
  const TODAY = '2026-10-04';

  test('bands by whole days from today: overdue, 3, 7, 30, later', () => {
    const cases: [string, string][] = [
      ['2025-12-31', 'overdue'], ['2026-10-03', 'overdue'],
      ['2026-10-04', 'd3'], ['2026-10-07', 'd3'],
      ['2026-10-08', 'd7'], ['2026-10-11', 'd7'],
      ['2026-10-12', 'd30'], ['2026-11-03', 'd30'],
      ['2026-11-04', 'later'],
    ];
    for (const [due, band] of cases) expect([due, WB.dueBand(due, TODAY)]).toEqual([due, band]);
    expect(WB.dueBand(null, TODAY)).toBeNull();
    expect(WB.dueBand('garbage', TODAY)).toBeNull();
  });

  test('counts calendar days across a daylight-saving change', () => {
    expect(WB.daysUntil('2026-03-15', '2026-03-08')).toBe(7);
    expect(WB.daysUntil('2026-11-08', '2026-11-01')).toBe(7);
  });

  test('the chip words say the band, not only its colour', () => {
    expect(WB.dueText('2026-10-02', TODAY)).toBe('Overdue 2d');
    expect(WB.dueText('2026-10-04', TODAY)).toBe('Due today');
    expect(WB.dueText('2026-10-05', TODAY)).toBe('Due tomorrow');
    expect(WB.dueText('2026-10-10', TODAY)).toBe('Due in 6d');
    expect(WB.dueText('2026-12-25', TODAY)).toMatch(/^Due /);
  });

  test('the due order breaks ties by priority, like wb todos', () => {
    const rows = [
      { id: 'undated-low', priority: 'p3' },
      { id: 'today-low', dueAt: '2026-10-05', priority: 'p3' },
      { id: 'undated-high', priority: 'p1' },
      { id: 'today-high', dueAt: '2026-10-05', priority: 'p1' },
      { id: 'undated-none' },
      { id: 'later', dueAt: '2026-10-09' },
    ];
    expect([...rows].sort(WB.byDueThenPriority).map((r) => r.id))
      .toEqual(['today-high', 'today-low', 'later', 'undated-high', 'undated-low', 'undated-none']);
  });

  test("today is the viewer's local calendar day", () => {
    expect(WB.localToday(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(WB.localToday(new Date(2026, 11, 31, 0, 1))).toBe('2026-12-31');
  });

  test('sorts soonest due first and undated last; priority p1 first, ties by due', () => {
    const rows = [
      { id: 'none' },
      { id: 'late', dueAt: '2026-12-01', priority: 'p1' },
      { id: 'soon', dueAt: '2026-10-05', priority: 'p3' },
      { id: 'mid', dueAt: '2026-10-20', priority: 'p1' },
      { id: 'p2', priority: 'p2' },
    ];
    expect([...rows].sort(WB.byDue).map((r) => r.id).slice(0, 3)).toEqual(['soon', 'mid', 'late']);
    expect([...rows].sort(WB.byPriority).map((r) => r.id)).toEqual(['mid', 'late', 'p2', 'soon', 'none']);
  });

  test('knows the to-do status set, and only an open to-do is banded', () => {
    expect(WB.statusesFor('todo')).toEqual(['todo', 'deferred', 'complete', 'cancelled']);
    expect(WB.statusesFor('issue')).not.toContain('todo');
    expect(WB.DUE_BANDED_STATUSES).toEqual(['todo']);
    expect(WB.DUE_BANDS.map((b: any) => b.id)).toEqual(['overdue', 'd3', 'd7', 'd30', 'later']);
  });

  // What the board and to-do pages actually draw is in tests/board-render.test.ts.

  test('every band has its own style, and every due token is set in each of the three theme blocks', () => {
    const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
    for (const band of ['overdue', 'd3', 'd7', 'd30', 'later', 'settled']) expect(css).toContain(`.due.b-${band}`);
    // The body of the first rule whose selector starts at `marker`.
    const block = (marker: string) => {
      const at = css.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      const open = css.indexOf('{', at + marker.length - 1);
      return css.slice(open + 1, css.indexOf('}', open));
    };
    const blocks = {
      light: block(':root {'),
      systemDark: block(':root:not([data-theme="light"]) {'),
      forcedDark: block(':root[data-theme="dark"] {'),
    };
    for (const [name, body] of Object.entries(blocks)) {
      for (const token of ['--due-over', '--due-3', '--due-3-soft', '--due-7', '--due-7-soft', '--due-30']) {
        expect([name, token, new RegExp(`${token}:`).test(body)]).toEqual([name, token, true]);
      }
    }
  });
});

// Review finding 5: the date field saved on every `change`, and a browser
// fires change for each valid date it passes through while a year is typed
// (0002, 0020, 0202, 2026), with the saves unordered. It now commits on blur
// or Enter, only when the value moved, and saves for one item go one at a time.
describe('saving a due date from the page', () => {
  const doc = { createElement: (t: string) => new El(t), createTextNode: (t: string) => { const n = new El('#text'); n.textContent = t; return n; } };
  function load(fetchFn: any) {
    const win: any = {};
    new Function('window', 'document', 'fetch', readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'))(win, doc, fetchFn);
    return win.WB;
  }

  test('typing a year saves nothing until the field is left, then saves once', () => {
    const WB = load(async () => new Response('{}'));
    const saves: any[] = [];
    const bar = WB.planControls({ id: 'x', dueAt: null, priority: null }, (patch: any) => saves.push(patch));
    const date = bar.all().find((e: El) => e.type === 'date')!;
    for (const v of ['0002-10-31', '0020-10-31', '0202-10-31', '2026-10-31']) {
      date.value = v;
      date.dispatchEvent({ type: 'change' });
      date.dispatchEvent({ type: 'input' });
    }
    expect(saves).toEqual([]);
    date.dispatchEvent({ type: 'blur' });
    expect(saves).toEqual([{ dueAt: '2026-10-31' }]);
    // Leaving it again unchanged is not another write; Enter commits too.
    date.dispatchEvent({ type: 'blur' });
    date.value = '';
    date.dispatchEvent({ type: 'keydown', key: 'Enter' } as any);
    expect(saves).toEqual([{ dueAt: '2026-10-31' }, { dueAt: null }]);
  });

  test('the priority select still saves on change', () => {
    const WB = load(async () => new Response('{}'));
    const saves: any[] = [];
    const bar = WB.planControls({ id: 'x', dueAt: null, priority: null }, (patch: any) => saves.push(patch));
    const sel = bar.all().find((e: El) => e.tagName === 'SELECT')!;
    sel.value = 'p2';
    sel.dispatchEvent({ type: 'change' });
    expect(saves).toEqual([{ priority: 'p2' }]);
  });

  test('saves for one item are sent one at a time, in order; other items do not wait', async () => {
    const sent: string[] = [];
    const release: Record<string, () => void> = {};
    const fetchFn = (url: string, init: any) => {
      const body = JSON.parse(init.body);
      sent.push(`${url} ${body.dueAt}`);
      return new Promise<Response>((resolve) => { release[`${url} ${body.dueAt}`] = () => resolve(new Response(JSON.stringify({ ok: true }))); });
    };
    const WB = load(fetchFn);
    const first = WB.serialPatch('a', '/api/items/a', { dueAt: '2026-10-01' });
    const second = WB.serialPatch('a', '/api/items/a', { dueAt: '2026-10-31' });
    WB.serialPatch('b', '/api/items/b', { dueAt: '2026-12-01' });
    await Promise.resolve(); await Promise.resolve();
    // The second save for "a" has not been sent while the first is in flight.
    expect(sent).toEqual(['/api/items/a 2026-10-01', '/api/items/b 2026-12-01']);
    release['/api/items/a 2026-10-01']();
    await first;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(sent).toEqual(['/api/items/a 2026-10-01', '/api/items/b 2026-12-01', '/api/items/a 2026-10-31']);
    release['/api/items/a 2026-10-31']();
    await second;
  });

  test('both pages save the date through the per-item queue', () => {
    for (const page of ['project.html', 'item.html']) {
      const html = readFileSync(new URL(`../public/${page}`, import.meta.url), 'utf8');
      expect([page, html.includes('WB.serialPatch(')]).toEqual([page, true]);
    }
  });
});

