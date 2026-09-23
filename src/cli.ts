// Export and import, which is what keeps the code repository and the content
// repository separate.
//
// The database is a binary file: useful to run against, useless in git, because
// a diff tells you nothing and two people's changes cannot be merged. Export
// writes one readable JSON file per project instead, so your own work can live
// in its own repository with a real history — who decided what, and when —
// while the app repository stays free of anybody's content and can be handed to
// a colleague as-is. The export itself lives in export.ts, shared with the
// server's automatic backup so the two can never write different shapes.
import { openDb, Store } from './db.ts';
import { exportAll, importAll } from './export.ts';
import { homedir } from 'os';
import { join } from 'path';

const DB_PATH = process.env.WORKBENCH_DB || join(homedir(), '.workbench', 'workbench.db');
const store = new Store(openDb(DB_PATH));

const [, , command, ...rest] = process.argv;
const dir = rest[0] || process.env.WORKBENCH_CONTENT || join(homedir(), 'workbench-content');

if (command === 'export') {
  const result = exportAll(store, dir);
  for (const file of result.files) console.log(`exported  ${file}`);
  console.log(`\n${result.items} items in ${result.projects} project(s) -> ${dir}`);
} else if (command === 'import') {
  try {
    importAll(store, dir);
  } catch (error: any) {
    console.error(error?.message || error);
    process.exit(1);
  }
}
else {
  console.log(`workbench content tool

  bun run export [dir]   write every project to <dir> as JSON  (default: ${dir})
  bun run import [dir]   read every *.json in <dir> back in

The database itself stays at ${DB_PATH} (override with WORKBENCH_DB).
Point <dir> at a git repository to keep your own content versioned separately
from this application's code. The running server exports there on its own after
every change (WORKBENCH_AUTO_EXPORT=0 turns that off).`);
}
