// The request handler, separated from the process that serves it.
//
// `server.ts` used to hold both: the routes and the `Bun.serve` call, with the
// store and the public directory as module-level constants. That made the one
// layer agents actually talk to — the JSON the routes return, the exact 400
// messages the contract promises, the 409 shape — untestable without starting a
// real server on a real port. `createHandler` takes the store and the paths as
// arguments and hands back the `fetch` function, so a test can call it with a
// `Request` and read the `Response` in-process.
import {
  Store, STATUSES, VersionConflict, ChecksLocked, findSimilarSection, asStatusValue,
  isStatusAllowed, statusesFor, KINDS,
  type Status, type ItemInput, type Project, type Kind,
} from './db.ts';
import { join } from 'path';

/**
 * The contract version. Bumped in the same pull request as any change to a
 * route, a field or a rule in AGENTS.md, so a writer running from a cached copy
 * of the contract can tell it is stale in one call (`GET /api`) instead of
 * discovering it when a request is refused. The server keeps accepting older
 * spellings regardless; the number is for the writer, not the server.
 */
export const CONTRACT_VERSION = '5';

export type HandlerOptions = {
  /** Directory the static UI is served from. */
  publicDir: string;
  /** The contract file, served verbatim at /api-doc. */
  agentsMdPath: string;
  /** Called after every request that changed something; the server hangs the auto-export on it. */
  onWrite?: () => void;
  /** The human's home directory, for expanding `~` in repo paths. */
  home?: string;
};

// Pretty JSON for a person reading it in a browser, compact for a program.
// Browsers send `Sec-Fetch-Mode` on every request and scripts do not, which is
// a more honest signal than the Accept header (fetch() sends `*/*`). The
// two-space indent was roughly a third of every agent payload. `?pretty=1`
// forces it for anyone debugging with curl.
function wantsPretty(req: Request, url: URL): boolean {
  if (url.searchParams.get('pretty') === '1') return true;
  if (url.searchParams.get('pretty') === '0') return false;
  return req.headers.has('sec-fetch-mode');
}

type Ctx = { pretty: boolean; wrote: boolean; browser: boolean };

// Which session of the actor is writing. `actor` is the name a person
// recognises; two sessions of one tool share it and are two workers. The
// session id — generated once by the writer, sent on every write — is what
// tells them apart, and what makes claim recovery exact: same session, mine;
// same actor, other session, a sibling or my own crashed run. Optional, so an
// older writer is not refused; '' is stored when none is sent.
function sessionOf(body: any): string | undefined {
  return typeof body?.session === 'string' && body.session.trim() ? body.session.trim().slice(0, 40) : undefined;
}

// The browser never sends an actor; it IS the human. Defaulting its edits to
// `you` keeps a button click from leaving updatedBy empty — which it did, and
// the row then said nobody had moved the item the human had just answered.
function actorOr(ctx: Ctx, body: any, alias: 'author' | 'by'): string | undefined {
  return actorOf(body, alias) ?? (ctx.browser ? 'you' : undefined);
}

