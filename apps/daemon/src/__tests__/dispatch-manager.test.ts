import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DispatchManager } from '../dispatch-manager.js';
import { StubAdapter, stubRuntimeManager, RecordingSink } from './stub-adapter.js';
import { makeDispatchFrame, happyScript, makeCompletedResult } from './fixtures.js';
import type { RuntimeEvent } from '@open-tag/core-types';
import { validateFrameSize, MAX_FRAME_BYTES } from '@open-tag/daemon-protocol';

/** A manually-resolvable gate so tests can hold a runtime open mid-stream. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function flush(): Promise<void> {
  // Let queued microtasks + the run loop settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

async function waitUntil(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  try {
    assertion();
  } catch (error) {
    throw lastError ?? error;
  }
}

describe('DispatchManager', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'daemon-dispatch-'));
    process.env.OPEN_TAG_HOME = home;
  });
  afterEach(async () => {
    delete process.env.OPEN_TAG_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it('accepts a dispatch, streams seq-numbered events, ends with terminal', async () => {
    const frame = makeDispatchFrame();
    const adapter = new StubAdapter(happyScript(frame.taskId));
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapter), sink);

    await mgr.handleDispatch(frame);
    await flush();

    const accepted = sink.byType('task_accepted');
    expect(accepted).toHaveLength(1);

    const events = sink.byType('task_event') as Array<{ seq: number; event: RuntimeEvent }>;
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[0].event.type).toBe('runtime_started');
    expect(events[2].event.type).toBe('completed');
    expect(adapter.prepareCalls).toBe(1);
    expect(adapter.executeCalls).toBe(1);
  });

  it('rejects with busy at the concurrency cap and does not queue', async () => {
    const gate = deferred();
    const adapterFactory = () => new StubAdapter([], { gate: gate.promise });
    // Cap of 1: first dispatch occupies the slot (held open by the gate).
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapterFactory()), sink, 1);

    const first = makeDispatchFrame({ dispatchId: 'd1' });
    const second = makeDispatchFrame({ dispatchId: 'd2' });

    await mgr.handleDispatch(first);
    await flush();
    await mgr.handleDispatch(second);
    await flush();

    const rejected = sink.byType('task_rejected') as Array<{ dispatchId: string; reason: string }>;
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ dispatchId: 'd2', reason: 'busy' });
    expect(mgr.has('d2')).toBe(false); // not queued

    gate.resolve();
    await flush();
  });

  it('enforces the concurrency cap for dispatches that arrive during prepare', async () => {
    // No flush between the two calls: the second frame lands while the first
    // is still inside prepareDispatch's first await (workspace creation).
    const adapter = new StubAdapter(happyScript('t1'));
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapter), sink, 1);

    const h1 = mgr.handleDispatch(makeDispatchFrame({ dispatchId: 'd1' }));
    const h2 = mgr.handleDispatch(makeDispatchFrame({ dispatchId: 'd2' }));
    await Promise.all([h1, h2]);
    await flush();

    const rejected = sink.byType('task_rejected') as Array<{ dispatchId: string; reason: string }>;
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ dispatchId: 'd2', reason: 'busy' });
    expect(adapter.executeCalls).toBe(1);
  });

  it('ignores a duplicate dispatch id that arrives during prepare', async () => {
    const adapter = new StubAdapter(happyScript('t1'));
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapter), sink, 2);

    const h1 = mgr.handleDispatch(makeDispatchFrame({ dispatchId: 'd1' }));
    const h2 = mgr.handleDispatch(makeDispatchFrame({ dispatchId: 'd1' }));
    await Promise.all([h1, h2]);
    await flush();

    expect(adapter.executeCalls).toBe(1);
    expect(sink.byType('task_accepted')).toHaveLength(1);
  });

  it('a task_cancel during prepare prevents the runtime from starting', async () => {
    const adapter = new StubAdapter(happyScript('t1'));
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapter), sink, 2);

    const handling = mgr.handleDispatch(makeDispatchFrame({ dispatchId: 'd1' }));
    await mgr.cancel('d1'); // arrives while prepare is in flight

    await handling;
    await flush();

    expect(adapter.executeCalls).toBe(0);
    expect(sink.byType('task_accepted')).toHaveLength(0);
    const rejected = sink.byType('task_rejected') as Array<{ dispatchId: string }>;
    expect(rejected).toHaveLength(1);
    expect(mgr.has('d1')).toBe(false);
  });

  it('re-sends the artifacts frame for resumed terminal dispatches on reconnect', async () => {
    class ArtifactProducingAdapter extends StubAdapter {
      async prepare(
        ...args: Parameters<StubAdapter['prepare']>
      ): ReturnType<StubAdapter['prepare']> {
        const [, workspace] = args;
        await mkdir(workspace.artifactsDir, { recursive: true });
        await writeFile(join(workspace.artifactsDir, 'out.txt'), 'artifact-data');
        return super.prepare(...args);
      }
    }
    const frame = makeDispatchFrame({ dispatchId: 'd1' });
    const adapter = new ArtifactProducingAdapter(happyScript(frame.taskId));
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapter), sink, 2);

    await mgr.handleDispatch(frame);
    await waitUntil(() => expect(sink.byType('artifacts')).toHaveLength(1));

    // Server reconnects and resumes the dispatch (events still unacked).
    mgr.reconcileOnReconnect(['d1'], []);
    expect(sink.byType('artifacts')).toHaveLength(2);
  });

  it('does not retire a fully-acked terminal dispatch until artifacts settle', async () => {
    const frame = makeDispatchFrame({ dispatchId: 'd1' });
    const adapter = new StubAdapter(happyScript(frame.taskId));
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapter), sink, 2);

    await mgr.handleDispatch(frame);
    await flush();
    await flush();

    const entry = (
      mgr as unknown as {
        active: Map<string, { artifactsSettled: boolean; terminal: boolean }>;
      }
    ).active.get('d1');
    expect(entry?.terminal).toBe(true);

    // Simulate the terminal event being acked while artifact collection is
    // still in flight: retirement must wait for artifactsSettled.
    entry!.artifactsSettled = false;
    mgr.ack('d1', 3);
    expect(mgr.has('d1')).toBe(true);

    entry!.artifactsSettled = true;
    mgr.ack('d1', 3);
    expect(mgr.has('d1')).toBe(false);
  });

  it('maps task_cancel to adapter.cancel with the runtime executionId', async () => {
    const frame = makeDispatchFrame();
    const gate = deferred();
    const adapter = new StubAdapter(
      [{ type: 'runtime_started', executionId: 'exec-xyz' }],
      { gate: gate.promise },
    );
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapter), sink);

    await mgr.handleDispatch(frame);
    gate.resolve();
    await flush();

    await mgr.cancel(frame.dispatchId, true);
    expect(adapter.cancelCalls).toContainEqual({ executionId: 'exec-xyz', force: true });

    // drain
    await flush();
  });

  it('runs resume mode via adapter.resume with the sdkSessionId', async () => {
    const frame = makeDispatchFrame({
      mode: 'resume',
      sdkSessionId: 'sdk-session-42',
    });
    const adapter = new StubAdapter([
      { type: 'completed', result: makeCompletedResult(frame.taskId) },
    ]);
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapter), sink);

    await mgr.handleDispatch(frame);
    await flush();

    expect(adapter.resumeCalls).toBe(1);
    expect(adapter.executeCalls).toBe(0);
    expect(adapter.lastResumeSdkSessionId).toBe('sdk-session-42');
    expect(sink.byType('task_event')).toHaveLength(1);
  });

  it('rejects when no adapter is available for the runtime', async () => {
    const frame = makeDispatchFrame();
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(undefined), sink);

    await mgr.handleDispatch(frame);
    await flush();

    const rejected = sink.byType('task_rejected') as Array<{ reason: string }>;
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/No healthy runtime adapter/);
  });

  it('emits a synthetic failed event when the runtime stream throws', async () => {
    const frame = makeDispatchFrame();
    const adapter = new StubAdapter([]);
    const throwingStream = (async function* (): AsyncGenerator<RuntimeEvent> {
      if (Date.now() >= 0) throw new Error('runtime exploded');
      yield { type: 'status', message: 'unreachable' };
    })();
    vi.spyOn(adapter, 'execute').mockReturnValue(throwingStream);
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapter), sink);

    await mgr.handleDispatch(frame);
    await flush();

    const events = sink.byType('task_event') as Array<{ event: RuntimeEvent }>;
    const failed = events.find((e) => e.event.type === 'failed');
    expect(failed).toBeDefined();
    expect((failed!.event as { error: string }).error).toMatch(/runtime exploded/);
  });

  it('drops acked events from the replay buffer', async () => {
    const frame = makeDispatchFrame();
    const adapter = new StubAdapter(happyScript(frame.taskId));
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapter), sink);

    await mgr.handleDispatch(frame);
    await flush();

    // Ack everything; reconnect replay should then produce nothing.
    mgr.ack(frame.dispatchId, 3);
    const before = sink.sent.length;
    mgr.reconcileOnReconnect([frame.dispatchId], []);
    expect(sink.sent.length).toBe(before); // nothing replayed
  });

  // ── Finding #7: terminal-but-unacked dispatches survive a pre-ack disconnect ──

  it('keeps a terminal dispatch in runningDispatchIds until its events are acked', async () => {
    const frame = makeDispatchFrame({ dispatchId: 'terminal-unacked' });
    const adapter = new StubAdapter(happyScript(frame.taskId));
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapter), sink);

    await mgr.handleDispatch(frame);
    await waitUntil(
      () =>
        expect(
          mgr.activeCount() === 0 && mgr.runningDispatchIds().includes('terminal-unacked'),
        ).toBe(true),
    );

    // The dispatch produced its terminal `completed` event but the server has
    // not acked anything yet — it MUST still be announced on the next hello so
    // the gateway resumes (and consumes the terminal event) rather than
    // synthesizing task_lost.
    expect(mgr.has('terminal-unacked')).toBe(true);
    expect(mgr.runningDispatchIds()).toContain('terminal-unacked');
    // It no longer counts toward the concurrency cap (it is not in-flight).
    expect(mgr.activeCount()).toBe(0);

    // After a full ack the terminal dispatch retires and drops out of hello.
    mgr.ack('terminal-unacked', 3);
    await waitUntil(() => expect(mgr.has('terminal-unacked')).toBe(false));
    expect(mgr.has('terminal-unacked')).toBe(false);
    expect(mgr.runningDispatchIds()).not.toContain('terminal-unacked');
  });

  it('replays the terminal event on reconnect resume (never task_lost)', async () => {
    const frame = makeDispatchFrame({ dispatchId: 'replay-terminal' });
    const adapter = new StubAdapter(happyScript(frame.taskId));
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapter), sink);

    await mgr.handleDispatch(frame);
    await flush();

    // Simulate a pre-ack disconnect: the sink dropped the frames (server never
    // saw them) and now the server asks to resume on reconnect.
    const before = sink.sent.length;
    mgr.reconcileOnReconnect(['replay-terminal'], []);
    const replayed = sink.sent.slice(before) as Array<{
      type: string;
      event?: RuntimeEvent;
    }>;
    const replayedTerminal = replayed.find(
      (f) => f.type === 'task_event' && f.event?.type === 'completed',
    );
    expect(replayedTerminal).toBeDefined();
  });

  it('retires a terminal dispatch placed in cancelDispatchIds on reconnect', async () => {
    const frame = makeDispatchFrame({ dispatchId: 'retire-terminal' });
    const adapter = new StubAdapter(happyScript(frame.taskId));
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapter), sink);

    await mgr.handleDispatch(frame);
    await flush();
    expect(mgr.has('retire-terminal')).toBe(true);

    mgr.reconcileOnReconnect([], ['retire-terminal']);
    expect(mgr.has('retire-terminal')).toBe(false);
  });

  // ── Finding #8: send-side frame preflight truncates oversized event data ──

  it('truncates an oversized stdout frame so it passes validateFrameSize, keeping the marker', async () => {
    const frame = makeDispatchFrame({ dispatchId: 'huge-stdout' });
    // A stdout chunk larger than the frame cap forces send-side truncation.
    const hugeData = 'x'.repeat(MAX_FRAME_BYTES + 1024);
    const adapter = new StubAdapter([
      { type: 'runtime_started', executionId: 'exec-huge' },
      { type: 'stdout', data: hugeData },
      { type: 'completed', result: makeCompletedResult(frame.taskId) },
    ]);
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapter), sink);

    await mgr.handleDispatch(frame);
    await flush();

    const events = sink.byType('task_event') as Array<{ event: RuntimeEvent }>;
    const stdoutFrameRaw = sink.sent.find(
      (f) => (f as { event?: RuntimeEvent }).event?.type === 'stdout',
    );
    expect(stdoutFrameRaw).toBeDefined();
    const stdoutEvent = (stdoutFrameRaw as { event: RuntimeEvent }).event as {
      type: 'stdout';
      data: string;
    };
    // The serialized frame fits within the cap and the data carries the marker.
    expect(validateFrameSize(JSON.stringify(stdoutFrameRaw))).toBe(true);
    expect(stdoutEvent.data).toMatch(/\.\.\. \[truncated \d+ bytes\]$/);
    expect(stdoutEvent.data.length).toBeLessThan(hugeData.length);
    // The dispatch still completed normally — truncation does not fail the run.
    const terminal = events.find((e) => e.event.type === 'completed');
    expect(terminal).toBeDefined();
  });

  it('fails the dispatch with a synthetic failed event when a non-truncatable frame is oversized', async () => {
    const frame = makeDispatchFrame({ dispatchId: 'huge-status' });
    // A `status` event (no truncatable data field) larger than the cap cannot be
    // shrunk; the daemon must drop it and surface a failed event.
    const hugeMessage = 'y'.repeat(MAX_FRAME_BYTES + 1024);
    const adapter = new StubAdapter([
      { type: 'runtime_started', executionId: 'exec-huge' },
      { type: 'status', message: hugeMessage },
      { type: 'completed', result: makeCompletedResult(frame.taskId) },
    ]);
    const sink = new RecordingSink();
    const mgr = new DispatchManager(stubRuntimeManager(adapter), sink);

    await mgr.handleDispatch(frame);
    await flush();

    const events = sink.byType('task_event') as Array<{ event: RuntimeEvent }>;
    // No oversized status frame crossed the wire.
    expect(events.some((e) => e.event.type === 'status')).toBe(false);
    // A synthetic failed event terminated the dispatch.
    const failed = events.find((e) => e.event.type === 'failed');
    expect(failed).toBeDefined();
    expect((failed!.event as { error: string }).error).toMatch(/oversized/i);
    // The run loop stopped — the later `completed` event was never streamed.
    expect(events.some((e) => e.event.type === 'completed')).toBe(false);
  });
});
