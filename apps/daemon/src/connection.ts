import { WebSocket } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  parseRawFrame,
  PROTOCOL_VERSION,
  type Capabilities,
  type Frame,
  type HelloOkFrame,
  type HelloErrorFrame,
} from '@open-tag/daemon-protocol';
import type { RuntimeManager } from '@open-tag/runtime-adapters';
import { logger } from './logger.js';
import type { DaemonConfig } from './config.js';
import { probeCapabilities } from './capabilities.js';
import { DAEMON_VERSION } from './version.js';
import { Backoff } from './backoff.js';
import { DispatchManager, type FrameSink } from './dispatch-manager.js';
import { helloFrame, pingFrame, taskLostFrame } from './frame-factory.js';

/** Heartbeat cadence and inbound-silence deadline (design D16). */
export const PING_INTERVAL_MS = 15_000;
export const INBOUND_SILENCE_DEADLINE_MS = 45_000;

/** A non-recoverable connection outcome that should stop the daemon. */
export class FatalConnectionError extends Error {
  constructor(
    message: string,
    /** Suggested process exit code. */
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'FatalConnectionError';
  }
}

export interface ConnectionManagerOptions {
  config: DaemonConfig;
  runtimeManager: RuntimeManager;
  /** WebSocket constructor, injectable for tests. */
  wsFactory?: (url: string, headers: Record<string, string>, proxy?: string) => WebSocket;
  backoff?: Backoff;
  pingIntervalMs?: number;
  inboundSilenceDeadlineMs?: number;
  /** Resolves a proxy URL for the target; defaults to HTTPS_PROXY honoring NO_PROXY. */
  resolveProxy?: (targetUrl: string) => string | undefined;
  /** Called after the server accepts hello; used by the background parent handshake. */
  onReady?: () => void;
}

/**
 * Rewrites an http(s) server URL to the ws(s) `/daemon/ws` endpoint.
 */
export function toWsUrl(serverUrl: string): string {
  const trimmed = serverUrl.replace(/\/+$/, '');
  const ws = trimmed.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  return `${ws}/daemon/ws`;
}

/**
 * Returns the proxy URL to use for `targetUrl`, honoring `HTTPS_PROXY`/`ALL_PROXY`
 * and the `NO_PROXY` exclusion list (design D2). Returns undefined when the host
 * is excluded or no proxy is configured.
 */
export function resolveProxyForTarget(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const proxy =
    env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? undefined;
  if (!proxy) return undefined;

  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? '').trim();
  if (noProxy === '*') return undefined;
  if (noProxy) {
    let host: string;
    try {
      host = new URL(targetUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')).hostname;
    } catch {
      host = '';
    }
    const entries = noProxy
      .split(',')
      .map((e) => e.trim().replace(/^\./, ''))
      .filter(Boolean);
    if (entries.some((e) => host === e || host.endsWith(`.${e}`))) {
      return undefined;
    }
  }
  return proxy;
}

function defaultWsFactory(
  url: string,
  headers: Record<string, string>,
  proxy?: string,
): WebSocket {
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  return new WebSocket(url, { headers, agent });
}

/**
 * Manages the daemon's single outbound WebSocket (design §8, D16).
 *
 * Connect → `hello` → `hello_ok` reconcile → heartbeat + inbound watchdog.
 * Reconnects with jittered exponential backoff; resets backoff on a clean hello.
 * `hello_error` codes are fatal (protocol_incompatible / revoked / superseded).
 * Disconnects do NOT kill running runtimes (D12) — the `DispatchManager` keeps
 * its buffers and replays on the next hello.
 */
