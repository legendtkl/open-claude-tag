import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

type InstanceRole = 'primary' | 'isolated';

interface WorkerPidRecord {
  service: 'worker';
  pid: number;
  startedAt: number;
  lastHeartbeatAt: number;
  cwd: string;
  instanceRole: InstanceRole;
  instanceId: string;
}

const DEFAULT_PID_ROOT = '/tmp/open-claude-tag';
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.OPEN_TAG_SERVICE_HEARTBEAT_MS ?? '10000', 10);
let heartbeatTimer: NodeJS.Timeout | null = null;

function resolveInstanceRole(): InstanceRole {
  return process.env.OPEN_TAG_INSTANCE_ROLE === 'isolated' ? 'isolated' : 'primary';
}

function resolveInstanceId(): string {
  return process.env.OPEN_TAG_INSTANCE_ID ?? resolveInstanceRole();
}

function defaultWorkerPidPath(): string {
  const role = resolveInstanceRole();
  const instanceId = resolveInstanceId();

  if (role === 'primary') {
    return join(DEFAULT_PID_ROOT, 'primary', 'worker.pid.json');
  }

  return join(DEFAULT_PID_ROOT, 'isolated', instanceId, 'worker.pid.json');
}

const WORKER_PID_PATH = process.env.OPEN_TAG_WORKER_PID_PATH ?? defaultWorkerPidPath();

function readWorkerPidRecord(): WorkerPidRecord | null {
  if (!existsSync(WORKER_PID_PATH)) return null;

  try {
    return JSON.parse(readFileSync(WORKER_PID_PATH, 'utf8')) as WorkerPidRecord;
  } catch {
    return null;
  }
}

function writeCurrentWorkerPidRecord(): void {
  mkdirSync(dirname(WORKER_PID_PATH), { recursive: true });
  writeFileSync(
    WORKER_PID_PATH,
    JSON.stringify(
      {
        service: 'worker',
        pid: process.pid,
        startedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        cwd: process.cwd(),
        instanceRole: resolveInstanceRole(),
        instanceId: resolveInstanceId(),
      } satisfies WorkerPidRecord,
      null,
      2,
    ),
  );
}

function startHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  heartbeatTimer = setInterval(() => {
    const record = readWorkerPidRecord();
    if (!record || record.pid !== process.pid) {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      return;
    }
    writeCurrentWorkerPidRecord();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
}

export function registerWorkerProcess(): void {
  writeCurrentWorkerPidRecord();
  startHeartbeat();
}

export function unregisterWorkerProcess(pid: number = process.pid): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (!existsSync(WORKER_PID_PATH)) return;

  const record = readWorkerPidRecord();
  if (!record || record.pid === pid) {
    rmSync(WORKER_PID_PATH, { force: true });
  }
}
