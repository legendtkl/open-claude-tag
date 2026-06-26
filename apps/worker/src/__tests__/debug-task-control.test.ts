import { describe, expect, it } from 'vitest';
import { shouldSkipTaskExecution } from '../debug-task-control.js';

describe('shouldSkipTaskExecution', () => {
  it('returns true when debugSkipExecution is enabled', () => {
    expect(shouldSkipTaskExecution({ debugSkipExecution: true })).toBe(true);
  });

  it('returns false when debugSkipExecution is absent', () => {
    expect(shouldSkipTaskExecution({ chatId: 'oc_123' })).toBe(false);
  });

  it('returns false for null constraints', () => {
    expect(shouldSkipTaskExecution(null)).toBe(false);
  });

  it('returns false for undefined constraints', () => {
    expect(shouldSkipTaskExecution(undefined)).toBe(false);
  });
});
