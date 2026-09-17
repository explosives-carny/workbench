// Labels get the near-duplicate warning sections already had, and a route of
// their own so a label field can offer the vocabulary without the whole board.
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
  dbPath = join(tmpdir(), `workbench-labels-${Math.random().toString(36).slice(2)}.db`);
  handler = createHandler(new Store(openDb(dbPath)), { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
});
afterEach(() => { for (const s of ['', '-wal', '-shm']) { try { rmSync(dbPath + s); } catch {} } });

async function api(method: string, path: string, body?: unknown) {
  const res = await handler(new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}
async function seed() {
  await api('POST', '/api/projects', { name: 'Acme', slug: 'acme' });
  return (await api('POST', '/api/projects/acme/items', [{ title: 'A', labels: ['Ship it', 'Design'] }, { title: 'B', labels: ['Design'] }])).json.items;
}

describe('label near-duplicates', () => {
  test('a new label that looks like one in use is warned about, naming the existing one, and still lands', async () => {
    await seed();
    const res = await api('POST', '/api/projects/acme/items', { title: 'C', labels: ['Designs'] });
    expect(res.status).toBe(201);
    expect(res.json.warnings).toHaveLength(1);
    expect(res.json.warnings[0]).toContain('label "Designs" looks like a duplicate of "Design"');
    expect(res.json.warnings[0]).toContain('/api/projects/acme/labels');
    expect(res.json.items[0].labels).toEqual(['Designs']);
  });

  test('an exact or case-only match is the same label and does not warn', async () => {
    await seed();
    const res = await api('POST', '/api/projects/acme/items', { title: 'C', labels: ['design', 'Ship it'] });
    expect(res.json.warnings).toBeUndefined();
  });

  test('a genuinely new label does not warn', async () => {
    await seed();
    const res = await api('POST', '/api/projects/acme/items', { title: 'C', labels: ['Cycle count'] });
    expect(res.json.warnings).toBeUndefined();
  });

  test('editing an item warns only about labels it did not already carry', async () => {
    const [a] = await seed();
    const same = await api('PATCH', `/api/items/${a.id}`, { labels: ['Ship it', 'Design'], actor: 'x', ifVersion: a.version });
    expect(same.json.warning).toBeUndefined();
    const dup = await api('PATCH', `/api/items/${a.id}`, { labels: ['Ship it', 'Design', 'Ship-it'], actor: 'x', ifVersion: same.json.item.version });
    expect(dup.json.warning).toContain('label "Ship-it" looks like a duplicate of "Ship it"');
  });

  test('GET /api/projects/<slug>/labels returns the vocabulary with counts, commonest first', async () => {
    await seed();
    const res = await api('GET', '/api/projects/acme/labels');
    expect(res.status).toBe(200);
    expect(res.json.labels).toEqual([{ name: 'Design', count: 2 }, { name: 'Ship it', count: 1 }]);
  });
});
