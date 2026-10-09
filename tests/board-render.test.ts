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
import { rmSync, readFileSync } from 'fs';

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

// Due highlighting as the page draws it: each band's row class and chip, the
// overdue mark, and nothing on a settled to-do or on a board. Dates are set
// from the machine's own today, as the page measures them.
describe('a to-do list highlights each due band on the row and the chip', () => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const rowFor = (items: El, title: string) => items.byClass('listrow').find((r) => r.byClass('lr-title')[0]?.textContent === title)!;

  test('overdue, today, tomorrow, within a week, later, no date, and a deferred one', async () => {
    const list = store.createProject({ name: 'Bands', key: 'BND', mode: 'todo' });
    const cases: [string, number | null, string, string | null, string | null][] = [
      // title, offset, status, row band class, chip text
      ['Late', -2, 'todo', 'due-overdue', '!Overdue 2d'],
      ['Today', 0, 'todo', 'due-today', 'Due today'],
      ['Tomorrow', 1, 'todo', 'due-tomorrow', 'Due tomorrow'],
      ['Six days', 6, 'todo', null, 'Due in 6d'],
      ['Seven days', 7, 'todo', null, 'Due in 7d'],
      ['Undated', null, 'todo', null, null],
      ['Parked', -5, 'deferred', null, null],
    ];
    for (const [title, offset, status] of cases) {
      store.createItem(list.id, { title, status: status as any, ...(offset === null ? {} : { dueAt: day(offset) }) });
    }
    const page = await renderPage(handler, 'project.html', '/p/bands');
    const items = page.byId('items');
    for (const [title, offset, , rowBand, text] of cases) {
      const row = rowFor(items, title);
      expect([title, Boolean(row)]).toEqual([title, true]);
      const bandClasses = row.className.split(/\s+/).filter((c) => c.startsWith('due-'));
      expect([title, bandClasses]).toEqual([title, rowBand ? [rowBand] : []]);
      const chip = row.byClass('due')[0];
      if (offset === null) { expect([title, chip]).toEqual([title, undefined]); continue; }
      if (text) expect([title, chip.textContent]).toEqual([title, text]);
    }
    const chipClass = (title: string) => rowFor(items, title).byClass('due')[0].className;
    expect(chipClass('Late')).toContain('b-overdue');
    expect(rowFor(items, 'Late').byClass('due-mark').map((m) => [m.textContent, m.getAttribute('aria-hidden')])).toEqual([['!', 'true']]);
    expect(chipClass('Today')).toContain('b-today');
    expect(chipClass('Tomorrow')).toContain('b-tomorrow');
    expect(chipClass('Six days')).toContain('b-week');
    expect(chipClass('Seven days')).toContain('b-later');
    // A parked to-do shows its date plainly: no band, no mark, no "Overdue".
    expect(chipClass('Parked')).toContain('b-settled');
    expect(rowFor(items, 'Parked').textContent).not.toContain('Overdue');
    expect(rowFor(items, 'Parked').byClass('due-mark')).toHaveLength(0);
  });

  test('the due layout groups by the same bands', async () => {
    const list = store.createProject({ name: 'Bands', key: 'BND', mode: 'todo' });
    for (const [title, offset] of [['a', -1], ['b', 0], ['c', 1], ['d', 3], ['e', 30]] as const) {
      store.createItem(list.id, { title, dueAt: day(offset) });
    }
    store.createItem(list.id, { title: 'f' });
    store.setProjectSections('bands', { groupBy: 'due' as any });
    const page = await renderPage(handler, 'project.html', '/p/bands');
    expect(heads(page.byId('items'))).toEqual(['Overdue', 'Due today', 'Due tomorrow', 'Due within a week', 'Due later', 'No due date']);
  });

  test('a complete or cancelled to-do that was due last week shows its date plainly', async () => {
    const page = await renderPage(handler, 'project.html', '/p/errands');
    const WB = page.win.WB;
    for (const status of ['complete', 'cancelled', 'deferred']) {
      const chip = WB.dueChip({ status, dueAt: day(-7) }, WB.localToday());
      expect([status, chip.className.includes('b-settled'), chip.textContent.startsWith('Due '), chip.byClass('due-mark').length])
        .toEqual([status, true, true, 0]);
    }
  });

  test('a board row never carries a due band', async () => {
    const page = await renderPage(handler, 'project.html', '/p/board');
    for (const row of page.byId('items').byClass('listrow')) {
      expect(row.className.split(/\s+/).filter((c) => c.startsWith('due-'))).toEqual([]);
    }
  });
});

