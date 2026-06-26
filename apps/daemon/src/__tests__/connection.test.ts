import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { AddressInfo } from 'net';
import {
  ConnectionManager,
  FatalConnectionError,
  toWsUrl,
  resolveProxyForTarget,
} from '../connection.js';
import { parseRawFrame, ENVELOPE_VERSION } from '@open-tag/daemon-protocol';
import { randomUUID } from 'crypto';
import type { DaemonConfig } from '../config.js';
import { StubAdapter, stubRuntimeManager } from './stub-adapter.js';
import { makeDispatchFrame, makeCompletedResult } from './fixtures.js';
import type { RuntimeEvent } from '@open-tag/core-types';

function envelope<T extends Record<string, unknown>>(payload: T) {
  return JSON.stringify({
    v: ENVELOPE_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...payload,
  });
}

const CONFIG: DaemonConfig = {
  serverUrl: 'http://127.0.0.1:0',
  machineId: 'm1',
  machineSecret: 'secret',
  name: 'test',
};

describe('helpers', () => {
  it('rewrites http(s) → ws(s) /daemon/ws', () => {
    expect(toWsUrl('http://x:3001')).toBe('ws://x:3001/daemon/ws');
    expect(toWsUrl('https://x/')).toBe('wss://x/daemon/ws');
  });

  it('honors NO_PROXY exclusions', () => {
    const env = { HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'internal.example.com' };
    expect(resolveProxyForTarget('wss://internal.example.com/daemon/ws', env)).toBeUndefined();
    expect(resolveProxyForTarget('wss://other.example.com/daemon/ws', env)).toBe('http://proxy:8080');
    expect(resolveProxyForTarget('wss://x/ws', { NO_PROXY: '*', HTTPS_PROXY: 'http://p' })).toBeUndefined();
  });
});

