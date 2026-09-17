// `wb` — the board from a shell, for agents and people.
//
// Every command here is one the contract asks an agent to make by hand-writing
// an HTTP request with JSON inside it, and that is where the mistakes happen:
// the wrong `who`, a missing `actor`, a forgotten `ifVersion`, a finishing reply
// with no status. A session on the reference machine got tired of it and wrote
// its own helper script. This is that script, once, with the rules baked in:
// every edit reads the version first and retries once on 409; every write is
// signed; `board` returns the actionable set and nothing else.
//
// No dependencies, same as the rest of the tool. Output is plain text for a
// person and `--json` for a program.
import { homedir } from 'os';
import { basename } from 'path';

const BASE = process.env.WORKBENCH_URL || `http://localhost:${process.env.WORKBENCH_PORT || 4317}`;

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

// A refused connection is retried before it is reported. A deploy restarts the
// service and leaves the port silent for about two seconds; a QA agent that hit
// one of those gaps reported the board down and dropped a round of results. Three
// waits totalling ~7 s cover a restart; a board that is really down is still
// reported, with how to start it.
const RETRY_MS = [1000, 2000, 4000];

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  let res: Response | null = null;
  let lastError: any = null;
  for (let attempt = 0; attempt <= RETRY_MS.length; attempt++) {
    try {
      res = await fetch(BASE + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      break;
    } catch (error: any) {
      lastError = error;
      if (attempt < RETRY_MS.length) {
        console.error(`wb: board not answering at ${BASE}; retrying in ${RETRY_MS[attempt] / 1000}s (a deploy restart takes ~2s)`);
        await Bun.sleep(RETRY_MS[attempt]);
      }
    }
  }
  if (!res) {
    // Still nothing after ~7 s: the board is really down, not restarting.
    console.error(`wb: cannot reach the board at ${BASE} (${lastError?.cause?.code || lastError?.message || lastError}) after ${RETRY_MS.length + 1} attempts.`);
    console.error(`    If the service is installed: launchctl kickstart -k gui/$(id -u)/dev.workbench.server`);
    console.error(`    Otherwise: cd <workbench repo> && bun run start   (or bun run install-service, once, to keep it running)`);
    process.exit(2);
  }
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { ok: false, error: text }; }
  return { status: res.status, json };
}

/**
 * Who this command signs as. In order: --actor, WB_ACTOR, the human's
 * settings.agentNames entry for WB_TOOL (or for the tool this shell is running
 * under), then the tool name itself. One rule, so one agent never ends up
 * signing under two names.
 */
async function actor(flags: Flags): Promise<string> {
  if (typeof flags.actor === 'string' && flags.actor.trim()) return flags.actor.trim();
  if (process.env.WB_ACTOR) return process.env.WB_ACTOR;
  const tool = process.env.WB_TOOL || (process.env.CLAUDECODE ? 'claude-code' : process.env.CODEX_SANDBOX ? 'codex' : 'agent');
  const { json } = await call('GET', '/api/settings');
  const names = json?.settings?.agentNames;
  if (names && typeof names === 'object' && typeof names[tool] === 'string') return names[tool];
  return tool;
}

/**
 * Which session this is. WB_SESSION if the session set one; else the first
 * eight characters of the harness's own session id when it exposes one (Claude
 * Code sets CLAUDE_CODE_SESSION_ID); else nothing — the board stores '' and the
 * clock rule still applies. Sent on every write so a sibling session running
 * under the same name can be told apart, and so a crashed session's claims can
 * be recognised as its own.
 */