function json(ctx: Ctx, data: unknown, status = 200): Response {
  return new Response(ctx.pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function badRequest(ctx: Ctx, message: string): Response {
  return json(ctx, { ok: false, error: message }, 400);
}

function notFound(ctx: Ctx, message = 'not found'): Response {
  return json(ctx, { ok: false, error: message }, 404);
}

// Accepts the current spellings and the old ones (see STATUS_ALIASES), so a
// writer running from a cached copy of the contract is not refused for being
// older rather than wrong. The value stored is always the current spelling.
function asStatus(value: unknown, field = 'status'): Status | undefined {
  if (value === undefined || value === null) return undefined;
  const status = asStatusValue(value);
  if (!status) throw new Error(`${field} must be one of: ${STATUSES.join(', ')}`);
  return status;
}

// Who is doing this. One name, `actor`, on every write — an edit, a reply, a
// checklist result. It used to be three: `actor` on edits, `author` on messages,
// `by` on checks, and the contract had to spend a paragraph telling agents which
// word went where. The old two are still read as aliases so a writer on an
// older copy of the contract is not refused; `actor` wins when both are sent.
function actorOf(body: any, alias: 'author' | 'by'): string | undefined {
  if (typeof body?.actor === 'string' && body.actor.trim()) return body.actor.trim();
  if (typeof body?.[alias] === 'string' && body[alias].trim()) return body[alias].trim();
  return undefined;
}

// Fields a caller may send, per write. Anything else is reported back as
// `ignored`, not refused: a misspelt `lables` used to vanish with a 201, and the
// caller believed the label had landed until the board looked wrong. Refusing
// would break older writers sending fields since retired; naming the drop is
// enough for a writer to notice and fix itself.
const ITEM_FIELDS = new Set(['title', 'context', 'options', 'choice', 'status', 'section', 'kind', 'body', 'bodyFormat', 'checks', 'replaceChecks', 'createdAt', 'labels', 'clientId', 'ifVersion', 'actor', 'author', 'session', 'position']);
const MESSAGE_FIELDS = new Set(['who', 'text', 'actor', 'author', 'session', 'status', 'createdAt']);
const CHECK_FIELDS = new Set(['result', 'note', 'actor', 'by', 'session']);

function ignoredKeys(body: any, known: Set<string>): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.keys(body).filter((k) => !known.has(k));
}

function withIgnored<T extends object>(data: T, ignored: string[]): T & { ignored?: string[] } {
  return ignored.length ? { ...data, ignored } : data;
}

function asItemInput(body: any, requireTitle: boolean): ItemInput {
  if (!body || typeof body !== 'object') throw new Error('body must be a JSON object');
  if (requireTitle && (typeof body.title !== 'string' || !body.title.trim())) {
    throw new Error('title is required');
  }
  if (body.options !== undefined) {
    if (!Array.isArray(body.options) || body.options.some((o: unknown) => typeof o !== 'string')) {
      throw new Error('options must be an array of strings');
    }
  }
  if (body.bodyFormat !== undefined && !['text', 'markdown', 'html'].includes(body.bodyFormat)) {
    throw new Error('bodyFormat must be text, markdown or html');
  }
  if (body.kind !== undefined && !KINDS.includes(body.kind)) {
    throw new Error(`kind must be one of: ${KINDS.join(', ')}`);
  }
  // The two status sets do not overlap, and a caller who names both a kind and a
  // status it cannot hold has a real mistake rather than an old spelling — say
  // so, rather than silently storing something they did not ask for.
  const status = asStatusValue(body.status);
  if (body.kind !== undefined && status && !isStatusAllowed(body.kind as Kind, status)) {
    throw new Error(
      `a ${body.kind} cannot be "${status}". Allowed: ${statusesFor(body.kind as Kind).join(', ')}. ` +
      `An issue is something to decide or do; a document is something to read.`
    );
  }
  return {
    title: typeof body.title === 'string' ? body.title.trim() : undefined!,
    context: typeof body.context === 'string' ? body.context : undefined,
    options: body.options,
    choice: typeof body.choice === 'string' ? body.choice : undefined,
    status: asStatus(body.status),
    section: typeof body.section === 'string' ? body.section : undefined,
    kind: body.kind === undefined ? undefined : body.kind,
    // These were added to the store and forgotten here, so every document
    // imported as an empty one and the API cheerfully reported success. A
    // field the store accepts and the parser drops is a silent data loss, and
    // the only thing that catches it is checking what landed rather than what
    // the response said. `ignored` on the response now names such drops.
    body: typeof body.body === 'string' ? body.body : undefined,
    bodyFormat: body.bodyFormat,
    checks: Array.isArray(body.checks)
      ? body.checks.map((c: any, n: number) => ({
          id: typeof c?.id === 'string' && c.id ? c.id : `c${n + 1}`,
          label: String(c?.label ?? ''),
          result: ['', 'pass', 'fail', 'skip'].includes(c?.result) ? c.result : '',
          note: typeof c?.note === 'string' ? c.note : '',
          by: typeof c?.by === 'string' ? c.by : '',
          at: typeof c?.at === 'string' ? c.at : '',
        }))
      : undefined,
    // Honoured on create only (the store ignores it on update). An import
    // carrying real history says when each thing actually happened; anything
    // unparseable or in the future is dropped rather than refused, because a
    // bad date is not a reason to lose the item.
    createdAt: typeof body.createdAt === 'string' ? body.createdAt : undefined,
    // Normalised in the store, not here, so every write path gets the same
    // treatment — including an import, which is where a stray trailing space
    // would otherwise become a second label that looks identical.
    labels: body.labels === undefined ? undefined : (Array.isArray(body.labels) ? body.labels : []),
    clientId: typeof body.clientId === 'string' ? body.clientId : undefined,
  };
}

// Section policy, applied wherever an item gets one.
//
// declared → refuse an unlisted section, and say what IS allowed plus how to add
//            one. A refusal that does not tell the caller the way forward just
//            gets worked around.
// adhoc    → accept anything, but hand back a warning when it looks like a
//            near-duplicate of a section already in use. The tool cannot know
//            two names mean the same area; the human can, and now gets told.
function sectionPolicy(store: Store, project: Project, section: string | undefined): { warning?: string } {
  if (!section) return {};
  const inUse = store.sectionsInUse(project).map((s) => s.name);
  if (project.sectionMode === 'declared') {
    if (!project.sections.includes(section)) {
      const allowed = project.sections.length ? project.sections.join(', ') : '(none declared yet)';
      throw new Error(
        `section "${section}" is not declared on this project. Allowed: ${allowed}. ` +
        `Use an existing one, leave it empty, or propose a new area to the human and add it with ` +
        `PATCH /api/projects/${project.slug} {"sections":[...]}.`
      );
    }
    return {};
  }
  const similar = findSimilarSection(section, inUse);
  return similar
    ? { warning: `section "${section}" looks like a duplicate of "${similar}" already in use. Reuse that one, or merge later with PATCH /api/projects/${project.slug}/sections {"from":"...","to":"..."}.` }
    : {};
}

// Label policy: the same near-duplicate test sections get, as a warning. Nothing
// governs a label on the way in, which is why they rot faster than sections —
// "Deploy" beside "Deploys", "Ship it" beside "Ship-it" — and a filter on one
// spelling silently misses the items carrying the other. An exact match,
// case-insensitive, is the same label (the store folds case); anything the
// section test would call a duplicate is named so the writer reuses or merges.
function labelPolicy(store: Store, project: Project, labels: string[] | undefined): string[] {
  if (!labels || !labels.length) return [];
  const inUse = store.labelsInUse(project.id).map((l) => l.name);
  const warnings: string[] = [];
  for (const label of labels) {
    if (typeof label !== 'string' || !label.trim()) continue;
    if (inUse.some((l) => l.toLowerCase() === label.trim().toLowerCase())) continue;
    const similar = findSimilarSection(label.trim(), inUse);
    if (similar) {
      warnings.push(`label "${label.trim()}" looks like a duplicate of "${similar}" already in use. Reuse that one, or merge later with PATCH /api/projects/${project.slug}/labels {"from":"...","to":"..."}.`);
    }
  }
  return warnings;
}

async function readJson(req: Request): Promise<any> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('body is not valid JSON');
  }
}

