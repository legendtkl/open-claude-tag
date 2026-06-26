import { TaskStatus } from '@open-tag/core-types';

export const FEISHU_TRACKING_STATUSES = [
  'todo',
  'in-progress',
  'to-clarify',
  'review',
  'completed',
] as const;

export type FeishuTrackingStatus = (typeof FEISHU_TRACKING_STATUSES)[number];

export const TASK_INTERACTION_REASONS = ['clarify', 'approval', 'review'] as const;

export type TaskInteractionReason = (typeof TASK_INTERACTION_REASONS)[number];

export function normalizeInteractionReason(value: unknown): TaskInteractionReason | null {
  return TASK_INTERACTION_REASONS.includes(value as TaskInteractionReason)
    ? (value as TaskInteractionReason)
    : null;
}

export function mapTaskStatusToFeishuTrackingStatus(
  status: TaskStatus,
  interactionReason?: TaskInteractionReason | null,
): FeishuTrackingStatus {
  switch (status) {
    case TaskStatus.PENDING:
    case TaskStatus.QUEUED:
      return 'todo';
    case TaskStatus.RUNNING:
    case TaskStatus.WAITING_DELEGATION:
      return 'in-progress';
    case TaskStatus.WAITING_APPROVAL:
      return interactionReason === 'clarify' ? 'to-clarify' : 'review';
    case TaskStatus.COMPLETED:
      return 'completed';
    case TaskStatus.FAILED:
    case TaskStatus.CANCELLED:
      return 'review';
  }
}
