import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerHealthMonitor } from '../worker-health-monitor.js';

// Mock service-process to control PID record
vi.mock('../service-process.js', () => ({
  readPidRecord: vi.fn(),
  startManagedService: vi.fn(),
}));

// Mock observability to avoid file transport setup
vi.mock('@open-tag/observability', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { readPidRecord, startManagedService } from '../service-process.js';

const mockedReadPidRecord = vi.mocked(readPidRecord);
const mockedStartManagedService = vi.mocked(startManagedService);

function makePidRecord(overrides: Record<string, unknown> = {}) {
  return {
    service: 'worker' as const,
    pid: process.pid, // Use own PID so isProcessAlive returns true
    startedAt: Date.now() - 60_000,
    lastHeartbeatAt: Date.now(),
    cwd: '/tmp',
    instanceRole: 'primary' as const,
    instanceId: 'primary',
    ...overrides,
  };
}

describe('WorkerHealthMonitor', () => {
  let monitor: WorkerHealthMonitor;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    mockedReadPidRecord.mockReset();
    mockedStartManagedService.mockReset();
  });

  afterEach(() => {
    monitor?.stop();
    vi.useRealTimers();
  });

  it('starts in unknown status', () => {
    monitor = new WorkerHealthMonitor({ intervalMs: 1000 });
    // Before start, status is unknown
    expect(monitor.getSnapshot().status).toBe('unknown');
  });

  it('transitions to healthy when worker is alive and heartbeat is fresh', () => {
    mockedReadPidRecord.mockReturnValue(makePidRecord());
    monitor = new WorkerHealthMonitor({ intervalMs: 1000 });
    monitor.start();
    // start() runs an immediate check
    expect(monitor.getSnapshot().status).toBe('healthy');
  });

  it('transitions to degraded after two consecutive stale checks', () => {
    mockedReadPidRecord.mockReturnValue(
      makePidRecord({ lastHeartbeatAt: Date.now() - 60_000 }), // way past 5x10s=50s threshold
    );
    monitor = new WorkerHealthMonitor({ intervalMs: 1000, workerHeartbeatMs: 10_000 });
    monitor.start();
    // First check: stale, count=1, not yet degraded
    expect(monitor.getSnapshot().status).not.toBe('degraded');

    // Second check: still stale → degraded
    vi.advanceTimersByTime(1000);
    expect(monitor.getSnapshot().status).toBe('degraded');
  });

  it('requires 2 consecutive failures to transition to down (hysteresis)', () => {
    // First check: healthy
    mockedReadPidRecord.mockReturnValue(makePidRecord());
    monitor = new WorkerHealthMonitor({ intervalMs: 1000 });
    monitor.start();
    expect(monitor.getSnapshot().status).toBe('healthy');

    // Second check: PID file gone — first failure
    mockedReadPidRecord.mockReturnValue(null);
    vi.advanceTimersByTime(1000);
    // Still healthy after one failure
    expect(monitor.getSnapshot().status).toBe('healthy');

    // Third check: still gone — second failure → down
    vi.advanceTimersByTime(1000);
    expect(monitor.getSnapshot().status).toBe('down');
  });

  it('single failure followed by success stays healthy', () => {
    mockedReadPidRecord.mockReturnValue(makePidRecord());
    monitor = new WorkerHealthMonitor({ intervalMs: 1000 });
    monitor.start();
    expect(monitor.getSnapshot().status).toBe('healthy');

    // Failure
    mockedReadPidRecord.mockReturnValue(null);
    vi.advanceTimersByTime(1000);
    expect(monitor.getSnapshot().status).toBe('healthy');

    // Recovery
    mockedReadPidRecord.mockReturnValue(makePidRecord());
    vi.advanceTimersByTime(1000);
    expect(monitor.getSnapshot().status).toBe('healthy');
  });

  it('sends alert on down transition and recovery', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const fakeClient = { sendMessage } as unknown as import('@open-tag/feishu-adapter').FeishuClient;

    mockedReadPidRecord.mockReturnValue(makePidRecord());
    monitor = new WorkerHealthMonitor({
      intervalMs: 1000,
      alertChatId: 'oc_test123',
      feishuClient: fakeClient,
      instanceId: 'test-instance',
    });
    monitor.start();

    // Two consecutive failures → down
    mockedReadPidRecord.mockReturnValue(null);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    expect(monitor.getSnapshot().status).toBe('down');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][2].content.text).toContain('Worker DOWN');

    // Recovery
    mockedReadPidRecord.mockReturnValue(makePidRecord());
    vi.advanceTimersByTime(1000);
    expect(monitor.getSnapshot().status).toBe('healthy');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1][2].content.text).toContain('Worker RECOVERED');
  });

  it('does not send duplicate down alerts', () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const fakeClient = { sendMessage } as unknown as import('@open-tag/feishu-adapter').FeishuClient;

    mockedReadPidRecord.mockReturnValue(makePidRecord());
    monitor = new WorkerHealthMonitor({
      intervalMs: 1000,
      alertChatId: 'oc_test123',
      feishuClient: fakeClient,
    });
    monitor.start();

    // Go down
    mockedReadPidRecord.mockReturnValue(null);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    expect(monitor.getSnapshot().status).toBe('down');

    // Stay down for 3 more checks
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    // Only 1 alert sent (not 4)
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('logs warning when ALERT_CHAT_ID is not set', () => {
    mockedReadPidRecord.mockReturnValue(makePidRecord());
    monitor = new WorkerHealthMonitor({
      intervalMs: 1000,
      alertChatId: '', // not configured
    });
    monitor.start();

    // Go down — should not throw, just log
    mockedReadPidRecord.mockReturnValue(null);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    expect(monitor.getSnapshot().status).toBe('down');
  });

  it('snapshot includes pid and uptime when healthy', () => {
    const startedAt = Date.now() - 3600_000; // 1 hour ago
    mockedReadPidRecord.mockReturnValue(makePidRecord({ startedAt }));
    monitor = new WorkerHealthMonitor({ intervalMs: 1000 });
    monitor.start();

    const snap = monitor.getSnapshot();
    expect(snap.status).toBe('healthy');
    expect(snap.pid).toBe(process.pid);
    expect(snap.lastHeartbeat).toBeDefined();
    expect(snap.uptimeSeconds).toBeGreaterThanOrEqual(3599);
  });

  it('does not transition to degraded on a single stale check', () => {
    // staleThreshold = heartbeatMs(10_000) * 5 = 50_000ms
    mockedReadPidRecord.mockReturnValue(
      makePidRecord({ lastHeartbeatAt: Date.now() - 55_000 }), // stale
    );
    monitor = new WorkerHealthMonitor({ intervalMs: 1000, workerHeartbeatMs: 10_000 });
    monitor.start();
    // Single stale check (from start()'s immediate call) should NOT go to degraded
    expect(monitor.getSnapshot().status).not.toBe('degraded');
  });

  it('transitions to degraded after 2 consecutive stale checks', () => {
    mockedReadPidRecord.mockReturnValue(
      makePidRecord({ lastHeartbeatAt: Date.now() - 55_000 }), // stale (>50s threshold)
    );
    monitor = new WorkerHealthMonitor({ intervalMs: 1000, workerHeartbeatMs: 10_000 });
    monitor.start();
    // First check at start(): stale but count=1, no degraded yet
    expect(monitor.getSnapshot().status).not.toBe('degraded');

    // Second check: still stale → count=2 → degraded
    vi.advanceTimersByTime(1000);
    expect(monitor.getSnapshot().status).toBe('degraded');
  });

  it('resets degraded counter when heartbeat recovers mid-stale', () => {
    // First check: stale (count=1)
    mockedReadPidRecord.mockReturnValue(
      makePidRecord({ lastHeartbeatAt: Date.now() - 55_000 }),
    );
    monitor = new WorkerHealthMonitor({ intervalMs: 1000, workerHeartbeatMs: 10_000 });
    monitor.start();
    expect(monitor.getSnapshot().status).not.toBe('degraded');

    // Second check: fresh heartbeat → counter resets, stays healthy
    mockedReadPidRecord.mockReturnValue(makePidRecord());
    vi.advanceTimersByTime(1000);
    expect(monitor.getSnapshot().status).toBe('healthy');

    // Third check: stale again → counter starts from 1 again, no degraded
    mockedReadPidRecord.mockReturnValue(
      makePidRecord({ lastHeartbeatAt: Date.now() - 55_000 }),
    );
    vi.advanceTimersByTime(1000);
    expect(monitor.getSnapshot().status).not.toBe('degraded');
  });

  it('calls startManagedService when autoRestart is enabled and worker goes down', () => {
    mockedReadPidRecord.mockReturnValue(null);
    monitor = new WorkerHealthMonitor({
      intervalMs: 1000,
      autoRestart: true,
      repoRoot: '/repo',
    });
    monitor.start(); // initial check: no PID → failure count 1
    expect(mockedStartManagedService).not.toHaveBeenCalled(); // single failure: hysteresis

    vi.advanceTimersByTime(1000); // second check → transitions to down
    expect(mockedStartManagedService).toHaveBeenCalledWith('worker', '/repo', expect.anything());
    expect(mockedStartManagedService).toHaveBeenCalledTimes(1);
  });

  it('skips auto-restart when within cooldown window', () => {
    const intervalMs = 1000;
    monitor = new WorkerHealthMonitor({
      intervalMs,
      autoRestart: true,
      repoRoot: '/repo',
      restartCooldownMs: 60_000, // 60s cooldown — well above test duration
    });

    // Phase 1: drive to 'down' → first restart
    mockedReadPidRecord.mockReturnValue(null);
    monitor.start();                      // immediate check: failure #1
    vi.advanceTimersByTime(intervalMs);   // check: failure #2 → transitions to 'down' → restart
    expect(mockedStartManagedService).toHaveBeenCalledTimes(1);
    expect(monitor.getSnapshot().status).toBe('down');

    // Phase 2: simulate recovery — worker registers a fresh heartbeat
    mockedReadPidRecord.mockReturnValue(makePidRecord());
    vi.advanceTimersByTime(intervalMs);   // check: process alive + fresh heartbeat → 'healthy'
    expect(monitor.getSnapshot().status).toBe('healthy');

    // Phase 3: worker goes down again, within cooldown window
    mockedReadPidRecord.mockReturnValue(null);
    vi.advanceTimersByTime(intervalMs);   // check: failure #1 (hysteresis: still healthy)
    vi.advanceTimersByTime(intervalMs);   // check: failure #2 → transitions to 'down' again
    expect(monitor.getSnapshot().status).toBe('down');

    // Cooldown (60s) has NOT elapsed — restart should be blocked
    expect(mockedStartManagedService).toHaveBeenCalledTimes(1);
  });

});
