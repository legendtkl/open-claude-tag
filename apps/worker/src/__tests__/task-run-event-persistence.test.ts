import { describe, expect, it } from 'vitest';
import {
  buildTaskRunEventInsert,
  MAX_TASK_RUN_EVENT_MESSAGE_LENGTH,
} from '../task-run-event-persistence.js';

describe('task run event persistence', () => {
  it('maps progress runtime events into ordered trace rows', () => {
    expect(
      buildTaskRunEventInsert({
        taskId: 'task_1',
        runId: 'run_1',
        eventIndex: 2,
        event: { type: 'progress', percent: 35, message: 'Reading files' },
      }),
    ).toMatchObject({
      taskId: 'task_1',
      runId: 'run_1',
      eventIndex: 2,
      eventType: 'progress',
      message: 'Reading files',
      progress: 35,
      payload: { type: 'progress', percent: 35, message: 'Reading files' },
    });
  });

  it('truncates oversized event messages without dropping payload', () => {
    const data = 'x'.repeat(MAX_TASK_RUN_EVENT_MESSAGE_LENGTH + 50);

    const row = buildTaskRunEventInsert({
      taskId: 'task_1',
      runId: 'run_1',
      eventIndex: 3,
      event: { type: 'stdout', data },
    });

    expect(row.message).toContain('... (truncated)');
    expect(row.message).toHaveLength(MAX_TASK_RUN_EVENT_MESSAGE_LENGTH + 16);
    expect(row.payload).toEqual({ type: 'stdout', data });
  });
});
