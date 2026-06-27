/**
 * Selects which Postgres lifecycle a launcher manages.
 *
 * - `embedded` — provision a real Postgres via `embedded-postgres`, zero Docker.
 * - `docker`   — bring up the project's docker-compose Postgres.
 * - `external` — connect to a Postgres someone else manages (BYO).
 */
export type DbMode = 'embedded' | 'docker' | 'external';

/**
 * A DB provider owns the lifecycle contract for one {@link DbMode}: make a
 * Postgres reachable and hand back its DSN, then optionally stop what it
 * started. Implementations MUST be idempotent and MUST NOT stop a server they
 * did not start.
 */
export interface DbProvider {
  /** Ensure Postgres is reachable and return the DSN to connect with. */
  ensureRunning(): Promise<{ databaseUrl: string }>;
  /** Stop only what this provider started. A no-op otherwise. */
  stop(): Promise<void>;
}
