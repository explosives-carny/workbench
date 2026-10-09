// References as links (contract v25). Three layers, each tested where it
// lives: md.js links a ref in rendered text; the pages link refs in the
// fields that are not Markdown and load the board's keys first; the server
// turns /i/<ref> into the item's page. And the rule that keeps agents from
// building the link by hand: a warning on the write, a finding in the audit.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDb, Store } from '../src/db.ts';
import { createHandler, CONTRACT_VERSION } from '../src/app.ts';
import { refLinkWarning, auditItem } from '../src/rules.ts';
import { renderPage, type El } from './helpers/page.ts';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

function loadMd() {
  const src = readFileSync(new URL('../public/md.js', import.meta.url), 'utf8');
  const win: any = {};
  new Function('window', src)(win);
  return win.MD as ((md: string, opts?: { breaks?: boolean; refs?: boolean }) => string) & {
    inline: (s: string, opts?: { refs?: boolean }) => string;
    refKeys: Set<string> | null;
  };
}

describe('md.js links a reference in text', () => {
  let MD: ReturnType<typeof loadMd>;
  beforeEach(() => { MD = loadMd(); MD.refKeys = new Set(['BD', 'OLD']); });

  const link = (ref: string, text = ref) => `<a class="ref-link mono" href="/i/${ref}">${text}</a>`;

  test('a bare ref in a paragraph, a list, a table cell and a heading', () => {
    expect(MD('see WB-BD-1 first')).toBe(`<p>see ${link('WB-BD-1')} first</p>`);
    expect(MD('- WB-BD-2 done')).toContain(`<li>${link('WB-BD-2')} done</li>`);
    expect(MD('| a | b |\n|---|---|\n| WB-BD-3 | x |')).toContain(`<td>${link('WB-BD-3')}</td>`);
    expect(MD('## After WB-BD-4')).toBe(`<h2>After ${link('WB-BD-4')}</h2>`);
    expect(MD('> WB-BD-5', { breaks: true })).toContain(link('WB-BD-5'));
  });

  test('case and punctuation: the text stays as written, the href is upper-cased, neighbours are untouched', () => {
    expect(MD('(wb-bd-7).')).toBe(`<p>(${link('WB-BD-7', 'wb-bd-7')}).</p>`);
    expect(MD('**WB-BD-8**')).toBe(`<p><strong>${link('WB-BD-8')}</strong></p>`);
    expect(MD('WB-BD-9, WB-BD-10')).toBe(`<p>${link('WB-BD-9')}, ${link('WB-BD-10')}</p>`);
  });

  test('inline code links; a fenced block, an existing link and an attribute do not', () => {
    expect(MD('run `wb show WB-BD-1`')).toBe(`<p>run <code>wb show ${link('WB-BD-1')}</code></p>`);
    expect(MD('```\nwb show WB-BD-1\n```')).toBe('<pre><code>wb show WB-BD-1</code></pre>');
    expect(MD('[WB-BD-1](https://example.test/pr/1)')).toBe('<p><a href="https://example.test/pr/1" rel="noopener">WB-BD-1</a></p>');
    expect(MD('[the PR](https://example.test/WB-BD-1)')).toBe('<p><a href="https://example.test/WB-BD-1" rel="noopener">the PR</a></p>');
    const img = '![WB-BD-1 shot](/api/images/' + 'a'.repeat(64) + '.png)';
    expect(MD(img)).toContain('alt="WB-BD-1 shot"');
    expect(MD(img)).not.toContain('ref-link');
  });

  test('what is not a ref: a leading zero, a run-on word, a path segment, a key the board lacks', () => {
    expect(MD('WB-BD-01')).toBe('<p>WB-BD-01</p>');
    expect(MD('XWB-BD-1 WB-BD-1x WB-BD-1-fix')).toBe('<p>XWB-BD-1 WB-BD-1x WB-BD-1-fix</p>');
    expect(MD('feat/WB-BD-1 and https://x.test/WB-BD-1')).toBe('<p>feat/WB-BD-1 and https://x.test/WB-BD-1</p>');
    expect(MD('WB-ZZ-1 is elsewhere')).toBe('<p>WB-ZZ-1 is elsewhere</p>');
    expect(MD('WB-OLD-3 still lands')).toBe(`<p>${link('WB-OLD-3')} still lands</p>`);
  });

  test('a question citation links to the question; with no key set every well-formed ref links', () => {
    expect(MD('WB-BD-1/q3 asks')).toBe('<p><a class="ref-link mono" href="/i/WB-BD-1#q3">WB-BD-1/q3</a> asks</p>');
    MD.refKeys = null;
    expect(MD('WB-ZZ-1')).toBe(`<p>${link('WB-ZZ-1')}</p>`);
  });

  test('inline mode links answers and leaves option buttons alone', () => {
    expect(MD.inline('WB-BD-1 then')).toBe(`${link('WB-BD-1')} then`);
    expect(MD.inline('WB-BD-1 then', { refs: false })).toBe('WB-BD-1 then');
    expect(MD('WB-BD-1', { refs: false })).toBe('<p>WB-BD-1</p>');
    // The flag does not stick to the next render.
    expect(MD('WB-BD-1')).toBe(`<p>${link('WB-BD-1')}</p>`);
  });

  test('nothing in the text reaches the page as markup', () => {
    expect(MD('<b>WB-BD-1</b>')).toBe(`<p>&lt;b&gt;${link('WB-BD-1')}&lt;/b&gt;</p>`);
    expect(MD('WB-BD-1 "x" <a href="/i/WB-BD-2">y</a>')).not.toContain('<a href="/i/WB-BD-2"');
  });
});

