// A QA record cannot be overwritten by redefining the steps — unless the caller
// says so. Filed from the reference board after a requeue wiped seven results.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, Store } from '../src/db.ts';
import { createHandler } from '../src/app.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

let dbPath: string;
let handler: (req: Request) => Promise<Response>;
const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

beforeEach(() => {
  dbPath = join(tmpdir(), `workbench-checks-${Math.random().toString(36).slice(2)}.db`);
  handler = createHandler(new Store(openDb(dbPath)), { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
});
afterEach(() => { for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s); } catch {} } });

async function api(method: string, path: string, body?: unknown) {
  const res = await handler(new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}
async function qaItem() {
  await api('POST', '/api/projects', { name: 'Acme', slug: 'acme' });
  const it = (await api('POST', '/api/projects/acme/items', { title: 'Deploy?', status: 'needs-qa', checks: [{ id: 's1', label: '1.' }, { id: 's2', label: '2.' }, { id: 's3', label: '3.' }] })).json.items[0];
  await api('PATCH', `/api/items/${it.id}/checks/s1`, { result: 'pass', actor: 'qa' });
  await api('PATCH', `/api/items/${it.id}/checks/s2`, { result: 'fail', note: 'broken', actor: 'qa' });
  return (await api('GET', `/api/items/${it.id}`)).json.item;
}

describe('checks carry a record', () => {
  test('redefining steps over recorded results is refused, naming the steps, with the item attached', async () => {
    const it = await qaItem();
    const res = await api('PATCH', `/api/items/${it.id}`, { checks: [{ id: 'n1', label: 'new 1.' }], actor: 'a', ifVersion: it.version });
    expect(res.status).toBe(409);
    expect(res.json.conflict).toBe('checks');
    expect(res.json.stepsWithResults).toEqual(['s1', 's2']);
    expect(res.json.error).toContain('replaceChecks');
    const after = (await api('GET', `/api/items/${it.id}`)).json.item;
    expect(after.checks.map((c: any) => c.result)).toEqual(['pass', 'fail', '']);
    expect(after.version).toBe(it.version);
  });

  test('replaceChecks: true redefines them knowingly', async () => {
    const it = await qaItem();
    const res = await api('PATCH', `/api/items/${it.id}`, { checks: [{ id: 'n1', label: 'new 1.' }], replaceChecks: true, actor: 'a', ifVersion: it.version });
    expect(res.status).toBe(200);
    expect(res.json.item.checks).toHaveLength(1);
    expect(res.json.ignored).toBeUndefined();
  });

  test('steps with no results yet can still be redefined freely', async () => {
    await api('POST', '/api/projects', { name: 'Acme', slug: 'acme' });
    const it = (await api('POST', '/api/projects/acme/items', { title: 'X', checks: [{ id: 's1', label: '1.' }] })).json.items[0];
    const res = await api('PATCH', `/api/items/${it.id}`, { checks: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], actor: 'a', ifVersion: it.version });
    expect(res.status).toBe(200);
    expect(res.json.item.checks).toHaveLength(2);
  });

  test('an edit that does not touch checks is unaffected by recorded results', async () => {
    const it = await qaItem();
    const res = await api('PATCH', `/api/items/${it.id}`, { context: 'more detail', actor: 'a', ifVersion: it.version });
    expect(res.status).toBe(200);
    expect(res.json.item.checks.map((c: any) => c.result)).toEqual(['pass', 'fail', '']);
  });
});
