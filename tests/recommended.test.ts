// A decision names the option the agent recommends (AGENTS.md rule 6,
// contract v16). The field is `recommended`, a subset of `options`; marking
// it in the option text ("B (Recommended)") is what it replaces. A missing
// recommendation is warned in v16 (refused from v17); one that names no option
// is refused now. Older items stay editable and answerable.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { openDb, Store } from '../src/db.ts';
import { createHandler } from '../src/app.ts';
import { exportAll, importAll } from '../src/export.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, readFileSync, rmSync } from 'fs';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

let paths: string[];
let store: Store;
let handler: (req: Request) => Promise<Response>;

function tmpDb(tag: string): string {
  const p = join(tmpdir(), `workbench-recommended-${tag}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(p);
  return p;
}

beforeEach(async () => {
  paths = [];
  store = new Store(openDb(tmpDb('main')));
  handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
  expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
});

afterEach(() => {
  for (const p of paths) for (const s of ['', '-wal', '-shm']) { try { rmSync(p + s, { recursive: true }); } catch {} }
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

const ask = (item: Record<string, unknown>) => api('POST', '/api/projects/demo/items', { title: 'Which one?', ...item });

// An item filed before the rule: options, no recommendation. Written through
// the store, which is what the API used to accept and what an import writes.
function legacyDecision(): string {
  const project = store.getProject('demo')!;
  return store.createItem(project.id, { title: 'Old question', options: ['A', 'B'] }).id;
}

describe('creating a decision', () => {
  test('options without recommended land with a warning that names the field and v17', async () => {
    const res = await ask({ options: ['A', 'B'] });
    expect(res.status).toBe(201);
    const warned = res.json.warnings.join(' ');
    expect(warned).toContain('"recommended"');
    expect(warned).toContain('v17');
  });

  test('a decision with a recommendation carries no recommendation warning', async () => {
    const res = await ask({ options: ['A', 'B'], recommended: ['A'] });
    expect(res.json.warnings).toBeUndefined();
  });

  test('one option ending "(Recommended)" is converted into the field', async () => {
    const res = await ask({ options: ['A', 'B (Recommended)'] });
    expect(res.status).toBe(201);
    expect(res.json.items[0].options).toEqual(['A', 'B']);
    expect(res.json.items[0].recommended).toEqual(['B']);
    expect(res.json.warnings.join(' ')).toContain('send the field instead of the suffix');
  });

  test('two "(Recommended)" options are not converted, and are warned about', async () => {
    const res = await ask({ options: ['A (Recommended)', 'B (recommended)'] });
    expect(res.status).toBe(201);
    expect(res.json.items[0].recommended).toEqual([]);
    expect(res.json.warnings.join(' ')).toContain('list the option in "recommended" instead');
  });

  test('an empty string cannot be the recommendation', async () => {
    const res = await ask({ options: ['', 'B'], recommended: [''] });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('non-empty');
  });

  test('a clientId retry of an item filed before the rule returns it without a warning', async () => {
    const project = store.getProject('demo')!;
    const old = store.createItem(project.id, { title: 'Old question', options: ['A', 'B'], clientId: 'r1' });
    const res = await ask({ title: 'Old question', options: ['A', 'B'], clientId: 'r1' });
    expect(res.status).toBe(201);
    expect(res.json.items[0].id).toBe(old.id);
    expect(res.json.warnings).toBeUndefined();
  });

  test('a recommendation that is not one of the options is refused', async () => {
    const res = await ask({ options: ['A', 'B'], recommended: ['C'] });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('"C" is not one of the options');
  });

  test('recommended must be an array of strings', async () => {
    expect((await ask({ options: ['A', 'B'], recommended: 'A' })).status).toBe(400);
    expect((await ask({ options: ['A', 'B'], recommended: [1] })).status).toBe(400);
  });

  test('a valid recommendation lands and reads back', async () => {
    const res = await ask({ options: ['A', 'B'], recommended: ['B'] });
    expect(res.status).toBe(201);
    expect(res.json.ignored).toBeUndefined();
    const id = res.json.items[0].id;
    expect((await api('GET', `/api/items/${id}`)).json.item.recommended).toEqual(['B']);
  });

  test('more than one option may be recommended; duplicates collapse', async () => {
    const res = await ask({ options: ['A', 'B', 'C'], recommended: ['A', 'C', 'A'] });
    expect(res.status).toBe(201);
    expect(res.json.items[0].recommended).toEqual(['A', 'C']);
  });

  test('a batch with one bad recommendation lands nothing', async () => {
    const res = await api('POST', '/api/projects/demo/items', [
      { title: 'good', options: ['A', 'B'], recommended: ['A'] },
      { title: 'bad', options: ['A', 'B'], recommended: ['Z'] },
    ]);
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('"bad"');
    expect(store.listItems(store.getProject('demo')!.id)).toHaveLength(0);
  });

  test('work in progress with options is not a decision and needs no recommendation', async () => {
    expect((await ask({ status: 'in-progress', options: ['A', 'B'] })).status).toBe(201);
  });

  test('an explicit decision with no options lands with a warning', async () => {
    const res = await ask({ status: 'needs-decision' });
    expect(res.status).toBe(201);
    expect(res.json.warnings.join(' ')).toContain('no options');
  });

  test('a plain issue with no status and no options does not warn', async () => {
    const res = await ask({});
    expect(res.status).toBe(201);
    expect(res.json.warnings).toBeUndefined();
  });

  test('an option that says "recommended" in its text is warned about', async () => {
    const res = await ask({ options: ['A, recommended by vendor', 'B'], recommended: ['B'] });
    expect(res.status).toBe(201);
    expect(res.json.warnings.join(' ')).toContain('list the option in "recommended" instead');
  });
});

describe('changing an item', () => {
  test('new options that drop the recommendation are warned about on a decision', async () => {
    const id = (await ask({ options: ['A', 'B'], recommended: ['B'] })).json.items[0].id;
    const res = await api('PATCH', `/api/items/${id}`, { options: ['A', 'C'] });
    expect(res.status).toBe(200);
    expect(res.json.item.recommended).toEqual([]);
    expect(res.json.warning).toContain('"recommended"');
  });

  test('new options with a "(Recommended)" suffix are converted on a PATCH', async () => {
    const id = (await ask({ options: ['A', 'B'], recommended: ['B'] })).json.items[0].id;
    const res = await api('PATCH', `/api/items/${id}`, { options: ['A (Recommended)', 'C'] });
    expect(res.status).toBe(200);
    expect(res.json.item.options).toEqual(['A', 'C']);
    expect(res.json.item.recommended).toEqual(['A']);
  });

  test('turning a document with options into an issue is checked like a move into needs-decision', async () => {
    const project = store.getProject('demo')!;
    const doc = store.createItem(project.id, { title: 'Spec', kind: 'document', options: ['A', 'B'] });
    const res = await api('PATCH', `/api/items/${doc.id}`, { kind: 'issue' });
    expect(res.status).toBe(200);
    expect(res.json.item.status).toBe('needs-decision');
    expect(res.json.warning).toContain('"recommended"');
  });

  test('new options keep a recommendation still offered', async () => {
    const id = (await ask({ options: ['A', 'B'], recommended: ['B'] })).json.items[0].id;
    const res = await api('PATCH', `/api/items/${id}`, { options: ['B', 'C'] });
    expect(res.status).toBe(200);
    expect(res.json.item.recommended).toEqual(['B']);
  });

  test('emptying the options of a decision warns rather than refuses', async () => {
    const id = (await ask({ options: ['A', 'B'], recommended: ['B'] })).json.items[0].id;
    const res = await api('PATCH', `/api/items/${id}`, { options: [] });
    expect(res.status).toBe(200);
    expect(res.json.item.recommended).toEqual([]);
    expect(res.json.warning).toContain('no options');
  });

  test('an unknown recommendation on a PATCH is refused', async () => {
    const id = (await ask({ options: ['A', 'B'], recommended: ['B'] })).json.items[0].id;
    expect((await api('PATCH', `/api/items/${id}`, { recommended: ['Z'] })).status).toBe(400);
  });

  test('the status select can reopen an older decision; it is warned, never refused', async () => {
    const id = legacyDecision();
    await api('PATCH', `/api/items/${id}`, { choice: 'A', status: 'received' });
    const res = await api('PATCH', `/api/items/${id}`, { status: 'needs-decision' });
    expect(res.status).toBe(200);
    expect(res.json.item.status).toBe('needs-decision');
    expect(res.json.warning).toContain('"recommended"');
  });

  test('a legacy decision can still be retitled and labelled', async () => {
    const id = legacyDecision();
    expect((await api('PATCH', `/api/items/${id}`, { title: 'Renamed' })).status).toBe(200);
    expect((await api('PATCH', `/api/items/${id}`, { labels: ['x'] })).status).toBe(200);
  });

  test('a person can still answer a legacy decision', async () => {
    const id = legacyDecision();
    const res = await api('PATCH', `/api/items/${id}`, { choice: 'A', status: 'received' });
    expect(res.status).toBe(200);
    expect(res.json.item.choice).toBe('A');
  });

  test('a legacy decision gains a recommendation with one PATCH', async () => {
    const id = legacyDecision();
    const res = await api('PATCH', `/api/items/${id}`, { recommended: ['B'] });
    expect(res.status).toBe(200);
    expect(res.json.item.recommended).toEqual(['B']);
  });
});

describe('replying', () => {
  test('a reply that moves an optioned item back to needs-decision lands and says which PATCH adds the recommendation', async () => {
    const id = (await ask({ status: 'in-progress', options: ['A', 'B'] })).json.items[0].id;
    const res = await api('POST', `/api/items/${id}/messages`, { who: 'agent', text: 'back to you', status: 'needs-decision' });
    expect(res.status).toBe(201);
    expect(res.json.warning).toContain(`PATCH /api/items/${id}`);
  });

  test('a person replying on a legacy decision is not refused', async () => {
    const id = legacyDecision();
    expect((await api('POST', `/api/items/${id}/messages`, { who: 'you', text: 'hmm' })).status).toBe(201);
  });
});

describe('storage', () => {
  test('an old database without the column opens and gains it', () => {
    const path = tmpDb('legacy');
    const raw = new Database(path, { create: true });
    raw.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT);
      CREATE TABLE items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, context TEXT NOT NULL, options TEXT NOT NULL, choice TEXT NOT NULL, status TEXT NOT NULL, section TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO projects VALUES ('p', 'old', 'Old', '', '2020-01-01T00:00:00.000Z', NULL);
      INSERT INTO items VALUES ('i', 'p', 'q', '', '["A","B"]', '', 'needs-decision', '', 0, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    `);
    raw.close();
    const migrated = new Store(openDb(path));
    expect(migrated.getItem('i')!.recommended).toEqual([]);
    expect(migrated.getItem('i')!.options).toEqual(['A', 'B']);
  });

  test('export carries recommended and import restores it', async () => {
    await ask({ title: 'new', options: ['A', 'B'], recommended: ['B'] });
    legacyDecision();
    const dir = mkdtempSync(join(tmpdir(), 'wb-recommended-export-'));
    paths.push(dir);
    exportAll(store, dir);
    expect(readFileSync(join(dir, 'demo.json'), 'utf8')).toContain('"recommended"');
    const target = new Store(openDb(tmpDb('target')));
    importAll(target, dir, () => {});
    const items = target.listItems(target.getProject('demo')!.id);
    expect(items.find((i) => i.title === 'new')!.recommended).toEqual(['B']);
    // A restore of an item filed before the rule does not fail.
    expect(items.find((i) => i.title === 'Old question')!.recommended).toEqual([]);
  });
});