export class ConnectionManager implements FrameSink {
  private readonly config: DaemonConfig;
  private readonly wsFactory: NonNullable<ConnectionManagerOptions['wsFactory']>;
  private readonly backoff: Backoff;
  private readonly pingIntervalMs: number;
  private readonly inboundSilenceDeadlineMs: number;
  private readonly resolveProxy: (targetUrl: string) => string | undefined;
  private readonly onReady?: () => void;
  private readonly dispatchManager: DispatchManager;

  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInboundAt = 0;
  private pingSeq = 0;
  private stopped = false;
  private helloAcknowledged = false;
  private fatal: FatalConnectionError | null = null;
  private runResolve: (() => void) | null = null;
  private runReject: ((err: Error) => void) | null = null;
  /**
   * Probed once, then reused across reconnects. Capabilities (runtimes,
   * platform, versions) are static for the process lifetime, and probing codex
   * spawns a login shell — re-probing on every hello would spawn a shell on
   * every reconnect (the daemon's whole point is surviving flaps). Restart the
   * daemon to pick up a newly-installed runtime.
   */
  private capabilities: Capabilities | null = null;

  constructor(options: ConnectionManagerOptions) {
    this.config = options.config;
    this.wsFactory = options.wsFactory ?? defaultWsFactory;
    this.backoff = options.backoff ?? new Backoff();
    this.pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.inboundSilenceDeadlineMs =
      options.inboundSilenceDeadlineMs ?? INBOUND_SILENCE_DEADLINE_MS;
    this.resolveProxy = options.resolveProxy ?? ((url) => resolveProxyForTarget(url));
    this.onReady = options.onReady;
    this.dispatchManager = new DispatchManager(options.runtimeManager, this);
  }

