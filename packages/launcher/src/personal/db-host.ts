import { spawn } from 'child_process';
import { closeSync, mkdirSync, openSync, rmSync } from 'fs';
import { canConnect } from '../pg.js';
import { buildDatabaseUrl } from '../config.js';
import { createEmbeddedDbProvider } from '../providers/embedded.js';
import type { PersonalConfig } from './config.js';
import {
  isProcessAlive,
  readPidRecord,
  stopRecordedProcess,
  writePidRecord,
} from './process-control.js';
import { stopEmbeddedPostmaster } from './embedded-stop.js';

const DB_HOST_MARKER = 'db-host';

/**
 * Entry point for the hidden `db-host` subcommand. Owns the embedded Postgres:
 * because `embedded-postgres` spawns `postgres` as a direct child and stops it
 * when the owning Node process exits, the cluster needs a dedicated long-lived
 * process — this one — so it survives the transient `up` and can be stopped by a
 * separate `down`. We refuse to adopt a foreign Postgres already on the port.
 */
export async function runDbHost(
  config: PersonalConfig,
  log: (message: string) => void = (m) => process.stdout.write(`[db-host] ${m}\n`),
): Promise<void> {
  const embedded = config.embedded;
  if (!embedded) {
    log('OPEN_TAG_DB_MODE is not embedded; db-host has nothing to own. Exiting.');
    return;
  }

  const existing = readPidRecord(config.dbHostPidPath);
  if (existing && typeof existing.pid === 'number' && isProcessAlive(existing.pid)) {
    log(`Another db-host already owns this stack (pid ${existing.pid}). Exiting.`);
    return;
  }

  // Refuse to adopt a foreign Postgres. `up` only spawns db-host when nothing
  // answers the port; if something answers here it is not ours to manage.
  if (await canConnect(embedded, embedded.database)) {
    log(
      `A Postgres is already listening on ${embedded.host}:${embedded.port} that this launcher ` +
        `did not start. Refusing to adopt it. Stop it, choose OPEN_TAG_PG_PORT, or use external mode.`,
    );
    process.exitCode = 1;
    return;
  }

  const provider = createEmbeddedDbProvider({ env: process.env, config: embedded, logger: log });
  const { databaseUrl } = await provider.ensureRunning();

  writePidRecord(config.dbHostPidPath, {
    pid: process.pid,
    role: 'db-host',
    cwd: config.repoRoot,
    startedAt: Date.now(),
    dataDir: embedded.dataDir,
    port: embedded.port,
    startedByUs: true,
    databaseUrl,
  });
  log(`Embedded Postgres ready (${embedded.host}:${embedded.port}); owning it.`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`Received ${signal}; stopping embedded Postgres.`);
    try {
      await provider.stop();
    } finally {
      rmSync(config.dbHostPidPath, { force: true });
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));

  // The live postgres child keeps the event loop ref'd, so this process stays
  // alive until signalled (or until Postgres dies, which lets it exit and lets
  // `up`/`down` observe the failure).
}

// ── DB lifecycle used by up/down/status ────────────────────────────────────────

