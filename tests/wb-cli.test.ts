// The CLI must use the same reference routes a shell does, not a mocked fetch.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'fs';
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
    fetch: createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD, imagesDir: dbPath + '-images' }),
  });
});

afterAll(() => {
  server.stop(true);
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + suffix); } catch {}
  }
  rmSync(dbPath + '-images', { recursive: true, force: true });
  rmSync(dbPath + '-shot.png', { force: true });
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

  test('refuses a known flag given no value instead of dropping it', async () => {
    const result = await wb('project', 'demo', '--name', '--key', 'NEWKEY');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--name needs a value');
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

  test('refuses a known flag given no value', async () => {
    const result = await wb('settings', '--default-project');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('needs a value');
  });
});

describe('wb due / wb priority', () => {
  // Dates and priority live on to-dos, in a project created with mode todo.
  beforeAll(() => {
    const list = store.createProject({ name: 'Errands', key: 'ERR', mode: 'todo' });
    store.createItem(list.id, { title: 'Renew the permit' });
  });

  test('set, show and clear a due date and a priority without moving the status', async () => {
    const due = await wb('due', 'WB-ERR-1', '2026-10-31');
    expect(due.code).toBe(0);
    expect(due.stdout).toContain('due: 2026-10-31');
    const prio = await wb('priority', 'wb-err-1', 'P1');
    expect(prio.code).toBe(0);
    expect(prio.stdout).toContain('priority: High');
    const item = store.resolveItem('WB-ERR-1')!;
    expect([item.dueAt, item.priority, item.status]).toEqual(['2026-10-31', 'p1', 'todo']);

    const shown = await wb('show', 'WB-ERR-1');
    expect(shown.stdout).toContain('due:     2026-10-31');
    expect(shown.stdout).toContain('priority: High');
    const board = await wb('board', 'errands', '--all');
    expect(board.stdout).toContain('High  due 2026-10-31');

    expect((await wb('due', 'WB-ERR-1', 'none')).code).toBe(0);
    expect((await wb('priority', 'WB-ERR-1', 'none')).code).toBe(0);
    const cleared = store.resolveItem('WB-ERR-1')!;
    expect([cleared.dueAt, cleared.priority]).toEqual([null, null]);
  });

  test('priority takes the words a person reads: high, medium, low', async () => {
    for (const [word, stored, shown] of [['medium', 'p2', 'Medium'], ['LOW', 'p3', 'Low'], ['High', 'p1', 'High']]) {
      const res = await wb('priority', 'WB-ERR-1', word);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(`priority: ${shown}`);
      expect(store.resolveItem('WB-ERR-1')!.priority).toBe(stored);
    }
    expect((await wb('priority', 'WB-ERR-1', 'none')).code).toBe(0);
  });

  test('a malformed date is refused with what to send, and nothing changes', async () => {
    const result = await wb('due', 'WB-ERR-1', '31/10/2026');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('YYYY-MM-DD');
    expect(store.resolveItem('WB-ERR-1')!.dueAt).toBeNull();
  });

  test('on a board item it is refused, naming to-do projects', async () => {
    const result = await wb('due', 'WB-DEMO-2', '2026-10-31');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('to-do projects');
  });

  test('wb project --mode sets the mode and prints it', async () => {
    store.createProject({ name: 'Spare' });
    const set = await wb('project', 'spare', '--mode', 'todo');
    expect(set.code).toBe(0);
    const shown = await wb('project', 'spare');
    expect(shown.stdout).toContain('mode: todo');
  });
});

