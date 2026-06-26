import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Database } from '@open-tag/storage';
import {
  machines,
  machinePairingTokens,
  hashMachineSecret,
  hashPairingToken,
  generateMachineSecret,
} from '@open-tag/storage';
import type { Logger } from '@open-tag/observability';
import {
  parseRawFrame,
  serializeFrame,
  isProtocolCompatible,
  SUPPORTED_PROTOCOL_RANGE,
  type Frame,
  type HelloFrame,
} from '@open-tag/daemon-protocol';
import type { DispatchBridge, GatewayDispatchPort, SendResult } from './dispatch-bridge.js';
import * as build from './frame-factory.js';

/** Default gateway port (design §6, requirement). */
const DEFAULT_PORT = 3001;
/** Heartbeat cadence advertised to daemons (D16). */
const HEARTBEAT_SEC = 15;
/** Inbound silence after which a socket is terminated + machine marked offline (D16). */
const LIVENESS_TIMEOUT_MS = 45_000;
/** Liveness scan cadence; also propagates revocation within ≤ one tick. */
const LIVENESS_TICK_MS = 5_000;
/** Time the daemon has to send its first `hello` after auth. */
const HELLO_TIMEOUT_MS = 10_000;
/** Malformed-frame strikes before the socket is closed (failure matrix §9). */
const MAX_FRAME_STRIKES = 3;
/**
 * WS close code for a server-initiated disconnect (design D-A9). Distinct from the
 * fatal codes (4000 protocol / 4001 superseded / 4004 revoked) so the daemon treats
 * it as an ordinary close and reconnects per its backoff — it is NOT fatal.
 */
const SERVER_DISCONNECT_CLOSE_CODE = 4005;
/** Human-readable close reason carried alongside {@link SERVER_DISCONNECT_CLOSE_CODE}. */
const SERVER_DISCONNECT_REASON = 'server_disconnect';

export interface DaemonGatewayOptions {
  db: Database;
  logger: Logger;
  /** Listen port; defaults to `DAEMON_GATEWAY_PORT` env or 3001. */
  port?: number;
  /** Bind 0.0.0.0 when true (`DAEMON_GATEWAY_PUBLIC=true`), else loopback. */
  publicBind?: boolean;
  /**
   * Announce a freshly paired machine in the token's chat. Skipped silently when
   * Feishu access is disabled (mirrors the main.ts FEISHU_ACCESS gate).
   */
  announcePairing?: (input: { chatId: string; machineName: string }) => Promise<void>;
}

/** A daemon socket that has authenticated and (eventually) said hello. */
interface MachineConnection {
  machineId: string;
  socket: WebSocket;
  /** Set once the `hello` handshake completes; until then the socket is unproven. */
  helloDone: boolean;
  /** Last instant any inbound frame arrived (drives the liveness watchdog). */
  lastInboundAt: number;
  /** Malformed-frame strike counter. */
  strikes: number;
  /**
   * Server-clock instant this socket was accepted (D-A9). A server-initiated
   * disconnect is honored only when `machine.disconnect_requested_at` is newer
   * than this — so a stale request never tears down a fresh reconnection.
   */
  connectedAt: number;
}

/**
 * Worker-hosted daemon gateway (design §3, D10): plain `node:http` for the
 * pairing REST endpoint plus a `ws` WebSocketServer for `/daemon/ws`. The API
 * never proxies execution traffic — daemons dial the worker directly.
 *
 * Responsibilities: pairing-token redemption, WS auth + version negotiation +
 * supersede (D14), app-level heartbeat/liveness (D16), revocation propagation,
 * and routing inbound dispatch frames to per-dispatch {@link DispatchBridge}s
 * registered by {@link RemoteRuntimeAdapter}.
 */
export class DaemonGateway implements GatewayDispatchPort {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly port: number;
  private readonly host: string;
  private readonly announcePairing?: DaemonGatewayOptions['announcePairing'];

  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  /** Re-entrancy guard: skip overlapping liveness ticks (slow DB). */
  private livenessTickInFlight = false;

