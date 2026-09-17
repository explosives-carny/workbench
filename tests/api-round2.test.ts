// Contract round 2 over the API: the pieces the review round approved.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, Store, normaliseRepoRef } from '../src/db.ts';
import { createHandler, CONTRACT_VERSION } from '../src/app.ts';
import { exportAll } from '../src/export.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, readFileSync, mkdtempSync } from 'fs';

let dbPath: string;
let store: Store;
let writes = 0;
let handler: (req: Request) => Promise<Response>;

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

beforeEach(() => {
  dbPath = join(tmpdir(), `workbench-r2-${Math.random().toString(36).slice(2)}.db`);
  store = new Store(openDb(dbPath));
  writes = 0;
  handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD, onWrite: () => { writes += 1; }, home: '/home/sam' });
});

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + suffix); } catch {}
  }
});

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await handler(new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function project(slug = 'acme', extra: Record<string, unknown> = {}) {
  return (await api('POST', '/api/projects', { name: 'Acme', slug, ...extra })).json.project;
}

async function item(slug = 'acme', extra: Record<string, unknown> = {}) {
  await project(slug);
  return (await api('POST', `/api/projects/${slug}/items`, { title: 'Deploy?', ...extra })).json.items[0];
}

describe('self-description', () => {
  test('GET /api names the contract version, the contract, and the routes', async () => {
    const res = await api('GET', '/api');
    expect(res.status).toBe(200);
    expect(res.json.contractVersion).toBe(CONTRACT_VERSION);
    expect(res.json.agentsMd).toBe('/api-doc');
    expect(res.json.routes.some((r: string) => r.includes('/api/projects/<slug>/authors'))).toBe(true);
  });

  test('AGENTS.md declares the same contract version the server does', () => {
    const md = readFileSync(AGENTS_MD, 'utf8');
    expect(md).toContain(`Contract v${CONTRACT_VERSION}`);
  });
});

describe('payload cost', () => {
  test('a script gets compact JSON; a browser (Sec-Fetch-Mode) gets it pretty; ?pretty overrides', async () => {
    const script = await api('GET', '/api/projects');
    expect(script.text).toBe('{"ok":true,"projects":[]}');
    const browser = await api('GET', '/api/projects', undefined, { 'sec-fetch-mode': 'cors' });
    expect(browser.text).toContain('\n  "ok": true');
    const forced = await api('GET', '/api/projects?pretty=1');
    expect(forced.text).toContain('\n');
  });

  test('?status= returns only those rows and ?messages=last trims the threads but keeps the count', async () => {
    const a = await item('acme');
    await api('POST', `/api/items/${a.id}/messages`, { who: 'you', text: 'one' });
    await api('POST', `/api/items/${a.id}/messages`, { who: 'you', text: 'two' });
    await api('POST', '/api/projects/acme/items', [{ title: 'B' }, { title: 'C' }]);
    const filtered = await api('GET', '/api/projects/acme?status=received&messages=last');
    expect(filtered.json.items).toHaveLength(1);
    expect(filtered.json.items[0].status).toBe('received');
    expect(filtered.json.items[0].messages).toHaveLength(1);
    expect(filtered.json.items[0].messages[0].text).toBe('two');
    expect(filtered.json.items[0].messageCount).toBe(2);
    expect(filtered.json.counts['needs-decision']).toBe(2);
    const none = await api('GET', '/api/projects/acme?messages=none');
    expect(none.json.items.every((i: any) => i.messages === undefined)).toBe(true);
    const bad = await api('GET', '/api/projects/acme?status=bogus');
    expect(bad.status).toBe(400);
  });
});

describe('unknown fields are reported, not swallowed', () => {
  test('a misspelt field on create comes back in ignored[]', async () => {
    await project();
    const res = await api('POST', '/api/projects/acme/items', { title: 'A', lables: ['x'] });
    expect(res.status).toBe(201);
    expect(res.json.ignored).toEqual(['lables']);
    expect(res.json.items[0].labels).toEqual([]);
  });

  test('a clean request carries no ignored key at all', async () => {
    await project();
    const res = await api('POST', '/api/projects/acme/items', { title: 'A', labels: ['x'] });
    expect(res.json.ignored).toBeUndefined();
  });

  test('messages and checks report ignored fields too', async () => {
    const it = await item('acme', { checks: [{ id: 's1', label: '1.' }] });
    const m = await api('POST', `/api/items/${it.id}/messages`, { who: 'agent', actor: 'a', text: 'hi', stauts: 'complete' });
    expect(m.json.ignored).toEqual(['stauts']);
    const c = await api('PATCH', `/api/items/${it.id}/checks/s1`, { result: 'pass', actor: 'a', notes: 'x' });
    expect(c.json.ignored).toEqual(['notes']);
  });
});

describe('ifVersion on status edits', () => {
  test('a status change without ifVersion lands but warns, naming the version to send', async () => {
    const it = await item();
    const res = await api('PATCH', `/api/items/${it.id}`, { status: 'in-progress', actor: 'a' });
    expect(res.status).toBe(200);
    expect(res.json.item.status).toBe('in-progress');
    expect(res.json.warning).toContain('without ifVersion');
    expect(res.json.warning).toContain(`(${it.version} before this write)`);
  });

  test('a non-status edit without ifVersion, or a status edit with it, does not warn', async () => {
    const it = await item();
    const a = await api('PATCH', `/api/items/${it.id}`, { context: 'more', actor: 'a' });
    expect(a.json.warning).toBeUndefined();
    const b = await api('PATCH', `/api/items/${it.id}`, { status: 'in-progress', actor: 'a', ifVersion: a.json.item.version });
    expect(b.json.warning).toBeUndefined();
  });
});

describe('the finishing reply', () => {
  test('a reply that sounds finished and carries no status is warned about, and the item is not moved', async () => {
    const it = await item();
    await api('POST', `/api/items/${it.id}/messages`, { who: 'you', text: 'Do it' });
    const res = await api('POST', `/api/items/${it.id}/messages`, { who: 'agent', actor: 'a', text: 'Landed, PR merged and deployed.' });
    expect(res.status).toBe(201);
    expect(res.json.item.status).toBe('in-progress');
    expect(res.json.warning).toContain('carried no status');
  });

  test('the same reply with a status is not warned about', async () => {
    const it = await item();
    await api('POST', `/api/items/${it.id}/messages`, { who: 'you', text: 'Do it' });
    const res = await api('POST', `/api/items/${it.id}/messages`, { who: 'agent', actor: 'a', status: 'complete', text: 'Landed, PR merged.' });
    expect(res.json.item.status).toBe('complete');
    expect(res.json.warning).toBeUndefined();
  });

  test('a human message is never warned about', async () => {
    const it = await item();
    const res = await api('POST', `/api/items/${it.id}/messages`, { who: 'you', text: 'done, thanks' });
    expect(res.json.warning).toBeUndefined();
  });
});

describe('no delete', () => {
  test('DELETE is refused and says what to do instead; the item is still there', async () => {
    const it = await item();
    const res = await api('DELETE', `/api/items/${it.id}`);
    expect(res.status).toBe(405);
    expect(res.json.error).toContain('never deleted');
    expect((await api('GET', `/api/items/${it.id}`)).status).toBe(200);
  });
});

describe('idempotent creates', () => {
  test('re-sending a batch with clientIds finds the existing items instead of duplicating them', async () => {
    const p = await project();
    const batch = [{ title: 'A', clientId: 'r1-a' }, { title: 'B', clientId: 'r1-b' }];
    const first = await api('POST', '/api/projects/acme/items', batch);
    const second = await api('POST', '/api/projects/acme/items', batch);
    expect(second.status).toBe(201);
    expect(second.json.items.map((i: any) => i.id)).toEqual(first.json.items.map((i: any) => i.id));
    expect(store.listItems(p.id, 'none')).toHaveLength(2);
  });

  test('clientIds are scoped to the project', async () => {
    await project('one');
    await project('two');
    const a = await api('POST', '/api/projects/one/items', { title: 'A', clientId: 'k' });
    const b = await api('POST', '/api/projects/two/items', { title: 'A', clientId: 'k' });
    expect(a.json.items[0].id).not.toBe(b.json.items[0].id);
  });
});

describe('repo → project', () => {
  test('a remote in any spelling resolves to the project that lists it', async () => {
    await project('site', { repos: ['git@github.com:Acme/site.git', '~/code/site*'] });
    await project('other', { repos: ['acme/other'] });
    for (const ref of ['https://github.com/acme/site', 'acme/site', 'git@github.com:acme/site.git']) {
      const res = await api('GET', `/api/projects?repo=${encodeURIComponent(ref)}`);
      expect(res.json.projects.map((p: any) => p.slug)).toEqual(['site']);
    }
  });

  test('a path with a trailing * matches every worktree under it, ~ expands to home', async () => {
    await project('site', { repos: ['~/code/site*'] });
    const hit = await api('GET', `/api/projects?repo=${encodeURIComponent('/home/sam/code/site-feature-x')}`);
    expect(hit.json.projects).toHaveLength(1);
    const miss = await api('GET', `/api/projects?repo=${encodeURIComponent('/home/sam/code/sitemap')}`);
    expect(miss.json.projects).toHaveLength(1); // prefix match is deliberately loose: "site*" covers "sitemap"
    const none = await api('GET', `/api/projects?repo=${encodeURIComponent('/home/sam/code/blog')}`);
    expect(none.json.projects).toHaveLength(0);
    expect(none.json.resolvedFrom).toBe('/home/sam/code/blog');
  });

  test('repos can be set later with PATCH and come back on the project', async () => {
    await project('site');
    const res = await api('PATCH', '/api/projects/site', { repos: ['acme/site'] });
    expect(res.json.project.repos).toEqual(['acme/site']);
    expect(normaliseRepoRef('HTTPS://GitHub.com/Acme/Site.git/')).toBe('acme/site');
  });
});

describe('QA sign-off', () => {
  test('recording the last pass posts the sign-off and hands the item back at received', async () => {
    const it = await item('acme', { status: 'needs-qa', checks: [{ id: 's1', label: '1.' }, { id: 's2', label: '2.' }] });
    const one = await api('PATCH', `/api/items/${it.id}/checks/s1`, { result: 'pass', actor: 'qa-bot' });
    expect(one.json.item.status).toBe('needs-qa');
    const two = await api('PATCH', `/api/items/${it.id}/checks/s2`, { result: 'pass', actor: 'qa-bot' });
    expect(two.json.item.status).toBe('received');
    const last = two.json.item.messages.at(-1);
    expect(last.author).toBe('qa-bot');
    expect(last.who).toBe('agent');
    expect(last.text).toContain('All 2 steps passed');
  });

  test('a fail or a skip anywhere leaves it at QA', async () => {
    const it = await item('acme', { status: 'needs-qa', checks: [{ id: 's1', label: '1.' }, { id: 's2', label: '2.' }] });
    await api('PATCH', `/api/items/${it.id}/checks/s1`, { result: 'pass' });
    const res = await api('PATCH', `/api/items/${it.id}/checks/s2`, { result: 'skip', note: 'no device' });
    expect(res.json.item.status).toBe('needs-qa');
  });

  test('a human recording the last pass is recorded as the human', async () => {
    const it = await item('acme', { status: 'needs-qa', checks: [{ id: 's1', label: '1.' }] });
    const res = await api('PATCH', `/api/items/${it.id}/checks/s1`, { result: 'pass' });
    expect(res.json.item.status).toBe('received');
    expect(res.json.item.messages.at(-1).who).toBe('you');
  });
});

describe('writes are reported to the exporter, reads are not', () => {
  test('onWrite fires once per mutating request', async () => {
    await project();
    expect(writes).toBe(1);
    await api('GET', '/api/projects');
    expect(writes).toBe(1);
    const it = await api('POST', '/api/projects/acme/items', { title: 'A' });
    await api('POST', `/api/items/${it.json.items[0].id}/messages`, { who: 'you', text: 'x' });
    expect(writes).toBe(3);
    await api('POST', '/api/projects/acme/items', { context: 'refused' });
    expect(writes).toBe(3);
  });

  test('exportAll writes one file per project with full bodies and threads', async () => {
    const it = await item('acme', { kind: 'document', body: 'x'.repeat(300) });
    await api('POST', `/api/items/${it.id}/messages`, { who: 'you', text: 'read it' });
    const dir = mkdtempSync(join(tmpdir(), 'wb-export-'));
    const result = exportAll(store, dir);
    expect(result.projects).toBe(1);
    const file = JSON.parse(readFileSync(join(dir, 'acme.json'), 'utf8'));
    expect(file.items[0].body).toHaveLength(300);
    expect(file.items[0].messages).toHaveLength(1);
    expect(file.items[0].projectId).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
