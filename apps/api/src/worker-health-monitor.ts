import { createLogger } from '@open-tag/observability';
import type { FeishuClient } from '@open-tag/feishu-adapter';
import { readPidRecord, startManagedService } from './service-process.js';
import type { ServicePidRecord } from './service-process.js';

const logger = createLogger('worker-health-monitor');

export type WorkerStatus = 'unknown' | 'healthy' | 'degraded' | 'down';

export interface WorkerHealthSnapshot {
  status: WorkerStatus;
  pid?: number;
  lastHeartbeat?: string;
  uptimeSeconds?: number;
}

export interface WorkerHealthMonitorConfig {
  /** Check interval in ms (default 30000) */
  intervalMs?: number;
  /** Heartbeat interval the worker uses in ms (default 10000) */
  workerHeartbeatMs?: number;
  /** Chat ID for alerts (default: ALERT_CHAT_ID env) */
  alertChatId?: string;
  /** Feishu client for sending alerts */
  feishuClient?: FeishuClient;
  /** Instance ID for alert messages */
  instanceId?: string;
  /**
   * Enable automatic worker restart when status transitions to 'down'.
   * Default: WORKER_AUTO_RESTART env === 'true', or false.
   */
  autoRestart?: boolean;
  /**
   * Repo root path used to spawn the worker process. Required when autoRestart is true.
   * Default: OPEN_TAG_REPO_ROOT env or process.cwd().
   */
  repoRoot?: string;
  /**
   * Minimum ms between consecutive auto-restart attempts.
   * Default: WORKER_RESTART_COOLDOWN_MS env or 30_000.
   */
  restartCooldownMs?: number;
}

export class WorkerHealthMonitor {
  private status: WorkerStatus = 'unknown';
  private consecutiveFailures = 0;
  private consecutiveDegradedChecks = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPidRecord: ServicePidRecord | null = null;
  private restartCount = 0;
  private lastRestartAt = 0;

  private readonly intervalMs: number;
  private readonly heartbeatMs: number;
  private readonly alertChatId: string;
  private readonly feishuClient: FeishuClient | null;
  private readonly instanceId: string;
  private readonly autoRestart: boolean;
  private readonly repoRoot: string;
  private readonly restartCooldownMs: number;

  constructor(config: WorkerHealthMonitorConfig = {}) {
    this.intervalMs = config.intervalMs
      ?? parseInt(process.env.WORKER_MONITOR_INTERVAL_MS ?? '30000', 10);
    this.heartbeatMs = config.workerHeartbeatMs
      ?? parseInt(process.env.OPEN_TAG_SERVICE_HEARTBEAT_MS ?? '10000', 10);
    this.alertChatId = config.alertChatId ?? process.env.ALERT_CHAT_ID ?? '';
    this.feishuClient = config.feishuClient ?? null;
    this.instanceId = config.instanceId ?? process.env.OPEN_TAG_INSTANCE_ID ?? 'primary';
    this.autoRestart = config.autoRestart ?? (process.env.WORKER_AUTO_RESTART === 'true');
    this.repoRoot = config.repoRoot ?? (process.env.OPEN_TAG_REPO_ROOT ?? process.cwd());
    this.restartCooldownMs = config.restartCooldownMs
      ?? parseInt(process.env.WORKER_RESTART_COOLDOWN_MS ?? '30000', 10);
  }

