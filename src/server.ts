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
import { openDb, Store, STATUSES, VersionConflict, type Status, type ItemInput } from './db.ts';
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
  return {
    title: typeof body.title === 'string' ? body.title.trim() : undefined!,
    context: typeof body.context === 'string' ? body.context : undefined,
    options: body.options,
    choice: typeof body.choice === 'string' ? body.choice : undefined,
    status: asStatus(body.status),
    section: typeof body.section === 'string' ? body.section : undefined,
  };
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
        return json({ ok: true, project, items: store.listItems(project.id), counts: store.counts(project.id) });
      }
      if (method === 'PATCH') {
        const body = await readJson(req);
        if (typeof body.archived === 'boolean') {
          return json({ ok: true, project: store.archiveProject(project.slug, body.archived) });
        }
        return badRequest('nothing to update; supported: archived');
      }
      return badRequest(`${method} not supported here`);
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
        const created = inputs.map((input) => store.createItem(project.id, asItemInput(input, true)));
        return json({ ok: true, items: created }, 201);
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
        try {
          const updated = store.updateItem(item.id, patch, {
            ifVersion: typeof body.ifVersion === 'number' ? body.ifVersion : undefined,
            actor: typeof body.actor === 'string' ? body.actor : undefined,
          });
          return json({ ok: true, item: updated });
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

    if (url.pathname.startsWith('/api')) {
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
    // Any /p/<slug> renders the same shell; the slug is read client-side.
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