  /** FrameSink: send a serialized frame. Returns false when the socket is down. */
  send(serialized: string): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(serialized);
      return true;
    }
    return false;
  }

  /**
   * Runs the connect/reconnect loop until {@link stop} or a fatal `hello_error`.
   * Resolves on a clean stop; rejects with {@link FatalConnectionError} on a
   * fatal protocol/auth outcome so the CLI can exit non-zero.
   */
  async run(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.runResolve = resolve;
      this.runReject = reject;
      this.connect();
    });
  }

  /** Graceful shutdown: cancel in-flight work, flush, close the socket. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    this.clearReconnectTimer();
    await this.dispatchManager.shutdown();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'daemon shutting down');
    }
    this.settleRun();
  }

  private settleRun(): void {
    if (this.fatal) {
      this.runReject?.(this.fatal);
    } else {
      this.runResolve?.();
    }
    this.runResolve = null;
    this.runReject = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const wsUrl = toWsUrl(this.config.serverUrl);
    const proxy = this.resolveProxy(wsUrl);
    const headers = {
      authorization: `Bearer ${this.config.machineId}.${this.config.machineSecret}`,
    };
    this.helloAcknowledged = false;

    let socket: WebSocket;
    try {
      socket = this.wsFactory(wsUrl, headers, proxy);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'WebSocket construction failed; scheduling reconnect',
      );
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.on('open', () => {
      logger.info({ proxied: Boolean(proxy) }, 'WebSocket connected; sending hello');
      this.lastInboundAt = Date.now();
      this.sendHello();
      this.startWatchdog();
    });
    socket.on('message', (data) => this.onMessage(data.toString()));
    socket.on('close', (code, reason) => this.onClose(code, reason.toString()));
    socket.on('error', (err) => {
      logger.warn({ err: err.message }, 'WebSocket error');
    });
  }

  private sendHello(): void {
    // Probe once; reuse across reconnects (see `capabilities` field).
    this.capabilities ??= probeCapabilities();
    this.send(
      helloFrame({
        machineId: this.config.machineId,
        protocolVersion: PROTOCOL_VERSION,
        daemonVersion: DAEMON_VERSION,
        capabilities: this.capabilities,
        runningDispatchIds: this.dispatchManager.runningDispatchIds(),
      }),
    );
  }

  private onMessage(raw: string): void {
    this.lastInboundAt = Date.now();
    const result = parseRawFrame(raw);
    if (!result.ok) {
      logger.warn({ error: result.error }, 'Dropping malformed inbound frame');
      return;
    }
    this.route(result.frame);
  }

  private route(frame: Frame): void {
    switch (frame.type) {
      case 'hello_ok':
        this.onHelloOk(frame);
        break;
      case 'hello_error':
        this.onHelloError(frame);
        break;
      case 'pong':
        // Liveness already refreshed by lastInboundAt; nothing else to do.
        break;
      case 'task_dispatch':
        void this.dispatchManager.handleDispatch(frame);
        break;
      case 'event_ack':
        this.dispatchManager.ack(frame.dispatchId, frame.lastSeq);
        break;
      case 'task_cancel':
        void this.dispatchManager.cancel(frame.dispatchId, frame.force ?? false);
        break;
      default:
        logger.debug({ type: frame.type }, 'Ignoring unexpected server frame');
    }
  }

  private onHelloOk(frame: HelloOkFrame): void {
    this.helloAcknowledged = true;
    this.backoff.reset();
    logger.info(
      {
        resume: frame.resumeDispatchIds.length,
        cancel: frame.cancelDispatchIds.length,
      },
      'hello_ok received; reconciling dispatches',
    );

    // Report dispatches the server still wants but we no longer know (daemon
    // restarted) as task_lost so the server fails them now (D12).
    const known = new Set(this.dispatchManager.runningDispatchIds());
    for (const dispatchId of frame.resumeDispatchIds) {
      if (!known.has(dispatchId)) {
        this.send(taskLostFrame(dispatchId));
      }
    }

    this.dispatchManager.reconcileOnReconnect(
      frame.resumeDispatchIds,
      frame.cancelDispatchIds,
    );
    this.onReady?.();
    this.startHeartbeat();
  }

  private onHelloError(frame: HelloErrorFrame): void {
    const hints: Record<typeof frame.code, { message: string; exit: number }> = {
      protocol_incompatible: {
        message: `Protocol incompatible: ${frame.message}. Upgrade the daemon: npx @open-tag/daemon@latest`,
        exit: 3,
      },
      revoked: {
        message: `This machine has been revoked: ${frame.message}. Re-pair from the admin console (Machines page → Generate pairing token).`,
        exit: 4,
      },
      superseded: {
        message: `Another daemon took over this machine: ${frame.message}.`,
        exit: 5,
      },
    };
    const hint = hints[frame.code];
    logger.error({ code: frame.code }, hint.message);
    this.fatal = new FatalConnectionError(hint.message, hint.exit);
    this.stopped = true;
    this.clearTimers();
    this.clearReconnectTimer();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, frame.code);
    }
    this.settleRun();
  }

  private onClose(code: number, reason: string): void {
    logger.warn({ code, reason }, 'WebSocket closed');
    this.clearTimers();
    this.ws = null;
    if (this.stopped) {
      this.settleRun();
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = this.backoff.next();
    logger.info({ delayMs: delay }, 'Scheduling reconnect');
    // Deliberately NOT unref'd: while disconnected this timer may be the only
    // handle keeping the event loop alive. An unref'd timer here lets the
    // process exit silently instead of reconnecting (observed in live smoke:
    // socket closed → all other timers cleared → loop drained → daemon gone).
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      this.send(pingFrame(this.pingSeq++));
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastInboundAt > this.inboundSilenceDeadlineMs) {
        logger.warn(
          { silenceMs: Date.now() - this.lastInboundAt },
          'Inbound silence exceeded deadline; terminating socket',
        );
        this.clearTimers();
        this.ws?.terminate();
        // `close` fires after terminate and schedules the reconnect.
      }
    }, this.pingIntervalMs);
    this.watchdogTimer.unref?.();
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    // The reconnect timer survives clearTimers() on purpose: onClose() clears
    // socket-scoped timers and then schedules the reconnect. It is cancelled
    // only by stop()/fatal paths via clearReconnectTimer().
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Test/diagnostic accessor for the dispatch manager. */
  get dispatches(): DispatchManager {
    return this.dispatchManager;
  }

  /** Whether the last hello was acknowledged (for status reporting). */
  get connected(): boolean {
    return this.helloAcknowledged && this.ws?.readyState === WebSocket.OPEN;
  }
}
