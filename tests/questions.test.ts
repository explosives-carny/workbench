// Question sets (contract v23): one item, several questions, each with its own
// options, recommendation and answer slot, answered one at a time.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { openDb, Store, isAnswered } from '../src/db.ts';
import { createHandler } from '../src/app.ts';
import { exportAll, importAll } from '../src/export.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

let paths: string[];
let store: Store;
let handler: (req: Request) => Promise<Response>;

function tmpDb(tag: string): string {
  const p = join(tmpdir(), `workbench-questions-${tag}-${Math.random().toString(36).slice(2)}.db`);
  paths.push(p);
  return p;
}

beforeEach(async () => {
  paths = [];
  store = new Store(openDb(tmpDb('main')));
  handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD });
  expect((await api('POST', '/api/projects', { name: 'Demo', key: 'demo' })).status).toBe(201);
});

afterEach(() => {
  for (const p of paths) for (const s of ['', '-wal', '-shm']) { try { rmSync(p + s, { recursive: true }); } catch {} }
});

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

const QS = [
  { id: 's1', label: 'Packing location', ask: 'Where do the cases go?', options: ['Bay A', 'Bay B'], recommended: ['Bay A'] },
  { id: 's2', label: 'Label stock', ask: 'Which label stock?', options: ['Thermal', 'Paper'], recommended: ['Thermal'] },
  { id: 's3', label: 'Notes', ask: 'Anything else the crew should know?' },
];

async function makeSet(extra: Record<string, unknown> = {}, questions: unknown[] = QS) {
  const res = await api('POST', '/api/projects/demo/items', { title: 'Three questions', kind: 'questions', context: 'Shared facts.', questions, ...extra });
  expect(res.status).toBe(201);
  return res.json.items[0];
}
const answer = (id: string, qid: string, body: Record<string, unknown>) => api('PATCH', `/api/items/${id}/questions/${qid}`, { actor: 'you', ...body });

