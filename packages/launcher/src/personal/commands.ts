import type { PersonalConfig } from './config.js';
import { isPersonalHealthReady, type HealthSnapshot } from './health.js';
import type { LockHandle } from './process-control.js';

// ── up ───────────────────────────────────────────────────────────────────────

export interface UpDeps {
  log: (message: string) => void;
  acquireLock: () => LockHandle;
  releaseLock: (handle: LockHandle | null) => void;
  ensureEnvFile: () => void;
  /** Is the whole personal stack already up and healthy? */
  probeRunning: () => Promise<{ allUp: boolean; health: HealthSnapshot | null }>;
  ensureDatabaseUp: () => Promise<{ databaseUrl: string }>;
  migrateAndSeed: (databaseUrl: string) => Promise<void>;
  ensureBuilt: () => Promise<void>;
  startServices: (databaseUrl: string) => Promise<void>;
  startConsole: (databaseUrl: string) => Promise<void>;
  waitForHealth: () => Promise<HealthSnapshot | null>;
  openBrowser: () => void;
  /** Best-effort teardown of anything `up` may have started, after a failure. */
  rollback: () => Promise<void>;
}

export interface UpOptions {
  noOpen?: boolean;
}

export interface UpResult {
  status: 'already-running' | 'started';
  health: HealthSnapshot | null;
}

/**
 * Orchestrate `up`. Pure step-ordering over injected steps so the ordering,
 * idempotency short-circuit, and lock-release-on-failure are unit-testable
 * without booting anything. The lock guards against a concurrent `up`.
 */
export async function runUp(config: PersonalConfig, deps: UpDeps, options: UpOptions = {}): Promise<UpResult> {
  const lock = deps.acquireLock();
  // Once we move past the idempotency probe we begin mutating system state, so
  // any later failure must tear back down — never leave a half-started stack.
  let mutating = false;
  try {
    deps.ensureEnvFile();

    const probe = await deps.probeRunning();
    if (probe.allUp) {
      deps.log('Personal stack is already running.');
      if (!options.noOpen) deps.openBrowser();
      return { status: 'already-running', health: probe.health };
    }

    mutating = true;
    const { databaseUrl } = await deps.ensureDatabaseUp();
    deps.log('Database ready.');

    await deps.migrateAndSeed(databaseUrl);
    deps.log('Migrations + seed applied.');

    await deps.ensureBuilt();

    await deps.startServices(databaseUrl);
    deps.log('API + Worker started.');

    await deps.startConsole(databaseUrl);
    deps.log('Console started.');

    const health = await deps.waitForHealth();
    if (!isPersonalHealthReady(health)) {
      throw new Error(
        `The stack did not become healthy at ${config.healthUrl}. ` +
          `Last /health: ${health ? JSON.stringify(health) : 'unreachable'}.`,
      );
    }
    deps.log(`Healthy at ${config.healthUrl}.`);

    if (!options.noOpen) deps.openBrowser();
    return { status: 'started', health };
  } catch (error) {
    if (mutating) {
      deps.log('Startup failed; rolling back partially started components.');
      await deps.rollback().catch(() => {});
    }
    throw error;
  } finally {
    deps.releaseLock(lock);
  }
}

// ── down ─────────────────────────────────────────────────────────────────────

export interface DownStepResult {
  status: string;
  [key: string]: unknown;
}

export interface DownDeps {
  log: (message: string) => void;
  stopConsole: () => Promise<DownStepResult>;
  stopServices: () => Promise<unknown>;
  stopDatabase: () => Promise<DownStepResult>;
}

export interface DownResult {
  console: DownStepResult;
  services: unknown;
  database: DownStepResult;
}

/**
 * Orchestrate `down`. Stop the front of the stack first (console), then the
 * services (worker before api, handled by the supervisor), then the database.
 * Each step is a no-op when its target is not running, so `down` is safe to run
 * when nothing is up.
 */
export async function runDown(_config: PersonalConfig, deps: DownDeps): Promise<DownResult> {
  const consoleResult = await deps.stopConsole();
  deps.log(`Console: ${consoleResult.status}.`);

  const servicesResult = await deps.stopServices();
  deps.log('API + Worker stopped.');

  const databaseResult = await deps.stopDatabase();
  deps.log(`Database: ${databaseResult.status}.`);

  return { console: consoleResult, services: servicesResult, database: databaseResult };
}

// ── status ───────────────────────────────────────────────────────────────────

export interface StatusSnapshot {
  dbMode: string;
  databaseUp: boolean;
  databaseDetail: string;
  api: boolean;
  worker: boolean;
  console: boolean;
  health: HealthSnapshot | null;
}

export interface StatusDeps {
  collect: () => Promise<StatusSnapshot>;
}

export async function runStatus(_config: PersonalConfig, deps: StatusDeps): Promise<StatusSnapshot> {
  return deps.collect();
}

function yesNo(value: boolean): string {
  return value ? 'up' : 'down';
}

/** Render a status snapshot as a short, human-readable block. Pure. */
export function formatStatus(snapshot: StatusSnapshot): string {
  const lines = [
    'OpenClaudeTag personal stack',
    `  DB mode:  ${snapshot.dbMode}`,
    `  Database: ${yesNo(snapshot.databaseUp)} (${snapshot.databaseDetail})`,
    `  API:      ${yesNo(snapshot.api)}`,
    `  Worker:   ${yesNo(snapshot.worker)}`,
    `  Console:  ${yesNo(snapshot.console)}`,
  ];
  if (snapshot.health) {
    const h = snapshot.health;
    lines.push(
      `  /health:  status=${h.status ?? '?'} db=${h.db ?? '?'} ` +
        `worker=${h.worker?.status ?? '?'} feishu=${h.feishu?.websocket ?? '?'}`,
    );
  } else {
    lines.push('  /health:  unreachable');
  }
  return lines.join('\n');
}