describe('ConnectionManager against an in-process ws server', () => {
  let wss: WebSocketServer;
  let port: number;
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'daemon-conn-'));
    process.env.OPEN_TAG_HOME = home;
    wss = new WebSocketServer({ port: 0, path: '/daemon/ws' });
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
    port = (wss.address() as AddressInfo).port;
  });
  afterEach(async () => {
    delete process.env.OPEN_TAG_HOME;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  });

  function config(): DaemonConfig {
    return { ...CONFIG, serverUrl: `http://127.0.0.1:${port}` };
  }

  it('sends hello with Bearer auth then receives hello_ok', async () => {
    let authHeader = '';
    let helloSeen = false;
    wss.on('connection', (ws, req) => {
      authHeader = req.headers.authorization ?? '';
      ws.on('message', (data: RawData) => {
        const parsed = parseRawFrame(data.toString());
        if (parsed.ok && parsed.frame.type === 'hello') {
          helloSeen = true;
          ws.send(envelope({ type: 'hello_ok', heartbeatSec: 15, resumeDispatchIds: [], cancelDispatchIds: [] }));
        }
      });
    });

    const adapter = new StubAdapter([]);
    const cm = new ConnectionManager({ config: config(), runtimeManager: stubRuntimeManager(adapter) });
    void cm.run();
    try {
      // Poll instead of a fixed sleep: under full-suite parallel load the
      // connect + hello round trip can take well over 80ms.
      await vi.waitFor(
        () => {
          expect(helloSeen).toBe(true);
          expect(cm.connected).toBe(true);
        },
        { timeout: 5000, interval: 25 },
      );
      expect(authHeader).toBe('Bearer m1.secret');
    } finally {
      // Always stop, otherwise the open socket stalls afterEach's wss.close
      // until the hook times out.
      await cm.stop();
    }
  });

  it('replays unacked events after a mid-stream socket kill (no loss by seq)', async () => {
    const frame = makeDispatchFrame({ dispatchId: 'replay-1' });
    const received: Array<{ seq: number; event: RuntimeEvent }> = [];
    let connectionCount = 0;
    let firstWs: WebSocket | null = null;

    wss.on('connection', (ws) => {
      connectionCount++;
      const isFirst = connectionCount === 1;
      if (isFirst) firstWs = ws;
      ws.on('message', (data: RawData) => {
        const parsed = parseRawFrame(data.toString());
        if (!parsed.ok) return;
        const f = parsed.frame;
        if (f.type === 'hello') {
          // On the SECOND connection, ask the daemon to resume the dispatch.
          ws.send(
            envelope({
              type: 'hello_ok',
              heartbeatSec: 15,
              resumeDispatchIds: isFirst ? [] : ['replay-1'],
              cancelDispatchIds: [],
            }),
          );
          if (isFirst) {
            // Dispatch a task on the first connection, then kill the socket
            // mid-stream WITHOUT acking, so events must replay on reconnect.
            ws.send(JSON.stringify(frame));
          }
        } else if (f.type === 'task_event') {
          received.push({ seq: f.seq, event: f.event });
          if (isFirst && f.event.type === 'runtime_started') {
            // Kill the socket right after the first event, before acking.
            ws.terminate();
          }
        }
      });
    });

    const adapter = new StubAdapter([
      { type: 'runtime_started', executionId: 'exec-replay' },
      { type: 'progress', percent: 50, message: 'half' },
      { type: 'completed', result: makeCompletedResult(frame.taskId) },
    ]);
    const cm = new ConnectionManager({
      config: config(),
      runtimeManager: stubRuntimeManager(adapter),
      // Fast reconnect for the test.
      backoff: { next: () => 10, reset: () => {}, peekBase: () => 10, attempts: () => 0 } as never,
    });
    void cm.run();

    try {
      await vi.waitFor(
        () => {
          // Every seq 1..3 must have arrived at least once across both connections;
          // and the full contiguous run is present (no loss).
          const seqs = received.map((r) => r.seq).sort((a, b) => a - b);
          expect(new Set(seqs)).toEqual(new Set([1, 2, 3]));
          expect(connectionCount).toBeGreaterThanOrEqual(2);
          const terminal = received.find((r) => r.event.type === 'completed');
          expect(terminal).toBeDefined();
        },
        { timeout: 5000, interval: 25 },
      );
      void firstWs;
    } finally {
      await cm.stop();
    }
  });

  it('re-announces a terminal-but-unacked dispatch on reconnect (no task_lost)', async () => {
    // Finding #7: if the socket drops after `completed` is produced but before
    // the server acks it, the reconnect hello MUST still list the dispatch so
    // the gateway resumes it (and consumes the replayed terminal event) instead
    // of synthesizing task_lost and failing a task that actually completed.
    const frame = makeDispatchFrame({ dispatchId: 'terminal-replay' });
    const helloRunningIds: string[][] = [];
    const lostSeen: string[] = [];
    const replayedTerminal: boolean[] = [];
    let connectionCount = 0;

    wss.on('connection', (ws) => {
      connectionCount++;
      const isFirst = connectionCount === 1;
      ws.on('message', (data: RawData) => {
        const parsed = parseRawFrame(data.toString());
        if (!parsed.ok) return;
        const f = parsed.frame;
        if (f.type === 'hello') {
          helloRunningIds.push(f.runningDispatchIds);
          ws.send(
            envelope({
              type: 'hello_ok',
              heartbeatSec: 15,
              // On reconnect, resume the dispatch the daemon re-announced.
              resumeDispatchIds: isFirst ? [] : ['terminal-replay'],
              cancelDispatchIds: [],
            }),
          );
          if (isFirst) {
            ws.send(JSON.stringify(frame));
          }
        } else if (f.type === 'task_event') {
          if (f.event.type === 'completed') {
            if (isFirst) {
              // Kill the socket right after the terminal event, BEFORE acking.
              ws.terminate();
            } else {
              replayedTerminal.push(true);
            }
          }
        } else if (f.type === 'task_lost') {
          lostSeen.push(f.dispatchId);
        }
      });
    });

    const adapter = new StubAdapter([
      { type: 'runtime_started', executionId: 'exec-terminal' },
      { type: 'completed', result: makeCompletedResult(frame.taskId) },
    ]);
    const cm = new ConnectionManager({
      config: config(),
      runtimeManager: stubRuntimeManager(adapter),
      backoff: { next: () => 10, reset: () => {}, peekBase: () => 10, attempts: () => 0 } as never,
    });
    void cm.run();
    try {
      await vi.waitFor(
        () => {
          expect(connectionCount).toBeGreaterThanOrEqual(2);
          // The second hello re-announced the terminal-but-unacked dispatch.
          expect(helloRunningIds[1] ?? []).toContain('terminal-replay');
          // It was never reported as lost.
          expect(lostSeen).not.toContain('terminal-replay');
          // The terminal event was replayed on the new connection.
          expect(replayedTerminal.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 5000, interval: 25 },
      );
    } finally {
      await cm.stop();
    }
  });

  it('exits fatally on hello_error: protocol_incompatible', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data: RawData) => {
        const parsed = parseRawFrame(data.toString());
        if (parsed.ok && parsed.frame.type === 'hello') {
          ws.send(envelope({ type: 'hello_error', code: 'protocol_incompatible', message: 'too old' }));
        }
      });
    });
    const cm = new ConnectionManager({
      config: config(),
      runtimeManager: stubRuntimeManager(new StubAdapter([])),
    });
    await expect(cm.run()).rejects.toMatchObject({
      exitCode: 3,
    });
  });

  it('exits fatally on hello_error: revoked', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data: RawData) => {
        const parsed = parseRawFrame(data.toString());
        if (parsed.ok && parsed.frame.type === 'hello') {
          ws.send(envelope({ type: 'hello_error', code: 'revoked', message: 'removed' }));
        }
      });
    });
    const cm = new ConnectionManager({
      config: config(),
      runtimeManager: stubRuntimeManager(new StubAdapter([])),
    });
    const err = await cm.run().catch((e) => e);
    expect(err).toBeInstanceOf(FatalConnectionError);
    expect((err as FatalConnectionError).exitCode).toBe(4);
  });

  it('exits fatally on hello_error: superseded', async () => {
    wss.on('connection', (ws) => {
      ws.on('message', (data: RawData) => {
        const parsed = parseRawFrame(data.toString());
        if (parsed.ok && parsed.frame.type === 'hello') {
          ws.send(envelope({ type: 'hello_error', code: 'superseded', message: 'another took over' }));
        }
      });
    });
    const cm = new ConnectionManager({
      config: config(),
      runtimeManager: stubRuntimeManager(new StubAdapter([])),
    });
    const err = await cm.run().catch((e) => e);
    expect((err as FatalConnectionError).exitCode).toBe(5);
  });

  it('reports task_lost for resume ids the daemon no longer knows', async () => {
    const lostSeen: string[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data: RawData) => {
        const parsed = parseRawFrame(data.toString());
        if (!parsed.ok) return;
        if (parsed.frame.type === 'hello') {
          ws.send(
            envelope({
              type: 'hello_ok',
              heartbeatSec: 15,
              resumeDispatchIds: ['ghost-dispatch'],
              cancelDispatchIds: [],
            }),
          );
        } else if (parsed.frame.type === 'task_lost') {
          lostSeen.push(parsed.frame.dispatchId);
        }
      });
    });
    const cm = new ConnectionManager({
      config: config(),
      runtimeManager: stubRuntimeManager(new StubAdapter([])),
    });
    void cm.run();
    try {
      await vi.waitFor(
        () => {
          expect(lostSeen).toContain('ghost-dispatch');
        },
        { timeout: 5000, interval: 25 },
      );
    } finally {
      await cm.stop();
    }
  });
});