describe('creating a question set', () => {
  test('lands at needs-decision with the questions, ids kept, labels and counts derived', async () => {
    const item = await makeSet();
    expect(item.kind).toBe('questions');
    expect(item.status).toBe('needs-decision');
    expect(item.questions.map((q: any) => q.id)).toEqual(['s1', 's2', 's3']);
    expect(item.questions[0]).toMatchObject({ label: 'Packing location', choice: '', answer: '', by: '', at: '', relayed: false });
    expect(item.questionCount).toBe(3);
    expect(item.answered).toBe(0);
    expect(item.options).toEqual([]);
  });

  test('a question without an id gets q<n>; a missing label is the first line of the ask, cut to 60', async () => {
    const long = 'x'.repeat(90);
    const item = await makeSet({}, [{ ask: `${long}\nsecond line` }, { label: 'Two', ask: 'b' }]);
    expect(item.questions.map((q: any) => q.id)).toEqual(['q1', 'q2']);
    expect(item.questions[0].label).toBe('x'.repeat(60));
  });

  test('a recommended entry that is not one of the question\'s options is dropped', async () => {
    const item = await makeSet({}, [{ id: 'a', ask: 'Pick', options: ['One', 'Two'], recommended: ['Two', 'Three'] }]);
    expect(item.questions[0].recommended).toEqual(['Two']);
  });

  test('duplicate ids are refused, naming the id, and nothing is created', async () => {
    const res = await api('POST', '/api/projects/demo/items', { title: 'X', kind: 'questions', questions: [{ id: 'a', ask: 'one' }, { id: 'a', ask: 'two' }] });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('"a"');
    expect((await api('GET', '/api/projects/demo')).json.items).toHaveLength(0);
  });

  test('item-level options or recommended on a question set are refused with the pointer to the question', async () => {
    for (const extra of [{ options: ['A'] }, { recommended: ['A'] }]) {
      const res = await api('POST', '/api/projects/demo/items', { title: 'X', kind: 'questions', questions: [{ ask: 'q' }], ...extra });
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('a question set carries its options on each question');
    }
    const item = await makeSet();
    const patched = await api('PATCH', `/api/items/${item.id}`, { options: ['A'], ifVersion: item.version, actor: 'a' });
    expect(patched.status).toBe(400);
  });

  test('questions on another kind are refused, naming the kind', async () => {
    const issue = await api('POST', '/api/projects/demo/items', { title: 'X', questions: [{ ask: 'q' }] });
    expect(issue.status).toBe(400);
    expect(issue.json.error).toContain('issue');
    const doc = await api('POST', '/api/projects/demo/items', { title: 'X', kind: 'document', questions: [{ ask: 'q' }] });
    expect(doc.status).toBe(400);
    expect(doc.json.error).toContain('document');
  });

  test('a malformed question list is refused with a message that says what to send', async () => {
    expect((await api('POST', '/api/projects/demo/items', { title: 'X', kind: 'questions', questions: 'nope' })).status).toBe(400);
    expect((await api('POST', '/api/projects/demo/items', { title: 'X', kind: 'questions', questions: [{ options: ['A'] }] })).status).toBe(400);
    expect((await api('POST', '/api/projects/demo/items', { title: 'X', kind: 'questions', questions: [{ ask: 'q', options: 'A' }] })).status).toBe(400);
  });

  test('kind questions on a to-do project is refused as an issue is', async () => {
    await api('POST', '/api/projects', { name: 'Chores', key: 'chr', mode: 'todo' });
    const res = await api('POST', '/api/projects/chores/items', { title: 'X', kind: 'questions', questions: [{ ask: 'q' }] });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('to-do project');
  });

  test('warns per question without a recommendation, naming the id, and on an empty set', async () => {
    const res = await api('POST', '/api/projects/demo/items', { title: 'X', kind: 'questions', questions: [{ id: 'q9', ask: 'Pick', options: ['A', 'B'] }] });
    expect(res.json.warnings.join(' | ')).toContain('question q9');
    const empty = await api('POST', '/api/projects/demo/items', { title: 'Empty', kind: 'questions' });
    expect(empty.json.warnings.join(' | ')).toContain('no questions');
  });

  test('more than twelve questions is a hint on the write, not a refusal', async () => {
    const many = Array.from({ length: 13 }, (_, n) => ({ ask: `Question ${n + 1}?` }));
    const res = await api('POST', '/api/projects/demo/items', { title: 'Long', kind: 'questions', questions: many });
    expect(res.status).toBe(201);
    expect(res.json.warnings.join(' | ')).toContain('13 questions');
  });

  test('format warnings name the question field', async () => {
    const res = await api('POST', '/api/projects/demo/items', {
      title: 'X', kind: 'questions',
      questions: [{ id: 'w1', ask: 'y'.repeat(500), options: ['A (see above)', 'B'], recommended: ['B'] }],
    });
    const text = res.json.warnings.join(' | ');
    expect(text).toContain('questions[w1].ask');
    expect(text).toContain('questions[w1].options');
  });
});

