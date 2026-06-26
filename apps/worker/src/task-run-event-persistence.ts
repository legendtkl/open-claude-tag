import type { RuntimeEvent } from '@open-tag/core-types';
import type { taskRunEvents } from '@open-tag/storage';

export const MAX_TASK_RUN_EVENT_MESSAGE_LENGTH = 4000;

function truncateTaskRunEventMessage(message: string | null): string | null {
  if (!message || message.length <= MAX_TASK_RUN_EVENT_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_TASK_RUN_EVENT_MESSAGE_LENGTH)}\n... (truncated)`;
}

function getRuntimeEventMessage(event: RuntimeEvent): string | null {
  switch (event.type) {
    case 'status':
    case 'progress':
      return event.message;
    case 'reasoning':
      return event.summary;
    case 'stdout':
    case 'stderr':
      return event.data;
    case 'artifact':
      return event.ref.name;
    case 'completed':
      return 'Completed';
    case 'failed':
      return event.error;
    case 'session_created':
      return event.sdkSessionId;
    case 'runtime_started':
      return null;
  }
}

function getRuntimeEventProgress(event: RuntimeEvent): number | null {
  return event.type === 'progress' ? event.percent : null;
}

export function buildTaskRunEventInsert(input: {
  taskId: string;
  runId: string;
  eventIndex: number;
  event: RuntimeEvent;
}): typeof taskRunEvents.$inferInsert {
  return {
    taskId: input.taskId,
    runId: input.runId,
    eventIndex: input.eventIndex,
    eventType: input.event.type,
    message: truncateTaskRunEventMessage(getRuntimeEventMessage(input.event)),
    progress: getRuntimeEventProgress(input.event),
    payload: input.event,
  };
}
