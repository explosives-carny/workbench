import { describe, it, expect, beforeEach } from 'bun:test';
import { openDb, Store, VersionConflict, findSimilarSection } from '../src/db.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

function freshStore(): Store {
  // A real file rather than :memory: — WAL and ALTER TABLE are what this tool
  // actually runs on, and an in-memory database would not exercise either.
  return new Store(openDb(join(tmpdir(), `wb-${randomUUID()}`, 'test.db')));
}

describe('projects', () => {
  let store: Store;
  beforeEach(() => { store = freshStore(); });

  it('creates a project and addresses it by slug', () => {
    const project = store.createProject({ name: 'Acme Site' });
    expect(project.slug).toBe('acme-site');
    expect(store.getProject('acme-site')!.id).toBe(project.id);
  });

  // An agent re-running its own setup must not produce a second board.
  it('is idempotent by slug', () => {
    const first = store.createProject({ name: 'Acme Site' });
    const second = store.createProject({ name: 'Acme Site' });
    expect(second.id).toBe(first.id);
    expect(store.listProjects().length).toBe(1);
  });
});

describe('items and threads', () => {
  let store: Store;
  let projectId: string;
  beforeEach(() => {
    store = freshStore();
    projectId = store.createProject({ name: 'P' }).id;
  });

  it('starts an item waiting on the human', () => {
    const item = store.createItem(projectId, { title: 'Deploy?' });
    expect(item.status).toBe('needs-you');
    expect(item.version).toBe(1);
  });

  // The status transition is the point of the tool: a human answering must
  // visibly stop being a question, without the human having to say so twice.
  it('moves off needs-you when the human replies', () => {
    const item = store.createItem(projectId, { title: 'Deploy?' });
    store.addMessage(item.id, { who: 'you', text: 'Do it' });
    expect(store.getItem(item.id)!.status).toBe('received');
  });

  it('leaves the status alone when an agent replies', () => {
    const item = store.createItem(projectId, { title: 'Deploy?' });
    store.addMessage(item.id, { who: 'agent', text: 'Asking again' });
    expect(store.getItem(item.id)!.status).toBe('needs-you');
  });

  it('keeps the thread in order and append-only', () => {
    const item = store.createItem(projectId, { title: 'Deploy?' });
    store.addMessage(item.id, { who: 'agent', text: 'first' });
    store.addMessage(item.id, { who: 'you', text: 'second' });
    store.addMessage(item.id, { who: 'agent', text: 'third' });
    expect(store.listMessages(item.id).map((m) => m.text)).toEqual(['first', 'second', 'third']);
  });

  it('creates a whole set in one call without losing order', () => {
    const titles = ['a', 'b', 'c'];
    for (const title of titles) store.createItem(projectId, { title });
    expect(store.listItems(projectId).map((i) => i.title)).toEqual(titles);
  });

  it('survives a malformed options blob rather than taking the list down', () => {
    const item = store.createItem(projectId, { title: 'x', options: ['one'] });
    // Simulates a hand-edited or partially written row.
    (store as any).db.query('UPDATE items SET options = ? WHERE id = ?').run('{not json', item.id);
    expect(store.getItem(item.id)!.options).toEqual([]);
  });
});

describe('concurrency', () => {
  let store: Store;
  let projectId: string;
  beforeEach(() => {
    store = freshStore();
    projectId = store.createProject({ name: 'P' }).id;
  });

  it('bumps the version on every write', () => {
    const item = store.createItem(projectId, { title: 'x' });
    expect(store.updateItem(item.id, { status: 'received' })!.version).toBe(2);
    store.addMessage(item.id, { who: 'agent', text: 'note' });
    expect(store.getItem(item.id)!.version).toBe(3);
  });

  // The whole reason ifVersion exists: two sessions holding the same item, and
  // the second one must not silently erase the first one's decision.
  it('refuses a stale write and hands back the current item', () => {
    const item = store.createItem(projectId, { title: 'x' });
    const staleVersion = item.version;
    store.updateItem(item.id, { choice: 'Do it', status: 'received' }, { actor: 'human' });

    let conflict: VersionConflict | null = null;
    try {
      store.updateItem(item.id, { choice: 'Hold' }, { ifVersion: staleVersion, actor: 'other-session' });
    } catch (error) {
      conflict = error as VersionConflict;
    }
    expect(conflict).toBeInstanceOf(VersionConflict);
    // Attached, so the caller can merge instead of re-reading and racing again.
    expect(conflict!.current.choice).toBe('Do it');
    expect(store.getItem(item.id)!.choice).toBe('Do it');
  });

  it('accepts a write pinned to the current version', () => {
    const item = store.createItem(projectId, { title: 'x' });
    const updated = store.updateItem(item.id, { status: 'complete' }, { ifVersion: item.version, actor: 'forge' });
    expect(updated!.status).toBe('complete');
    expect(updated!.updatedBy).toBe('forge');
  });

  it('lets an unpinned write through, because that is the documented default', () => {
    const item = store.createItem(projectId, { title: 'x' });
    store.updateItem(item.id, { status: 'received' });
    expect(store.updateItem(item.id, { status: 'complete' })!.status).toBe('complete');
  });

  // Messages never conflict, which is why the contract tells agents to prefer
  // them for recording what happened.
  it('accepts concurrent messages from several sessions', () => {
    const item = store.createItem(projectId, { title: 'x' });
    for (const who of ['agent', 'you', 'agent'] as const) {
      store.addMessage(item.id, { who, text: who, author: who + '-session' });
    }
    expect(store.listMessages(item.id).length).toBe(3);
  });
});

