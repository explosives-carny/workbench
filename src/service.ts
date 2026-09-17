// Keep the board running: a launchd agent on macOS, so the server starts at
// login and restarts if it dies.
//
// `bun run start` is a foreground process. Close the terminal, restart the
// machine, and the board is gone until somebody starts it again — and an agent
// that gets "connection refused" silently falls back to asking in chat, which
// is the failure the tool exists to stop. On the reference machine the server
// was being restarted by hand with pkill and nohup.
//
//   bun run install-service      write and load ~/Library/LaunchAgents/…plist
//   bun run install-service --remove
//
// Linux/systemd users: the equivalent unit is three lines and not worth a
// second code path here; see README.
import { homedir, platform } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'fs';

const LABEL = 'dev.workbench.server';
const HOME = homedir();
const PLIST = join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const LOG_DIR = join(HOME, '.workbench');

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function run(args: string[]): Promise<number> {
  const proc = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit' });
  return proc.exited;
}

if (platform() !== 'darwin') {
  console.error('install-service writes a launchd agent and only knows macOS. On Linux, a user systemd unit running `bun run start` in this directory does the same job.');
  process.exit(1);
}

const remove = process.argv.includes('--remove');
const uid = process.getuid?.() ?? 501;

if (remove) {
  await run(['launchctl', 'bootout', `gui/${uid}/${LABEL}`]);
  if (existsSync(PLIST)) unlinkSync(PLIST);
  console.log(`removed ${PLIST}`);
  process.exit(0);
}

const bunPath = Bun.which('bun') || process.execPath;
const env: Record<string, string> = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME };
for (const key of ['WORKBENCH_PORT', 'WORKBENCH_DB', 'WORKBENCH_CONTENT', 'WORKBENCH_AUTO_EXPORT']) {
  if (process.env[key]) env[key] = process.env[key]!;
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(bunPath)}</string>
    <string>run</string>
    <string>${escape(join(REPO, 'src', 'server.ts'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${escape(REPO)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escape(join(LOG_DIR, 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${escape(join(LOG_DIR, 'server.err.log'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${escape(k)}</key><string>${escape(v)}</string>`).join('\n')}
  </dict>
</dict>
</plist>
`;

mkdirSync(join(HOME, 'Library', 'LaunchAgents'), { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });
writeFileSync(PLIST, plist);
// bootout first so a re-install picks up a changed path or port instead of
// launchd keeping the old definition alive.
await run(['launchctl', 'bootout', `gui/${uid}/${LABEL}`]);
const code = await run(['launchctl', 'bootstrap', `gui/${uid}`, PLIST]);
if (code !== 0) {
  console.error(`launchctl bootstrap failed (${code}); the plist is at ${PLIST}`);
  process.exit(code);
}
console.log(`installed ${PLIST}\nlogs      ${join(LOG_DIR, 'server.log')}\nremove    bun run install-service --remove`);
