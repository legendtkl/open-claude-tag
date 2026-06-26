import type { RuntimeEvent } from '@open-tag/core-types';

export type RunningCardSource = 'progress' | 'reasoning' | 'status' | 'stdout' | 'stderr';

export interface RunningCardUpdate {
  message: string;
  source: RunningCardSource;
  progress?: number;
  updateDescription: boolean;
}

export function toRunningCardUpdate(
  event: RuntimeEvent,
  currentProgress?: number,
): RunningCardUpdate | null {
  switch (event.type) {
    case 'progress':
      return {
        message: event.message,
        source: 'progress',
        progress: event.percent,
        updateDescription: true,
      };
    case 'reasoning':
      return {
        message: event.summary,
        source: 'reasoning',
        progress: currentProgress,
        updateDescription: false,
      };
    case 'status':
      return {
        message: event.message,
        source: 'status',
        progress: currentProgress,
        updateDescription: false,
      };
    case 'stdout':
      return {
        message: event.data,
        source: 'stdout',
        progress: currentProgress,
        updateDescription: false,
      };
    case 'stderr':
      return {
        message: event.data,
        source: 'stderr',
        progress: currentProgress,
        updateDescription: false,
      };
    default:
      return null;
  }
}