describe('wb todo / wb todos (v19)', () => {
  // A local calendar day `n` days from today, as the person would say it.
  const day = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  beforeAll(() => {
    store.createProject({ name: 'Chores', key: 'CHO', mode: 'todo' });
  });

  test('wb todo adds a to-do with the date and priority given', async () => {
    const res = await wb('todo', 'chores', 'Return', 'the', 'library', 'books', '--due', day(3), '--priority', 'high');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('WB-CHO-1  todo  High  due ' + day(3) + '  Return the library books');
    const item = store.resolveItem('WB-CHO-1')!;
    expect([item.kind, item.status, item.dueAt, item.priority]).toEqual(['todo', 'todo', day(3), 'p1']);
  });

  test('wb todo on a board is refused and files nothing', async () => {
    const before = store.counts(store.getProject('demo')!.id);
    const res = await wb('todo', 'demo', 'Not a decision');
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('to-do projects');
    expect(store.counts(store.getProject('demo')!.id)).toEqual(before);
  });

  test('wb todos lists open to-dos due first, then priority, with the day against today', async () => {
    expect((await wb('todo', 'chores', 'Pay the water bill', '--due', day(-2), '--priority', 'low')).code).toBe(0);
    expect((await wb('todo', 'chores', 'Book a dentist', '--priority', 'medium')).code).toBe(0);
    expect((await wb('todo', 'chores', 'Water plants', '--due', day(0))).code).toBe(0);
    const parked = (await wb('todo', 'chores', 'Clean the garage')).stdout.split(/\s+/)[0];
    expect((await wb('status', parked, 'deferred')).code).toBe(0);

    const res = await wb('todos', 'chores');
    expect(res.code).toBe(0);
    const lines = res.stdout.trim().split('\n');
    expect(lines.map((l) => l.split(/\s{2,}/).pop())).toEqual(['Pay the water bill', 'Water plants', 'Return the library books', 'Book a dentist']);
    expect(lines[0]).toContain('overdue 2d');
    expect(lines[1]).toContain('due today');
    expect(lines[2]).toContain('due in 3d');
    expect(lines[3]).toContain('no date');
    expect(res.stdout).not.toContain('Clean the garage');

    const withParked = await wb('todos', 'chores', '--all');
    expect(withParked.stdout).toContain('(deferred) Clean the garage');
  });

  test('wb todos with no slug covers every to-do project and tags each row', async () => {
    const res = await wb('todos');
    expect(res.stdout).toContain('[chores]');
    expect(res.stdout).toContain('[errands]');
  });

  test('wb todos on a board says it is not a to-do project', async () => {
    const res = await wb('todos', 'demo');
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('not a to-do project');
  });

  test('wb projects shows a to-do list by what it holds, not decision counts', async () => {
    const res = await wb('projects');
    const line = res.stdout.split('\n').find((l) => l.startsWith('chores'))!;
    expect(line).toContain('to-do list  open 4');
    expect(line).not.toContain('decision');
  });
});

describe('wb brief (v21)', () => {
  test('prints the same Markdown the route serves', async () => {
    const res = await wb('brief', 'wb-demo-1');
    expect(res.code).toBe(0);
    expect(res.stdout.startsWith('# Second opinion: First')).toBe(true);
    const served = await (await fetch(`http://127.0.0.1:${server.port}/api/items/WB-DEMO-1/brief`)).text();
    // Only the footer's timestamp may differ between the two reads.
    const body = (t: string) => t.split('\n---\n')[0];
    expect(body(res.stdout)).toBe(body(served));
  });

  test('an unknown ref fails with the server error', async () => {
    const res = await wb('brief', 'WB-NOPE-9');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('404');
  });
});

