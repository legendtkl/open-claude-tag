import { randomUUID } from 'node:crypto';
import type { TaskSpec, RuntimeEvent, ArtifactRef } from '@open-tag/core-types';
import {
  SeqTracker,
  ENVELOPE_VERSION,
  serializeFrame,
  validateFrameSize,
  type Frame,
  type InlineImage,
  type WorkdirHints,
} from '@open-tag/daemon-protocol';
import type { Logger } from '@open-tag/observability';
import type {
  RuntimeAdapter,
  RuntimeDescriptor,
  RuntimeHandle,
  WorkspaceContext,
  RuntimeCancelOptions,
  RuntimeCancelOutcome,
  HealthStatus,
} from '@open-tag/runtime-adapters';
import { RUNTIME_DESCRIPTORS_BY_NAME } from '@open-tag/runtime-adapters';

/**
 * Local mirror of `RuntimeResumeOptions` (not exported from runtime-adapters'
 * public index). Structurally identical so the `resume` method stays assignable
 * to the {@link RuntimeAdapter} interface.
 */
interface RuntimeResumeOptions {
  taskId?: string;
  executionId?: string;
  imagePaths?: string[];
}
import type { GatewayDispatchPort, DispatchBridge } from './daemon-gateway/dispatch-bridge.js';
import type { MachineRow } from './machine-routing.js';
import {
  machineOfflineMessage,
  dispatchTimeoutMessage,
  dispatchRejectedMessage,
  taskLostMessage,
  machineDisconnectedMessage,
} from './daemon-gateway/messages.js';

/** Accept-timeout for `task_dispatch` → `task_accepted` (design §6, D8). */
const ACCEPT_TIMEOUT_MS = 15_000;
/** Disconnect grace window before a streaming dispatch fails (D12). */
const DISCONNECT_GRACE_MS = 120_000;
/** Minimum cadence for cumulative event acks while streaming (D12). */
const ACK_INTERVAL_MS = 1_000;

/** Typed dispatch error so the worker can render the D8 failure copy. */
export class RemoteDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteDispatchError';
  }
}

export interface RemoteRuntimeAdapterOptions {
  gateway: GatewayDispatchPort;
  machine: MachineRow;
  /** Underlying runtime name (claude_code/codex) — what `name()` returns. */
  runtime: 'claude_code' | 'codex';
  workdirHints: WorkdirHints;
  runtimeEnv?: Record<string, string>;
  /** Inline images (base64) materialized server-side for this dispatch (D11). */
  images?: InlineImage[];
  /** Late image resolver for contextual specs assembled after adapter creation. */
  buildImages?: (spec: TaskSpec) => Promise<InlineImage[] | undefined>;
  logger: Logger;
  /** Overridable timers for tests. */
  acceptTimeoutMs?: number;
  disconnectGraceMs?: number;
}

/**
 * A {@link RuntimeAdapter} that proxies `prepare/execute/resume/cancel` to a
 * remote daemon over the gateway (design D3). Constructed per-dispatch — one
 * instance owns exactly one dispatchId — so downstream orchestration (cards,
 * state machine, session persistence) is unchanged: from the worker's view this
 * is just another adapter producing a `RuntimeEvent` stream.
 *
 * `name()` returns the underlying runtime so `sessions.runtimeBackend`
 * persistence keeps working across local↔remote turns.
 */
export class RemoteRuntimeAdapter implements RuntimeAdapter {
  private readonly gateway: GatewayDispatchPort;
  private readonly machine: MachineRow;
  private readonly runtime: 'claude_code' | 'codex';
  private readonly workdirHints: WorkdirHints;
  private readonly runtimeEnv?: Record<string, string>;
  private readonly images?: InlineImage[];
  private readonly buildImages?: (spec: TaskSpec) => Promise<InlineImage[] | undefined>;
  private readonly logger: Logger;
  private readonly acceptTimeoutMs: number;
  private readonly disconnectGraceMs: number;

  private readonly dispatchId = randomUUID();
  private readonly seq = new SeqTracker();
  private unregister: (() => void) | null = null;

  // ── streaming queue ──
  private readonly pending: RuntimeEvent[] = [];
  private waiter: ((value: IteratorResult<RuntimeEvent>) => void) | null = null;
  private finished = false;

  // ── accept gating ──
  private acceptResolve: ((accepted: boolean) => void) | null = null;
  private rejectReason: string | null = null;
  /** True once a task_dispatch frame has actually been put on the wire. */
  private dispatchSent = false;
  /** Latched by cancel() racing ahead of execute/resume: never send the dispatch. */
  private cancelledBeforeDispatch = false;

  // ── ack + grace timers ──
  private ackTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private connected = true;
  private lastAckedSeq = 0;

  private artifactsCache: ArtifactRef[] | null = null;

