// The audit lists live items that are out of spec with the current contract
// (AGENTS.md, "When the contract version moves"), naming the rule and the fix.
// It reads; it never writes.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, Store } from '../src/db.ts';
import { createHandler } from '../src/app.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

let paths: string[];
let store: Store;
let handler: (req: Request) => Promise<Response>;

function tmpDb(tag: string): string {
  const p = join(tmpdir(), `workbench-audit-${tag}-${Math.random().toString(36).slice(2)}.db`);
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

// Items filed the way an older contract allowed: straight into the store,
// which is what the API accepted then and what an import writes.
function seedOld() {
  const project = store.getProject('demo')!;
  const put = (input: any) => store.createItem(project.id, input);
  return {
    decision: put({ title: 'Old decision', options: ['A', 'B'] }),
    textMarked: put({ title: 'Marked in text', options: ['A (Recommended)', 'B'], recommended: ['A (Recommended)'] }),
    qaNoSteps: put({ title: 'QA without steps', status: 'needs-qa' }),
    qaUnowned: put({ title: 'QA unowned', status: 'needs-qa', checks: [{ id: 'c1', label: 'x', result: '', note: '', by: '', at: '', owner: '' }] }),
    blocked: put({ title: 'Blocked', status: 'blocked' }),
    good: put({ title: 'Fine', options: ['A', 'B'], recommended: ['A'] }),
    finished: put({ title: 'Done long ago', options: ['A', 'B'], status: 'complete' }),
  };
}

describe('audit', () => {
  test('lists each out-of-spec item with the rule and a fix', async () => {
    const ids = seedOld();
    const res = await api('GET', '/api/projects/demo/audit');
    expect(res.status).toBe(200);
    expect(res.json.contractVersion).toBe('21');
    const rules = (id: string) => (res.json.items.find((i: any) => i.id === id)?.findings || []).map((f: any) => f.rule);
    expect(rules(ids.decision.id)).toEqual(['decision-without-recommendation']);
    expect(rules(ids.textMarked.id)).toEqual(['recommended-in-text']);
    expect(rules(ids.qaNoSteps.id)).toEqual(['qa-without-steps']);
    expect(rules(ids.qaUnowned.id)).toEqual(['qa-unowned-steps']);
    expect(rules(ids.blocked.id)).toEqual(['blocked-without-reason']);
    expect(res.json.total).toBe(5);
    for (const row of res.json.items) for (const f of row.findings) expect(f.message.length).toBeGreaterThan(10);
  });

  test('an item in spec, and finished work, are not listed', async () => {
    const ids = seedOld();
    const res = await api('GET', '/api/projects/demo/audit');
    const listed = res.json.items.map((i: any) => i.id);
    expect(listed).not.toContain(ids.good.id);
    expect(listed).not.toContain(ids.finished.id);
  });

  test('fixing an item takes it off the audit', async () => {
    const ids = seedOld();
    await api('PATCH', `/api/items/${ids.decision.id}`, { recommended: ['A'] });
    const res = await api('GET', '/api/projects/demo/audit');
    expect(res.json.items.map((i: any) => i.id)).not.toContain(ids.decision.id);
  });

  test('the board-wide audit covers every project and changes nothing', async () => {
    seedOld();
    await api('POST', '/api/projects', { name: 'Other', key: 'oth' });
    const project = store.getProject('other')!;
    store.createItem(project.id, { title: 'Other decision', options: ['X', 'Y'] });
    const before = JSON.stringify(store.listItems(store.getProject('demo')!.id, 'none'));
    const res = await api('GET', '/api/audit');
    expect(res.status).toBe(200);
    expect(res.json.projects.map((p: any) => p.slug).sort()).toEqual(['demo', 'other']);
    expect(res.json.total).toBe(6);
    expect(JSON.stringify(store.listItems(store.getProject('demo')!.id, 'none'))).toBe(before);
  });

  test('an empty project is in spec', async () => {
    const res = await api('GET', '/api/projects/demo/audit');
    expect(res.json.items).toEqual([]);
    expect(res.json.total).toBe(0);
  });
});
