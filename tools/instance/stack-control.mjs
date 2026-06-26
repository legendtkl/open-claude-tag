import { execSync as execSyncChild, spawn as spawnChild } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import { buildIsolatedEnv } from './config.mjs';
import { isMissingProcessError } from './process-utils.mjs';

const START_ORDER = ['api', 'worker'];
const STOP_ORDER = ['worker', 'api'];
const POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 30_000;
const HEALTH_REQUEST_TIMEOUT_MS = 1_000;

const ROGUE_KILL_TIMEOUT_MS = 5_000;

function createOps(deps = {}) {
  return {
    spawn: deps.spawn ?? spawnChild,
    execSync: deps.execSync ?? execSyncChild,
    existsSync: deps.existsSync ?? existsSync,
    mkdirSync: deps.mkdirSync ?? mkdirSync,
    openSync: deps.openSync ?? openSync,
    closeSync: deps.closeSync ?? closeSync,
    readFileSync: deps.readFileSync ?? readFileSync,
    rmSync: deps.rmSync ?? rmSync,
    isProcessAlive: deps.isProcessAlive,
    kill: deps.kill ?? process.kill.bind(process),
    fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
    wait: deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? (() => Date.now()),
  };
}

function isProcessAlive(pid, ops) {
  if (typeof ops.isProcessAlive === 'function') {
    return ops.isProcessAlive(pid);
  }

  try {
    ops.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) {
      return false;
    }
    throw error;
  }
}

function pidPathForService(config, service) {
  return service === 'api' ? config.apiPidPath : config.workerPidPath;
}

function pidPathCandidates(config, service) {
  const configuredPath = pidPathForService(config, service);
  if (config.instanceRole !== 'primary') {
    return [configuredPath];
  }

  const pidRoot = path.dirname(path.dirname(configuredPath));
  return [configuredPath, path.join(pidRoot, `${service}.pid.json`)];
}

export function logDirectoryForService(cwd, service) {
  return path.join(cwd, 'logs', 'services', service);
}

export function logPathForService(cwd, service) {
  return path.join(logDirectoryForService(cwd, service), 'service.log');
}

function packageNameForService(service) {
  return service === 'api' ? '@open-tag/api' : '@open-tag/worker';
}

export function resolveManagedApiUrl(config, env = process.env) {
  if (config.instanceRole === 'isolated') {
    return config.apiUrl;
  }

  if (env.API_URL?.trim()) {
    return env.API_URL;
  }

  const port = env.PORT?.trim() || env.API_PORT?.trim() || '3000';
  return `http://127.0.0.1:${port}`;
}

export function buildManagedServiceEnv(config, env = process.env) {
  if (config.instanceRole === 'isolated') {
    return buildIsolatedEnv({ cwd: config.cwd, env });
  }

  return {
    ...env,
    OPEN_TAG_INSTANCE_ROLE: 'primary',
    OPEN_TAG_INSTANCE_ID: 'primary',
    OPEN_TAG_API_PID_PATH: config.apiPidPath,
    OPEN_TAG_WORKER_PID_PATH: config.workerPidPath,
  };
}