describe('counts', () => {
  it('reports what is actually waiting on the human', () => {
    const store = freshStore();
    const projectId = store.createProject({ name: 'P' }).id;
    store.createItem(projectId, { title: 'a' });
    store.createItem(projectId, { title: 'b' });
    const third = store.createItem(projectId, { title: 'c' });
    store.updateItem(third.id, { status: 'complete' });
    const counts = store.counts(projectId);
    expect(counts['needs-you']).toBe(2);
    expect(counts.complete).toBe(1);
  });
});

describe('section vocabulary', () => {
  let store: Store;
  let projectId: string;
  let slug: string;
  beforeEach(() => {
    store = freshStore();
    const p = store.createProject({ name: 'P' });
    projectId = p.id;
    slug = p.slug;
  });

  // Ad-hoc is the default because a project rarely knows its areas on day one,
  // and forcing a guess produces a worse taxonomy than letting one emerge.
  it('starts ad-hoc with no declared sections', () => {
    expect(store.getProject(slug)!.sectionMode).toBe('adhoc');
    expect(store.getProject(slug)!.sections).toEqual([]);
  });

  it('reports the vocabulary in use with counts', () => {
    store.createItem(projectId, { title: 'a', section: 'Ship it' });
    store.createItem(projectId, { title: 'b', section: 'Ship it' });
    store.createItem(projectId, { title: 'c', section: 'Design' });
    store.createItem(projectId, { title: 'd' });
    const inUse = store.sectionsInUse(store.getProject(slug)!);
    expect(inUse.find((s) => s.name === 'Ship it')!.count).toBe(2);
    expect(inUse.find((s) => s.name === 'Design')!.count).toBe(1);
    // An unsectioned item is not a section called "".
    expect(inUse.some((s) => s.name === '')).toBe(false);
  });

  it('includes a declared section nobody has used yet', () => {
    store.setProjectSections(slug, { sections: ['Design', 'Unused'] });
    const inUse = store.sectionsInUse(store.getProject(slug)!);
    expect(inUse.find((s) => s.name === 'Unused')).toEqual({ name: 'Unused', count: 0, declared: true });
  });

  // The way a vocabulary actually rots: not a wild new name, but a synonym that
  // splits one area into two lists, both of which then look complete.
  it('spots the near-duplicates that matter', () => {
    const existing = ['Ship it', 'Design', 'People and access'];
    expect(findSimilarSection('Ship its', existing)).toBe('Ship it');
    expect(findSimilarSection('ship it', existing)).toBe('Ship it');
    expect(findSimilarSection('Designs', existing)).toBe('Design');
    expect(findSimilarSection('DESIGN', existing)).toBe('Design');
  });

  it('does not cry duplicate over a genuinely different area', () => {
    const existing = ['Ship it', 'Design'];
    expect(findSimilarSection('People and access', existing)).toBe(null);
    expect(findSimilarSection('Cycle count', existing)).toBe(null);
  });

  it('treats an exact match as reuse, not duplication', () => {
    expect(findSimilarSection('Design', ['Design', 'Ship it'])).toBe(null);
  });

  // Without a repair tool a vocabulary can only get worse, so this is the one
  // piece that makes ad-hoc mode safe rather than merely permissive.
  it('merges one section into another across every item', () => {
    store.createItem(projectId, { title: 'a', section: 'Deploys' });
    store.createItem(projectId, { title: 'b', section: 'Deploys' });
    store.createItem(projectId, { title: 'c', section: 'Design' });
    expect(store.renameSection(projectId, 'Deploys', 'Ship it', 'tidy')).toBe(2);
    const inUse = store.sectionsInUse(store.getProject(slug)!);
    expect(inUse.find((s) => s.name === 'Ship it')!.count).toBe(2);
    expect(inUse.some((s) => s.name === 'Deploys')).toBe(false);
  });

  it('bumps the version of every item a merge touched', () => {
    const item = store.createItem(projectId, { title: 'a', section: 'Deploys' });
    store.renameSection(projectId, 'Deploys', 'Ship it');
    expect(store.getItem(item.id)!.version).toBe(2);
  });
});
