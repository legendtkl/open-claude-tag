import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  serializeFrame,
  parseRawFrame,
  ENVELOPE_VERSION,
  DAEMON_FEATURE_RUNTIME_ENV,
  PROTOCOL_VERSION,
  type Frame,
} from '@open-tag/daemon-protocol';
import type { RuntimeEvent } from '@open-tag/core-types';

/**
 * A minimal scripted daemon for integration tests: a real `ws` client that
 * authenticates, says hello, and lets the test drive frames over the wire. It
 * records inbound server frames so assertions can inspect dispatch/ack/cancel.
 */
export class ScriptedDaemon {
  private ws: WebSocket | null = null;
  readonly received: Frame[] = [];
  private readonly waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];

  constructor(
    private readonly url: string,
    private readonly machineId: string,
    private readonly machineSecret: string,
    private readonly protocolVersion: number = PROTOCOL_VERSION,
  ) {}

  async connect(runningDispatchIds: string[] = []): Promise<void> {
    const ws = new WebSocket(this.url, {
      headers: { authorization: `Bearer ${this.machineId}.${this.machineSecret}` },
    });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) =>
        reject(new Error(`upgrade rejected: ${res.statusCode}`)),
      );
    });
    ws.on('message', (data) => {
      const parsed = parseRawFrame(typeof data === 'string' ? data : data.toString('utf8'));
      if (!parsed.ok) return;
      this.received.push(parsed.frame);
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        if (this.waiters[i].match(parsed.frame)) {
          const [w] = this.waiters.splice(i, 1);
          w.resolve(parsed.frame);
        }
      }
    });
    this.send({
      ...this.envelope(),
      type: 'hello',
      machineId: this.machineId,
      protocolVersion: this.protocolVersion,
      daemonVersion: '0.0.0-test',
      capabilities: { runtimes: ['claude_code', 'codex'], features: [DAEMON_FEATURE_RUNTIME_ENV] },
      runningDispatchIds,
    });
  }

  /** Resolve once a frame matching `match` is received from the server. */
  waitFor(match: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const existing = this.received.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs);
      timer.unref();
      this.waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  waitForType(type: Frame['type'], timeoutMs?: number): Promise<Frame> {
    return this.waitFor((f) => f.type === type, timeoutMs);
  }

  accept(dispatchId: string): void {
    this.send({ ...this.envelope(), type: 'task_accepted', dispatchId });
  }

  reject(dispatchId: string, reason: string): void {
    this.send({ ...this.envelope(), type: 'task_rejected', dispatchId, reason });
  }

  emitEvent(dispatchId: string, seq: number, event: RuntimeEvent): void {
    this.send({ ...this.envelope(), type: 'task_event', dispatchId, seq, event });
  }

  lost(dispatchId: string): void {
    this.send({ ...this.envelope(), type: 'task_lost', dispatchId });
  }

  send(frame: Frame): void {
    this.ws?.send(serializeFrame(frame));
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  /** Force a hard TCP drop without a close handshake (simulates a flap). */
  terminate(): void {
    try {
      this.ws?.terminate();
    } catch {
      // ignore
    }
  }

  private envelope() {
    return { v: ENVELOPE_VERSION, id: randomUUID(), ts: new Date().toISOString() } as const;
  }
}