// A reply that sounds finished and carries no status is the auto-claim trap:
// the reply moves a `received` item to `in-progress` (or leaves it there), and
// "landed, PR merged" then reads as work in progress under the author's name
// for good. The server cannot know the work landed, so it does not move the
// item — it says what it saw. The words are the ones agents actually write.
const FINISHED_WORDS = /\b(landed|merged|deployed|shipped|released|done|complete|completed|finished|closed|resolved|fixed)\b/i;

function finishedWithoutStatus(who: string, text: string, status: Status | undefined, after: Status): string | undefined {
  if (who !== 'agent' || status !== undefined) return undefined;
  // Any live task status qualifies, not only the two the auto-claim touches: a
  // "landed" reply on an item still at needs-qa or needs-decision leaves it
  // reading as waiting on the human, which is just as false. QA found the
  // narrower version silent on exactly that case.
  if (after === 'complete' || after === 'archived' || after === 'active') return undefined;
  if (!FINISHED_WORDS.test(text)) return undefined;
  return `this reply reads as if the work is finished but carried no status, so the item stays "${after}" under your name. ` +
    `If it landed, send status "complete"; if it needs their eyes, "needs-qa"; if it is their call now, "needs-decision".`;
}

const ROUTES = [
  'GET    /api                                 this',
  'GET    /api/settings · PATCH /api/settings',
  'GET    /api/projects[?archived=1][?repo=<remote-or-path>]',
  'POST   /api/projects                        {name, slug?, description?, repos?}',
  'GET    /api/projects/<slug>[?status=a,b][?messages=all|last|none]',
  'PATCH  /api/projects/<slug>                 {archived?|sectionMode?|sections?|groupBy?|repos?}',
  'PATCH  /api/projects/<slug>/sections        {from,to,actor}',
  'GET    /api/projects/<slug>/labels          labels in use, with counts (also returned with the board)',
  'PATCH  /api/projects/<slug>/labels          {from,to,actor}',
  'PATCH  /api/projects/<slug>/authors         {from,to,actor}',
  'POST   /api/projects/<slug>/items           item | [item, ...]   (item.clientId for idempotent retries)',
  'GET    /api/items/<id> · PATCH /api/items/<id> {..., actor, session, ifVersion}',
  'GET    /api/items/<id>/body',
  'GET    /api/items/<id>/messages · POST /api/items/<id>/messages {who, text, actor, session, status?}',
  'PATCH  /api/items/<id>/checks/<checkId>     {result, note?, actor, session}',
  'every write: actor = the name a person recognises; session = the id this session generated once at start',
];

