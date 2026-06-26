import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('process-registration', () => {
  let tempDir: string;
  let workerPidPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'open-claude-tag-worker-process-'));
    workerPidPath = join(tempDir, 'worker.pid.json');
    process.env.OPEN_TAG_WORKER_PID_PATH = workerPidPath;
    process.env.OPEN_TAG_INSTANCE_ROLE = 'isolated';
    process.env.OPEN_TAG_INSTANCE_ID = 'worker-test-instance';
  });

  afterEach(() => {
    delete process.env.OPEN_TAG_WORKER_PID_PATH;
    delete process.env.OPEN_TAG_INSTANCE_ROLE;
    delete process.env.OPEN_TAG_INSTANCE_ID;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers and unregisters the worker process with instance metadata', async () => {
    const { registerWorkerProcess, unregisterWorkerProcess } = await import('../process-registration.js');

    registerWorkerProcess();

    const record = JSON.parse(readFileSync(workerPidPath, 'utf8'));
    expect(record).toMatchObject({
      service: 'worker',
      pid: process.pid,
      cwd: process.cwd(),
      instanceRole: 'isolated',
      instanceId: 'worker-test-instance',
    });
    expect(record.lastHeartbeatAt).toEqual(expect.any(Number));

    unregisterWorkerProcess();
    expect(() => readFileSync(workerPidPath, 'utf8')).toThrow();
  });
});
