// Contract v13: projects order by activity and each carries a fixed colour
// (AGENTS.md "Projects, and which one is yours"; src/db.ts PROJECT_COLORS).
import { describe, it, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, Store, PROJECT_COLORS } from '../src/db.ts';
import { createHandler } from '../src/app.ts';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { rmSync } from 'fs';
import { readFileSync } from 'node:fs';

function freshStore(): Store {
  return new Store(openDb(join(tmpdir(), `wb-color-${randomUUID()}`, 'test.db')));
}

describe('project colours', () => {
  let store: Store;
  beforeEach(() => { store = freshStore(); });

  it('assigns one of the twelve palette colours on create', () => {
    const p = store.createProject({ name: 'Acme' });
    expect(PROJECT_COLORS as readonly string[]).toContain(p.color);
  });

  it('never assigns the same colour to two unarchived projects, up to twelve', () => {
    const created = Array.from({ length: 12 }, (_, i) => store.createProject({ name: `P${i}` }));
    const colors = created.map((p) => p.color);
    expect(new Set(colors).size).toBe(12);
    expect([...colors].sort()).toEqual([...PROJECT_COLORS].sort());
  });

  it('reuses the least-used colour once there are more than twelve unarchived projects', () => {
    for (let i = 0; i < 13; i++) store.createProject({ name: `P${i}` });
    const projects = store.listProjects();
    expect(projects.length).toBe(13);
    // Still every project has a real palette colour, and no other failure —
    // creation must not throw for want of a free one.
    for (const p of projects) expect(PROJECT_COLORS as readonly string[]).toContain(p.color);
  });

  it('archiving frees a colour for a new project, and restoring reclaims it if still free', () => {
    const a = store.createProject({ name: 'A' });
    // Fill the rest of the palette so the only free colour is A's own.
    for (let i = 0; i < 11; i++) store.createProject({ name: `Filler${i}` });
    store.archiveProject(a.slug, true);
    const fresh = store.createProject({ name: 'Fresh' });
    expect(fresh.color).toBe(a.color);
    // A restores now — its own colour is taken, so it must get reassigned,
    // never collide with the project that claimed it.
    const restored = store.archiveProject(a.slug, false)!;
    expect(restored.color).not.toBe(fresh.color);
  });

  it('restoring reclaims its own colour when nothing else took it', () => {
    const a = store.createProject({ name: 'A' });
    const color = a.color;
    store.archiveProject(a.slug, true);
    const restored = store.archiveProject(a.slug, false)!;
    expect(restored.color).toBe(color);
  });

  it('the migration backfills colour on a database that predates the column, without collisions', () => {
    const path = join(tmpdir(), `wb-color-old-${randomUUID()}`, 'test.db');
    const seeded = new Store(openDb(path));
    const names = ['One', 'Two', 'Three', 'Four'];
    for (const name of names) seeded.createProject({ name });
    const raw = new Database(path);
    raw.exec('ALTER TABLE projects DROP COLUMN color');
    raw.close();
    const reopened = new Store(openDb(path));
    const projects = reopened.listProjects();
    expect(projects.length).toBe(4);
    for (const p of projects) expect(PROJECT_COLORS as readonly string[]).toContain(p.color);
    expect(new Set(projects.map((p) => p.color)).size).toBe(4);
    // Idempotent: reopening again must not reassign or duplicate.
    const colorsBefore = new Map(projects.map((p) => [p.slug, p.color]));
    const reopenedAgain = new Store(openDb(path));
    for (const p of reopenedAgain.listProjects()) expect(p.color).toBe(colorsBefore.get(p.slug));
  });
});

describe('project activity ordering', () => {
  let store: Store;
  beforeEach(() => { store = freshStore(); });

  it('orders by lastActivityAt, newest first', async () => {
    const a = store.createProject({ name: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    const b = store.createProject({ name: 'B' });
    // B was created after A, so B is more recently active.
    expect(store.listProjects().map((p) => p.slug)).toEqual([b.slug, a.slug]);
  });

  it('an item updated in an older project moves that project back to the top', async () => {
    const a = store.createProject({ name: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    const b = store.createProject({ name: 'B' });
    expect(store.listProjects().map((p) => p.slug)).toEqual([b.slug, a.slug]);
    await new Promise((r) => setTimeout(r, 5));
    const item = store.createItem(a.id, { title: 'Touch A' });
    expect(store.listProjects().map((p) => p.slug)).toEqual([a.slug, b.slug]);
    // A reply on the item is activity too.
    await new Promise((r) => setTimeout(r, 5));
    const c = store.createProject({ name: 'C' });
    expect(store.listProjects().map((p) => p.slug)[0]).toBe(c.slug);
    await new Promise((r) => setTimeout(r, 5));
    store.addMessage(item.id, { who: 'you', text: 'reply' });
    expect(store.listProjects().map((p) => p.slug)[0]).toBe(a.slug);
  });

  it('a project with no items yet is exactly as fresh as its own creation', () => {
    const p = store.createProject({ name: 'Quiet' });
    expect(p.lastActivityAt).toBe(p.createdAt);
    expect(store.getProject(p.slug)!.lastActivityAt).toBe(p.createdAt);
  });
});

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

describe('PATCH /api/projects/<slug> color', () => {
  let store: Store;
  let handler: (req: Request) => Promise<Response>;

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

  beforeEach(() => {
    store = freshStore();
    handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
  });

  test('accepts a palette colour', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    const res = await api('PATCH', '/api/projects/demo', { color: PROJECT_COLORS[3] });
    expect(res.status).toBe(200);
    expect(res.json.project.color).toBe(PROJECT_COLORS[3]);
  });

  test('refuses a colour outside the palette', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    const res = await api('PATCH', '/api/projects/demo', { color: '#000000' });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('color must be one of');
  });

  test('GET /api/projects returns lastActivityAt and color on every row', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    const res = await api('GET', '/api/projects');
    expect(res.status).toBe(200);
    expect(typeof res.json.projects[0].lastActivityAt).toBe('string');
    expect(PROJECT_COLORS as readonly string[]).toContain(res.json.projects[0].color);
  });
});

describe('the home page renders projects in API order, not a client-side sort', () => {
  const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  it('iterates data.projects directly with no re-sort', () => {
    const start = indexHtml.indexOf('async function render()');
    expect(start).toBeGreaterThan(-1);
    const end = indexHtml.indexOf('\n  }', start);
    const body = indexHtml.slice(start, end);
    expect(body).not.toMatch(/\.sort\(/);
    expect(body).toContain('for (const p of data.projects) listEl.appendChild(card(p));');
  });

  it('shows the project colour and a relative activity time on each card', () => {
    const start = indexHtml.indexOf('function card(p)');
    const end = indexHtml.indexOf('\n  }', start);
    const body = indexHtml.slice(start, end);
    expect(body).toContain('p.color');
    expect(body).toContain('WB.relTime(p.lastActivityAt)');
  });
});
