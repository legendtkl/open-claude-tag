import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { hashMachineSecret } from '@open-tag/storage';
import { DaemonGateway } from '../daemon-gateway/index.js';
import { createFakeGatewayDb, type FakeGatewayDbState } from './fake-gateway-db.js';
import { ScriptedDaemon } from './scripted-daemon.js';

// The worker installs fatal process handlers: an unhandled rejection exits the
// process and kills every running task. This suite drives the gateway's
// fire-and-forget surfaces (HTTP, WS upgrade, frames, liveness) against a
// failing database and asserts each failure is contained.

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

const loggerError = logger as unknown as { error: ReturnType<typeof vi.fn> };

const MACHINE_SECRET = 'secret-1';

function machineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    tenantKey: 'tenant-a',
    name: 'dev-box',
    status: 'online',
    secretHash: hashMachineSecret(MACHINE_SECRET),
    capabilities: {},
    lastSeenAt: new Date(),
    disconnectRequestedAt: null,
    platformOwnerId: null,
    ownerOpenId: 'ou_owner',
    ...overrides,
  };
}

describe('daemon gateway — resilience to backend failures', () => {
  let gateway: DaemonGateway;
  let state: FakeGatewayDbState;
  let port: number;
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => {
    unhandled.push(err);
  };

  async function startGateway(initial: Partial<FakeGatewayDbState>) {
    const made = createFakeGatewayDb(initial);
    state = made.state;
    gateway = new DaemonGateway({ db: made.db, logger, port: 0 });
    await gateway.start();
    port = gateway.boundPort();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(async () => {
    process.removeListener('unhandledRejection', onUnhandled);
    await gateway?.stop();
  });

  it('whoami answers 500 and the gateway stays serviceable when the DB rejects', async () => {
    await startGateway({ machines: [machineRow()] });
    state.failSelects = true;

    const res = await fetch(`http://127.0.0.1:${port}/daemon/whoami`, {
      headers: { authorization: `Bearer m-1.${MACHINE_SECRET}` },
    });
    expect(res.status).toBeGreaterThanOrEqual(500);

    state.failSelects = false;
    const recovered = await fetch(`http://127.0.0.1:${port}/daemon/whoami`, {
      headers: { authorization: `Bearer m-1.${MACHINE_SECRET}` },
    });
    expect(recovered.status).toBe(200);

    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toHaveLength(0);
  });

  it('destroys the socket and logs when the DB rejects during upgrade auth', async () => {
    await startGateway({ machines: [machineRow()] });
    state.failSelects = true;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon/ws`, {
      headers: { authorization: `Bearer m-1.${MACHINE_SECRET}` },
    });
    await new Promise<void>((resolve) => {
      ws.once('error', () => resolve());
      ws.once('close', () => resolve());
      ws.once('unexpected-response', (_req, res) => {
        res.resume();
        resolve();
      });
    });

    // The gateway must still answer health probes afterwards.
    state.failSelects = false;
    const health = await fetch(`http://127.0.0.1:${port}/daemon/health`);
    expect(health.status).toBe(200);

    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toHaveLength(0);
    expect(loggerError.error).toHaveBeenCalled();
  });

  it('contains a failing machines update during hello and stays connectable', async () => {
    await startGateway({ machines: [machineRow()] });
    state.failMachineUpdates = true;

    const daemon = new ScriptedDaemon(
      `ws://127.0.0.1:${port}/daemon/ws`,
      'm-1',
      MACHINE_SECRET,
    );
    await daemon.connect();
    // markMachineOnline rejects inside hello handling; wait for the error to be
    // observed (logged) rather than crashing the process.
    await vi.waitFor(() => {
      expect(loggerError.error).toHaveBeenCalled();
    });
    daemon.close();

    // After the DB recovers, a fresh connection completes the full hello.
    state.failMachineUpdates = false;
    const daemon2 = new ScriptedDaemon(
      `ws://127.0.0.1:${port}/daemon/ws`,
      'm-1',
      MACHINE_SECRET,
    );
    await daemon2.connect();
    await daemon2.waitForType('hello_ok');
    daemon2.close();

    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toHaveLength(0);
  });

  it('liveness tick logs and resolves when the status read rejects, and recovers next tick', async () => {
    await startGateway({ machines: [machineRow()] });

    const daemon = new ScriptedDaemon(
      `ws://127.0.0.1:${port}/daemon/ws`,
      'm-1',
      MACHINE_SECRET,
    );
    await daemon.connect();
    await daemon.waitForType('hello_ok');

    state.failSelects = true;
    const tick = (gateway as unknown as { livenessTick(): Promise<void> }).livenessTick();
    await expect(tick).resolves.toBeUndefined();
    expect(loggerError.error).toHaveBeenCalled();

    state.failSelects = false;
    loggerError.error.mockClear();
    await (gateway as unknown as { livenessTick(): Promise<void> }).livenessTick();
    expect(loggerError.error).not.toHaveBeenCalled();

    daemon.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toHaveLength(0);
  });

  it('contains a failing offline-marking when a daemon socket drops', async () => {
    await startGateway({ machines: [machineRow()] });

    const daemon = new ScriptedDaemon(
      `ws://127.0.0.1:${port}/daemon/ws`,
      'm-1',
      MACHINE_SECRET,
    );
    await daemon.connect();
    await daemon.waitForType('hello_ok');

    loggerError.error.mockClear();
    state.failMachineUpdates = true;
    daemon.terminate();
    await vi.waitFor(() => {
      expect(loggerError.error).toHaveBeenCalled();
    });
    state.failMachineUpdates = false;

    // Gateway must remain serviceable after the contained failure.
    const health = await fetch(`http://127.0.0.1:${port}/daemon/health`);
    expect(health.status).toBe(200);

    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toHaveLength(0);
  });

  it('skips a liveness tick while a previous tick is still in flight', async () => {
    await startGateway({ machines: [machineRow()] });
    const daemon = new ScriptedDaemon(
      `ws://127.0.0.1:${port}/daemon/ws`,
      'm-1',
      MACHINE_SECRET,
    );
    await daemon.connect();
    await daemon.waitForType('hello_ok');

    const internals = gateway as unknown as {
      livenessTick(): Promise<void>;
      livenessTickInFlight: boolean;
    };
    const db = (gateway as unknown as { db: { select: ReturnType<typeof vi.fn> } }).db;

    // Sanity: with a live connection, a normal tick reads the machine status.
    db.select.mockClear();
    await internals.livenessTick();
    expect(db.select).toHaveBeenCalled();

    // While a tick is marked in flight, the overlapping tick must no-op.
    internals.livenessTickInFlight = true;
    db.select.mockClear();
    await internals.livenessTick();
    expect(db.select).not.toHaveBeenCalled();
    internals.livenessTickInFlight = false;

    daemon.close();
  });
});
