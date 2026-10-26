// The needs-qa with every step recorded: a finished round set back to QA
// reads as unchecked work. The write lands with a warning naming where the
// item belongs (blocked on the release, or complete).
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
  const p = join(tmpdir(), `workbench-qa-finished-${tag}-${Math.random().toString(36).slice(2)}.db`);
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

async function checkedIssue(results: ('pass' | 'fail' | null)[]): Promise<any> {
  expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
  const checks = results.map((_, i) => ({ id: `s${i + 1}`, label: `Step ${i + 1}`, owner: 'agent' }));
  const created = await api('POST', '/api/projects/demo/items', { title: 'Ship the scanner fix', status: 'needs-qa', checks });
  const item = created.json.item ?? created.json.items[0];
  for (const [i, r] of results.entries()) {
    if (r) expect((await api('PATCH', `/api/items/${item.id}/checks/s${i + 1}`, { result: r, note: 'seen on screen', actor: 'qa' })).status).toBe(200);
  }
  return (await api('GET', `/api/items/${item.id}`)).json.item;
}

describe('needs-qa with no open steps', () => {
  test('a reply that sets a signed-off item back to needs-qa lands with a warning naming blocked and complete', async () => {
    const item = await checkedIssue(['pass', 'pass']);
    expect(item.status).toBe('received');
    const res = await api('POST', `/api/items/${item.id}/messages`, { text: 'QA passed; held for the release.', status: 'needs-qa', author: 'builder' });
    expect(res.status).toBe(201);
    expect(res.json.item.status).toBe('needs-qa');
    expect(String(res.json.warning)).toContain('every step already has a result');
    expect(String(res.json.warning)).toContain('"blocked" with blockedBy');
  });

  test('a PATCH to needs-qa on a fully recorded item warns', async () => {
    const item = await checkedIssue(['pass', 'fail']);
    const res = await api('PATCH', `/api/items/${item.id}`, { status: 'needs-qa', actor: 'builder', ifVersion: item.version });
    expect(res.status).toBe(200);
    expect(String(res.json.warning)).toContain('nothing is left to run');
  });

  test('needs-qa with an open step does not warn', async () => {
    const item = await checkedIssue(['pass', null]);
    expect(item.status).toBe('needs-qa');
    const res = await api('POST', `/api/items/${item.id}/messages`, { text: 'Step 2 is ready to run.', status: 'needs-qa', author: 'builder' });
    expect(String(res.json.warning ?? '')).not.toContain('every step already has a result');
  });

  test('blocked on the release does not warn, and the audit lists only the needs-qa case', async () => {
    const item = await checkedIssue(['pass']);
    const ok = await api('PATCH', `/api/items/${item.id}`, { status: 'blocked', blockedBy: 'release 1.15.0', actor: 'builder', ifVersion: item.version });
    expect(String(ok.json.warning ?? '')).not.toContain('every step already has a result');
    let audit = await api('GET', '/api/audit');
    expect(JSON.stringify(audit.json)).not.toContain('qa-without-open-steps');
    await api('PATCH', `/api/items/${item.id}`, { status: 'needs-qa', actor: 'builder', ifVersion: ok.json.item.version });
    audit = await api('GET', '/api/audit');
    expect(JSON.stringify(audit.json)).toContain('qa-without-open-steps');
  });
});
