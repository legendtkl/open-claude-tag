// apps/api/src/ws-watchdog.ts
import { createLogger } from '@open-tag/observability';

export interface WsWatchdogConfig {
  /** Initial stale threshold in ms. Default: WS_STALE_BASE_MS env or 600_000 (10 min) */
  baseThresholdMs?: number;
  /** Maximum threshold after backoff. Default: WS_STALE_MAX_MS env or 3_600_000 (60 min) */
  maxThresholdMs?: number;
  /** Backoff multiplier per restart. Default: WS_STALE_BACKOFF env or 2 */
  backoffFactor?: number;
  /** Check interval in ms. Default: 60_000 */
  checkIntervalMs?: number;
}

export interface WsWatchdogStatus {
  status: 'connected' | 'stale';
  lastActivityAt: string;
  restartCount: number;
  currentThresholdMs: number;
}

const logger = createLogger('ws-watchdog');

export class WsWatchdog {
  private lastActivityAt: number;
  private restartCount = 0;
  private currentThresholdMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly baseThresholdMs: number;
  private readonly maxThresholdMs: number;
  private readonly backoffFactor: number;
  private readonly checkIntervalMs: number;

  constructor(config: WsWatchdogConfig = {}) {
    this.baseThresholdMs =
      config.baseThresholdMs ??
      parseInt(process.env.WS_STALE_BASE_MS ?? '600000', 10);
    this.maxThresholdMs =
      config.maxThresholdMs ??
      parseInt(process.env.WS_STALE_MAX_MS ?? '3600000', 10);
    this.backoffFactor =
      config.backoffFactor ??
      parseFloat(process.env.WS_STALE_BACKOFF ?? '2');
    this.checkIntervalMs = config.checkIntervalMs ?? 60_000;

    this.currentThresholdMs = this.baseThresholdMs;
    this.lastActivityAt = Date.now();
  }

  start(createWsClient: () => void, closeWsClient?: () => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const elapsed = Date.now() - this.lastActivityAt;
      if (elapsed <= this.currentThresholdMs) return;

      logger.warn(
        { elapsed, currentThresholdMs: this.currentThresholdMs, restartCount: this.restartCount },
        'WsWatchdog: stale connection detected, restarting WSClient',
      );

      if (closeWsClient) {
        try {
          closeWsClient();
        } catch (err) {
          logger.warn({ err }, 'WsWatchdog: error closing old WSClient');
        }
      }

      createWsClient();
      this.restartCount++;
      this.currentThresholdMs = Math.min(
        this.currentThresholdMs * this.backoffFactor,
        this.maxThresholdMs,
      );
      // Reset lastActivityAt so we don't immediately re-trigger
      this.lastActivityAt = Date.now();

      logger.info(
        { restartCount: this.restartCount, nextThresholdMs: this.currentThresholdMs },
        'WsWatchdog: WSClient restarted',
      );
    }, this.checkIntervalMs);

    this.timer.unref?.();
    logger.info(
      { baseThresholdMs: this.baseThresholdMs, maxThresholdMs: this.maxThresholdMs },
      'WsWatchdog started',
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('WsWatchdog stopped');
    }
  }

  recordActivity(): void {
    this.lastActivityAt = Date.now();
    if (this.currentThresholdMs !== this.baseThresholdMs) {
      this.currentThresholdMs = this.baseThresholdMs;
      logger.info(
        { currentThresholdMs: this.currentThresholdMs },
        'WsWatchdog: activity received, threshold reset to base',
      );
    }
  }

  getStatus(): WsWatchdogStatus {
    const elapsed = Date.now() - this.lastActivityAt;
    let status: WsWatchdogStatus['status'] = 'connected';
    if (elapsed > this.currentThresholdMs) {
      status = 'stale';
    }
    return {
      status,
      lastActivityAt: new Date(this.lastActivityAt).toISOString(),
      restartCount: this.restartCount,
      currentThresholdMs: this.currentThresholdMs,
    };
  }
}
