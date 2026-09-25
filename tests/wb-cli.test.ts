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

describe('wb archive / restore', () => {
  test('archives a project, then restores it (reclaiming its colour)', async () => {
    const p = store.createProject({ name: 'Retire Me' });
    const before = store.getProject(p.slug)!;
    const archived = await wb('archive', p.slug);
    expect(archived.code).toBe(0);
    expect(archived.stdout).toContain('archived');
    expect(store.getProject(p.slug)!.archivedAt).not.toBeNull();

    const restored = await wb('restore', p.slug);
    expect(restored.code).toBe(0);
    expect(restored.stdout).toContain('restored');
    const after = store.getProject(p.slug)!;
    expect(after.archivedAt).toBeNull();
    expect(after.color).toBe(before.color);
  });

  test('fails loudly for an unknown slug', async () => {
    const result = await wb('archive', 'no-such-project');
    expect(result.code).not.toBe(0);
  });
});

describe('wb project', () => {
  test('prints the project when given no flags', async () => {
    const result = await wb('project', 'demo');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('demo');
    expect(result.stdout).toContain('groupBy:');
    expect(result.stdout).toContain('colour:');
  });

  test('sets a subset of fields in one PATCH', async () => {
    const p = store.createProject({ name: 'Configurable' });
    const result = await wb('project', p.slug, '--group', 'move', '--sort', 'ref', '--description', 'set from the CLI');
    expect(result.code).toBe(0);
    const after = store.getProject(p.slug)!;
    expect(after.groupBy).toBe('move');
    expect(after.sortBy).toBe('ref');
    expect(after.description).toBe('set from the CLI');
  });

  test('sets sections and repos from a comma-separated list', async () => {
    const p = store.createProject({ name: 'Listy' });
    const result = await wb('project', p.slug, '--section-mode', 'declared', '--sections', 'Ship it, Design', '--repos', 'owner/name, ~/code/x*');
    expect(result.code).toBe(0);
    const after = store.getProject(p.slug)!;
    expect(after.sectionMode).toBe('declared');
    expect(after.sections).toEqual(['Ship it', 'Design']);
    expect(after.repos).toEqual(['owner/name', '~/code/x*']);
  });

  test('refuses an unknown flag', async () => {
    const result = await wb('project', 'demo', '--auto-mode');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('unknown flag');
  });
});

describe('wb settings', () => {
  test('prints settings with onboarding defaults when unset', async () => {
    const result = await wb('settings');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('autoCapture: true');
    expect(result.stdout).toContain('checkInOnStart: true');
  });

  test('sets a boolean flag bare (true) and explicit false', async () => {
    const on = await wb('settings', '--post-findings');
    expect(on.code).toBe(0);
    expect((await wb('settings')).stdout).toContain('postFindings: true');

    const off = await wb('settings', '--post-findings', 'false');
    expect(off.code).toBe(0);
    expect((await wb('settings')).stdout).toContain('postFindings: false');
  });

  test('sets --agent-name tool=name, merged onto any existing entries', async () => {
    const first = await wb('settings', '--agent-name', 'claude-code=Spike');
    expect(first.code).toBe(0);
    const second = await wb('settings', '--agent-name', 'codex=Forge');
    expect(second.code).toBe(0);
    const printed = await wb('settings');
    const names = JSON.parse(printed.stdout.match(/agentNames: (.+)/)![1]);
    expect(names).toEqual({ 'claude-code': 'Spike', codex: 'Forge' });
  });

  test('refuses --auto-mode and any other unknown flag', async () => {
    const result = await wb('settings', '--auto-mode');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('unknown flag');
    expect(result.stderr).toContain('no --auto-mode');
  });
});