describe('the rule against hand-built links', () => {
  test('an item-page href, or a ref as link text, is warned; the bare ref and other links are not', () => {
    expect(refLinkWarning('context', '[WB-BD-1](/p/board/i/0f3a9c)')).toContain('links an item by hand');
    expect(refLinkWarning('context', 'see [this](http://localhost:4317/p/board/i/WB-BD-1)')).toContain('links an item by hand');
    expect(refLinkWarning('context', '[open](/i/WB-BD-1)')).toContain('links an item by hand');
    expect(refLinkWarning('context', '[WB-BD-1](https://example.test/pr/1)')).toContain('uses a ref as link text');
    expect(refLinkWarning('context', 'WB-BD-1 and `WB-BD-2`')).toBeUndefined();
    expect(refLinkWarning('context', '[the PR](https://example.test/pr/1)')).toBeUndefined();
    expect(refLinkWarning('context', '```\n[WB-BD-1](/p/board/i/x)\n```')).toBeUndefined();
    expect(refLinkWarning('context', '')).toBeUndefined();
  });
});

describe('server: writes warn, the audit lists, /i/<ref> redirects', () => {
  let dbPath: string;
  let store: Store;
  let handler: (req: Request) => Promise<Response>;
  let board: any;
  let other: any;

  beforeEach(() => {
    dbPath = join(tmpdir(), `workbench-reflinks-${Math.random().toString(36).slice(2)}.db`);
    store = new Store(openDb(dbPath));
    handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
    board = store.createProject({ name: 'Board', key: 'BD' });
    other = store.createProject({ name: 'Other', key: 'OT' });
  });
  afterEach(() => { for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s); } catch {} } });

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handler(new Request(`http://localhost${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      redirect: 'manual',
    }));
    let json: any = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };

  test('the contract is v25', async () => {
    expect(CONTRACT_VERSION).toBe('25');
    expect((await call('GET', '/api')).json.contractVersion).toBe('25');
    expect((await call('GET', '/api')).json.routes.some((r: string) => r.includes('/i/<id-or-ref>'))).toBe(true);
  });

  test('/i/<ref> is a 302 to the item page, case-insensitively, on the project that holds it', async () => {
    const a = store.createItem(board.id, { title: 'First' });
    const b = store.createItem(other.id, { title: 'Theirs' });
    const r1 = await call('GET', '/i/WB-BD-1');
    expect(r1.status).toBe(302);
    expect(r1.headers.get('location')).toBe('/p/board/i/WB-BD-1');
    expect((await call('GET', '/i/wb-ot-1')).headers.get('location')).toBe('/p/other/i/WB-OT-1');
    expect((await call('GET', `/i/${a.id}`)).headers.get('location')).toBe('/p/board/i/WB-BD-1');
    expect(b.ref).toBe('WB-OT-1');
  });

  test('a former key lands on the current page and the address teaches the current ref', async () => {
    store.createItem(board.id, { title: 'First' });
    store.setProjectKey('board', 'NEW');
    const r = await call('GET', '/i/WB-BD-1');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/p/board/i/WB-NEW-1');
  });

  test('a ref nobody holds, a bad escape and a malformed ref are 404 text, never 500', async () => {
    for (const path of ['/i/WB-ZZ-1', '/i/WB-BD-99', '/i/%E0%A4%A', '/i/not-a-ref', '/i/WB-BD-0']) {
      const r = await call('GET', path);
      expect(r.status).toBe(404);
      expect(r.headers.get('content-type')).toContain('text/plain');
    }
  });

  test('a hand-built link is warned on create, on PATCH of context or a Markdown body, and on an agent message', async () => {
    const created = await call('POST', '/api/projects/board/items', { title: 'T', context: 'see [WB-OT-1](/p/other/i/x)', actor: 'a', session: 's1' });
    expect(created.status).toBe(201);
    expect(created.json.warnings.join(' ')).toContain('links an item by hand');
    const id = created.json.items[0].id;
    const patched = await call('PATCH', `/api/items/${id}`, { context: '[WB-OT-1](https://example.test/pr)', actor: 'a', session: 's1', ifVersion: created.json.items[0].version });
    expect(patched.status).toBe(200);
    expect(patched.json.warning).toContain('uses a ref as link text');
    const body = await call('PATCH', `/api/items/${id}`, { body: '# Doc\n\n[WB-OT-1](/i/WB-OT-1)', bodyFormat: 'markdown', actor: 'a', session: 's1', ifVersion: patched.json.item.version });
    expect(body.json.warning).toContain('body links an item by hand');
    const msg = await call('POST', `/api/items/${id}/messages`, { who: 'agent', actor: 'a', session: 's1', text: 'done: [WB-BD-1](/p/board/i/WB-BD-1)' });
    expect(msg.status).toBe(201);
    expect(msg.json.warning).toContain('message links an item by hand');
    const person = await call('POST', `/api/items/${id}/messages`, { who: 'you', text: '[WB-BD-1](/p/board/i/WB-BD-1)' });
    expect(person.json.warning || '').not.toContain('links an item by hand');
  });

  test('the audit lists the same, on context, a Markdown body and a question ask, and not on finished work', async () => {
    const live = store.createItem(board.id, { title: 'Live', context: '[WB-OT-1](/p/other/i/x)' });
    const doc = store.createItem(board.id, { title: 'Doc', kind: 'document', body: '[WB-OT-1](/i/WB-OT-1)', bodyFormat: 'markdown' });
    const set = store.createItem(board.id, { title: 'Set', kind: 'questions', questions: [{ id: 'q1', label: 'L', ask: '[WB-OT-1](/p/other/i/x)?', options: ['A'], recommended: ['A'] }] } as any);
    const done = store.createItem(board.id, { title: 'Done', context: '[WB-OT-1](/p/other/i/x)', status: 'complete' });
    const rules = (item: any) => auditItem(store.getItem(item.id)!).map((f) => f.rule);
    expect(rules(live)).toContain('ref-written-as-link');
    expect(rules(doc)).toContain('ref-written-as-link');
    expect(rules(set)).toContain('ref-written-as-link');
    expect(rules(done)).toEqual([]);
    const audit = await call('GET', '/api/projects/board/audit');
    expect(audit.json.items.map((i: any) => i.ref).sort()).toEqual(['WB-BD-1', 'WB-BD-2', 'WB-BD-3']);
  });
});

describe('the pages link refs in titles, labels and blocked-by lines, across projects', () => {
  let dbPath: string;
  let store: Store;
  let handler: (req: Request) => Promise<Response>;
  let item: any;

  beforeEach(() => {
    dbPath = join(tmpdir(), `workbench-reflinks-page-${Math.random().toString(36).slice(2)}.db`);
    store = new Store(openDb(dbPath));
    handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
    const board = store.createProject({ name: 'Board', key: 'BD' });
    const other = store.createProject({ name: 'Other', key: 'OT' });
    store.createItem(other.id, { title: 'Theirs' });
    store.createItem(board.id, { title: 'Earlier' });
    item = store.createItem(board.id, {
      title: 'Follow-up to WB-OT-1',
      context: 'Continues WB-BD-1 and WB-OT-1; WB-ZZ-9 is not ours.',
      status: 'blocked',
      blockedBy: 'WB-OT-1 merged',
      checks: [{ label: '1. Open WB-BD-1 and compare', owner: 'human' }],
    } as any);
    store.addMessage(item.id, { who: 'agent', text: 'See WB-OT-1/q2 for the answer', author: 'a', session: 's' } as any);
  });
  afterEach(() => { for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s); } catch {} } });

  const anchors = (el: El) => el.byClass('ref-link').map((a) => [a.textContent, a.href]);

  test('the item page', async () => {
    const page = await renderPage(handler, 'item.html', `/p/board/i/${item.id}`);
    expect(page.win.MD.refKeys).toEqual(new Set(['BD', 'OT']));
    expect(anchors(page.byId('title'))).toEqual([['WB-OT-1', '/i/WB-OT-1']]);
    expect(page.byId('title').textContent).toBe('Follow-up to WB-OT-1');
    expect(anchors(page.byId('blocked'))).toEqual([['WB-OT-1', '/i/WB-OT-1']]);
    expect(page.byId('blocked').byClass('blocked-ref').length).toBe(1);
    // Markdown fields go through md.js: the harness keeps innerHTML as text,
    // so the anchor is asserted on the rendered string instead.
    const ctx = page.win.MD('Continues WB-BD-1 and WB-OT-1; WB-ZZ-9 is not ours.', { breaks: true });
    expect(ctx).toContain('href="/i/WB-BD-1"');
    expect(ctx).toContain('href="/i/WB-OT-1"');
    expect(ctx).not.toContain('href="/i/WB-ZZ-9"');
    expect(page.win.MD('See WB-OT-1/q2', { breaks: true })).toContain('href="/i/WB-OT-1#q2"');
    const labels = page.byId('checks').byClass('ck-label');
    expect(labels.length).toBe(1);
    expect(anchors(labels[0])).toEqual([['WB-BD-1', '/i/WB-BD-1']]);
  });

  test('the project page: the row title stays text inside its own link; the expanded card links', async () => {
    const page = await renderPage(handler, 'project.html', '/p/board');
    const items = page.byId('items');
    const row = items.byClass('lr-title').find((t) => t.textContent === 'Follow-up to WB-OT-1')!;
    expect(row).toBeDefined();
    expect(row.byClass('ref-link').length).toBe(0);
    expect(page.win.MD.refKeys).toEqual(new Set(['BD', 'OT']));
  });
});