  start(): void {
    if (this.timer) return;
    logger.info({ intervalMs: this.intervalMs }, 'Worker health monitor started');
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref();
    // Run an initial check immediately
    this.check();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Worker health monitor stopped');
    }
  }

  getSnapshot(): WorkerHealthSnapshot {
    const snapshot: WorkerHealthSnapshot = { status: this.status };
    if (this.lastPidRecord) {
      snapshot.pid = this.lastPidRecord.pid;
      snapshot.lastHeartbeat = new Date(this.lastPidRecord.lastHeartbeatAt).toISOString();
      snapshot.uptimeSeconds = Math.floor(
        (Date.now() - this.lastPidRecord.startedAt) / 1000,
      );
    }
    return snapshot;
  }

  private check(): void {
    const record = readPidRecord('worker');

    if (!record) {
      this.handleFailure('PID file not found');
      return;
    }

    if (!isProcessAlive(record.pid)) {
      this.handleFailure(`Process ${record.pid} is not alive`);
      return;
    }

    // Process is alive — check heartbeat staleness
    this.lastPidRecord = record;
    const staleThreshold = this.heartbeatMs * 5;
    const elapsed = Date.now() - record.lastHeartbeatAt;

    if (elapsed > staleThreshold) {
      this.consecutiveFailures = 0;
      this.consecutiveDegradedChecks++;
      if (this.consecutiveDegradedChecks >= 2) {
        this.transitionTo('degraded');
      }
      return;
    }

    // Heartbeat is fresh — reset both counters
    this.consecutiveFailures = 0;
    this.consecutiveDegradedChecks = 0;
    this.transitionTo('healthy');
  }

  private handleFailure(reason: string): void {
    this.consecutiveFailures++;
    this.consecutiveDegradedChecks = 0;
    logger.debug({ reason, consecutiveFailures: this.consecutiveFailures }, 'Health check failure');

    if (this.consecutiveFailures >= 2) {
      this.transitionTo('down');
    }
    // Single failure: don't change status yet (hysteresis)
  }

  private transitionTo(newStatus: WorkerStatus): void {
    const prevStatus = this.status;
    if (prevStatus === newStatus) return;

    this.status = newStatus;
    logger.info({ from: prevStatus, to: newStatus }, 'Worker status changed');

    if (newStatus === 'down' && prevStatus !== 'down') {
      this.onWorkerDown();
    } else if (newStatus === 'healthy' && prevStatus === 'down') {
      this.onWorkerRecovered();
    }
  }

  private onWorkerDown(): void {
    const timestamp = new Date().toISOString();
    const pid = this.lastPidRecord?.pid ?? 'unknown';

    if (!this.alertChatId) {
      logger.warn(
        { instanceId: this.instanceId, pid, timestamp },
        'Worker is DOWN but ALERT_CHAT_ID is not configured, skipping Feishu alert',
      );
    } else if (!this.feishuClient) {
      logger.warn('Worker is DOWN but no Feishu client configured');
    } else {
      const text = `⚠️ Worker DOWN\nInstance: ${this.instanceId}\nLast known PID: ${pid}\nDetected at: ${timestamp}`;
      this.feishuClient
        .sendMessage('chat_id', this.alertChatId, { msg_type: 'text', content: { text } })
        .catch((err) => logger.error({ err }, 'Failed to send worker-down alert'));
    }

    if (!this.autoRestart) return;

    const timeSinceLast = Date.now() - this.lastRestartAt;
    if (this.lastRestartAt > 0 && timeSinceLast < this.restartCooldownMs) {
      logger.warn(
        { timeSinceLast, restartCooldownMs: this.restartCooldownMs },
        'Worker auto-restart skipped: within cooldown window',
      );
      return;
    }

    const childPid = startManagedService('worker', this.repoRoot, logger);
    this.lastRestartAt = Date.now();
    this.restartCount++;
    logger.info({ restartCount: this.restartCount, childPid }, 'Worker auto-restart initiated');
  }

  private onWorkerRecovered(): void {
    const timestamp = new Date().toISOString();
    const wasAutoRestarted = this.autoRestart && this.restartCount > 0;

    if (!this.alertChatId || !this.feishuClient) {
      logger.info({ timestamp, wasAutoRestarted, restartCount: this.restartCount }, 'Worker recovered');
      return;
    }

    const text = wasAutoRestarted
      ? `✅ Worker RECOVERED (auto-restarted ${this.restartCount}x)\nInstance: ${this.instanceId}\nRecovered at: ${timestamp}`
      : `✅ Worker RECOVERED\nInstance: ${this.instanceId}\nRecovered at: ${timestamp}`;
    this.feishuClient
      .sendMessage('chat_id', this.alertChatId, { msg_type: 'text', content: { text } })
      .catch((err) => logger.error({ err }, 'Failed to send worker-recovery alert'));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'ESRCH'
    ) {
      return false;
    }
    throw error;
  }
}