function readPidRecordFromPath(filePath, ops) {
  if (!ops.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(ops.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function inspectServiceState(config, service, ops) {
  const candidatePaths = pidPathCandidates(config, service);

  for (const candidatePath of candidatePaths) {
    const exists = ops.existsSync(candidatePath);
    if (!exists) {
      continue;
    }

    const record = readPidRecordFromPath(candidatePath, ops);
    if (!record) {
      return {
        service,
        pidPath: candidatePath,
        logPath: logPathForService(config.cwd, service),
        record: null,
        alive: false,
        exists: true,
      };
    }

    const alive = typeof record.pid === 'number' ? isProcessAlive(record.pid, ops) : false;
    return {
      service,
      pidPath: candidatePath,
      logPath: logPathForService(config.cwd, service),
      record,
      alive,
      exists: true,
    };
  }

  return {
    service,
    pidPath: candidatePaths[0],
    logPath: logPathForService(config.cwd, service),
    record: null,
    alive: false,
    exists: false,
  };
}

function cleanupPidFile(filePath, ops) {
  ops.rmSync(filePath, { force: true });
}

async function waitFor(predicate, timeoutMs, ops) {
  const startedAt = ops.now();
  while (ops.now() - startedAt < timeoutMs) {
    const result = await predicate();
    if (result) {
      return result;
    }
    await ops.wait(POLL_INTERVAL_MS);
  }

  return null;
}

async function waitForServiceRegistration(config, service, timeoutMs, ops) {
  return waitFor(() => {
    const state = inspectServiceState(config, service, ops);
    if (state.record && state.alive) {
      return state.record;
    }
    return null;
  }, timeoutMs, ops);
}

async function fetchWithTimeout(url, timeoutMs, ops) {
  const controller = new AbortController();
  let timer = null;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Health check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([ops.fetch(url, { signal: controller.signal }), timeoutPromise]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

async function waitForApiHealth(apiUrl, timeoutMs, ops) {
  const healthUrl = `${apiUrl.replace(/\/$/, '')}/health`;

  const startedAt = ops.now();
  while (ops.now() - startedAt < timeoutMs) {
    const remainingMs = timeoutMs - (ops.now() - startedAt);
    const requestTimeoutMs = Math.max(1, Math.min(HEALTH_REQUEST_TIMEOUT_MS, remainingMs));

    try {
      const response = await fetchWithTimeout(healthUrl, requestTimeoutMs, ops);
      if (response.ok) {
        return { ready: true, healthUrl };
      }
    } catch {
      // Keep polling until the overall timeout budget is exhausted.
    }

    const remainingAfterProbe = timeoutMs - (ops.now() - startedAt);
    if (remainingAfterProbe <= 0) {
      break;
    }

    await ops.wait(Math.min(POLL_INTERVAL_MS, remainingAfterProbe));
  }

  return { ready: false, healthUrl };
}

function openServiceLog(cwd, service, ops) {
  const logDir = logDirectoryForService(cwd, service);
  const logPath = logPathForService(cwd, service);
  ops.mkdirSync(logDir, { recursive: true });
  const fd = ops.openSync(logPath, 'a');
  return { fd, logPath };
}

function serviceFailureMessage(service, logPath, reason) {
  return `Failed to make ${service} ready. Check log: ${logPath}. ${reason}`;
}

function spawnService(config, service, env, ops) {
  const { fd, logPath } = openServiceLog(config.cwd, service, ops);

  try {
    const child = ops.spawn(
      'pnpm',
      ['--filter', packageNameForService(service), 'run', 'dev'],
      {
        cwd: config.cwd,
        env,
        detached: true,
        shell: false,
        stdio: ['ignore', fd, fd],
      },
    );
    child.unref();
    return {
      pid: child.pid,
      logPath,
    };
  } finally {
    ops.closeSync(fd);
  }
}

async function waitForExit(pid, timeoutMs, ops) {
  const exited = await waitFor(() => (!isProcessAlive(pid, ops) ? true : null), timeoutMs, ops);
  return Boolean(exited);
}

async function stopService(config, service, timeoutMs, ops) {
  const state = inspectServiceState(config, service, ops);

  if (!state.record || typeof state.record.pid !== 'number') {
    if (state.exists) {
      cleanupPidFile(state.pidPath, ops);
      return { service, status: 'stale-removed', pidPath: state.pidPath };
    }

    return { service, status: 'not-running', pidPath: state.pidPath };
  }

  if (!state.alive) {
    cleanupPidFile(state.pidPath, ops);
    return { service, status: 'stale-removed', pidPath: state.pidPath, pid: state.record.pid };
  }

  ops.kill(state.record.pid, 'SIGTERM');
  const exited = await waitForExit(state.record.pid, timeoutMs, ops);
  if (!exited) {
    ops.kill(state.record.pid, 'SIGKILL');
    await waitForExit(state.record.pid, 5_000, ops);
  }

  cleanupPidFile(state.pidPath, ops);
  return { service, status: 'stopped', pidPath: state.pidPath, pid: state.record.pid };
}

async function rollbackStartedServices(config, services, timeoutMs, ops) {
  for (const service of [...services].reverse()) {
    await stopService(config, service, timeoutMs, ops);
  }
}

function serviceDirectoryMarker(service) {
  return service === 'api' ? 'apps/api' : 'apps/worker';
}

export function findRogueProcesses(config, service, excludePids, ops) {
  const marker = path.join(config.cwd, serviceDirectoryMarker(service));
  let psOutput;
  try {
    psOutput = ops.execSync('ps -eo pid,args', { encoding: 'utf8' });
  } catch {
    return [];
  }

  const rogues = [];
  for (const line of psOutput.split('\n')) {
    if (!line.includes(marker) || !line.includes('src/main.ts')) {
      continue;
    }
    const pid = parseInt(line.trim(), 10);
    if (isNaN(pid) || excludePids.has(pid)) {
      continue;
    }
    rogues.push(pid);
  }
  return rogues;
}

async function killRogueProcesses(config, service, excludePids, ops) {
  const rogues = findRogueProcesses(config, service, excludePids, ops);
  let killed = 0;

  for (const pid of rogues) {
    try {
      ops.kill(pid, 'SIGTERM');
    } catch (error) {
      if (isMissingProcessError(error)) continue;
      throw error;
    }

    const exited = await waitForExit(pid, ROGUE_KILL_TIMEOUT_MS, ops);
    if (!exited) {
      try {
        ops.kill(pid, 'SIGKILL');
      } catch (error) {
        if (!isMissingProcessError(error)) throw error;
      }
    }
    killed++;
  }

  return { service, killed, pids: rogues };
}

export async function startStack(options) {
  const ops = createOps(options.deps);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const config = options.config;
  const env = buildManagedServiceEnv(config, options.env);
  const apiUrl = resolveManagedApiUrl(config, env);
  const startedServices = [];
  const results = {};

  for (const service of START_ORDER) {
    const state = inspectServiceState(config, service, ops);
    if (state.record && state.alive) {
      if (service === 'api') {
        const { ready } = await waitForApiHealth(apiUrl, timeoutMs, ops);
        if (!ready) {
          throw new Error(
            serviceFailureMessage(service, state.logPath, 'Timed out waiting for health readiness'),
          );
        }
      }

      results[service] = {
        status: 'already-running',
        pid: state.record.pid,
        logPath: state.logPath,
      };
      continue;
    }

    if (state.exists) {
      cleanupPidFile(state.pidPath, ops);
    }

    // Kill unmanaged (rogue) processes for this service before spawning
    const excludePids = new Set([process.pid]);
    if (state.record?.pid) excludePids.add(state.record.pid);
    await killRogueProcesses(config, service, excludePids, ops);

    const launched = spawnService(config, service, env, ops);

    try {
      const record = await waitForServiceRegistration(config, service, timeoutMs, ops);
      if (!record) {
        throw new Error(`Timed out waiting for ${service} pid registration`);
      }

      startedServices.push(service);

      if (service === 'api') {
        const { ready } = await waitForApiHealth(apiUrl, timeoutMs, ops);
        if (!ready) {
          throw new Error('Timed out waiting for api health readiness');
        }
      }

      results[service] = {
        status: 'started',
        pid: record.pid,
        logPath: launched.logPath,
      };
    } catch (error) {
      await rollbackStartedServices(config, startedServices, timeoutMs, ops);
      throw new Error(serviceFailureMessage(service, launched.logPath, error instanceof Error ? error.message : String(error)));
    }
  }

  return {
    action: 'start',
    apiUrl,
    services: results,
  };
}

export async function stopStack(options) {
  const ops = createOps(options.deps);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results = {};

  for (const service of STOP_ORDER) {
    results[service] = await stopService(options.config, service, timeoutMs, ops);
  }

  return {
    action: 'stop',
    services: results,
  };
}

export async function restartStack(options) {
  const stopHandler = options.deps?.stopStack ?? stopStack;
  const startHandler = options.deps?.startStack ?? startStack;

  await stopHandler(options);
  const startResult = await startHandler(options);
  return {
    ...startResult,
    action: 'restart',
  };
}

export async function runStackSubcommand(subcommand, options) {
  const ensureDatabase = options.deps?.ensureDatabase ?? (() => {});
  const startHandler = options.deps?.startStack ?? startStack;
  const stopHandler = options.deps?.stopStack ?? stopStack;
  const restartHandler = options.deps?.restartStack ?? restartStack;

  if (subcommand === 'services-start') {
    if (options.config.instanceRole === 'isolated') {
      ensureDatabase();
    }
    return startHandler(options);
  }

  if (subcommand === 'services-stop') {
    return stopHandler(options);
  }

  if (subcommand === 'services-restart') {
    if (options.config.instanceRole === 'isolated') {
      ensureDatabase();
    }
    return restartHandler(options);
  }

  throw new Error(
    `Unsupported stack subcommand "${subcommand}". Expected services-start, services-stop, or services-restart.`,
  );
}