describe('answering one question at a time', () => {
  test('records the choice and a note, who and when, and never touches updatedBy', async () => {
    const item = await makeSet();
    const res = await answer(item.id, 's1', { choice: 'Bay B', answer: 'closer to the dock' });
    expect(res.status).toBe(200);
    const q = res.json.item.questions[0];
    expect(q).toMatchObject({ choice: 'Bay B', answer: 'closer to the dock', by: 'you', relayed: false });
    expect(q.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(res.json.item.answered).toBe(1);
    expect(res.json.item.version).toBe(item.version + 1);
    expect(res.json.item.updatedBy).toBe(item.updatedBy);
    expect(res.json.item.status).toBe('needs-decision');
  });

  test('a free-text question takes an answer; a choice on it is refused', async () => {
    const item = await makeSet();
    expect((await answer(item.id, 's3', { answer: 'Bring ear plugs' })).status).toBe(200);
    const res = await answer(item.id, 's3', { choice: 'Yes' });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('no options');
  });

  test('an unknown question id is 404 and names the known ids', async () => {
    const item = await makeSet();
    const res = await answer(item.id, 'zz', { answer: 'x' });
    expect(res.status).toBe(404);
    expect(res.json.error).toContain('s1, s2, s3');
  });

  test('a choice that is not among the options is 400 and names them', async () => {
    const item = await makeSet();
    const res = await answer(item.id, 's1', { choice: 'Bay Z' });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('Bay A');
    expect(res.json.error).toContain('Bay B');
  });

  test('an empty save records nothing and erases nothing', async () => {
    const item = await makeSet();
    await answer(item.id, 's1', { choice: 'Bay A' });
    for (const body of [{}, { answer: '   ' }, { choice: '' }]) {
      const res = await answer(item.id, 's1', body);
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('nothing to record');
    }
    expect((await api('GET', `/api/items/${item.id}`)).json.item.questions[0].choice).toBe('Bay A');
  });

  test('clear: true empties the whole slot', async () => {
    const item = await makeSet();
    await answer(item.id, 's1', { choice: 'Bay A', answer: 'note' });
    const res = await answer(item.id, 's1', { clear: true });
    expect(res.status).toBe(200);
    expect(res.json.item.questions[0]).toMatchObject({ choice: '', answer: '', by: '', at: '', relayed: false });
    expect(res.json.item.answered).toBe(0);
  });

  test('an actor other than you is refused unless it relays', async () => {
    const item = await makeSet();
    const refused = await api('PATCH', `/api/items/${item.id}/questions/s1`, { choice: 'Bay A', actor: 'tool-a' });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toContain('relay:true');
    const relayed = await api('PATCH', `/api/items/${item.id}/questions/s1`, { choice: 'Bay A', actor: 'tool-a', relay: true });
    expect(relayed.status).toBe(200);
    expect(relayed.json.item.questions[0]).toMatchObject({ by: 'tool-a', relayed: true });
  });

  test('refs resolve, other methods are 405, and answers on another kind are refused', async () => {
    const item = await makeSet();
    const byRef = await api('PATCH', `/api/items/${item.ref}/questions/s1`, { choice: 'Bay A', actor: 'you' });
    expect(byRef.status).toBe(200);
    const get = await api('GET', `/api/items/${item.id}/questions/s1`);
    expect(get.status).toBe(405);
    expect(get.json.error).toContain('one at a time with PATCH');
    expect((await api('POST', `/api/items/${item.id}/questions/s1`, {})).status).toBe(405);
    const issue = (await api('POST', '/api/projects/demo/items', { title: 'Plain' })).json.items[0];
    expect((await answer(issue.id, 's1', { answer: 'x' })).status).toBe(400);
  });

  test('the last answer moves a needs-decision set to received with one message', async () => {
    const item = await makeSet();
    await answer(item.id, 's1', { choice: 'Bay A' });
    await answer(item.id, 's2', { choice: 'Paper' });
    expect((await api('GET', `/api/items/${item.id}`)).json.item.status).toBe('needs-decision');
    const last = await answer(item.id, 's3', { answer: 'done' });
    expect(last.json.item.status).toBe('received');
    const messages = last.json.item.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: 'All 3 questions answered', who: 'you', author: 'you' });
  });

  test('a relayed last answer posts the message as the agent', async () => {
    const item = await makeSet({}, [{ id: 'a', ask: 'Only one?' }]);
    const res = await api('PATCH', `/api/items/${item.id}/questions/a`, { answer: 'yes', actor: 'tool-a', relay: true });
    expect(res.json.item.messages[0]).toMatchObject({ who: 'agent', author: 'tool-a' });
    expect(res.json.item.status).toBe('received');
  });

  test('nine concurrent answers produce exactly one completion message', async () => {
    const nine = Array.from({ length: 9 }, (_, n) => ({ id: `n${n}`, ask: `Q${n}?` }));
    const item = await makeSet({}, nine);
    const results = await Promise.all(nine.map((q) => answer(item.id, q.id, { answer: `a-${q.id}` })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const after = (await api('GET', `/api/items/${item.id}`)).json.item;
    expect(after.answered).toBe(9);
    expect(after.messages.filter((m: any) => m.text === 'All 9 questions answered')).toHaveLength(1);
    expect(after.status).toBe('received');
  });

  test('answering an item that is not at needs-decision records and moves nothing', async () => {
    const item = await makeSet({ status: 'in-progress' });
    const res = await answer(item.id, 's1', { choice: 'Bay A' });
    expect(res.json.item.status).toBe('in-progress');
    await answer(item.id, 's2', { choice: 'Paper' });
    const last = await answer(item.id, 's3', { answer: 'x' });
    expect(last.json.item.status).toBe('in-progress');
    expect(last.json.item.messages).toHaveLength(0);
  });

  test('a person\'s reply still moves a set to received, and an agent reply on received claims it', async () => {
    const item = await makeSet();
    const reply = await api('POST', `/api/items/${item.id}/messages`, { who: 'you', text: 'Let me think about it.' });
    expect(reply.json.item.status).toBe('received');
    const claim = await api('POST', `/api/items/${item.id}/messages`, { who: 'agent', actor: 'tool-a', text: 'On it.' });
    expect(claim.json.item.status).toBe('in-progress');
  });
});

describe('redefining the questions', () => {
  test('merges by id: an existing question keeps its answer and takes the new ask', async () => {
    const item = await makeSet();
    await answer(item.id, 's1', { choice: 'Bay A', answer: 'note' });
    const current = (await api('GET', `/api/items/${item.id}`)).json.item;
    const res = await api('PATCH', `/api/items/${item.id}`, {
      actor: 'a', ifVersion: current.version,
      questions: [{ id: 's1', label: 'Where?', ask: 'Reworded ask', options: ['Bay A', 'Bay B'], recommended: ['Bay B'] }, QS[1], QS[2], { id: 's4', ask: 'A new one?' }],
    });
    expect(res.status).toBe(200);
    const [s1] = res.json.item.questions;
    expect(s1).toMatchObject({ label: 'Where?', ask: 'Reworded ask', choice: 'Bay A', answer: 'note', by: 'you', recommended: ['Bay B'] });
    expect(res.json.item.questions.map((q: any) => q.id)).toEqual(['s1', 's2', 's3', 's4']);
  });

  test('options that no longer offer the stored choice clear it and say so', async () => {
    const item = await makeSet();
    await answer(item.id, 's1', { choice: 'Bay A' });
    const current = (await api('GET', `/api/items/${item.id}`)).json.item;
    const res = await api('PATCH', `/api/items/${item.id}`, {
      actor: 'a', ifVersion: current.version,
      questions: [{ id: 's1', ask: 'Where?', options: ['Bay C', 'Bay D'], recommended: ['Bay C'] }, QS[1], QS[2]],
    });
    expect(res.status).toBe(200);
    expect(res.json.item.questions[0]).toMatchObject({ choice: '', by: '', at: '' });
    expect(res.json.warning).toContain('"Bay A"');
  });

  test('dropping an answered question is 409 with the live item, unless replaceQuestions is sent', async () => {
    const item = await makeSet();
    await answer(item.id, 's1', { choice: 'Bay A' });
    const current = (await api('GET', `/api/items/${item.id}`)).json.item;
    const locked = await api('PATCH', `/api/items/${item.id}`, { actor: 'a', ifVersion: current.version, questions: [QS[1], QS[2]] });
    expect(locked.status).toBe(409);
    expect(locked.json.conflict).toBe('questions');
    expect(locked.json.answeredIds).toEqual(['s1']);
    expect(locked.json.item.questions).toHaveLength(3);
    const forced = await api('PATCH', `/api/items/${item.id}`, { actor: 'a', ifVersion: current.version, questions: [QS[1], QS[2]], replaceQuestions: true });
    expect(forced.status).toBe(200);
    expect(forced.json.item.questions.map((q: any) => q.id)).toEqual(['s2', 's3']);
  });

  test('dropping an unanswered question needs no ceremony', async () => {
    const item = await makeSet();
    const res = await api('PATCH', `/api/items/${item.id}`, { actor: 'a', ifVersion: item.version, questions: [QS[0]] });
    expect(res.status).toBe(200);
    expect(res.json.item.questions).toHaveLength(1);
  });

  test('one write turns an issue into a question set, clears its item-level fields and adds the questions', async () => {
    const issue = (await api('POST', '/api/projects/demo/items', { title: 'Old shape', options: ['A', 'B'], recommended: ['A'], choice: 'A', context: 'facts' })).json.items[0];
    const res = await api('PATCH', `/api/items/${issue.id}`, {
      kind: 'questions', options: [], recommended: [], choice: '', questions: QS, actor: 'a', ifVersion: issue.version,
    });
    expect(res.status).toBe(200);
    expect(res.json.item).toMatchObject({ kind: 'questions', options: [], recommended: [], choice: '', questionCount: 3 });
    // The same change without clearing the item-level options is refused on the state it would leave.
    const issue2 = (await api('POST', '/api/projects/demo/items', { title: 'Old shape 2', options: ['A', 'B'], recommended: ['A'] })).json.items[0];
    const refused = await api('PATCH', `/api/items/${issue2.id}`, { kind: 'questions', questions: QS, actor: 'a', ifVersion: issue2.version });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toContain('carries its options on each question');
  });

  test('leaving the kind with answers on it is locked too', async () => {
    const item = await makeSet();
    await answer(item.id, 's1', { choice: 'Bay A' });
    const current = (await api('GET', `/api/items/${item.id}`)).json.item;
    const res = await api('PATCH', `/api/items/${item.id}`, { kind: 'issue', actor: 'a', ifVersion: current.version });
    expect(res.status).toBe(409);
  });
});

describe('reading', () => {
  test('list rows carry the counts and never the array; the item carries the array', async () => {
    const item = await makeSet();
    await answer(item.id, 's1', { choice: 'Bay A' });
    const board = (await api('GET', '/api/projects/demo')).json.items[0];
    expect(board.questionCount).toBe(3);
    expect(board.answered).toBe(1);
    expect(board.questions).toBeUndefined();
    const listed = (await api('GET', '/api/projects/demo/items')).json.items[0];
    expect(listed.questions).toBeUndefined();
    expect((await api('GET', `/api/items/${item.id}`)).json.item.questions).toHaveLength(3);
  });

  test('isAnswered is a choice or a non-blank note', () => {
    expect(isAnswered({ choice: '', answer: '' })).toBe(false);
    expect(isAnswered({ choice: '', answer: '  ' })).toBe(false);
    expect(isAnswered({ choice: 'A', answer: '' })).toBe(true);
    expect(isAnswered({ choice: '', answer: 'x' })).toBe(true);
  });

  test('a malformed questions blob reads as none and an old database opens', () => {
    const file = tmpDb('old');
    const raw = new Database(file, { create: true });
    raw.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT);
      CREATE TABLE items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, context TEXT NOT NULL, options TEXT NOT NULL, choice TEXT NOT NULL, status TEXT NOT NULL, section TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO projects VALUES ('p', 'old', 'Old', '', '2020-01-01T00:00:00.000Z', NULL);
      INSERT INTO items VALUES ('i', 'p', 'Before question sets', '', '["A"]', '', 'needs-decision', '', 0, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');`);
    raw.close();
    const old = new Store(openDb(file));
    const rows = old.listItems(old.getProject('old')!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].questions).toEqual([]);
    const set = old.createItem(old.getProject('old')!.id, { title: 'Set', kind: 'questions', questions: [{ ask: 'one?' }] });
    const db = new Database(file);
    db.query('UPDATE items SET questions = ? WHERE id = ?').run('{not json', set.id);
    db.close();
    expect(old.getItem(set.id)!.questions).toEqual([]);
    expect(old.getItem(set.id)!.questionCount).toBe(0);
  });
});

