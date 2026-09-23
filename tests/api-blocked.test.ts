// The blocked status: committed work waiting on other work. Distinct from
// deferred (parked, may not come back) — filing blocked work as deferred made
// it read as abandoned.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, Store } from '../src/db.ts';
import { createHandler } from '../src/app.ts';
import { exportAll, importAll } from '../src/export.ts';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

let dbPaths: string[];
let dirs: string[];
let store: Store;
let handler: (req: Request) => Promise<Response>;

function tmpDb(tag: string): string {
  const p = join(tmpdir(), `workbench-blocked-${tag}-${Math.random().toString(36).slice(2)}.db`);
  dbPaths.push(p);
  return p;
}

beforeEach(() => {
  dbPaths = [];
  dirs = [];
  store = new Store(openDb(tmpDb('main')));
  handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
});

afterEach(() => {
  for (const p of dbPaths) for (const s of ['', '-wal', '-shm']) { try { rmSync(p + s); } catch {} }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
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

async function oneIssue(): Promise<any> {
  expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
  const created = await api('POST', '/api/projects/demo/items', { title: 'Turn the flag on after the deploy' });
  return created.json.item ?? created.json.items[0];
}

describe('blocked status', () => {
  test('an issue can be blocked with what it waits on, and the ref still resolves', async () => {
    const item = await oneIssue();
    const res = await api('PATCH', `/api/items/${item.ref}`, { status: 'blocked', blockedBy: 'WB-DEMO-2 merged', actor: 't', ifVersion: item.version });
    expect(res.status).toBe(200);
    expect(res.json.item).toMatchObject({ status: 'blocked', blockedBy: 'WB-DEMO-2 merged' });
    expect(res.json.warning).toBeUndefined();
    const read = await api('GET', `/api/items/${item.ref}`);
    expect((read.json.item ?? read.json).blockedBy).toBe('WB-DEMO-2 merged');
  });

  test('blocking with no blockedBy is accepted with a warning', async () => {
    const item = await oneIssue();
    const res = await api('PATCH', `/api/items/${item.id}`, { status: 'blocked', actor: 't', ifVersion: item.version });
    expect(res.status).toBe(200);
    expect(res.json.item.status).toBe('blocked');
    expect(String(res.json.warning)).toContain('blockedBy');
  });

  test('a stored blockedBy satisfies a later block without the warning, and survives leaving blocked', async () => {
    const item = await oneIssue();
    const first = await api('PATCH', `/api/items/${item.id}`, { status: 'blocked', blockedBy: 'deploy of the release', actor: 't', ifVersion: item.version });
    const moved = await api('PATCH', `/api/items/${item.id}`, { status: 'in-progress', actor: 't', ifVersion: first.json.item.version });
    expect(moved.json.item.blockedBy).toBe('deploy of the release');
    const again = await api('PATCH', `/api/items/${item.id}`, { status: 'blocked', actor: 't', ifVersion: moved.json.item.version });
    expect(again.json.warning).toBeUndefined();
  });

  test('a document cannot be blocked', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    const doc = await api('POST', '/api/projects/demo/items', { title: 'Notes', kind: 'document', status: 'blocked' });
    expect([201, 400]).toContain(doc.status);
    if (doc.status === 201) expect((doc.json.item ?? doc.json.items[0]).status).toBe('active');
  });

  test('blockedBy round-trips through export and import', async () => {
    const item = await oneIssue();
    await api('PATCH', `/api/items/${item.id}`, { status: 'blocked', blockedBy: 'PR 14 merged', actor: 't', ifVersion: item.version });
    const dir = mkdtempSync(join(tmpdir(), 'workbench-blocked-export-'));
    dirs.push(dir);
    exportAll(store, dir);
    const fresh = new Store(openDb(tmpDb('import')));
    importAll(fresh, dir, () => {});
    const restored = fresh.listItems(fresh.getProject('demo')!.id, 'none');
    expect(restored[0]).toMatchObject({ status: 'blocked', blockedBy: 'PR 14 merged' });
  });

  test('the migration restores blocked_by on a database that predates it, idempotently', () => {
    const path = tmpDb('old');
    const seeded = new Store(openDb(path));
    const p = seeded.createProject({ name: 'Demo' } as any);
    seeded.createItem(p.id, { title: 'kept' });
    const raw = new Database(path);
    raw.exec('ALTER TABLE items DROP COLUMN blocked_by');
    raw.close();
    for (let i = 0; i < 2; i++) {
      const again = new Store(openDb(path));
      const items = again.listItems(again.getProject('demo')!.id, 'none');
      expect(items.map((it) => [it.title, it.blockedBy])).toEqual([['kept', '']]);
    }
  });

});
