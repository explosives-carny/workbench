// Public item references are a routing contract, not merely a label. These
// probes keep creation, retries, key history, and content recovery aligned.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, Store } from '../src/db.ts';
import { createHandler } from '../src/app.ts';
import { exportAll, importAll } from '../src/export.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, readFileSync, rmSync } from 'fs';

let dbPath: string;
let dbPaths: string[];
let exportDir: string | undefined;
let store: Store;
let handler: (req: Request) => Promise<Response>;

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

beforeEach(() => {
  dbPath = join(tmpdir(), `workbench-api-refs-${Math.random().toString(36).slice(2)}.db`);
  dbPaths = [dbPath];
  exportDir = undefined;
  store = new Store(openDb(dbPath));
  handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
});

afterEach(() => {
  for (const path of dbPaths) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(path + suffix); } catch {}
    }
  }
  if (exportDir) rmSync(exportDir, { recursive: true, force: true });
});

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
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
  return { status: res.status, json };
}

async function demoProject(key = 'demo'): Promise<void> {
  const res = await api('POST', '/api/projects', { name: 'Demo', key });
  expect(res.status).toBe(201);
}

describe('public item references', () => {
  test('validates project keys when projects are created', async () => {
    const created = await api('POST', '/api/projects', { name: 'Demo', key: 'demo' });
    expect(created.status).toBe(201);
    expect(created.json.project.key).toBe('DEMO');

    const invalid = await api('POST', '/api/projects', { name: 'Bad', key: 'd' });
    expect(invalid.status).toBe(400);

    const conflict = await api('POST', '/api/projects', { name: 'Other', key: 'DEMO' });
    expect(conflict.status).toBe(409);
    expect(conflict.json.conflict).toBe('key');
  });

  test('assigns sequence references and resolves them case-insensitively', async () => {
    await demoProject();
    const created = await api('POST', '/api/projects/demo/items', [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }]);
    expect(created.status).toBe(201);
    expect(created.json.items.map((item: any) => item.seq)).toEqual([1, 2, 3]);
    expect(created.json.items.map((item: any) => item.ref)).toEqual(['WB-DEMO-1', 'WB-DEMO-2', 'WB-DEMO-3']);

    const board = await api('GET', '/api/projects/demo');
    expect(board.json.items.map((item: any) => [item.seq, item.ref])).toEqual([
      [1, 'WB-DEMO-1'], [2, 'WB-DEMO-2'], [3, 'WB-DEMO-3'],
    ]);

    const resolved = await api('GET', '/api/items/wb-demo-2');
    expect(resolved.status).toBe(200);
    expect(resolved.json.item.seq).toBe(2);
  });

  test('accepts references on message, edit, and check sub-routes', async () => {
    await demoProject();
    const created = await api('POST', '/api/projects/demo/items', [
      { title: 'One' },
      { title: 'Checked', checks: [{ id: 's1', label: '1. Confirm it' }] },
    ]);
    const checked = created.json.items[1];

    const message = await api('POST', '/api/items/WB-DEMO-1/messages', { who: 'agent', text: 'hi', actor: 'a' });
    expect(message.status).toBe(201);
    const messages = await api('GET', '/api/items/wb-demo-1/messages');
    expect(messages.status).toBe(200);
    expect(messages.json.messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'hi', author: 'a' })]));

    const edited = await api('PATCH', '/api/items/wb-demo-1', { title: 'New', actor: 'a' });
    expect(edited.status).toBe(200);
    expect(edited.json.item).toMatchObject({ ref: 'WB-DEMO-1', title: 'New' });

    const check = await api('PATCH', `/api/items/${checked.ref.toLowerCase()}/checks/s1`, { result: 'pass', actor: 'a' });
    expect(check.status).toBe(200);
  });

  test('does not consume another sequence when clientId retries a batch', async () => {
    await demoProject();
    const batch = [{ title: 'One', clientId: 'x1' }, { title: 'Two', clientId: 'x2' }];
    const first = await api('POST', '/api/projects/demo/items', batch);
    const retry = await api('POST', '/api/projects/demo/items', batch);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.json.items.map((item: any) => item.id)).toEqual(first.json.items.map((item: any) => item.id));

    const next = await api('POST', '/api/projects/demo/items', { title: 'Three' });
    const highestFirstSeq = Math.max(...first.json.items.map((item: any) => item.seq));
    expect(next.json.items[0].seq).toBe(highestFirstSeq + 1);
  });

  test('assigns every sequence exactly once across concurrent batches', async () => {
    await demoProject();
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, batch) => api(
        'POST',
        '/api/projects/demo/items',
        Array.from({ length: 4 }, (_, index) => ({ title: `Item ${batch}-${index}` }))
      ))
    );
    const sequences = responses.flatMap((response) => response.json.items.map((item: any) => item.seq)).sort((a: number, b: number) => a - b);
    expect(sequences).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  test('preserves legacy keys while a project key changes', async () => {
    const project = await api('POST', '/api/projects', { name: 'Demo' });
    const created = await api('POST', '/api/projects/demo/items', { title: 'One' });
    expect(created.json.items[0]).toMatchObject({ seq: 1, ref: null });

    const keyed = await api('PATCH', '/api/projects/demo', { key: 'demo' });
    expect(keyed.status).toBe(200);
    const afterKey = await api('GET', `/api/items/${created.json.items[0].id}`);
    expect(afterKey.json.item.ref).toBe('WB-DEMO-1');

    const renamed = await api('PATCH', '/api/projects/demo', { key: 'ACME' });
    expect(renamed.status).toBe(200);
    expect(renamed.json.warning).toBeDefined();
    const legacy = await api('GET', '/api/items/WB-DEMO-1');
    expect(legacy.status).toBe(200);
    expect(legacy.json.item.ref).toBe('WB-ACME-1');

    const other = await api('POST', '/api/projects', { name: 'Other' });
    expect(other.status).toBe(201);
    const collision = await api('PATCH', '/api/projects/other', { key: 'DEMO' });
    expect(collision.status).toBe(409);
    const absent = await api('PATCH', '/api/projects/demo', { key: null });
    expect(absent.status).toBe(400);
    const invalid = await api('PATCH', '/api/projects/demo', { key: 'x!' });
    expect(invalid.status).toBe(400);
    expect(project.status).toBe(201);
  });

  test('advertises the current contract version', async () => {
    const response = await api('GET', '/api');
    expect(response.status).toBe(200);
    expect(response.json.contractVersion).toBe('11');
  });

  test('round-trips current and former keys, sequence state, and references', async () => {
    await demoProject();
    const created = await api('POST', '/api/projects/demo/items', [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }]);
    const renamed = await api('PATCH', '/api/projects/demo', { key: 'ACME' });
    expect(renamed.status).toBe(200);
    const originalProject = store.getProject('demo')!;
    const originalItems = store.listItems(originalProject.id, 'none');

    exportDir = mkdtempSync(join(tmpdir(), 'workbench-refs-export-'));
    const exported = exportAll(store, exportDir);
    expect(exported).toMatchObject({ projects: 1, items: 3 });
    const file = JSON.parse(readFileSync(join(exportDir, 'demo.json'), 'utf8'));
    expect(file.project).toMatchObject({ key: 'ACME', oldKeys: ['DEMO'], nextSeq: originalProject.nextSeq });
    expect(file.items.map((item: any) => [item.seq, item.ref])).toEqual(originalItems.map((item) => [item.seq, item.ref]));

    const freshDbPath = join(tmpdir(), `workbench-api-refs-import-${Math.random().toString(36).slice(2)}.db`);
    dbPaths.push(freshDbPath);
    const fresh = new Store(openDb(freshDbPath));
    const imported = importAll(fresh, exportDir, () => {});
    expect(imported).toEqual({ projects: 1, items: 3 });

    const restoredProject = fresh.getProject('demo')!;
    const restoredItems = fresh.listItems(restoredProject.id, 'none');
    expect(restoredProject).toMatchObject({ key: 'ACME', oldKeys: ['DEMO'], nextSeq: originalProject.nextSeq });
    expect(restoredItems.map((item) => [item.seq, item.ref])).toEqual(originalItems.map((item) => [item.seq, item.ref]));
    expect(fresh.resolveItem('WB-DEMO-2')).toMatchObject({ seq: 2, ref: 'WB-ACME-2' });
    expect(created.status).toBe(201);
  });
});