describe('the favicon', () => {
  test('is served as SVG and linked from every page', async () => {
    const res = await handler(new Request('http://localhost/favicon.svg'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') || '').toContain('image/svg+xml');
    const svg = await res.text();
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox="0 0 32 32"');
    for (const page of ['index.html', 'project.html', 'item.html', 'agents.html']) {
      const html = readFileSync(new URL(`../public/${page}`, import.meta.url), 'utf8');
      expect([page, html.includes('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')]).toEqual([page, true]);
    }
  });
});

// Question sets (contract v23): the row, the item page and the expanded card.
describe('a question set on the board and on its page', () => {
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
  const QS = [
    { id: 's1', label: 'Packing location', ask: 'Where do the cases go?', options: ['Bay A', 'Bay B'], recommended: ['Bay A'] },
    { id: 's2', label: 'Label stock', ask: 'Which label stock?', options: ['Thermal', 'Paper'], recommended: ['Thermal'] },
    { id: 's3', label: 'Notes', ask: 'Anything else?' },
  ];
  const make = (questions: any[] = QS) => {
    const p = store.getProject('board')!;
    return store.createItem(p.id, { title: 'Three questions', kind: 'questions', questions });
  };
  const read = (id: string) => store.getItem(id)!;

  test('the row says how many are answered and how many questions it holds', async () => {
    const item = make();
    store.answerQuestion(item.id, 's1', { choice: 'Bay A', by: 'you' });
    const page = await renderPage(handler, 'project.html', '/p/board');
    const items = page.byId('items');
    expect(items.byClass('lr-choice').map((c) => c.textContent)).toContain('1 of 3 answered');
    const chip = items.byClass('qs-chip')[0];
    expect(chip.textContent).toBe('3 questions');
    expect(chip.classList.contains('done')).toBe(false);
    // And it still counts as waiting on the person.
    expect(page.byId('eyebrow').textContent).toContain('2 waiting on you');
  });

  test('the chip turns green once every question is answered', async () => {
    const item = make([{ id: 'a', ask: 'One?' }]);
    store.answerQuestion(item.id, 'a', { answer: 'yes', by: 'you' });
    const page = await renderPage(handler, 'project.html', '/p/board');
    expect(page.byId('items').byClass('qs-chip')[0].classList.contains('done')).toBe(true);
  });

  test('the item page draws the header, open questions with option buttons, and answered ones collapsed', async () => {
    const item = make();
    store.answerQuestion(item.id, 's1', { choice: 'Bay B', answer: 'by the dock', by: 'you' });
    store.answerQuestion(item.id, 's2', { choice: 'Paper', by: 'tool-a', relay: true });
    const page = await renderPage(handler, 'item.html', `/p/board/i/${item.id}`);
    const host = page.byId('questions');
    expect(host.byClass('qset').length).toBe(1);
    expect(host.byClass('qcount')[0].textContent).toBe('2 of 3 answered');
    const done = host.byClass('q-done');
    expect(done.length).toBe(2);
    expect(done[0].textContent).toContain('✓');
    expect(done[0].textContent).toContain('Packing location');
    expect(done[0].textContent).toContain('Bay B');
    expect(done[0].textContent).toContain('by the dock');
    expect(done[0].textContent).not.toContain('relayed');
    expect(done[1].textContent).toContain('relayed');
    expect(done[1].byClass('qchange').length).toBe(1);
    const open = host.byClass('q-open');
    expect(open.length).toBe(1);
    expect(open[0].textContent).toContain('Notes');
    // Free-text question: the input is the answer, and there are no option buttons.
    expect(open[0].byClass('q-input')[0].placeholder).toBe('Your answer');
    expect(open[0].byClass('opts').length).toBe(0);
    // No item-level options exist on a question set.
    expect(page.byId('panel').byClass('opts').length).toBe(0);
  });

  test('option buttons carry the recommendation and the pressed state, and the input is optional beside them', async () => {
    const item = make();
    store.answerQuestion(item.id, 's1', { choice: 'Bay A', by: 'you' });
    const page = await renderPage(handler, 'item.html', `/p/board/i/${item.id}`);
    const host = page.byId('questions');
    const s2 = host.byClass('q-open').find((r) => r.textContent.includes('Label stock'))!;
    const buttons = s2.byClass('opts')[0].children;
    expect(buttons.map((b) => b.classList.contains('rec'))).toEqual([true, false]);
    expect(buttons[0].textContent).toContain('Recommended');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
    expect(s2.byClass('q-input')[0].placeholder).toBe('Add a note (optional)');
    expect(s2.byClass('q-input')[0].getAttribute('aria-label')).toBe('Answer for Label stock');
  });

  test('"change" opens an answered question with its answer pressed; Clear empties it', async () => {
    const item = make();
    store.answerQuestion(item.id, 's1', { choice: 'Bay B', by: 'you' });
    const page = await renderPage(handler, 'item.html', `/p/board/i/${item.id}`);
    page.byId('questions').byClass('qchange')[0].dispatchEvent({ type: 'click' });
    await settle();
    const reopened = page.byId('questions').byClass('q-editing')[0];
    expect(reopened.byClass('opts')[0].children.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    reopened.byClass('qclear')[0].dispatchEvent({ type: 'click' });
    await settle();
    expect(read(item.id).questions[0].choice).toBe('');
  });

  test('clicking an option records that one question and repaints from the returned item', async () => {
    const item = make();
    const page = await renderPage(handler, 'item.html', `/p/board/i/${item.id}`);
    const s2 = page.byId('questions').byClass('q-open').find((r) => r.textContent.includes('Label stock'))!;
    s2.byClass('opts')[0].children[1].dispatchEvent({ type: 'click' });
    await settle();
    expect(read(item.id).questions[1]).toMatchObject({ choice: 'Paper', by: 'you', relayed: false });
    expect(read(item.id).questions[0].choice).toBe('');
    expect(page.byId('questions').byClass('qcount')[0].textContent).toBe('1 of 3 answered');
  });

  test('a typed answer saves with Save, and a refused save shows in the note area', async () => {
    const item = make();
    const page = await renderPage(handler, 'item.html', `/p/board/i/${item.id}`);
    const s3 = page.byId('questions').byClass('q-open').find((r) => r.textContent.includes('Notes'))!;
    // Nothing typed: the server refuses an empty save and the page says so.
    s3.byClass('qsave')[0].dispatchEvent({ type: 'click' });
    await settle();
    expect(page.byId('saved-main').textContent).toContain('nothing to record');
    expect(read(item.id).answered).toBe(0);
    const input = page.byId('questions').byClass('q-open').find((r) => r.textContent.includes('Notes'))!.byClass('q-input')[0];
    input.value = 'Bring ear plugs';
    input.dispatchEvent({ type: 'input' });
    input.dispatchEvent({ type: 'keydown', key: 'Enter' } as any);
    await settle();
    expect(read(item.id).questions[2].answer).toBe('Bring ear plugs');
  });

  test('Accept all recommendations shows only when an open question has exactly one recommended option', async () => {
    const none = make([{ id: 'a', ask: 'Free?' }, { id: 'b', ask: 'Two?', options: ['X', 'Y'], recommended: ['X', 'Y'] }]);
    let page = await renderPage(handler, 'item.html', `/p/board/i/${none.id}`);
    expect(page.byId('questions').byClass('qaccept').length).toBe(0);
    const allDone = make([{ id: 'a', ask: 'One?', options: ['X'], recommended: ['X'] }]);
    store.answerQuestion(allDone.id, 'a', { choice: 'X', by: 'you' });
    page = await renderPage(handler, 'item.html', `/p/board/i/${allDone.id}`);
    expect(page.byId('questions').byClass('qaccept').length).toBe(0);
    const some = make();
    page = await renderPage(handler, 'item.html', `/p/board/i/${some.id}`);
    expect(page.byId('questions').byClass('qaccept').length).toBe(1);
  });

  test('Accept all answers each such question in turn, skips answered ones, and hands the set back when it finishes', async () => {
    const item = make([QS[0], QS[1]]);
    store.answerQuestion(item.id, 's2', { choice: 'Paper', by: 'you' });
    const page = await renderPage(handler, 'item.html', `/p/board/i/${item.id}`);
    page.byId('questions').byClass('qaccept')[0].dispatchEvent({ type: 'click' });
    await settle();
    const after = read(item.id);
    expect(after.questions[0]).toMatchObject({ choice: 'Bay A', by: 'you' });
    expect(after.questions[1].choice).toBe('Paper');
    expect(after.status).toBe('received');
  });

  test('on the project page an expanded card loads the questions and answers them in place', async () => {
    const item = make();
    const page = await renderPage(handler, 'project.html', '/p/board');
    const items = page.byId('items');
    expect(items.byClass('qset').length).toBe(0);
    const toggle = items.byClass('lr-toggle').find((t) => t.getAttribute('aria-label')!.includes('Three questions'))!;
    toggle.dispatchEvent({ type: 'click' });
    await settle();
    const panel = page.byId('items').byClass('qset');
    expect(panel.length).toBe(1);
    const s1 = panel[0].byClass('q-open').find((r) => r.textContent.includes('Packing location'))!;
    s1.byClass('opts')[0].children[1].dispatchEvent({ type: 'click' });
    await settle();
    expect(read(item.id).questions[0].choice).toBe('Bay B');
    expect(page.byId('items').byClass('lr-choice').map((c) => c.textContent)).toContain('1 of 3 answered');
  });

  test('the layout holds at phone width: every row wraps and inputs may shrink', () => {
    const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
    const rule = (selector: string) => css.slice(css.indexOf(selector)).split('}')[0];
    expect(rule('.qrow {')).toContain('flex-wrap: wrap');
    expect(rule('.qform {')).toContain('flex-wrap: wrap');
    expect(rule('input.q-input {')).toContain('min-width: 0');
    expect(rule('.qask {')).toContain('overflow-wrap');
  });
});

describe('saving a question with Enter while its box has focus', () => {
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
  test('the row folds and the count moves without waiting for a blur', async () => {
    const item = store.createItem(store.getProject('board')!.id, { title: 'Focus', kind: 'questions', questions: [{ id: 'a', ask: 'One?' }, { id: 'b', ask: 'Two?' }] });
    const page = await renderPage(handler, 'item.html', `/p/board/i/${item.id}`);
    const rows = () => page.byId('questions').byClass('q-open');
    const input = rows()[0].byClass('q-input')[0];
    // The browser reports the box as focused until something blurs it.
    page.doc.activeElement = input;
    (input as any).blur = () => { if (page.doc.activeElement === input) page.doc.activeElement = null; };
    input.value = 'typed answer';
    input.dispatchEvent({ type: 'input' });
    input.dispatchEvent({ type: 'keydown', key: 'Enter' } as any);
    await settle();
    expect(page.byId('questions').byClass('qcount')[0].textContent).toBe('1 of 2 answered');
    expect(page.byId('questions').byClass('q-done').length).toBe(1);
    expect(rows().length).toBe(1);
  });
});
