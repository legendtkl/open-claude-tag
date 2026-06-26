import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import { resolveDatabaseUrl } from './env.js';

export function createDb(connectionString?: string) {
  const url = connectionString ?? resolveDatabaseUrl();
  const client = postgres(url, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
  });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
