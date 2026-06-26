import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hashMachineSecret } from '@open-tag/storage';
import type { TaskSpec, RuntimeEvent } from '@open-tag/core-types';
import { DaemonGateway } from '../daemon-gateway/index.js';
import { RemoteRuntimeAdapter, RemoteDispatchError } from '../remote-runtime-adapter.js';
import type { MachineRow } from '../machine-routing.js';
import { createFakeGatewayDb, type FakeGatewayDbState } from './fake-gateway-db.js';
import { ScriptedDaemon } from './scripted-daemon.js';

const loggerFns = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
const logger = loggerFns as never;

const MACHINE_ID = 'm-int-1';
const SECRET = 'super-secret-value';

function machineRow(overrides: Partial<MachineRow> = {}): MachineRow {
  return {
    id: MACHINE_ID,
    tenantKey: 'tenant-a',
    ownerOpenId: 'ou_owner',
    name: 'test-laptop',
    secretHash: hashMachineSecret(SECRET),
    status: 'online',
    capabilities: { runtimes: ['claude_code', 'codex'] },
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as MachineRow;
}

function taskSpec(): TaskSpec {
  return {
    taskId: randomUUID(),
    sessionId: randomUUID(),
    taskType: 'chat_reply',
    goal: 'do the thing',
    runtimeHint: 'auto',
    constraints: {},
    context: { systemPrompt: '', recentTurns: [] },
  } as unknown as TaskSpec;
}

function workspace() {
  return {
    runId: 'run-1',
    workspacePath: '/tmp/ws',
    cwd: '/tmp/ws',
    inputDir: '/tmp/ws/in',
    outputDir: '/tmp/ws/out',
    repoDir: '/tmp/ws/repo',
    artifactsDir: '/tmp/ws/artifacts',
    logsDir: '/tmp/ws/logs',
  };
}

const completed: RuntimeEvent = {
  type: 'completed',
  result: {
    taskId: randomUUID(),
    status: 'completed',
    output: { text: 'done' },
    metrics: { durationMs: 1, tokenIn: 0, tokenOut: 0, estimatedCostUsd: 0 },
  },
} as RuntimeEvent;

async function drain(stream: AsyncGenerator<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

describe('RemoteRuntimeAdapter ↔ scripted daemon (real ws)', () => {
  let gateway: DaemonGateway;
  let state: FakeGatewayDbState;
  let url: string;
  let daemon: ScriptedDaemon | undefined;

  async function start(machine: MachineRow = machineRow()) {
    const made = createFakeGatewayDb({ machines: [machine] });
    state = made.state;
    void state;
    gateway = new DaemonGateway({ db: made.db, logger, port: 0 });
    await gateway.start();
    url = `ws://127.0.0.1:${gateway.boundPort()}/daemon/ws`;
  }

  beforeEach(() => vi.clearAllMocks());

  afterEach(async () => {
    daemon?.close();
    daemon = undefined;
    await gateway?.stop();
  });

  it('a cancel that races ahead of execute latches and prevents the dispatch', async () => {
    await start();
    const adapter = new RemoteRuntimeAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      logger,
    });

    // Watchdog/shutdown cancel arrives before execute() sent task_dispatch.
    await expect(adapter.cancel('task-x')).resolves.toBe('termination_started');

    const sendSpy = vi.spyOn(gateway, 'sendToMachine');
    await expect(drain(adapter.execute({} as never, taskSpec()))).rejects.toBeInstanceOf(
      RemoteDispatchError,
    );
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('accept → events → completed (in order)', async () => {
    await start();
    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await daemon.connect();
    await daemon.waitForType('hello_ok');

    const adapter = new RemoteRuntimeAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      logger,
    });

    // Script the daemon: accept on dispatch, then stream three events.
    void daemon.waitForType('task_dispatch').then((frame) => {
      const dispatchId = (frame as { dispatchId: string }).dispatchId;
      daemon!.accept(dispatchId);
      daemon!.emitEvent(dispatchId, 1, { type: 'status', message: 'starting' });
      daemon!.emitEvent(dispatchId, 2, { type: 'progress', percent: 50, message: 'half' });
      daemon!.emitEvent(dispatchId, 3, completed);
    });

    const handle = await adapter.prepare(taskSpec(), workspace());
    const events = await drain(adapter.execute(handle, taskSpec()));

    expect(events.map((e) => e.type)).toEqual(['status', 'progress', 'completed']);
  });

  it('execute dispatches the contextual spec goal + systemPromptAppend (finding #4)', async () => {
    await start();
    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await daemon.connect();
    await daemon.waitForType('hello_ok');

    const adapter = new RemoteRuntimeAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      runtimeEnv: { a: 'b' },
      logger,
    });

    // Capture the dispatch frame the daemon receives, then accept + complete.
    const dispatchSeen = daemon.waitForType('task_dispatch');
    void dispatchSeen.then((frame) => {
      const dispatchId = (frame as { dispatchId: string }).dispatchId;
      daemon!.accept(dispatchId);
      daemon!.emitEvent(dispatchId, 1, completed);
    });

    // prepare() is a no-op; execute() carries the contextual spec (its OWN goal)
    // plus systemPromptAppend onto the wire.
    const handle = await adapter.prepare(taskSpec(), workspace());
    const contextualSpec = { ...taskSpec(), goal: 'contextual goal with history' };
    await drain(adapter.execute(handle, contextualSpec, 'APPEND-PROMPT'));

    const frame = (await dispatchSeen) as {
      mode: string;
      spec: { goal: string };
      systemPromptAppend?: string;
      runtimeEnv?: Record<string, string>;
    };
    expect(frame.mode).toBe('prepare_execute');
    expect(frame.spec.goal).toBe('contextual goal with history');
    expect(frame.systemPromptAppend).toBe('APPEND-PROMPT');
    expect(frame.runtimeEnv).toEqual({ a: 'b' });
  });

  it('execute includes late-built contextual images in the dispatch frame', async () => {
    await start();
    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await daemon.connect();
    await daemon.waitForType('hello_ok');
    const buildImages = vi.fn(async (spec: TaskSpec) =>
      spec.context.imageAttachments?.map((attachment) => ({
        name: `${attachment.imageKey}.png`,
        base64: Buffer.from(attachment.messageId).toString('base64'),
      })) ?? [],
    );
    const adapter = new RemoteRuntimeAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      images: [{ name: 'initial.png', base64: Buffer.from('initial').toString('base64') }],
      buildImages,
      logger,
    });

    const dispatchSeen = daemon.waitForType('task_dispatch');
    void dispatchSeen.then((frame) => {
      const dispatchId = (frame as { dispatchId: string }).dispatchId;
      daemon!.accept(dispatchId);
      daemon!.emitEvent(dispatchId, 1, completed);
    });

    const handle = await adapter.prepare(taskSpec(), workspace());
    const contextualSpec = {
      ...taskSpec(),
      context: {
        systemPrompt: '',
        recentTurns: [],
        imageAttachments: [{ imageKey: 'history-img', messageId: 'om_history' }],
      },
    } as TaskSpec;
    await drain(adapter.execute(handle, contextualSpec));

    const frame = (await dispatchSeen) as {
      images?: Array<{ name: string; base64: string }>;
    };
    expect(buildImages).toHaveBeenCalledWith(contextualSpec);
    expect(frame.images?.map((image) => image.name)).toEqual(['initial.png', 'history-img.png']);
  });

  it('resume dispatches mode=resume carrying the sdkSessionId + prompt as goal (finding #4)', async () => {
    await start();
    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await daemon.connect();
    await daemon.waitForType('hello_ok');

    const adapter = new RemoteRuntimeAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      logger,
    });

    const dispatchSeen = daemon.waitForType('task_dispatch');
    void dispatchSeen.then((frame) => {
      const dispatchId = (frame as { dispatchId: string }).dispatchId;
      daemon!.accept(dispatchId);
      daemon!.emitEvent(dispatchId, 1, completed);
    });

    await drain(adapter.resume('sdk-prev-123', 'resume prompt', workspace(), 'RESUME-APPEND'));

    const frame = (await dispatchSeen) as {
      mode: string;
      sdkSessionId?: string;
      spec: { goal: string };
      systemPromptAppend?: string;
    };
    expect(frame.mode).toBe('resume');
    expect(frame.sdkSessionId).toBe('sdk-prev-123');
    expect(frame.spec.goal).toBe('resume prompt');
    expect(frame.systemPromptAppend).toBe('RESUME-APPEND');
  });

  it('cancel before any dispatch is sent is a no-op success (finding #4)', async () => {
    await start();
    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await daemon.connect();
    await daemon.waitForType('hello_ok');

    const adapter = new RemoteRuntimeAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      logger,
    });

    // No execute/resume called yet ⇒ nothing on the wire ⇒ no-op success.
    await expect(adapter.cancel('exec-id')).resolves.toBe('termination_started');
  });

  it('oversized inline image degrades to text-only and still dispatches (finding #8, D11)', async () => {
    await start();
    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await daemon.connect();
    await daemon.waitForType('hello_ok');

    // A ~20 MiB image base64 blows past the 16 MiB frame cap; the adapter must
    // drop it, warn, and re-serialize text-only rather than fail the dispatch.
    const hugeBase64 = 'A'.repeat(20 * 1024 * 1024);
    const adapter = new RemoteRuntimeAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      images: [{ name: 'huge.png', base64: hugeBase64 }],
      logger,
    });

    const dispatchSeen = daemon.waitForType('task_dispatch');
    void dispatchSeen.then((frame) => {
      const dispatchId = (frame as { dispatchId: string }).dispatchId;
      daemon!.accept(dispatchId);
      daemon!.emitEvent(dispatchId, 1, completed);
    });

    const handle = await adapter.prepare(taskSpec(), workspace());
    const events = await drain(adapter.execute(handle, taskSpec()));

    const frame = (await dispatchSeen) as { images?: unknown[] };
    // Images dropped from the wire (degraded to text), dispatch still completed.
    expect(frame.images).toBeUndefined();
    expect(events.at(-1)?.type).toBe('completed');
    expect(loggerFns.warn).toHaveBeenCalled();
  });

  it('rejected(busy) raises a typed dispatch error', async () => {
    await start();
    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await daemon.connect();
    await daemon.waitForType('hello_ok');

    const adapter = new RemoteRuntimeAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      logger,
    });
    void daemon.waitForType('task_dispatch').then((frame) => {
      daemon!.reject((frame as { dispatchId: string }).dispatchId, 'busy');
    });

    // Dispatch is sent from execute() (finding #4), so the typed error surfaces
    // when the generator is driven, not from the now-no-op prepare().
    const handle = await adapter.prepare(taskSpec(), workspace());
    await expect(drain(adapter.execute(handle, taskSpec()))).rejects.toBeInstanceOf(
      RemoteDispatchError,
    );
  });

  it('accept timeout fails with a dispatch-timeout error', async () => {
    await start();
    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await daemon.connect();
    await daemon.waitForType('hello_ok');

    const adapter = new RemoteRuntimeAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      logger,
      acceptTimeoutMs: 50, // daemon never accepts
    });

    const handle = await adapter.prepare(taskSpec(), workspace());
    await expect(drain(adapter.execute(handle, taskSpec()))).rejects.toThrow(/did not accept/);
  });

  it('offline machine (no socket) fails fast', async () => {
    await start();
    // No daemon connects ⇒ machine not online.
    const adapter = new RemoteRuntimeAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      logger,
    });
    const handle = await adapter.prepare(taskSpec(), workspace());
    await expect(drain(adapter.execute(handle, taskSpec()))).rejects.toThrow(/offline/);
  });

  it('mid-stream socket kill + reconnect with replayed duplicate seqs ⇒ exactly-once, in order', async () => {
    await start();
    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await daemon.connect([]);
    await daemon.waitForType('hello_ok');

    const adapter = new RemoteRuntimeAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      logger,
      disconnectGraceMs: 5000,
    });

    let dispatchId = '';
    void daemon.waitForType('task_dispatch').then((frame) => {
      dispatchId = (frame as { dispatchId: string }).dispatchId;
      daemon!.accept(dispatchId);
      daemon!.emitEvent(dispatchId, 1, { type: 'status', message: 's1' });
      daemon!.emitEvent(dispatchId, 2, { type: 'status', message: 's2' });
    });

    const handle = await adapter.prepare(taskSpec(), workspace());
    const collected: RuntimeEvent[] = [];
    const streamDone = (async () => {
      for await (const e of adapter.execute(handle, taskSpec())) collected.push(e);
    })();

    // Wait until the first two events are delivered.
    await vi.waitFor(() => expect(collected.length).toBe(2));

    // Kill the socket mid-stream; the generator stays open during grace (D12).
    daemon.terminate();
    await new Promise((r) => setTimeout(r, 50));

    // Reconnect and replay: seq 2 is a duplicate (already delivered), seq 3-4 new.
    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await daemon.connect([dispatchId]);
    await daemon.waitForType('hello_ok');
    daemon.emitEvent(dispatchId, 2, { type: 'status', message: 's2-dup' });
    daemon.emitEvent(dispatchId, 3, { type: 'status', message: 's3' });
    daemon.emitEvent(dispatchId, 4, completed);

    await streamDone;

    // Exactly-once, in order: s1, s2, s3, completed — the duplicate seq 2 dropped.
    expect(collected.map((e) => (e.type === 'status' ? e.message : e.type))).toEqual([
      's1',
      's2',
      's3',
      'completed',
    ]);
  });

  it('re-announced dispatch replays its terminal event ⇒ consumed + acked, never task_lost (replay-of-terminal)', async () => {
    await start();
    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await daemon.connect([]);
    await daemon.waitForType('hello_ok');

    const adapter = new RemoteRuntimeAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      logger,
      disconnectGraceMs: 5000,
    });

    let dispatchId = '';
    void daemon.waitForType('task_dispatch').then((frame) => {
      dispatchId = (frame as { dispatchId: string }).dispatchId;
      daemon!.accept(dispatchId);
      daemon!.emitEvent(dispatchId, 1, { type: 'status', message: 's1' });
      // NOTE: terminal event (seq 2) is intentionally NOT sent before the flap —
      // it lands only on the replay after reconnect.
    });

    const handle = await adapter.prepare(taskSpec(), workspace());
    const collected: RuntimeEvent[] = [];
    const streamDone = (async () => {
      for await (const e of adapter.execute(handle, taskSpec())) collected.push(e);
    })();
    await vi.waitFor(() => expect(collected.length).toBe(1));

    // Flap, then a NEW daemon re-announces the SAME dispatch as still running and
    // replays the as-yet-unacked terminal event. The open generator must consume
    // it and ack it; the gateway must NOT synthesise task_lost for a re-announced
    // dispatch.
    daemon.terminate();
    await new Promise((r) => setTimeout(r, 50));
    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await daemon.connect([dispatchId]);
    await daemon.waitForType('hello_ok');
    daemon.emitEvent(dispatchId, 2, completed);

    await streamDone;

    // The terminal event was delivered (no spurious failed), and an event_ack for
    // the terminal seq flowed back so the daemon can retire the dispatch.
    expect(collected.map((e) => (e.type === 'status' ? e.message : e.type))).toEqual([
      's1',
      'completed',
    ]);
    await daemon.waitFor((f) => f.type === 'event_ack' && (f as { lastSeq: number }).lastSeq >= 2);
  });

  it('task_lost ⇒ generator yields a failed event', async () => {
    await start();
    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await daemon.connect();
    await daemon.waitForType('hello_ok');

    const adapter = new RemoteRuntimeAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      logger,
    });

    void daemon.waitForType('task_dispatch').then((frame) => {
      const dispatchId = (frame as { dispatchId: string }).dispatchId;
      daemon!.accept(dispatchId);
      daemon!.lost(dispatchId);
    });

    const handle = await adapter.prepare(taskSpec(), workspace());
    const events = await drain(adapter.execute(handle, taskSpec()));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('failed');
  });

  it('supersede: a second connection closes the first with hello_error superseded (D14)', async () => {
    await start();
    const first = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await first.connect();
    await first.waitForType('hello_ok');

    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await daemon.connect();
    await daemon.waitForType('hello_ok');

    const superseded = await first.waitFor(
      (f) => f.type === 'hello_error' && f.code === 'superseded',
    );
    expect(superseded.type).toBe('hello_error');
    first.close();
  });

  it('whoami while a WS is active is a pure read and does not close the socket (finding #3)', async () => {
    await start();
    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await daemon.connect();
    await daemon.waitForType('hello_ok');
    expect(gateway.isMachineOnline(MACHINE_ID)).toBe(true);

    // A whoami probe with the SAME creds must NOT supersede or close the live WS.
    const httpUrl = `http://127.0.0.1:${gateway.boundPort()}/daemon/whoami`;
    const res = await fetch(httpUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${MACHINE_ID}.${SECRET}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { machineId: string };
    expect(body.machineId).toBe(MACHINE_ID);

    // The socket is still live: the machine remains online and the daemon never
    // received a hello_error (superseded/revoked).
    await new Promise((r) => setTimeout(r, 50));
    expect(gateway.isMachineOnline(MACHINE_ID)).toBe(true);
    expect(daemon.received.some((f) => f.type === 'hello_error')).toBe(false);
  });

  it('revoked machine is refused at WS auth', async () => {
    await start(machineRow({ status: 'revoked' }));
    daemon = new ScriptedDaemon(url, MACHINE_ID, SECRET);
    await expect(daemon.connect()).rejects.toThrow(/upgrade rejected: 401/);
  });

  it('wrong secret is refused at WS auth (uniform 401)', async () => {
    await start();
    daemon = new ScriptedDaemon(url, MACHINE_ID, 'wrong-secret');
    await expect(daemon.connect()).rejects.toThrow(/upgrade rejected: 401/);
  });
});
