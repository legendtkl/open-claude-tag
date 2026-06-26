// apps/api/src/__tests__/ws-watchdog.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WsWatchdog } from '../ws-watchdog.js';

vi.mock('@open-tag/observability', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('WsWatchdog', () => {
  let watchdog: WsWatchdog;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    watchdog?.stop();
    vi.useRealTimers();
  });

  it('starts with connected status and restartCount 0', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2, checkIntervalMs: 1000 });
    const createWsClient = vi.fn();
    watchdog.start(createWsClient);

    const status = watchdog.getStatus();
    expect(status.status).toBe('connected');
    expect(status.restartCount).toBe(0);
    expect(status.currentThresholdMs).toBe(5000);
  });

  it('does not restart when activity is recent', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2, checkIntervalMs: 1000 });
    const createWsClient = vi.fn();
    watchdog.start(createWsClient);

    watchdog.recordActivity();
    vi.advanceTimersByTime(1000); // one check cycle

    expect(createWsClient).not.toHaveBeenCalled();
    expect(watchdog.getStatus().restartCount).toBe(0);
  });

  it('restarts when stale threshold exceeded', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2, checkIntervalMs: 1000 });
    const createWsClient = vi.fn();
    watchdog.start(createWsClient);

    // Do NOT record activity — lastActivityAt stays at init time
    // Advance just past the 5000ms threshold; the next 1000ms check interval fires
    vi.advanceTimersByTime(6000); // 6 check cycles; first 5 see elapsed < 5000, 6th sees elapsed >= 5000

    expect(createWsClient).toHaveBeenCalledTimes(1);
    expect(watchdog.getStatus().restartCount).toBe(1);
  });

  it('applies backoff after each restart', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2, checkIntervalMs: 1000 });
    const createWsClient = vi.fn();
    watchdog.start(createWsClient);

    // First restart: advance until elapsed > 5000ms (fires at T+6000)
    vi.advanceTimersByTime(6000);
    expect(watchdog.getStatus().currentThresholdMs).toBe(10000);

    // Second restart: need elapsed > 10000ms from lastActivityAt (T+6000)
    // advance 11000ms → fires at T+17000
    vi.advanceTimersByTime(11000);
    expect(watchdog.getStatus().currentThresholdMs).toBe(20000);

    // Third restart: need elapsed > 20000ms from lastActivityAt (T+17000)
    // advance 21000ms → fires at T+38000
    vi.advanceTimersByTime(21000);
    expect(watchdog.getStatus().currentThresholdMs).toBe(20000);

    expect(createWsClient).toHaveBeenCalledTimes(3);
  });

  it('resets threshold to base after activity is recorded', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2, checkIntervalMs: 1000 });
    const createWsClient = vi.fn();
    watchdog.start(createWsClient);

    // Trigger one restart to push threshold to 10000 (fires at T+6000)
    vi.advanceTimersByTime(6000);
    expect(watchdog.getStatus().currentThresholdMs).toBe(10000);

    // Activity resets threshold
    watchdog.recordActivity();
    expect(watchdog.getStatus().currentThresholdMs).toBe(5000);
  });

  it('calls closeWsClient before restarting when provided', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2, checkIntervalMs: 1000 });
    const createWsClient = vi.fn();
    const closeWsClient = vi.fn();
    watchdog.start(createWsClient, closeWsClient);

    vi.advanceTimersByTime(6000); // triggers exactly one restart

    expect(closeWsClient).toHaveBeenCalledTimes(1);
    expect(createWsClient).toHaveBeenCalledTimes(1);
    // close must be called before create
    expect(closeWsClient.mock.invocationCallOrder[0]).toBeLessThan(
      createWsClient.mock.invocationCallOrder[0],
    );
  });

  it('does not restart after stop()', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2, checkIntervalMs: 1000 });
    const createWsClient = vi.fn();
    watchdog.start(createWsClient);
    watchdog.stop();

    vi.advanceTimersByTime(6000); // would trigger a restart if not stopped

    expect(createWsClient).not.toHaveBeenCalled();
  });

  it('getStatus returns ISO lastActivityAt', () => {
    watchdog = new WsWatchdog({ baseThresholdMs: 5000, maxThresholdMs: 20000, backoffFactor: 2, checkIntervalMs: 1000 });
    watchdog.start(vi.fn());

    const { lastActivityAt } = watchdog.getStatus();
    expect(() => new Date(lastActivityAt)).not.toThrow();
    expect(new Date(lastActivityAt).toISOString()).toBe(lastActivityAt);
  });
});
