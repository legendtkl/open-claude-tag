import { homedir } from 'os';
import { join } from 'path';

/** The default role / database / password the whole repo assumes. */
export const DEFAULT_DB_IDENTITY = 'open-claude-tag';
export const DEFAULT_DB_HOST = '127.0.0.1';
export const DEFAULT_DB_PORT = 5432;

export interface DbConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface EmbeddedConfig extends DbConnectionConfig {
  /** Where the embedded cluster's data directory lives. */
  dataDir: string;
}

function parsePort(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid OPEN_TAG_PG_PORT: "${raw}". Expected an integer in 1-65535.`);
  }
  return port;
}

/**
 * Resolve the embedded cluster config from env. Pure: same env in, same config
 * out. Port is overridable via `OPEN_TAG_PG_PORT`, the data dir via
 * `OPEN_TAG_PG_DATA_DIR` (default `~/.open-claude-tag/pgdata`). Role, database,
 * and password all default to `open-claude-tag` so the resulting DSN matches the
 * repo default without editing `DATABASE_URL`.
 */
export function resolveEmbeddedConfig(env: NodeJS.ProcessEnv = process.env): EmbeddedConfig {
  const port = parsePort(env.OPEN_TAG_PG_PORT) ?? DEFAULT_DB_PORT;
  const overrideDir = env.OPEN_TAG_PG_DATA_DIR?.trim();
  const dataDir = overrideDir && overrideDir.length > 0
    ? overrideDir
    : join(homedir(), '.open-claude-tag', 'pgdata');
  return {
    host: DEFAULT_DB_HOST,
    port,
    user: DEFAULT_DB_IDENTITY,
    password: DEFAULT_DB_IDENTITY,
    database: DEFAULT_DB_IDENTITY,
    dataDir,
  };
}

/**
 * Resolve the docker-compose Postgres config from env. Host is `localhost`
 * (the published compose port), port overridable via `OPEN_TAG_PG_PORT`.
 */
export function resolveDockerConfig(env: NodeJS.ProcessEnv = process.env): DbConnectionConfig {
  const port = parsePort(env.OPEN_TAG_PG_PORT) ?? DEFAULT_DB_PORT;
  return {
    host: 'localhost',
    port,
    user: DEFAULT_DB_IDENTITY,
    password: DEFAULT_DB_IDENTITY,
    database: DEFAULT_DB_IDENTITY,
  };
}

/** Build a `postgresql://` DSN from connection parts, URL-encoding credentials. */
export function buildDatabaseUrl(config: DbConnectionConfig): string {
  const user = encodeURIComponent(config.user);
  const password = encodeURIComponent(config.password);
  const database = encodeURIComponent(config.database);
  return `postgresql://${user}:${password}@${config.host}:${config.port}/${database}`;
}
