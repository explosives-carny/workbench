// The CLI must use the same reference routes a shell does, not a mocked fetch.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHandler } from '../src/app.ts';
import { openDb, Store } from '../src/db.ts';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;
const WB = new URL('../src/wb.ts', import.meta.url).pathname;

let dbPath: string;
let store: Store;
let server: ReturnType<typeof Bun.serve>;
let plainSlug: string;
let plainItemId: string;

beforeAll(() => {
  dbPath = join(tmpdir(), `workbench-wb-cli-${Math.random().toString(36).slice(2)}.db`);
  store = new Store(openDb(dbPath));
  const demo = store.createProject({ name: 'Demo', key: 'DEMO' });
  store.createItem(demo.id, { title: 'First' });
  store.createItem(demo.id, { title: 'Second' });
  const plain = store.createProject({ name: 'Plain' });
  plainSlug = plain.slug;
  plainItemId = store.createItem(plain.id, { title: 'Only' }).id;
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD }),
  });
});

afterAll(() => {
  server.stop(true);
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + suffix); } catch {}
  }
});

async function wb(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', WB, ...args], {
    env: {
      ...process.env,
      WORKBENCH_URL: `http://127.0.0.1:${server.port}`,
      WB_ACTOR: 'tester',
      WB_SESSION: 'testsess',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          proc.kill();
          reject(new Error(`wb ${args.join(' ')} timed out after 10 seconds`));
        }, 10_000);
      }),
    ]);
    return {
      code,
      stdout: await new Response(proc.stdout).text(),
      stderr: await new Response(proc.stderr).text(),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe('wb item references', () => {
  test('shows a case-insensitive reference label', async () => {
    const result = await wb('show', 'wb-demo-2');
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith('WB-DEMO-2')).toBe(true);
  });

  test('replies through a reference', async () => {
    const result = await wb('reply', 'WB-DEMO-1', 'hello');
    expect(result.code).toBe(0);
    expect(store.resolveItem('WB-DEMO-1')!.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'hello', author: 'tester' }),
    ]));
  });

  test('prints references on keyed boards and UUID prefixes on unkeyed boards', async () => {
    const keyed = await wb('board', 'demo', '--all');
    expect(keyed.code).toBe(0);
    expect(keyed.stdout).toContain('WB-DEMO-1');
    expect(keyed.stdout).toContain('WB-DEMO-2');

    const plain = await wb('board', plainSlug, '--all');
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain(plainItemId.slice(0, 8));
  });

  test('lists project keys', async () => {
    const result = await wb('projects');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('DEMO');
  });

  // Runs before the key test below gives the plain project a key.
  test('ask prints something the next command can take back', async () => {
    const keyed = await wb('ask', 'demo', JSON.stringify({ title: 'Third' }));
    expect(keyed.code).toBe(0);
    expect(keyed.stdout.startsWith('WB-DEMO-3 ')).toBe(true);

    const plain = await wb('ask', plainSlug, JSON.stringify({ title: 'Another' }));
    expect(plain.code).toBe(0);
    const printed = plain.stdout.split(/\s+/)[0];
    expect(printed).toMatch(/^[0-9a-f-]{36}$/);
    const shown = await wb('show', printed);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('Another');
  });

  test('sets a project key and reports a taken key', async () => {
    const set = await wb('key', plainSlug, 'acme');
    expect(set.code).toBe(0);
    expect(set.stdout).toContain('key ACME');
    expect(store.getProject(plainSlug)!.key).toBe('ACME');

    const taken = await wb('key', plainSlug, 'DEMO');
    expect(taken.code).not.toBe(0);
    expect(taken.stderr).toContain('409');
  });

  test('fails loudly for an unknown reference', async () => {
    const result = await wb('show', 'WB-NOPE-1');
    expect(result.code).not.toBe(0);
  });
});
