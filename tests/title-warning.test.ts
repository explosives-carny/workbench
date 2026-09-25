// A title is a headline, not the body (AGENTS.md rule 7, contract v13). Warned,
// never refused: the failure this answers was 25 of ~350 items on a real board
// with titles over 100 characters, five with no context and no body at all —
// the whole message pasted into the one field POST requires.
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

function tmpDb(tag: string): string {
  const p = join(tmpdir(), `workbench-title-${tag}-${Math.random().toString(36).slice(2)}.db`);
  dbPaths.push(p);
  return p;
}

beforeEach(() => {
  dbPaths = [];
  store = new Store(openDb(tmpDb('main')));
  handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
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

const LONG_121 = 'x'.repeat(121);
const LONG_110 = 'x'.repeat(110);
const SHORT = 'Decide the deploy window';

describe('title length warnings', () => {
  test('a short title with no context produces no warning', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    const res = await api('POST', '/api/projects/demo/items', { title: SHORT });
    expect(res.status).toBe(201);
    expect(res.json.warnings).toBeUndefined();
  });

  test('a title over 120 characters warns, even with context', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    const res = await api('POST', '/api/projects/demo/items', { title: LONG_121, context: 'plenty of context here' });
    expect(res.status).toBe(201);
    expect(res.json.warnings.join(' ')).toContain('title is 121 characters');
  });

  test('a title over 100 with no context and no body warns that it reads like a body', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    const res = await api('POST', '/api/projects/demo/items', { title: LONG_110 });
    expect(res.status).toBe(201);
    expect(res.json.warnings.join(' ')).toContain('title reads like a body');
  });

  test('a title over 100 with context attached produces no "reads like a body" warning', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    const res = await api('POST', '/api/projects/demo/items', { title: LONG_110, context: 'the explanation lives here instead' });
    expect(res.status).toBe(201);
    expect(res.json.warnings).toBeUndefined();
  });

  test('a title over 100 with a document body produces no "reads like a body" warning', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    const res = await api('POST', '/api/projects/demo/items', { title: LONG_110, kind: 'document', body: 'the notes', status: 'active' });
    expect(res.status).toBe(201);
    expect(res.json.warnings).toBeUndefined();
  });

  test('a PATCH that leaves the title too long warns the same way', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    const created = await api('POST', '/api/projects/demo/items', { title: 'short for now' });
    const item = created.json.items[0];
    const res = await api('PATCH', `/api/items/${item.id}`, { title: LONG_121, actor: 't', ifVersion: item.version });
    expect(res.status).toBe(200);
    expect(String(res.json.warning)).toContain('title is 121 characters');
  });

  test('a PATCH with a short title produces no title warning', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    const created = await api('POST', '/api/projects/demo/items', { title: 'short for now' });
    const item = created.json.items[0];
    const res = await api('PATCH', `/api/items/${item.id}`, { status: 'in-progress', actor: 't', ifVersion: item.version });
    expect(res.status).toBe(200);
    expect(res.json.warning).toBeUndefined();
  });
});