function session(): string | undefined {
  if (process.env.WB_SESSION) return process.env.WB_SESSION.slice(0, 40);
  if (process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID.slice(0, 8);
  return undefined;
}

function fail(message: string, code = 1): never {
  console.error(`wb: ${message}`);
  process.exit(code);
}

function out(flags: Flags, human: string, data: unknown): void {
  if (flags.json) console.log(JSON.stringify(data));
  else console.log(human);
}

async function readBodyArg(arg: string | undefined): Promise<any> {
  if (!arg) fail('expected JSON, a path to a JSON file, or - for stdin');
  if (arg === '-') return JSON.parse(await Bun.stdin.text());
  if (arg.trim().startsWith('{') || arg.trim().startsWith('[')) return JSON.parse(arg);
  return JSON.parse(await Bun.file(arg).text());
}

// The read-then-write every status change needs, done here so no caller
// forgets it. One retry on 409, onto the live item's version; a second refusal
// is reported, not overwritten.
async function patchItem(id: string, patch: Record<string, unknown>, who: string): Promise<any> {
  const current = await call('GET', `/api/items/${id}`);
  if (!current.json.ok) fail(current.json.error);
  let attempt = await call('PATCH', `/api/items/${id}`, { ...patch, actor: who, session: session(), ifVersion: current.json.item.version });
  if (attempt.status === 409) {
    attempt = await call('PATCH', `/api/items/${id}`, { ...patch, actor: who, session: session(), ifVersion: attempt.json.item.version });
    if (attempt.status === 409) fail(`item ${id} changed twice while writing; read it and decide: ${JSON.stringify(attempt.json.item.status)} by ${attempt.json.item.updatedBy}`);
  }
  if (!attempt.json.ok) fail(attempt.json.error);
  if (attempt.json.warning) console.error(`wb: warning: ${attempt.json.warning}`);
  if (attempt.json.ignored) console.error(`wb: ignored fields: ${attempt.json.ignored.join(', ')}`);
  return attempt.json.item;
}

function row(i: any): string {
  const last = i.messages?.length ? i.messages[i.messages.length - 1] : null;
  const tag = (who: string, s?: string) => (s ? `${who}·${s}` : who);
  const lastLine = last ? `${last.who === 'you' ? 'YOU' : tag(last.author, last.session)}: ${String(last.text).replace(/\s+/g, ' ').slice(0, 160)}` : '(no messages)';
  return [
    `${i.status.padEnd(14)} ${i.id}  v${i.version}  by ${tag(i.updatedBy || '-', i.updatedSession)}  ${i.updatedAt}`,
    `  ${i.title}`,
    i.choice ? `  choice: ${i.choice}` : null,
    `  last: ${lastLine}`,
  ].filter(Boolean).join('\n');
}

const HELP = `wb — the workbench board from a shell (${BASE})

  wb projects                              every project with counts
  wb resolve <repo-or-path>                the project for a repository (or exit 1)
  wb board <slug> [--all] [--status a,b]   the actionable set: received + in-progress (--all: everything)
  wb show <id>                             one item, full thread and body
  wb ask <slug> <json|file|->              create items; an array files a whole set; give each a clientId to make retries safe
  wb reply <id> <text> [--status s]        post a reply; a finishing reply MUST carry --status
  wb claim <id> [<text>]                   set in-progress with your name and say what you are about to do
  wb status <id> <status>                  change the status (reads the version, retries once on 409)
  wb check <id> <step> <pass|fail|skip> [--note "..."]   record one checklist result
  wb export [dir]                          write one JSON per project to the content directory

  --actor <name>   sign as (else WB_ACTOR, else settings.agentNames[WB_TOOL], else the tool name)
  WB_SESSION       this session's id, sent on every write (else the first 8 chars of CLAUDE_CODE_SESSION_ID)
  --json           machine-readable output
`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...args] = positional;
  if (!cmd || cmd === 'help' || flags.help) { console.log(HELP); return; }

  if (cmd === 'projects') {
    const { json } = await call('GET', '/api/projects');
    if (!json.ok) fail(json.error);
    const lines = json.projects.map((p: any) => `${p.slug.padEnd(24)} decision ${p.counts['needs-decision']}  qa ${p.counts['needs-qa']}  received ${p.counts.received}  working ${p.counts['in-progress']}  ${p.repos?.length ? `repos: ${p.repos.join(', ')}` : ''}`);
    out(flags, lines.join('\n') || '(no projects)', json.projects);
    return;
  }

  if (cmd === 'resolve') {
    const ref = args[0] || process.cwd();
    const { json } = await call('GET', `/api/projects?repo=${encodeURIComponent(ref)}`);
    if (!json.ok) fail(json.error);
    if (!json.projects.length) { console.error(`wb: no project claims ${ref}; set project.repos or name the slug`); process.exit(1); }
    out(flags, json.projects[0].slug, json.projects[0]);
    return;
  }

  if (cmd === 'board') {
    const slug = args[0] || fail('usage: wb board <slug>');
    const status = typeof flags.status === 'string' ? flags.status : flags.all ? '' : 'received,in-progress';
    const q = status ? `?status=${encodeURIComponent(status)}&messages=last` : '?messages=last';
    const { json } = await call('GET', `/api/projects/${slug}${q}`);
    if (!json.ok) fail(json.error);
    const human = json.items.length
      ? json.items.map(row).join('\n\n')
      : `nothing at ${status || 'any status'} on ${slug}`;
    out(flags, `${slug}  counts ${JSON.stringify(json.counts)}\n\n${human}`, json);
    return;
  }

  if (cmd === 'show') {
    const id = args[0] || fail('usage: wb show <id>');
    const { json } = await call('GET', `/api/items/${id}`);
    if (!json.ok) fail(json.error);
    const i = json.item;
    const thread = (i.messages || []).map((m: any) => `  [${m.createdAt}] ${m.who === 'you' ? 'YOU' : m.author}${m.session ? '·' + m.session : ''}: ${m.text}`).join('\n');
    const checks = (i.checks || []).map((c: any) => `  [${(c.result || ' ').padEnd(4)}] ${c.id}: ${c.label}${c.note ? ` — ${c.note}` : ''}${c.by ? ` (${c.by})` : ''}`).join('\n');
    out(flags, [
      `${i.kind} ${i.status} v${i.version} by ${i.updatedBy || '-'} ${i.updatedAt}`,
      `title:   ${i.title}`,
      i.labels?.length ? `labels:  ${i.labels.join(', ')}` : null,
      i.options?.length ? `options: ${i.options.join(' | ')}` : null,
      i.choice ? `choice:  ${i.choice}` : null,
      `context: ${i.context}`,
      checks ? `checks:\n${checks}` : null,
      i.body ? `body (${i.bodyFormat}, ${i.body.length} chars):\n${i.body}` : null,
      `thread:\n${thread || '  (none)'}`,
    ].filter(Boolean).join('\n'), i);
    return;
  }

  if (cmd === 'ask') {
    const slug = args[0] || fail('usage: wb ask <slug> <json|file|->');
    const body = await readBodyArg(args[1]);
    const { status, json } = await call('POST', `/api/projects/${slug}/items`, body);
    if (!json.ok) fail(`${status}: ${json.error}`);
    if (json.warnings) for (const w of json.warnings) console.error(`wb: warning: ${w}`);
    if (json.ignored) console.error(`wb: ignored fields: ${json.ignored.join(', ')}`);
    out(flags, json.items.map((i: any) => `${i.id}  ${i.status}  ${i.title}`).join('\n'), json.items);
    return;
  }

  if (cmd === 'reply') {
    const id = args[0] || fail('usage: wb reply <id> <text> [--status s]');
    const text = args.slice(1).join(' ') || fail('reply text is required');
    const who = await actor(flags);
    const payload: any = { who: 'agent', actor: who, session: session(), text };
    if (typeof flags.status === 'string') payload.status = flags.status;
    const { status, json } = await call('POST', `/api/items/${id}/messages`, payload);
    if (!json.ok) fail(`${status}: ${json.error}`);
    if (json.warning) console.error(`wb: warning: ${json.warning}`);
    out(flags, `${json.item.status} v${json.item.version}  ${json.item.title}`, json);
    return;
  }

  if (cmd === 'claim') {
    const id = args[0] || fail('usage: wb claim <id> [<what you are about to do>]');
    const who = await actor(flags);
    const item = await patchItem(id, { status: 'in-progress' }, who);
    const text = args.slice(1).join(' ') || 'Picking this up.';
    await call('POST', `/api/items/${id}/messages`, { who: 'agent', actor: who, session: session(), text: `Picking this up: ${text}` });
    out(flags, `in-progress v${item.version + 1}  ${item.title}`, item);
    return;
  }

  if (cmd === 'status') {
    const id = args[0] || fail('usage: wb status <id> <status>');
    const next = args[1] || fail('status is required');
    const item = await patchItem(id, { status: next }, await actor(flags));
    out(flags, `${item.status} v${item.version}  ${item.title}`, item);
    return;
  }

  if (cmd === 'check') {
    const [id, step, result] = args;
    if (!id || !step || !result) fail('usage: wb check <id> <step> <pass|fail|skip> [--note "..."]');
    const payload: any = { result, actor: await actor(flags), session: session() };
    if (typeof flags.note === 'string') payload.note = flags.note;
    const { status, json } = await call('PATCH', `/api/items/${id}/checks/${step}`, payload);
    if (!json.ok) fail(`${status}: ${json.error}`);
    const c = json.item.checks.find((x: any) => x.id === step);
    out(flags, `${c?.result} ${step}  item now ${json.item.status}`, json.item);
    return;
  }

  if (cmd === 'export') {
    const dir = args[0] || process.env.WORKBENCH_CONTENT || `${homedir()}/workbench-content`;
    // Delegates to the same code the server uses, through the CLI entry so the
    // database path rules stay in one place.
    const proc = Bun.spawn(['bun', 'run', new URL('./cli.ts', import.meta.url).pathname, 'export', dir], { stdout: 'inherit', stderr: 'inherit' });
    process.exit(await proc.exited);
  }

  fail(`unknown command "${cmd}" (${basename(process.argv[1])} help)`);
}

main();
