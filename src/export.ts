// Export: one readable JSON file per project, so your own content lives in its
// own repository with a real history while the app repository stays free of
// anybody's decisions. Shared by the `bun run export` command and by the
// server's automatic export, so the two can never write different shapes.
import { ProjectKeyTaken, Store, type Item } from './db.ts';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export function exportAll(store: Store, dir: string): { projects: number; items: number; files: string[] } {
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  let total = 0;
  for (const project of store.listProjects(true)) {
    // getItem per row, not listItems: the list deliberately strips `body` so a
    // 150KB document does not ride along in every poll — and an export that
    // inherited that would write a content repository in which every document
    // is empty, silently. Caught by comparing the exported size against what
    // the board reported holding.
    const items = store
      .listItems(project.id, 'none')
      .map((row) => store.getItem(row.id)!)
      .map((item: Item) => ({
        ...item,
        // projectId is an internal identifier and means nothing outside this
        // database; the file is keyed by the project's slug instead, so an import
        // into a fresh machine does not depend on ids matching.
        projectId: undefined,
        messageCount: undefined,
        messages: item.messages || [],
      }));
    const file = join(dir, `${project.slug}.json`);
    writeFileSync(file, JSON.stringify({ project: { ...project, id: undefined }, items }, null, 2) + '\n');
    files.push(file);
    total += items.length;
  }
  return { projects: files.length, items: total, files };
}

export function importAll(store: Store, dir: string, log: (line: string) => void = console.log): { projects: number; items: number } {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith('.json'));
  } catch {
    throw new Error(`No such directory: ${dir}`);
  }
  let projects = 0;
  let items = 0;
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (!raw?.project?.name) {
        log(`skipped ${file}: no project.name`);
        continue;
      }
      // createProject is idempotent by slug, so re-importing updates nothing it
      // should not and never produces a second copy of the same project.
      const project = store.createProject({
        name: raw.project.name,
        slug: raw.project.slug,
        description: raw.project.description,
        repos: raw.project.repos,
        key: raw.project.key ?? undefined,
      });
      const existing = new Set(store.listItems(project.id, 'none').map((item) => item.title));
      let added = 0;
      for (const item of raw.items || []) {
        // Matched on title rather than id: ids are regenerated on import, and the
        // alternative — duplicating every item on a second import — is worse than
        // occasionally skipping a genuine retitled duplicate.
        if (existing.has(item.title)) continue;
        // Every field the store accepts, deliberately. This list had drifted
        // behind the store twice already — body and checks were both missing,
        // which meant a restore from an export produced a board of empty
        // documents and no checklists while reporting success. This is the
        // disaster-recovery path; anything it drops is gone for good.
        const created = store.createItem(project.id, {
          title: item.title,
          context: item.context,
          options: item.options,
          choice: item.choice,
          status: item.status,
          kind: item.kind,
          section: item.section,
          labels: item.labels,
          body: item.body,
          bodyFormat: item.bodyFormat,
          checks: item.checks,
          clientId: item.clientId,
          createdAt: item.createdAt,
          seq: item.seq,
        });
        for (const message of item.messages || []) {
          store.addMessage(created.id, {
            who: message.who === 'you' ? 'you' : 'agent',
            text: message.text,
            author: message.author,
            status: item.status,
            createdAt: message.createdAt,
          });
        }
        added += 1;
      }
      if (raw.project.key !== undefined || raw.project.oldKeys !== undefined || raw.project.nextSeq !== undefined) {
        store.restoreProjectIdentity(project.slug, {
          key: raw.project.key ?? project.key ?? null,
          oldKeys: [...project.oldKeys, ...(raw.project.oldKeys ?? [])],
          nextSeq: raw.project.nextSeq ?? 1,
        });
      }
      log(`imported ${added} new item(s) into "${project.name}"`);
      projects += 1;
      items += added;
    } catch (error) {
      if (error instanceof ProjectKeyTaken) throw new Error(`${file}: ${error.message}`);
      throw error;
    }
  }
  return { projects, items };
}

/**
 * Commit the content directory if it is a git repository. A local commit only:
 * pushing is the human's (or an agent's) deliberate act, and a server that
 * pushed on its own would be sending data somewhere every time a row changed.
 * Nothing happens when the directory is not a repository — the files are the
 * backup then, and that is what the human chose.
 */
export async function commitIfRepo(dir: string, message: string): Promise<'committed' | 'nothing-to-commit' | 'not-a-repo' | 'failed'> {
  const isRepo = await Bun.file(join(dir, '.git', 'HEAD')).exists();
  if (!isRepo) return 'not-a-repo';
  // Argument arrays, never a shell: `dir` and `message` are data.
  const add = Bun.spawn(['git', '-C', dir, 'add', '--all', '--', '.'], { stdout: 'ignore', stderr: 'ignore' });
  if ((await add.exited) !== 0) return 'failed';
  const status = Bun.spawn(['git', '-C', dir, 'status', '--porcelain'], { stdout: 'pipe', stderr: 'ignore' });
  const changed = (await new Response(status.stdout).text()).trim().length > 0;
  await status.exited;
  if (!changed) return 'nothing-to-commit';
  const commit = Bun.spawn(['git', '-C', dir, 'commit', '-q', '-m', message], { stdout: 'ignore', stderr: 'ignore' });
  return (await commit.exited) === 0 ? 'committed' : 'failed';
}

/**
 * The server-side backup. Every write schedules an export a few seconds out;
 * a burst of writes (a batch of items, a round of replies) becomes one export
 * and one commit. Exists because the human recorded a backup plan and nothing
 * executed it: three exports in the content repository, all run by hand, on a
 * board that had changed hundreds of times. A backup that depends on somebody
 * remembering is not a backup.
 */
export function autoExporter(store: Store, dir: string, opts: { delayMs?: number; log?: (line: string) => void } = {}): () => void {
  const delay = opts.delayMs ?? 3000;
  const log = opts.log ?? (() => {});
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let dirtyAgain = false;
  const run = async () => {
    timer = null;
    if (running) { dirtyAgain = true; return; }
    running = true;
    try {
      const result = exportAll(store, dir);
      const committed = await commitIfRepo(dir, `workbench: auto-export ${new Date().toISOString()}`);
      log(`export     ${result.items} items in ${result.projects} project(s) -> ${dir} (${committed})`);
    } catch (error: any) {
      log(`export     FAILED: ${error?.message || error}`);
    } finally {
      running = false;
      if (dirtyAgain) { dirtyAgain = false; schedule(); }
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delay);
  };
  return schedule;
}
