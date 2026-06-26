import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import type { AddressInfo } from 'net';
import { probeServer } from '../checks.js';
import type { DaemonConfig } from '../config.js';

/**
 * Finding #3 regression: `status`/`doctor` probe the server over REST
 * (`GET /daemon/health` + `GET /daemon/whoami`) and NEVER open the execution
 * WebSocket, so they cannot supersede a running daemon. These tests stand up an
 * in-process http server faking both endpoints with the 200/401/timeout/
 * protocol-incompatible variants.
 */

interface FakeServerOptions {
  /** Status + body for GET /daemon/health. */
  health?: { status: number; body?: unknown };
  /** Status + body for GET /daemon/whoami. */
  whoami?: { status: number; body?: unknown };
  /** When true, accept the socket but never respond (forces a client timeout). */
  hang?: boolean;
  /** Records the Authorization header seen on /daemon/whoami. */
  onWhoamiAuth?: (auth: string | undefined) => void;
}

function startFakeServer(opts: FakeServerOptions): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (opts.hang) return; // never respond
    if (req.url === '/daemon/health') {
      const h = opts.health ?? { status: 200, body: { ok: true } };
      res.writeHead(h.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(h.body ?? {}));
      return;
    }
    if (req.url === '/daemon/whoami') {
      opts.onWhoamiAuth?.(req.headers.authorization);
      const w = opts.whoami ?? { status: 200, body: {} };
      res.writeHead(w.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(w.body ?? {}));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function configFor(baseUrl: string): DaemonConfig {
  return { serverUrl: baseUrl, machineId: 'm1', machineSecret: 'secret', name: 'test' };
}

describe('probeServer (REST diagnostics, no WebSocket)', () => {
  let server: Server | undefined;

  beforeEach(() => {
    server = undefined;
  });
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
  });

  it('reports reachable + protocol compatible + credentials valid on 200/200', async () => {
    let seenAuth: string | undefined;
    const fake = await startFakeServer({
      health: { status: 200, body: { ok: true, serverProtocol: { min: 1, max: 1 }, heartbeatSec: 15 } },
      whoami: { status: 200, body: { machineId: 'm1', name: 'box', status: 'active' } },
      onWhoamiAuth: (a) => (seenAuth = a),
    });
    server = fake.server;

    const result = await probeServer(configFor(fake.baseUrl), { timeoutMs: 2000 });
    expect(result.reachable).toBe(true);
    expect(result.protocolCompatible).toBe(true);
    expect(result.credentialsValid).toBe(true);
    // whoami carries the Bearer machineId.machineSecret credential.
    expect(seenAuth).toBe('Bearer m1.secret');
  });

  it('reports protocol incompatible when the daemon version is outside the server range', async () => {
    const fake = await startFakeServer({
      health: { status: 200, body: { ok: true, serverProtocol: { min: 2, max: 3 }, heartbeatSec: 15 } },
      whoami: { status: 200, body: { machineId: 'm1' } },
    });
    server = fake.server;

    const result = await probeServer(configFor(fake.baseUrl), { timeoutMs: 2000 });
    expect(result.reachable).toBe(true);
    expect(result.protocolCompatible).toBe(false);
    expect(result.credentialsValid).toBe(true);
  });

  it('reports credentials invalid on whoami 401 (revoked/invalid)', async () => {
    const fake = await startFakeServer({
      health: { status: 200, body: { ok: true, serverProtocol: { min: 1, max: 1 }, heartbeatSec: 15 } },
      whoami: { status: 401, body: { error: 'revoked' } },
    });
    server = fake.server;

    const result = await probeServer(configFor(fake.baseUrl), { timeoutMs: 2000 });
    expect(result.reachable).toBe(true);
    expect(result.protocolCompatible).toBe(true);
    expect(result.credentialsValid).toBe(false);
    expect(result.detail).toMatch(/401|revoked|invalid/i);
  });

  it('reports unreachable when health returns non-200', async () => {
    const fake = await startFakeServer({ health: { status: 503, body: {} } });
    server = fake.server;

    const result = await probeServer(configFor(fake.baseUrl), { timeoutMs: 2000 });
    expect(result.reachable).toBe(false);
    expect(result.protocolCompatible).toBe(false);
    expect(result.credentialsValid).toBe(false);
    expect(result.detail).toMatch(/503/);
  });

  it('reports unreachable when health times out', async () => {
    const fake = await startFakeServer({ hang: true });
    server = fake.server;

    const result = await probeServer(configFor(fake.baseUrl), { timeoutMs: 150 });
    expect(result.reachable).toBe(false);
    expect(result.detail).toMatch(/timed out/i);
  });

  it('reports unreachable when the dial fails (no listener)', async () => {
    // Point at a closed port: connection refused, never a WS supersede.
    const result = await probeServer(
      { serverUrl: 'http://127.0.0.1:1', machineId: 'm1', machineSecret: 's', name: 't' },
      { timeoutMs: 2000 },
    );
    expect(result.reachable).toBe(false);
  });

  it('treats a missing serverProtocol range as incompatible', async () => {
    const fake = await startFakeServer({
      health: { status: 200, body: { ok: true } },
      whoami: { status: 200, body: { machineId: 'm1' } },
    });
    server = fake.server;

    const result = await probeServer(configFor(fake.baseUrl), { timeoutMs: 2000 });
    expect(result.reachable).toBe(true);
    expect(result.protocolCompatible).toBe(false);
  });
});
