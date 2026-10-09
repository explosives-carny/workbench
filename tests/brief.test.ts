// The second-opinion brief (contract v21): one item written out so somebody
// with no access to the board can answer it. These pin what a reader with zero
// context needs to find in it, what it must never carry, and that the route
// and the item page's button share the one generator.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, Store } from '../src/db.ts';
import { createHandler, CONTRACT_VERSION } from '../src/app.ts';
import { itemBrief, redactSecrets, shortenHomePaths, BRIEF_LIMITS } from '../src/brief.ts';
import { renderPage, type El } from './helpers/page.ts';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFileSync, rmSync } from 'fs';

const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;
const NOW = new Date('2026-10-08T12:00:00Z');

let dbPath: string;
let store: Store;
let writes: number;
let handler: (req: Request) => Promise<Response>;

beforeEach(() => {
  dbPath = join(tmpdir(), `workbench-brief-${Math.random().toString(36).slice(2)}.db`);
  store = new Store(openDb(dbPath));
  writes = 0;
  handler = createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD, onWrite: () => { writes++; } });
});

afterEach(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + suffix); } catch {}
  }
});

function board(key: string | undefined = 'demo', mode: 'board' | 'todo' = 'board') {
  return store.createProject({ name: 'Picker rollout', key, mode, description: 'Replacing the old picker', repos: ['~/code/picker', 'acme/picker'] });
}

function briefOf(id: string): string {
  const item = store.getItem(id)!;
  return itemBrief(item, store.getProjectById(item.projectId)!, NOW);
}

