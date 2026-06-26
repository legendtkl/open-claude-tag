import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import {
  ENVELOPE_VERSION,
  MAX_FRAME_BYTES,
  parseFrame,
  parseRawFrame,
  serializeFrame,
  validateFrameSize,
} from '../frames.js';
import type {
  ArtifactsFrame,
  EventAckFrame,
  Frame,
  HelloErrorFrame,
  HelloFrame,
  HelloOkFrame,
  PingFrame,
  PongFrame,
  TaskAcceptedFrame,
  TaskCancelFrame,
  TaskDispatchFrame,
  TaskEventFrame,
  TaskLostFrame,
  TaskRejectedFrame,
} from '../frames.js';
import type { TaskSpec, RuntimeEvent, ArtifactRef, TaskResult } from '@open-tag/core-types';

const TS = '2026-06-10T00:00:00.000Z';

function envelope(type: string) {
  return { v: ENVELOPE_VERSION, type, id: randomUUID(), ts: TS };
}

const taskSpec: TaskSpec = {
  taskId: randomUUID(),
  sessionId: randomUUID(),
  taskType: 'chat_reply',
  goal: 'Write a hello world function',
  runtimeHint: 'auto',
  constraints: {
    timeoutSec: 1800,
    approvalRequired: false,
    writeScope: [],
    networkPolicy: 'restricted',
  },
  context: {
    systemPrompt: 'You are a helpful assistant.',
    recentTurns: [],
  },
};

const artifactRef: ArtifactRef = {
  name: 'out.txt',
  path: '/tmp/out.txt',
  mimeType: 'text/plain',
  sha256: 'a'.repeat(64),
  sizeBytes: 12,
};

const taskResult: TaskResult = {
  taskId: taskSpec.taskId,
  status: 'completed',
  output: { text: 'done', artifacts: [artifactRef] },
  metrics: { durationMs: 100, tokenIn: 10, tokenOut: 20, estimatedCostUsd: 0.01 },
};

const completedEvent: RuntimeEvent = { type: 'completed', result: taskResult };

const helloFrame: HelloFrame = {
  ...envelope('hello'),
  type: 'hello',
  machineId: randomUUID(),
  protocolVersion: 1,
  daemonVersion: '0.1.0',
  capabilities: {
    runtimes: ['claude_code', 'codex'],
    features: ['runtime_env'],
    platform: 'linux',
    hostname: 'box',
    daemonVersion: '0.1.0',
    protocolVersion: 1,
  },
  runningDispatchIds: ['d-1', 'd-2'],
};

const helloOkFrame: HelloOkFrame = {
  ...envelope('hello_ok'),
  type: 'hello_ok',
  heartbeatSec: 15,
  resumeDispatchIds: ['d-1'],
  cancelDispatchIds: ['d-2'],
};

const helloErrorFrame: HelloErrorFrame = {
  ...envelope('hello_error'),
  type: 'hello_error',
  code: 'protocol_incompatible',
  message: 'upgrade your daemon',
};

const pingFrame: PingFrame = { ...envelope('ping'), type: 'ping', seq: 7 };
const pongFrame: PongFrame = { ...envelope('pong'), type: 'pong', seq: 7 };

const taskDispatchFrame: TaskDispatchFrame = {
  ...envelope('task_dispatch'),
  type: 'task_dispatch',
  dispatchId: 'disp-1',
  taskId: taskSpec.taskId,
  mode: 'prepare_execute',
  spec: taskSpec,
  sdkSessionId: 'sdk-1',
  systemPromptAppend: 'be concise',
  workdirHints: {
    confirmedWorkDir: '/repo',
    adhocWorkDir: undefined,
    defaultWorkDir: '/home',
    readOnly: false,
    agentId: 'agent-1',
  },
  runtime: 'claude_code',
  runtimeEnv: { a: 'b' },
  images: [{ name: 'shot.png', base64: 'aGVsbG8=' }],
};

const taskAcceptedFrame: TaskAcceptedFrame = {
  ...envelope('task_accepted'),
  type: 'task_accepted',
  dispatchId: 'disp-1',
};

const taskRejectedFrame: TaskRejectedFrame = {
  ...envelope('task_rejected'),
  type: 'task_rejected',
  dispatchId: 'disp-1',
  reason: 'busy',
};

const taskEventFrame: TaskEventFrame = {
  ...envelope('task_event'),
  type: 'task_event',
  dispatchId: 'disp-1',
  seq: 1,
  event: completedEvent,
};

const eventAckFrame: EventAckFrame = {
  ...envelope('event_ack'),
  type: 'event_ack',
  dispatchId: 'disp-1',
  lastSeq: 1,
};

const taskLostFrame: TaskLostFrame = {
  ...envelope('task_lost'),
  type: 'task_lost',
  dispatchId: 'disp-1',
};

const taskCancelFrame: TaskCancelFrame = {
  ...envelope('task_cancel'),
  type: 'task_cancel',
  dispatchId: 'disp-1',
  force: true,
};

const artifactsFrame: ArtifactsFrame = {
  ...envelope('artifacts'),
  type: 'artifacts',
  dispatchId: 'disp-1',
  refs: [artifactRef],
};