export interface DbHostSpawnDeps {
  /** Absolute path to the launcher CLI entry to re-exec as `db-host`. */
  cliPath: string;
  log?: (message: string) => void;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ensure the embedded Postgres is up and owned by a live db-host. Reuses a
 * running owner; otherwise spawns a detached db-host and polls until the DB
 * accepts connections. Fails closed if a foreign Postgres already answers the
 * port without a launcher owner.
 */
export async function ensureEmbeddedDb(
  config: PersonalConfig,
  deps: DbHostSpawnDeps,
): Promise<{ databaseUrl: string }> {
  const embedded = config.embedded;
  if (!embedded) throw new Error('ensureEmbeddedDb called without an embedded config.');
  const log = deps.log ?? (() => {});
  const wait = deps.wait ?? defaultWait;
  const now = deps.now ?? (() => Date.now());
  const databaseUrl = buildDatabaseUrl(embedded);

  const owner = readPidRecord(config.dbHostPidPath);
  const ownerAlive = owner && typeof owner.pid === 'number' && isProcessAlive(owner.pid);
  const reachable = await canConnect(embedded, embedded.database);

  if (ownerAlive && reachable) {
    log('Embedded Postgres already running (reusing db-host).');
    return { databaseUrl };
  }
  if (reachable && !ownerAlive) {
    throw new Error(
      `A Postgres is listening on ${embedded.host}:${embedded.port} but no launcher db-host owns it. ` +
        `Refusing to adopt a foreign Postgres in embedded mode. Stop it, set OPEN_TAG_PG_PORT, or ` +
        `use OPEN_TAG_DB_MODE=external.`,
    );
  }

  mkdirSync(config.runtimeDir, { recursive: true });
  const logFd = openSync(config.dbHostLogPath, 'a');
  const child = spawn('node', [deps.cliPath, 'db-host'], {
    cwd: config.repoRoot,
    detached: true,
    shell: false,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  closeSync(logFd);
  child.unref();
  let childExited = false;
  child.on('exit', () => {
    childExited = true;
  });

  log(`Booting embedded Postgres (db-host pid ${child.pid})…`);
  const deadline = now() + 60_000;
  while (now() < deadline) {
    if (await canConnect(embedded, embedded.database)) {
      log('Embedded Postgres accepted connections.');
      return { databaseUrl };
    }
    if (childExited) {
      throw new Error(
        `db-host exited before Postgres became ready. See ${config.dbHostLogPath}.`,
      );
    }
    await wait(500);
  }
  throw new Error(`Embedded Postgres did not become ready in time. See ${config.dbHostLogPath}.`);
}

/**
 * Stop the embedded Postgres for `down`: SIGTERM the db-host owner (which stops
 * Postgres gracefully). If the owner is wedged, fall back to an ownership-gated
 * postmaster stop (never touches a foreign cluster). No-op when nothing is up.
 */
export async function stopEmbeddedDb(
  config: PersonalConfig,
  log: (message: string) => void = () => {},
): Promise<{ status: string }> {
  const embedded = config.embedded;
  if (!embedded) return { status: 'no-op' };

  const result = await stopRecordedProcess(config.dbHostPidPath, DB_HOST_MARKER, {
    timeoutMs: 20_000,
    allowKill: false,
  });

  if (result.status === 'stopped' || result.status === 'stale-removed' || result.status === 'not-running') {
    log(`db-host: ${result.status}.`);
    // Belt-and-suspenders: if a cluster is still in our data dir (orphaned), stop it.
    const fallback = await stopEmbeddedPostmaster(embedded.dataDir, { timeoutMs: 10_000 });
    if (fallback.status === 'stopped') {
      log('Stopped an orphaned embedded Postgres via postmaster.pid.');
    }
    rmSync(config.dbHostPidPath, { force: true });
    return { status: result.status };
  }

  // db-host alive but did not exit on SIGTERM ⇒ ownership-gated postmaster stop.
  log('db-host did not exit on SIGTERM; stopping Postgres via its data dir.');
  const fallback = await stopEmbeddedPostmaster(embedded.dataDir, { timeoutMs: 15_000 });
  if (fallback.status === 'stopped' || fallback.status === 'already-stopped') {
    // Now the wedged db-host can be force-stopped safely (Postgres already down).
    await stopRecordedProcess(config.dbHostPidPath, DB_HOST_MARKER, {
      timeoutMs: 5_000,
      allowKill: true,
    });
    rmSync(config.dbHostPidPath, { force: true });
    return { status: 'stopped-via-postmaster' };
  }
  log(
    `Refused to force-stop Postgres (${fallback.status}); leaving it running. ` +
      `Inspect ${embedded.dataDir} manually.`,
  );
  return { status: `unverified-${fallback.status}` };
}
