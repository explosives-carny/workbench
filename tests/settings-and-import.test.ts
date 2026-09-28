// Two gaps closed together: board settings used to store any key with any
// value, and an import dropped a project's layout, colour and archived state.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, Store, PROJECT_COLORS } from '../src/db.ts';
import { createHandler } from '../src/app.ts';
import { exportAll, importAll } from '../src/export.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;
const cleanup: string[] = [];
const freshStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-gaps-'));
  cleanup.push(dir);
  return new Store(openDb(join(dir, 'test.db')));
};
afterEach(() => { while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true }); });

describe('PATCH /api/settings', () => {
  let store: Store;
  let handler: (req: Request) => Promise<Response>;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await handler(new Request(`http://localhost${path}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    return { status: res.status, json: await res.json() as any };
  };
  beforeEach(() => {
    store = freshStore();
    store.createProject({ name: 'Demo' });
    handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
  });

  test('stores well-typed known keys', async () => {
    const r = await api('PATCH', '/api/settings', {
      autoCapture: false, defaultProject: 'demo', backupPlan: 'git remote',
      agentNames: { 'claude-code': 'Spike' }, onboardedAt: '2026-09-16T20:15:00Z',
    });
    expect(r.status).toBe(200);
    expect(r.json.ignored).toBeUndefined();
    expect(r.json.settings).toMatchObject({ autoCapture: false, defaultProject: 'demo', agentNames: { 'claude-code': 'Spike' } });
  });

  test('refuses a wrong type with the reason, and stores nothing from that request', async () => {
    for (const [body, words] of [
      [{ autoCapture: 'yes' }, 'autoCapture must be true or false'],
      [{ agentNames: 'Spike' }, 'agentNames must be an object'],
      [{ agentNames: { codex: 3 } }, 'agentNames.codex'],
      [{ defaultProject: 'nope' }, 'no project "nope"'],
      [{ onboardedAt: 'last tuesday' }, 'onboardedAt must be an ISO date-time'],
      [{ postFindings: true, checkInOnStart: 'no' }, 'checkInOnStart'],
    ] as const) {
      const r = await api('PATCH', '/api/settings', body);
      expect(r.status).toBe(400);
      expect(r.json.error).toContain(words);
    }
    expect(store.getSettings().postFindings).toBeUndefined();
  });

  test('does not store an unknown key and names it in ignored', async () => {
    const r = await api('PATCH', '/api/settings', { autoCaptue: true, autoMode: true, summariseOnExit: true });
    expect(r.status).toBe(200);
    expect(r.json.ignored).toEqual(['autoCaptue', 'autoMode']);
    expect(store.getSettings()).toEqual({ summariseOnExit: true });
  });

  test('treats actor and session as the write signature, not settings', async () => {
    const r = await api('PATCH', '/api/settings', { postFindings: false, actor: 'spike', session: 'abcd1234' });
    expect(r.json.ignored).toBeUndefined();
    expect(store.getSettings()).toEqual({ postFindings: false });
  });

  test('null clears defaultProject', async () => {
    await api('PATCH', '/api/settings', { defaultProject: 'demo' });
    const r = await api('PATCH', '/api/settings', { defaultProject: null });
    expect(r.status).toBe(200);
    expect(r.json.settings.defaultProject).toBeNull();
  });
});

describe('importAll restores a project the way it was', () => {
  test('layout, sections, colour and archived state survive an export and import', () => {
    const source = freshStore();
    const live = source.createProject({ name: 'Live' });
    source.setProjectSections(live.slug, { groupBy: 'move', sortBy: 'ref', sectionMode: 'declared', sections: ['Now', 'Later'], color: PROJECT_COLORS[5] });
    const old = source.createProject({ name: 'Old' });
    source.setProjectSections(old.slug, { groupBy: 'section' });
    source.archiveProject(old.slug, true);

    const dir = mkdtempSync(join(tmpdir(), 'wb-gaps-export-'));
    cleanup.push(dir);
    exportAll(source, dir);

    const target = freshStore();
    importAll(target, dir, () => {});
    const back = target.getProject(live.slug)!;
    expect(back).toMatchObject({ groupBy: 'move', sortBy: 'ref', sectionMode: 'declared', sections: ['Now', 'Later'], color: PROJECT_COLORS[5] });
    expect(back.archivedAt).toBeNull();
    const oldBack = target.getProject(old.slug)!;
    expect(oldBack.groupBy).toBe('section');
    expect(oldBack.archivedAt).toBeTruthy();
    expect(target.listProjects(false).map((p) => p.slug)).not.toContain(old.slug);
  });

  test('a bad value in the file is skipped and logged, and the rest still restores', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-gaps-bad-'));
    cleanup.push(dir);
    writeFileSync(join(dir, 'odd.json'), JSON.stringify({
      project: { name: 'Odd', slug: 'odd', groupBy: 'sideways', sortBy: 'ref', color: '#000000' },
      items: [],
    }));
    const lines: string[] = [];
    const target = freshStore();
    importAll(target, dir, (l) => lines.push(l));
    const p = target.getProject('odd')!;
    expect(p.sortBy).toBe('ref');
    expect(p.groupBy).toBe('status');
    expect(PROJECT_COLORS as readonly string[]).toContain(p.color);
    expect(lines.some((l) => l.includes('skipped groupBy'))).toBe(true);
    expect(lines.some((l) => l.includes('skipped color'))).toBe(true);
  });
});
