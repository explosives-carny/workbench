// Export and import, which is what keeps the code repository and the content
// repository separate.
//
// The database is a binary file: useful to run against, useless in git, because
// a diff tells you nothing and two people's changes cannot be merged. Export
// writes one readable JSON file per project instead, so your own work can live
// in its own repository with a real history — who decided what, and when —
// while the app repository stays free of anybody's content and can be handed to
// a colleague as-is.
import { openDb, Store, type Item } from './db.ts';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';

const DB_PATH = process.env.WORKBENCH_DB || join(homedir(), '.workbench', 'workbench.db');
const store = new Store(openDb(DB_PATH));

const [, , command, ...rest] = process.argv;
const dir = rest[0] || process.env.WORKBENCH_CONTENT || join(homedir(), 'workbench-content');

function exportAll(): void {
  mkdirSync(dir, { recursive: true });
  const projects = store.listProjects(true);
  for (const project of projects) {
    const items = store.listItems(project.id).map((item: Item) => ({
      ...item,
      // projectId is an internal identifier and means nothing outside this
      // database; the file is keyed by the project's slug instead, so an import
      // into a fresh machine does not depend on ids matching.
      projectId: undefined,
      messages: item.messages || [],
    }));
    const file = join(dir, `${project.slug}.json`);
    writeFileSync(file, JSON.stringify({ project: { ...project, id: undefined }, items }, null, 2) + '\n');
    console.log(`exported ${items.length} items  ${file}`);
  }
  console.log(`\n${projects.length} project(s) -> ${dir}`);
}

function importAll(): void {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    console.error(`No such directory: ${dir}`);
    process.exit(1);
  }
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (!raw?.project?.name) {
      console.error(`skipped ${file}: no project.name`);
      continue;
    }
    // createProject is idempotent by slug, so re-importing updates nothing it
    // should not and never produces a second copy of the same project.
    const project = store.createProject({
      name: raw.project.name,
      slug: raw.project.slug,
      description: raw.project.description,
    });
    const existing = new Set(store.listItems(project.id, false).map((i) => i.title));
    let added = 0;
    for (const item of raw.items || []) {
      // Matched on title rather than id: ids are regenerated on import, and the
      // alternative — duplicating every item on a second import — is worse than
      // occasionally skipping a genuine retitled duplicate.
      if (existing.has(item.title)) continue;
      const created = store.createItem(project.id, {
        title: item.title,
        context: item.context,
        options: item.options,
        choice: item.choice,
        status: item.status,
        section: item.section,
      });
      for (const message of item.messages || []) {
        store.addMessage(created.id, {
          who: message.who === 'you' ? 'you' : 'agent',
          text: message.text,
          author: message.author,
          status: item.status,
        });
      }
      added += 1;
    }
    console.log(`imported ${added} new item(s) into "${project.name}"`);
  }
}

if (command === 'export') exportAll();
else if (command === 'import') importAll();
else {
  console.log(`workbench content tool

  bun run export [dir]   write every project to <dir> as JSON  (default: ${dir})
  bun run import [dir]   read every *.json in <dir> back in

The database itself stays at ${DB_PATH} (override with WORKBENCH_DB).
Point <dir> at a git repository to keep your own content versioned separately
from this application's code.`);
}
