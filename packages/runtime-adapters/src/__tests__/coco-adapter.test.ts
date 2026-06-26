import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import type { spawn } from 'child_process';
import type { RuntimeEvent, TaskSpec } from '@open-tag/core-types';
import type { RuntimeHandle } from '../types.js';
import {
  CocoAdapter,
  buildCocoArgs,
  createCocoStreamState,
  processCocoEvent,
} from '../coco-adapter.js';

/** A representative successful Coco stream-json event sequence (captured shape). */
function successEvents(): Array<Record<string, unknown>> {
  return [
    { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'M', permission_mode: 'bypass_permissions' },
    { type: 'system', subtype: 'status', updates: { 'prompt.detected_language': 'English' } },
    { type: 'system', subtype: 'status', updates: { title: 'Do the thing', model_name: 'M', cwd: '/tmp/x' } },
    { type: 'stream_event', delta: { role: 'assistant', content: '', reasoning_content: 'Thinking about ' } },
    {
      type: 'stream_event',
      delta: {
        role: 'assistant',
        content: '',
        reasoning_content:
          'the request in great detail so that the buffer easily crosses the flush threshold of 120 characters indeed.',
      },
    },
    { type: 'stream_event', delta: { role: 'assistant', content: 'HELLO_DONE' } },
    { type: 'user', subtype: 'tool_result' },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: 'HELLO_DONE',
        reasoning_content: 'final reasoning summary',
        response_meta: { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      },
    },
    {
      type: 'result',
      subtype: 'success',
      result: 'HELLO_DONE',
      is_error: false,
      num_turns: 1,
      duration_ms: 1234,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 8 },
    },
  ];
}

function replay(events: Array<Record<string, unknown>>): RuntimeEvent[] {
  const state = createCocoStreamState({ taskId: 'task-1', executionId: 'exec-1', startTime: Date.now() });
  const out: RuntimeEvent[] = [];
  for (const e of events) out.push(...processCocoEvent(e, state));
  return out;
}

describe('buildCocoArgs', () => {
  it('produces the headless streaming flags with the prompt as the final positional', () => {
    const args = buildCocoArgs({ prompt: 'do X' });
    expect(args).toContain('--print');
    expect(args).toContain('--output-format=stream-json');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--yolo');
    expect(args[args.length - 1]).toBe('do X');
  });

  it('passes the model via -c model.name and resume via --resume', () => {
    const args = buildCocoArgs({ prompt: 'go', model: 'kimi-k2', resumeSessionId: 'sess-9' });
    const i = args.indexOf('-c');
    expect(args[i + 1]).toBe('model.name=kimi-k2');
    const r = args.indexOf('--resume');
    expect(args[r + 1]).toBe('sess-9');
    expect(args[args.length - 1]).toBe('go');
  });

  it('appends extra config overrides', () => {
    const args = buildCocoArgs({ prompt: 'go', configOverrides: ['permission_mode=plan'] });
    expect(args).toContain('permission_mode=plan');
  });
});

describe('processCocoEvent mapping', () => {
  it('maps a successful turn to session_created, progress, reasoning and completed', () => {
    const events = replay(successEvents());

    const runtimeStarted = events.filter((e) => e.type === 'runtime_started');
    expect(runtimeStarted).toHaveLength(1);

    const session = events.find((e) => e.type === 'session_created');
    expect(session).toEqual({ type: 'session_created', sdkSessionId: 'sess-1' });

    expect(events.some((e) => e.type === 'reasoning')).toBe(true);
    expect(events.some((e) => e.type === 'progress')).toBe(true);

    const completed = events.find((e) => e.type === 'completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'completed') {
      expect(completed.result.output.text).toBe('HELLO_DONE');
      expect(completed.result.metrics.tokenIn).toBe(100);
      expect(completed.result.metrics.tokenOut).toBe(20);
      expect(completed.result.metrics.durationMs).toBe(1234);
    }
  });

  it('emits a title progress update once', () => {
    const events = replay(successEvents());
    const titleProgress = events.filter(
      (e) => e.type === 'progress' && e.message.startsWith('Coco: '),
    );
    expect(titleProgress).toHaveLength(1);
    expect(titleProgress[0].type === 'progress' && titleProgress[0].message).toBe('Coco: Do the thing');
  });

  it('scales tool progress and caps at 80%', () => {
    const state = createCocoStreamState({ taskId: 't', executionId: 'e', startTime: Date.now() });
    let last = 0;
    for (let i = 0; i < 40; i++) {
      const evs = processCocoEvent({ type: 'user', subtype: 'tool_result' }, state);
      const p = evs.find((e) => e.type === 'progress');
      if (p && p.type === 'progress') last = p.percent;
    }
    expect(last).toBe(80);
  });

  it('maps an error result to a failed event', () => {
    const events = replay([
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'result', subtype: 'error_max_turns', is_error: true, result: 'too many turns' },
    ]);
    const failed = events.find((e) => e.type === 'failed');
    expect(failed).toEqual({ type: 'failed', error: 'too many turns' });
    expect(events.some((e) => e.type === 'completed')).toBe(false);
  });

  it('tolerates unknown event shapes without throwing', () => {
    const state = createCocoStreamState({ taskId: 't', executionId: 'e', startTime: Date.now() });
    expect(() => processCocoEvent({ type: 'mystery', foo: 1 }, state)).not.toThrow();
    expect(() => processCocoEvent({ type: 'stream_event' }, state)).not.toThrow();
  });
});