  /** Authenticated connections that have completed `hello`, keyed by machineId. */
  private readonly connections = new Map<string, MachineConnection>();
  /** Bridges for in-flight dispatches, keyed by dispatchId. */
  private readonly bridges = new Map<string, DispatchBridge>();

  constructor(options: DaemonGatewayOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.port = options.port ?? Number(process.env.DAEMON_GATEWAY_PORT ?? DEFAULT_PORT);
    this.host = options.publicBind ? '0.0.0.0' : '127.0.0.1';
    this.announcePairing = options.announcePairing;
  }

  /** The port the gateway is bound to (resolved after {@link start}). */
  boundPort(): number {
    const addr = this.httpServer?.address();
    if (addr && typeof addr === 'object') return addr.port;
    return this.port;
  }

  async start(): Promise<void> {
    // Fire-and-forget surfaces below all carry their own error boundary: the
    // worker runs under fatal process handlers, so an unhandled rejection in
    // any of them would exit the process and kill every running task.
    const httpServer = createServer((req, res) => {
      void this.handleHttp(req, res).catch((err) => {
        this.logger.error({ err, url: req.url }, 'Daemon gateway HTTP handler failed');
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
          }
          res.end(JSON.stringify({ error: 'internal error' }));
        } catch {
          // best-effort
        }
      });
    });
    this.httpServer = httpServer;

    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    httpServer.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as Socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(this.port, this.host, () => {
        httpServer.removeListener('error', reject);
        resolve();
      });
    });

    this.livenessTimer = setInterval(() => {
      void this.livenessTick();
    }, LIVENESS_TICK_MS);
    this.livenessTimer.unref();

    this.logger.info(
      { host: this.host, port: this.boundPort() },
      'Daemon gateway listening',
    );
  }

  async stop(): Promise<void> {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    for (const conn of this.connections.values()) {
      try {
        conn.socket.close(1001, 'server shutdown');
      } catch {
        // best-effort
      }
    }
    this.connections.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close(() => resolve());
    });
    this.httpServer = null;
    this.wss = null;
  }

  // ── GatewayDispatchPort ──

  isMachineOnline(machineId: string): boolean {
    const conn = this.connections.get(machineId);
    return Boolean(conn && conn.helloDone && conn.socket.readyState === WebSocket.OPEN);
  }

  registerDispatch(dispatchId: string, bridge: DispatchBridge): () => void {
    this.bridges.set(dispatchId, bridge);
    return () => {
      if (this.bridges.get(dispatchId) === bridge) {
        this.bridges.delete(dispatchId);
      }
    };
  }

  sendToMachine(machineId: string, frame: Frame): SendResult {
    const conn = this.connections.get(machineId);
    if (!conn || conn.socket.readyState !== WebSocket.OPEN) {
      return { ok: false };
    }
    try {
      conn.socket.send(serializeFrame(frame));
      return { ok: true };
    } catch (err) {
      this.logger.warn({ machineId, err }, 'Failed to send frame to machine');
      return { ok: false };
    }
  }

  // ── Pairing REST ──

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url ? new URL(req.url, 'http://localhost').pathname : '';
    if (req.method === 'POST' && path === '/daemon/pair') {
      await this.handlePair(req, res);
      return;
    }
    if (req.method === 'GET' && path === '/daemon/health') {
      this.handleHealth(res);
      return;
    }
    if (req.method === 'GET' && path === '/daemon/whoami') {
      await this.handleWhoami(req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  /**
   * Unauthenticated liveness + protocol probe (codex finding #3). Returns the same
   * protocol range and heartbeat cadence the WS path advertises, so a daemon can
   * detect an incompatible server before opening a socket.
   */
  private handleHealth(res: ServerResponse): void {
    sendJson(res, 200, {
      ok: true,
      serverProtocol: SUPPORTED_PROTOCOL_RANGE,
      heartbeatSec: HEARTBEAT_SEC,
    });
  }

  /**
   * Authenticated identity probe (codex finding #3). Validates the same
   * `<machineId>.<secret>` bearer the WS upgrade uses (revoked ⇒ uniform 401). A
   * pure read: it MUST NOT touch WS/session state or supersede a live connection.
   */
  private async handleWhoami(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const creds = parseBearer(req.headers.authorization);
    if (!creds) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    const [machine] = await this.db
      .select({
        id: machines.id,
        name: machines.name,
        status: machines.status,
        secretHash: machines.secretHash,
      })
      .from(machines)
      .where(eq(machines.id, creds.machineId))
      .limit(1);

    // Uniform 401: unknown machine, secret mismatch, or revoked all look the same.
    if (
      !machine ||
      machine.status === 'revoked' ||
      machine.secretHash !== hashMachineSecret(creds.secret)
    ) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }

    return sendJson(res, 200, {
      machineId: machine.id,
      name: machine.name,
      status: machine.status,
    });
  }

  private async handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'invalid body' });
    }
    if (!body || typeof body !== 'object') {
      return sendJson(res, 400, { error: 'invalid body' });
    }
    const { token, name, capabilities } = body as {
      token?: unknown;
      name?: unknown;
      capabilities?: unknown;
    };
    if (typeof token !== 'string' || token.length === 0) {
      // Uniform 401 — never reveal which part failed (D5).
      return sendJson(res, 401, { error: 'invalid token' });
    }

    const tokenHash = hashPairingToken(token);
    const machineSecret = generateMachineSecret();
    const caps = normalizeCapabilities(capabilities);
    const requestedName = normalizeMachineName(name);

    let result:
      | { kind: 'paired'; machineId: string; machineName: string; chatId: string | null }
      | { kind: 'invalid' };
    try {
      result = await this.db.transaction(async (tx) => {
        // Atomic single-use claim (D5, codex finding #2): a single UPDATE … RETURNING
        // flips `used_at` only when the token is still unused AND unexpired, so two
        // concurrent redemptions cannot both win — exactly one row comes back.
        const now = new Date();
        const [claimed] = await tx
          .update(machinePairingTokens)
          .set({ usedAt: now })
          .where(
            and(
              eq(machinePairingTokens.tokenHash, tokenHash),
              isNull(machinePairingTokens.usedAt),
              gt(machinePairingTokens.expiresAt, now),
            ),
          )
          .returning({
            id: machinePairingTokens.id,
            tenantKey: machinePairingTokens.tenantKey,
            platformIssuerId: machinePairingTokens.platformIssuerId,
            issuerOpenId: machinePairingTokens.issuerOpenId,
            chatId: machinePairingTokens.chatId,
            machineName: machinePairingTokens.machineName,
          });

        // Unknown / expired / already-used all collapse to a uniform 401 (D5).
        if (!claimed) {
          return { kind: 'invalid' } as const;
        }

        const hasPlatformOwner = claimed.platformIssuerId != null;
        const hasLegacyOwner = claimed.issuerOpenId != null;
        if (hasPlatformOwner === hasLegacyOwner) {
          throw new InvalidPairingTokenOwnershipError();
        }

        const machineName =
          requestedName ??
          normalizeMachineName(claimed.machineName) ??
          normalizeMachineName(caps.hostname) ??
          defaultMachineName();

        // Ownership domain (design D-A7): a console-issued token carries a
        // `platformIssuerId` and the machine is owned by that console platform
        // user (openId stays NULL). A legacy Feishu-issued token carries an
        // `issuerOpenId` and keeps the historical openId ownership. Uniqueness is
        // checked within whichever owning domain the token belongs to.
        const consoleOwned = hasPlatformOwner;

        const ownerValues = {
          platformOwnerId: consoleOwned ? claimed.platformIssuerId : null,
          ownerOpenId: consoleOwned ? null : claimed.issuerOpenId,
        };
        const ownerWhere = consoleOwned
          ? and(
              eq(machines.tenantKey, claimed.tenantKey),
              eq(machines.platformOwnerId, claimed.platformIssuerId!),
              eq(machines.name, machineName),
            )
          : and(
              eq(machines.tenantKey, claimed.tenantKey),
              eq(machines.ownerOpenId, claimed.issuerOpenId!),
              eq(machines.name, machineName),
            );
        const candidates = await tx
          .select({
            id: machines.id,
            tenantKey: machines.tenantKey,
            platformOwnerId: machines.platformOwnerId,
            ownerOpenId: machines.ownerOpenId,
            name: machines.name,
            secretHash: machines.secretHash,
            status: machines.status,
          })
          .from(machines)
          .where(ownerWhere)
          .limit(2);
        const existing = candidates.find((row) =>
          machineMatchesOwner(row, {
            tenantKey: claimed.tenantKey,
            platformOwnerId: ownerValues.platformOwnerId,
            ownerOpenId: ownerValues.ownerOpenId,
            name: machineName,
          }),
        );
        if (existing) {
          if (existing.status === 'revoked') {
            throw new NameTakenError();
          }
          const [updated] = await tx
            .update(machines)
            .set({
              tenantKey: claimed.tenantKey,
              ...ownerValues,
              name: machineName,
              secretHash: hashMachineSecret(machineSecret),
              status: 'offline',
              capabilities: caps,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(machines.id, existing.id),
                eq(machines.secretHash, existing.secretHash),
                ne(machines.status, 'revoked'),
              ),
            )
            .returning({ id: machines.id });
          if (!updated) {
            throw new PairingConflictError();
          }
          return {
            kind: 'paired' as const,
            machineId: existing.id,
            machineName,
            // Console tokens have no announce chat; legacy tokens carry one.
            chatId: claimed.chatId,
          };
        }

        // Unique-index race on (tenant, owner, name) also throws ⇒ rolls back the
        // claim, surfaced as 409 below.
        const [created] = await tx
          .insert(machines)
          .values({
            tenantKey: claimed.tenantKey,
            // Stamp exactly one ownership domain: console → platformOwnerId,
            // legacy → ownerOpenId. The other stays NULL.
            ...ownerValues,
            name: machineName,
            secretHash: hashMachineSecret(machineSecret),
            status: 'offline',
            capabilities: caps,
          })
          .returning({ id: machines.id });

        return {
          kind: 'paired' as const,
          machineId: created.id,
          machineName,
          // Console tokens have no announce chat; legacy tokens carry one.
          chatId: claimed.chatId,
        };
      });
    } catch (err) {
      if (err instanceof NameTakenError) {
        return sendJson(res, 409, { error: 'name taken' });
      }
      if (err instanceof PairingConflictError) {
        return sendJson(res, 409, { error: 'pairing conflict' });
      }
      if (err instanceof InvalidPairingTokenOwnershipError) {
        return sendJson(res, 401, { error: 'invalid token' });
      }
      // Unique-index race (or any other insert failure) ⇒ 409; the rolled-back
      // claim leaves the token redeemable.
      this.logger.warn({ err }, 'Pairing transaction failed');
      return sendJson(res, 409, { error: 'name taken' });
    }

    if (result.kind === 'invalid') {
      return sendJson(res, 401, { error: 'invalid token' });
    }

    // Announce in the issuing chat (skipped when Feishu access is disabled OR the
    // token is console-issued, which has no chat to announce in — design D-A7).
    if (this.announcePairing && result.chatId) {
      const chatId = result.chatId;
      try {
        await this.announcePairing({ chatId, machineName: result.machineName });
      } catch (err) {
        this.logger.warn({ err, chatId }, 'Pairing announcement failed');
      }
    }

    this.logger.info(
      { machineId: result.machineId, machineName: result.machineName },
      'Machine paired',
    );
    this.closeActiveConnectionAfterRePair(result.machineId);
    return sendJson(res, 201, {
      machineId: result.machineId,
      machineName: result.machineName,
      machineSecret,
      serverProtocol: SUPPORTED_PROTOCOL_RANGE,
      heartbeatSec: HEARTBEAT_SEC,
    });
  }

  // ── WS upgrade + auth ──

  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (!req.url || new URL(req.url, 'http://localhost').pathname !== '/daemon/ws') {
      socket.destroy();
      return;
    }
    void this.authenticateAndAccept(req, socket, head).catch((err) => {
      this.logger.error({ err }, 'Daemon gateway upgrade authentication failed');
      try {
        socket.destroy();
      } catch {
        // best-effort
      }
    });
  }

  private async authenticateAndAccept(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    const auth = req.headers.authorization;
    const creds = parseBearer(auth);
    if (!creds) {
      return rejectUpgrade(socket, 401);
    }
    const { machineId, secret } = creds;

    const [machine] = await this.db
      .select()
      .from(machines)
      .where(eq(machines.id, machineId))
      .limit(1);

    // Uniform 401: unknown machine, secret mismatch, or revoked all look the same.
    if (
      !machine ||
      machine.status === 'revoked' ||
      machine.secretHash !== hashMachineSecret(secret)
    ) {
      return rejectUpgrade(socket, 401);
    }

    const wss = this.wss;
    if (!wss) {
      return rejectUpgrade(socket, 503);
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      this.onSocketAuthenticated(ws, machineId);
    });
  }

  private onSocketAuthenticated(ws: WebSocket, machineId: string): void {
    const conn: MachineConnection = {
      machineId,
      socket: ws,
      helloDone: false,
      lastInboundAt: Date.now(),
      strikes: 0,
      connectedAt: Date.now(),
    };

    // First frame must be `hello` within the timeout, else close.
    const helloTimer = setTimeout(() => {
      if (!conn.helloDone) {
        this.logger.info({ machineId }, 'hello timeout, closing socket');
        try {
          ws.close(4002, 'hello timeout');
        } catch {
          // best-effort
        }
      }
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref();

    ws.on('message', (data) => {
      conn.lastInboundAt = Date.now();
      const raw = typeof data === 'string' ? data : data.toString('utf8');
      const parsed = parseRawFrame(raw);
      if (!parsed.ok) {
        conn.strikes += 1;
        this.logger.warn(
          { machineId, strikes: conn.strikes, error: parsed.error },
          'Malformed frame from daemon',
        );
        if (conn.strikes >= MAX_FRAME_STRIKES) {
          try {
            ws.close(1002, 'too many malformed frames');
          } catch {
            // best-effort
          }
        }
        return;
      }
      void this.onFrame(conn, parsed.frame, helloTimer).catch((err) => {
        this.logger.error(
          { machineId, frameType: parsed.frame.type, err },
          'Daemon frame handling failed',
        );
      });
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.onSocketClosed(conn);
    });
    ws.on('error', (err) => {
      this.logger.warn({ machineId, err }, 'Daemon socket error');
    });
  }

  private async onFrame(
    conn: MachineConnection,
    frame: Frame,
    helloTimer: NodeJS.Timeout,
  ): Promise<void> {
    if (!conn.helloDone) {
      if (frame.type !== 'hello') {
        try {
          conn.socket.close(4003, 'expected hello first');
        } catch {
          // best-effort
        }
        return;
      }
      clearTimeout(helloTimer);
      await this.handleHello(conn, frame);
      return;
    }

    switch (frame.type) {
      case 'ping':
        this.sendToMachine(conn.machineId, build.pong(frame.seq));
        return;
      case 'task_accepted':
      case 'task_rejected':
      case 'task_event':
      case 'task_lost':
      case 'artifacts':
        this.routeDispatchFrame(conn, frame);
        return;
      default:
        // hello after hello / unexpected s→d frame echoed back: ignore.
        return;
    }
  }

  private async handleHello(conn: MachineConnection, hello: HelloFrame): Promise<void> {
    if (!isProtocolCompatible(hello.protocolVersion, SUPPORTED_PROTOCOL_RANGE)) {
      this.sendFrame(
        conn.socket,
        build.helloError(
          'protocol_incompatible',
          `server supports protocol ${SUPPORTED_PROTOCOL_RANGE.min}-${SUPPORTED_PROTOCOL_RANGE.max}; ` +
            `upgrade with: npx @open-tag/daemon@latest`,
        ),
      );
      conn.socket.close(4000, 'protocol_incompatible');
      return;
    }

    // Supersede an existing connection for the same machine (D14): newest wins.
    const previous = this.connections.get(conn.machineId);
    if (previous && previous.socket !== conn.socket) {
      this.sendFrame(previous.socket, build.helloError('superseded', 'replaced by a newer connection'));
      try {
        previous.socket.close(4001, 'superseded');
      } catch {
        // best-effort
      }
      this.connections.delete(conn.machineId);
    }

    // Persist the online flip BEFORE registering the connection: if the DB
    // write fails we close the socket (daemon reconnects per its backoff)
    // instead of leaving a half-handshaken socket that isMachineOnline()
    // would route dispatches to without ever sending hello_ok.
    try {
      await this.markMachineOnline(conn.machineId, hello);
    } catch (err) {
      this.logger.error(
        { machineId: conn.machineId, err },
        'hello failed: could not mark machine online; closing socket',
      );
      try {
        conn.socket.close(1011, 'server error');
      } catch {
        // best-effort
      }
      return;
    }
    conn.helloDone = true;
    this.connections.set(conn.machineId, conn);

    // Reconcile in-flight dispatches against the daemon's running set (D12).
    const ownedDispatchIds = this.dispatchIdsForMachine(conn.machineId);
    const running = new Set(hello.runningDispatchIds);
    const resumeDispatchIds = ownedDispatchIds.filter((id) => running.has(id));
    // Dispatches the daemon claims but the server no longer owns ⇒ ask to cancel.
    const cancelDispatchIds = hello.runningDispatchIds.filter((id) => !this.bridges.has(id));

    this.sendFrame(
      conn.socket,
      build.helloOk({ heartbeatSec: HEARTBEAT_SEC, resumeDispatchIds, cancelDispatchIds }),
    );

    // Notify bridges: reconnected dispatches resume; restarted ones (owned but
    // absent from runningDispatchIds) are told the daemon lost them.
    for (const dispatchId of ownedDispatchIds) {
      const bridge = this.bridges.get(dispatchId);
      if (!bridge) continue;
      if (running.has(dispatchId)) {
        bridge.onConnected();
      } else {
        // Daemon restarted without this dispatch ⇒ synthesise a task_lost so the
        // adapter fails the task immediately rather than waiting out the grace.
        bridge.onFrame({
          v: 1,
          id: randomUUID(),
          ts: new Date().toISOString(),
          type: 'task_lost',
          dispatchId,
        });
      }
    }
  }

  private routeDispatchFrame(
    conn: MachineConnection,
    frame: Extract<
      Frame,
      { type: 'task_accepted' | 'task_rejected' | 'task_event' | 'task_lost' | 'artifacts' }
    >,
  ): void {
    const bridge = this.bridges.get(frame.dispatchId);
    if (!bridge) {
      // Terminal/unknown dispatch: ack task_events on the originating socket so
      // the daemon stops replaying (loop's "already terminal" discipline), then
      // drop everything else.
      if (frame.type === 'task_event') {
        this.sendFrame(conn.socket, build.eventAck(frame.dispatchId, frame.seq));
      }
      return;
    }
    bridge.onFrame(frame);
  }

  private onSocketClosed(conn: MachineConnection): void {
    const current = this.connections.get(conn.machineId);
    if (current === conn) {
      this.connections.delete(conn.machineId);
      void this.markMachineOffline(conn.machineId);
      // Notify owned dispatches so their grace window starts.
      for (const dispatchId of this.dispatchIdsForMachine(conn.machineId)) {
        try {
          this.bridges.get(dispatchId)?.onDisconnected();
        } catch (err) {
          this.logger.error({ dispatchId, err }, 'Dispatch bridge onDisconnected failed');
        }
      }
    }
  }

  private closeActiveConnectionAfterRePair(machineId: string): void {
    const conn = this.connections.get(machineId);
    if (!conn) return;
    this.sendFrame(
      conn.socket,
      build.helloError('superseded', 'machine credentials rotated by a new pairing'),
    );
    this.connections.delete(machineId);
    void this.markMachineOffline(machineId);
    for (const dispatchId of this.dispatchIdsForMachine(machineId)) {
      try {
        this.bridges.get(dispatchId)?.onDisconnected();
      } catch (err) {
        this.logger.error({ dispatchId, err }, 'Dispatch bridge onDisconnected failed');
      }
    }
    try {
      conn.socket.close(4001, 'superseded');
    } catch {
      // best-effort
    }
  }

  private dispatchIdsForMachine(machineId: string): string[] {
    const ids: string[] = [];
    for (const [dispatchId, bridge] of this.bridges) {
      if (bridge.machineId === machineId) ids.push(dispatchId);
    }
    return ids;
  }

  // ── Liveness + revocation ──

  private async livenessTick(): Promise<void> {
    // Re-entrancy guard: a tick slower than the interval (e.g. a slow DB) must
    // not stack concurrent sweeps. Errors are contained per connection — this
    // method is invoked fire-and-forget and must never reject.
    if (this.livenessTickInFlight) return;
    this.livenessTickInFlight = true;
    try {
      await this.livenessSweep();
    } catch (err) {
      this.logger.error({ err }, 'Daemon gateway liveness tick failed');
    } finally {
      this.livenessTickInFlight = false;
    }
  }

  private async livenessSweep(): Promise<void> {
    const now = Date.now();
    for (const conn of [...this.connections.values()]) {
      try {
        await this.sweepConnection(conn, now);
      } catch (err) {
        this.logger.error(
          { machineId: conn.machineId, err },
          'Liveness sweep failed for connection; will retry next tick',
        );
      }
    }
  }

  private async sweepConnection(conn: MachineConnection, now: number): Promise<void> {
    if (now - conn.lastInboundAt > LIVENESS_TIMEOUT_MS) {
      this.logger.info({ machineId: conn.machineId }, 'Liveness timeout, terminating socket');
      try {
        conn.socket.terminate();
      } catch {
        // best-effort
      }
      // close handler runs onSocketClosed which marks offline.
      return;
    }
    // Revocation + server-initiated disconnect both propagate within ≤ one tick
    // (reusing the existing tick means up to ~one tick of latency, acceptable for
    // a manual admin action — D-A9). Load both the status and the disconnect
    // signal in one read.
    const [row] = await this.db
      .select({
        status: machines.status,
        disconnectRequestedAt: machines.disconnectRequestedAt,
      })
      .from(machines)
      .where(eq(machines.id, conn.machineId))
      .limit(1);

    // Revocation (fatal): close sockets whose row turned 'revoked' while connected.
    if (!row || row.status === 'revoked') {
      this.sendFrame(conn.socket, build.helloError('revoked', 'machine revoked'));
      try {
        conn.socket.close(4004, 'revoked');
      } catch {
        // best-effort
      }
      return;
    }

    // Server-initiated disconnect (D-A9): close the CURRENT socket when a
    // disconnect was requested AFTER this connection was accepted. The
    // `connectedAt` guard ensures a stale request from a prior session never
    // tears down a fresh reconnection. This is NOT a revoke — credentials stay
    // valid (no helloError frame, an ordinary close code) so the daemon may
    // reconnect per its own backoff; mark the machine offline so it shows
    // offline immediately instead of waiting out the 45s heartbeat timeout.
    const requestedAt = row.disconnectRequestedAt?.getTime();
    if (requestedAt != null && requestedAt > conn.connectedAt) {
      this.logger.info(
        { machineId: conn.machineId },
        'Server-initiated disconnect, closing socket',
      );
      try {
        conn.socket.close(SERVER_DISCONNECT_CLOSE_CODE, SERVER_DISCONNECT_REASON);
      } catch {
        // best-effort
      }
      // close handler runs onSocketClosed which removes the connection and marks
      // the machine offline.
    }
  }

  private async markMachineOnline(machineId: string, hello: HelloFrame): Promise<void> {
    await this.db
      .update(machines)
      .set({
        status: 'online',
        lastSeenAt: new Date(),
        capabilities: {
          runtimes: hello.capabilities.runtimes,
          features: hello.capabilities.features ?? [],
          platform: hello.capabilities.platform,
          hostname: hello.capabilities.hostname,
          daemonVersion: hello.capabilities.daemonVersion,
          protocolVersion: hello.capabilities.protocolVersion ?? hello.protocolVersion,
        },
        updatedAt: new Date(),
      })
      .where(eq(machines.id, machineId));
  }

  private async markMachineOffline(machineId: string): Promise<void> {
    // Invoked fire-and-forget from socket close paths — must never reject.
    try {
      // Do not flip a 'revoked' machine back to 'offline'.
      await this.db
        .update(machines)
        .set({ status: 'offline', lastSeenAt: new Date(), updatedAt: new Date() })
        .where(and(eq(machines.id, machineId), eq(machines.status, 'online')));
    } catch (err) {
      this.logger.error({ machineId, err }, 'Failed to mark machine offline');
    }
  }

  private sendFrame(ws: WebSocket, frame: Frame): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(serializeFrame(frame));
    } catch (err) {
      this.logger.warn({ err }, 'Failed to send frame');
    }
  }
}

