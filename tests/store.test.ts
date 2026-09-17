import { describe, it, expect, beforeEach } from 'bun:test';
import { openDb, Store, VersionConflict, findSimilarSection, asHistoricInstant, asStatusValue, normaliseLabels, STATUSES, STATUS_GROUPS, DOCUMENT_STATUSES, statusesFor } from '../src/db.ts';
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
    expect(item.status).toBe('needs-decision');
    expect(item.version).toBe(1);
  });

  // The status transition is the point of the tool: a human answering must
  // visibly stop being a question, without the human having to say so twice.
  it('moves off the needs-* states when the human replies', () => {
    const item = store.createItem(projectId, { title: 'Deploy?' });
    store.addMessage(item.id, { who: 'you', text: 'Do it' });
    expect(store.getItem(item.id)!.status).toBe('received');
  });

  it('leaves the status alone when an agent replies', () => {
    const item = store.createItem(projectId, { title: 'Deploy?' });
    store.addMessage(item.id, { who: 'agent', text: 'Asking again' });
    expect(store.getItem(item.id)!.status).toBe('needs-decision');
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
    expect(counts['needs-decision']).toBe(2);
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

// Creation dates. The board's whole job is showing what is waiting and how
// long it has been waiting, so an item with no usable date is a row that
// cannot be triaged — and an import that stamps everything with the moment it
// ran produces a board of items that all appeared in the same second.
describe('creation dates', () => {
  let store: Store;
  let projectId: string;
  beforeEach(() => {
    store = freshStore();
    projectId = store.createProject({ name: 'Acme Site' }).id;
  });

  it('stamps every new item with a creation date', () => {
    const item = store.createItem(projectId, { title: 'a' });
    expect(Date.parse(item.createdAt)).toBeGreaterThan(0);
  });

  it('honours a supplied creation date so an import can carry real history', () => {
    const item = store.createItem(projectId, { title: 'a', createdAt: '2026-03-04T05:06:07.000Z' });
    expect(item.createdAt).toBe('2026-03-04T05:06:07.000Z');
  });

  // updatedAt is when the ROW was written. Backdating both would make an item
  // look untouched for months the instant it arrived.
  it('keeps updatedAt on the clock even when the creation date is backdated', () => {
    const item = store.createItem(projectId, { title: 'a', createdAt: '2020-01-01T00:00:00.000Z' });
    expect(Date.parse(item.updatedAt)).toBeGreaterThan(Date.parse(item.createdAt));
  });

  it('falls back to now for a date that is unparseable or in the future', () => {
    const before = Date.now() - 1000;
    for (const bad of ['not a date', new Date(Date.now() + 86400000).toISOString(), '']) {
      const item = store.createItem(projectId, { title: `t-${bad}`, createdAt: bad });
      expect(Date.parse(item.createdAt)).toBeGreaterThanOrEqual(before);
    }
  });

  it('ignores a creation date on update — history is set once', () => {
    const item = store.createItem(projectId, { title: 'a', createdAt: '2026-03-04T05:06:07.000Z' });
    store.updateItem(item.id, { title: 'b', createdAt: '2019-01-01T00:00:00.000Z' } as any);
    expect(store.getItem(item.id)!.createdAt).toBe('2026-03-04T05:06:07.000Z');
  });

  it('replays a message at its original time', () => {
    const item = store.createItem(projectId, { title: 'a' });
    const message = store.addMessage(item.id, { who: 'you', text: 'hi', createdAt: '2026-03-04T05:06:07.000Z' })!;
    expect(message.createdAt).toBe('2026-03-04T05:06:07.000Z');
  });
});

describe('asHistoricInstant', () => {
  const nowMs = Date.parse('2026-06-01T00:00:00.000Z');

  it('accepts a real past instant and normalises it', () => {
    expect(asHistoricInstant('2026-03-04T05:06:07Z', nowMs)).toBe('2026-03-04T05:06:07.000Z');
  });

  it('refuses the future, because it would sort above everything real forever', () => {
    expect(asHistoricInstant('2026-06-02T00:00:00.000Z', nowMs)).toBe(null);
  });

  it('refuses what it cannot parse, rather than inventing a date', () => {
    expect(asHistoricInstant('last tuesday', nowMs)).toBe(null);
    expect(asHistoricInstant(undefined, nowMs)).toBe(null);
    expect(asHistoricInstant(12345, nowMs)).toBe(null);
  });
});

// Labels: the crosswise axis. A section says which area of work; labels say
// what this has in common with that, any number, ungoverned on the way in.
describe('labels', () => {
  let store: Store;
  let projectId: string;
  let slug: string;
  beforeEach(() => {
    store = freshStore();
    const project = store.createProject({ name: 'Acme Site' });
    projectId = project.id;
    slug = project.slug;
  });

  it('round-trips a label set', () => {
    const item = store.createItem(projectId, { title: 'a', labels: ['Release 3', 'blocked'] });
    expect(store.getItem(item.id)!.labels).toEqual(['Release 3', 'blocked']);
  });

  it('defaults to none rather than null', () => {
    expect(store.createItem(projectId, { title: 'a' }).labels).toEqual([]);
  });

  // The only way a free-text field silently lies: two labels that look identical
  // in the filter list and match different items.
  it('trims, collapses whitespace and drops empties', () => {
    const item = store.createItem(projectId, { title: 'a', labels: ['  spaced  ', 'two   words', '', '   '] });
    expect(item.labels).toEqual(['spaced', 'two words']);
  });

  it('de-duplicates case-insensitively, first spelling wins', () => {
    const item = store.createItem(projectId, { title: 'a', labels: ['Release', 'release', 'RELEASE'] });
    expect(item.labels).toEqual(['Release']);
  });

  it('ignores non-strings and anything absurdly long', () => {
    const item = store.createItem(projectId, { title: 'a', labels: ['ok', 42 as any, null as any, 'x'.repeat(61)] });
    expect(item.labels).toEqual(['ok']);
  });

  // Undefined means "leave them"; an empty array means "clear them". Collapsing
  // the two would make every unrelated PATCH silently strip an item's labels.
  it('leaves labels alone when a patch omits them, and clears them on an empty array', () => {
    const item = store.createItem(projectId, { title: 'a', labels: ['keep'] });
    store.updateItem(item.id, { title: 'b' });
    expect(store.getItem(item.id)!.labels).toEqual(['keep']);
    store.updateItem(item.id, { labels: [] });
    expect(store.getItem(item.id)!.labels).toEqual([]);
  });

  it('reports what is in use, commonest first', () => {
    store.createItem(projectId, { title: 'a', labels: ['ship', 'qa'] });
    store.createItem(projectId, { title: 'b', labels: ['ship'] });
    expect(store.labelsInUse(projectId)).toEqual([{ name: 'ship', count: 2 }, { name: 'qa', count: 1 }]);
  });

  it('counts a label once per item however it is cased', () => {
    store.createItem(projectId, { title: 'a', labels: ['Ship'] });
    store.createItem(projectId, { title: 'b', labels: ['ship'] });
    expect(store.labelsInUse(projectId)).toEqual([{ name: 'Ship', count: 2 }]);
  });

  it('renames a label across every item that carries it', () => {
    store.createItem(projectId, { title: 'a', labels: ['deploys', 'keep'] });
    store.createItem(projectId, { title: 'b', labels: ['deploys'] });
    store.createItem(projectId, { title: 'c', labels: ['other'] });
    expect(store.renameLabel(projectId, 'deploys', 'ship it')).toBe(2);
    expect(store.labelsInUse(projectId).find((l) => l.name === 'ship it')!.count).toBe(2);
    expect(store.labelsInUse(projectId).some((l) => l.name === 'deploys')).toBe(false);
  });

  // Renaming onto a label an item already has must merge, not duplicate it.
  it('merges rather than doubling when renamed onto an existing label', () => {
    const item = store.createItem(projectId, { title: 'a', labels: ['ship', 'deploys'] });
    store.renameLabel(projectId, 'deploys', 'ship');
    expect(store.getItem(item.id)!.labels).toEqual(['ship']);
  });

  it('removes a label when renamed to nothing', () => {
    const item = store.createItem(projectId, { title: 'a', labels: ['gone', 'stays'] });
    expect(store.renameLabel(projectId, 'gone', '')).toBe(1);
    expect(store.getItem(item.id)!.labels).toEqual(['stays']);
  });

  it('bumps the version of every item a rename touched', () => {
    const item = store.createItem(projectId, { title: 'a', labels: ['x'] });
    store.renameLabel(projectId, 'x', 'y');
    expect(store.getItem(item.id)!.version).toBe(2);
  });

  it('matches the label case-insensitively when renaming', () => {
    store.createItem(projectId, { title: 'a', labels: ['Ship'] });
    expect(store.renameLabel(projectId, 'ship', 'shipped')).toBe(1);
  });
});

describe('grouping', () => {
  let store: Store;
  beforeEach(() => { store = freshStore(); });

  // A board exists to answer "what is waiting on me", and status grouping
  // answers it directly. Sections answer "what area is this" — useful, but a
  // second question, and labels cover the relating without forcing one axis.
  it('groups a new project by status', () => {
    expect(store.createProject({ name: 'Acme' }).groupBy).toBe('status');
  });

  it('can still be put on sections', () => {
    const project = store.createProject({ name: 'Acme' });
    expect(store.setProjectSections(project.slug, { groupBy: 'section' })!.groupBy).toBe('section');
  });

  it('keeps a grouping choice once made', () => {
    const project = store.createProject({ name: 'Acme' });
    store.setProjectSections(project.slug, { groupBy: 'section' });
    expect(store.getProject(project.slug)!.groupBy).toBe('section');
    store.setProjectSections(project.slug, { groupBy: 'status' });
    expect(store.getProject(project.slug)!.groupBy).toBe('status');
  });

  it('leaves the section vocabulary alone when only the grouping changes', () => {
    const project = store.createProject({ name: 'Acme' });
    store.setProjectSections(project.slug, { sectionMode: 'declared', sections: ['Ship it'] });
    store.setProjectSections(project.slug, { groupBy: 'status' });
    const after = store.getProject(project.slug)!;
    expect(after.sections).toEqual(['Ship it']);
    expect(after.sectionMode).toBe('declared');
  });

  // Every live status belongs to Open. Splitting them would move a piece of work
  // between groups every time it changed hands.
  it('puts every live task state under Open', () => {
    const open = STATUS_GROUPS.find((g) => g.id === 'open')!;
    expect(open.statuses).toEqual(['needs-decision', 'needs-qa', 'received', 'in-progress']);
    expect(STATUS_GROUPS.map((g) => g.label)).toEqual(['Open', 'Deferred', 'Documents', 'Archived']);
    // Every status lands in exactly one group, or a row would vanish from the board.
    const placed = STATUS_GROUPS.flatMap((g) => g.statuses);
    expect(placed.sort()).toEqual([...STATUSES].sort());
  });
});

// needs-you split into needs-decision and needs-qa. "Choose between these" and
// "I finished, check it" are different asks and cannot be triaged together.
describe('the status split', () => {
  let store: Store;
  beforeEach(() => { store = freshStore(); });

  it('has nine distinct states', () => {
    expect([...STATUSES]).toEqual(['needs-decision', 'needs-qa', 'received', 'in-progress', 'deferred', 'active', 'archived', 'complete', 'cancelled']);
    expect(new Set(STATUSES).size).toBe(STATUSES.length);
  });

  // A document is never "waiting on" anybody and never "done". Forced through
  // the task vocabulary it had to be filed as complete, which hid the board's
  // most-read material behind the completed filter on the day it was written.
  it('keeps the document statuses out of the task scale', () => {
    expect(DOCUMENT_STATUSES).toEqual(['active', 'archived']);
    const open = STATUS_GROUPS.find((g) => g.id === 'open')!;
    for (const status of DOCUMENT_STATUSES) expect(open.statuses).not.toContain(status);
  });

  // Documents above Archived: a current reference is something you reach for
  // while working, not something waiting on you.
  it('puts Documents before Archived, and archived documents with finished work', () => {
    const order = STATUS_GROUPS.map((g) => g.id);
    expect(order.indexOf('documents')).toBeLessThan(order.indexOf('archived'));
    expect(STATUS_GROUPS.find((g) => g.id === 'documents')!.statuses).toEqual(['active']);
    expect(STATUS_GROUPS.find((g) => g.id === 'archived')!.statuses).toEqual(['archived', 'complete', 'cancelled']);
  });

  it('accepts the old spelling and stores the new one', () => {
    expect(asStatusValue('needs-you')).toBe('needs-decision');
    expect(asStatusValue('needs-qa')).toBe('needs-qa');
    expect(asStatusValue('nonsense')).toBe(null);
    expect(asStatusValue(undefined)).toBe(null);
  });

  it('starts an item needing a decision, not QA', () => {
    const project = store.createProject({ name: 'Acme' });
    expect(store.createItem(project.id, { title: 'a' }).status).toBe('needs-decision');
  });

  it('can be set to needs-qa and counted there', () => {
    const project = store.createProject({ name: 'Acme' });
    const item = store.createItem(project.id, { title: 'a' });
    store.updateItem(item.id, { status: 'needs-qa' });
    expect(store.counts(project.id)['needs-qa']).toBe(1);
    expect(store.counts(project.id)['needs-decision']).toBe(0);
  });

  it('counts every status, including the ones at zero', () => {
    const project = store.createProject({ name: 'Acme' });
    expect(Object.keys(store.counts(project.id)).sort()).toEqual([...STATUSES].sort());
  });
});

// Kind decides which statuses an item may hold. The two sets do not overlap:
// offering all seven let a specification be set to "Received", which is the
// exact confusion the split exists to prevent.
describe('kind and status', () => {
  let store: Store;
  let projectId: string;
  beforeEach(() => {
    store = freshStore();
    projectId = store.createProject({ name: 'Acme' }).id;
  });

  it('defaults to an issue', () => {
    expect(store.createItem(projectId, { title: 'a' }).kind).toBe('issue');
  });

  it('splits the statuses with no overlap and no gaps', () => {
    expect(statusesFor('document')).toEqual(['active', 'archived']);
    expect(statusesFor('issue')).toEqual(['needs-decision', 'needs-qa', 'received', 'in-progress', 'deferred', 'complete', 'cancelled']);
    expect([...statusesFor('issue'), ...statusesFor('document')].sort()).toEqual([...STATUSES].sort());
    for (const s of statusesFor('document')) expect(statusesFor('issue')).not.toContain(s);
  });

  it('starts a document Active and an issue needing a decision', () => {
    expect(store.createItem(projectId, { title: 'a', kind: 'document' }).status).toBe('active');
    expect(store.createItem(projectId, { title: 'b', kind: 'issue' }).status).toBe('needs-decision');
  });

  // Replaced rather than refused on create: the caller told us what the thing
  // IS, which is the more reliable half, and losing the item over a status an
  // older writer could not have known about is the worse failure.
  it('replaces a status the kind cannot hold', () => {
    expect(store.createItem(projectId, { title: 'a', kind: 'document', status: 'received' }).status).toBe('active');
    expect(store.createItem(projectId, { title: 'b', kind: 'issue', status: 'archived' }).status).toBe('needs-decision');
  });

  it('keeps a status the kind can hold', () => {
    expect(store.createItem(projectId, { title: 'a', kind: 'document', status: 'archived' }).status).toBe('archived');
    expect(store.createItem(projectId, { title: 'b', status: 'needs-qa' }).status).toBe('needs-qa');
  });

  // cancelled (contract v4): an issue that will not be done. A task status, so a
  // document cannot hold it, and it files with the finished work.
  it('cancelled is an issue status that files under Archived and counts', () => {
    const cancelled = store.createItem(projectId, { title: 'drop it', status: 'cancelled' });
    expect(cancelled.status).toBe('cancelled');
    expect(store.createItem(projectId, { title: 'spec', kind: 'document', status: 'cancelled' }).status).toBe('active');
    const archivedGroup = STATUS_GROUPS.find((g) => g.id === 'archived')!;
    expect(archivedGroup.statuses).toEqual(['archived', 'complete', 'cancelled']);
    expect(store.counts(projectId).cancelled).toBe(1);
    const moved = store.updateItem(cancelled.id, { status: 'received' }, { actor: 'x' })!;
    expect(store.updateItem(moved.id, { status: 'cancelled' }, { actor: 'x', ifVersion: moved.version })!.status).toBe('cancelled');
  });

  // Changing kind is legitimate — a decision that turns out to be a spec — but
  // it must never leave the item holding a status its new kind does not have.
  it('carries the status with it when the kind changes', () => {
    const item = store.createItem(projectId, { title: 'a', status: 'received' });
    store.updateItem(item.id, { kind: 'document' });
    const after = store.getItem(item.id)!;
    expect(after.kind).toBe('document');
    expect(after.status).toBe('active');
  });

  it('accepts a valid status in the same patch that changes the kind', () => {
    const item = store.createItem(projectId, { title: 'a', status: 'received' });
    store.updateItem(item.id, { kind: 'document', status: 'archived' });
    expect(store.getItem(item.id)!.status).toBe('archived');
  });

  it('refuses to let an unrelated patch move a status off its kind', () => {
    const doc = store.createItem(projectId, { title: 'a', kind: 'document' });
    store.updateItem(doc.id, { status: 'complete' });
    expect(store.getItem(doc.id)!.status).toBe('active');
  });

  // A document has no "the agent is working on it" state, so a human reply must
  // not drag it there — that would put a specification in a status its own
  // dropdown cannot show.
  it('does not move a document to received when the human replies', () => {
    const doc = store.createItem(projectId, { title: 'a', kind: 'document', status: 'archived' });
    store.addMessage(doc.id, { who: 'you', text: 'still relevant' });
    expect(store.getItem(doc.id)!.status).toBe('archived');
  });

  it('still moves an issue to received when the human replies', () => {
    const item = store.createItem(projectId, { title: 'a' });
    store.addMessage(item.id, { who: 'you', text: 'do it' });
    expect(store.getItem(item.id)!.status).toBe('received');
  });
});

// `received` used to mean both "the answer arrived" and "somebody is working on
// it", and the only thing that ever started work was a human reply landing in a
// live session. Lose the session — outage, crash, context reset — and that
// trigger goes with it: the item still reads `received`, nobody is on it, and
// nothing on the board says so.
describe('claiming work survives a lost session', () => {
  let store: Store;
  let projectId: string;
  beforeEach(() => {
    store = freshStore();
    projectId = store.createProject({ name: 'Acme' }).id;
  });

  it('separates the answer arriving from somebody picking it up', () => {
    const item = store.createItem(projectId, { title: 'a' });
    store.addMessage(item.id, { who: 'you', text: 'go ahead' });
    // The human's reply hands it back, and says nothing about anyone starting.
    expect(store.getItem(item.id)!.status).toBe('received');
    store.updateItem(item.id, { status: 'in-progress' }, { actor: 'claude-code' });
    expect(store.getItem(item.id)!.status).toBe('in-progress');
  });

  // The whole point: a claim has to say WHO, or a survivor cannot tell an
  // abandoned claim from somebody else's live work.
  it('records who claimed it', () => {
    const item = store.createItem(projectId, { title: 'a' });
    store.updateItem(item.id, { status: 'in-progress' }, { actor: 'codex' });
    expect(store.getItem(item.id)!.updatedBy).toBe('codex');
  });

  // And WHEN, so staleness is answerable without a heartbeat or a lock table.
  it('records when, so an abandoned claim is visible', () => {
    const item = store.createItem(projectId, { title: 'a' });
    const before = Date.now();
    store.updateItem(item.id, { status: 'in-progress' }, { actor: 'claude-code' });
    expect(Date.parse(store.getItem(item.id)!.updatedAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('is a live task state, so a claimed item stays visible under Open', () => {
    const open = STATUS_GROUPS.find((g) => g.id === 'open')!;
    expect(open.statuses).toContain('in-progress');
  });

  // A document is never claimed — there is no work to pick up on something you
  // read — so the kind guard has to keep it out.
  it('is an issue state only', () => {
    expect(statusesFor('document')).not.toContain('in-progress');
    const doc = store.createItem(projectId, { title: 'a', kind: 'document' });
    store.updateItem(doc.id, { status: 'in-progress' });
    expect(store.getItem(doc.id)!.status).toBe('active');
  });

  // Two agents on one board: the second must be refused rather than silently
  // taking work the first is already doing.
  it('refuses a second claim from a writer holding an older copy', () => {
    const item = store.createItem(projectId, { title: 'a' });
    const read = store.getItem(item.id)!;
    store.updateItem(item.id, { status: 'in-progress' }, { actor: 'codex', ifVersion: read.version });
    expect(() => store.updateItem(item.id, { status: 'in-progress' }, { actor: 'claude-code', ifVersion: read.version }))
      .toThrow(VersionConflict);
  });
});

// The handshake is symmetric, and it was not. A human reply always moved an
// issue to `received`; an agent reply moved nothing — so an agent that answered
// an item and forgot the separate status call left it reading `received`,
// indistinguishable from an item nobody had touched. "Post a message, set the
// status" had only one of its two halves enforced by anything.
describe('an agent reply claims what it answers', () => {
  let store: Store;
  let projectId: string;
  beforeEach(() => {
    store = freshStore();
    projectId = store.createProject({ name: 'Acme' }).id;
  });

  function answered() {
    const item = store.createItem(projectId, { title: 'a' });
    store.addMessage(item.id, { who: 'you', text: 'go ahead' });
    return item.id;
  }

  it('moves a received item to in-progress when the agent replies', () => {
    const id = answered();
    expect(store.getItem(id)!.status).toBe('received');
    store.addMessage(id, { who: 'agent', author: 'claude-code', text: 'on it' });
    expect(store.getItem(id)!.status).toBe('in-progress');
  });

  it('records who claimed it, so the claim is recoverable', () => {
    const id = answered();
    store.addMessage(id, { who: 'agent', author: 'codex', text: 'on it' });
    expect(store.getItem(id)!.updatedBy).toBe('codex');
  });

  // The reply that hands it back must still be able to say so.
  it('honours an explicit status over the claim', () => {
    const id = answered();
    store.addMessage(id, { who: 'agent', author: 'claude-code', text: 'your call', status: 'needs-decision' });
    expect(store.getItem(id)!.status).toBe('needs-decision');
  });

  // Narrow on purpose: only `received` is unambiguous. An agent adding context
  // to a question still waiting on the human leaves the move where it is.
  it('leaves an item that is waiting on the human alone', () => {
    for (const status of ['needs-decision', 'needs-qa'] as const) {
      const item = store.createItem(projectId, { title: `t-${status}`, status });
      store.addMessage(item.id, { who: 'agent', author: 'claude-code', text: 'one more thing' });
      expect(store.getItem(item.id)!.status).toBe(status);
    }
  });

  it('does not resurrect a deferred or completed item', () => {
    for (const status of ['deferred', 'complete'] as const) {
      const item = store.createItem(projectId, { title: `d-${status}`, status });
      store.addMessage(item.id, { who: 'agent', author: 'claude-code', text: 'noting this' });
      expect(store.getItem(item.id)!.status).toBe(status);
    }
  });

  it('never claims a document', () => {
    const doc = store.createItem(projectId, { title: 'spec', kind: 'document' });
    store.addMessage(doc.id, { who: 'agent', author: 'claude-code', text: 'updated' });
    expect(store.getItem(doc.id)!.status).toBe('active');
  });

  // The failure this prevents: B says "nice" on A's in-progress item, and the
  // board now reports B as the holder. Every recovery decision in the contract
  // is made from `updatedBy` and `updatedAt`, so a comment that repaints them
  // does not just lose a name — it invents a claim nobody made.
  it('leaves the claim with whoever made it when somebody else comments', () => {
    const id = answered();
    store.addMessage(id, { who: 'agent', author: 'agent-a', text: 'picking this up' });
    const claimed = store.getItem(id)!;
    expect(claimed.status).toBe('in-progress');
    expect(claimed.updatedBy).toBe('agent-a');

    store.addMessage(id, { who: 'agent', author: 'agent-b', text: 'looks right to me' });

    const after = store.getItem(id)!;
    expect(after.updatedBy).toBe('agent-a');
    expect(after.updatedAt).toBe(claimed.updatedAt);
    expect(after.version).toBe(claimed.version);
    // The comment itself is still on the record — the item row is untouched,
    // not the thread.
    expect(store.listMessages(id).map((m) => m.author)).toEqual(['you', 'agent-a', 'agent-b']);
  });

  it('does not bump the version for a message that changes nothing', () => {
    const id = answered();
    const before = store.getItem(id)!;
    store.addMessage(id, { who: 'you', text: 'one more thing' });
    expect(store.getItem(id)!.version).toBe(before.version);
  });

  // The other half of the same rule: a message that DOES move the status still
  // owns the row, or the version guard stops protecting concurrent editors.
  it('still stamps the row when the message moves the status', () => {
    const item = store.createItem(projectId, { title: 'a' });
    expect(item.status).toBe('needs-decision');
    store.addMessage(item.id, { who: 'you', text: 'go ahead' });
    const after = store.getItem(item.id)!;
    expect(after.status).toBe('received');
    expect(after.version).toBe(item.version + 1);
  });
});
