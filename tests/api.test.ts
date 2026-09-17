// The web layer, tested the way an agent uses it: a Request in, a Response out.
//
// store.test.ts proves the storage rules. Nothing proved the shapes AGENTS.md
// promises — the exact 400 messages an agent reads to decide what to do next,
// the 409 with the live item attached, a batch landing whole or not at all. A
// route change could break every one of those and 78 green tests would say
// nothing. createHandler makes this possible without a port.
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
  dbPath = join(tmpdir(), `workbench-api-${Math.random().toString(36).slice(2)}.db`);
  store = new Store(openDb(dbPath));
  handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
});

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + suffix); } catch {}
  }
});

async function api(method: string, path: string, body?: unknown) {
  const res = await handler(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function project(slug = 'acme') {
  const res = await api('POST', '/api/projects', { name: 'Acme', slug });
  return res.json.project;
}

async function item(slug = 'acme', extra: Record<string, unknown> = {}) {
  await project(slug);
  const res = await api('POST', `/api/projects/${slug}/items`, { title: 'Deploy?', ...extra });
  return res.json.items[0];
}

describe('error shapes the contract promises', () => {
  test('an empty install answers with an empty list', async () => {
    const res = await api('GET', '/api/projects');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, projects: [] });
  });

  test('400 carries ok:false and a message written for the caller', async () => {
    const res = await api('POST', '/api/projects', {});
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ ok: false, error: 'name is required' });
  });

  test('an item needs a title', async () => {
    await project();
    const res = await api('POST', '/api/projects/acme/items', { context: 'no title' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('title is required');
  });

  test('a kind and a status it cannot hold is a 400, naming what is allowed', async () => {
    await project();
    const res = await api('POST', '/api/projects/acme/items', { title: 'Spec', kind: 'document', status: 'received' });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('a document cannot be "received"');
    expect(res.json.error).toContain('active, archived');
  });

  test('bodyFormat is a closed set', async () => {
    await project();
    const res = await api('POST', '/api/projects/acme/items', { title: 'Doc', bodyFormat: 'pdf' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('bodyFormat must be text, markdown or html');
  });

  test('invalid JSON is a 400, not a crash', async () => {
    await project();
    const res = await handler(new Request('http://localhost/api/projects/acme/items', { method: 'POST', body: '{not json' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('body is not valid JSON');
  });

  test('unknown slug and unknown item are 404s that name what was asked for', async () => {
    const slug = await api('GET', '/api/projects/nope');
    expect(slug.status).toBe(404);
    expect(slug.json.error).toBe('no project with slug "nope"');
    const id = await api('GET', '/api/items/nope');
    expect(id.status).toBe(404);
    expect(id.json.error).toBe('no item with id "nope"');
  });

  test('a bare /api is a 404 from the API router, and /api-doc is not swallowed by it', async () => {
    const bare = await api('GET', '/api');
    expect(bare.status).toBe(404);
    expect(bare.json.error).toContain('no API route');
    const doc = await api('GET', '/api-doc');
    expect(doc.status).toBe(200);
    expect(doc.headers.get('content-type')).toContain('text/plain');
    expect(doc.text.startsWith('# Workbench')).toBe(true);
  });
});

describe('batches', () => {
  test('an array lands whole', async () => {
    await project();
    const res = await api('POST', '/api/projects/acme/items', [{ title: 'A' }, { title: 'B' }, { title: 'C' }]);
    expect(res.status).toBe(201);
    expect(res.json.items.map((i: any) => i.title)).toEqual(['A', 'B', 'C']);
  });

  test('one bad element refuses the whole batch and creates nothing', async () => {
    const p = await project();
    const res = await api('POST', '/api/projects/acme/items', [{ title: 'A' }, { context: 'no title' }]);
    expect(res.status).toBe(400);
    expect(store.listItems(p.id)).toHaveLength(0);
  });
});

describe('concurrency shapes', () => {
  test('a stale ifVersion is a 409 with conflict:true and the live item attached', async () => {
    const it = await item();
    await api('PATCH', `/api/items/${it.id}`, { context: 'first edit', actor: 'a' });
    const res = await api('PATCH', `/api/items/${it.id}`, { context: 'second edit', actor: 'b', ifVersion: it.version });
    expect(res.status).toBe(409);
    expect(res.json.ok).toBe(false);
    expect(res.json.conflict).toBe(true);
    expect(res.json.item.context).toBe('first edit');
    expect(res.json.item.version).toBe(it.version + 1);
  });

  test('a comment by somebody else does not repaint who holds the claim', async () => {
    const it = await item();
    await api('POST', `/api/items/${it.id}/messages`, { who: 'you', text: 'Do it' });
    const claimed = await api('POST', `/api/items/${it.id}/messages`, { who: 'agent', actor: 'spike', text: 'Picking this up' });
    expect(claimed.json.item.status).toBe('in-progress');
    expect(claimed.json.item.updatedBy).toBe('spike');
    const version = claimed.json.item.version;
    const comment = await api('POST', `/api/items/${it.id}/messages`, { who: 'agent', actor: 'codex', text: 'FYI, related PR is open' });
    expect(comment.status).toBe(201);
    expect(comment.json.item.status).toBe('in-progress');
    expect(comment.json.item.updatedBy).toBe('spike');
    expect(comment.json.item.version).toBe(version);
    expect(comment.json.item.messages.at(-1).author).toBe('codex');
  });
});

describe('one name field: actor', () => {
  test('actor signs a message; author is still accepted; actor wins when both are sent', async () => {
    const it = await item();
    const a = await api('POST', `/api/items/${it.id}/messages`, { who: 'agent', actor: 'spike', text: 'one' });
    expect(a.json.message.author).toBe('spike');
    const b = await api('POST', `/api/items/${it.id}/messages`, { who: 'agent', author: 'old-writer', text: 'two' });
    expect(b.json.message.author).toBe('old-writer');
    const c = await api('POST', `/api/items/${it.id}/messages`, { who: 'agent', actor: 'spike', author: 'ignored', text: 'three' });
    expect(c.json.message.author).toBe('spike');
  });

  test('actor records a checklist result; by is still accepted; an unsigned result is the human', async () => {
    const it = await item('acme', { checks: [{ id: 's1', label: '1. Open it' }, { id: 's2', label: '2. Read it' }, { id: 's3', label: '3. Close it' }] });
    const a = await api('PATCH', `/api/items/${it.id}/checks/s1`, { result: 'pass', actor: 'sam' });
    expect(a.json.item.checks[0].by).toBe('sam');
    const b = await api('PATCH', `/api/items/${it.id}/checks/s2`, { result: 'pass', by: 'old-writer' });
    expect(b.json.item.checks[1].by).toBe('old-writer');
    const c = await api('PATCH', `/api/items/${it.id}/checks/s3`, { result: 'pass' });
    expect(c.json.item.checks[2].by).toBe('you');
  });

  test('actor on an edit is what updatedBy shows', async () => {
    const it = await item();
    const res = await api('PATCH', `/api/items/${it.id}`, { status: 'in-progress', actor: 'spike', ifVersion: it.version });
    expect(res.json.item.updatedBy).toBe('spike');
  });
});

describe('checklist steps over the API', () => {
  test('a fail without a note is refused with the step named; with a note it lands', async () => {
    const it = await item('acme', { checks: [{ id: 's1', label: '1. Switch is visible' }] });
    const bare = await api('PATCH', `/api/items/${it.id}/checks/s1`, { result: 'fail', actor: 'sam' });
    expect(bare.status).toBe(400);
    expect(bare.json.error).toContain('1. Switch is visible');
    expect(bare.json.error).toContain('a note is required');
    const noted = await api('PATCH', `/api/items/${it.id}/checks/s1`, { result: 'fail', note: 'thumb invisible in dark', actor: 'sam' });
    expect(noted.status).toBe(200);
    expect(noted.json.item.checks[0]).toMatchObject({ result: 'fail', note: 'thumb invisible in dark', by: 'sam' });
  });

  test('a result outside the closed set is refused', async () => {
    const it = await item('acme', { checks: [{ id: 's1', label: '1.' }] });
    const res = await api('PATCH', `/api/items/${it.id}/checks/s1`, { result: 'meh' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("result must be '', pass, fail or skip");
  });
});

describe('documents', () => {
  test('the body is served at its own URL with the sandbox headers', async () => {
    const it = await item('acme', { kind: 'document', bodyFormat: 'html', body: '<h1>Spec</h1>' });
    const res = await api('GET', `/api/items/${it.id}/body`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('<h1>Spec</h1>');
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('the list strips the body and reports its length', async () => {
    const it = await item('acme', { kind: 'document', body: 'x'.repeat(500) });
    const res = await api('GET', '/api/projects/acme');
    const row = res.json.items.find((i: any) => i.id === it.id);
    expect(row.body).toBe('');
    expect(row.bodyLength).toBe(500);
  });
});

describe('author repair', () => {
  test('renames every signature and last-actor in one project, and only that project', async () => {
    const a = await item('acme');
    await api('POST', `/api/items/${a.id}/messages`, { who: 'agent', actor: 'claude-code', text: 'one' });
    await api('POST', `/api/items/${a.id}/messages`, { who: 'agent', actor: 'Claude-Code', text: 'two' });
    await api('PATCH', `/api/items/${a.id}`, { status: 'in-progress', actor: 'claude-code' });
    const other = await item('other');
    await api('POST', `/api/items/${other.id}/messages`, { who: 'agent', actor: 'claude-code', text: 'elsewhere' });

    const res = await api('PATCH', '/api/projects/acme/authors', { from: 'claude-code', to: 'spike', actor: 'spike' });
    expect(res.status).toBe(200);
    expect(res.json.moved).toEqual({ messages: 2, items: 1 });

    const after = await api('GET', `/api/items/${a.id}`);
    expect(after.json.item.updatedBy).toBe('spike');
    expect(after.json.item.messages.map((m: any) => m.author)).toEqual(['spike', 'spike']);
    const untouched = await api('GET', `/api/items/${other.id}`);
    expect(untouched.json.item.messages[0].author).toBe('claude-code');
  });

  test('an empty target is refused: an unsigned message is what the rule exists to prevent', async () => {
    await project();
    const res = await api('PATCH', '/api/projects/acme/authors', { from: 'claude-code', to: '' });
    expect(res.status).toBe(400);
  });
});
