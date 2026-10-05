// Optional due dates and priorities on items (contract v18). `dueAt` is a
// calendar day, YYYY-MM-DD; `priority` is p1, p2, p3 or null. Both are purely
// additive: settable on create and PATCH, returned everywhere an item is,
// carried through export and import, and neither ever moves the status. The
// board's due bands are computed on the page (public/app.js), so they are
// tested here by running that file, not a copy of it.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { openDb, Store, isDueDate, normaliseDueAt, normalisePriority } from '../src/db.ts';
import { createHandler } from '../src/app.ts';
import { exportAll, importAll } from '../src/export.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

let paths: string[];
let store: Store;
let handler: (req: Request) => Promise<Response>;

function tmpDb(tag: string): string {
  const p = join(tmpdir(), `workbench-due-${tag}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(p);
  return p;
}

beforeEach(async () => {
  paths = [];
  store = new Store(openDb(tmpDb('main')));
  handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
  expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
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

const create = (item: Record<string, unknown>) => api('POST', '/api/projects/demo/items', { title: 'Renew the permit', status: 'received', ...item });

describe('creating an item', () => {
  test('carries dueAt and priority when sent', async () => {
    const res = await create({ dueAt: '2026-10-31', priority: 'p1' });
    expect(res.status).toBe(201);
    expect(res.json.items[0].dueAt).toBe('2026-10-31');
    expect(res.json.items[0].priority).toBe('p1');
    expect(res.json.ignored).toBeUndefined();
  });

  test('leaves both null when not sent, so older writers see no change', async () => {
    const res = await create({});
    expect(res.json.items[0].dueAt).toBeNull();
    expect(res.json.items[0].priority).toBeNull();
    expect(res.json.warnings).toBeUndefined();
  });

  test('reads a priority case-insensitively and stores it lowercase', async () => {
    const res = await create({ priority: 'P2' });
    expect(res.status).toBe(201);
    expect(res.json.items[0].priority).toBe('p2');
  });

  for (const bad of ['2026-02-30', '2026-13-01', '10/31/2026', '2026-10-31T09:00:00Z', '2026-1-5', 'tomorrow', 20261031, true]) {
    test(`refuses dueAt ${JSON.stringify(bad)} with a 400 naming the shape to send`, async () => {
      const res = await create({ dueAt: bad });
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('YYYY-MM-DD');
      expect(res.json.error).toContain('null to clear');
    });
  }

  for (const bad of ['p0', 'p4', 'high', 1, 'P 1']) {
    test(`refuses priority ${JSON.stringify(bad)} with a 400 listing the values`, async () => {
      const res = await create({ priority: bad });
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('p1, p2, p3');
    });
  }

  test('a batch with one bad date lands nothing', async () => {
    const res = await api('POST', '/api/projects/demo/items', [
      { title: 'fine', dueAt: '2026-11-01' },
      { title: 'broken', dueAt: '2026-11-31' },
    ]);
    expect(res.status).toBe(400);
    expect(store.listItems(store.getProject('demo')!.id)).toHaveLength(0);
  });

  test('accepts 29 February only in a leap year', async () => {
    expect((await create({ dueAt: '2028-02-29' })).status).toBe(201);
    expect((await create({ dueAt: '2027-02-29' })).status).toBe(400);
  });
});

describe('changing an item', () => {
  test('PATCH sets, keeps when left out, and clears with null or ""', async () => {
    const id = (await create({})).json.items[0].id;
    let res = await api('PATCH', `/api/items/${id}`, { dueAt: '2026-12-01', priority: 'p3' });
    expect(res.status).toBe(200);
    expect([res.json.item.dueAt, res.json.item.priority]).toEqual(['2026-12-01', 'p3']);

    res = await api('PATCH', `/api/items/${id}`, { title: 'Renew the permit early' });
    expect([res.json.item.dueAt, res.json.item.priority]).toEqual(['2026-12-01', 'p3']);

    res = await api('PATCH', `/api/items/${id}`, { dueAt: null });
    expect(res.json.item.dueAt).toBeNull();
    expect(res.json.item.priority).toBe('p3');

    res = await api('PATCH', `/api/items/${id}`, { priority: '' });
    expect(res.json.item.priority).toBeNull();
  });

  test('a bad value on PATCH is refused and the stored one is untouched', async () => {
    const id = (await create({ dueAt: '2026-10-31', priority: 'p1' })).json.items[0].id;
    const res = await api('PATCH', `/api/items/${id}`, { dueAt: '31 Oct', priority: 'urgent' });
    expect(res.status).toBe(400);
    const item = store.getItem(id)!;
    expect([item.dueAt, item.priority, item.version]).toEqual(['2026-10-31', 'p1', 1]);
  });

  test('works through a ref, like every other item route', async () => {
    await create({});
    const res = await api('PATCH', '/api/items/WB-DEMO-1', { dueAt: '2027-01-15' });
    expect(res.status).toBe(200);
    expect(res.json.item.dueAt).toBe('2027-01-15');
  });

  test('setting either never moves the status', async () => {
    const id = (await create({ status: 'in-progress' })).json.items[0].id;
    const res = await api('PATCH', `/api/items/${id}`, { dueAt: '2020-01-01', priority: 'p1' });
    expect(res.json.item.status).toBe('in-progress');
    // A due date long past is still only a highlight, never a status change.
    expect(store.getItem(id)!.status).toBe('in-progress');
  });

  test('a status change, a reply and a check leave both alone', async () => {
    const id = (await create({ dueAt: '2026-10-31', priority: 'p2', checks: [{ label: 'one' }] })).json.items[0].id;
    await api('PATCH', `/api/items/${id}`, { status: 'needs-qa', ifVersion: 1 });
    await api('POST', `/api/items/${id}/messages`, { who: 'you', text: 'looks fine' });
    await api('PATCH', `/api/items/${id}/checks/c1`, { result: 'pass', actor: 'tester' });
    const item = store.getItem(id)!;
    expect([item.dueAt, item.priority]).toEqual(['2026-10-31', 'p2']);
  });

  test('a decision with a deadline still needs its recommendation like any other', async () => {
    const res = await create({ status: 'needs-decision', options: ['A', 'B'], recommended: ['A'], dueAt: '2026-10-10' });
    expect(res.status).toBe(201);
    expect(res.json.warnings).toBeUndefined();
    expect(res.json.items[0].dueAt).toBe('2026-10-10');
  });
});

describe('reading', () => {
  test('board rows carry both fields', async () => {
    await create({ dueAt: '2026-10-31', priority: 'p1' });
    await create({ title: 'Plain one' });
    const res = await api('GET', '/api/projects/demo?messages=none');
    const rows = res.json.items.map((i: any) => [i.title, i.dueAt, i.priority]);
    expect(rows).toEqual(expect.arrayContaining([
      ['Renew the permit', '2026-10-31', 'p1'],
      ['Plain one', null, null],
    ]));
  });
});

describe('project grouping and order', () => {
  test('groupBy and sortBy accept due and priority', async () => {
    for (const [groupBy, sortBy] of [['due', 'priority'], ['priority', 'due']]) {
      const res = await api('PATCH', '/api/projects/demo', { groupBy, sortBy });
      expect(res.status).toBe(200);
      expect([res.json.project.groupBy, res.json.project.sortBy]).toEqual([groupBy, sortBy]);
      expect([store.getProject('demo')!.groupBy, store.getProject('demo')!.sortBy]).toEqual([groupBy, sortBy]);
    }
  });

  test('an unknown value is still refused, naming every allowed one', async () => {
    const g = await api('PATCH', '/api/projects/demo', { groupBy: 'deadline' });
    expect(g.status).toBe(400);
    expect(g.json.error).toContain("'due'");
    const s = await api('PATCH', '/api/projects/demo', { sortBy: 'urgency' });
    expect(s.status).toBe(400);
    expect(s.json.error).toContain("'priority'");
  });
});

describe('storage', () => {
  test('the validators agree with the contract', () => {
    expect(isDueDate('2026-10-31')).toBe(true);
    expect(isDueDate('2026-04-31')).toBe(false);
    expect(isDueDate(' 2026-10-31')).toBe(false);
    expect(normaliseDueAt('nonsense')).toBeNull();
    expect(normalisePriority(' P1 ')).toBe('p1');
    expect(normalisePriority('p9')).toBeNull();
  });

  test('an old database without the columns opens and gains them', () => {
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
    const item = migrated.getItem('i')!;
    expect([item.dueAt, item.priority, item.title]).toEqual([null, null, 'q']);
    expect(migrated.updateItem('i', { dueAt: '2026-10-31', priority: 'p2' })!.dueAt).toBe('2026-10-31');
    // Opening it a second time is a no-op, not a second ALTER.
    const again = new Store(openDb(path));
    expect(again.getItem('i')!.priority).toBe('p2');
  });

  test('a malformed stored value reads as none rather than breaking the row', () => {
    const path = tmpDb('handedit');
    const s = new Store(openDb(path));
    const project = s.createProject({ name: 'Hand' });
    const id = s.createItem(project.id, { title: 'x' }).id;
    const raw = new Database(path);
    raw.query("UPDATE items SET due_at = '31/10/2026', priority = 'urgent' WHERE id = ?").run(id);
    raw.close();
    const item = s.getItem(id)!;
    expect([item.dueAt, item.priority]).toEqual([null, null]);
  });

  test('export carries both fields and import restores them; an older export imports without them', async () => {
    await create({ dueAt: '2026-10-31', priority: 'p1' });
    await create({ title: 'Undated' });
    await api('PATCH', '/api/projects/demo', { groupBy: 'due', sortBy: 'priority' });
    const dir = mkdtempSync(join(tmpdir(), 'wb-due-export-'));
    paths.push(dir);
    exportAll(store, dir);
    const file = join(dir, 'demo.json');
    expect(readFileSync(file, 'utf8')).toContain('"dueAt": "2026-10-31"');

    const target = new Store(openDb(tmpDb('target')));
    importAll(target, dir, () => {});
    const restored = target.getProject('demo')!;
    expect([restored.groupBy, restored.sortBy]).toEqual(['due', 'priority']);
    const items = target.listItems(restored.id);
    const dated = items.find((i) => i.title === 'Renew the permit')!;
    expect([dated.dueAt, dated.priority]).toEqual(['2026-10-31', 'p1']);
    expect(items.find((i) => i.title === 'Undated')!.dueAt).toBeNull();

    // An export written before these fields existed, plus a bad value in the
    // file: both import, the bad value as none, rather than losing the item.
    const old = JSON.parse(readFileSync(file, 'utf8'));
    for (const item of old.items) { delete item.dueAt; delete item.priority; }
    old.items.push({ ...old.items[0], title: 'Bad date in file', dueAt: 'next week', priority: 'p7', seq: 99 });
    writeFileSync(file, JSON.stringify(old));
    const fresh = new Store(openDb(tmpDb('fresh')));
    importAll(fresh, dir, () => {});
    const back = fresh.listItems(fresh.getProject('demo')!.id);
    expect(back).toHaveLength(3);
    for (const item of back) expect([item.dueAt, item.priority]).toEqual([null, null]);
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
      ['2025-12-31', 'overdue'],
      ['2026-10-03', 'overdue'],
      ['2026-10-04', 'd3'],
      ['2026-10-07', 'd3'],
      ['2026-10-08', 'd7'],
      ['2026-10-11', 'd7'],
      ['2026-10-12', 'd30'],
      ['2026-11-03', 'd30'],
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
    expect([...rows].sort(WB.byDue).slice(3).every((r: any) => !r.dueAt)).toBe(true);
    expect([...rows].sort(WB.byPriority).map((r) => r.id)).toEqual(['mid', 'late', 'p2', 'soon', 'none']);
  });

  test('the board offers a group per band, then no date, then the usual tail', () => {
    const page = readFileSync(new URL('../public/project.html', import.meta.url), 'utf8');
    expect(page).toContain("groupBy === 'due' || groupBy === 'priority'");
    expect(page).toContain("label: 'No due date'");
    expect(page).toContain("label: 'No priority'");
    expect(page).toContain('STATUS_GROUPS.slice(1)');
    expect(WB.DUE_BANDS.map((b: any) => b.id)).toEqual(['overdue', 'd3', 'd7', 'd30', 'later']);
    // Only live work is banded; it is the same set as the Open group.
    expect(WB.LIVE_STATUSES).toEqual(['needs-decision', 'needs-qa', 'received', 'in-progress', 'blocked']);
  });

  test('every band has its own style in both themes', () => {
    const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
    for (const band of ['overdue', 'd3', 'd7', 'd30', 'later', 'settled']) expect(css).toContain(`.due.b-${band}`);
    for (const token of ['--due-over', '--due-3', '--due-7', '--due-30']) {
      // Light :root, the prefers-color-scheme dark block and the explicit dark theme.
      expect(css.split(`${token}:`).length - 1).toBeGreaterThanOrEqual(3);
    }
  });
});
