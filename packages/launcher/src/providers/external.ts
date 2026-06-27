import { pingDatabaseUrl } from '../pg.js';
import type { DbProvider } from '../types.js';

export interface ExternalProviderDeps {
  env?: NodeJS.ProcessEnv;
  /** Connectivity probe. Defaults to a real `select 1` over the DSN. */
  probe?: (databaseUrl: string) => Promise<void>;
}

/**
 * BYO-Postgres provider: it owns no lifecycle. `ensureRunning` probes the
 * configured `DATABASE_URL` and returns it; `stop` is a no-op.
 */
export function createExternalDbProvider(deps: ExternalProviderDeps = {}): DbProvider {
  const env = deps.env ?? process.env;
  const probe = deps.probe ?? ((url: string) => pingDatabaseUrl(url));

  return {
    async ensureRunning() {
      const databaseUrl = env.DATABASE_URL?.trim();
      if (!databaseUrl) {
        throw new Error('OPEN_TAG_DB_MODE=external requires DATABASE_URL to be set.');
      }
      await probe(databaseUrl);
      return { databaseUrl };
    },
    async stop() {
      // External Postgres lifecycle is not ours to manage.
    },
  };
}
