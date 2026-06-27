import { existsSync } from 'fs';
import { join } from 'path';
// Type-only import: erased at runtime, so this never eagerly loads the heavy
// binary wrapper. The value is pulled in via dynamic import inside ensureRunning.
import type EmbeddedPostgres from 'embedded-postgres';
import { buildDatabaseUrl, resolveEmbeddedConfig, type EmbeddedConfig } from '../config.js';
import { canConnect, ensureDatabaseExists } from '../pg.js';
import type { DbProvider } from '../types.js';

export interface EmbeddedProviderDeps {
  env?: NodeJS.ProcessEnv;
  config?: EmbeddedConfig;
  logger?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  healthcheckAttempts?: number;
  healthcheckIntervalMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Embedded provider: provisions a real Postgres via `embedded-postgres` with no
 * Docker. Idempotent — reuses an already-running compatible cluster and only
 * stops a child it started.
 */
export function createEmbeddedDbProvider(deps: EmbeddedProviderDeps = {}): DbProvider {
  const config = deps.config ?? resolveEmbeddedConfig(deps.env ?? process.env);
  const databaseUrl = buildDatabaseUrl(config);
  const log = deps.logger ?? (() => {});
  const sleep = deps.sleep ?? defaultSleep;
  const attempts = deps.healthcheckAttempts ?? 30;
  const intervalMs = deps.healthcheckIntervalMs ?? 500;

  let instance: EmbeddedPostgres | null = null;
  let startedByUs = false;

  return {
    async ensureRunning() {
      // Already up with our credentials? Reuse it — never start a second cluster.
      if (await canConnect(config, config.database)) {
        log('healthcheck ok (reusing running server)');
        return { databaseUrl };
      }

      // Lazy-load the heavy binary wrapper so docker/external users never pay for it.
      const { default: EmbeddedPostgresClass } = await import('embedded-postgres');
      const pg = new EmbeddedPostgresClass({
        databaseDir: config.dataDir,
        user: config.user,
        password: config.password,
        port: config.port,
        persistent: true,
        authMethod: 'scram-sha-256',
        onLog: () => {},
        onError: () => {},
      });

      if (!existsSync(join(config.dataDir, 'PG_VERSION'))) {
        log('initdb');
        await pg.initialise();
      }

      try {
        log(`start (${config.host}:${config.port})`);
        await pg.start();
        instance = pg;
        startedByUs = true;
      } catch (error) {
        // Port busy: only acceptable when it is OUR cluster answering. Otherwise
        // fail loud rather than silently bind to a foreign Postgres.
        if (await canConnect(config, 'postgres')) {
          log('reusing already-running server (start skipped)');
        } else {
          throw new Error(
            `Failed to start embedded Postgres on ${config.host}:${config.port}. ` +
              `The port may be held by a different Postgres.`,
            { cause: error },
          );
        }
      }

      log('ensure database');
      await ensureDatabaseExists(config);

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (await canConnect(config, config.database)) {
          log('healthcheck ok');
          return { databaseUrl };
        }
        await sleep(intervalMs);
      }
      throw new Error(
        `Embedded Postgres did not accept connections on ${config.host}:${config.port} in time.`,
      );
    },

    async stop() {
      if (instance && startedByUs) {
        log('stop');
        await instance.stop();
        instance = null;
        startedByUs = false;
      }
    },
  };
}
