// A browser write from another site is refused; everything else is untouched.
//
// The board has no delete, so a drive-by write from a page open in the same
// browser is permanent. Writes carry `Origin` when a browser sends them; a
// request without one (curl, wb, an agent) is not a browser acting for a page
// and is unaffected. Same-origin is judged against the request's own URL.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, Store } from '../src/db.ts';
import { createHandler, crossSiteRefusal } from '../src/app.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

let dbPath: string;
let store: Store;
let handler: (req: Request) => Promise<Response>;

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

beforeEach(() => {
  dbPath = join(tmpdir(), `workbench-origin-${Math.random().toString(36).slice(2)}.db`);
  store = new Store(openDb(dbPath));
  handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD, origins: ['https://board.example'] });
});

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + suffix); } catch {}
  }
});

function req(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return handler(
    new Request(`http://localhost:4317${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

describe('cross-site browser writes', () => {
  test('a POST from another origin is refused with 403 and writes nothing', async () => {
    const res = await req('POST', '/api/projects', { origin: 'https://evil.example' }, { name: 'Drive-by', slug: 'driveby' });
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('https://evil.example');
    expect(body.error).toContain('http://localhost:4317');
    expect(store.getProject('driveby')).toBeNull();
  });

  test('the same origin, the configured extra origin, and no origin all write', async () => {
    for (const [origin, slug] of [['http://localhost:4317', 'same'], ['https://board.example', 'extra'], [undefined, 'none']] as const) {
      const headers: Record<string, string> = origin ? { origin } : {};
      const res = await req('POST', '/api/projects', headers, { name: slug, slug });
      expect(res.status).toBe(201);
      expect(store.getProject(slug)).not.toBeNull();
    }
  });

  test('a cross-site PATCH, message and image upload are refused the same way', async () => {
    await req('POST', '/api/projects', {}, { name: 'Acme', slug: 'acme' });
    const created: any = await (await req('POST', '/api/projects/acme/items', {}, { title: 'Ship it?', options: ['A', 'B'], recommended: ['A'] })).json();
    const id = created.items ? created.items[0].id : created.item.id;
    const patch = await req('PATCH', `/api/items/${id}`, { origin: 'https://evil.example' }, { status: 'complete' });
    expect(patch.status).toBe(403);
    const message = await req('POST', `/api/items/${id}/messages`, { origin: 'https://evil.example' }, { who: 'you', text: 'planted' });
    expect(message.status).toBe(403);
    const image = await handler(new Request('http://localhost:4317/api/images', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'image/png' }, body: new Uint8Array([0x89, 0x50]) }));
    expect(image.status).toBe(403);
    const item: any = await (await req('GET', `/api/items/${id}`)).json();
    expect(item.item.status).toBe('needs-decision');
    expect(item.item.messages.length).toBe(0);
  });

  test('reads from another origin are not refused', async () => {
    const res = await req('GET', '/api', { origin: 'https://evil.example' });
    expect(res.status).toBe(200);
  });

  test('an opaque "null" origin is refused, a trailing slash is tolerated', () => {
    const url = new URL('http://127.0.0.1:4317/api/projects');
    const post = (origin: string) => new Request(url.toString(), { method: 'POST', headers: { origin } });
    expect(crossSiteRefusal(post('null'), url)).toContain('no origin');
    expect(crossSiteRefusal(post('http://127.0.0.1:4317/'), url)).toBeUndefined();
    expect(crossSiteRefusal(post('http://localhost:4317'), url)).toContain('127.0.0.1:4317');
    expect(crossSiteRefusal(post('http://localhost:4317'), url, ['http://localhost:4317/'])).toBeUndefined();
    expect(crossSiteRefusal(new Request(url.toString(), { method: 'GET', headers: { origin: 'https://evil.example' } }), url)).toBeUndefined();
  });
});
