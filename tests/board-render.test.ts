// The board page rendered for real: its own scripts, its own group tables,
// against the real handler. Review on the to-do PR found open to-dos missing
// from a new to-do project's default layout because the page kept a stale
// copy of the group tables; a test of the server's tables, or a grep of the
// page source, could not see that. This one counts the rows the page draws.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, Store, STATUS_GROUPS, MOVE_GROUPS } from '../src/db.ts';
import { createHandler } from '../src/app.ts';
import { renderPage, type El } from './helpers/page.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

let dbPath: string;
let store: Store;
let handler: (req: Request) => Promise<Response>;

beforeEach(() => {
  dbPath = join(tmpdir(), `workbench-render-${Math.random().toString(36).slice(2)}.db`);
  store = new Store(openDb(dbPath));
  handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
  const board = store.createProject({ name: 'Board', key: 'BD' });
  store.createItem(board.id, { title: 'Pick a vendor', options: ['A', 'B'], recommended: ['A'] });
  store.createItem(board.id, { title: 'Ship the fix', status: 'in-progress' });
  const list = store.createProject({ name: 'Errands', key: 'ERR', mode: 'todo' });
  store.createItem(list.id, { title: 'Renew the permit', dueAt: '2026-10-01', priority: 'p1' });
  store.createItem(list.id, { title: 'Buy stamps' });
  store.createItem(list.id, { title: 'Paid the bill', status: 'complete' });
});

afterEach(() => { for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s); } catch {} } });

const titles = (items: El) => items.byClass('lr-title').map((t) => t.textContent);
const heads = (items: El) => items.byClass('sec-head').map((h) => h.children[0].textContent);

describe('a to-do project renders its open to-dos', () => {
  for (const groupBy of ['status', 'move', 'section', 'due', 'priority']) {
    test(`on the ${groupBy} layout`, async () => {
      store.setProjectSections('errands', { groupBy: groupBy as any });
      const page = await renderPage(handler, 'project.html', '/p/errands');
      const items = page.byId('items');
      // Complete is hidden by default; both open to-dos must be on screen.
      expect(titles(items).sort()).toEqual(['Buy stamps', 'Renew the permit']);
      if (groupBy === 'status') expect(heads(items)).toEqual(['Open']);
      if (groupBy === 'move') expect(heads(items)).toEqual(['Your move']);
      if (groupBy === 'due') expect(heads(items)).toEqual(['Overdue', 'No due date']);
      if (groupBy === 'priority') expect(heads(items)).toEqual(['High', 'No priority']);
    });
  }

  test('shows the to-do chips and the to-do filters, and counts what is left', async () => {
    const page = await renderPage(handler, 'project.html', '/p/errands');
    const items = page.byId('items');
    expect(items.byClass('prio').map((c) => c.textContent)).toEqual(['High']);
    expect(items.byClass('due').length).toBe(1);
    expect(page.byId('eyebrow').textContent).toBe('2 to do · 3 items');
    expect(page.byId('filters').byClass('filterset-label').map((l) => l.textContent)).toContain('To-dos');
    expect(page.byId('idue').hidden).toBe(false);
  });
});

describe('a board project renders exactly as a board', () => {
  test('rows, groups and filters, with no to-do controls anywhere', async () => {
    const page = await renderPage(handler, 'project.html', '/p/board');
    const items = page.byId('items');
    expect(titles(items).sort()).toEqual(['Pick a vendor', 'Ship the fix']);
    expect(heads(items)).toEqual(['Open']);
    expect(items.byClass('due').length + items.byClass('prio').length + items.byClass('planbar').length).toBe(0);
    const filters = page.byId('filters');
    expect(filters.byClass('filterset-label').map((l) => l.textContent)).toEqual(['Work', 'Documents']);
    expect(filters.all().some((b) => b.textContent.startsWith('To do'))).toBe(false);
    expect(page.byId('idue').hidden).toBe(true);
    expect(page.byId('ipriority').hidden).toBe(true);
    // The layout selects offer no due or priority option on a board.
    for (const sel of ['set-groupBy', 'set-sortBy']) {
      const offered = page.byId(sel).options.filter((o) => !o.hidden).map((o) => o.value);
      expect(offered).not.toContain('due');
      expect(offered).not.toContain('priority');
    }
    expect(page.byId('eyebrow').textContent).toContain('waiting on you');
  });
});

describe('the page uses the server group tables', () => {
  test('/groups.js serves exactly STATUS_GROUPS and MOVE_GROUPS', async () => {
    const res = await handler(new Request('http://localhost/groups.js'));
    expect(res.status).toBe(200);
    const win: any = {};
    new Function('window', await res.text())(win);
    expect(win.WB_GROUPS.status).toEqual(STATUS_GROUPS);
    expect(win.WB_GROUPS.move).toEqual(MOVE_GROUPS);
  });
});
