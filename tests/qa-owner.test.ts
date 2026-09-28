// Each QA step says who runs it — the person or an agent (AGENTS.md rule 8,
// contract v17). The item's QA type is derived from its steps: Human QA, Agent
// QA or Mixed QA, and who its open steps wait on. Unset reads as human.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { openDb, Store, qaOf } from '../src/db.ts';
import { createHandler } from '../src/app.ts';
import { exportAll, importAll } from '../src/export.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

let paths: string[];
let store: Store;
let handler: (req: Request) => Promise<Response>;

function tmpDb(tag: string): string {
  const p = join(tmpdir(), `workbench-qaowner-${tag}-${Math.random().toString(36).slice(2)}.db`);
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

const qa = (checks: unknown[], extra: Record<string, unknown> = {}) =>
  api('POST', '/api/projects/demo/items', { title: 'Check it', status: 'needs-qa', checks, ...extra });

describe('qaOf', () => {
  test('no steps is no QA', () => expect(qaOf([])).toEqual({ qa: '', qaWaitingOn: '' }));
  test('unset owners read as human', () => expect(qaOf([{ owner: '' }, {}])).toEqual({ qa: 'human', qaWaitingOn: 'human' }));
  test('all agent', () => expect(qaOf([{ owner: 'agent' }, { owner: 'agent' }])).toEqual({ qa: 'agent', qaWaitingOn: 'agent' }));
  test('one human among agents is mixed and waits on the human', () =>
    expect(qaOf([{ owner: 'agent' }, { owner: 'human' }, { owner: 'agent' }])).toEqual({ qa: 'mixed', qaWaitingOn: 'human' }));
  test('mixed with the human steps done waits on the agent', () =>
    expect(qaOf([{ owner: 'human', result: 'pass' }, { owner: 'agent' }])).toEqual({ qa: 'mixed', qaWaitingOn: 'agent' }));
  test('mixed with the agent steps done waits on the human', () =>
    expect(qaOf([{ owner: 'human' }, { owner: 'agent', result: 'pass' }])).toEqual({ qa: 'mixed', qaWaitingOn: 'human' }));
  test('every step answered waits on nobody', () =>
    expect(qaOf([{ owner: 'human', result: 'pass' }, { owner: 'agent', result: 'fail' }])).toEqual({ qa: 'mixed', qaWaitingOn: '' }));
});

describe('writing steps with owners', () => {
  test('owners round-trip and the item reports its QA type', async () => {
    const res = await qa([{ label: 'run the suite', owner: 'agent' }, { label: 'look at it on the phone', owner: 'human' }]);
    expect(res.status).toBe(201);
    const id = res.json.items[0].id;
    const item = (await api('GET', `/api/items/${id}`)).json.item;
    expect(item.checks.map((c: any) => c.owner)).toEqual(['agent', 'human']);
    expect(item.qa).toBe('mixed');
    expect(item.qaWaitingOn).toBe('human');
    expect(res.json.warnings).toBeUndefined();
  });

  test('an unknown owner is refused', async () => {
    const res = await qa([{ label: 'x', owner: 'robot' }]);
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('human or agent');
  });

  test('steps with no owner land as human QA with a warning naming the count', async () => {
    const res = await qa([{ label: 'a' }, { label: 'b', owner: 'agent' }]);
    expect(res.status).toBe(201);
    expect(res.json.items[0].checks[0].owner).toBe('');
    expect(res.json.items[0].qa).toBe('mixed');
    expect(res.json.warnings.join(' ')).toContain('1 of 2 steps have no owner');
  });

  test('steps on work that is not at needs-qa are not warned about', async () => {
    const res = await qa([{ label: 'a' }], { status: 'in-progress' });
    expect(res.json.warnings).toBeUndefined();
  });

  test('replacing the steps keeps their new owners', async () => {
    const id = (await qa([{ label: 'a', owner: 'human' }])).json.items[0].id;
    const res = await api('PATCH', `/api/items/${id}`, { checks: [{ label: 'a', owner: 'agent' }], replaceChecks: true });
    expect(res.status).toBe(200);
    expect(res.json.item.qa).toBe('agent');
  });
});

describe('one step at a time', () => {
  test('an unanswered step can change owner without recording anything', async () => {
    const id = (await qa([{ label: 'a', owner: 'human' }, { label: 'b', owner: 'human' }])).json.items[0].id;
    const res = await api('PATCH', `/api/items/${id}/checks/c1`, { owner: 'agent', actor: 'spike' });
    expect(res.status).toBe(200);
    const step = res.json.item.checks[0];
    expect(step.owner).toBe('agent');
    expect(step.result).toBe('');
    expect(step.at).toBe('');
    expect(res.json.ignored).toBeUndefined();
  });

  test('a step with a result keeps its owner', async () => {
    const id = (await qa([{ label: 'a', owner: 'human' }, { label: 'b', owner: 'human' }])).json.items[0].id;
    await api('PATCH', `/api/items/${id}/checks/c1`, { result: 'pass' });
    const res = await api('PATCH', `/api/items/${id}/checks/c1`, { owner: 'agent' });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('already has a result');
  });

  test('recording a result keeps the owner', async () => {
    const id = (await qa([{ label: 'a', owner: 'agent' }, { label: 'b', owner: 'human' }])).json.items[0].id;
    const res = await api('PATCH', `/api/items/${id}/checks/c1`, { result: 'pass', actor: 'spike' });
    expect(res.json.item.checks[0].owner).toBe('agent');
    expect(res.json.item.qaWaitingOn).toBe('human');
  });

  test('an owner change on the last open step does not finish the round', async () => {
    const id = (await qa([{ label: 'a', owner: 'human' }, { label: 'b', owner: 'human' }])).json.items[0].id;
    await api('PATCH', `/api/items/${id}/checks/c1`, { result: 'pass' });
    const res = await api('PATCH', `/api/items/${id}/checks/c2`, { owner: 'agent' });
    expect(res.json.item.status).toBe('needs-qa');
  });

  test('an invalid owner on the step route is refused', async () => {
    const id = (await qa([{ label: 'a', owner: 'human' }])).json.items[0].id;
    expect((await api('PATCH', `/api/items/${id}/checks/c1`, { owner: 'bot' })).status).toBe(400);
  });
});

describe('storage', () => {
  test('steps saved before owners existed read as human QA', () => {
    const path = tmpDb('legacy');
    const raw = new Database(path, { create: true });
    raw.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT);
      CREATE TABLE items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, context TEXT NOT NULL, options TEXT NOT NULL, choice TEXT NOT NULL, status TEXT NOT NULL, section TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, checks TEXT NOT NULL DEFAULT '[]');
      INSERT INTO projects VALUES ('p', 'old', 'Old', '', '2020-01-01T00:00:00.000Z', NULL);
      INSERT INTO items VALUES ('i', 'p', 'q', '', '[]', '', 'needs-qa', '', 0, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '[{"id":"c1","label":"x","result":"","note":"","by":"","at":""}]');
    `);
    raw.close();
    const item = new Store(openDb(path)).getItem('i')!;
    expect(item.checks[0].owner).toBe('');
    expect(item.qa).toBe('human');
  });

  test('export and import carry step owners', async () => {
    await qa([{ label: 'a', owner: 'agent' }, { label: 'b', owner: 'human' }], { title: 'mixed one' });
    const dir = mkdtempSync(join(tmpdir(), 'wb-qaowner-export-'));
    paths.push(dir);
    exportAll(store, dir);
    const target = new Store(openDb(tmpDb('target')));
    importAll(target, dir, () => {});
    const item = target.listItems(target.getProject('demo')!.id).find((i) => i.title === 'mixed one')!;
    expect(item.checks.map((c) => c.owner)).toEqual(['agent', 'human']);
    expect(item.qa).toBe('mixed');
  });
});