// ── helpers ──

/** Sentinel thrown to roll back the token claim when the machine name is taken. */
class NameTakenError extends Error {
  constructor() {
    super('machine name taken');
    this.name = 'NameTakenError';
  }
}

/** Sentinel thrown to roll back the token claim when a concurrent re-pair wins first. */
class PairingConflictError extends Error {
  constructor() {
    super('machine pairing conflict');
    this.name = 'PairingConflictError';
  }
}

/** Sentinel thrown to roll back malformed token rows with no unambiguous owner. */
class InvalidPairingTokenOwnershipError extends Error {
  constructor() {
    super('invalid pairing token ownership');
    this.name = 'InvalidPairingTokenOwnershipError';
  }
}

function defaultMachineName(): string {
  return `machine-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMachineName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.trim().replace(/\s+/g, ' ');
  return name.length > 0 ? name : null;
}

function machineMatchesOwner(
  row: {
    tenantKey: string;
    platformOwnerId: string | null;
    ownerOpenId: string | null;
    name: string;
  },
  expected: {
    tenantKey: string;
    platformOwnerId: string | null;
    ownerOpenId: string | null;
    name: string;
  },
): boolean {
  return (
    row.tenantKey === expected.tenantKey &&
    row.platformOwnerId === expected.platformOwnerId &&
    row.ownerOpenId === expected.ownerOpenId &&
    row.name === expected.name
  );
}

function normalizeCapabilities(input: unknown): {
  runtimes: string[];
  features: string[];
  platform?: string;
  hostname?: string;
  daemonVersion?: string;
  protocolVersion?: number;
} {
  if (!input || typeof input !== 'object') return { runtimes: [], features: [] };
  const obj = input as Record<string, unknown>;
  const runtimes = Array.isArray(obj.runtimes)
    ? obj.runtimes.filter((r): r is string => typeof r === 'string')
    : [];
  const features = Array.isArray(obj.features)
    ? obj.features.filter((feature): feature is string => typeof feature === 'string')
    : [];
  return {
    runtimes,
    features,
    platform: typeof obj.platform === 'string' ? obj.platform : undefined,
    hostname: typeof obj.hostname === 'string' ? obj.hostname : undefined,
    daemonVersion: typeof obj.daemonVersion === 'string' ? obj.daemonVersion : undefined,
    protocolVersion: typeof obj.protocolVersion === 'number' ? obj.protocolVersion : undefined,
  };
}

function parseBearer(header: string | undefined): { machineId: string; secret: string } | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const value = match[1];
  const dot = value.indexOf('.');
  if (dot <= 0 || dot >= value.length - 1) return null;
  return { machineId: value.slice(0, dot), secret: value.slice(dot + 1) };
}

function rejectUpgrade(socket: Socket, status: number): void {
  const text = status === 401 ? 'Unauthorized' : status === 503 ? 'Service Unavailable' : 'Error';
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const MAX = 2 * 1024 * 1024;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX) throw new Error('body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
