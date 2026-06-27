/**
 * Feasibility proof for the embedded-Postgres path (zero Docker).
 *
 * Boots a REAL embedded Postgres on an isolated port + temp data dir (so it
 * never collides with the repo's docker-compose Postgres on 5432), runs the
 * project's drizzle migrations against it, verifies a query + migration
 * artifacts, then shuts down cleanly and removes the temp data dir.
 *
 * Run: `pnpm --filter @open-tag/launcher run prove:embedded`
 */
import { spawnSync } from 'child_process';
import { createServer } from 'net';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { resolveDbMode, resolveDbProvider } from '../select.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[proof] assertion failed: ${message}`);
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('could not resolve a free port')));
      }
    });
  });
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'oct-pgproof-'));
  const port = await findFreePort();
  const env = {
    ...process.env,
    OPEN_TAG_DB_MODE: 'embedded',
    OPEN_TAG_PG_DATA_DIR: dataDir,
    OPEN_TAG_PG_PORT: String(port),
  };

  const mode = resolveDbMode(env);
  assert(mode === 'embedded', 'mode resolves to embedded');
  const provider = resolveDbProvider(mode, env);

  let stopped = false;
  try {
    console.log(`[proof] booting embedded Postgres on 127.0.0.1:${port} (data dir ${dataDir})`);
    const { databaseUrl } = await provider.ensureRunning();
    console.log('[proof] embedded Postgres up; DSN =', databaseUrl);
    assert(databaseUrl.includes(`:${port}/`), 'DSN uses the isolated override port');

    console.log('[proof] running project migrations (drizzle-kit migrate)...');
    const migrate = spawnSync('pnpm', ['--filter', '@open-tag/storage', 'run', 'db:migrate'], {
      cwd: repoRoot,
      env: { ...env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
    assert(migrate.status === 0, `migrations exited 0 (got ${migrate.status})`);

    const sql = postgres(databaseUrl, { max: 1, idle_timeout: 1, connect_timeout: 10 });
    try {
      const [{ ok }] = await sql<{ ok: number }[]>`select 1 as ok`;
      const [{ applied }] = await sql<{ applied: number }[]>`
        select count(*)::int as applied from drizzle.__drizzle_migrations
      `;
      const [{ users }] = await sql<{ users: string | null }[]>`
        select to_regclass('public.users')::text as users
      `;
      const [{ tables }] = await sql<{ tables: number }[]>`
        select count(*)::int as tables from information_schema.tables where table_schema = 'public'
      `;
      console.log(
        `[proof] SELECT 1 => ${ok} | drizzle migrations applied => ${applied} | ` +
          `public.users => ${users} | public tables => ${tables}`,
      );
      assert(ok === 1, 'SELECT 1 returns 1');
      assert(applied > 0, 'at least one migration recorded');
      assert(users === 'users', 'migrated table public.users exists');
      assert(tables > 30, 'schema has the expected table count');
    } finally {
      await sql.end({ timeout: 5 });
    }

    await provider.stop();
    stopped = true;
    const free = await isPortFree(port);
    console.log(`[proof] stopped; port ${port} free => ${free}`);
    assert(free, 'port is released after stop()');

    console.log('[proof] PASS — embedded Postgres booted, migrated, served a query, and shut down clean.');
  } finally {
    if (!stopped) {
      await provider.stop().catch(() => {});
    }
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[proof] FAILED:', error);
  process.exitCode = 1;
});
