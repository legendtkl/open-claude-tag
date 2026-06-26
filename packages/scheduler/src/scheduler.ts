// Server-side admission no longer throttles concurrency by default. Physical
// capacity is enforced per-machine by the daemon's dispatch cap
// (OPEN_TAG_DAEMON_MAX_CONCURRENT_DISPATCHES); the server admits freely and
// lets the daemon reject with `busy` when a machine is full. Operators can still
// re-impose limits via AGENT_MAX_CONCURRENCY / MAX_CONCURRENT_AGENT_STARTS /
// AGENT_START_INTERVAL_MS. Duplicate-task suppression always remains in effect.
export const DEFAULT_AGENT_MAX_CONCURRENCY = Number.POSITIVE_INFINITY;
export const DEFAULT_MAX_CONCURRENT_AGENT_STARTS = Number.POSITIVE_INFINITY;
export const DEFAULT_AGENT_START_INTERVAL_MS = 0;

export interface SchedulerConfig {
  agentMaxConcurrency: number;
  maxConcurrentAgentStarts: number;
  agentStartIntervalMs: number;
  now?: () => number;
}

export interface SchedulerEnv {
  AGENT_MAX_CONCURRENCY?: string;
  MAX_CONCURRENT_AGENT_STARTS?: string;
  AGENT_START_INTERVAL_MS?: string;
}

export interface AdmissionHandle {
  taskId: string;
  agentId: string;
  releaseStartSlot(): void;
  releaseRunningSlot(): void;
}

export type AdmissionDecision =
  | { admitted: true; handle: AdmissionHandle }
  | {
      admitted: false;
      reason: 'duplicate' | 'agent_concurrency' | 'cold_start';
      retryAfterMs: number;
    };

export interface SchedulerSnapshot {
  runningByAgent: Record<string, number>;
  startingCount: number;
  admittedTaskCount: number;
  nextStartAt: number;
}

interface AdmittedTaskState {
  agentId: string;
  startSlotHeld: boolean;
  runningSlotHeld: boolean;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function parseSchedulerConfigFromEnv(
  env: SchedulerEnv = process.env,
  overrides: Partial<Pick<SchedulerConfig, 'now'>> = {},
): SchedulerConfig {
  return {
    agentMaxConcurrency: parsePositiveInteger(
      env.AGENT_MAX_CONCURRENCY,
      DEFAULT_AGENT_MAX_CONCURRENCY,
      'AGENT_MAX_CONCURRENCY',
    ),
    maxConcurrentAgentStarts: parsePositiveInteger(
      env.MAX_CONCURRENT_AGENT_STARTS,
      DEFAULT_MAX_CONCURRENT_AGENT_STARTS,
      'MAX_CONCURRENT_AGENT_STARTS',
    ),
    agentStartIntervalMs: parseNonNegativeInteger(
      env.AGENT_START_INTERVAL_MS,
      DEFAULT_AGENT_START_INTERVAL_MS,
      'AGENT_START_INTERVAL_MS',
    ),
    now: overrides.now,
  };
}

export class AgentAdmissionScheduler {
  private readonly config: Required<SchedulerConfig>;
  private readonly runningByAgent = new Map<string, number>();
  private readonly admittedTasks = new Map<string, AdmittedTaskState>();
  private startingCount = 0;
  private nextStartAt = 0;

  constructor(config: SchedulerConfig) {
    this.config = {
      ...config,
      now: config.now ?? Date.now,
    };
  }

  admit(input: { taskId: string; agentId: string }): AdmissionDecision {
    const taskKey = this.taskKey(input.agentId, input.taskId);
    if (this.admittedTasks.has(taskKey)) {
      return { admitted: false, reason: 'duplicate', retryAfterMs: 0 };
    }

    const running = this.runningByAgent.get(input.agentId) ?? 0;
    if (running >= this.config.agentMaxConcurrency) {
      return {
        admitted: false,
        reason: 'agent_concurrency',
        retryAfterMs: this.retryDelayMs(),
      };
    }

    const now = this.config.now();
    if (this.startingCount >= this.config.maxConcurrentAgentStarts || now < this.nextStartAt) {
      return {
        admitted: false,
        reason: 'cold_start',
        retryAfterMs: Math.max(1, this.nextStartAt - now, this.config.agentStartIntervalMs),
      };
    }

    this.startingCount += 1;
    this.runningByAgent.set(input.agentId, running + 1);
    this.nextStartAt = now + this.config.agentStartIntervalMs;
    this.admittedTasks.set(taskKey, {
      agentId: input.agentId,
      startSlotHeld: true,
      runningSlotHeld: true,
    });

    return {
      admitted: true,
      handle: {
        taskId: input.taskId,
        agentId: input.agentId,
        releaseStartSlot: () => this.releaseStartSlot(taskKey),
        releaseRunningSlot: () => this.releaseRunningSlot(taskKey),
      },
    };
  }

  snapshot(): SchedulerSnapshot {
    return {
      runningByAgent: Object.fromEntries(this.runningByAgent),
      startingCount: this.startingCount,
      admittedTaskCount: this.admittedTasks.size,
      nextStartAt: this.nextStartAt,
    };
  }

  private retryDelayMs(): number {
    const now = this.config.now();
    return Math.max(1, this.nextStartAt - now, this.config.agentStartIntervalMs);
  }

  private releaseStartSlot(taskKey: string): void {
    const state = this.admittedTasks.get(taskKey);
    if (!state?.startSlotHeld) return;
    state.startSlotHeld = false;
    this.startingCount = Math.max(0, this.startingCount - 1);
  }

  private releaseRunningSlot(taskKey: string): void {
    const state = this.admittedTasks.get(taskKey);
    if (!state?.runningSlotHeld) return;
    state.runningSlotHeld = false;
    const current = this.runningByAgent.get(state.agentId) ?? 0;
    if (current <= 1) {
      this.runningByAgent.delete(state.agentId);
    } else {
      this.runningByAgent.set(state.agentId, current - 1);
    }
    this.releaseStartSlot(taskKey);
    this.admittedTasks.delete(taskKey);
  }

  private taskKey(agentId: string, taskId: string): string {
    return `${agentId}:${taskId}`;
  }
}