// ── Fake child process for end-to-end adapter wiring ──────────────────────────
interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: null;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  lastSignal?: NodeJS.Signals;
  kill(signal?: NodeJS.Signals): boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = null;
  child.pid = 999999; // not a real group; process.kill(-pid) will ESRCH → falls to child.kill
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    child.killed = true;
    child.lastSignal = signal;
    child.signalCode = signal;
    setImmediate(() => {
      child.emit('exit', null, signal);
      child.emit('close', null, signal);
    });
    return true;
  };
  return child;
}

function makeHandle(cwd: string): RuntimeHandle {
  return { executionId: 'task-e2e', workspacePath: cwd, cwd, readOnly: false };
}

const minimalSpec = { taskId: 'task-e2e', goal: 'say hi' } as unknown as TaskSpec;

describe('CocoAdapter end-to-end (fake spawn)', () => {
  it('streams a successful run through to a completed event', async () => {
    const lines = successEvents().map((e) => JSON.stringify(e));
    const fakeSpawn = ((_bin: string, _args: readonly string[]) => {
      const child = makeFakeChild();
      setImmediate(() => {
        for (const l of lines) child.stdout.write(`${l}\n`);
        child.stdout.end();
      });
      return child;
    }) as unknown as typeof spawn;

    const adapter = new CocoAdapter({ binaryPath: '/usr/bin/coco', spawnImpl: fakeSpawn, startupTimeoutMs: 0 });
    const events: RuntimeEvent[] = [];
    for await (const ev of adapter.execute(makeHandle(tmpdir()), minimalSpec)) {
      events.push(ev);
    }

    expect(events[0]).toEqual({ type: 'status', message: 'Starting Coco...' });
    const completed = events.find((e) => e.type === 'completed');
    expect(completed?.type === 'completed' && completed.result.output.text).toBe('HELLO_DONE');
    expect(events.some((e) => e.type === 'session_created')).toBe(true);
  });

  it('passes the resolved cwd and argv to spawn', async () => {
    let capturedArgs: readonly string[] = [];
    let capturedOpts: { cwd?: string } = {};
    const fakeSpawn = ((_bin: string, args: readonly string[], opts: { cwd?: string }) => {
      capturedArgs = args;
      capturedOpts = opts;
      const child = makeFakeChild();
      setImmediate(() => {
        child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', is_error: false, duration_ms: 1 })}\n`);
        child.stdout.end();
      });
      return child;
    }) as unknown as typeof spawn;

    const adapter = new CocoAdapter({ model: 'gpt-5', spawnImpl: fakeSpawn, startupTimeoutMs: 0 });
    for await (const _ev of adapter.execute(makeHandle('/work/dir'), minimalSpec)) {
      void _ev;
    }
    expect(capturedOpts.cwd).toBe('/work/dir');
    expect(capturedArgs).toContain('--yolo');
    expect(capturedArgs[capturedArgs.length - 1]).toContain('say hi');
  });

  it('threads the per-task spec.model into the coco argv (-c model.name=), overriding config', async () => {
    let capturedArgs: readonly string[] = [];
    const fakeSpawn = ((_bin: string, args: readonly string[]) => {
      capturedArgs = args;
      const child = makeFakeChild();
      setImmediate(() => {
        child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', is_error: false, duration_ms: 1 })}\n`);
        child.stdout.end();
      });
      return child;
    }) as unknown as typeof spawn;

    const adapter = new CocoAdapter({
      binaryPath: '/usr/bin/coco',
      model: 'config-default-model',
      spawnImpl: fakeSpawn,
      startupTimeoutMs: 0,
    });
    const specWithModel = { taskId: 'task-e2e', goal: 'hi', model: 'kimi-k2' } as unknown as TaskSpec;
    for await (const _ev of adapter.execute(makeHandle(tmpdir()), specWithModel)) {
      void _ev;
    }
    expect(capturedArgs).toContain('model.name=kimi-k2');
    expect(capturedArgs).not.toContain('model.name=config-default-model');
  });

  it('cancellation yields a failed event with reason cancelled', async () => {
    const fakeSpawn = ((_bin: string, _args: readonly string[]) => {
      const child = makeFakeChild();
      setImmediate(() => {
        // Emit init then keep the stream open (no result).
        child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' })}\n`);
      });
      return child;
    }) as unknown as typeof spawn;

    const adapter = new CocoAdapter({
      binaryPath: '/usr/bin/coco',
      spawnImpl: fakeSpawn,
      startupTimeoutMs: 0,
      cancelSigtermGraceMs: 0,
      cancelSigkillGraceMs: 0,
    });

    const iter = adapter.execute(makeHandle(tmpdir()), minimalSpec)[Symbol.asyncIterator]();
    const collected: RuntimeEvent[] = [];
    // Pull the first couple of events (status, progress, runtime_started/session...).
    for (let i = 0; i < 3; i++) {
      const r = await iter.next();
      if (r.done) break;
      collected.push(r.value);
    }
    const outcome = await adapter.cancel('task-e2e', { force: true });
    expect(['terminated', 'termination_started']).toContain(outcome);

    // Drain the remaining events.
    let guard = 0;
    while (guard++ < 50) {
      const r = await iter.next();
      if (r.done) break;
      collected.push(r.value);
    }
    const failed = collected.find((e) => e.type === 'failed');
    expect(failed?.type === 'failed' && failed.reason).toBe('cancelled');
  });

  it('fails with a startup-timeout error when no line ever arrives', async () => {
    const fakeSpawn = (() => makeFakeChild()) as unknown as typeof spawn; // never emits
    const adapter = new CocoAdapter({
      binaryPath: '/usr/bin/coco',
      spawnImpl: fakeSpawn,
      startupTimeoutMs: 40,
      idleTimeoutMs: 60_000,
    });
    const events: RuntimeEvent[] = [];
    for await (const ev of adapter.execute(makeHandle(tmpdir()), minimalSpec)) events.push(ev);
    const failed = events.find((e) => e.type === 'failed');
    expect(failed?.type === 'failed' && failed.error).toMatch(/startup timed out/i);
  });

  it('fails with an idle-stall error when the stream goes silent after init', async () => {
    const fakeSpawn = (() => {
      const child = makeFakeChild();
      setImmediate(() => {
        child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' })}\n`);
        // then silent — no end, no further lines
      });
      return child;
    }) as unknown as typeof spawn;
    const adapter = new CocoAdapter({
      binaryPath: '/usr/bin/coco',
      spawnImpl: fakeSpawn,
      startupTimeoutMs: 0,
      idleTimeoutMs: 40,
    });
    const events: RuntimeEvent[] = [];
    for await (const ev of adapter.execute(makeHandle(tmpdir()), minimalSpec)) events.push(ev);
    const failed = events.find((e) => e.type === 'failed');
    expect(failed?.type === 'failed' && failed.error).toMatch(/stalled/i);
  });

  it('fails with the stderr detail when coco exits non-zero without a result', async () => {
    const fakeSpawn = (() => {
      const child = makeFakeChild();
      setImmediate(() => {
        child.stderr.write('boom: coco blew up');
        child.stdout.end();
        child.exitCode = 1;
        child.emit('exit', 1, null);
        child.emit('close', 1, null);
      });
      return child;
    }) as unknown as typeof spawn;
    const adapter = new CocoAdapter({ binaryPath: '/usr/bin/coco', spawnImpl: fakeSpawn, startupTimeoutMs: 0 });
    const events: RuntimeEvent[] = [];
    for await (const ev of adapter.execute(makeHandle(tmpdir()), minimalSpec)) events.push(ev);
    const failed = events.find((e) => e.type === 'failed');
    expect(failed?.type === 'failed' && failed.error).toMatch(/exited with code 1/i);
    expect(failed?.type === 'failed' && failed.error).toMatch(/boom: coco blew up/);
    expect(events.some((e) => e.type === 'completed')).toBe(false);
  });

  it('skips a non-JSON banner line before the first valid event and still completes', async () => {
    const lines = [
      'WARNING: some coco banner noise, not json',
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-x' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'BANNER_OK', is_error: false, duration_ms: 3 }),
    ];
    const fakeSpawn = (() => {
      const child = makeFakeChild();
      setImmediate(() => {
        for (const l of lines) child.stdout.write(`${l}\n`);
        child.stdout.end();
      });
      return child;
    }) as unknown as typeof spawn;
    const adapter = new CocoAdapter({ binaryPath: '/usr/bin/coco', spawnImpl: fakeSpawn, startupTimeoutMs: 0 });
    const events: RuntimeEvent[] = [];
    for await (const ev of adapter.execute(makeHandle(tmpdir()), minimalSpec)) events.push(ev);
    const completed = events.find((e) => e.type === 'completed');
    expect(completed?.type === 'completed' && completed.result.output.text).toBe('BANNER_OK');
    expect(events.some((e) => e.type === 'session_created')).toBe(true);
  });

  it('cancel on an unknown execution reports no active execution', async () => {
    const adapter = new CocoAdapter();
    expect(await adapter.cancel('nope')).toBe('no_active_execution');
  });

  it('reports a healthcheck for an absolute binary path', async () => {
    const present = await new CocoAdapter({ binaryPath: process.execPath }).healthcheck();
    expect(present.healthy).toBe(true);
    expect(present.name).toBe('coco');
    const missing = await new CocoAdapter({ binaryPath: '/no/such/coco' }).healthcheck();
    expect(missing.healthy).toBe(false);
  });
});
