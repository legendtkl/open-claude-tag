import { randomUUID } from 'crypto';
import {
  ENVELOPE_VERSION,
  serializeFrame,
  type Frame,
  type Capabilities,
  type HelloFrame,
  type PingFrame,
  type TaskAcceptedFrame,
  type TaskRejectedFrame,
  type TaskEventFrame,
  type TaskLostFrame,
  type ArtifactsFrame,
} from '@open-tag/daemon-protocol';
import type { RuntimeEvent, ArtifactRef } from '@open-tag/core-types';

/**
 * Stamps the shared envelope fields (`v`, `id`, `ts`) onto a frame payload so
 * call sites only specify the type-specific fields (design §6 envelope). The
 * type parameter must be given explicitly at each call site so the payload is
 * checked against the correct frame variant.
 */
type FramePayload<T extends Frame> = Omit<T, 'v' | 'id' | 'ts'>;

function envelope<T extends Frame>(payload: FramePayload<T>): T {
  return {
    v: ENVELOPE_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...payload,
  } as T;
}

export function helloFrame(input: {
  machineId: string;
  protocolVersion: number;
  daemonVersion: string;
  capabilities: Capabilities;
  runningDispatchIds: string[];
}): string {
  return serializeFrame(
    envelope<HelloFrame>({
      type: 'hello',
      machineId: input.machineId,
      protocolVersion: input.protocolVersion,
      daemonVersion: input.daemonVersion,
      capabilities: input.capabilities,
      runningDispatchIds: input.runningDispatchIds,
    }),
  );
}

export function pingFrame(seq: number): string {
  return serializeFrame(envelope<PingFrame>({ type: 'ping', seq }));
}

export function taskAcceptedFrame(dispatchId: string): string {
  return serializeFrame(envelope<TaskAcceptedFrame>({ type: 'task_accepted', dispatchId }));
}

export function taskRejectedFrame(dispatchId: string, reason: string): string {
  return serializeFrame(
    envelope<TaskRejectedFrame>({ type: 'task_rejected', dispatchId, reason }),
  );
}

export function taskEventFrame(dispatchId: string, seq: number, event: RuntimeEvent): string {
  return serializeFrame(
    envelope<TaskEventFrame>({ type: 'task_event', dispatchId, seq, event }),
  );
}

export function taskLostFrame(dispatchId: string): string {
  return serializeFrame(envelope<TaskLostFrame>({ type: 'task_lost', dispatchId }));
}

export function artifactsFrame(dispatchId: string, refs: ArtifactRef[]): string {
  return serializeFrame(envelope<ArtifactsFrame>({ type: 'artifacts', dispatchId, refs }));
}
