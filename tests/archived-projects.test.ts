// Archived projects: kept as a record, not hidden. Home page collapses them
// into their own section; a write into one still lands but warns; the
// project page banners it and stops offering to add more.
import { describe, it, test, expect, beforeEach } from 'bun:test';
import { openDb, Store } from '../src/db.ts';
import { createHandler } from '../src/app.ts';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

function freshStore(): Store {
  return new Store(openDb(join(tmpdir(), `wb-archived-${randomUUID()}`, 'test.db')));
}

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

describe('writes into an archived project still land, with a warning', () => {
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

  test('creating an item in an archived project succeeds and warns', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    expect((await api('PATCH', '/api/projects/demo', { archived: true })).status).toBe(200);
    const res = await api('POST', '/api/projects/demo/items', { title: 'Still lands' });
    expect(res.status).toBe(201);
    expect(res.json.warnings.join(' ')).toContain('is archived');
  });

  test('creating an item in a NOT-archived project carries no such warning', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    const res = await api('POST', '/api/projects/demo/items', { title: 'Normal item' });
    expect(res.status).toBe(201);
    expect(res.json.warnings).toBeUndefined();
  });

  test('a PATCH on an item in an archived project warns', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    const created = await api('POST', '/api/projects/demo/items', { title: 'Item' });
    const item = created.json.items[0];
    expect((await api('PATCH', '/api/projects/demo', { archived: true })).status).toBe(200);
    const res = await api('PATCH', `/api/items/${item.id}`, { status: 'in-progress', actor: 't', ifVersion: item.version });
    expect(res.status).toBe(200);
    expect(String(res.json.warning)).toContain('is archived');
  });

  test('a reply on an item in an archived project warns', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    const created = await api('POST', '/api/projects/demo/items', { title: 'Item' });
    const item = created.json.items[0];
    expect((await api('PATCH', '/api/projects/demo', { archived: true })).status).toBe(200);
    const res = await api('POST', `/api/items/${item.id}/messages`, { who: 'agent', text: 'still working here' });
    expect(res.status).toBe(201);
    expect(String(res.json.warning)).toContain('is archived');
  });

  test('a check result on an item in an archived project warns', async () => {
    expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
    const created = await api('POST', '/api/projects/demo/items', { title: 'Item', checks: [{ label: 'step 1' }] });
    const item = created.json.items[0];
    expect((await api('PATCH', '/api/projects/demo', { archived: true })).status).toBe(200);
    const res = await api('PATCH', `/api/items/${item.id}/checks/${item.checks[0].id}`, { result: 'pass' });
    expect(res.status).toBe(200);
    expect(String(res.json.warning)).toContain('is archived');
  });
});

describe('the home page: archived section and project page banner (source-level)', () => {
  const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const projectHtml = readFileSync(new URL('../public/project.html', import.meta.url), 'utf8');

  it('has a collapsed Archived projects section, hidden when empty', () => {
    expect(indexHtml).toContain('id="archivedprojects"');
    expect(indexHtml).toMatch(/<details class="archived-projects" id="archivedprojects" hidden>/);
    expect(indexHtml).toContain("archivedSection.hidden = true;");
  });

  it('gives every archived card a Restore button that PATCHes archived: false', () => {
    const start = indexHtml.indexOf('function archivedCard(p)');
    expect(start).toBeGreaterThan(-1);
    const end = indexHtml.indexOf('\n  }', start);
    const body = indexHtml.slice(start, end);
    expect(body).toContain('restore-btn');
    expect(body).toContain('{ archived: false }');
  });

  it('splits active and archived from one API call, active excludes archivedAt', () => {
    const start = indexHtml.indexOf('async function render()');
    const end = indexHtml.indexOf('\n  }', start);
    const body = indexHtml.slice(start, end);
    expect(body).toContain("data.projects.filter((p) => !p.archivedAt)");
    expect(body).toContain("data.projects.filter((p) => p.archivedAt)");
  });

  it('project.html shows an archived banner and hides the Add-item form when archived', () => {
    expect(projectHtml).toContain('id="archivedbanner"');
    expect(projectHtml).toMatch(/archivedbanner'\)\.hidden = !project\.archivedAt/);
    expect(projectHtml).toMatch(/addsection'\)\.hidden = !!project\.archivedAt/);
  });
});