describe('the brief, for a reader with no context', () => {
  test('a decision carries project, ref, why, the question, options, thread, status and the ask', () => {
    const p = board();
    const item = store.createItem(p.id, {
      title: 'Ship the new picker this week?',
      context: 'The new picker is built and passes its tests.\n\n- **Risk:** the warehouse has not tried it.',
      options: ['Ship now', 'Wait a week'],
      recommended: ['Wait a week'],
      labels: ['Release 3'],
      section: 'Picking',
    });
    store.addMessage(item.id, { who: 'agent', author: 'builder', text: 'Built and tested.' });
    store.addMessage(item.id, { who: 'you', text: 'Why wait, though?' });
    store.updateItem(item.id, { choice: 'Ship now' }, {});
    const text = briefOf(item.id);

    expect(text.startsWith('# Second opinion: Ship the new picker this week?')).toBe(true);
    expect(text).toContain('- **Project:** Picker rollout: Replacing the old picker');
    expect(text).toContain('- **Item:** WB-DEMO-1, an issue');
    expect(text).toContain('- **Area:** Picking');
    expect(text).toContain('- **Labels:** Release 3');
    expect(text).toContain('## Why it exists\n\nThe new picker is built and passes its tests.');
    expect(text).toContain('## The question\n\n> Ship the new picker this week?');
    expect(text).toContain('1. Ship now (**chosen so far**)');
    expect(text).toContain('2. Wait a week (**recommended by the agent**)');
    expect(text).toContain('When two messages disagree, the newest one wins.');
    // Who said what, in order, newest last.
    const agentAt = text.indexOf('**1. Agent "builder"');
    const personAt = text.indexOf('**2. The person');
    expect(agentAt).toBeGreaterThan(0);
    expect(personAt).toBeGreaterThan(agentAt);
    expect(text).toContain('> Why wait, though?');
    expect(text).toContain('- **Status:** Received: the person has answered');
    expect(text).toContain('A message from the person after that click overrides it.');
    expect(text).toContain('## What I need from you\n\nWhat would you choose and why? What am I missing?');
    expect(text).toContain('_Brief made 2026-10-08 12:00 UTC from WB-DEMO-1._');
  });

  test('empty context and no options say so instead of leaving a gap', () => {
    const p = board();
    const item = store.createItem(p.id, { title: 'What should the pilot measure?' });
    const text = briefOf(item.id);
    expect(text).toContain('No background was written for this item.');
    expect(text).toContain('No fixed options were offered, so the answer is open.');
    expect(text).not.toContain('## The options');
    expect(text).toContain('Nobody has replied yet.');
  });

  test('every option recommended reads as no preference, not as every one marked', () => {
    const p = board();
    const item = store.createItem(p.id, { title: 'Which carrier?', options: ['A', 'B'], recommended: ['A', 'B'] });
    const text = briefOf(item.id);
    expect(text).toContain('The agent marked every option as recommended: it has no preference.');
    expect(text).not.toContain('recommended by the agent**');
  });

  test('a long thread keeps the opening and the newest, in order, and cuts a long message', () => {
    const p = board();
    const item = store.createItem(p.id, { title: 'Long one?' });
    for (let n = 1; n <= 20; n++) {
      store.addMessage(item.id, { who: n % 2 ? 'agent' : 'you', author: 'builder', text: `message number ${n}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString() });
    }
    store.addMessage(item.id, { who: 'you', text: 'x'.repeat(BRIEF_LIMITS.message + 50) });
    const text = briefOf(item.id);
    expect(text).toContain('21 messages, oldest first.');
    expect(text).toContain('message number 1\n');
    expect(text).toContain('message number 2\n');
    expect(text).not.toContain('message number 3\n');
    expect(text).not.toContain('message number 11\n');
    expect(text).toContain('_(9 messages in the middle left out)_');
    for (let n = 12; n <= 20; n++) expect(text).toContain(`message number ${n}\n`);
    expect(text.indexOf('message number 12')).toBeLessThan(text.indexOf('message number 20'));
    expect(text).toContain('**21. The person');
    expect(text).toContain('_(cut here: 50 more characters on the board)_');
  });

  test('a document asks for a review and carries its Markdown body', () => {
    const p = board();
    const doc = store.createItem(p.id, { title: 'Picker runbook', kind: 'document', body: '# Runbook\n\n1. Scan the tote.', bodyFormat: 'markdown' });
    const text = briefOf(doc.id);
    expect(text).toContain(', a document,');
    expect(text).toContain('This is a reference document, not a decision.');
    expect(text).toContain('## The document\n\n# Runbook\n\n1. Scan the tote.');
    expect(text).toContain('- **Status:** Active');
  });

  test('an HTML body is named, not pasted', () => {
    const p = board();
    const doc = store.createItem(p.id, { title: 'Imported spec', kind: 'document', body: '<!doctype html><html><body><script>x()</script></body></html>', bodyFormat: 'html' });
    const text = briefOf(doc.id);
    expect(text).toContain('An HTML page (1 KB) is attached on the board. It is not copied here');
    expect(text).not.toContain('<script>');
  });

  test('an issue with a body calls it attached material, not the document', () => {
    const p = board();
    const item = store.createItem(p.id, { title: 'Which layout?', body: 'Layout notes', bodyFormat: 'text' });
    expect(briefOf(item.id)).toContain('## Attached material\n\nLayout notes');
  });

  test('a to-do on a to-do project carries its due day and priority in words', () => {
    const p = board('todo', 'todo');
    const todo = store.createItem(p.id, { title: 'Book the forklift service', dueAt: '2026-10-31', priority: 'p1' });
    const text = briefOf(todo.id);
    expect(text).toContain(', a to-do,');
    expect(text).toContain("This is a task on the person's own to-do list.");
    expect(text).toContain('- **Status:** To do');
    expect(text).toContain('- **Due:** 2026-10-31');
    expect(text).toContain('- **Priority:** High');
  });

  test('blocked work names what it waits on; QA lists its steps and results', () => {
    const p = board();
    const blocked = store.createItem(p.id, { title: 'Turn on scanning', status: 'blocked', blockedBy: 'WB-DEMO-9 merged' });
    expect(briefOf(blocked.id)).toContain('- **Blocked by:** WB-DEMO-9 merged');
    const qa = store.createItem(p.id, {
      title: 'Check the label print',
      status: 'needs-qa',
      checks: [
        { id: 'c1', label: 'Print one label', result: 'pass', note: '', owner: 'human', by: '', at: '' },
        { id: 'c2', label: 'Run the parser', result: '', note: '', owner: 'agent', by: '', at: '' },
      ],
    });
    const text = briefOf(qa.id);
    expect(text).toContain('Built work is waiting for a check.');
    expect(text).toContain('1 of 2 steps have a result.');
    expect(text).toContain('- [PASS] (person) Print one label');
    expect(text).toContain('- [OPEN] (agent) Run the parser');
  });

  test('a project with no key is named by the first eight of the id, never the whole UUID', () => {
    const p = store.createProject({ name: 'No key yet' });
    const item = store.createItem(p.id, { title: 'Keyless?' });
    const text = briefOf(item.id);
    expect(text).toContain(`- **Item:** ${item.id.slice(0, 8)},`);
    expect(text).not.toContain(item.id);
  });

  test('nothing about the installation rides along: no repos, no board URL', () => {
    const p = board();
    const item = store.createItem(p.id, { title: 'Anything?' });
    const text = briefOf(item.id);
    expect(text).not.toContain('~/code/picker');
    expect(text).not.toContain('acme/picker');
    expect(text).not.toContain('localhost');
  });
});

describe('secrets and home paths', () => {
  test('credential shapes are replaced and counted', () => {
    const samples = [
      'sk-ant-api03-abcdefghijklmnopqrstuv',
      'ghp_abcdefghijklmnopqrstuvwxyz012345',
      'github_pat_11ABCDEFG0123456789_abcdefghij',
      'xoxb-1234567890-abcdefghij',
      'AKIAABCDEFGHIJKLMNOP',
      'AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop',
      'Bearer abcdefghijklmnopqrstuvwx',
      'api_key=abcdef123456',
      '"password": "hunter22"',
      'https://deploy:s3cretpass@example.com/x',
      'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3Aa4Bb',
    ];
    const { text, count } = redactSecrets(samples.join('\n'));
    expect(count).toBe(samples.length);
    for (const leaked of ['abcdefghijklmnopqrstuv', 'ghp_', 'AKIAABCD', 'hunter22', 's3cretpass', 'abcdef123456', 'Ab1Cd2Ef3']) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain('api_key=[redacted]');
    expect(text).toContain('https://deploy:[redacted]@example.com/x');
    expect(text).toContain('Bearer [redacted]');
  });

  test('ordinary identifiers survive: a UUID, a git hash, a ref, a date', () => {
    const plain = 'WB-DEMO-14 at 3f2a9c1e0b7d4e6f8a1b2c3d4e5f6a7b8c9d0e1f on 2026-10-08, id 0b6c7a0e-5d1f-4c9e-9a3b-2f1e0d9c8b7a';
    expect(redactSecrets(plain)).toEqual({ text: plain, count: 0 });
  });

  test('a home-directory prefix becomes ~', () => {
    expect(shortenHomePaths('see /Users/someone/code/x and (/home/dev/app) and C:\\Users\\pat\\file')).toBe('see ~/code/x and (~/app) and ~\\file');
    expect(shortenHomePaths('a/Users/x/y stays')).toBe('a/Users/x/y stays');
  });

  test('the brief applies both and says how many values it replaced', () => {
    const p = board();
    const item = store.createItem(p.id, { title: 'Rotate the key?', context: 'The token=abcdefghij123 is in /Users/someone/.env' });
    store.addMessage(item.id, { who: 'agent', author: 'builder', text: 'Used Bearer abcdefghijklmnopqrstuvwx to test' });
    const text = briefOf(item.id);
    expect(text).toContain('token=[redacted]');
    expect(text).toContain('~/.env');
    expect(text).not.toContain('someone');
    expect(text).toContain('_2 values that looked like a secret were replaced with [redacted]._');
  });

  test('a secret longer than the cut, or straddling it, is redacted before the cut', () => {
    const p = board();
    const key = '-----BEGIN RSA PRIVATE KEY-----\n' + 'MIIEow'.repeat(300) + '\n-----END RSA PRIVATE KEY-----';
    const token = 'ghp_' + 'Ab1'.repeat(12);
    const item = store.createItem(p.id, { title: 'Key in the thread?', context: 'x'.repeat(BRIEF_LIMITS.section - 10) + ' ' + token });
    store.addMessage(item.id, { who: 'agent', author: 'builder', text: key });
    const text = briefOf(item.id);
    expect(text).not.toContain('MIIEow');
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain('Ab1Ab1');
    expect(text).toContain('_2 values that looked like a secret were replaced with [redacted]._');
    // A key block pasted without its END marker is redacted to the end.
    expect(redactSecrets('-----BEGIN PRIVATE KEY-----\nMIIEvgIBADAN').text).toBe('[redacted]');
  });

  test('redaction runs in linear time on long runs any writer can store', () => {
    for (const input of ['a-'.repeat(50_000), 'token'.repeat(20_000), 'Users/'.repeat(20_000), 'Basic '.repeat(20_000)]) {
      const started = performance.now();
      redactSecrets(shortenHomePaths(input));
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  test('prose is not mistaken for a credential, and a quoted password is taken whole', () => {
    expect(redactSecrets('Basic responsibilities of the night shift').count).toBe(0);
    expect(redactSecrets('Authorization: Basic ZGVwbG95OnMzY3JldHBhc3M=').text).toBe('Authorization: Basic [redacted]');
    expect(redactSecrets('password: "hunter two words"').text).toBe('password: "[redacted]"');
  });

  test('a home path inside Markdown or a file URL loses the account name too', () => {
    expect(shortenHomePaths('[/Users/someone/x] **/Users/someone/y** file:///Users/someone/z | /home/someone/q, ok'))
      .toBe('[~/x] **~/y** file://~/z | ~/q, ok');
    expect(shortenHomePaths('https://example.com/Users/someone/x')).toBe('https://example.com/Users/someone/x');
  });

  test('a cut never splits an emoji in half', () => {
    const p = board();
    const item = store.createItem(p.id, { title: 'Emoji at the edge?', context: 'x'.repeat(BRIEF_LIMITS.section - 1) + '🎆 tail' });
    expect(briefOf(item.id)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('GET /api/items/<id-or-ref>/brief', () => {
  async function get(path: string, method = 'GET') {
    return handler(new Request(`http://localhost${path}`, { method }));
  }

  test('serves the generator output as Markdown, by ref or id, and writes nothing', async () => {
    const p = board();
    const item = store.createItem(p.id, { title: 'Ship it?', options: ['Yes', 'No'], recommended: ['Yes'] });
    const before = store.getItem(item.id)!;
    for (const key of ['wb-demo-1', item.id]) {
      const res = await get(`/api/items/${key}/brief`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const text = await res.text();
      const expected = itemBrief(store.getItem(item.id)!, p);
      expect(text.split('\n---\n')[0]).toBe(expected.split('\n---\n')[0]);
    }
    const after = store.getItem(item.id)!;
    expect([after.version, after.status, after.updatedAt]).toEqual([before.version, before.status, before.updatedAt]);
    expect(writes).toBe(0);
  });

  test('an unknown item is a JSON 404 and a write to the brief is refused', async () => {
    const missing = await get('/api/items/WB-NOPE-3/brief');
    expect(missing.status).toBe(404);
    expect((await missing.json()).ok).toBe(false);
    const p = board();
    store.createItem(p.id, { title: 'Ship it?' });
    const posted = await get('/api/items/WB-DEMO-1/brief', 'POST');
    expect(posted.status).toBe(400);
    expect((await posted.json()).error).toContain('read-only');
  });

  test('the route is listed by GET /api and documented in the contract at the version it speaks', async () => {
    const api = await (await get('/api')).json();
    expect(api.contractVersion).toBe(CONTRACT_VERSION);
    expect(Number(CONTRACT_VERSION)).toBeGreaterThanOrEqual(21);
    expect(api.routes.some((r: string) => r.includes('/api/items/<id-or-ref>/brief'))).toBe(true);
    const md = readFileSync(AGENTS_MD, 'utf8');
    expect(md).toContain('GET  /api/items/<id-or-ref>/brief');
    expect(md).toContain('wb brief <id|ref>');
  });
});

describe('the item page button', () => {
  function panelButton(byId: (id: string) => El): El | undefined {
    return byId('panel').byClass('second-opinion')[0];
  }
  async function settle() {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  }

  test('copies the served brief and shows it below the button', async () => {
    const p = board();
    const item = store.createItem(p.id, { title: 'Ship it?', options: ['Yes', 'No'], recommended: ['Yes'] });
    const copied: string[] = [];
    const page = await renderPage(handler, 'item.html', `/p/${p.slug}/i/${item.id}`, {
      navigator: { clipboard: { writeText: async (t: string) => { copied.push(t); } } },
    });
    const button = panelButton(page.byId);
    expect(button?.textContent).toBe('Get a 2nd opinion');
    expect(page.byId('panel').byClass('briefbox').length).toBe(0);
    button!.dispatchEvent({ type: 'click' });
    await settle();
    expect(copied.length).toBe(1);
    expect(copied[0].startsWith('# Second opinion: Ship it?')).toBe(true);
    const box = page.byId('panel').byClass('briefbox')[0];
    expect(box.byClass('brief-text')[0].value).toBe(copied[0]);
    expect(box.byClass('brief-note')[0].textContent).toContain('Copied to the clipboard');
    expect(store.getItem(item.id)!.status).toBe('needs-decision');
  });

  test('a refused clipboard leaves the brief in a visible box to copy by hand', async () => {
    const p = board();
    const item = store.createItem(p.id, { title: 'Ship it?' });
    const page = await renderPage(handler, 'item.html', `/p/${p.slug}/i/${item.id}`, {
      navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
    });
    panelButton(page.byId)!.dispatchEvent({ type: 'click' });
    await settle();
    const box = page.byId('panel').byClass('briefbox')[0];
    expect(box).toBeDefined();
    expect(box.byClass('brief-text')[0].value.startsWith('# Second opinion: Ship it?')).toBe(true);
    const note = box.byClass('brief-note')[0];
    expect(note.textContent).toContain('Could not copy automatically');
    expect(note.classList.contains('err')).toBe(true);
  });

  test('the panel carries a Copy button that writes the brief on a click of its own', async () => {
    const p = board();
    const item = store.createItem(p.id, { title: 'Ship it?' });
    // The automatic copy is refused (as a browser may do that far from the
    // gesture); the button's own click is allowed.
    let calls = 0;
    const copied: string[] = [];
    const page = await renderPage(handler, 'item.html', `/p/${p.slug}/i/${item.id}`, {
      navigator: { clipboard: { writeText: async (t: string) => { if (calls++ === 0) throw new Error('denied'); copied.push(t); } } },
    });
    panelButton(page.byId)!.dispatchEvent({ type: 'click' });
    await settle();
    let box = page.byId('panel').byClass('briefbox')[0];
    const copy = box.byClass('brief-copy')[0];
    expect(copy?.textContent).toBe('Copy');
    copy!.dispatchEvent({ type: 'click' });
    await settle();
    expect(copied.length).toBe(1);
    expect(copied[0].startsWith('# Second opinion: Ship it?')).toBe(true);
    box = page.byId('panel').byClass('briefbox')[0];
    expect(box.byClass('brief-note')[0].textContent).toContain('Copied to the clipboard');
    expect(box.byClass('brief-note')[0].classList.contains('err')).toBe(false);
    expect(box.byClass('brief-copy').length).toBe(1);
    expect(box.byClass('brief-text')[0].value).toBe(copied[0]);
  });

  test('a Copy click the browser refuses keeps the panel and says to copy by hand', async () => {
    const p = board();
    const item = store.createItem(p.id, { title: 'Ship it?' });
    const page = await renderPage(handler, 'item.html', `/p/${p.slug}/i/${item.id}`, {
      navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
    });
    panelButton(page.byId)!.dispatchEvent({ type: 'click' });
    await settle();
    page.byId('panel').byClass('brief-copy')[0].dispatchEvent({ type: 'click' });
    await settle();
    const box = page.byId('panel').byClass('briefbox')[0];
    expect(box).toBeDefined();
    expect(box.byClass('brief-text')[0].value.startsWith('# Second opinion: Ship it?')).toBe(true);
    expect(page.byId('saved-main').textContent).toContain('copy it by hand');
  });
});
