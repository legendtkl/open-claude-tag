import { execFileSync, spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import process from 'process';
import { buildIsolatedEnv, buildIsolatedInstanceConfig, deriveDatabaseUrl } from './config.mjs';
import { isMissingProcessError } from './process-utils.mjs';
import { runStackSubcommand } from './stack-control.mjs';

const PID_ROOT = '/tmp/open-claude-tag';
const HEARTBEAT_STALE_MS = 30_000;
const ISOLATED_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_DATABASE_URL = 'postgresql://open-claude-tag:open-claude-tag@localhost:5432/open-claude-tag';

function escapeSqlLiteral(value) {
  return value.replace(/'/g, "''");
}

function buildConnectionArgs(url) {
  const args = [];
  if (url.hostname) args.push('--host', url.hostname);
  if (url.port) args.push('--port', url.port);
  if (url.username) args.push('--username', decodeURIComponent(url.username));
  return args;
}

function buildPgEnv(baseEnv, url) {
  const nextEnv = { ...baseEnv };
  if (url.password) {
    nextEnv.PGPASSWORD = decodeURIComponent(url.password);
  }
  return nextEnv;
}

function ensureDatabaseExists(config, env) {
  const targetUrl = new URL(config.databaseUrl);
  const targetDbName = targetUrl.pathname.replace(/^\//, '');
  const adminUrl = new URL(config.databaseUrl);
  adminUrl.pathname = '/postgres';

  const connectionArgs = buildConnectionArgs(adminUrl);
  const pgEnv = buildPgEnv(env, adminUrl);
  const existsQuery = `SELECT 1 FROM pg_database WHERE datname = '${escapeSqlLiteral(targetDbName)}';`;
  const existsOutput = execFileSync(
    'psql',
    [...connectionArgs, '--dbname', 'postgres', '-Atqc', existsQuery],
    {
      env: pgEnv,
      encoding: 'utf8',
    },
  ).trim();

  if (existsOutput === '1') {
    return false;
  }

  const createArgs = [...connectionArgs, '--maintenance-db', 'postgres'];
  if (adminUrl.username) {
    createArgs.push('--owner', decodeURIComponent(adminUrl.username));
  }
  createArgs.push(targetDbName);

  execFileSync('createdb', createArgs, {
    env: pgEnv,
    stdio: 'inherit',
  });
  return true;
}

function dropDatabaseIfExists(databaseUrl, env) {
  const targetUrl = new URL(databaseUrl);
  const targetDbName = targetUrl.pathname.replace(/^\//, '');
  const baseDbName = new URL(env.DATABASE_URL ?? DEFAULT_DATABASE_URL).pathname.replace(/^\//, '');

  if (!targetDbName || targetDbName === baseDbName) {
    throw new Error(`Refusing to drop non-isolated database "${targetDbName || '<empty>'}"`);
  }

  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';
  const connectionArgs = buildConnectionArgs(adminUrl);
  const pgEnv = buildPgEnv(env, adminUrl);

  execFileSync(
    'psql',
    [
      ...connectionArgs,
      '--dbname',
      'postgres',
      '-Atqc',
      `
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = '${escapeSqlLiteral(targetDbName)}'
          AND pid <> pg_backend_pid();
      `,
    ],
    {
      env: pgEnv,
      stdio: 'ignore',
    },
  );

  execFileSync(
    'dropdb',
    [...connectionArgs, '--maintenance-db', 'postgres', '--if-exists', targetDbName],
    {
      env: pgEnv,
      stdio: 'inherit',
    },
  );

  return targetDbName;
}

function printUsage() {
  process.stderr.write(
    'Usage:\n' +
      '  node tools/instance/run.mjs print\n' +
      '  node tools/instance/run.mjs ensure-db\n' +
      '  node tools/instance/run.mjs exec [--ensure-db] -- <command> [args...]\n' +
      '  node tools/instance/run.mjs services-start\n' +
      '  node tools/instance/run.mjs services-stop\n' +
      '  node tools/instance/run.mjs services-restart\n' +
      '  node tools/instance/run.mjs isolated-ps\n' +
      '  node tools/instance/run.mjs isolated-stop\n' +
      '  node tools/instance/run.mjs isolated-reap\n' +
      '  node tools/instance/run.mjs isolated-purge\n',
  );
}

function parseExecArgs(argv) {
  const ensureDb = argv.includes('--ensure-db');
  const separatorIndex = argv.indexOf('--');
  if (separatorIndex === -1 || separatorIndex === argv.length - 1) {
    throw new Error('exec requires a command after "--"');
  }

  return {
    ensureDb,
    command: argv[separatorIndex + 1],
    args: argv.slice(separatorIndex + 2),
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) return false;
    throw error;
  }
}

function readPidRecord(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function listIsolatedPidFiles() {
  const isolatedRoot = path.join(PID_ROOT, 'isolated');
  if (!existsSync(isolatedRoot)) {
    return [];
  }

  const pidFiles = [];
  for (const instanceDir of readdirSync(isolatedRoot, { withFileTypes: true })) {
    if (!instanceDir.isDirectory()) continue;
    const fullInstanceDir = path.join(isolatedRoot, instanceDir.name);
    for (const file of readdirSync(fullInstanceDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.pid.json')) continue;
      pidFiles.push(path.join(fullInstanceDir, file.name));
    }
  }
  return pidFiles;
}

function inspectPidRecord(record, filePath) {
  const instanceIdFromPath = path.basename(path.dirname(filePath));
  const alive = typeof record?.pid === 'number' ? isProcessAlive(record.pid) : false;
  const cwdExists = Boolean(record?.cwd && existsSync(record.cwd));
  const now = Date.now();
  const heartbeatAgeMs = record?.lastHeartbeatAt ? now - record.lastHeartbeatAt : null;
  const uptimeMs = record?.startedAt ? now - record.startedAt : null;
  const staleHeartbeat = heartbeatAgeMs !== null && heartbeatAgeMs > HEARTBEAT_STALE_MS;
  const expired = uptimeMs !== null && uptimeMs > ISOLATED_TTL_MS;

  return {
    ...record,
    instanceId: record?.instanceId ?? instanceIdFromPath,
    instanceRole: record?.instanceRole ?? 'isolated',
    filePath,
    alive,
    cwdExists,
    heartbeatAgeMs,
    uptimeMs,
    staleHeartbeat,
    expired,
  };
}

async function waitForExit(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !isProcessAlive(pid);
}

async function stopPidRecord(record, reason) {
  if (!record || typeof record.pid !== 'number') {
    return false;
  }

  const filePath = record.filePath;
  if (!record.alive) {
    rmSync(filePath, { force: true });
    return false;
  }

  process.stderr.write(
    `Stopping ${record.instanceId}/${record.service} pid=${record.pid} (${reason})\n`,
  );
  process.kill(record.pid, 'SIGTERM');
  const exited = await waitForExit(record.pid, 30_000);
  if (!exited) {
    process.kill(record.pid, 'SIGKILL');
    await waitForExit(record.pid, 5_000);
  }
  rmSync(filePath, { force: true });
  return true;
}

function currentInstancePidFiles(config) {
  return [config.apiPidPath, config.workerPidPath].filter((filePath) => existsSync(filePath));
}

function runtimeDirForInstance(instanceId) {
  return path.join(PID_ROOT, 'isolated', instanceId);
}

function listInstancePidFiles(instanceId) {
  const runtimeDir = runtimeDirForInstance(instanceId);
  if (!existsSync(runtimeDir)) {
    return [];
  }

  return readdirSync(runtimeDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.pid.json'))
    .map((entry) => path.join(runtimeDir, entry.name));
}

function instanceDatabaseUrl(instanceId, env = process.env) {
  return deriveDatabaseUrl(env.DATABASE_URL ?? DEFAULT_DATABASE_URL, instanceId);
}

function purgeInstanceRuntimeDir(instanceId) {
  rmSync(runtimeDirForInstance(instanceId), { recursive: true, force: true });
}

function purgeInstanceDatabase(instanceId, env = process.env) {
  return dropDatabaseIfExists(instanceDatabaseUrl(instanceId, env), env);
}

async function purgeCurrentInstance(config, env) {
  const records = currentInstancePidFiles(config)
    .map((filePath) => inspectPidRecord(readPidRecord(filePath), filePath))
    .filter((record) => record.instanceRole === 'isolated');

  for (const record of records) {
    await stopPidRecord(record, 'purge');
  }

  if (listInstancePidFiles(config.instanceId).length > 0) {
    throw new Error(`Cannot purge instance "${config.instanceId}" while pid files still exist`);
  }

  const droppedDatabase = purgeInstanceDatabase(config.instanceId, env);
  purgeInstanceRuntimeDir(config.instanceId);

  return {
    instanceId: config.instanceId,
    droppedDatabase,
  };
}

async function main() {
  const [, , subcommand, ...rest] = process.argv;

  if (!subcommand) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const config = buildIsolatedInstanceConfig({ cwd: process.cwd(), env: process.env });
  const isolatedEnv = buildIsolatedEnv({ cwd: process.cwd(), env: process.env });

  if (subcommand === 'print') {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return;
  }

  if (subcommand === 'ensure-db') {
    const created = ensureDatabaseExists(config, isolatedEnv);
    process.stdout.write(
      `${created ? 'created' : 'exists'} database ${new URL(config.databaseUrl).pathname.slice(1)}\n`,
    );
    return;
  }

  if (subcommand === 'exec') {
    const parsed = parseExecArgs(rest);
    if (parsed.ensureDb) {
      ensureDatabaseExists(config, isolatedEnv);
    }

    const child = spawn(parsed.command, parsed.args, {
      cwd: process.cwd(),
      env: isolatedEnv,
      stdio: 'inherit',
      shell: false,
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
    return;
  }

  if (
    subcommand === 'services-start' ||
    subcommand === 'services-stop' ||
    subcommand === 'services-restart'
  ) {
    const result = await runStackSubcommand(subcommand, {
      config,
      env: process.env,
      deps: {
        ensureDatabase: () => {
          ensureDatabaseExists(config, isolatedEnv);
        },
      },
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (subcommand === 'isolated-ps') {
    const rows = listIsolatedPidFiles()
      .map((filePath) => inspectPidRecord(readPidRecord(filePath), filePath))
      .sort(
        (a, b) => a.instanceId.localeCompare(b.instanceId) || a.service.localeCompare(b.service),
      );
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  if (subcommand === 'isolated-stop') {
    const records = currentInstancePidFiles(config)
      .map((filePath) => inspectPidRecord(readPidRecord(filePath), filePath))
      .filter((record) => record.instanceRole === 'isolated');

    for (const record of records) {
      await stopPidRecord(record, 'manual stop');
    }
    return;
  }

  if (subcommand === 'isolated-reap') {
    const records = listIsolatedPidFiles().map((filePath) =>
      inspectPidRecord(readPidRecord(filePath), filePath),
    );
    const reaped = [];
    const candidateInstanceIds = new Set();

    for (const record of records) {
      if (record.instanceRole !== 'isolated') {
        continue;
      }

      const shouldReap =
        !record.alive || !record.cwdExists || record.staleHeartbeat || record.expired;
      if (!shouldReap) {
        continue;
      }

      await stopPidRecord(
        record,
        !record.alive
          ? 'dead pid'
          : !record.cwdExists
            ? 'missing cwd'
            : record.staleHeartbeat
              ? 'stale heartbeat'
              : 'ttl expired',
      );
      candidateInstanceIds.add(record.instanceId);
      reaped.push({
        instanceId: record.instanceId,
        service: record.service,
        pid: record.pid,
      });
    }

    const droppedDatabases = [];
    for (const instanceId of [...candidateInstanceIds].sort()) {
      if (listInstancePidFiles(instanceId).length > 0) {
        continue;
      }

      const dbName = purgeInstanceDatabase(instanceId, process.env);
      purgeInstanceRuntimeDir(instanceId);
      droppedDatabases.push({ instanceId, database: dbName });
    }

    process.stdout.write(`${JSON.stringify({ reaped, droppedDatabases }, null, 2)}\n`);
    return;
  }

  if (subcommand === 'isolated-purge') {
    const result = await purgeCurrentInstance(config, process.env);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
