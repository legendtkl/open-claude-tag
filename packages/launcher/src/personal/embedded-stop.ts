import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isProcessAlive, readCmdline, type ProcessOps } from './process-control.js';

export interface PostmasterStopResult {
  status: 'no-postmaster' | 'already-stopped' | 'unverified' | 'stopped' | 'wedged';
  pid?: number;
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ownership-gated stop of the embedded Postgres directly, via the cluster's
 * `postmaster.pid`. Used ONLY as a fallback when the db-host owner is wedged.
 *
 * The ownership guard is the postmaster's own command line: a `postgres` running
 * with `-D <dataDir>` against the launcher's data dir is, by construction, the
 * cluster the launcher created — a foreign Postgres would never use our data
 * dir. If the command line cannot be read (cannot prove ownership), we REFUSE
 * to signal it. This preserves the "never kill a Postgres we did not start"
 * guarantee even across process boundaries.
 */
export async function stopEmbeddedPostmaster(
  dataDir: string,
  opts: { timeoutMs?: number; ops?: ProcessOps } = {},
): Promise<PostmasterStopResult> {
  const ops = opts.ops ?? {};
  const kill = ops.kill ?? process.kill.bind(process);
  const wait = ops.wait ?? defaultWait;
  const now = ops.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const postmasterPidPath = join(dataDir, 'postmaster.pid');
  if (!existsSync(postmasterPidPath)) return { status: 'no-postmaster' };

  let pid: number;
  try {
    const firstLine = readFileSync(postmasterPidPath, 'utf8').split(/\r?\n/, 1)[0]?.trim() ?? '';
    pid = Number.parseInt(firstLine, 10);
  } catch {
    return { status: 'no-postmaster' };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { status: 'no-postmaster' };

  if (!isProcessAlive(pid, ops)) return { status: 'already-stopped', pid };

  const cmdline = (ops.cmdline ?? readCmdline)(pid);
  if (cmdline === null || !cmdline.includes(dataDir)) {
    // Cannot prove this is our cluster ⇒ refuse to signal it.
    return { status: 'unverified', pid };
  }

  // SIGINT ⇒ Postgres "fast" shutdown (roll back active transactions, exit).
  kill(pid, 'SIGINT');

  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid, ops)) return { status: 'stopped', pid };
    await wait(250);
  }
  return isProcessAlive(pid, ops) ? { status: 'wedged', pid } : { status: 'stopped', pid };
}
