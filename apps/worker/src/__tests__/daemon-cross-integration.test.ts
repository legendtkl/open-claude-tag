/**
 * Stage 6.1 — cross-end integration suite.
 *
 * Wires the REAL worker gateway (`apps/worker` DaemonGateway + RemoteRuntimeAdapter)
 * against the REAL daemon client (`apps/daemon` ConnectionManager + DispatchManager,
 * imported via the `@open-tag/daemon/testing` barrel) over a REAL WebSocket in a
 * single vitest process. Only the daemon-side `RuntimeAdapter` is stubbed
 * (`StubAdapter`); both ends — gateway routing, hello/supersede/liveness, the
 * adapter's seq/dedup/grace logic, and the daemon's reconnect/replay/reconcile
 * logic — run their production code.
 *
 * Each scenario asserts through BOTH ends. Heartbeat/backoff timings are forced
 * fast through the constructor options both ends already expose (no source edits).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hashMachineSecret } from '@open-tag/storage';
import type { TaskSpec, RuntimeEvent } from '@open-tag/core-types';
import {
  ConnectionManager,
  StubAdapter,
  stubRuntimeManager,
  type DaemonConfig,
} from '@open-tag/daemon/testing';
import { DaemonGateway } from '../daemon-gateway/index.js';
import { RemoteRuntimeAdapter, RemoteDispatchError } from '../remote-runtime-adapter.js';
import type { MachineRow } from '../machine-routing.js';
import { createFakeGatewayDb, type FakeGatewayDbState } from './fake-gateway-db.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

const MACHINE_ID = 'm-cross-1';
const SECRET = 'cross-end-secret-value-123456';

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

function daemonConfig(serverUrl: string): DaemonConfig {
  return { serverUrl, machineId: MACHINE_ID, machineSecret: SECRET, name: 'cross-test' };
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

function completedResult(): RuntimeEvent {
  return {
    type: 'completed',
    result: {
      taskId: randomUUID(),
      status: 'completed',
      output: { text: 'done' },
      metrics: { durationMs: 1, tokenIn: 0, tokenOut: 0, estimatedCostUsd: 0 },
    },
  } as RuntimeEvent;
}

/** Drain a RuntimeEvent generator to completion. */
async function drain(stream: AsyncGenerator<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

/** A real daemon client wired to a stub adapter, with fast heartbeat/backoff. */
function buildDaemon(opts: {
  serverUrl: string;
  script: RuntimeEvent[];
  adapterOpts?: ConstructorParameters<typeof StubAdapter>[1];
  pingIntervalMs?: number;
}): { connection: ConnectionManager; adapter: StubAdapter } {
  const adapter = new StubAdapter(opts.script, opts.adapterOpts);
  const runtimeManager = stubRuntimeManager(adapter);
  const connection = new ConnectionManager({
    config: daemonConfig(opts.serverUrl),
    runtimeManager,
    // Force fast reconnect so the flap scenario stays well under the suite budget.
    backoff: { next: () => 20, reset: () => {}, peekBase: () => 20, attempts: () => 0 } as never,
    pingIntervalMs: opts.pingIntervalMs ?? 200,
    inboundSilenceDeadlineMs: 60_000,
  });
  return { connection, adapter };
}

describe('Stage 6.1 — real gateway ↔ real daemon (single ws process)', () => {
  let gateway: DaemonGateway;
  let state: FakeGatewayDbState;
  let serverUrl: string;
  const connections: ConnectionManager[] = [];

  async function startGateway(machine: MachineRow = machineRow()) {
    const made = createFakeGatewayDb({ machines: [machine] });
    state = made.state;
    gateway = new DaemonGateway({ db: made.db, logger, port: 0 });
    await gateway.start();
    serverUrl = `http://127.0.0.1:${gateway.boundPort()}`;
  }

  /** Spin up a real daemon, run it, and wait until it is hello-acknowledged. */
  async function connectDaemon(daemon: ConnectionManager): Promise<void> {
    connections.push(daemon);
    void daemon.run().catch(() => {
      // run() rejects on a fatal hello_error (e.g. superseded) — expected in some
      // scenarios; the scenario asserts the outcome explicitly.
    });
    await vi.waitFor(() => expect(daemon.connected).toBe(true), { timeout: 4000, interval: 10 });
    // Also wait until the gateway considers the machine online (hello processed).
    await vi.waitFor(() => expect(gateway.isMachineOnline(MACHINE_ID)).toBe(true), {
      timeout: 4000,
      interval: 10,
    });
  }

  function remoteAdapter(overrides: Partial<ConstructorParameters<typeof RemoteRuntimeAdapter>[0]> = {}) {
    return new RemoteRuntimeAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      logger,
      ...overrides,
    });
  }

  beforeEach(() => vi.clearAllMocks());

  afterEach(async () => {
    await Promise.allSettled(connections.splice(0).map((c) => c.stop()));
    await gateway?.stop();
  });

  // ── (a) pairing + hello → machine online ──────────────────────────────────
  it('(a) pairs via real REST, then the daemon connects with the issued creds and goes online', async () => {
    // Seed a usable pairing token in the fake DB and pair via the real REST route.
    const { hashPairingToken } = await import('@open-tag/storage');
    const token = 'cross-pair-token';
    const made = createFakeGatewayDb({
      tokens: [
        {
          id: 'tok-1',
          tokenHash: hashPairingToken(token),
          tenantKey: 'tenant-a',
          issuerOpenId: 'ou_owner',
          chatId: 'oc_chat',
          machineName: 'paired-laptop',
          expiresAt: new Date(Date.now() + 60_000),
          usedAt: null,
          createdAt: new Date(),
        },
      ],
      insertedMachineId: MACHINE_ID,
    });
    state = made.state;
    gateway = new DaemonGateway({ db: made.db, logger, port: 0 });
    await gateway.start();
    serverUrl = `http://127.0.0.1:${gateway.boundPort()}`;

    // Real REST pairing exchange: token → machineId + machineSecret.
    const res = await fetch(`${serverUrl}/daemon/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        name: 'paired-laptop',
        capabilities: { runtimes: ['claude_code'] },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { machineId: string; machineSecret: string };
    expect(body.machineId).toBe(MACHINE_ID);
    expect(typeof body.machineSecret).toBe('string');
    expect(state.tokenUpdates).toHaveLength(1); // single-use token consumed

    // The paired machine row now exists with the returned secret hash; expose it
    // to the WS-auth path so the daemon can connect with exactly those creds.
    state.machines.push(
      machineRow({ id: body.machineId, secretHash: hashMachineSecret(body.machineSecret) }),
    );

    // Real daemon dials with the issued creds → hello → hello_ok → online.
    const paired = new ConnectionManager({
      config: {
        serverUrl,
        machineId: body.machineId,
        machineSecret: body.machineSecret,
        name: 'paired',
      },
      runtimeManager: stubRuntimeManager(new StubAdapter([completedResult()])),
      backoff: { next: () => 20, reset: () => {}, peekBase: () => 20, attempts: () => 0 } as never,
      pingIntervalMs: 200,
      inboundSilenceDeadlineMs: 60_000,
    });
    await connectDaemon(paired);

    expect(gateway.isMachineOnline(MACHINE_ID)).toBe(true);
    expect(paired.connected).toBe(true);
    // markMachineOnline persisted status=online + lastSeenAt.
    const onlineUpdate = state.machineUpdates.find((u) => u.status === 'online');
    expect(onlineUpdate).toBeTruthy();
    expect(onlineUpdate).toHaveProperty('lastSeenAt');
  });

  // ── (b) dispatch happy path: full RuntimeEvent sequence end to end ─────────
  it('(b) dispatch happy path streams status/progress/session_created/completed in order', async () => {
    await startGateway();
    const script: RuntimeEvent[] = [
      { type: 'status', message: 'starting' },
      { type: 'progress', percent: 50, message: 'halfway' },
      { type: 'session_created', sdkSessionId: 'sdk-xyz' },
      completedResult(),
    ];
    const { connection } = buildDaemon({ serverUrl, script });
    await connectDaemon(connection);

    const adapter = remoteAdapter();
    const handle = await adapter.prepare(taskSpec(), workspace());
    const events = await drain(adapter.execute(handle, taskSpec()));

    expect(events.map((e) => e.type)).toEqual([
      'status',
      'progress',
      'session_created',
      'completed',
    ]);
    const sessionCreated = events.find((e) => e.type === 'session_created');
    expect(sessionCreated).toMatchObject({ sdkSessionId: 'sdk-xyz' });

    // ack flowed back to the daemon: the dispatch buffer is fully drained, so the
    // daemon retires it (no pending replay state remains).
    await vi.waitFor(() =>
      expect(connection.dispatches.runningDispatchIds()).toHaveLength(0),
    );

    // machines.lastSeenAt was updated on hello (online write captured by fake DB).
    expect(state.machineUpdates.some((u) => u.status === 'online' && 'lastSeenAt' in u)).toBe(true);
  });

  it('(b2) daemon-produced artifact ⇒ artifacts frame routed + cached before stream teardown', async () => {
    await startGateway();
    // Point the daemon harness workspaces at an isolated temp root, then use an
    // inline RuntimeAdapter that writes a real file into the dispatch workspace's
    // artifactsDir during prepare(). The REAL daemon harness then collects it via
    // collectArtifactsFromDir and sends an `artifacts` frame.
    //
    // IMPORTANT ordering nuance (verified by this test): the daemon sends
    // `artifacts` AFTER the terminal event, while the worker's RemoteRuntimeAdapter
    // unregisters its bridge in the generator's `finally` once the terminal event
    // is consumed. To observe the cache deterministically we hold the generator
    // open (delay the final pull) until the artifacts frame has been routed, then
    // read collectArtifacts — exercising the real artifacts caching path end to end.
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const prevRoot = process.env.WORKSPACES_ROOT;
    const root = await mkdtemp(join(tmpdir(), 'cross-artifacts-'));
    process.env.WORKSPACES_ROOT = root;
    try {
      const artifactWriter = new ArtifactWritingAdapter(async (artifactsDir) => {
        await mkdir(artifactsDir, { recursive: true });
        await writeFile(join(artifactsDir, 'result.txt'), 'remote artifact body');
      });
      const connection = new ConnectionManager({
        config: daemonConfig(serverUrl),
        runtimeManager: stubRuntimeManager(artifactWriter as never),
        backoff: { next: () => 20, reset: () => {}, peekBase: () => 20, attempts: () => 0 } as never,
        pingIntervalMs: 200,
        inboundSilenceDeadlineMs: 60_000,
      });
      await connectDaemon(connection);

      const adapter = remoteAdapter();
      const handle = await adapter.prepare(taskSpec(), workspace());

      // Consume up to and including the terminal event, but DO NOT make the final
      // pull that triggers teardown — leave the bridge registered so the trailing
      // `artifacts` frame is routed and cached.
      const gen = adapter.execute(handle, taskSpec());
      const seen: RuntimeEvent[] = [];
      for (;;) {
        const next = await gen.next();
        if (next.done) break;
        seen.push(next.value);
        if (next.value.type === 'completed' || next.value.type === 'failed') break;
      }
      expect(seen.at(-1)?.type).toBe('completed');

      // The artifacts frame arrives just after the terminal event; wait for it to
      // be cached, then assert the ref made it across both ends.
      let refs: Awaited<ReturnType<typeof adapter.collectArtifacts>> = [];
      await vi.waitFor(async () => {
        refs = await adapter.collectArtifacts(handle.executionId);
        expect(refs.length).toBeGreaterThanOrEqual(1);
      });
      expect(refs.some((r) => r.name === 'result.txt' || r.path?.endsWith('result.txt'))).toBe(true);

      // Now make the final pull to let the generator tear down cleanly.
      await gen.next();
    } finally {
      if (prevRoot === undefined) delete process.env.WORKSPACES_ROOT;
      else process.env.WORKSPACES_ROOT = prevRoot;
    }
  });

  // ── (c) busy rejection at the daemon concurrency cap ──────────────────────
  it('(c) daemon rejects past its concurrency cap ⇒ worker sees a typed rejection', async () => {
    await startGateway();
    // Build a real daemon whose real DispatchManager has a cap of 1 (read from
    // env at construction time), and gate the first dispatch open so it stays
    // active while the second arrives and is rejected with `busy`.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const adapter = new StubAdapter([completedResult()], { gate });
    process.env.OPEN_TAG_DAEMON_MAX_CONCURRENT_DISPATCHES = '1';
    const connection = new ConnectionManager({
      config: daemonConfig(serverUrl),
      runtimeManager: stubRuntimeManager(adapter),
      backoff: { next: () => 20, reset: () => {}, peekBase: () => 20, attempts: () => 0 } as never,
      pingIntervalMs: 200,
      inboundSilenceDeadlineMs: 60_000,
    });
    delete process.env.OPEN_TAG_DAEMON_MAX_CONCURRENT_DISPATCHES;
    await connectDaemon(connection);

    const first = remoteAdapter();
    const second = remoteAdapter();

    // First dispatch is accepted and held open by the gate. The dispatch now goes
    // out from execute() (finding #4), so iterate the generator to put it on the
    // wire; swallow its eventual rejection so the floating promise never warns.
    const firstHandle = await first.prepare(taskSpec(), workspace());
    const firstStream = drain(first.execute(firstHandle, taskSpec())).catch(() => []);
    // Wait until the daemon has accepted + is running the first dispatch (slot taken)
    // before issuing the second, so the cap is genuinely exhausted.
    await vi.waitFor(() => expect(connection.dispatches.runningDispatchIds()).toHaveLength(1), {
      timeout: 4000,
      interval: 10,
    });

    // Second dispatch arrives at the cap ⇒ rejected(busy). The typed error surfaces
    // from the generator, not from the no-op prepare().
    const secondHandle = await second.prepare(taskSpec(), workspace());
    const rejection = await drain(second.execute(secondHandle, taskSpec()))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(RemoteDispatchError);
    expect((rejection as Error).message).toMatch(/busy/);

    // Let the first finish so the suite tears down cleanly.
    release();
    const events = await firstStream;
    expect(events.at(-1)?.type).toBe('completed');
  });

  // ── (d) cancel propagation ────────────────────────────────────────────────
  it('(d) worker cancel() ⇒ daemon adapter.cancel invoked ⇒ failed/cancelled propagates', async () => {
    await startGateway();
    // Hold the adapter open so cancel arrives mid-flight; on cancel the stub
    // yields nothing more, so the harness ends the stream. We assert the daemon's
    // adapter.cancel was called.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { connection, adapter: stub } = buildDaemon({
      serverUrl,
      script: [{ type: 'status', message: 'working' }, completedResult()],
      adapterOpts: { gate },
    });
    await connectDaemon(connection);

    const adapter = remoteAdapter({ disconnectGraceMs: 5_000 });
    const handle = await adapter.prepare(taskSpec(), workspace());
    const streamDone = drain(adapter.execute(handle, taskSpec()));

    // The dispatch now goes out from execute() (finding #4). The daemon registers
    // a placeholder before prepare completes, so wait until the stub runtime has
    // actually entered execute() before cancelling; otherwise the correct behavior
    // is "cancelled before start" and no runtime cancel is issued.
    await vi.waitFor(() => expect(stub.executeCalls).toBeGreaterThanOrEqual(1), {
      timeout: 4000,
      interval: 10,
    });

    // Issue cancel from the worker side.
    const outcome = await adapter.cancel(handle.executionId);
    expect(outcome).toBe('termination_started');

    // The daemon's stub adapter.cancel was invoked for this dispatch.
    await vi.waitFor(() => expect(stub.cancelCalls.length).toBeGreaterThanOrEqual(1));

    // Release the gate so the (now-cancelled) run finishes and the stream closes.
    release();
    const events = await streamDone;
    // Terminal event present (completed, since the stub script ends in completed
    // once unblocked — cancellation reached the runtime, which is the assertion).
    expect(events.some((e) => e.type === 'completed' || e.type === 'failed')).toBe(true);
  });

  // ── (e) flap: kill the socket mid-stream ⇒ reconnect + replay, exactly once ─
  it('(e) mid-stream socket kill ⇒ daemon reconnects, replays, worker yields each event once in order', async () => {
    await startGateway();
    // Drive events manually from the stub via a controllable generator so we can
    // kill the socket between events and prove replay produces no loss/dup.
    const emitted: RuntimeEvent[] = [
      { type: 'status', message: 's1' },
      { type: 'status', message: 's2' },
      { type: 'status', message: 's3' },
      completedResult(),
    ];
    const { connection } = buildDaemon({ serverUrl, script: emitted, pingIntervalMs: 100 });
    await connectDaemon(connection);

    const adapter = remoteAdapter({ disconnectGraceMs: 10_000 });
    const handle = await adapter.prepare(taskSpec(), workspace());
    const collected: RuntimeEvent[] = [];
    const streamDone = (async () => {
      for await (const e of adapter.execute(handle, taskSpec())) collected.push(e);
    })();

    // Wait until at least the first event lands, then hard-kill the gateway-side
    // socket for this machine to simulate a flap.
    await vi.waitFor(() => expect(collected.length).toBeGreaterThanOrEqual(1));
    terminateGatewaySocket(gateway, MACHINE_ID);

    // The daemon reconnects (fast backoff), re-announces runningDispatchIds, the
    // gateway asks it to resume, and the daemon replays unacked events. The
    // worker's SeqTracker drops the duplicates ⇒ exactly-once, in order.
    await streamDone;
    const seqMessages = collected.map((e) => (e.type === 'status' ? e.message : e.type));
    expect(seqMessages).toEqual(['s1', 's2', 's3', 'completed']);
  });

  // ── (f) daemon restart ⇒ in-flight dispatch fails fast with restart reason ─
  it('(f) daemon restart (empty runningDispatchIds) ⇒ worker dispatch fails fast', async () => {
    await startGateway();
    // First daemon accepts and emits ONE non-terminal event (no completion), so
    // the dispatch stays in-flight (non-terminal) in the daemon's active set. We
    // then shut it down and a NEW daemon instance reconnects with an EMPTY running
    // set (simulating a process restart that lost the in-flight dispatch). The
    // gateway synthesises task_lost ⇒ the worker generator yields a single
    // `failed` event with the restart reason (D12).
    const first = buildDaemon({
      serverUrl,
      script: [{ type: 'status', message: 'before-restart' }],
      pingIntervalMs: 100,
    });
    await connectDaemon(first.connection);

    const adapter = remoteAdapter({ disconnectGraceMs: 10_000 });
    const handle = await adapter.prepare(taskSpec(), workspace());
    const collected: RuntimeEvent[] = [];
    const streamDone = (async () => {
      for await (const e of adapter.execute(handle, taskSpec())) collected.push(e);
    })();
    // Wait until the first (non-terminal) event lands so the dispatch is live.
    await vi.waitFor(() => expect(collected.length).toBeGreaterThanOrEqual(1));

    // Shut the first daemon down (no gated work ⇒ stop() returns promptly), and
    // hard-kill its gateway socket so the worker enters the disconnect grace.
    await first.connection.stop();
    terminateGatewaySocket(gateway, MACHINE_ID);

    // New daemon process: empty running set (it never knew this dispatch).
    const restarted = buildDaemon({ serverUrl, script: [completedResult()], pingIntervalMs: 100 });
    await connectDaemon(restarted.connection);

    await streamDone;
    expect(collected.at(-1)?.type).toBe('failed');
    const failed = collected.at(-1) as Extract<RuntimeEvent, { type: 'failed' }>;
    expect(failed.error).toMatch(/restart|lost/i);
  });

  // ── (g) supersede: second connection closes the first (D14, newest wins) ───
  it('(g) a second daemon with the same creds supersedes the first (hello_error superseded)', async () => {
    await startGateway();
    const first = buildDaemon({ serverUrl, script: [completedResult()], pingIntervalMs: 5_000 });
    let firstFatal: Error | null = null;
    connections.push(first.connection);
    first.connection.run().catch((e) => {
      firstFatal = e as Error;
    });
    await vi.waitFor(() => expect(first.connection.connected).toBe(true), {
      timeout: 4000,
      interval: 10,
    });

    // Second daemon, same creds ⇒ gateway closes the first with hello_error superseded.
    const second = buildDaemon({ serverUrl, script: [completedResult()], pingIntervalMs: 5_000 });
    await connectDaemon(second.connection);

    // First connection received a fatal superseded outcome.
    await vi.waitFor(() => expect(firstFatal).not.toBeNull(), { timeout: 4000, interval: 20 });
    expect((firstFatal as unknown as { exitCode?: number })?.exitCode).toBe(5);

    // The newest connection remains the live one for the machine.
    expect(gateway.isMachineOnline(MACHINE_ID)).toBe(true);
    expect(second.connection.connected).toBe(true);
  });

  // ── offline fail-fast (no daemon connected) ───────────────────────────────
  it('(extra) offline machine (no daemon) fails fast with the D8 offline copy', async () => {
    await startGateway();
    const adapter = remoteAdapter();
    // Dispatch goes out from execute() (finding #4); offline surfaces there.
    const handle = await adapter.prepare(taskSpec(), workspace());
    await expect(drain(adapter.execute(handle, taskSpec()))).rejects.toThrow(/offline/);
  });

  // ── (h) execute carries contextual goal + systemPromptAppend (finding #4) ──
  it('(h) execute serializes the contextual spec goal + systemPromptAppend onto the dispatch', async () => {
    await startGateway();
    const { connection } = buildDaemon({ serverUrl, script: [completedResult()] });
    await connectDaemon(connection);

    // Capture the task_dispatch frame the gateway forwards to the daemon. The
    // dispatch goes out from execute() (finding #4), carrying ITS spec argument
    // (the contextual goal) plus systemPromptAppend — not the bare prepare() spec.
    const captured = captureDispatchFrames(gateway, MACHINE_ID);

    const adapter = remoteAdapter();
    const handle = await adapter.prepare(taskSpec(), workspace());
    const contextualSpec = { ...taskSpec(), goal: 'contextual goal with conversation history' };
    await drain(adapter.execute(handle, contextualSpec, 'SYSTEM-PROMPT-APPEND'));

    const dispatched = captured.find((f) => f.type === 'task_dispatch') as {
      mode: string;
      spec: { goal: string };
      systemPromptAppend?: string;
    };
    expect(dispatched).toBeTruthy();
    expect(dispatched.mode).toBe('prepare_execute');
    expect(dispatched.spec.goal).toBe('contextual goal with conversation history');
    expect(dispatched.systemPromptAppend).toBe('SYSTEM-PROMPT-APPEND');
  });
});

/**
 * Wrap the gateway's `sendToMachine` to record every frame forwarded to a given
 * machine, so a test can assert the on-the-wire dispatch contract without reaching
 * into the daemon's internals (its DispatchManager belongs to the daemon agent).
 */
function captureDispatchFrames(
  gateway: DaemonGateway,
  machineId: string,
): Array<Record<string, unknown>> {
  const captured: Array<Record<string, unknown>> = [];
  const original = gateway.sendToMachine.bind(gateway);
  (gateway as unknown as { sendToMachine: typeof gateway.sendToMachine }).sendToMachine = (
    id: string,
    frame,
  ) => {
    if (id === machineId) captured.push(frame as unknown as Record<string, unknown>);
    return original(id, frame);
  };
  return captured;
}

/**
 * Inline RuntimeAdapter that writes a real file into the dispatch workspace's
 * artifactsDir during prepare(), then completes. Used by (b2) to exercise the
 * daemon harness's real artifact collection + the worker's artifacts caching,
 * end to end, without touching the shared StubAdapter.
 */
class ArtifactWritingAdapter {
  constructor(private readonly writeArtifact: (artifactsDir: string) => Promise<void>) {}
  name(): string {
    return 'claude_code';
  }
  supportsResume(): boolean {
    return true;
  }
  async prepare(spec: TaskSpec, workspace: { workspacePath: string; artifactsDir: string; cwd?: string; readOnly?: boolean }) {
    await this.writeArtifact(workspace.artifactsDir);
    return {
      executionId: (spec as unknown as { taskId: string }).taskId,
      workspacePath: workspace.workspacePath,
      cwd: workspace.cwd ?? workspace.workspacePath,
      readOnly: Boolean(workspace.readOnly),
    };
  }
  async *execute(): AsyncGenerator<RuntimeEvent> {
    yield completedResult();
  }
  async *resume(): AsyncGenerator<RuntimeEvent> {
    yield completedResult();
  }
  async cancel() {
    return 'termination_started' as const;
  }
  async collectArtifacts() {
    return [];
  }
  async healthcheck() {
    return { healthy: true, name: this.name(), lastCheckedAt: new Date() };
  }
}

/**
 * Reach into the gateway's private connection map to hard-terminate the raw
 * socket for a machine, simulating a network flap from the server side. This is
 * the test-only equivalent of the OS dropping the TCP connection — the gateway's
 * own `close` handler then runs (markMachineOffline + bridge.onDisconnected),
 * exercising the real disconnect path.
 */
function terminateGatewaySocket(gateway: DaemonGateway, machineId: string): void {
  const conns = (gateway as unknown as {
    connections: Map<string, { socket: { terminate(): void } }>;
  }).connections;
  const conn = conns.get(machineId);
  conn?.socket.terminate();
}
