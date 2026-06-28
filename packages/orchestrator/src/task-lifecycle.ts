import { IntentType, TaskStatus } from '@open-tag/core-types';
import type { Database } from '@open-tag/storage';
import { transitionTask } from './orchestrator.js';

export interface TaskCreatedEvent {
  taskId: string;
  taskType: IntentType;
  sessionId?: string;
  summary: string;
  description?: string;
  localStatus: TaskStatus;
  tenantKey?: string;
  sourceMessageId?: string;
  sourceTopicKey?: string;
  chatId?: string;
  replyToMessageId?: string;
  requesterOpenId?: string;
  agentId?: string;
  feishuAppId?: string;
}

export interface TaskStatusChangedEvent {
  taskId: string;
  localStatus: TaskStatus;
  interactionReason?: string | null;
  agentId?: string;
  feishuAppId?: string;
}

export interface TaskLifecycleObserver {
  onTaskCreated?(event: TaskCreatedEvent): Promise<void>;
  onTaskStatusChanged?(event: TaskStatusChangedEvent): Promise<void>;
}

export interface TaskLifecycleLogger {
  warn(context: Record<string, unknown>, message?: string): void;
}

export class TaskLifecycleService {
  constructor(
    private readonly db: Database,
    private readonly observer?: TaskLifecycleObserver,
    private readonly logger?: TaskLifecycleLogger,
  ) {}

  async notifyTaskCreated(event: TaskCreatedEvent): Promise<void> {
    try {
      await this.observer?.onTaskCreated?.(event);
    } catch (err) {
      // Lifecycle observers are external projections and must not block local
      // execution, but a silent failure leaves projections (e.g. Feishu task
      // cards) permanently out of sync — log it.
      this.logger?.warn({ err, taskId: event.taskId }, 'Task lifecycle observer failed (created)');
    }
  }

  async notifyTaskStatusChanged(event: TaskStatusChangedEvent): Promise<void> {
    if (event.localStatus === TaskStatus.WAITING_DELEGATION) {
      return;
    }
    try {
      await this.observer?.onTaskStatusChanged?.(event);
    } catch (err) {
      this.logger?.warn(
        { err, taskId: event.taskId, localStatus: event.localStatus },
        'Task lifecycle observer failed (status changed)',
      );
    }
  }

  async transitionTask(
    taskId: string,
    newStatus: TaskStatus,
    extra?: { errorMessage?: string | null; result?: unknown; interactionReason?: string | null },
  ): Promise<void> {
    await transitionTask(this.db, taskId, newStatus, extra);
    await this.notifyTaskStatusChanged({
      taskId,
      localStatus: newStatus,
      interactionReason: extra?.interactionReason,
    });
  }
}
