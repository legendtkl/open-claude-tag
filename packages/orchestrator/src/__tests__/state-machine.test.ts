import { describe, it, expect } from 'vitest';
import { TaskStatus } from '@open-tag/core-types';
import { canTransition, assertTransition, isTerminal } from '../task-state-machine.js';

describe('Task state machine', () => {
  it('PENDING → QUEUED is valid', () => {
    expect(canTransition(TaskStatus.PENDING, TaskStatus.QUEUED)).toBe(true);
  });

  it('QUEUED → RUNNING is valid', () => {
    expect(canTransition(TaskStatus.QUEUED, TaskStatus.RUNNING)).toBe(true);
  });

  it('RUNNING → COMPLETED is valid', () => {
    expect(canTransition(TaskStatus.RUNNING, TaskStatus.COMPLETED)).toBe(true);
  });

  it('RUNNING → FAILED is valid', () => {
    expect(canTransition(TaskStatus.RUNNING, TaskStatus.FAILED)).toBe(true);
  });

  it('RUNNING → WAITING_APPROVAL is valid', () => {
    expect(canTransition(TaskStatus.RUNNING, TaskStatus.WAITING_APPROVAL)).toBe(true);
  });

  it('RUNNING → WAITING_DELEGATION → QUEUED is valid', () => {
    expect(canTransition(TaskStatus.RUNNING, TaskStatus.WAITING_DELEGATION)).toBe(true);
    expect(canTransition(TaskStatus.WAITING_DELEGATION, TaskStatus.QUEUED)).toBe(true);
  });

  it('PENDING → RUNNING is invalid', () => {
    expect(canTransition(TaskStatus.PENDING, TaskStatus.RUNNING)).toBe(false);
  });

  it('COMPLETED → anything is invalid', () => {
    expect(canTransition(TaskStatus.COMPLETED, TaskStatus.PENDING)).toBe(false);
    expect(canTransition(TaskStatus.COMPLETED, TaskStatus.RUNNING)).toBe(false);
  });

  it('assertTransition throws on invalid transition', () => {
    expect(() => assertTransition(TaskStatus.PENDING, TaskStatus.RUNNING)).toThrow(
      'Invalid task state transition',
    );
  });

  it('FAILED → PENDING (retry) is valid', () => {
    expect(canTransition(TaskStatus.FAILED, TaskStatus.PENDING)).toBe(true);
  });

  it('RUNNING → RUNNING is invalid (prevents duplicate processing)', () => {
    expect(canTransition(TaskStatus.RUNNING, TaskStatus.RUNNING)).toBe(false);
  });

  it('FAILED → COMPLETED is invalid', () => {
    expect(canTransition(TaskStatus.FAILED, TaskStatus.COMPLETED)).toBe(false);
  });

  it('RUNNING → CANCELLED is valid', () => {
    expect(canTransition(TaskStatus.RUNNING, TaskStatus.CANCELLED)).toBe(true);
  });

  it('WAITING_DELEGATION can fail or cancel without resuming', () => {
    expect(canTransition(TaskStatus.WAITING_DELEGATION, TaskStatus.FAILED)).toBe(true);
    expect(canTransition(TaskStatus.WAITING_DELEGATION, TaskStatus.CANCELLED)).toBe(true);
  });

  it('isTerminal identifies terminal states', () => {
    expect(isTerminal(TaskStatus.COMPLETED)).toBe(true);
    expect(isTerminal(TaskStatus.FAILED)).toBe(true);
    expect(isTerminal(TaskStatus.CANCELLED)).toBe(true);
    expect(isTerminal(TaskStatus.RUNNING)).toBe(false);
    expect(isTerminal(TaskStatus.WAITING_DELEGATION)).toBe(false);
    expect(isTerminal(TaskStatus.PENDING)).toBe(false);
  });
});
