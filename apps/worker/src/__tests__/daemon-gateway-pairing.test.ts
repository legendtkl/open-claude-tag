import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashMachineSecret, hashPairingToken } from '@open-tag/storage';
import { DaemonGateway } from '../daemon-gateway/index.js';
import { createFakeGatewayDb, type FakeGatewayDbState } from './fake-gateway-db.js';
import { ScriptedDaemon } from './scripted-daemon.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

function tokenRow(token: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'token-1',
    tokenHash: hashPairingToken(token),
    tenantKey: 'tenant-a',
    platformIssuerId: null,
    issuerOpenId: 'ou_owner',
    chatId: 'oc_chat',
    machineName: null,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** A console-issued token (design D-A7): platform issuer, no openId, no chat. */
function consoleTokenRow(token: string, overrides: Record<string, unknown> = {}) {
  return tokenRow(token, {
    platformIssuerId: 'pu-owner',
    issuerOpenId: null,
    chatId: null,
    ...overrides,
  });
}

async function pair(port: number, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/daemon/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, { method: 'GET', headers });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

describe('daemon gateway — pairing REST', () => {
  let gateway: DaemonGateway;
  let state: FakeGatewayDbState;
  let port: number;
  const announce = vi.fn(async () => {});

  async function startGateway(initial: Partial<FakeGatewayDbState>, withAnnounce: boolean) {
    const made = createFakeGatewayDb(initial);
    state = made.state;
    gateway = new DaemonGateway({
      db: made.db,
      logger,
      port: 0,
      announcePairing: withAnnounce ? announce : undefined,
    });
    await gateway.start();
    port = gateway.boundPort();
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await gateway?.stop();
  });

  it('happy path: redeems a token, returns 201 with secret, marks token used', async () => {
    const token = 'plain-token-abc';
    await startGateway({ tokens: [tokenRow(token)], insertedMachineId: 'm-123' }, true);

    const { status, json } = await pair(port, {
      token,
      name: 'laptop',
      capabilities: { runtimes: ['claude_code'] },
    });

    expect(status).toBe(201);
    const body = json as Record<string, unknown>;
    expect(body.machineId).toBe('m-123');
    expect(body.machineName).toBe('laptop');
    expect(typeof body.machineSecret).toBe('string');
    expect((body.machineSecret as string).length).toBeGreaterThan(20);
    expect(body.serverProtocol).toEqual({ min: 1, max: 1 });
    expect(body.heartbeatSec).toBe(15);

    // Single-use: token marked used.
    expect(state.tokenUpdates).toHaveLength(1);
    expect(state.tokenUpdates[0]).toHaveProperty('usedAt');
    // Machine inserted with token's owner + tenant.
    expect(state.machineInserts[0]).toMatchObject({
      tenantKey: 'tenant-a',
      ownerOpenId: 'ou_owner',
      name: 'laptop',
    });
    // Announcement fired in the issuing chat.
    expect(announce).toHaveBeenCalledWith({ chatId: 'oc_chat', machineName: 'laptop' });
  });

  it('401 for an unknown token (no detail leak)', async () => {
    await startGateway({ tokens: [] }, false);
    const { status, json } = await pair(port, { token: 'nope', capabilities: {} });
    expect(status).toBe(401);
    expect(json).toEqual({ error: 'invalid token' });
  });

  it('401 for an expired token', async () => {
    const token = 'expired-token';
    await startGateway(
      { tokens: [tokenRow(token, { expiresAt: new Date(Date.now() - 1000) })] },
      false,
    );
    const { status } = await pair(port, { token, capabilities: {} });
    expect(status).toBe(401);
  });

  it('401 for an already-used token', async () => {
    const token = 'used-token';
    await startGateway({ tokens: [tokenRow(token, { usedAt: new Date() })] }, false);
    const { status } = await pair(port, { token, capabilities: {} });
    expect(status).toBe(401);
  });

  it('uses the daemon hostname as the stable default machine name', async () => {
    const token = 'hostname-token';
    await startGateway({ tokens: [consoleTokenRow(token)], insertedMachineId: 'm-host' }, false);

    const { status, json } = await pair(port, {
      token,
      capabilities: { runtimes: ['codex'], hostname: 'studio-mbp' },
    });

    expect(status).toBe(201);
    expect(json).toMatchObject({ machineId: 'm-host', machineName: 'studio-mbp' });
    expect(state.machineInserts[0]).toMatchObject({
      platformOwnerId: 'pu-owner',
      ownerOpenId: null,
      name: 'studio-mbp',
    });
  });

  it('name resolution prefers explicit name over token name and hostname', async () => {
    const token = 'explicit-name-token';
    await startGateway(
      {
        tokens: [consoleTokenRow(token, { machineName: 'token-name' })],
        insertedMachineId: 'm-explicit',
      },
      false,
    );

    const { status, json } = await pair(port, {
      token,
      name: '  cli-name  ',
      capabilities: { runtimes: ['codex'], hostname: 'host-name' },
    });

    expect(status).toBe(201);
    expect(json).toMatchObject({ machineId: 'm-explicit', machineName: 'cli-name' });
    expect(state.machineInserts[0]).toMatchObject({ name: 'cli-name' });
  });

  it('name resolution prefers token machineName over hostname when no explicit name exists', async () => {
    const token = 'token-name-token';
    await startGateway(
      {
        tokens: [consoleTokenRow(token, { machineName: ' token-name ' })],
        insertedMachineId: 'm-token-name',
      },
      false,
    );

    const { status, json } = await pair(port, {
      token,
      name: '   ',
      capabilities: { runtimes: ['codex'], hostname: 'host-name' },
    });

    expect(status).toBe(201);
    expect(json).toMatchObject({ machineId: 'm-token-name', machineName: 'token-name' });
    expect(state.machineInserts[0]).toMatchObject({ name: 'token-name' });
  });

  it('re-pairs an existing non-revoked console machine by stable name', async () => {
    const token = 'repair-token';
    const oldSecretHash = hashMachineSecret('old-secret');
    await startGateway(
      {
        tokens: [consoleTokenRow(token)],
        machines: [
          {
            id: 'm-existing',
            tenantKey: 'tenant-a',
            platformOwnerId: 'pu-owner',
            ownerOpenId: null,
            name: 'studio-mbp',
            status: 'offline',
            secretHash: oldSecretHash,
            capabilities: { runtimes: ['claude_code'] },
          },
        ],
      },
      false,
    );

    const { status, json } = await pair(port, {
      token,
      capabilities: { runtimes: ['codex'], hostname: 'studio-mbp', daemonVersion: '0.1.3' },
    });

    expect(status).toBe(201);
    expect(json).toMatchObject({ machineId: 'm-existing', machineName: 'studio-mbp' });
    expect(state.machineInserts).toHaveLength(0);
    expect(state.machineUpdates[0]).toMatchObject({
      status: 'offline',
      capabilities: {
        runtimes: ['codex'],
        features: [],
        hostname: 'studio-mbp',
        daemonVersion: '0.1.3',
      },
    });
    expect(state.machineUpdates[0]?.secretHash).not.toBe(oldSecretHash);
  });

  it('does not re-pair a same-name machine from another console owner', async () => {
    const token = 'other-owner-token';
    await startGateway(
      {
        tokens: [consoleTokenRow(token)],
        insertedMachineId: 'm-new-owner',
        machines: [
          {
            id: 'm-other-owner',
            tenantKey: 'tenant-a',
            platformOwnerId: 'pu-other',
            ownerOpenId: null,
            name: 'studio-mbp',
            status: 'offline',
            secretHash: hashMachineSecret('other-secret'),
          },
        ],
      },
      false,
    );

    const { status, json } = await pair(port, {
      token,
      capabilities: { runtimes: ['codex'], hostname: 'studio-mbp' },
    });

    expect(status).toBe(201);
    expect(json).toMatchObject({ machineId: 'm-new-owner', machineName: 'studio-mbp' });
    expect(state.machineInserts).toHaveLength(1);
    expect(state.machineUpdates).toHaveLength(0);
  });

  it('does not re-pair a same-name machine from another tenant', async () => {
    const token = 'other-tenant-token';
    await startGateway(
      {
        tokens: [consoleTokenRow(token)],
        insertedMachineId: 'm-new-tenant',
        machines: [
          {
            id: 'm-other-tenant',
            tenantKey: 'tenant-b',
            platformOwnerId: 'pu-owner',
            ownerOpenId: null,
            name: 'studio-mbp',
            status: 'offline',
            secretHash: hashMachineSecret('other-secret'),
          },
        ],
      },
      false,
    );

    const { status, json } = await pair(port, {
      token,
      capabilities: { runtimes: ['codex'], hostname: 'studio-mbp' },
    });

    expect(status).toBe(201);
    expect(json).toMatchObject({ machineId: 'm-new-tenant', machineName: 'studio-mbp' });
    expect(state.machineInserts).toHaveLength(1);
    expect(state.machineUpdates).toHaveLength(0);
  });

  it('closes an active old socket when re-pair rotates the machine secret', async () => {
    const token = 'socket-rotation-token';
    const oldSecret = 'old-online-secret';
    await startGateway(
      {
        tokens: [consoleTokenRow(token)],
        machines: [
          {
            id: 'm-online',
            tenantKey: 'tenant-a',
            platformOwnerId: 'pu-owner',
            ownerOpenId: null,
            name: 'studio-mbp',
            status: 'online',
            secretHash: hashMachineSecret(oldSecret),
            capabilities: { runtimes: ['codex'] },
          },
        ],
      },
      false,
    );
    const daemon = new ScriptedDaemon(
      `ws://127.0.0.1:${port}/daemon/ws`,
      'm-online',
      oldSecret,
    );
    await daemon.connect();
    await daemon.waitForType('hello_ok');
    expect(gateway.isMachineOnline('m-online')).toBe(true);

    const { status, json } = await pair(port, {
      token,
      capabilities: { runtimes: ['codex'], hostname: 'studio-mbp' },
    });

    expect(status).toBe(201);
    expect(json).toMatchObject({ machineId: 'm-online', machineName: 'studio-mbp' });
    const error = await daemon.waitForType('hello_error');
    expect(error).toMatchObject({ type: 'hello_error', code: 'superseded' });
    await vi.waitFor(() => expect(gateway.isMachineOnline('m-online')).toBe(false), {
      timeout: 1000,
      interval: 10,
    });
    const whoami = await getJson(`http://127.0.0.1:${port}/daemon/whoami`, {
      authorization: `Bearer m-online.${oldSecret}`,
    });
    expect(whoami.status).toBe(401);
    daemon.close();
  });

  it('409 pairing conflict rolls back the claim when another re-pair wins first', async () => {
    const token = 'conflict-token';
    const oldSecretHash = hashMachineSecret('old-secret');
    await startGateway(
      {
        tokens: [consoleTokenRow(token)],
        failNextMachineUpdate: true,
        machines: [
          {
            id: 'm-existing',
            tenantKey: 'tenant-a',
            platformOwnerId: 'pu-owner',
            ownerOpenId: null,
            name: 'studio-mbp',
            status: 'offline',
            secretHash: oldSecretHash,
            capabilities: { runtimes: ['claude_code'] },
          },
        ],
      },
      false,
    );

    const { status, json } = await pair(port, {
      token,
      capabilities: { runtimes: ['codex'], hostname: 'studio-mbp' },
    });

    expect(status).toBe(409);
    expect(json).toEqual({ error: 'pairing conflict' });
    expect(state.tokens[0].usedAt).toBeNull();
    expect(state.machines[0].secretHash).toBe(oldSecretHash);
  });

  it('409 for a revoked duplicate machine name (same owner+tenant)', async () => {
    const token = 'dup-token';
    await startGateway(
      {
        tokens: [tokenRow(token, { machineName: 'laptop' })],
        machines: [
          {
            id: 'm-existing',
            tenantKey: 'tenant-a',
            platformOwnerId: null,
            ownerOpenId: 'ou_owner',
            name: 'laptop',
            status: 'revoked',
          },
        ],
      },
      false,
    );
    const { status, json } = await pair(port, { token, capabilities: {} });
    expect(status).toBe(409);
    expect(json).toEqual({ error: 'name taken' });
  });

  it('401 and rolls back when a token has no unambiguous owner', async () => {
    const token = 'ownerless-token';
    await startGateway(
      {
        tokens: [
          tokenRow(token, {
            platformIssuerId: null,
            issuerOpenId: null,
            chatId: null,
          }),
        ],
      },
      false,
    );

    const { status, json } = await pair(port, {
      token,
      capabilities: { runtimes: ['codex'], hostname: 'studio-mbp' },
    });

    expect(status).toBe(401);
    expect(json).toEqual({ error: 'invalid token' });
    expect(state.tokens[0].usedAt).toBeNull();
    expect(state.machineInserts).toHaveLength(0);
  });

  it('skips announcement when Feishu is disabled (no announce callback)', async () => {
    const token = 'no-announce-token';
    await startGateway({ tokens: [tokenRow(token)], insertedMachineId: 'm-x' }, false);
    const { status } = await pair(port, { token, capabilities: {} });
    expect(status).toBe(201);
    expect(announce).not.toHaveBeenCalled();
  });

  // ── D-A7 console-issued tokens ──────────────────────────────────────────────
  it('console-issued token: machine stamped with platformOwnerId, openId NULL', async () => {
    const token = 'console-token';
    await startGateway(
      { tokens: [consoleTokenRow(token)], insertedMachineId: 'm-console' },
      true, // announce callback present, but the console token has no chat
    );

    const { status, json } = await pair(port, {
      token,
      name: 'workstation',
      capabilities: { runtimes: ['claude_code'] },
    });

    expect(status).toBe(201);
    expect((json as Record<string, unknown>).machineId).toBe('m-console');
    // Machine owned by the console platform user; legacy openId left NULL.
    expect(state.machineInserts[0]).toMatchObject({
      tenantKey: 'tenant-a',
      platformOwnerId: 'pu-owner',
      ownerOpenId: null,
      name: 'workstation',
    });
    // No chat ⇒ no announcement even though the callback is wired.
    expect(announce).not.toHaveBeenCalled();
  });

  it('legacy openId token still stamps ownerOpenId and announces in the chat', async () => {
    const token = 'legacy-token';
    await startGateway({ tokens: [tokenRow(token)], insertedMachineId: 'm-legacy' }, true);

    const { status } = await pair(port, { token, name: 'laptop', capabilities: {} });
    expect(status).toBe(201);
    expect(state.machineInserts[0]).toMatchObject({
      ownerOpenId: 'ou_owner',
      platformOwnerId: null,
      name: 'laptop',
    });
    expect(announce).toHaveBeenCalledWith({ chatId: 'oc_chat', machineName: 'laptop' });
  });

  // ── #2 atomic single-use redemption ──────────────────────────────────────
  it('concurrent double-redeem yields exactly one 201 (atomic single-use claim)', async () => {
    const token = 'race-token';
    await startGateway({ tokens: [tokenRow(token)], insertedMachineId: 'm-race' }, false);

    // Two redemptions race against the same token. The atomic UPDATE … RETURNING
    // lets exactly one win; the loser sees a uniform 401.
    const [a, b] = await Promise.all([
      pair(port, { token, name: 'laptop-a', capabilities: {} }),
      pair(port, { token, name: 'laptop-b', capabilities: {} }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 401]);
    // Exactly one machine inserted and one token consumed.
    expect(state.machineInserts).toHaveLength(1);
    expect(state.tokenUpdates).toHaveLength(1);
  });

  it('409 (revoked duplicate name) rolls back the claim, leaving the token redeemable', async () => {
    const token = 'rollback-token';
    await startGateway(
      {
        tokens: [tokenRow(token, { machineName: 'laptop' })],
        machines: [
          {
            id: 'm-existing',
            tenantKey: 'tenant-a',
            platformOwnerId: null,
            ownerOpenId: 'ou_owner',
            name: 'laptop',
            status: 'revoked',
          },
        ],
      },
      false,
    );

    // First attempt collides on name ⇒ 409, and the claim is rolled back.
    const first = await pair(port, { token, name: 'laptop', capabilities: {} });
    expect(first.status).toBe(409);
    // Token was NOT consumed (rollback): still unused.
    expect(state.tokens[0].usedAt).toBeNull();
    expect(state.machineInserts).toHaveLength(0);

    // The same token can still be redeemed once the name collision is removed.
    state.machines.length = 0;
    const second = await pair(port, { token, name: 'laptop', capabilities: {} });
    expect(second.status).toBe(201);
  });

  // ── #3 diagnostics REST: health ──────────────────────────────────────────
  it('GET /daemon/health returns protocol + heartbeat with no auth', async () => {
    await startGateway({ tokens: [] }, false);
    const { status, json } = await getJson(`http://127.0.0.1:${port}/daemon/health`);
    expect(status).toBe(200);
    expect(json).toEqual({
      ok: true,
      serverProtocol: { min: 1, max: 1 },
      heartbeatSec: 15,
    });
  });

  // ── #3 diagnostics REST: whoami ──────────────────────────────────────────
  it('GET /daemon/whoami returns identity for a valid bearer', async () => {
    const secret = 'whoami-secret-value';
    await startGateway(
      {
        tokens: [],
        machines: [
          { id: 'm-1', name: 'laptop', status: 'online', secretHash: hashMachineSecret(secret) },
        ],
      },
      false,
    );
    const { status, json } = await getJson(`http://127.0.0.1:${port}/daemon/whoami`, {
      authorization: `Bearer m-1.${secret}`,
    });
    expect(status).toBe(200);
    expect(json).toEqual({ machineId: 'm-1', name: 'laptop', status: 'online' });
  });

  it('GET /daemon/whoami returns uniform 401 for a wrong secret', async () => {
    await startGateway(
      {
        tokens: [],
        machines: [
          {
            id: 'm-1',
            name: 'laptop',
            status: 'online',
            secretHash: hashMachineSecret('right-secret'),
          },
        ],
      },
      false,
    );
    const { status } = await getJson(`http://127.0.0.1:${port}/daemon/whoami`, {
      authorization: 'Bearer m-1.wrong-secret',
    });
    expect(status).toBe(401);
  });

  it('GET /daemon/whoami returns 401 for a revoked machine', async () => {
    const secret = 'revoked-secret';
    await startGateway(
      {
        tokens: [],
        machines: [
          { id: 'm-1', name: 'laptop', status: 'revoked', secretHash: hashMachineSecret(secret) },
        ],
      },
      false,
    );
    const { status } = await getJson(`http://127.0.0.1:${port}/daemon/whoami`, {
      authorization: `Bearer m-1.${secret}`,
    });
    expect(status).toBe(401);
  });

  it('GET /daemon/whoami returns 401 when no bearer is presented', async () => {
    await startGateway({ tokens: [] }, false);
    const { status } = await getJson(`http://127.0.0.1:${port}/daemon/whoami`);
    expect(status).toBe(401);
  });
});