  constructor(options: RemoteRuntimeAdapterOptions) {
    this.gateway = options.gateway;
    this.machine = options.machine;
    this.runtime = options.runtime;
    this.workdirHints = options.workdirHints;
    this.runtimeEnv = options.runtimeEnv;
    this.images = options.images;
    this.buildImages = options.buildImages;
    this.logger = options.logger;
    this.acceptTimeoutMs = options.acceptTimeoutMs ?? ACCEPT_TIMEOUT_MS;
    this.disconnectGraceMs = options.disconnectGraceMs ?? DISCONNECT_GRACE_MS;
  }

  name(): string {
    return this.runtime;
  }

  /**
   * Proxy the underlying runtime's open descriptor: a remote dispatch runs the
   * same runtime (claude_code/codex) on another host, so its capabilities are
   * identical. Resolved by persisted name; `this.runtime` is always one of the
   * known keys.
   */
  descriptor(): RuntimeDescriptor {
    return RUNTIME_DESCRIPTORS_BY_NAME[this.runtime];
  }

  supportsResume(): boolean {
    return true;
  }

  async healthcheck(): Promise<HealthStatus> {
    const online = this.gateway.isMachineOnline(this.machine.id);
    return {
      healthy: online,
      name: this.runtime,
      message: online ? undefined : `machine ${this.machine.name} offline`,
      lastCheckedAt: new Date(),
    };
  }

  /**
   * Local no-op: returns the synthetic handle without any wire traffic. The real
   * dispatch is sent from {@link execute} so it carries the contextual spec (with
   * conversation history) + systemPromptAppend the worker passes there, not the
   * bare spec prepare() receives (codex review finding #4).
   */
  async prepare(_spec: TaskSpec, workspace: WorkspaceContext): Promise<RuntimeHandle> {
    return {
      executionId: this.dispatchId,
      workspacePath: workspace.workspacePath,
      cwd: workspace.cwd ?? workspace.workspacePath,
      artifactsDir: workspace.artifactsDir,
      readOnly: workspace.readOnly ?? false,
    };
  }

  /**
   * Send `task_dispatch` (mode prepare_execute) carrying THIS spec argument — the
   * contextual one with conversation history — plus systemPromptAppend, then await
   * `task_accepted` (15 s) before yielding any event. Offline / no-socket / timeout
   * / rejected surface as the same typed {@link RemoteDispatchError} thrown from the
   * generator, so the worker's failure-card path renders the D8 copy.
   */
  async *execute(
    _handle: RuntimeHandle,
    spec: TaskSpec,
    systemPromptAppend?: string,
  ): AsyncGenerator<RuntimeEvent> {
    this.registerBridge();
    this.throwIfCancelledBeforeDispatch();
    await this.dispatchAndAwaitAccept(spec, 'prepare_execute', { systemPromptAppend });
    yield* this.streamEvents();
  }

  /**
   * Resume sends a fresh `task_dispatch` (mode resume) carrying the sdkSessionId
   * and the resume prompt as the spec goal, then streams events. Resume also gates
   * on `task_accepted` for symmetry with fresh execution.
   */
  async *resume(
    sdkSessionId: string,
    prompt: string,
    workspace: WorkspaceContext,
    systemPromptAppend?: string,
    options?: RuntimeResumeOptions,
  ): AsyncGenerator<RuntimeEvent> {
    void workspace;
    this.registerBridge();
    this.throwIfCancelledBeforeDispatch();
    const spec = buildResumeSpec(prompt, options);
    await this.dispatchAndAwaitAccept(spec, 'resume', { sdkSessionId, systemPromptAppend });
    yield* this.streamEvents();
  }

  /**
   * Cancel an in-flight dispatch. When no dispatch frame has been sent yet (cancel
   * raced ahead of execute/resume), this is a no-op success — there is nothing on
   * the remote to terminate.
   */
  async cancel(
    _executionId: string,
    options?: RuntimeCancelOptions,
  ): Promise<RuntimeCancelOutcome> {
    if (!this.dispatchSent) {
      // Latch: the watchdog (or shutdown) cancelled before execute/resume sent
      // the dispatch frame. Reporting success without remembering it would let
      // the dispatch proceed afterwards — the exact "server failed it, daemon
      // runs it anyway" split this adapter exists to prevent.
      this.cancelledBeforeDispatch = true;
      return 'termination_started';
    }
    const result = this.gateway.sendToMachine(this.machine.id, {
      v: ENVELOPE_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: 'task_cancel',
      dispatchId: this.dispatchId,
      ...(options?.force ? { force: true } : {}),
    });
    return result.ok ? 'termination_started' : 'no_active_execution';
  }

  async collectArtifacts(_executionId: string): Promise<ArtifactRef[]> {
    return this.artifactsCache ?? [];
  }