const allFrames: Array<{ name: string; frame: Frame }> = [
  { name: 'hello', frame: helloFrame },
  { name: 'hello_ok', frame: helloOkFrame },
  { name: 'hello_error', frame: helloErrorFrame },
  { name: 'ping', frame: pingFrame },
  { name: 'pong', frame: pongFrame },
  { name: 'task_dispatch', frame: taskDispatchFrame },
  { name: 'task_accepted', frame: taskAcceptedFrame },
  { name: 'task_rejected', frame: taskRejectedFrame },
  { name: 'task_event', frame: taskEventFrame },
  { name: 'event_ack', frame: eventAckFrame },
  { name: 'task_lost', frame: taskLostFrame },
  { name: 'task_cancel', frame: taskCancelFrame },
  { name: 'artifacts', frame: artifactsFrame },
];

describe('frame schemas — round-trip', () => {
  for (const { name, frame } of allFrames) {
    it(`round-trips ${name}`, () => {
      const wire = serializeFrame(frame);
      const result = parseRawFrame(wire);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.frame.type).toBe(name);
        expect(result.frame).toEqual(JSON.parse(wire));
      }
    });
  }

  it('covers every frame type exactly once', () => {
    const names = new Set(allFrames.map((f) => f.name));
    expect(names.size).toBe(allFrames.length);
    expect(names.size).toBe(13);
  });
});

describe('frame schemas — malformed rejection', () => {
  it('rejects an unknown frame type', () => {
    const result = parseFrame({ ...envelope('unknown_type'), foo: 'bar' });
    expect(result.ok).toBe(false);
  });

  it('rejects a wrong envelope version', () => {
    const result = parseFrame({ ...pingFrame, v: 2 });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-uuid envelope id', () => {
    const result = parseFrame({ ...pingFrame, id: 'not-a-uuid' });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-ISO8601 timestamp', () => {
    const result = parseFrame({ ...pingFrame, ts: 'yesterday' });
    expect(result.ok).toBe(false);
  });

  it('rejects a frame missing required payload fields', () => {
    const result = parseFrame({ ...envelope('task_accepted'), type: 'task_accepted' });
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid hello_error code', () => {
    const result = parseFrame({ ...helloErrorFrame, code: 'nope' });
    expect(result.ok).toBe(false);
  });

  it('rejects a task_event carrying a malformed RuntimeEvent', () => {
    const result = parseFrame({
      ...envelope('task_event'),
      type: 'task_event',
      dispatchId: 'disp-1',
      seq: 1,
      event: { type: 'not_a_real_event' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a task_dispatch with an invalid runtime', () => {
    const result = parseFrame({ ...taskDispatchFrame, runtime: 'gemini' });
    expect(result.ok).toBe(false);
  });

  it('rejects a task_dispatch with an invalid runtime env key', () => {
    const result = parseFrame({ ...taskDispatchFrame, runtimeEnv: { 'bad-key': 'value' } });
    expect(result.ok).toBe(false);
  });

  it('rejects a hello frame with an invalid daemon feature', () => {
    const result = parseFrame({
      ...helloFrame,
      capabilities: { ...helloFrame.capabilities, features: ['unknown_feature'] },
    });
    expect(result.ok).toBe(false);
  });

  it('accepts the agent_home daemon feature', () => {
    const result = parseFrame({
      ...helloFrame,
      capabilities: { ...helloFrame.capabilities, features: ['runtime_env', 'agent_home'] },
    });
    expect(result.ok).toBe(true);
  });

  it('returns an error string and never throws on garbage input', () => {
    for (const garbage of [null, undefined, 42, 'string', [], {}]) {
      const result = parseFrame(garbage);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(typeof result.error).toBe('string');
      }
    }
  });

  it('parseRawFrame rejects invalid JSON without throwing', () => {
    const result = parseRawFrame('{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid JSON');
    }
  });
});

describe('serializeFrame', () => {
  it('throws on a structurally invalid frame (programming error)', () => {
    const bad = { ...pingFrame, seq: -1 } as unknown as Frame;
    expect(() => serializeFrame(bad)).toThrow();
  });
});

describe('frame size cap', () => {
  it('exposes a 16 MiB cap that admits a 10 MB inline image after base64', () => {
    // 10 MB raw image -> ~13.4 MB base64 + JSON envelope overhead must fit
    // (codex review finding #8: a 1 MB cap contradicted the D11 image design).
    expect(MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
    const tenMbBase64Length = Math.ceil((10 * 1024 * 1024) / 3) * 4;
    expect(tenMbBase64Length + 64 * 1024).toBeLessThan(MAX_FRAME_BYTES);
  });

  it('accepts a frame within the cap', () => {
    expect(validateFrameSize(serializeFrame(pingFrame))).toBe(true);
  });

  it('rejects a serialized frame over the cap', () => {
    const big = 'x'.repeat(MAX_FRAME_BYTES + 1);
    expect(validateFrameSize(big)).toBe(false);
  });

  it('measures UTF-8 byte length, not character count', () => {
    // Each multi-byte char counts as >1 byte.
    const multibyte = '€'.repeat(MAX_FRAME_BYTES); // 3 bytes each
    expect(validateFrameSize(multibyte)).toBe(false);
  });

  it('parseRawFrame rejects oversized raw input before parsing', () => {
    const oversized = JSON.stringify({
      ...taskDispatchFrame,
      systemPromptAppend: 'z'.repeat(MAX_FRAME_BYTES + 10),
    });
    const result = parseRawFrame(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('maximum size');
    }
  });

  it('honors a custom maxBytes override', () => {
    expect(validateFrameSize('abcdef', 3)).toBe(false);
    expect(validateFrameSize('ab', 3)).toBe(true);
  });
});
