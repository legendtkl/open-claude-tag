import { resolveDockerConfig, buildDatabaseUrl } from '../config.js';
import { pingDatabaseUrl } from '../pg.js';
import { resolveDbProvider } from '../select.js';
import type { PersonalConfig } from './config.js';
import { ensureEmbeddedDb, stopEmbeddedDb } from './db-host.js';
import { ensureEnvFile } from './env.js';
import { getHealth, isPersonalHealthReady, waitForPersonalHealth } from './health.js';
import { openBrowser } from './browser.js';
import {
  acquireLock,
  isProcessAlive,
  readPidRecord,
  releaseLock,
  stopRecordedProcess,
} from './process-control.js';
import {
  ensureBuilt as ensureBuiltStep,
  migrateAndSeed as migrateAndSeedStep,
  startApiWorker,
  startConsole,
  stopApiWorker,
} from './supervisors.js';
import type { UpDeps, DownDeps, StatusDeps, StatusSnapshot } from './commands.js';

export interface RuntimeContext {
  config: PersonalConfig;
  effectiveEnv: NodeJS.ProcessEnv;
  cliPath: string;
  log: (message: string) => void;
  build?: boolean;
  noBuild?: boolean;
}

/** The DATABASE_URL the stack will use, derivable without booting anything. */
export function resolveExpectedDatabaseUrl(ctx: RuntimeContext): string | undefined {
  const { config, effectiveEnv } = ctx;
  if (config.dbMode === 'embedded') return buildDatabaseUrl(config.embedded!);
  if (config.dbMode === 'external') return effectiveEnv.DATABASE_URL?.trim() || undefined;
  return effectiveEnv.DATABASE_URL?.trim() || buildDatabaseUrl(resolveDockerConfig(effectiveEnv));
}

async function isDatabaseReachable(ctx: RuntimeContext): Promise<boolean> {
  const url = resolveExpectedDatabaseUrl(ctx);
  if (!url) return false;
  try {
    await pingDatabaseUrl(url, 5);
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pidPath: string): boolean {
  const record = readPidRecord(pidPath);
  return Boolean(record && typeof record.pid === 'number' && isProcessAlive(record.pid));
}

async function ensureDatabaseUp(ctx: RuntimeContext): Promise<{ databaseUrl: string }> {
  const { config, effectiveEnv, cliPath, log } = ctx;
  if (config.dbMode === 'embedded') {
    return ensureEmbeddedDb(config, { cliPath, log });
  }
  const provider = resolveDbProvider(config.dbMode, effectiveEnv);
  return provider.ensureRunning();
}

async function stopDatabase(ctx: RuntimeContext): Promise<{ status: string }> {
  if (ctx.config.dbMode === 'embedded') {
    return stopEmbeddedDb(ctx.config, ctx.log);
  }
  // docker/external lifecycles are owned elsewhere; leave them running.
  return { status: `${ctx.config.dbMode} (left running)` };
}

export function buildUpDeps(ctx: RuntimeContext): UpDeps {
  const { config, effectiveEnv, log } = ctx;
  return {
    log,
    acquireLock: () => acquireLock(config.lockPath),
    releaseLock: (handle) => releaseLock(handle),
    ensureEnvFile: () => {
      if (ensureEnvFile(config.repoRoot)) log('Created .env from .env.example.');
    },
    probeRunning: async () => {
      const dbUp =
        config.dbMode === 'embedded'
          ? pidAlive(config.dbHostPidPath) && (await isDatabaseReachable(ctx))
          : await isDatabaseReachable(ctx);
      const allAlive =
        dbUp &&
        pidAlive(config.apiPidPath) &&
        pidAlive(config.workerPidPath) &&
        pidAlive(config.consolePidPath);
      if (!allAlive) return { allUp: false, health: null };
      const health = await getHealth(config.healthUrl);
      return { allUp: isPersonalHealthReady(health), health };
    },
    ensureDatabaseUp: () => ensureDatabaseUp(ctx),
    migrateAndSeed: async (databaseUrl) => migrateAndSeedStep(config, effectiveEnv, databaseUrl),
    ensureBuilt: async () =>
      ensureBuiltStep(config, effectiveEnv, { force: ctx.build, skip: ctx.noBuild, log }),
    startServices: async (databaseUrl) => {
      await startApiWorker(config, effectiveEnv, databaseUrl);
    },
    startConsole: async () => {
      await startConsole(config, effectiveEnv);
    },
    waitForHealth: () => waitForPersonalHealth(config.healthUrl, 60_000),
    openBrowser: () => openBrowser(config.consoleUrl, { log }),
    rollback: async () => {
      // Best-effort teardown in the same order as `down`. Each step is a no-op
      // when its target never started.
      await stopRecordedProcess(config.consolePidPath, 'serve-console.mjs', { allowKill: true }).catch(
        () => {},
      );
      await stopApiWorker(config, effectiveEnv).catch(() => {});
      await stopDatabase(ctx).catch(() => {});
    },
  };
}

export function buildDownDeps(ctx: RuntimeContext): DownDeps {
  const { config, effectiveEnv, log } = ctx;
  return {
    log,
    stopConsole: async () => {
      const result = await stopRecordedProcess(config.consolePidPath, 'serve-console.mjs', {
        allowKill: true,
      });
      return { status: result.status, pid: result.pid };
    },
    stopServices: () => stopApiWorker(config, effectiveEnv),
    stopDatabase: () => stopDatabase(ctx),
  };
}

export function buildStatusDeps(ctx: RuntimeContext): StatusDeps {
  const { config } = ctx;
  return {
    collect: async (): Promise<StatusSnapshot> => {
      const reachable = await isDatabaseReachable(ctx);
      let databaseUp = reachable;
      let databaseDetail: string;
      if (config.dbMode === 'embedded') {
        const ownerAlive = pidAlive(config.dbHostPidPath);
        databaseUp = ownerAlive && reachable;
        databaseDetail = ownerAlive
          ? `embedded, db-host alive, ${config.embedded!.host}:${config.embedded!.port}`
          : reachable
            ? `reachable but NOT launcher-owned, ${config.embedded!.host}:${config.embedded!.port}`
            : `embedded, data dir ${config.embedded!.dataDir}`;
      } else {
        databaseDetail = reachable ? `${config.dbMode}, reachable` : `${config.dbMode}, unreachable`;
      }
      return {
        dbMode: config.dbMode,
        databaseUp,
        databaseDetail,
        api: pidAlive(config.apiPidPath),
        worker: pidAlive(config.workerPidPath),
        console: pidAlive(config.consolePidPath),
        health: await getHealth(config.healthUrl),
      };
    },
  };
}
