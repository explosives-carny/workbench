import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { InvalidProjectKey, openDb, ProjectKeyTaken, Store } from '../src/db.ts';

type TempStore = {
  database: Database;
  path: string;
  store: Store;
};

type LegacyFixture = {
  itemIds: { first: string; second: string; third: string; other: string };
  path: string;
  projectIds: { one: string; two: string };
};

const databases: Database[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function registerDatabase(database: Database): Database {
  databases.push(database);
  return database;
}

function closeDatabase(database: Database): void {
  database.close();
  const index = databases.indexOf(database);
  if (index >= 0) databases.splice(index, 1);
}

function freshStore(): TempStore {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-refs-'));
  const path = join(directory, 'test.db');
  directories.push(directory);
  const database = registerDatabase(openDb(path));
  return { database, path, store: new Store(database) };
}

function createLegacyFixture(): LegacyFixture {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-refs-legacy-'));
  const path = join(directory, 'legacy.db');
  directories.push(directory);
  const database = registerDatabase(new Database(path, { create: true }));
  const projectIds = { one: 'project-one', two: 'project-two' };
  const itemIds = { first: 'item-a', second: 'item-b', third: 'item-c', other: 'item-d' };

  database.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      context TEXT NOT NULL,
      options TEXT NOT NULL,
      choice TEXT NOT NULL,
      status TEXT NOT NULL,
      section TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const insertProject = database.query(
    'INSERT INTO projects (id, slug, name, description, created_at, archived_at) VALUES (?, ?, ?, ?, ?, NULL)'
  );
  insertProject.run(projectIds.one, 'one', 'One', '', '2020-01-01T00:00:00.000Z');
  insertProject.run(projectIds.two, 'two', 'Two', '', '2020-01-01T00:00:00.000Z');
  const insertItem = database.query(
    `INSERT INTO items (id, project_id, title, context, options, choice, status, section, position, created_at, updated_at)
     VALUES (?, ?, ?, '', '[]', '', 'needs-decision', '', 0, ?, ?)`
  );
  insertItem.run(itemIds.third, projectIds.one, 'third', '2020-01-02T00:00:00.000Z', '2020-01-02T00:00:00.000Z');
  insertItem.run(itemIds.second, projectIds.one, 'second', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
  insertItem.run(itemIds.first, projectIds.one, 'first', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
  insertItem.run(itemIds.other, projectIds.two, 'other', '2020-01-03T00:00:00.000Z', '2020-01-03T00:00:00.000Z');
  closeDatabase(database);
  return { itemIds, path, projectIds };
}

describe('item references', () => {
  it('backfills legacy sequences by created_at then id, separately per project', () => {
    const fixture = createLegacyFixture();
    const database = registerDatabase(openDb(fixture.path));
    const store = new Store(database);

    expect(store.getItem(fixture.itemIds.first)!.seq).toBe(1);
    expect(store.getItem(fixture.itemIds.second)!.seq).toBe(2);
    expect(store.getItem(fixture.itemIds.third)!.seq).toBe(3);
    expect(store.getItem(fixture.itemIds.other)!.seq).toBe(1);
    expect(store.getProject('one')!.nextSeq).toBe(4);
    expect(store.getProject('two')!.nextSeq).toBe(2);
  });

  it('does not change existing sequence backfill values when reopened', () => {
    const fixture = createLegacyFixture();
    const firstDatabase = registerDatabase(openDb(fixture.path));
    const firstStore = new Store(firstDatabase);
    const firstSeqs = [
      firstStore.getItem(fixture.itemIds.first)!.seq,
      firstStore.getItem(fixture.itemIds.second)!.seq,
      firstStore.getItem(fixture.itemIds.third)!.seq,
    ];
    const firstNextSeq = firstStore.getProject('one')!.nextSeq;
    closeDatabase(firstDatabase);

    const secondDatabase = registerDatabase(openDb(fixture.path));
    const secondStore = new Store(secondDatabase);
    expect([
      secondStore.getItem(fixture.itemIds.first)!.seq,
      secondStore.getItem(fixture.itemIds.second)!.seq,
      secondStore.getItem(fixture.itemIds.third)!.seq,
    ]).toEqual(firstSeqs);
    expect(secondStore.getProject('one')!.nextSeq).toBe(firstNextSeq);
  });

  it('assigns unique consecutive sequences across stores and nested batches', () => {
    const first = freshStore();
    const secondDatabase = registerDatabase(openDb(first.path));
    const secondStore = new Store(secondDatabase);
    const project = first.store.createProject({ name: 'Project' });
    const created: number[] = [];

    for (let index = 0; index < 10; index += 1) {
      created.push((index % 2 === 0 ? first.store : secondStore).createItem(project.id, { title: `single-${index}` }).seq);
    }
    first.database.transaction(() => {
      for (let index = 0; index < 10; index += 1) created.push(first.store.createItem(project.id, { title: `first-batch-${index}` }).seq);
    })();
    secondDatabase.transaction(() => {
      for (let index = 0; index < 10; index += 1) created.push(secondStore.createItem(project.id, { title: `second-batch-${index}` }).seq);
    })();
    for (let index = 0; index < 10; index += 1) {
      created.push((index % 2 === 0 ? secondStore : first.store).createItem(project.id, { title: `tail-${index}` }).seq);
    }

    expect(created).toHaveLength(40);
    expect([...created].sort((left, right) => left - right)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    expect(first.store.getProject(project.slug)!.nextSeq).toBe(41);
  });

  it('does not consume a sequence for a client-id retry', () => {
    const { store } = freshStore();
    const project = store.createProject({ name: 'Project' });
    const first = store.createItem(project.id, { title: 'first', clientId: 'c1' });
    const retry = store.createItem(project.id, { title: 'ignored retry', clientId: 'c1' });
    const next = store.createItem(project.id, { title: 'next' });

    expect(first.seq).toBe(1);
    expect(retry.id).toBe(first.id);
    expect(next.seq).toBe(2);
    expect(store.getProject(project.slug)!.nextSeq).toBe(3);
  });

  it('validates, normalises, reserves, and idempotently sets project keys', () => {
    const { store } = freshStore();
    for (const key of ['a', 'TOOLONG', '1AB', 'A-B', '']) {
      expect(() => store.createProject({ name: `Project ${key || 'empty'}`, key })).toThrow(InvalidProjectKey);
    }
    const project = store.createProject({ name: 'Project', key: ' demo ' });

    expect(project.key).toBe('DEMO');
    expect(() => store.createProject({ name: 'Other', key: 'DEMO' })).toThrow(ProjectKeyTaken);
    expect(store.setProjectKey(project.slug, 'demo')).toMatchObject({ changed: false, previousKey: 'DEMO' });
  });

  it('adds references to existing items when a project receives a key', () => {
    const { store } = freshStore();
    const project = store.createProject({ name: 'Project' });
    const first = store.createItem(project.id, { title: 'first' });
    const second = store.createItem(project.id, { title: 'second' });

    expect(first.ref).toBeNull();
    expect(second.ref).toBeNull();
    expect([first.seq, second.seq]).toEqual([1, 2]);
    store.setProjectKey(project.slug, 'DEMO');

    expect(store.listItems(project.id, 'none').map((item) => item.ref)).toEqual(['WB-DEMO-1', 'WB-DEMO-2']);
    expect(store.getItem(first.id)!.ref).toBe('WB-DEMO-1');
    expect(store.getItem(second.id)!.ref).toBe('WB-DEMO-2');
  });

  it('keeps former keys resolving and reserved across renames', () => {
    const { store } = freshStore();
    const project = store.createProject({ name: 'Project', key: 'DEMO' });
    store.createItem(project.id, { title: 'first' });
    const second = store.createItem(project.id, { title: 'second' });

    store.setProjectKey(project.slug, 'ACME');
    expect(store.resolveItem('wb-demo-2')!.id).toBe(second.id);
    expect(store.resolveItem('WB-ACME-2')!.id).toBe(second.id);
    expect(store.getProject(project.slug)!.oldKeys).toEqual(['DEMO']);
    expect(() => store.createProject({ name: 'Other', key: 'DEMO' })).toThrow(ProjectKeyTaken);

    store.setProjectKey(project.slug, 'DEMO');
    expect(store.getProject(project.slug)!.oldKeys).toEqual(['ACME']);
  });

  it('resolves UUIDs and case-insensitive references while rejecting invalid lookups', () => {
    const { store } = freshStore();
    const project = store.createProject({ name: 'Project', key: 'DEMO' });
    const item = store.createItem(project.id, { title: 'item' });

    expect(store.resolveItem(item.id)!.id).toBe(item.id);
    expect(store.resolveItem('wb-demo-1')!.id).toBe(item.id);
    expect(store.resolveItem('WB-DEMO-99')).toBeNull();
    expect(store.resolveItem('WB-DEMO-0')).toBeNull();
    expect(store.resolveItem('WB-DEMO-x')).toBeNull();
    expect(store.resolveItem('nonsense')).toBeNull();
  });

  it('never restores nextSeq below an existing item sequence', () => {
    const { store } = freshStore();
    const project = store.createProject({ name: 'Project', key: 'DEMO' });
    store.createItem(project.id, { title: 'imported', seq: 7 });

    const restored = store.restoreProjectIdentity(project.slug, { key: 'DEMO', oldKeys: [], nextSeq: 1 })!;
    expect(restored.nextSeq).toBe(8);
  });

  it('retains an unused imported sequence and replaces a duplicate one', () => {
    const { store } = freshStore();
    const project = store.createProject({ name: 'Project' });
    const imported = store.createItem(project.id, { title: 'imported', seq: 7 });
    const fresh = store.createItem(project.id, { title: 'fresh' });
    const duplicate = store.createItem(project.id, { title: 'duplicate', seq: 7 });

    expect(imported.seq).toBe(7);
    expect(fresh.seq).toBe(8);
    expect(duplicate.seq).toBe(9);
  });
});
