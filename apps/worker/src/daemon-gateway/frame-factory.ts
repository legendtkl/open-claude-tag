import { randomUUID } from 'node:crypto';
import {
  ENVELOPE_VERSION,
  type HelloOkFrame,
  type HelloErrorFrame,
  type HelloErrorCode,
  type PongFrame,
  type TaskDispatchFrame,
  type EventAckFrame,
  type TaskCancelFrame,
} from '@open-tag/daemon-protocol';

/**
 * Constructs server→daemon frames with a fresh envelope (`v`, `id`, `ts`).
 *
 * Keeps the envelope boilerplate in one place so call sites only specify the
 * meaningful payload. Every returned object is a valid {@link Frame} and round
 * trips through `serializeFrame` without further massaging.
 */

function envelope() {
  return { v: ENVELOPE_VERSION, id: randomUUID(), ts: new Date().toISOString() } as const;
}

export function helloOk(payload: {
  heartbeatSec: number;
  resumeDispatchIds: string[];
  cancelDispatchIds: string[];
}): HelloOkFrame {
  return { ...envelope(), type: 'hello_ok', ...payload };
}

export function helloError(code: HelloErrorCode, message: string): HelloErrorFrame {
  return { ...envelope(), type: 'hello_error', code, message };
}

export function pong(seq: number): PongFrame {
  return { ...envelope(), type: 'pong', seq };
}

export function taskDispatch(
  payload: Omit<TaskDispatchFrame, 'v' | 'id' | 'ts' | 'type'>,
): TaskDispatchFrame {
  return { ...envelope(), type: 'task_dispatch', ...payload };
}

export function eventAck(dispatchId: string, lastSeq: number): EventAckFrame {
  return { ...envelope(), type: 'event_ack', dispatchId, lastSeq };
}

export function taskCancel(dispatchId: string, force?: boolean): TaskCancelFrame {
  return { ...envelope(), type: 'task_cancel', dispatchId, ...(force ? { force } : {}) };
}