async function handleApi(store: Store, opts: HandlerOptions, req: Request, url: URL, ctx: Ctx): Promise<Response> {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method.toUpperCase();

  // The API describes itself, so a writer can check the contract version in one
  // call and find the contract without knowing where the repository lives.
  if (parts.length === 0) {
    if (method === 'GET') return json(ctx, { ok: true, contractVersion: CONTRACT_VERSION, agentsMd: '/api-doc', routes: ROUTES });
    return badRequest(ctx, `${method} not supported here`);
  }

  // Settings: what the human has already been asked and answered. An agent
  // reads this FIRST in a session so it neither re-asks nor assumes.
  if (parts[0] === 'settings' && parts.length === 1) {
    if (method === 'GET') return json(ctx, { ok: true, settings: store.getSettings() });
    if (method === 'PATCH') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(ctx, 'body must be a JSON object');
      ctx.wrote = true;
      return json(ctx, { ok: true, settings: store.setSettings(body) });
    }
    return badRequest(ctx, `${method} not supported here`);
  }

  if (parts[0] === 'projects' && parts.length === 1) {
    if (method === 'GET') {
      // ?repo= resolves the project for the repository a session is standing
      // in, so it never has to read every board to find its own. One match or
      // none; the list shape is kept so callers parse one thing.
      const repo = url.searchParams.get('repo');
      if (repo !== null) {
        const match = store.resolveProject(repo, opts.home);
        return json(ctx, { ok: true, projects: match ? [{ ...match, counts: store.counts(match.id) }] : [], resolvedFrom: repo });
      }
      // GET /api/projects — everything the index needs in one call, counts
      // included, so the gallery never fans out one request per project.
      const includeArchived = url.searchParams.get('archived') === '1';
      const projects = store.listProjects(includeArchived).map((p) => ({ ...p, counts: store.counts(p.id) }));
      return json(ctx, { ok: true, projects });
    }
    if (method === 'POST') {
      const body = await readJson(req);
      if (typeof body.name !== 'string' || !body.name.trim()) return badRequest(ctx, 'name is required');
      if (body.repos !== undefined && (!Array.isArray(body.repos) || body.repos.some((x: unknown) => typeof x !== 'string'))) {
        return badRequest(ctx, 'repos must be an array of strings');
      }
      ctx.wrote = true;
      const project = store.createProject({ name: body.name.trim(), slug: body.slug, description: body.description, repos: body.repos });
      return json(ctx, { ok: true, project }, 201);
    }
    return badRequest(ctx, `${method} not supported here`);
  }

  if (parts[0] === 'projects' && parts.length >= 2) {
    const project = store.getProject(parts[1]);
    if (!project) return notFound(ctx, `no project with slug "${parts[1]}"`);

    if (parts.length === 2) {
      if (method === 'GET') {
        // ?status=received,in-progress returns only those rows — the actionable
        // set on a check-in — and ?messages=last|none trims the threads. The
        // browser sends neither and gets the whole board, as before.
        const statusFilter = url.searchParams.get('status');
        const wanted = statusFilter
          ? new Set(statusFilter.split(',').map((s) => asStatusValue(s.trim())).filter(Boolean) as Status[])
          : null;
        if (statusFilter && wanted!.size === 0) return badRequest(ctx, `status filter must name one or more of: ${STATUSES.join(', ')}`);
        const messagesParam = url.searchParams.get('messages') ?? 'all';
        if (!['all', 'last', 'none'].includes(messagesParam)) return badRequest(ctx, "messages must be all, last or none");
        let items = store.listItems(project.id, messagesParam as 'all' | 'last' | 'none');
        if (wanted) items = items.filter((i) => wanted.has(i.status));
        // `sections` and `labels` are returned so an agent can read the
        // vocabulary in the same call it reads the board, and reuse a name
        // instead of inventing a near-synonym. Deriving them by scanning items
        // is what agents skip.
        return json(ctx, {
          ok: true,
          project,
          items,
          counts: store.counts(project.id),
          sections: store.sectionsInUse(project),
          labels: store.labelsInUse(project.id),
        });
      }
      if (method === 'PATCH') {
        const body = await readJson(req);
        if (typeof body.archived === 'boolean') {
          ctx.wrote = true;
          return json(ctx, { ok: true, project: store.archiveProject(project.slug, body.archived) });
        }
        if (body.sectionMode !== undefined || body.sections !== undefined || body.groupBy !== undefined || body.repos !== undefined) {
          if (body.sectionMode !== undefined && !['adhoc', 'declared'].includes(body.sectionMode)) {
            return badRequest(ctx, "sectionMode must be 'adhoc' or 'declared'");
          }
          if (body.sections !== undefined && (!Array.isArray(body.sections) || body.sections.some((x: unknown) => typeof x !== 'string'))) {
            return badRequest(ctx, 'sections must be an array of strings');
          }
          if (body.groupBy !== undefined && !['section', 'status'].includes(body.groupBy)) {
            return badRequest(ctx, "groupBy must be 'section' or 'status'");
          }
          if (body.repos !== undefined && (!Array.isArray(body.repos) || body.repos.some((x: unknown) => typeof x !== 'string'))) {
            return badRequest(ctx, 'repos must be an array of strings');
          }
          ctx.wrote = true;
          const updated = store.setProjectSections(project.slug, body)!;
          return json(ctx, { ok: true, project: updated, sections: store.sectionsInUse(updated), labels: store.labelsInUse(updated.id) });
        }
        return badRequest(ctx, 'nothing to update; supported: archived, sectionMode, sections, groupBy, repos');
      }
      return badRequest(ctx, `${method} not supported here`);
    }

    // Rename or merge a section across the whole project. The repair tool —
    // without one, a vocabulary can only ever get worse.
    if (parts[2] === 'sections' && parts.length === 3 && method === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.from !== 'string' || !body.from || typeof body.to !== 'string') {
        return badRequest(ctx, 'from (non-empty string) and to (string) are required');
      }
      ctx.wrote = true;
      const moved = store.renameSection(project.id, body.from, body.to, actorOf(body, 'author') ?? '');
      const after = store.getProject(project.slug)!;
      // Keep the declared list honest with what just happened.
      if (after.sections.includes(body.from)) {
        const next = after.sections.filter((s) => s !== body.from);
        if (body.to && !next.includes(body.to)) next.push(body.to);
        store.setProjectSections(after.slug, { sections: next });
      }
      const fresh = store.getProject(project.slug)!;
      return json(ctx, { ok: true, moved, sections: store.sectionsInUse(fresh) });
    }

    // Rename, merge or remove a label across the whole project. Labels rot
    // faster than sections because nothing governs them on the way in, so the
    // repair tool matters more here, not less. An empty `to` removes it.
    if (parts[2] === 'labels' && parts.length === 3 && method === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.from !== 'string' || !body.from || typeof body.to !== 'string') {
        return badRequest(ctx, 'from (non-empty string) and to (string) are required');
      }
      ctx.wrote = true;
      const moved = store.renameLabel(project.id, body.from, body.to, actorOf(body, 'author') ?? '');
      return json(ctx, { ok: true, moved, labels: store.labelsInUse(project.id) });
    }
    // The vocabulary alone, for a label field that wants to offer it without
    // downloading the board — the item page, a CLI completing a flag.
    if (parts[2] === 'labels' && parts.length === 3 && method === 'GET') {
      return json(ctx, { ok: true, labels: store.labelsInUse(project.id) });
    }

    // Rename an author across the whole project — every message they signed and
    // every item they last touched. The repair for the failure the contract
    // warned about and the reference board then produced anyway: one agent
    // signing as two names (`spike` on 22 messages, `claude-code` on 64), so the
    // "who spoke last" column could not answer its one question. Exact match,
    // case-insensitive; `to` may not be empty because an unsigned message is the
    // thing the `actor` rule exists to prevent.
    if (parts[2] === 'authors' && parts.length === 3 && method === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.from !== 'string' || !body.from.trim() || typeof body.to !== 'string' || !body.to.trim()) {
        return badRequest(ctx, 'from and to (both non-empty strings) are required');
      }
      ctx.wrote = true;
      const moved = store.renameAuthor(project.id, body.from, body.to);
      return json(ctx, { ok: true, moved });
    }

    if (parts[2] === 'items' && parts.length === 3) {
      if (method === 'GET') return json(ctx, { ok: true, items: store.listItems(project.id) });
      if (method === 'POST') {
        const body = await readJson(req);
        // An array creates a whole set in one call. This is the shape an agent
        // wants at the start of a piece of work — "here are the nine things I
        // need decided" — and doing it one request at a time is how half-built
        // lists happen when something fails in the middle.
        const inputs = Array.isArray(body) ? body : [body];
        const parsed = inputs.map((input) => asItemInput(input, true));
        const ignored = [...new Set(inputs.flatMap((input) => ignoredKeys(input, ITEM_FIELDS)))];
        // Policy first, for every item, so a batch either lands whole or is
        // refused whole — half a set is worse than none.
        const warnings: string[] = [];
        for (const input of parsed) {
          const { warning } = sectionPolicy(store, project, input.section);
          if (warning) warnings.push(warning);
          warnings.push(...labelPolicy(store, project, input.labels));
        }
        ctx.wrote = true;
        const created = parsed.map((input) => store.createItem(project.id, input));
        return json(ctx, withIgnored({ ok: true, items: created, ...(warnings.length ? { warnings } : {}) }, ignored), 201);
      }
      return badRequest(ctx, `${method} not supported here`);
    }
  }

  if (parts[0] === 'items' && parts.length >= 2) {
    const item = store.getItem(parts[1]);
    if (!item) return notFound(ctx, `no item with id "${parts[1]}"`);

    if (parts.length === 2) {
      if (method === 'GET') return json(ctx, { ok: true, item });
      if (method === 'PATCH') {
        const body = await readJson(req);
        const patch = asItemInput(body, false);
        const ignored = ignoredKeys(body, ITEM_FIELDS);
        if (typeof body.position === 'number') (patch as any).position = body.position;
        const warnings: string[] = [];
        if (patch.section !== undefined || patch.labels !== undefined) {
          const owner = store.listProjects(true).find((p) => p.id === item.projectId);
          if (owner) {
            if (patch.section !== undefined) {
              const { warning } = sectionPolicy(store, owner, patch.section);
              if (warning) warnings.push(warning);
            }
            // Labels already on this item are "in use" by it, so exclude them:
            // re-saving the same set must not warn about itself.
            const added = (patch.labels || []).filter((l) => !item.labels.some((x) => x.toLowerCase() === String(l).toLowerCase()));
            warnings.push(...labelPolicy(store, owner, added));
          }
        }
        const ifVersion = typeof body.ifVersion === 'number' ? body.ifVersion : undefined;
        // A status change without the version you read is a blind write in a
        // tool whose premise is several sessions on one board: the careless
        // writer wins over the careful one. Warned now; the contract says a
        // later version refuses it, so nobody is surprised when it does.
        if (patch.status !== undefined && patch.status !== item.status && ifVersion === undefined) {
          warnings.push(`status changed without ifVersion — send the version you read (${item.version} before this write); a later contract version refuses this with 400`);
        }
        try {
          ctx.wrote = true;
          const updated = store.updateItem(item.id, patch, {
            ifVersion, actor: actorOr(ctx, body, 'author'), session: sessionOf(body),
            replaceChecks: body.replaceChecks === true,
          });
          return json(ctx, withIgnored({ ok: true, item: updated, ...(warnings.length ? { warning: warnings.join(' | ') } : {}) }, ignored));
        } catch (error) {
          if (error instanceof VersionConflict) {
            // 409 with the live item attached, so the caller merges onto what is
            // actually there instead of re-reading and racing the same way again.
            return json(ctx, { ok: false, error: error.message, conflict: true, item: error.current }, 409);
          }
          if (error instanceof ChecksLocked) {
            // Same status, different conflict: the steps hold a QA record and
            // the caller tried to write over it without saying so.
            return json(ctx, { ok: false, error: error.message, conflict: 'checks', stepsWithResults: error.stepsWithResults, item: error.current }, 409);
          }
          throw error;
        }
      }
      // There is no delete. The board is a record: a decision somebody made is
      // archived (a document) or completed (an issue), never erased. The route
      // existed, undocumented and unguarded — no version check, no actor, no
      // trace — and a model that reads source will use what it finds to "tidy".
      if (method === 'DELETE') {
        return json(ctx, { ok: false, error: 'items are never deleted: the board is a record. Set status "archived" on a document or "complete" on an issue instead.' }, 405);
      }
      return badRequest(ctx, `${method} not supported here`);
    }

    // The document itself, at its own URL. It used to be inlined into a
    // `srcdoc` attribute, which meant a 150KB document travelled as one HTML
    // attribute inside the page — slow, and it rendered blank. A real URL also
    // means the document can be opened in its own tab, which is what you want
    // for anything long enough to be called a document.
    if (parts[2] === 'body' && method === 'GET') {
      const types: Record<string, string> = {
        html: 'text/html; charset=utf-8',
        markdown: 'text/plain; charset=utf-8',
        text: 'text/plain; charset=utf-8',
      };
      return new Response(item.body, {
        headers: {
          'content-type': types[item.bodyFormat] || types.text,
          // Belt and braces with the iframe sandbox: an imported document is
          // somebody else's markup and must not be able to frame-bust or be
          // treated as trusted by anything else.
          'content-security-policy': "sandbox; default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com",
          'x-content-type-options': 'nosniff',
        },
      });
    }

    // One step of a checklist. A whole-array PATCH would lose a concurrent
    // answer to a different step, which is the normal case when somebody walks
    // a checklist while an agent is writing to the same item.
    if (parts[2] === 'checks' && parts.length === 4 && method === 'PATCH') {
      const body = await readJson(req);
      if (body.result !== undefined && !['', 'pass', 'fail', 'skip'].includes(body.result)) {
        return badRequest(ctx, "result must be '', pass, fail or skip");
      }
      try {
        ctx.wrote = true;
        const updated = store.setCheck(item.id, parts[3], {
          result: body.result,
          note: typeof body.note === 'string' ? body.note : undefined,
          // Defaults to the human, not to the literal `agent`: the browser posts
          // check results without a name, and a step somebody walked by hand
          // must not read as machine-recorded.
          by: actorOf(body, 'by') ?? 'you',
          session: sessionOf(body),
        });
        return json(ctx, withIgnored({ ok: true, item: updated }, ignoredKeys(body, CHECK_FIELDS)));
      } catch (error: any) {
        if (error?.statusCode === 400) return badRequest(ctx, error.message);
        throw error;
      }
    }

    if (parts[2] === 'messages') {
      if (method === 'GET') return json(ctx, { ok: true, messages: store.listMessages(item.id) });
      if (method === 'POST') {
        const body = await readJson(req);
        if (typeof body.text !== 'string' || !body.text.trim()) return badRequest(ctx, 'text is required');
        const who = body.who === 'you' ? 'you' : 'agent';
        const status = asStatus(body.status);
        ctx.wrote = true;
        const message = store.addMessage(item.id, {
          who,
          text: body.text.trim(),
          author: actorOf(body, 'author'),
          session: sessionOf(body),
          status,
        });
        const after = store.getItem(item.id)!;
        const warning = finishedWithoutStatus(who, body.text, status, after.status);
        return json(ctx, withIgnored({ ok: true, message, item: after, ...(warning ? { warning } : {}) }, ignoredKeys(body, MESSAGE_FIELDS)), 201);
      }
      return badRequest(ctx, `${method} not supported here`);
    }
  }

  return notFound(ctx, `no API route for ${method} ${url.pathname}`);
}