describe('export and import', () => {
  test('a round trip keeps the questions and their answers; a file without the field restores none', async () => {
    const item = await makeSet();
    await answer(item.id, 's1', { choice: 'Bay B', answer: 'because' });
    await api('POST', '/api/projects/demo/items', { title: 'Plain issue', options: ['A'], recommended: ['A'] });
    const dir = mkdtempSync(join(tmpdir(), 'workbench-questions-export-'));
    paths.push(dir);
    exportAll(store, dir);
    const target = new Store(openDb(tmpDb('target')));
    importAll(target, dir, () => {});
    const restored = target.listItems(target.getProject('demo')!.id).find((i) => i.kind === 'questions')!;
    expect(restored.questionCount).toBe(3);
    expect(restored.answered).toBe(1);
    expect(restored.questions[0]).toMatchObject({ id: 's1', choice: 'Bay B', answer: 'because', by: 'you', relayed: false });
    expect(restored.status).toBe('needs-decision');
    const plain = target.listItems(target.getProject('demo')!.id).find((i) => i.title === 'Plain issue')!;
    expect(plain.questions).toEqual([]);
  });
});

describe('review fixes', () => {
  async function bare(method: string, path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await handler(new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
    return { status: res.status, json: await res.json() };
  }

  test('a non-browser answer with no actor is refused, not recorded as the person', async () => {
    const item = await makeSet();
    const res = await bare('PATCH', `/api/items/${item.id}/questions/s1`, { choice: 'Bay A' });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('relay:true');
    const relayNoActor = await bare('PATCH', `/api/items/${item.id}/questions/s1`, { choice: 'Bay A', relay: true });
    expect(relayNoActor.status).toBe(400);
    expect((await api('GET', `/api/items/${item.id}`)).json.item.answered).toBe(0);
    // The page's own path still works: explicit actor, and the browser default.
    expect((await bare('PATCH', `/api/items/${item.id}/questions/s1`, { choice: 'Bay A', actor: 'you' })).status).toBe(200);
    const browser = await bare('PATCH', `/api/items/${item.id}/questions/s2`, { choice: 'Paper' }, { 'sec-fetch-mode': 'cors' });
    expect(browser.status).toBe(200);
    expect(browser.json.item.questions[1].by).toBe('you');
  });
});

describe('answers cannot ride in on a definition', () => {
  const smuggled = { id: 'a', ask: 'Pick?', options: ['X', 'Y'], recommended: ['X'], choice: 'X', answer: 'forged', by: 'you', at: '2026-01-01T00:00:00.000Z', relayed: false };

  test('create and patch drop choice, answer, by, at and relayed from a question', async () => {
    const created = await api('POST', '/api/projects/demo/items', { title: 'S', kind: 'questions', questions: [smuggled] });
    const item = created.json.items[0];
    expect(item.questions[0]).toMatchObject({ choice: '', answer: '', by: '', at: '', relayed: false });
    expect(item.answered).toBe(0);
    const patched = await api('PATCH', `/api/items/${item.id}`, { actor: 'a', ifVersion: item.version, questions: [smuggled, { ...smuggled, id: 'b' }] });
    expect(patched.json.item.answered).toBe(0);
  });

  test('a store-level definition does not restore answers either; importAll does', () => {
    const project = store.getProject('demo')!;
    const viaStore = store.createItem(project.id, { title: 'S2', kind: 'questions', questions: [smuggled] });
    expect(viaStore.answered).toBe(0);
    const restored = store.createItem(project.id, { title: 'S3', kind: 'questions', questions: [smuggled], restoreAnswers: true });
    expect(restored.questions[0]).toMatchObject({ choice: 'X', answer: 'forged', by: 'you' });
  });
});

describe('a question set at needs-qa behaves as work', () => {
  test('recording the last step signs it off, counts as QA, and is audited like an issue', async () => {
    const item = await makeSet({ status: 'needs-qa', checks: [{ id: 'c1', label: '1. Look', owner: 'human' }, { id: 'c2', label: '2. Look again' }] });
    const unowned = await api('GET', '/api/projects/demo/audit');
    expect(unowned.json.items.find((i: any) => i.id === item.id).findings.map((f: any) => f.rule)).toContain('qa-unowned-steps');
    expect((await api('GET', '/api/projects/demo')).json.qaCounts.human).toBe(1);
    await api('PATCH', `/api/items/${item.id}/checks/c1`, { result: 'pass', actor: 'qa' });
    const last = await api('PATCH', `/api/items/${item.id}/checks/c2`, { result: 'pass', actor: 'qa' });
    expect(last.json.item.status).toBe('received');
    expect(last.json.item.messages[0].text).toContain('All 2 steps passed');
    const bare = await makeSet({ status: 'needs-qa' });
    const audit = (await api('GET', '/api/projects/demo/audit')).json.items.find((i: any) => i.id === bare.id);
    expect(audit.findings.map((f: any) => f.rule)).toContain('qa-without-steps');
  });
});
