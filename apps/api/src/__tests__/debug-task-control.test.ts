import { describe, expect, it } from 'vitest';
import { shouldSkipTaskExecutionForDebugEvent } from '../debug-task-control.js';

function makeEvent(raw: unknown) {
  return {
    content: {
      raw,
    },
  } as any;
}

describe('shouldSkipTaskExecutionForDebugEvent', () => {
  it('returns true when adapted debug event requests task skipping', () => {
    expect(
      shouldSkipTaskExecutionForDebugEvent(
        makeEvent({
          event: {
            message: {
              __openClaudeTagDebug: {
                skipTaskExecution: true,
              },
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it('returns false when debug event explicitly disables task skipping', () => {
    expect(
      shouldSkipTaskExecutionForDebugEvent(
        makeEvent({
          event: {
            message: {
              __openClaudeTagDebug: {
                skipTaskExecution: false,
              },
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it('returns false for null raw content', () => {
    expect(shouldSkipTaskExecutionForDebugEvent(makeEvent(null))).toBe(false);
  });

  it('returns false when debug metadata is absent', () => {
    expect(
      shouldSkipTaskExecutionForDebugEvent(
        makeEvent({
          event: {
            message: {},
          },
        }),
      ),
    ).toBe(false);
  });
});
