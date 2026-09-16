// The workbench server: one bun process, one SQLite file, two audiences.
//
// A human opens it in a browser to see what is waiting on them and answer in
// place. An agent talks to the same data over JSON, so a decision asked for in
// one session is still answerable in the next one and still readable by a
// different agent entirely. That second audience is the point — the pattern this
// replaces cost a full re-read of a large page before any edit could be made.
//
// Deliberately local-only: it binds to 127.0.0.1 and has no authentication,
// because adding accounts to a single-user tool on a laptop buys nothing and
// costs a login. Do not expose this port.
import {
  openDb, Store, STATUSES, VersionConflict, findSimilarSection,
  type Status, type ItemInput, type Project,
} from './db.ts';
import { homedir } from 'os';
import { join } from 'path';

const DB_PATH = process.env.WORKBENCH_DB || join(homedir(), '.workbench', 'workbench.db');
const PORT = Number(process.env.WORKBENCH_PORT || 4317);
const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;

const store = new Store(openDb(DB_PATH));

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function badRequest(message: string): Response {
  return json({ ok: false, error: message }, 400);
}

function notFound(message = 'not found'): Response {
  return json({ ok: false, error: message }, 404);
}

function asStatus(value: unknown, field = 'status'): Status | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !STATUSES.includes(value as Status)) {
    throw new Error(`${field} must be one of: ${STATUSES.join(', ')}`);
  }
  return value as Status;
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
  return {
    title: typeof body.title === 'string' ? body.title.trim() : undefined!,
    context: typeof body.context === 'string' ? body.context : undefined,
    options: body.options,
    choice: typeof body.choice === 'string' ? body.choice : undefined,
    status: asStatus(body.status),
    section: typeof body.section === 'string' ? body.section : undefined,
    // These were added to the store and forgotten here, so every document
    // imported as an empty one and the API cheerfully reported success. A
    // field the store accepts and the parser drops is a silent data loss, and
    // the only thing that catches it is checking what landed rather than what
    // the response said.
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

async function readJson(req: Request): Promise<any> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('body is not valid JSON');
  }
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method.toUpperCase();

  // GET /api/projects — everything the index needs in one call, counts included,
  // so the gallery never fans out one request per project.
  // Settings: what the human has already been asked and answered. An agent
  // reads this FIRST in a session so it neither re-asks nor assumes.
  if (parts[0] === 'settings' && parts.length === 1) {
    if (method === 'GET') return json({ ok: true, settings: store.getSettings() });
    if (method === 'PATCH') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('body must be a JSON object');
      return json({ ok: true, settings: store.setSettings(body) });
    }
    return badRequest(`${method} not supported here`);
  }

  if (parts[0] === 'projects' && parts.length === 1) {
    if (method === 'GET') {
      const includeArchived = url.searchParams.get('archived') === '1';
      const projects = store.listProjects(includeArchived).map((p) => ({ ...p, counts: store.counts(p.id) }));
      return json({ ok: true, projects });
    }
    if (method === 'POST') {
      const body = await readJson(req);
      if (typeof body.name !== 'string' || !body.name.trim()) return badRequest('name is required');
      const project = store.createProject({ name: body.name.trim(), slug: body.slug, description: body.description });
      return json({ ok: true, project }, 201);
    }
    return badRequest(`${method} not supported here`);
  }

  if (parts[0] === 'projects' && parts.length >= 2) {
    const project = store.getProject(parts[1]);
    if (!project) return notFound(`no project with slug "${parts[1]}"`);

    if (parts.length === 2) {
      if (method === 'GET') {
        // `sections` is returned so an agent can read the vocabulary in the same
        // call it reads the board, and reuse a name instead of inventing a
        // near-synonym. Deriving it by scanning items is what agents skip.
        return json({
          ok: true,
          project,
          items: store.listItems(project.id),
          counts: store.counts(project.id),
          sections: store.sectionsInUse(project),
        });
      }
      if (method === 'PATCH') {
        const body = await readJson(req);
        if (typeof body.archived === 'boolean') {
          return json({ ok: true, project: store.archiveProject(project.slug, body.archived) });
        }
        if (body.sectionMode !== undefined || body.sections !== undefined) {
          if (body.sectionMode !== undefined && !['adhoc', 'declared'].includes(body.sectionMode)) {
            return badRequest("sectionMode must be 'adhoc' or 'declared'");
          }
          if (body.sections !== undefined && (!Array.isArray(body.sections) || body.sections.some((x: unknown) => typeof x !== 'string'))) {
            return badRequest('sections must be an array of strings');
          }
          const updated = store.setProjectSections(project.slug, body)!;
          return json({ ok: true, project: updated, sections: store.sectionsInUse(updated) });
        }
        return badRequest('nothing to update; supported: archived, sectionMode, sections');
      }
      return badRequest(`${method} not supported here`);
    }

    // Rename or merge a section across the whole project. The repair tool —
    // without one, a vocabulary can only ever get worse.
    if (parts[2] === 'sections' && parts.length === 3 && method === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.from !== 'string' || !body.from || typeof body.to !== 'string') {
        return badRequest('from (non-empty string) and to (string) are required');
      }
      const moved = store.renameSection(project.id, body.from, body.to, typeof body.actor === 'string' ? body.actor : '');
      const after = store.getProject(project.slug)!;
      // Keep the declared list honest with what just happened.
      if (after.sections.includes(body.from)) {
        const next = after.sections.filter((s) => s !== body.from);
        if (body.to && !next.includes(body.to)) next.push(body.to);
        store.setProjectSections(after.slug, { sections: next });
      }
      const fresh = store.getProject(project.slug)!;
      return json({ ok: true, moved, sections: store.sectionsInUse(fresh) });
    }

    if (parts[2] === 'items' && parts.length === 3) {
      if (method === 'GET') return json({ ok: true, items: store.listItems(project.id) });
      if (method === 'POST') {
        const body = await readJson(req);
        // An array creates a whole set in one call. This is the shape an agent
        // wants at the start of a piece of work — "here are the nine things I
        // need decided" — and doing it one request at a time is how half-built
        // lists happen when something fails in the middle.
        const inputs = Array.isArray(body) ? body : [body];
        const parsed = inputs.map((input) => asItemInput(input, true));
        // Policy first, for every item, so a batch either lands whole or is
        // refused whole — half a set is worse than none.
        const warnings: string[] = [];
        for (const input of parsed) {
          const { warning } = sectionPolicy(store, project, input.section);
          if (warning) warnings.push(warning);
        }
        const created = parsed.map((input) => store.createItem(project.id, input));
        return json({ ok: true, items: created, ...(warnings.length ? { warnings } : {}) }, 201);
      }
      return badRequest(`${method} not supported here`);
    }
  }

  if (parts[0] === 'items' && parts.length >= 2) {
    const item = store.getItem(parts[1]);
    if (!item) return notFound(`no item with id "${parts[1]}"`);

    if (parts.length === 2) {
      if (method === 'GET') return json({ ok: true, item });
      if (method === 'PATCH') {
        const body = await readJson(req);
        const patch = asItemInput(body, false);
        if (typeof body.position === 'number') (patch as any).position = body.position;
        let sectionWarning: string | undefined;
        if (patch.section !== undefined) {
          const owner = store.listProjects(true).find((p) => p.id === item.projectId);
          if (owner) sectionWarning = sectionPolicy(store, owner, patch.section).warning;
        }
        try {
          const updated = store.updateItem(item.id, patch, {
            ifVersion: typeof body.ifVersion === 'number' ? body.ifVersion : undefined,
            actor: typeof body.actor === 'string' ? body.actor : undefined,
          });
          return json({ ok: true, item: updated, ...(sectionWarning ? { warning: sectionWarning } : {}) });
        } catch (error) {
          if (error instanceof VersionConflict) {
            // 409 with the live item attached, so the caller merges onto what is
            // actually there instead of re-reading and racing the same way again.
            return json({ ok: false, error: error.message, conflict: true, item: error.current }, 409);
          }
          throw error;
        }
      }
      if (method === 'DELETE') return json({ ok: store.deleteItem(item.id) });
      return badRequest(`${method} not supported here`);
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
        return badRequest("result must be '', pass, fail or skip");
      }
      try {
        const updated = store.setCheck(item.id, parts[3], {
          result: body.result,
          note: typeof body.note === 'string' ? body.note : undefined,
          by: typeof body.by === 'string' ? body.by : 'you',
        });
        return json({ ok: true, item: updated });
      } catch (error: any) {
        if (error?.statusCode === 400) return badRequest(error.message);
        throw error;
      }
    }

    if (parts[2] === 'messages') {
      if (method === 'GET') return json({ ok: true, messages: store.listMessages(item.id) });
      if (method === 'POST') {
        const body = await readJson(req);
        if (typeof body.text !== 'string' || !body.text.trim()) return badRequest('text is required');
        const who = body.who === 'you' ? 'you' : 'agent';
        const message = store.addMessage(item.id, {
          who,
          text: body.text.trim(),
          author: typeof body.author === 'string' ? body.author : undefined,
          status: asStatus(body.status),
        });
        return json({ ok: true, message, item: store.getItem(item.id) }, 201);
      }
      return badRequest(`${method} not supported here`);
    }
  }

  return notFound(`no API route for ${method} ${url.pathname}`);
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);

    // `/api/` with the slash: every API route has one, and a bare prefix test
    // swallowed `/api-doc` into the API router, which then 404'd it.
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(req, url);
      } catch (error: any) {
        // Every thrown validation message is written to be read by whoever sent
        // the request, which is usually an agent deciding what to do next.
        return badRequest(error?.message || 'request failed');
      }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(Bun.file(join(PUBLIC_DIR, 'index.html')));
    }
    // The contract is one file, AGENTS.md, and this renders that same file
    // rather than a copy of it — a second copy is a second thing to forget to
    // update, and the footer link pointed at a page that did not exist at all.
    if (url.pathname === '/agents.html') {
      return new Response(Bun.file(join(PUBLIC_DIR, 'agents.html')));
    }
    if (url.pathname === '/api-doc') {
      const md = Bun.file(new URL('../AGENTS.md', import.meta.url).pathname);
      return new Response(md, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    // /p/<slug>/i/<id> is one item on its own page; /p/<slug> is the list. Both
    // read their identifiers client-side from the path.
    if (/^\/p\/[^/]+\/i\/[^/]+\/?$/.test(url.pathname)) {
      return new Response(Bun.file(join(PUBLIC_DIR, 'item.html')));
    }
    if (url.pathname.startsWith('/p/')) {
      return new Response(Bun.file(join(PUBLIC_DIR, 'project.html')));
    }
    const asset = Bun.file(join(PUBLIC_DIR, url.pathname.replace(/^\/+/, '')));
    if (await asset.exists()) return new Response(asset);
    return new Response('Not found', { status: 404 });
  },
});

console.log(`workbench  http://localhost:${server.port}`);
console.log(`database   ${DB_PATH}`);
console.log(`api        http://localhost:${server.port}/api/projects`);
