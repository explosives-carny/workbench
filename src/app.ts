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
  Store, STATUSES, VersionConflict, ChecksLocked, QuestionsLocked, findSimilarSection, asStatusValue,
  ProjectKeyTaken, PROJECT_COLORS, STATUS_GROUPS, MOVE_GROUPS,
  isStatusAllowed, statusesFor, KINDS, defaultStatusFor, normaliseRecommended, CHECK_OWNERS,
  isDueDate, normalisePriority, PRIORITIES, kindFor, PROJECT_MODES, TODO_STATUSES,
  isWorkKind, checkQuestionSet, buildQuestions, type QuestionInput,
  type Status, type ItemInput, type Project, type Kind, type Item,
} from './db.ts';
import { join } from 'path';
import {
  blockedWithoutReason, titleWarning, recommendationRefusal, lacksRecommendation, MISSING_RECOMMENDATION,
  convertRecommendedSuffix, noOptionsWarning, recommendedInTextWarning, unownedStepsWarning, auditItems,
  wallOfTextWarning, escapedNewlineWarning, pointerOptionWarning,
  questionWithoutRecommendation, emptyQuestionSetWarning, longQuestionSetHint, questionFormatFindings,
} from './rules.ts';
import { itemBrief } from './brief.ts';
import { ImageStore, ImageRefused, imageHeaders, imageTooLarge, MAX_IMAGE_REQUEST_BYTES } from './images.ts';

/**
 * The contract version. Bumped in the same pull request as any change to a
 * route, a field or a rule in AGENTS.md, so a writer running from a cached copy
 * of the contract can tell it is stale in one call (`GET /api`) instead of
 * discovering it when a request is refused. The server keeps accepting older
 * spellings regardless; the number is for the writer, not the server.
 */
export const CONTRACT_VERSION = '23';

export type HandlerOptions = {
  /** Directory the static UI is served from. */
  publicDir: string;
  /** The contract file, served verbatim at /api-doc. */
  agentsMdPath: string;
  /** Called after every request that changed something; the server hangs the auto-export on it. */
  onWrite?: () => void;
  /** The human's home directory, for expanding `~` in repo paths. */
  home?: string;
  /**
   * Where uploaded images live (contract v22). The server puts it beside the
   * database. Left out, the image routes answer that this board stores none,
   * rather than writing pictures somewhere nobody chose.
   */
  imagesDir?: string;
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
const ITEM_FIELDS = new Set(['title', 'context', 'options', 'recommended', 'choice', 'status', 'section', 'blockedBy', 'dueAt', 'priority', 'kind', 'body', 'bodyFormat', 'checks', 'replaceChecks', 'questions', 'replaceQuestions', 'createdAt', 'labels', 'clientId', 'ifVersion', 'actor', 'author', 'session', 'position']);
const MESSAGE_FIELDS = new Set(['who', 'text', 'actor', 'author', 'session', 'status', 'createdAt']);
const IMAGE_FIELDS = new Set(['data', 'alt', 'name', 'actor', 'author', 'session']);
const CHECK_FIELDS = new Set(['result', 'note', 'owner', 'actor', 'by', 'session']);
const ANSWER_FIELDS = new Set(['choice', 'answer', 'clear', 'relay', 'actor', 'by', 'session']);

function ignoredKeys(body: any, known: Set<string>): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.keys(body).filter((k) => !known.has(k));
}

// Board settings: the onboarding answers and the few board-wide choices. This
// used to store any key with any value, so a typo (`autoCaptue`) or a wrong type
// (`agentNames: "Spike"`) was saved silently and the settings panel then read it
// back broken. Known keys are now type-checked and refused with the reason;
// unknown keys are not stored and come back in `ignored`, like item fields.
// `actor` and `session` are the write signature every client sends, never
// settings. `autoMode` is deliberately not a key: auto is a session order.
const SETTINGS_BOOLEANS = ['autoCapture', 'checkInOnStart', 'postFindings', 'summariseOnExit'];
const SETTINGS_SIGNATURE = new Set(['actor', 'session']);
export function checkSettingsPatch(
  body: Record<string, unknown>,
  projectExists: (slug: string) => boolean
): { patch: Record<string, unknown>; ignored: string[]; error?: string } {
  const patch: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (SETTINGS_SIGNATURE.has(key)) continue;
    if (SETTINGS_BOOLEANS.includes(key)) {
      if (typeof value !== 'boolean') return { patch, ignored, error: `${key} must be true or false` };
    } else if (key === 'defaultProject') {
      if (value !== null && typeof value !== 'string') return { patch, ignored, error: 'defaultProject must be a project slug, or null to clear it' };
      if (typeof value === 'string' && value && !projectExists(value)) return { patch, ignored, error: `defaultProject: no project "${value}"` };
    } else if (key === 'backupPlan') {
      if (value !== null && typeof value !== 'string') return { patch, ignored, error: 'backupPlan must be a string, or null to clear it' };
    } else if (key === 'onboardedAt') {
      if (value !== null && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
        return { patch, ignored, error: 'onboardedAt must be an ISO date-time, or null' };
      }
    } else if (key === 'agentNames') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { patch, ignored, error: 'agentNames must be an object of tool: name' };
      for (const [tool, name] of Object.entries(value as Record<string, unknown>)) {
        if (!tool.trim() || typeof name !== 'string') return { patch, ignored, error: `agentNames.${tool || "(empty)"} must be a name string` };
      }
    } else {
      ignored.push(key);
      continue;
    }
    patch[key] = value;
  }
  return { patch, ignored };
}

