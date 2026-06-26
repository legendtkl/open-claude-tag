import { randomUUID } from 'crypto';
import {
  ENVELOPE_VERSION,
  type TaskDispatchFrame,
} from '@open-tag/daemon-protocol';
import type { TaskResult, RuntimeEvent } from '@open-tag/core-types';

/** Builds a valid `task_dispatch` frame with sensible defaults for tests. */
export function makeDispatchFrame(overrides: Partial<TaskDispatchFrame> = {}): TaskDispatchFrame {
  const taskId = overrides.spec?.taskId ?? randomUUID();
  const sessionId = overrides.spec?.sessionId ?? randomUUID();
  return {
    v: ENVELOPE_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'task_dispatch',
    dispatchId: overrides.dispatchId ?? `dispatch-${randomUUID().slice(0, 8)}`,
    taskId,
    mode: overrides.mode ?? 'prepare_execute',
    runtime: overrides.runtime ?? 'claude_code',
    workdirHints: overrides.workdirHints ?? {},
    runtimeEnv: overrides.runtimeEnv,
    sdkSessionId: overrides.sdkSessionId,
    systemPromptAppend: overrides.systemPromptAppend,
    images: overrides.images,
    spec: overrides.spec ?? {
      taskId,
      sessionId,
      taskType: 'chat_reply',
      goal: 'do the thing',
      runtimeHint: 'auto',
      constraints: {
        timeoutSec: 1800,
        approvalRequired: false,
        writeScope: [],
        networkPolicy: 'restricted',
      },
      context: { systemPrompt: '', recentTurns: [] },
    },
  };
}

/** A minimal valid `completed` TaskResult for terminal events. */
export function makeCompletedResult(taskId: string, text = 'done'): TaskResult {
  return {
    taskId,
    status: 'completed',
    output: { text },
    metrics: { durationMs: 1, tokenIn: 0, tokenOut: 0, estimatedCostUsd: 0 },
  };
}

/** Convenience: a happy-path event script ending in `completed`. */
export function happyScript(taskId: string): RuntimeEvent[] {
  return [
    { type: 'runtime_started', executionId: `exec-${taskId}` },
    { type: 'progress', percent: 50, message: 'halfway' },
    { type: 'completed', result: makeCompletedResult(taskId) },
  ];
}
