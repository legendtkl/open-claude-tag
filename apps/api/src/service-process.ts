import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { Logger } from 'pino';

export type ManagedService = 'api' | 'worker';
export type InstanceRole = 'primary' | 'isolated';

export interface ServicePidRecord {
  service: ManagedService;
  pid: number;
  startedAt: number;
  lastHeartbeatAt: number;
  cwd: string;
  instanceRole: InstanceRole;
  instanceId: string;
}

const DEFAULT_PID_ROOT = '/tmp/open-claude-tag';
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.OPEN_TAG_SERVICE_HEARTBEAT_MS ?? '10000', 10);
const heartbeatTimers = new Map<ManagedService, NodeJS.Timeout>();

function resolveInstanceRole(): InstanceRole {
  return process.env.OPEN_TAG_INSTANCE_ROLE === 'isolated' ? 'isolated' : 'primary';
}

function resolveInstanceId(): string {
  return process.env.OPEN_TAG_INSTANCE_ID ?? resolveInstanceRole();
}

function resolvePidRoot(): string {
  return process.env.OPEN_TAG_PID_ROOT ?? DEFAULT_PID_ROOT;
}

function defaultPidFilePath(service: ManagedService): string {
  const role = resolveInstanceRole();
  const instanceId = resolveInstanceId();
  const pidRoot = resolvePidRoot();

  if (role === 'primary') {
    return join(pidRoot, 'primary', `${service}.pid.json`);
  }

  return join(pidRoot, 'isolated', instanceId, `${service}.pid.json`);
}

function configuredPidFilePath(service: ManagedService): string {
  if (service === 'api') {
    return process.env.OPEN_TAG_API_PID_PATH ?? defaultPidFilePath(service);
  }
  return process.env.OPEN_TAG_WORKER_PID_PATH ?? defaultPidFilePath(service);
}

function legacyPrimaryPidFilePath(service: ManagedService): string {
  return join(resolvePidRoot(), `${service}.pid.json`);
}

function pidFileCandidates(service: ManagedService): string[] {
  const configuredPath = configuredPidFilePath(service);
  const hasExplicitOverride =
    service === 'api'
      ? Boolean(process.env.OPEN_TAG_API_PID_PATH)
      : Boolean(process.env.OPEN_TAG_WORKER_PID_PATH);

  if (hasExplicitOverride || resolveInstanceRole() !== 'primary') {
    return [configuredPath];
  }

  return [configuredPath, legacyPrimaryPidFilePath(service)];
}

function readPidRecordFromPath(filePath: string): ServicePidRecord | null {
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as ServicePidRecord;
  } catch {
    return null;
  }
}

function isMissingProcessError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ESRCH'
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) return false;
    throw error;
  }
}

export function readPidRecord(service: ManagedService): ServicePidRecord | null {
  for (const filePath of pidFileCandidates(service)) {
    const record = readPidRecordFromPath(filePath);
    if (record) {
      return record;
    }
  }

  return null;
}

function writeCurrentPidRecord(service: ManagedService): void {
  const filePath = configuredPidFilePath(service);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        service,
        pid: process.pid,
        startedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        cwd: process.cwd(),
        instanceRole: resolveInstanceRole(),
        instanceId: resolveInstanceId(),
      } satisfies ServicePidRecord,
      null,
      2,
    ),
  );
}

function clearHeartbeat(service: ManagedService): void {
  const timer = heartbeatTimers.get(service);
  if (timer) {
    clearInterval(timer);
    heartbeatTimers.delete(service);
  }
}

function startHeartbeat(service: ManagedService): void {
  clearHeartbeat(service);
  const timer = setInterval(() => {
    const current = readPidRecord(service);
    if (!current || current.pid !== process.pid) {
      clearHeartbeat(service);
      return;
    }
    writeCurrentPidRecord(service);
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  heartbeatTimers.set(service, timer);
}

function removePidFileIfOwned(service: ManagedService, pid: number): void {
  for (const filePath of pidFileCandidates(service)) {
    if (!existsSync(filePath)) continue;

    const record = readPidRecordFromPath(filePath);
    if (!record || record.pid === pid) {
      rmSync(filePath, { force: true });
    }
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return !isProcessAlive(pid);
}

export function registerManagedService(service: ManagedService): void {
  writeCurrentPidRecord(service);
  startHeartbeat(service);
}

export function unregisterManagedService(service: ManagedService, pid: number = process.pid): void {
  clearHeartbeat(service);
  removePidFileIfOwned(service, pid);
}

export async function stopManagedService(
  service: ManagedService,
  logger: Pick<Logger, 'info' | 'warn'>,
  timeoutMs: number = 30_000,
): Promise<boolean> {
  const record = readPidRecord(service);
  if (!record) {
    logger.info({ service }, 'Managed service pid file not found, skipping stop');
    return false;
  }

  if (!isProcessAlive(record.pid)) {
    removePidFileIfOwned(service, record.pid);
    logger.info({ service, pid: record.pid }, 'Managed service pid is stale, removed pid file');
    return false;
  }

  logger.info(
    { service, pid: record.pid, instanceId: record.instanceId, instanceRole: record.instanceRole },
    'Stopping managed service',
  );
  process.kill(record.pid, 'SIGTERM');

  if (await waitForExit(record.pid, timeoutMs)) {
    removePidFileIfOwned(service, record.pid);
    logger.info({ service, pid: record.pid }, 'Managed service stopped gracefully');
    return true;
  }

  logger.warn({ service, pid: record.pid }, 'Managed service did not stop in time, forcing kill');
  process.kill(record.pid, 'SIGKILL');
  await waitForExit(record.pid, 5_000);
  removePidFileIfOwned(service, record.pid);
  return true;
}

function isWorkerTmuxEnabled(): boolean {
  return process.env.WORKER_EXECUTOR === 'tmux';
}

function resolveWorkerTmuxSession(): string {
  return process.env.WORKER_EXECUTOR_SESSION ?? `open-claude-tag-worker-${resolveInstanceId()}`;
}

function startWorkerViaTmux(repoRoot: string, logger: Pick<Logger, 'info'>): undefined {
  const sessionName = resolveWorkerTmuxSession();

  // Remove any stale session with the same name before creating a new one
  spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });

  const child = spawn(
    'tmux',
    ['new-session', '-d', '-s', sessionName, '-c', repoRoot, 'pnpm dev:worker'],
    {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    },
  );
  child.unref();

  logger.info({ service: 'worker', repoRoot, sessionName }, 'Started worker in tmux session');
  return undefined;
}

export function startManagedService(
  service: ManagedService,
  repoRoot: string,
  logger: Pick<Logger, 'info'>,
): number | undefined {
  if (service === 'worker' && isWorkerTmuxEnabled()) {
    return startWorkerViaTmux(repoRoot, logger);
  }

  const child = spawn('pnpm', [service === 'api' ? 'dev:api' : 'dev:worker'], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });

  child.unref();
  logger.info({ service, repoRoot, pid: child.pid }, 'Started managed service');
  return child.pid;
}

export async function waitForManagedServiceRegistration(
  service: ManagedService,
  timeoutMs: number = 30_000,
): Promise<ServicePidRecord> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const record = readPidRecord(service);
    if (record && isProcessAlive(record.pid)) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Managed service "${service}" did not register within ${timeoutMs / 1_000}s`);
}
