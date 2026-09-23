// Is the board down, or can this shell simply not reach it?
//
// A refused connection looks the same from inside the client either way:
// "Unable to connect", "Couldn't connect to server … after 0 ms". An agent
// running in a sandbox with networking off gets exactly that error while the
// server is up and answering everybody else — and the contract used to answer
// that error with "restart the service". So a sandboxed agent that asked for
// permission to restart was granted one, killed a healthy board, and dropped
// every other session connected at the time. The logs of one round showed three
// such restarts in ten minutes and no other cause of downtime.
//
// The listening socket settles it. A sandbox that forbids connecting still lets
// `lsof` read the process table, so if something is listening on the port the
// board is not down and a restart cannot help. During a real restart the old
// process has closed its socket before the new one binds, so "nothing is
// listening" is what a restart looks like and the retries stay useful there.

export type Listener =
  | { state: 'listening'; who: string }
  | { state: 'none' }
  | { state: 'unknown' };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The port to check, or null when the board is not on this machine (a listener elsewhere is not ours to see). */
export function localPort(base: string): number | null {
  let url: URL;
  try { url = new URL(base); } catch { return null; }
  if (!LOOPBACK.has(url.hostname)) return null;
  return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
}

/**
 * Who is listening on a local TCP port. `unknown` when the question cannot be
 * asked here (no lsof, or it failed for a reason other than "found nothing"),
 * so a caller never mistakes a missing tool for a missing server.
 */
export function listenerOn(port: number): Listener {
  let proc;
  try {
    proc = Bun.spawnSync(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdout: 'pipe', stderr: 'pipe' });
  } catch {
    return { state: 'unknown' };
  }
  const text = proc.stdout.toString().trim();
  const rows = text.split('\n').slice(1).filter(Boolean);
  if (rows.length) {
    const [command, pid] = rows[0].split(/\s+/);
    return { state: 'listening', who: `${command} pid ${pid}` };
  }
  // lsof exits 1 with no output when nothing matches; anything else is a failure to look.
  return proc.exitCode === 1 && !proc.stderr.toString().trim() ? { state: 'none' } : { state: 'unknown' };
}
