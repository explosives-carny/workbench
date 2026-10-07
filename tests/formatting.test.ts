// Formatting warnings (AGENTS.md rule 12, contract v20). Warned, never refused.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, Store } from '../src/db.ts';
import { createHandler } from '../src/app.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

let dbPaths: string[];
let store: Store;
let handler: (req: Request) => Promise<Response>;

beforeEach(async () => {
  dbPaths = [];
  const p = join(tmpdir(), `workbench-fmt-${Math.random().toString(36).slice(2)}.db`);
  dbPaths.push(p);
  store = new Store(openDb(p));
  handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
  await api('POST', '/api/projects', { name: 'Demo', key: 'demo' });
});

afterEach(() => {
  for (const p of dbPaths) for (const s of ['', '-wal', '-shm']) { try { rmSync(p + s); } catch {} }
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

const wall = 'word '.repeat(100).trim();
const TABLE = '| a | b |\n|---|---|\n| 1 | 2 |';
const warned = (res: any): string => [res.json.warning, ...(res.json.warnings || [])].filter(Boolean).join(' | ');
const create = (body: any) => api('POST', '/api/projects/demo/items', { title: 'T', ...body });

describe('create', () => {
  test('wall of text warns, lands, and states the length', async () => {
    const res = await create({ context: wall });
    expect(res.status).toBe(201);
    expect(warned(res)).toContain(`context is one ${wall.length}-character paragraph — it renders as Markdown`);
    expect(res.json.items[0].context).toBe(wall);
  });
  test('short text, or long text with newlines, is silent', async () => {
    expect(warned(await create({ context: 'short' }))).not.toContain('paragraph');
    expect(warned(await create({ context: wall.replace(/ /g, '\n') }))).not.toContain('paragraph');
  });
  test('one newline in front of a wall does not hide it', async () => {
    const res = await create({ context: `Lead.\n${wall}` });
    expect(warned(res)).toContain(`context has a ${wall.length}-character paragraph`);
  });
  test('a wide table row is not a wall', async () => {
    const row = `| ${'cell '.repeat(50)} | ${'cell '.repeat(50)} |`;
    expect(warned(await create({ context: `Lead.\n\n| a | b |\n|---|---|\n${row}` }))).not.toContain('paragraph');
  });
  test('the escaped-newline check names the field', async () => {
    expect(warned(await create({ context: 'a\\nb\\nc' }))).toContain('context contains literal');
  });
  test('escaped newlines warn only when twice and no real newline', async () => {
    expect(warned(await create({ context: 'a\\nb\\nc' }))).toContain('literal "\\n"');
    expect(warned(await create({ context: 'a\\nb' }))).not.toContain('literal');
    expect(warned(await create({ context: 'a\\nb\\nc\nd' }))).not.toContain('literal');
  });
  test('pointer option warns; plain option does not', async () => {
    const res = await create({ options: ['A. As in the table above', 'B'], recommended: ['B'] });
    expect(res.status).toBe(201);
    expect(warned(res)).toContain('option "A. As in the table above" points "above"');
    expect(warned(await create({ options: ['A', 'B'], recommended: ['A'] }))).not.toContain('points');
  });
  test('table option needs a Markdown table in context or body', async () => {
    const bare = await create({ options: ['Use the table above', 'B'], recommended: ['B'] });
    expect(warned(bare)).toContain('names a table, but this item has no Markdown table');
    const ok = await create({ context: `x\n${TABLE}`, options: ['Use the table above', 'B'], recommended: ['B'] });
    expect(warned(ok)).not.toContain('names a table');
  });
  test('comparisons and talk about a table are not pointers', async () => {
    const res = await create({ options: ['Alert when stock falls below 10', 'Raise the cap above 500', 'Drop the users table'], recommended: ['Drop the users table'] });
    expect(warned(res)).not.toContain('points');
    expect(warned(res)).not.toContain('names a table');
  });
  test('positional forms are caught', async () => {
    for (const o of ['A (see below)', 'Per the list above.', 'A. Adjust where it is wrong (the table above); holds post nothing']) {
      expect(warned(await create({ options: [o, 'B'], recommended: ['B'] }))).toContain('points');
    }
  });
  test('a long line inside fenced code is not a wall', async () => {
    const res = await create({ context: `Log:\n\`\`\`\n${wall}\n\`\`\`` });
    expect(warned(res)).not.toContain('paragraph');
  });
  test('batch create warns per item', async () => {
    const res = await api('POST', '/api/projects/demo/items', [{ title: 'One', context: wall }, { title: 'Two' }]);
    expect(res.status).toBe(201);
    expect(res.json.warnings.some((w: string) => w.startsWith('"One": context is one'))).toBe(true);
  });
});

describe('patch', () => {
  test('only fields that were sent are checked', async () => {
    const made = await create({ context: wall, options: ['A below', 'B'], recommended: ['B'] });
    const id = made.json.items[0].id;
    const title = await api('PATCH', `/api/items/${id}`, { title: 'New' });
    expect(warned(title)).not.toContain('paragraph');
    expect(warned(title)).not.toContain('points');
    const ctx = await api('PATCH', `/api/items/${id}`, { context: wall + ' more' });
    expect(ctx.status).toBe(200);
    expect(warned(ctx)).toContain('character paragraph');
    expect(warned(ctx)).not.toContain('points');
    const opts = await api('PATCH', `/api/items/${id}`, { options: ['A below', 'B'], recommended: ['B'] });
    expect(warned(opts)).toContain('points "below"');
    expect(opts.json.item.options).toEqual(['A below', 'B']);
  });
});

describe('messages', () => {
  test('agent message warns, human message never does', async () => {
    const id = (await create({})).json.items[0].id;
    const agent = await api('POST', `/api/items/${id}/messages`, { who: 'agent', text: wall });
    expect(agent.status).toBe(201);
    expect(warned(agent)).toContain('message is one');
    const esc = await api('POST', `/api/items/${id}/messages`, { text: 'a\\nb\\nc' });
    expect(warned(esc)).toContain('message contains literal "\\n"');
    const human = await api('POST', `/api/items/${id}/messages`, { who: 'you', text: wall });
    expect(human.status).toBe(201);
    expect(warned(human)).not.toContain('message is one');
    expect(warned(await api('POST', `/api/items/${id}/messages`, { who: 'agent', text: 'short' }))).not.toContain('message');
  });
});

describe('audit and contract', () => {
  test('lists wall and pointer findings on a live item, not a complete one', async () => {
    const project = store.getProject('demo')!;
    const live = store.createItem(project.id, { title: 'Live', context: wall, options: ['A above', 'B'], recommended: ['B'] } as any);
    const done = store.createItem(project.id, { title: 'Done', context: wall, options: ['A above', 'B'], recommended: ['B'], status: 'complete' } as any);
    const res = await api('GET', '/api/projects/demo/audit');
    const rules = (id: string) => (res.json.items.find((i: any) => i.id === id)?.findings || []).map((f: any) => f.rule);
    expect(rules(live.id)).toEqual(['context-wall-of-text', 'option-points-elsewhere']);
    expect(rules(done.id)).toEqual([]);
  });
  test('GET /api speaks v20', async () => {
    expect((await api('GET', '/api')).json.contractVersion).toBe('20');
  });
});
