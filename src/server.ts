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
//
// The routes live in `app.ts`; this file only decides where the database is,
// which port to listen on, and starts listening. Keeping the process concerns
// here and the handler there is what lets the API be tested without a port.
import { openDb, Store } from './db.ts';
import { createHandler } from './app.ts';
import { homedir } from 'os';
import { join } from 'path';

const DB_PATH = process.env.WORKBENCH_DB || join(homedir(), '.workbench', 'workbench.db');
const PORT = Number(process.env.WORKBENCH_PORT || 4317);
const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;
const AGENTS_MD = new URL('../AGENTS.md', import.meta.url).pathname;

const store = new Store(openDb(DB_PATH));

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch: createHandler(store, { publicDir: PUBLIC_DIR, agentsMdPath: AGENTS_MD }),
});

console.log(`workbench  http://localhost:${server.port}`);
console.log(`database   ${DB_PATH}`);
console.log(`api        http://localhost:${server.port}/api/projects`);