/** The `fetch` handler for one store: the API under /api, the UI everywhere else. */
export function createHandler(store: Store, opts: HandlerOptions): (req: Request) => Promise<Response> {
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // `/api/` with the slash: every API route has one, and a bare prefix test
    // swallowed `/api-doc` into the API router, which then 404'd it.
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const ctx: Ctx = { pretty: wantsPretty(req, url), wrote: false, browser: req.headers.has('sec-fetch-mode') };
      try {
        return await handleApi(store, opts, req, url, ctx);
      } catch (error: any) {
        // Every thrown validation message is written to be read by whoever sent
        // the request, which is usually an agent deciding what to do next.
        return badRequest(ctx, error?.message || 'request failed');
      } finally {
        if (ctx.wrote && opts.onWrite) opts.onWrite();
      }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(Bun.file(join(opts.publicDir, 'index.html')));
    }
    // The contract is one file, AGENTS.md, and this renders that same file
    // rather than a copy of it — a second copy is a second thing to forget to
    // update, and the footer link pointed at a page that did not exist at all.
    if (url.pathname === '/agents.html') {
      return new Response(Bun.file(join(opts.publicDir, 'agents.html')));
    }
    if (url.pathname === '/api-doc') {
      return new Response(Bun.file(opts.agentsMdPath), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    // /p/<slug>/i/<id> is one item on its own page; /p/<slug> is the list. Both
    // read their identifiers client-side from the path.
    if (/^\/p\/[^/]+\/i\/[^/]+\/?$/.test(url.pathname)) {
      return new Response(Bun.file(join(opts.publicDir, 'item.html')));
    }
    if (url.pathname.startsWith('/p/')) {
      return new Response(Bun.file(join(opts.publicDir, 'project.html')));
    }
    const asset = Bun.file(join(opts.publicDir, url.pathname.replace(/^\/+/, '')));
    if (await asset.exists()) return new Response(asset);
    return new Response('Not found', { status: 404 });
  };
}
