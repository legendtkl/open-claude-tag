import { describe, expect, it } from 'vitest';
import { toRunningCardUpdate } from '../runtime-event-routing.js';

describe('toRunningCardUpdate', () => {
  it('maps reasoning events into running-card activity updates', () => {
    expect(
      toRunningCardUpdate(
        { type: 'reasoning', summary: 'Inspecting the worker event pipeline' },
        42,
      ),
    ).toEqual({
      message: 'Inspecting the worker event pipeline',
      source: 'reasoning',
      progress: 42,
      updateDescription: false,
    });
  });

  it('returns null for non-running-card events', () => {
    expect(
      toRunningCardUpdate({
        type: 'completed',
        result: {
          taskId: '8d519978-6ac7-43bf-b294-3dcf17fe8481',
          status: 'completed',
          output: { text: 'done' },
          metrics: {
            durationMs: 1,
            tokenIn: 0,
            tokenOut: 0,
            estimatedCostUsd: 0,
          },
        },
      }),
    ).toBeNull();
  });
});