  private throwIfCancelledBeforeDispatch(): void {
    if (this.cancelledBeforeDispatch) {
      throw new RemoteDispatchError('Task was cancelled before the remote dispatch was sent');
    }
  }

  // ── internals ──

  private registerBridge(): void {
    if (this.unregister) return;
    const bridge: DispatchBridge = {
      machineId: this.machine.id,
      onFrame: (frame) => this.handleFrame(frame),
      onConnected: () => this.handleConnected(),
      onDisconnected: () => this.handleDisconnected(),
    };
    this.unregister = this.gateway.registerDispatch(this.dispatchId, bridge);
  }

  /** Serialize a `task_dispatch` frame, optionally with inline images omitted. */
  private buildDispatchFrame(
    spec: TaskSpec,
    mode: 'prepare_execute' | 'resume',
    resumeExtra: { sdkSessionId?: string; systemPromptAppend?: string } | undefined,
    images: InlineImage[] | undefined,
  ): Frame {
    return {
      v: ENVELOPE_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: 'task_dispatch',
      dispatchId: this.dispatchId,
      taskId: spec.taskId,
      mode,
      spec,
      ...(resumeExtra?.sdkSessionId ? { sdkSessionId: resumeExtra.sdkSessionId } : {}),
      ...(resumeExtra?.systemPromptAppend
        ? { systemPromptAppend: resumeExtra.systemPromptAppend }
        : {}),
      workdirHints: this.workdirHints,
      runtime: this.runtime,
      ...(this.runtimeEnv && Object.keys(this.runtimeEnv).length > 0
        ? { runtimeEnv: this.runtimeEnv }
        : {}),
      ...(images && images.length > 0 ? { images } : {}),
    };
  }

  private async dispatchAndAwaitAccept(
    spec: TaskSpec,
    mode: 'prepare_execute' | 'resume',
    resumeExtra: { sdkSessionId?: string; systemPromptAppend?: string } | undefined,
  ): Promise<void> {
    if (!this.gateway.isMachineOnline(this.machine.id)) {
      this.cleanup();
      throw new RemoteDispatchError(machineOfflineMessage(this.machine));
    }

    // Preflight the serialized frame against MAX_FRAME_BYTES (D11). When the
    // inline images push it over the cap, degrade to text-only and re-serialize;
    // if it is still oversized, fail the dispatch with an explicit error rather
    // than letting the gateway/daemon reject an unparseable oversized frame.
    const images = await this.resolveInlineImages(spec);
    let dispatchFrame = this.buildDispatchFrame(spec, mode, resumeExtra, images);
    if (!validateFrameSize(serializeFrame(dispatchFrame))) {
      this.logger.warn(
        { dispatchId: this.dispatchId, machineId: this.machine.id },
        'task_dispatch exceeds frame cap; dropping inline images and retrying text-only',
      );
      dispatchFrame = this.buildDispatchFrame(spec, mode, resumeExtra, undefined);
      if (!validateFrameSize(serializeFrame(dispatchFrame))) {
        this.cleanup();
        throw new RemoteDispatchError(
          `Task is too large to dispatch to "${this.machine.name}" even after dropping ` +
            'inline images (over the 16 MiB frame limit). Shorten the request and retry.',
        );
      }
    }

    const accepted = await new Promise<boolean>((resolve) => {
      this.acceptResolve = resolve;
      const sent = this.gateway.sendToMachine(this.machine.id, dispatchFrame);
      if (!sent.ok) {
        this.acceptResolve = null;
        resolve(false);
        return;
      }
      this.dispatchSent = true;
      const timer = setTimeout(() => {
        if (this.acceptResolve === resolve) {
          this.acceptResolve = null;
          this.rejectReason = '__timeout__';
          resolve(false);
        }
      }, this.acceptTimeoutMs);
      timer.unref();
    });

    if (!accepted) {
      const reason = this.rejectReason;
      this.cleanup();
      if (reason === '__timeout__' || reason == null) {
        throw new RemoteDispatchError(
          reason === '__timeout__'
            ? dispatchTimeoutMessage(this.machine, this.acceptTimeoutMs)
            : machineOfflineMessage(this.machine),
        );
      }
      throw new RemoteDispatchError(dispatchRejectedMessage(this.machine, reason));
    }
  }

  private async *streamEvents(): AsyncGenerator<RuntimeEvent> {
    this.startAckTimer();
    try {
      while (true) {
        const event = await this.nextEvent();
        if (event === null) break;
        yield event;
        if (event.type === 'completed' || event.type === 'failed') {
          break;
        }
      }
    } finally {
      this.cleanup();
    }
  }

