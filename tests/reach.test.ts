import { describe, expect, test, afterAll } from 'bun:test';
import { existsSync } from 'fs';
import { listenerOn, localPort } from '../src/reach.ts';

// A server on a free port stands in for the board: the question is only whether
// something is listening, not what it answers.
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('{"ok":true}') });
afterAll(() => server.stop(true));

// A port that was listening a moment ago and is now closed.
function closedPort(): number {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = s.port;
  s.stop(true);
  return port;
}

describe('localPort', () => {
  test('reads the port of a board on this machine', () => {
    expect(localPort('http://localhost:4317')).toBe(4317);
    expect(localPort('http://127.0.0.1:9000')).toBe(9000);
    expect(localPort('http://[::1]:4317')).toBe(4317);
    expect(localPort('http://localhost')).toBe(80);
  });

  test('gives up on a board elsewhere, whose listener this machine cannot see', () => {
    expect(localPort('http://board.example:4317')).toBeNull();
    expect(localPort('not a url')).toBeNull();
  });
});

describe('listenerOn', () => {
  test('names the process listening on an open port', () => {
    const found = listenerOn(server.port);
    expect(found.state).toBe('listening');
    if (found.state === 'listening') expect(found.who).toContain(`pid ${process.pid}`);
  });

  test('reports nothing listening on a closed port, rather than unknown', () => {
    expect(listenerOn(closedPort())).toEqual({ state: 'none' });
  });
});

// The failure itself, reproduced: macOS's own sandbox refusing loopback the way
// an agent sandbox with networking off does, while the board is up.
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const DENY_LOCALHOST = '(version 1)(allow default)(deny network-outbound (remote ip "localhost:*"))';

describe.skipIf(process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC))('wb from a blocked shell', () => {
  test('says the board is up and not to restart it, and exits 3 without the retry wait', async () => {
    const started = Date.now();
    const proc = Bun.spawn([SANDBOX_EXEC, '-p', DENY_LOCALHOST, process.execPath, 'run', 'src/wb.ts', 'projects'], {
      env: { ...process.env, WORKBENCH_URL: `http://127.0.0.1:${server.port}`, WB_ACTOR: 'test' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(code).toBe(3);
    expect(stderr).toContain('the board is running');
    expect(stderr).toContain('Do not restart the service');
    expect(stderr).not.toContain('kickstart');
    // The 1 s / 2 s / 4 s retries are for a restart; a blocked shell should not sit through them.
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