describe('wb attach and wb image (v22)', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  test('wb image uploads and prints the Markdown to paste', async () => {
    writeFileSync(dbPath + '-shot.png', PNG);
    const res = await wb('image', dbPath + '-shot.png', '--alt', 'the error banner');
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toMatch(/^!\[the error banner\]\(\/api\/images\/[0-9a-f]{64}\.png\)$/);
  });

  test('wb attach posts the images as one signed reply, caption first', async () => {
    writeFileSync(dbPath + '-shot.png', PNG);
    const res = await wb('attach', 'WB-DEMO-2', dbPath + '-shot.png', '--text', 'What I saw:');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('1 image(s) posted');
    const messages = store.listMessages(store.resolveItem('WB-DEMO-2')!.id);
    const last = messages[messages.length - 1];
    expect(last.author).toBe('tester');
    expect(last.text).toMatch(/^What I saw:\n\n!\[image\]\(\/api\/images\/[0-9a-f]{64}\.png\)$/);
  });

  test('a file that is not an image is refused with the server reason', async () => {
    writeFileSync(dbPath + '-shot.png', 'not an image');
    const res = await wb('attach', 'WB-DEMO-2', dbPath + '-shot.png');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('PNG, JPEG, GIF, WebP, SVG or HEIC');
  });
});

describe('wb questions, answer and show on a question set (v23)', () => {
  let setId: string;
  const QS = [
    { id: 's1', label: 'Packing location', ask: 'Where?', options: ['Bay A', 'Bay B'], recommended: ['Bay A'] },
    { id: 's2', label: 'Notes', ask: 'Anything else?' },
  ];

  test('wb ask files a set; show prints each question as open with its options and recommendation', async () => {
    const filed = await wb('ask', 'demo', JSON.stringify([{ title: 'Packing set', kind: 'questions', questions: QS }]), '--json');
    expect(filed.code).toBe(0);
    setId = JSON.parse(filed.stdout)[0].id;
    const shown = await wb('show', setId);
    expect(shown.stdout).toContain('questions (0/2 answered):');
    expect(shown.stdout).toContain('s1  Packing location  [Bay A | Bay B]  rec: Bay A  open');
    expect(shown.stdout).toContain('s2  Notes  [free text]');
  });

  test('answer without --relay is refused locally with the reason and writes nothing', async () => {
    const res = await wb('answer', setId, 's1', '--choice', 'Bay A');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("answers are the person's");
    expect(res.stderr).toContain('relay:true');
    const item = store.getItem(setId)!;
    expect(item.answered).toBe(0);
  });

  test('answer --relay records it as a relay and show prints who, when and relayed', async () => {
    const res = await wb('answer', setId, 's1', '--choice', 'Bay B', '--note', 'dock is closer', '--relay');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('s1 recorded (relayed)');
    const q = store.getItem(setId)!.questions[0];
    expect(q).toMatchObject({ choice: 'Bay B', answer: 'dock is closer', by: 'tester', relayed: true });
    const shown = await wb('show', setId);
    expect(shown.stdout).toMatch(/s1  Packing location  \[Bay A \| Bay B\]  rec: Bay A  ✓ Bay B — dock is closer · tester · \d{4}-\d\d-\d\dT.* · relayed/);
  });

  test('questions lists open ones first; board shows N/M answered', async () => {
    const res = await wb('questions', setId);
    expect(res.code).toBe(0);
    const lines = res.stdout.split('\n');
    expect(lines[0]).toContain('1/2 answered');
    expect(lines[1]).toContain('s2');
    expect(lines[1]).toContain('open');
    expect(lines[2]).toContain('s1');
    const board = await wb('board', 'demo', '--all');
    expect(board.stdout).toContain('1/2 answered');
  });

  test('questions on an issue says so; an unknown question is the server 404', async () => {
    const issue = await wb('questions', 'WB-DEMO-1');
    expect(issue.code).toBe(1);
    expect(issue.stderr).toContain('not a question set');
    const missing = await wb('answer', setId, 'zz', '--note', 'x', '--relay');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('404');
  });

  test('help lists the two commands and an audit prints the new findings', async () => {
    const help = await wb('--help');
    expect(help.stdout).toContain('wb questions <id|ref>');
    expect(help.stdout).toContain('wb answer <id|ref> <qid>');
    store.createItem(store.getProject('demo')!.id, { title: 'Bare set', kind: 'questions' });
    const audit = await wb('audit', 'demo');
    expect(audit.stdout).toContain('question-set-without-questions');
  });
});