function withIgnored<T extends object>(data: T, ignored: string[]): T & { ignored?: string[] } {
  return ignored.length ? { ...data, ignored } : data;
}

// The questions of a question set, shape-checked. Strings are coerced, a
// malformed option list is refused (a button the writer meant and the board
// would not show is worse than a refusal), and `relayed` is a plain boolean.
// Ids, labels and recommended-filtering are the store's (see buildQuestions).
function asQuestions(raw: unknown): QuestionInput[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error('questions must be an array of {"label","ask","options":[…],"recommended":[…]}');
  return raw.map((q: any, n: number) => {
    const where = `questions[${n}]`;
    if (!q || typeof q !== 'object' || Array.isArray(q)) throw new Error(`${where} must be an object with "ask"`);
    const text = (field: string) => (q[field] === undefined || q[field] === null ? '' : typeof q[field] === 'object' ? (() => { throw new Error(`${where}.${field} must be a string`); })() : String(q[field]));
    const list = (field: string) => {
      if (q[field] === undefined) return [];
      if (!Array.isArray(q[field]) || q[field].some((o: unknown) => typeof o !== 'string')) throw new Error(`${where}.${field} must be an array of strings`);
      return q[field] as string[];
    };
    const ask = text('ask');
    const label = text('label');
    if (!ask.trim() && !label.trim()) throw new Error(`${where} needs an "ask" (the question itself)`);
    return {
      id: text('id').trim() || undefined,
      label, ask,
      options: list('options'),
      recommended: list('recommended'),
      choice: text('choice'),
      answer: text('answer'),
      by: text('by'),
      at: text('at'),
      relayed: q.relayed === true,
    };
  });
}

// Policy checked before anything is written, so a batch of items either lands
// whole or is refused whole: the shape of a question set, and its ids.
function questionSetRefusal(kind: Kind, input: ItemInput): string | undefined {
  const refusal = checkQuestionSet(kind, { options: input.options || [], recommended: input.recommended || [], choice: input.choice || '', questions: input.questions });
  if (refusal) return refusal;
  if (kind === 'questions') {
    try { buildQuestions(input.questions || []); } catch (error: any) { return error.message; }
  }
  return undefined;
}

// What a written question set earns in warnings: per question, the same bar a
// decision is held to, plus the set-level ones.
function questionSetWarnings(item: Item, sent: boolean): string[] {
  if (item.kind !== 'questions') return [];
  const out: (string | undefined)[] = [emptyQuestionSetWarning(item)];
  if (sent) {
    out.push(longQuestionSetHint(item));
    for (const q of item.questions) out.push(questionWithoutRecommendation(q));
    for (const f of questionFormatFindings(item)) out.push(f.message);
  }
  return out.filter(Boolean) as string[];
}