  private nextEvent(): Promise<RuntimeEvent | null> {
    if (this.pending.length > 0) {
      return Promise.resolve(this.pending.shift() as RuntimeEvent);
    }
    if (this.finished) {
      return Promise.resolve(null);
    }
    return new Promise<RuntimeEvent | null>((resolve) => {
      this.waiter = (result) => {
        resolve(result.done ? null : result.value);
      };
    });
  }

  private pushEvent(event: RuntimeEvent): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: event, done: false });
      return;
    }
    this.pending.push(event);
  }

  private finishStream(): void {
    this.finished = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as unknown as RuntimeEvent, done: true });
    }
  }

  private handleFrame(frame: Frame): void {
    switch (frame.type) {
      case 'task_accepted':
        if (this.acceptResolve) {
          const r = this.acceptResolve;
          this.acceptResolve = null;
          r(true);
        }
        return;
      case 'task_rejected':
        this.rejectReason = frame.reason;
        if (this.acceptResolve) {
          const r = this.acceptResolve;
          this.acceptResolve = null;
          r(false);
        }
        return;
      case 'task_event':
        this.handleTaskEvent(frame.seq, frame.event);
        return;
      case 'task_lost':
        // Daemon restarted / lost the dispatch ⇒ fail now (D12).
        this.failStream(taskLostMessage(this.machine));
        return;
      case 'artifacts':
        this.artifactsCache = frame.refs;
        return;
      default:
        return;
    }
  }

  private handleTaskEvent(seq: number, event: RuntimeEvent): void {
    // SeqTracker enforces in-order, exactly-once delivery across replays (D12).
    const deliverable = this.seq.accept(seq);
    if (deliverable) {
      this.pushEvent(event);
      // Release any contiguous buffered run unlocked by this in-order arrival.
      for (const releasedSeq of this.seq.drain()) {
        const buffered = this.outOfOrder.get(releasedSeq);
        if (buffered) {
          this.outOfOrder.delete(releasedSeq);
          this.pushEvent(buffered);
        }
      }
    } else if (seq > this.seq.lastDeliveredSeq()) {
      // Future seq held by the tracker; stash the payload until the gap fills.
      this.outOfOrder.set(seq, event);
    }
    // else: duplicate already-delivered seq ⇒ dropped silently.
    this.scheduleAck();
  }

  private readonly outOfOrder = new Map<number, RuntimeEvent>();

  private startAckTimer(): void {
    if (this.ackTimer) return;
    this.ackTimer = setInterval(() => this.flushAck(), ACK_INTERVAL_MS);
    this.ackTimer.unref();
  }

  private scheduleAck(): void {
    // Piggyback immediately when a new seq lands; the timer is the ≥1/s floor.
    this.flushAck();
  }

  private flushAck(): void {
    const last = this.seq.lastDeliveredSeq();
    if (last <= this.lastAckedSeq) return;
    const sent = this.gateway.sendToMachine(this.machine.id, {
      v: ENVELOPE_VERSION,
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: 'event_ack',
      dispatchId: this.dispatchId,
      lastSeq: last,
    });
    if (sent.ok) this.lastAckedSeq = last;
  }

  private async resolveInlineImages(spec: TaskSpec): Promise<InlineImage[] | undefined> {
    const lateImages = this.buildImages ? await this.buildImages(spec) : undefined;
    const merged = [...(this.images ?? []), ...(lateImages ?? [])];
    if (merged.length === 0) return undefined;
    const seen = new Set<string>();
    return merged.filter((image) => {
      if (seen.has(image.name)) return false;
      seen.add(image.name);
      return true;
    });
  }

  private handleConnected(): void {
    this.connected = true;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    // Re-ack so the daemon knows where to resume replay from.
    this.flushAck();
  }

  private handleDisconnected(): void {
    if (!this.connected) return;
    this.connected = false;
    // 120 s grace: keep the generator open; reconnect resumes via replay (D12).
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      if (!this.connected && !this.finished) {
        this.pushEvent({ type: 'failed', error: machineDisconnectedMessage(this.machine) });
        this.finishStream();
      }
    }, this.disconnectGraceMs);
    this.graceTimer.unref();
  }

  private failStream(reason: string): void {
    if (this.finished) return;
    this.pushEvent({ type: 'failed', error: reason });
    this.finishStream();
  }

  private cleanup(): void {
    if (this.ackTimer) {
      clearInterval(this.ackTimer);
      this.ackTimer = null;
    }
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.unregister?.();
    this.unregister = null;
  }
}

function buildResumeSpec(prompt: string, options?: RuntimeResumeOptions): TaskSpec {
  return {
    taskId: (options?.taskId ?? randomUUID()) as string,
    sessionId: randomUUID(),
    taskType: 'chat_reply',
    goal: prompt,
    runtimeHint: 'auto',
    constraints: {},
    context: { systemPrompt: '', recentTurns: [] },
  } as unknown as TaskSpec;
}
