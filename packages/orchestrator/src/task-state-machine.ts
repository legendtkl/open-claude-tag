import { TaskStatus } from '@open-tag/core-types';

// Valid state transitions
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  [TaskStatus.PENDING]: [TaskStatus.QUEUED, TaskStatus.FAILED, TaskStatus.CANCELLED],
  [TaskStatus.QUEUED]: [TaskStatus.RUNNING, TaskStatus.FAILED, TaskStatus.CANCELLED],
  [TaskStatus.RUNNING]: [
    TaskStatus.WAITING_APPROVAL,
    TaskStatus.WAITING_DELEGATION,
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ],
  [TaskStatus.WAITING_APPROVAL]: [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED],
  [TaskStatus.WAITING_DELEGATION]: [
    TaskStatus.QUEUED,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ],
  [TaskStatus.COMPLETED]: [], // terminal state
  [TaskStatus.FAILED]: [TaskStatus.PENDING], // allow retry
  [TaskStatus.CANCELLED]: [], // terminal state
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task state transition: ${from} → ${to}`);
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return (
    status === TaskStatus.COMPLETED ||
    status === TaskStatus.FAILED ||
    status === TaskStatus.CANCELLED
  );
}