// List rows carry the counts, never the array: a board of forty sets would
// otherwise ship every ask on every poll. The item itself carries the array.
function withoutQuestions<T extends Item>(items: T[]): T[] {
  return items.map((item) => {
    if (!item.questions.length) return item;
    const { questions: _dropped, ...row } = item;
    return row as T;
  });
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
  if (body.recommended !== undefined) {
    if (!Array.isArray(body.recommended) || body.recommended.some((o: unknown) => typeof o !== 'string')) {
      throw new Error('recommended must be an array of option strings, e.g. "recommended":["B"]');
    }
  }
  if (Array.isArray(body.checks) && body.checks.some((c: any) => c?.owner !== undefined && c.owner !== '' && !CHECK_OWNERS.includes(c.owner))) {
    throw new Error('check owner must be human or agent');
  }
  // A due date is a calendar day, and a malformed one is refused rather than
  // dropped: a deadline the writer believes they set and the board silently
  // discarded is the worst outcome a deadline field can have. null (or "")
  // clears it.
  if (body.dueAt !== undefined && body.dueAt !== null && body.dueAt !== '' && !isDueDate(body.dueAt)) {
    throw new Error(
      `dueAt must be a calendar date written YYYY-MM-DD, e.g. "2026-10-31", or null to clear it; got ${JSON.stringify(body.dueAt)}`
    );
  }
  if (body.priority !== undefined && body.priority !== null && body.priority !== '' && !normalisePriority(body.priority)) {
    throw new Error(`priority must be high, medium or low (or ${PRIORITIES.join(', ')}, p1 = high), or null to clear it; got ${JSON.stringify(body.priority)}`);
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
    recommended: body.recommended,
    choice: typeof body.choice === 'string' ? body.choice : undefined,
    status: asStatus(body.status),
    section: typeof body.section === 'string' ? body.section : undefined,
    blockedBy: typeof body.blockedBy === 'string' ? body.blockedBy : undefined,
    // Left out → unchanged; null or "" → cleared (validated above).
    dueAt: body.dueAt === undefined ? undefined : (body.dueAt === null || body.dueAt === '' ? null : body.dueAt),
    priority: body.priority === undefined ? undefined : (body.priority === null || body.priority === '' ? null : normalisePriority(body.priority)),
    kind: body.kind === undefined ? undefined : body.kind,
    questions: asQuestions(body.questions),
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
          owner: c?.owner === 'human' || c?.owner === 'agent' ? c.owner : '',
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

// An archived project is "kept as a record", not actively worked — but
// nothing here refuses a write into one; the human archived the project, not
// its history, and a late reply or a stray automation should still land
// rather than fail closed. Warned instead, so the caller notices rather than
// wondering later why an answer landed on a project the board's own banner
// already says is archived.
function archivedProjectWarning(project: { name: string; archivedAt: string | null } | null): string | undefined {
  if (!project || !project.archivedAt) return undefined;
  return `project "${project.name}" is archived — the write landed, but this project is kept as a record, not actively worked`;
}

// To-do projects (contract v18). A project with mode "todo" holds to-dos and
// documents; every other project is a board and holds issues and documents,
// exactly as before. Due dates and priorities exist on to-dos only, so a board
// item can never grow a deadline field that would compete with the whose-move
// status as the thing that says what needs doing. Refused rather than
// dropped: a deadline the writer thinks they set and the board silently
// discarded is the worst outcome a deadline field can have.
function todoPolicy(
  project: Project,
  resultingKind: Kind,
  asked: { kind?: Kind; status?: Status; dueAt?: string | null; priority?: string | null }
): string | undefined {
  const where = `"${project.slug}"`;
  if (project.mode !== 'todo' && asked.kind === 'todo') {
    return `kind "todo" belongs to to-do projects; ${where} is a board. Keep to-dos in their own project: POST /api/projects {"name":"…","mode":"todo"}`;
  }
  if (project.mode === 'todo' && (asked.kind === 'issue' || asked.kind === 'questions')) {
    return `${where} is a to-do project: it holds to-dos and documents, not decisions or QA. File those on a board project.`;
  }
  const dated = (asked.dueAt !== undefined && asked.dueAt !== null) || (asked.priority !== undefined && asked.priority !== null);
  if (dated && project.mode !== 'todo') {
    return `dueAt and priority belong to to-do projects; ${where} is a board, where the status says whose move it is. Put a deadline in the context, or keep to-dos in a project created with "mode":"todo".`;
  }
  if (dated && resultingKind !== 'todo') {
    return 'dueAt and priority belong to to-dos, not documents';
  }
  if (asked.status !== undefined && resultingKind === 'todo' && !TODO_STATUSES.includes(asked.status)) {
    return `a to-do holds ${TODO_STATUSES.join(', ')} — "${asked.status}" is a board status, for decisions and work waiting on someone`;
  }
  if (asked.status === 'todo' && resultingKind !== 'todo') {
    return `"todo" is a to-do status; ${where} is a board, where an item holds a whose-move status`;
  }
  return undefined;
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
  'GET    /api/projects[?archived=1][?repo=<remote-or-path>]  ordered by lastActivityAt DESC, each with color',
  'POST   /api/projects                        {name, slug?, description?, repos?, key?, mode?}   mode: board (default) | todo',
  'GET    /api/projects/<slug>[?status=a,b][?messages=all|last|none]',
  'PATCH  /api/projects/<slug>                 {archived?|name?|description?|sectionMode?|mode?|sections?|groupBy?|sortBy?|repos?|key?|color?}',
  'PATCH  /api/projects/<slug>/sections        {from,to,actor}',
  'GET    /api/projects/<slug>/labels          labels in use, with counts (also returned with the board)',
  'GET    /api/projects/<slug>/audit           live items out of spec with the current contract, each with the rule and the fix',
  'GET    /api/audit                           the same, for every project not archived',
  'PATCH  /api/projects/<slug>/labels          {from,to,actor}',
  'PATCH  /api/projects/<slug>/authors         {from,to,actor}',
  'POST   /api/projects/<slug>/items           item | [item, ...]   (item.clientId for idempotent retries)',
  'GET    /api/items/<id-or-ref> · PATCH /api/items/<id-or-ref> {..., actor, session, ifVersion}  (id accepts WB-<KEY>-<n> refs)',
  'GET    /api/items/<id-or-ref>/body',
  'GET    /api/items/<id-or-ref>/brief          text/markdown: the item written out for a second opinion from someone with no context; reads, never writes',
  'GET    /api/items/<id-or-ref>/messages · POST /api/items/<id-or-ref>/messages {who, text, actor, session, status?}',
  'PATCH  /api/items/<id-or-ref>/checks/<checkId>     {result, note?, actor, session}',
  'PATCH  /api/items/<id-or-ref>/questions/<qid>      {choice?, answer?, clear?, relay?, actor, session}  — kind "questions"; the person answers, an agent only with relay:true',
  'POST   /api/images                          raw image bytes | multipart "file" | {data: base64 or data: URL, alt?}  → {image: {url, markdown}}; PNG, JPEG, GIF, WebP, SVG, 10 MB',
  'GET    /api/images/<sha256>.<ext>           the image; reference it in Markdown as ![alt](/api/images/<sha256>.<ext>)',
  'every write: actor = the name a person recognises; session = the id this session generated once at start',
];

// Images (contract v22). Three ways in, because there are three kinds of
// sender: a browser posts the file's bytes as they are, a shell posts a
// multipart form (`curl -F file=@shot.png`), and an agent that can only write
// JSON sends base64. All three land in the same ImageStore.put, which decides
// the type from the bytes and refuses anything else. See src/images.ts.
async function readImageUpload(req: Request): Promise<{ bytes: Uint8Array; alt?: string; ignored: string[] }> {
  const type = (req.headers.get('content-type') || '').toLowerCase();
  if (type.startsWith('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new Error('multipart upload needs the image in a field named "file"');
    const alt = form.get('alt');
    return {
      bytes: new Uint8Array(await (file as Blob).arrayBuffer()),
      alt: typeof alt === 'string' && alt ? alt : (file as File).name?.replace(/\.[a-z0-9]+$/i, ''),
      ignored: [],
    };
  }
  if (type.startsWith('application/json') || type === '') {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be a JSON object');
    if (typeof body.data !== 'string' || !body.data) {
      throw new Error('send the image as {"data":"<base64>"} (a data: URL works too), as raw bytes with an image content-type, or as multipart field "file"');
    }
    const b64 = body.data.replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw new Error('data is not base64');
    const alt = typeof body.alt === 'string' ? body.alt : typeof body.name === 'string' ? body.name.replace(/\.[a-z0-9]+$/i, '') : undefined;
    return { bytes: new Uint8Array(Buffer.from(b64, 'base64')), alt, ignored: ignoredKeys(body, IMAGE_FIELDS) };
  }
  // Anything else is the file itself. The declared type is not trusted; the
  // bytes are sniffed in the store.
  return { bytes: new Uint8Array(await req.arrayBuffer()), alt: undefined, ignored: [] };
}

async function handleImages(opts: HandlerOptions, req: Request, parts: string[], method: string, ctx: Ctx): Promise<Response> {
  if (!opts.imagesDir) return notFound(ctx, 'this board has no image directory configured');
  const images = new ImageStore(opts.imagesDir);
  if (parts.length === 1) {
    if (method !== 'POST') return badRequest(ctx, `${method} not supported here; POST an image`);
    // Refuse on the declared length before buffering anything: the 10 MB cap
    // in put() only runs after the whole body is in memory.
    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_REQUEST_BYTES) return badRequest(ctx, imageTooLarge(declared));
    let upload;
    try {
      upload = await readImageUpload(req);
    } catch (error: any) {
      return badRequest(ctx, error?.message || 'could not read the upload');
    }
    const alt = new URL(req.url).searchParams.get('alt') ?? upload.alt;
    try {
      const image = images.put(upload.bytes, alt);
      // Only a new file changes anything worth exporting.
      if (!image.existed) ctx.wrote = true;
      return json(ctx, withIgnored({ ok: true, image }, upload.ignored), image.existed ? 200 : 201);
    } catch (error) {
      if (error instanceof ImageRefused) return badRequest(ctx, error.message);
      throw error;
    }
  }
  if (parts.length === 2 && (method === 'GET' || method === 'HEAD')) {
    const found = images.get(parts[1]);
    if (!found) return notFound(ctx, `no image "${parts[1]}"`);
    return new Response(method === 'HEAD' ? null : Bun.file(found.path), { headers: imageHeaders(found.type) });
  }
  // No delete, for the same reason items have none: the board is a record.
  if (method === 'DELETE') return json(ctx, { ok: false, error: 'images are never deleted: the board is a record, and a message that showed one must keep showing it.' }, 405);
  return badRequest(ctx, `${method} not supported here`);
}

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
      const checked = checkSettingsPatch(body, (slug) => Boolean(store.getProject(slug)));
      if (checked.error) return badRequest(ctx, checked.error);
      if (Object.keys(checked.patch).length) ctx.wrote = true;
      const settings = Object.keys(checked.patch).length ? store.setSettings(checked.patch) : store.getSettings();
      return json(ctx, withIgnored({ ok: true, settings }, checked.ignored));
    }
    return badRequest(ctx, `${method} not supported here`);
  }

  // What on the board is out of spec with the contract this server speaks.
  // Read-only: it names the rule and the fix, and the agent that owns each
  // project makes the change (AGENTS.md, "When the contract version moves").
  if (parts[0] === 'audit' && parts.length === 1 && method === 'GET') {
    const projects = store.listProjects(false).map((p) => ({ slug: p.slug, name: p.name, items: auditItems(store.listItems(p.id, 'none')) }));
    return json(ctx, { ok: true, contractVersion: CONTRACT_VERSION, total: projects.reduce((n, p) => n + p.items.length, 0), projects });
  }

  if (parts[0] === 'images') return handleImages(opts, req, parts, method, ctx);

  if (parts[0] === 'projects' && parts.length === 1) {
    if (method === 'GET') {
      // ?repo= resolves the project for the repository a session is standing
      // in, so it never has to read every board to find its own. One match or
      // none; the list shape is kept so callers parse one thing.
      const repo = url.searchParams.get('repo');
      if (repo !== null) {
        const match = store.resolveProject(repo, opts.home);
        return json(ctx, { ok: true, projects: match ? [{ ...match, counts: store.counts(match.id), qaCounts: store.qaCounts(match.id) }] : [], resolvedFrom: repo });
      }
      // GET /api/projects — everything the index needs in one call, counts
      // included, so the gallery never fans out one request per project.
      const includeArchived = url.searchParams.get('archived') === '1';
      const projects = store.listProjects(includeArchived).map((p) => ({ ...p, counts: store.counts(p.id), qaCounts: store.qaCounts(p.id) }));
      return json(ctx, { ok: true, projects });
    }
    if (method === 'POST') {
      const body = await readJson(req);
      if (typeof body.name !== 'string' || !body.name.trim()) return badRequest(ctx, 'name is required');
      if (body.key !== undefined && typeof body.key !== 'string') return badRequest(ctx, 'key must be a string');
      if (body.repos !== undefined && (!Array.isArray(body.repos) || body.repos.some((x: unknown) => typeof x !== 'string'))) {
        return badRequest(ctx, 'repos must be an array of strings');
      }
      if (body.mode !== undefined && !(PROJECT_MODES as readonly string[]).includes(body.mode)) {
        return badRequest(ctx, "mode must be 'board' or 'todo'");
      }
      ctx.wrote = true;
      const project = store.createProject({ name: body.name.trim(), slug: body.slug, description: body.description, repos: body.repos, key: body.key, mode: body.mode });
      // createProject is idempotent by slug. A repeat request must not rename
      // public references, so it returns the established project and tells the
      // caller which explicit route can make that intentional change.
      const requestedKey = typeof body.key === 'string' ? body.key.trim().toUpperCase() : undefined;
      const warning = requestedKey !== undefined && project.key !== requestedKey
        ? 'project already exists; key was not applied. Use PATCH /api/projects/<slug> to change it.'
        : undefined;
      return json(ctx, { ok: true, project, ...(warning ? { warning } : {}) }, 201);
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
        items = withoutQuestions(items);
        // `sections` and `labels` are returned so an agent can read the
        // vocabulary in the same call it reads the board, and reuse a name
        // instead of inventing a near-synonym. Deriving them by scanning items
        // is what agents skip.
        return json(ctx, {
          ok: true,
          project,
          items,
          counts: store.counts(project.id),
          qaCounts: store.qaCounts(project.id),
          sections: store.sectionsInUse(project),
          labels: store.labelsInUse(project.id),
        });
      }
      if (method === 'PATCH') {
        const body = await readJson(req);
        if (body.key !== undefined && typeof body.key !== 'string') {
          return badRequest(ctx, 'key cannot be removed; set a different key instead');
        }
        if (typeof body.archived === 'boolean' || body.key !== undefined || body.name !== undefined || body.description !== undefined || body.sectionMode !== undefined || body.mode !== undefined || body.sections !== undefined || body.groupBy !== undefined || body.sortBy !== undefined || body.repos !== undefined || body.color !== undefined) {
          if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
            return badRequest(ctx, 'name must be a non-empty string');
          }
          if (body.description !== undefined && typeof body.description !== 'string') {
            return badRequest(ctx, 'description must be a string');
          }
          if (body.sectionMode !== undefined && !['adhoc', 'declared'].includes(body.sectionMode)) {
            return badRequest(ctx, "sectionMode must be 'adhoc' or 'declared'");
          }
          if (body.sections !== undefined && (!Array.isArray(body.sections) || body.sections.some((x: unknown) => typeof x !== 'string'))) {
            return badRequest(ctx, 'sections must be an array of strings');
          }
          if (body.groupBy !== undefined && !['section', 'status', 'move', 'due', 'priority'].includes(body.groupBy)) {
            return badRequest(ctx, "groupBy must be 'section', 'status', 'move', 'due' or 'priority'");
          }
          if (body.sortBy !== undefined && !['activity', 'ref', 'due', 'priority'].includes(body.sortBy)) {
            return badRequest(ctx, "sortBy must be 'activity', 'ref', 'due' or 'priority'");
          }
          if (body.mode !== undefined && !(PROJECT_MODES as readonly string[]).includes(body.mode)) {
            return badRequest(ctx, "mode must be 'board' or 'todo'");
          }
          // Due and priority layouts order to-dos by their dates; a board has
          // none, so they are refused there rather than showing one big group.
          const modeAfter = body.mode ?? project.mode;
          const planLayout = ['due', 'priority'];
          if (modeAfter !== 'todo' && (planLayout.includes(body.groupBy) || planLayout.includes(body.sortBy))) {
            return badRequest(ctx, `groupBy and sortBy "due" and "priority" belong to to-do projects; "${project.slug}" is a board`);
          }
          if (body.repos !== undefined && (!Array.isArray(body.repos) || body.repos.some((x: unknown) => typeof x !== 'string'))) {
            return badRequest(ctx, 'repos must be an array of strings');
          }
          if (body.color !== undefined && !(PROJECT_COLORS as readonly string[]).includes(body.color)) {
            return badRequest(ctx, `color must be one of: ${PROJECT_COLORS.join(', ')}`);
          }
          // All or nothing: every write below runs in one transaction, so a
          // refusal anywhere (the mode once the project holds work, a key
          // another project holds) leaves the whole request unapplied. Review
          // found the mode switching and then surviving a refused key.
          ctx.wrote = true;
          const outcome = store.atomically(() => {
            let updated = project;
            if (body.mode !== undefined && body.mode !== project.mode) {
              // Refused once the project holds work; see Store.setProjectMode
              // for why it never converts items.
              const switched = store.setProjectMode(project.slug, body.mode);
              if (switched.blocking) return { blocking: switched.blocking };
              updated = switched.project!;
            }
            let warning: string | undefined;
            if (typeof body.key === 'string') {
              const changed = store.setProjectKey(updated.slug, body.key)!;
              updated = changed.project;
              if (changed.changed && changed.previousKey) {
                warning = `refs quoted as WB-${changed.previousKey}-<n> keep resolving here, but this project now displays WB-${updated.key}-<n>`;
              }
            }
            if (typeof body.archived === 'boolean') updated = store.archiveProject(updated.slug, body.archived)!;
            if (body.name !== undefined || body.description !== undefined || body.sectionMode !== undefined || body.sections !== undefined || body.groupBy !== undefined || body.sortBy !== undefined || body.repos !== undefined || body.color !== undefined) {
              updated = store.setProjectSections(updated.slug, body)!;
            }
            return { updated, warning };
          });
          if ('blocking' in outcome) {
            return json(ctx, {
              ok: false,
              conflict: 'mode',
              error: `"${project.slug}" holds ${outcome.blocking} ${project.mode === 'todo' ? 'to-do(s)' : 'decision(s) or work item(s)'}, so its mode cannot change: items are never converted between a board and a to-do list. Create a new project with the mode you want.`,
            }, 409);
          }
          const { updated, warning } = outcome;
          return json(ctx, { ok: true, project: updated, sections: store.sectionsInUse(updated), labels: store.labelsInUse(updated.id), ...(warning ? { warning } : {}) });
        }
        return badRequest(ctx, 'nothing to update; supported: archived, key, name, description, sectionMode, mode, sections, groupBy, sortBy, repos, color');
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

    if (parts[2] === 'audit' && parts.length === 3 && method === 'GET') {
      const items = auditItems(store.listItems(project.id, 'none'));
      return json(ctx, { ok: true, contractVersion: CONTRACT_VERSION, total: items.length, items });
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
      if (method === 'GET') return json(ctx, { ok: true, items: withoutQuestions(store.listItems(project.id)) });
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
        const archivedWarn = archivedProjectWarning(project);
        if (archivedWarn) warnings.push(archivedWarn);
        for (const input of parsed) {
          const named = (text: string) => (parsed.length > 1 ? `"${input.title}": ${text}` : text);
          const misplaced = todoPolicy(project, kindFor(project.mode, input.kind), input);
          if (misplaced) return badRequest(ctx, named(misplaced));
          const shape = questionSetRefusal(kindFor(project.mode, input.kind), input);
          if (shape) return badRequest(ctx, named(shape));
          // A retry of something already filed returns the existing item
          // untouched, so the rule is not applied to it a second time.
          if (!store.hasClientId(project.id, input.clientId)) {
            const kind: Kind = kindFor(project.mode, input.kind);
            const converted = convertRecommendedSuffix(input);
            if (converted) warnings.push(named(converted));
            const refusal = recommendationRefusal(input.options || [], input.recommended);
            if (refusal) return badRequest(ctx, named(refusal));
            const status = input.status && isStatusAllowed(kind, input.status) ? input.status : defaultStatusFor(kind);
            if (lacksRecommendation({ kind, status, options: input.options || [], recommended: input.recommended })) {
              warnings.push(named(MISSING_RECOMMENDATION));
            }
          }
          const { warning } = sectionPolicy(store, project, input.section);
          if (warning) warnings.push(warning);
          warnings.push(...labelPolicy(store, project, input.labels));
          const textWarn = recommendedInTextWarning(input.options);
          if (textWarn) warnings.push(textWarn);
        }
        ctx.wrote = true;
        const created = parsed.map((input) => store.createItem(project.id, input));
        for (const item of created) {
          const warning = blockedWithoutReason(item);
          if (warning) warnings.push(warning);
          const titleWarn = titleWarning(item);
          if (titleWarn) warnings.push(titleWarn);
          const ownerWarn = unownedStepsWarning(item);
          if (ownerWarn) warnings.push(parsed.length > 1 ? `"${item.title}": ${ownerWarn}` : ownerWarn);
          // Only when the caller asked for a decision by name: an issue filed
          // with no status also lands at needs-decision, and warning on every
          // one of those would teach callers to ignore warnings.
          const askedForDecision = parsed[created.indexOf(item)]?.status === 'needs-decision';
          const optionsWarn = askedForDecision ? noOptionsWarning(item) : undefined;
          if (optionsWarn) warnings.push(parsed.length > 1 ? `"${item.title}": ${optionsWarn}` : optionsWarn);
          for (const w of questionSetWarnings(item, true)) warnings.push(parsed.length > 1 ? `"${item.title}": ${w}` : w);
          for (const w of [wallOfTextWarning('context', item.context), escapedNewlineWarning('context', item.context), pointerOptionWarning(item.options, item.context, item.body)]) {
            if (w) warnings.push(parsed.length > 1 ? `"${item.title}": ${w}` : w);
          }
        }
        return json(ctx, withIgnored({ ok: true, items: created, ...(warnings.length ? { warnings } : {}) }, ignored), 201);
      }
      return badRequest(ctx, `${method} not supported here`);
    }
  }

  if (parts[0] === 'items' && parts.length >= 2) {
    const item = store.resolveItem(decodeURIComponent(parts[1]));
    if (!item) return notFound(ctx, `no item with id "${parts[1]}"`);
    // One lookup, shared by every route below that needs the owning project —
    // for section/label policy on a PATCH, and for the archived-project
    // warning on every write path an item has (PATCH, a message, a check).
    const owner = store.getProjectById(item.projectId);

    if (parts.length === 2) {
      if (method === 'GET') return json(ctx, { ok: true, item });
      if (method === 'PATCH') {
        const body = await readJson(req);
        const patch = asItemInput(body, false);
        const ignored = ignoredKeys(body, ITEM_FIELDS);
        if (typeof body.position === 'number') (patch as any).position = body.position;
        const warnings: string[] = [];
        const archivedWarn = archivedProjectWarning(owner);
        if (archivedWarn) warnings.push(archivedWarn);
        if (owner && (patch.section !== undefined || patch.labels !== undefined)) {
          if (patch.section !== undefined) {
            const { warning } = sectionPolicy(store, owner, patch.section);
            if (warning) warnings.push(warning);
          }
          // Labels already on this item are "in use" by it, so exclude them:
          // re-saving the same set must not warn about itself.
          const added = (patch.labels || []).filter((l) => !item.labels.some((x) => x.toLowerCase() === String(l).toLowerCase()));
          warnings.push(...labelPolicy(store, owner, added));
        }
        // Same arithmetic as the store's updateItem: where the item lands.
        const kind: Kind = patch.kind === undefined ? item.kind : kindFor(owner?.mode ?? 'board', patch.kind);
        if (owner) {
          const misplaced = todoPolicy(owner, kind, patch);
          if (misplaced) return badRequest(ctx, misplaced);
        }
        const wanted = patch.status ?? item.status;
        const landsAt = isStatusAllowed(kind, wanted) ? wanted : defaultStatusFor(kind);
        // A document turned into an issue lands at needs-decision without
        // naming the status, so it counts as a move in.
        const movesIntoDecision = landsAt === 'needs-decision' && (item.status !== 'needs-decision' || kind !== item.kind);
        if (patch.options !== undefined || patch.recommended !== undefined || movesIntoDecision) {
          const converted = patch.options !== undefined ? convertRecommendedSuffix(patch, item.choice) : undefined;
          if (converted) warnings.push(converted);
          const options = patch.options ?? item.options;
          const refusal = recommendationRefusal(options, patch.recommended);
          if (refusal) return badRequest(ctx, refusal);
          // Sent → checked as sent; not sent → what the store will keep.
          const recommended = patch.recommended ?? normaliseRecommended(item.recommended, options);
          if (lacksRecommendation({ kind, status: landsAt, options, recommended })) warnings.push(MISSING_RECOMMENDATION);
          const textWarn = recommendedInTextWarning(patch.options);
          if (textWarn) warnings.push(textWarn);
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
          const storeWarnings: string[] = [];
          const updated = store.updateItem(item.id, patch, {
            ifVersion, actor: actorOr(ctx, body, 'author'), session: sessionOf(body),
            replaceChecks: body.replaceChecks === true,
            replaceQuestions: body.replaceQuestions === true,
            warnings: storeWarnings,
          });
          warnings.push(...storeWarnings);
          if (updated && (patch.questions !== undefined || movesIntoDecision || patch.kind !== undefined)) {
            warnings.push(...questionSetWarnings(updated, patch.questions !== undefined));
          }
          const blockedWarning = updated ? blockedWithoutReason(updated) : undefined;
          if (blockedWarning) warnings.push(blockedWarning);
          const titleWarn = updated ? titleWarning(updated) : undefined;
          if (titleWarn) warnings.push(titleWarn);
          const ownerWarn = updated && (patch.checks !== undefined || patch.status !== undefined) ? unownedStepsWarning(updated) : undefined;
          if (ownerWarn) warnings.push(ownerWarn);
          const optionsWarn = updated && (movesIntoDecision || patch.options !== undefined) ? noOptionsWarning(updated) : undefined;
          if (optionsWarn) warnings.push(optionsWarn);
          if (updated) {
            const sent: (string | undefined)[] = [];
            if (patch.context !== undefined) sent.push(wallOfTextWarning('context', updated.context), escapedNewlineWarning('context', updated.context));
            if (patch.options !== undefined) sent.push(pointerOptionWarning(updated.options, updated.context, updated.body));
            for (const w of sent) if (w) warnings.push(w);
          }
          return json(ctx, withIgnored({ ok: true, item: updated, ...(warnings.length ? { warning: warnings.join(' | ') } : {}) }, ignored));
        } catch (error) {
          if (error instanceof VersionConflict) {
            // 409 with the live item attached, so the caller merges onto what is
            // actually there instead of re-reading and racing the same way again.
            return json(ctx, { ok: false, error: error.message, conflict: true, item: error.current }, 409);
          }
          if (error instanceof QuestionsLocked) {
            return json(ctx, { ok: false, error: error.message, conflict: 'questions', answeredIds: error.answeredIds, item: error.current }, 409);
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

    // The second-opinion brief: the item as self-contained Markdown, for the
    // person to paste to another model or a colleague. The page's button
    // fetches this same route, so an agent and a person get identical text.
    // Read-only, and served as text rather than JSON because its one use is
    // being copied whole. See src/brief.ts for what it leaves out and why.
    if (parts[2] === 'brief' && parts.length === 3) {
      if (method !== 'GET') return badRequest(ctx, `${method} not supported here; the brief is read-only`);
      if (!owner) return notFound(ctx, `item "${parts[1]}" has no project`);
      return new Response(itemBrief(item, owner), {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'cache-control': 'no-store',
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
      if (body.owner !== undefined && !CHECK_OWNERS.includes(body.owner)) {
        return badRequest(ctx, 'owner must be human or agent');
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
          owner: body.owner,
        });
        const archivedWarn = archivedProjectWarning(owner);
        return json(ctx, withIgnored({ ok: true, item: updated, ...(archivedWarn ? { warning: archivedWarn } : {}) }, ignoredKeys(body, CHECK_FIELDS)));
      } catch (error: any) {
        if (error?.statusCode === 400) return badRequest(ctx, error.message);
        throw error;
      }
    }

    // One question of a question set, answered on its own. A whole-array PATCH
    // would lose a concurrent answer to a different question, and the answer is
    // the person's: an agent may record one only as a relay (relay:true), which
    // the item then says it was.
    if (parts[2] === 'questions') {
      if (method !== 'PATCH') return json(ctx, { ok: false, error: 'questions are recorded one at a time with PATCH /api/items/<id>/questions/<qid>' }, 405);
      if (parts.length !== 4) return badRequest(ctx, 'name the question: PATCH /api/items/<id>/questions/<qid>');
      const body = await readJson(req);
      for (const field of ['choice', 'answer'] as const) {
        if (body[field] !== undefined && typeof body[field] !== 'string') return badRequest(ctx, `${field} must be a string`);
      }
      for (const field of ['clear', 'relay'] as const) {
        if (body[field] !== undefined && typeof body[field] !== 'boolean') return badRequest(ctx, `${field} must be true or false`);
      }
      try {
        ctx.wrote = true;
        const updated = store.answerQuestion(item.id, decodeURIComponent(parts[3]), {
          choice: body.choice, answer: body.answer, clear: body.clear === true, relay: body.relay === true,
          by: actorOf(body, 'by') ?? 'you', session: sessionOf(body),
        });
        const archivedWarn = archivedProjectWarning(owner);
        return json(ctx, withIgnored({ ok: true, item: updated, ...(archivedWarn ? { warning: archivedWarn } : {}) }, ignoredKeys(body, ANSWER_FIELDS)));
      } catch (error: any) {
        if (error?.statusCode === 404) return notFound(ctx, error.message);
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
        // A message cannot carry a recommendation, so the action it names is
        // the PATCH that can.
        const reopensWithout = status === 'needs-decision' && item.status !== 'needs-decision'
          && lacksRecommendation({ kind: item.kind, status, options: item.options, recommended: item.recommended });
        ctx.wrote = true;
        const message = store.addMessage(item.id, {
          who,
          text: body.text.trim(),
          author: actorOf(body, 'author'),
          session: sessionOf(body),
          status,
        });
        const after = store.getItem(item.id)!;
        // Only an agent is held to the format: a person types the way they type.
        const formatWarnings = who === 'agent' ? [wallOfTextWarning('message', body.text), escapedNewlineWarning('message', body.text)] : [];
        const warnings = [
          finishedWithoutStatus(who, body.text, status, after.status),
          ...formatWarnings,
          archivedProjectWarning(owner),
          reopensWithout ? `this decision has options and no recommended — PATCH /api/items/${item.id} {"recommended":["<one of the options>"]}` : undefined,
          // The message lands (it never conflicts), but a status this kind of
          // item cannot hold is not applied. Said rather than dropped, naming
          // the set it can hold, the same set PATCH refuses with a 400.
          status !== undefined && !isStatusAllowed(item.kind, status)
            ? `the message landed but "${status}" was not applied: a ${item.kind === 'todo' ? 'to-do' : item.kind} holds ${statusesFor(item.kind).join(', ')}, so it stays "${after.status}"`
            : undefined,
        ].filter(Boolean) as string[];
        return json(ctx, withIgnored({ ok: true, message, item: after, ...(warnings.length ? { warning: warnings.join(' | ') } : {}) }, ignoredKeys(body, MESSAGE_FIELDS)), 201);
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
        if (error?.statusCode === 409) {
          return json(ctx, { ok: false, error: error.message || 'request conflict', conflict: 'key', project: error.conflictingSlug }, 409);
        }
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
    // The board's group tables, built from the server's own, so the page never
    // keeps a second copy to forget to update.
    if (url.pathname === '/groups.js') {
      return new Response(`window.WB_GROUPS = ${JSON.stringify({ status: STATUS_GROUPS, move: MOVE_GROUPS })};\n`, {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      });
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
