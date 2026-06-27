import postgres from 'postgres';
import type { DbConnectionConfig } from './config.js';

const SILENCE = () => {};

/** Connect using a full DSN and run `select 1`. Throws on failure. */
export async function pingDatabaseUrl(databaseUrl: string, connectTimeoutSeconds = 10): Promise<void> {
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: connectTimeoutSeconds,
    idle_timeout: 1,
    onnotice: SILENCE,
  });
  try {
    await sql`select 1`;
  } finally {
    await sql.end({ timeout: 5 }).catch(SILENCE);
  }
}

/** Return whether a `select 1` succeeds against the given database. Never throws. */
export async function canConnect(config: DbConnectionConfig, database: string): Promise<boolean> {
  const sql = postgres({
    host: config.host,
    port: config.port,
    username: config.user,
    password: config.password,
    database,
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: SILENCE,
  });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 5 }).catch(SILENCE);
  }
}

/**
 * Create the target database if it does not yet exist, connecting through the
 * `postgres` maintenance database (the target may not exist yet).
 */
export async function ensureDatabaseExists(config: DbConnectionConfig): Promise<void> {
  const admin = postgres({
    host: config.host,
    port: config.port,
    username: config.user,
    password: config.password,
    database: 'postgres',
    max: 1,
    connect_timeout: 10,
    idle_timeout: 1,
    onnotice: SILENCE,
  });
  try {
    const rows = await admin`select 1 from pg_database where datname = ${config.database}`;
    if (rows.length === 0) {
      const safeName = config.database.replace(/"/g, '""');
      await admin.unsafe(`create database "${safeName}"`);
    }
  } finally {
    await admin.end({ timeout: 5 }).catch(SILENCE);
  }
}
