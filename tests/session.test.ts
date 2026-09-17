// Session identity: the name is who, the session is which one.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, Store } from '../src/db.ts';
import { createHandler } from '../src/app.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

let dbPath: string;
let store: Store;
let handler: (req: Request) => Promise<Response>;
const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

beforeEach(() => {
  dbPath = join(tmpdir(), `workbench-session-${Math.random().toString(36).slice(2)}.db`);
  store = new Store(openDb(dbPath));
  handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
});
afterEach(() => { for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s); } catch {} } });

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await handler(new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}
async function item() {
  await api('POST', '/api/projects', { name: 'Acme', slug: 'acme' });
  return (await api('POST', '/api/projects/acme/items', { title: 'Deploy?' })).json.items[0];
}

describe('session identity', () => {
  test('a message carries the session that wrote it; the claim records name and session', async () => {
    const it = await item();
    await api('POST', `/api/items/${it.id}/messages`, { who: 'you', text: 'Do it' });
    const r = await api('POST', `/api/items/${it.id}/messages`, { who: 'agent', actor: 'spike', session: '7f3a', text: 'Picking this up' });
    expect(r.json.message.author).toBe('spike');
    expect(r.json.message.session).toBe('7f3a');
    expect(r.json.item.status).toBe('in-progress');
    expect(r.json.item.updatedBy).toBe('spike');
    expect(r.json.item.updatedSession).toBe('7f3a');
  });

  test('two sessions of the same name are told apart on the item, and a comment changes neither', async () => {
    const it = await item();
    await api('POST', `/api/items/${it.id}/messages`, { who: 'you', text: 'Do it' });
    await api('POST', `/api/items/${it.id}/messages`, { who: 'agent', actor: 'spike', session: '7f3a', text: 'mine' });
    const comment = await api('POST', `/api/items/${it.id}/messages`, { who: 'agent', actor: 'spike', session: 'c21e', text: 'sibling here, FYI' });
    expect(comment.json.item.updatedSession).toBe('7f3a');
    expect(comment.json.message.session).toBe('c21e');
    const reclaim = await api('PATCH', `/api/items/${it.id}`, { status: 'in-progress', actor: 'spike', session: 'c21e', ifVersion: comment.json.item.version });
    expect(reclaim.json.item.updatedSession).toBe('c21e');
  });

  test('an edit and a checklist result carry the session; the sign-off message inherits it', async () => {
    const it = await item();
    const q = await api('PATCH', `/api/items/${it.id}`, { status: 'needs-qa', actor: 'spike', session: '7f3a', ifVersion: it.version, checks: [{ id: 's1', label: '1.' }] });
    expect(q.json.item.updatedSession).toBe('7f3a');
    const r = await api('PATCH', `/api/items/${it.id}/checks/s1`, { result: 'pass', actor: 'qa-bot', session: 'b0b0' });
    expect(r.json.item.status).toBe('received');
    expect(r.json.item.messages.at(-1).session).toBe('b0b0');
    expect(r.json.item.updatedSession).toBe('b0b0');
  });

  test('a writer that sends no session stores an empty one and is not refused', async () => {
    const it = await item();
    const r = await api('POST', `/api/items/${it.id}/messages`, { who: 'agent', actor: 'old', text: 'hi' });
    expect(r.status).toBe(201);
    expect(r.json.message.session).toBe('');
    expect(r.json.ignored).toBeUndefined();
  });

  test('a browser edit with no actor is the human, not nobody', async () => {
    const it = await item();
    const r = await api('PATCH', `/api/items/${it.id}`, { choice: 'Do it', status: 'received' }, { 'sec-fetch-mode': 'cors' });
    expect(r.json.item.updatedBy).toBe('you');
    const script = await api('PATCH', `/api/items/${it.id}`, { context: 'x' });
    expect(script.json.item.updatedBy).toBe('');
  });
});
