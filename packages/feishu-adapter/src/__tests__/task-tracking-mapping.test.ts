import { describe, expect, it } from 'vitest';
import { TaskStatus } from '@open-tag/core-types';
import {
  mapTaskStatusToFeishuTrackingStatus,
  normalizeInteractionReason,
} from '../task-tracking-mapping.js';

describe('task tracking mapping', () => {
  it('maps pending and queued tasks to todo', () => {
    expect(mapTaskStatusToFeishuTrackingStatus(TaskStatus.PENDING)).toBe('todo');
    expect(mapTaskStatusToFeishuTrackingStatus(TaskStatus.QUEUED)).toBe('todo');
  });

  it('maps running tasks to in-progress', () => {
    expect(mapTaskStatusToFeishuTrackingStatus(TaskStatus.RUNNING)).toBe('in-progress');
  });

  it('maps delegation-waiting tasks to in-progress when projected defensively', () => {
    expect(mapTaskStatusToFeishuTrackingStatus(TaskStatus.WAITING_DELEGATION)).toBe('in-progress');
  });

  it('maps clarification handoffs to to-clarify', () => {
    expect(mapTaskStatusToFeishuTrackingStatus(TaskStatus.WAITING_APPROVAL, 'clarify')).toBe(
      'to-clarify',
    );
  });

  it('maps approval and review handoffs to review', () => {
    expect(mapTaskStatusToFeishuTrackingStatus(TaskStatus.WAITING_APPROVAL, 'approval')).toBe(
      'review',
    );
    expect(mapTaskStatusToFeishuTrackingStatus(TaskStatus.WAITING_APPROVAL, 'review')).toBe(
      'review',
    );
    expect(mapTaskStatusToFeishuTrackingStatus(TaskStatus.WAITING_APPROVAL)).toBe('review');
  });

  it('maps failed and cancelled tasks to review', () => {
    expect(mapTaskStatusToFeishuTrackingStatus(TaskStatus.FAILED)).toBe('review');
    expect(mapTaskStatusToFeishuTrackingStatus(TaskStatus.CANCELLED)).toBe('review');
  });

  it('maps completed tasks to completed', () => {
    expect(mapTaskStatusToFeishuTrackingStatus(TaskStatus.COMPLETED)).toBe('completed');
  });

  it('normalizes known interaction reasons only', () => {
    expect(normalizeInteractionReason('clarify')).toBe('clarify');
    expect(normalizeInteractionReason('approval')).toBe('approval');
    expect(normalizeInteractionReason('review')).toBe('review');
    expect(normalizeInteractionReason('other')).toBeNull();
    expect(normalizeInteractionReason(undefined)).toBeNull();
  });
});
