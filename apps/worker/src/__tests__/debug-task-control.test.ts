import { describe, expect, it } from 'vitest';
import { shouldSkipTaskExecution, shouldSuppressLoopbackFeishuFeedback } from '../debug-task-control.js';

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

describe('shouldSuppressLoopbackFeishuFeedback', () => {
  it('returns true only for local debug loopback tasks without a Feishu app id', () => {
    expect(shouldSuppressLoopbackFeishuFeedback({ debugLoopback: true })).toBe(true);
    expect(
      shouldSuppressLoopbackFeishuFeedback({ debugLoopback: true }, '00000000-0000-4000-8000-000000000001'),
    ).toBe(false);
    expect(shouldSuppressLoopbackFeishuFeedback({ debugLoopback: false })).toBe(false);
    expect(shouldSuppressLoopbackFeishuFeedback(null)).toBe(false);
  });
});
