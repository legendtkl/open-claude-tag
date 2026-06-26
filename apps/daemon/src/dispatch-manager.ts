import {
  EventReplayBuffer,
  validateFrameSize,
  type TaskDispatchFrame,
  type BufferedEvent,
} from '@open-tag/daemon-protocol';
import type { ArtifactRef, RuntimeEvent } from '@open-tag/core-types';
import type { RuntimeManager } from '@open-tag/runtime-adapters';
import { logger } from './logger.js';
import {
  prepareDispatch,
  runDispatch,
  collectDispatchArtifacts,
  type PreparedDispatch,
} from './harness.js';
import {
  taskAcceptedFrame,
  taskRejectedFrame,
  taskEventFrame,
  artifactsFrame,
} from './frame-factory.js';

/**
 * Default per-machine concurrent-dispatch cap, overridable via
 * `OPEN_TAG_DAEMON_MAX_CONCURRENT_DISPATCHES`. This is the primary concurrency
 * limit now that server-side admission defaults to unlimited — it bounds how many
 * tasks a single machine runs at once before the daemon rejects further dispatches
 * with `busy`.
 */
export const DEFAULT_MAX_CONCURRENT_DISPATCHES = 10;

/**
 * Per-dispatch replay-buffer byte cap. Kept explicit (not the package default)
 * so the send-side truncation budget (finding #8) can be computed against the
 * SAME ceiling: truncating an oversized stdout/stderr `data` only to the wire
 * frame cap (16 MiB) would still overflow the smaller buffer cap and fail the
 * dispatch, defeating the truncation. Truncating to `min(frame cap, this)` keeps
 * the event both bufferable and frame-valid.
 */
export const DAEMON_EVENT_BUFFER_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Max retained `data` bytes when an oversized `stdout`/`stderr` event is
 * truncated (finding #8). Deliberately well under the buffer cap so a single
 * huge chunk keeps a useful head of the output without monopolizing the replay
 * buffer and starving the dispatch's later (incl. terminal) events. The
 * `... [truncated N bytes]` marker reports how much was dropped.
 */
export const DAEMON_EVENT_DATA_TRUNCATE_BYTES = 256 * 1024;

/** Reads the concurrency cap from env, falling back to the default. */
export function resolveMaxConcurrentDispatches(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPEN_TAG_DAEMON_MAX_CONCURRENT_DISPATCHES?.trim();
  if (!raw) return DEFAULT_MAX_CONCURRENT_DISPATCHES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONCURRENT_DISPATCHES;
}

/**
 * Returns a copy of an oversized `stdout`/`stderr` event whose `data` is
 * truncated so its UTF-8 byte length (including the appended marker) is at most
 * `dataByteBudget`, appending a `... [truncated N bytes]` marker that names how
 * many UTF-8 bytes were cut.
 *
 * The caller supplies the already-resolved budget for the `data` field itself
 * (after reserving frame/buffer overhead), so this helper stays a pure string
 * operation. UTF-8 byte counting matches what crosses the socket; slicing by
 * char and trimming handles a multi-byte char straddling the boundary.
 */
function truncateDataEvent(
  event: Extract<RuntimeEvent, { type: 'stdout' | 'stderr' }>,
  dataByteBudget: number,
): Extract<RuntimeEvent, { type: 'stdout' | 'stderr' }> {
  const originalBytes = Buffer.byteLength(event.data, 'utf8');
  const marker = (cutBytes: number) => `... [truncated ${cutBytes} bytes]`;
  // Reserve room for the largest plausible marker so it never pushes back over.
  const markerBudget = Buffer.byteLength(marker(originalBytes), 'utf8');
  const prefixBudget = Math.max(0, dataByteBudget - markerBudget);

  let prefix = event.data.slice(0, prefixBudget);
  while (Buffer.byteLength(prefix, 'utf8') > prefixBudget && prefix.length > 0) {
    prefix = prefix.slice(0, -1);
  }
  const cutBytes = originalBytes - Buffer.byteLength(prefix, 'utf8');
  return { ...event, data: `${prefix}${marker(cutBytes)}` };
}

/** Sink the dispatch manager writes outbound frames to (the WS, in production). */
export interface FrameSink {
  /** Returns true if the frame was sent (socket open); false to buffer. */
  send(serialized: string): boolean;
}

interface ActiveDispatch {
  dispatchId: string;
  /** Null while the dispatch is still preparing (placeholder phase). */
  prepared: PreparedDispatch | null;
  buffer: EventReplayBuffer;
  /** Latest known runtime executionId (from `runtime_started`), for cancel. */
  executionId: string;
  terminal: boolean;
  cancelRequested: boolean;
  /** Artifact refs of a terminal dispatch, kept for reconnect replay. */
  artifacts?: ArtifactRef[];
  /** True once post-terminal artifact collection (and first send) finished. */
  artifactsSettled: boolean;
  /** Resolves when the run loop has fully finished (terminal + artifacts). */
  done: Promise<void>;
}

/**
 * Owns all in-flight dispatches on the daemon (design §8, D12).
 *
 * Responsibilities:
 * - Concurrency cap with `busy` rejection (no local queueing).
 * - Per-dispatch `EventReplayBuffer`: every `RuntimeEvent` is appended (assigning
 *   a seq) and sent as a `task_event`; `event_ack` drops acked entries.
 * - Replay on reconnect: re-send `pending()` for dispatches the server still
 *   wants; cancel + discard the rest.
 * - Overflow ⇒ fail the dispatch deterministically.
 * - `task_cancel` ⇒ `adapter.cancel`.
 * - Disconnect does NOT kill running runtimes — only the sink stops accepting.
 */
export class DispatchManager {
  private readonly active = new Map<string, ActiveDispatch>();

  constructor(
    private readonly runtimeManager: RuntimeManager,
    private readonly sink: FrameSink,
    private readonly maxConcurrent: number = resolveMaxConcurrentDispatches(),
  ) {}

  /**
   * Dispatch ids to announce in `hello.runningDispatchIds` on (re)connect.
   *
   * Includes every dispatch the daemon still tracks — running OR terminal — as
   * long as it has unacked buffered events. A terminal dispatch is retained
   * until its replay buffer is fully acked (see {@link ack}); if the socket
   * drops after `completed`/`failed` was produced but before the server acked
   * it, omitting that dispatch here would make the gateway synthesize
   * `task_lost` and fail a task that actually finished (codex review finding
   * #7). The gateway replays the terminal event from `resumeDispatchIds` and
   * its open generator consumes it, so the task lands in its true terminal
   * state instead of `task_lost`.
   */
  runningDispatchIds(): string[] {
    return [...this.active.values()]
      .filter((entry) => !entry.terminal || entry.buffer.size() > 0)
      .map((entry) => entry.dispatchId);
  }

  /** Number of in-flight (non-terminal) dispatches, for the concurrency check. */
  activeCount(): number {
    return [...this.active.values()].filter((entry) => !entry.terminal).length;
  }

  /**
   * Handles a `task_dispatch`. Over the cap ⇒ `task_rejected {busy}`. Otherwise
   * `task_accepted`, then the run loop streams events and finishes with an
   * `artifacts` frame. Returns once accept/reject is decided; the run continues
   * in the background (tracked via the dispatch's `done` promise).
   */
  async handleDispatch(frame: TaskDispatchFrame): Promise<void> {
    if (this.active.has(frame.dispatchId)) {
      logger.warn({ dispatchId: frame.dispatchId }, 'Duplicate dispatch ignored');
      return;
    }
    if (this.activeCount() >= this.maxConcurrent) {
      logger.info(
        { dispatchId: frame.dispatchId, cap: this.maxConcurrent },
        'Rejecting dispatch: at concurrency cap',
      );
      this.sink.send(taskRejectedFrame(frame.dispatchId, 'busy'));
      return;
    }

    // Register a placeholder BEFORE the first await: prepare takes seconds
    // (workspace + possibly git worktrees), and during that window duplicate
    // dispatches, the concurrency cap, and task_cancel must all observe this
    // dispatch — otherwise the cap is breached, a duplicate double-runs, or a
    // cancel is silently dropped.
    const entry: ActiveDispatch = {
      dispatchId: frame.dispatchId,
      prepared: null,
      buffer: new EventReplayBuffer({ maxBytes: DAEMON_EVENT_BUFFER_MAX_BYTES }),
      executionId: frame.spec.taskId,
      terminal: false,
      cancelRequested: false,
      artifactsSettled: false,
      done: Promise.resolve(),
    };
    this.active.set(frame.dispatchId, entry);

    let prepared: PreparedDispatch;
    try {
      prepared = await prepareDispatch(frame, this.runtimeManager);
    } catch (err) {
      this.active.delete(frame.dispatchId);
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ dispatchId: frame.dispatchId, reason }, 'Rejecting dispatch: prepare failed');
      this.sink.send(taskRejectedFrame(frame.dispatchId, reason));
      return;
    }

    if (entry.cancelRequested) {
      this.active.delete(frame.dispatchId);
      logger.info({ dispatchId: frame.dispatchId }, 'Dispatch cancelled during prepare');
      this.sink.send(taskRejectedFrame(frame.dispatchId, 'cancelled before start'));
      return;
    }

    this.sink.send(taskAcceptedFrame(frame.dispatchId));
    entry.prepared = prepared;
    entry.executionId = prepared.sdkSessionId ? frame.dispatchId : frame.spec.taskId;
    entry.done = this.runLoop(entry);
  }

  /**
   * Drives the runtime stream for one dispatch: append each event to the buffer
   * (assigns seq), send it as a `task_event`, and finish with `artifacts` after
   * the terminal event. Buffer overflow fails the dispatch deterministically.
   */
  private async runLoop(entry: ActiveDispatch): Promise<void> {
    const { dispatchId, buffer } = entry;
    const prepared = entry.prepared;
    if (!prepared) {
      // Defensive: runLoop is only started after prepare succeeds.
      logger.error({ dispatchId }, 'runLoop started without a prepared dispatch');
      entry.terminal = true;
      entry.artifactsSettled = true;
      return;
    }
    try {
      for await (const event of runDispatch(prepared)) {
        if (event.type === 'runtime_started' && event.executionId) {
          entry.executionId = event.executionId;
        }
        this.emit(entry, event);
        // emit() may itself terminate the dispatch (oversized non-truncatable
        // frame ⇒ synthetic `failed`, finding #8). Stop streaming if so.
        if (entry.terminal) {
          return;
        }
        if (buffer.isOverflowed()) {
          logger.error({ dispatchId }, 'Replay buffer overflow — failing dispatch');
          this.emit(entry, {
            type: 'failed',
            error: 'daemon event buffer overflowed (too many unacked events)',
          });
          entry.terminal = true;
          return;
        }
        if (event.type === 'completed' || event.type === 'failed') {
          entry.terminal = true;
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ dispatchId, err: message }, 'Dispatch run failed');
      if (!entry.terminal) {
        this.emit(entry, { type: 'failed', error: message });
        entry.terminal = true;
      }
    }

    // After the terminal event, report artifact refs (refs only, D12).
    try {
      const refs = await collectDispatchArtifacts(prepared.workspace);
      if (refs.length > 0) {
        // Retain for reconnect replay: a dispatch that finishes while the
        // socket is down would otherwise lose its artifacts forever.
        entry.artifacts = refs;
        this.sink.send(artifactsFrame(dispatchId, refs));
      }
    } catch (err) {
      logger.warn(
        { dispatchId, err: err instanceof Error ? err.message : String(err) },
        'Artifact collection failed',
      );
    } finally {
      entry.artifactsSettled = true;
      // The terminal event may have been fully acked while artifacts were
      // still settling; perform the retirement that ack() deferred.
      if (entry.terminal && entry.buffer.size() === 0) {
        this.active.delete(dispatchId);
      }
    }
  }

  /**
   * Appends an event to the buffer (assigning a seq) and sends it on the sink,
   * after a send-side frame-size preflight (codex review finding #8).
   *
   * The wire-safe event is computed BEFORE appending so the buffer holds exactly
   * what crosses the socket — replay on reconnect then re-serializes a frame that
   * already passes {@link validateFrameSize}. An oversized `stdout`/`stderr`
   * frame has its bulky `data` truncated (with a marker) rather than letting the
   * peer reject the whole frame; any other oversized frame is dropped with a
   * surfaced `failed` event so the dispatch fails deterministically instead of
   * silently stalling.
   */
  private emit(entry: ActiveDispatch, event: RuntimeEvent): void {
    const safe = this.preflightEvent(entry, event);
    if (!safe) {
      // Non-truncatable oversized frame; surface a failed event so the run loop
      // (and the server) treat the dispatch as terminally failed.
      const failure: RuntimeEvent = {
        type: 'failed',
        error: `daemon dropped an oversized ${event.type} frame (exceeds max frame size)`,
      };
      const seq = entry.buffer.append(failure);
      if (!entry.buffer.isOverflowed()) {
        this.sink.send(taskEventFrame(entry.dispatchId, seq, failure));
      }
      entry.terminal = true;
      return;
    }

    const seq = entry.buffer.append(safe);
    if (entry.buffer.isOverflowed() && safe.type !== 'failed') {
      // The overflowing event was not retained; the runLoop will fail the
      // dispatch. Do not send a frame we cannot later replay.
      return;
    }
    this.sink.send(taskEventFrame(entry.dispatchId, seq, safe));
  }

  /**
   * Returns a wire-safe version of `event` whose serialized `task_event` frame
   * fits within the protocol frame-size cap, or `null` when it cannot be made to
   * fit. Oversized `stdout`/`stderr` events have their `data` truncated with a
   * `... [truncated N bytes]` marker; all other oversized events return `null`.
   *
   * `seq: 0` is used only to measure envelope overhead — the real seq is
   * assigned by the buffer when the returned event is appended.
   */
  private preflightEvent(entry: ActiveDispatch, event: RuntimeEvent): RuntimeEvent | null {
    const { dispatchId } = entry;
    if (validateFrameSize(taskEventFrame(dispatchId, 0, event))) {
      return event;
    }
    if (event.type !== 'stdout' && event.type !== 'stderr') {
      logger.error(
        { dispatchId, type: event.type },
        'Oversized non-truncatable event frame — dropping',
      );
      return null;
    }
    // Truncate the `data` field to a sane retained size that is well under both
    // the wire frame cap and the replay-buffer cap, so the truncated event is
    // frame-valid, bufferable, and leaves room for the dispatch's later (incl.
    // terminal) events instead of monopolizing the buffer.
    const truncated = truncateDataEvent(event, DAEMON_EVENT_DATA_TRUNCATE_BYTES);
    if (!validateFrameSize(taskEventFrame(dispatchId, 0, truncated))) {
      // Pathological: even an empty data field overflows (impossible for the
      // current schema, but stay safe rather than emit a rejected frame).
      logger.error({ dispatchId, type: event.type }, 'Oversized event frame irreducible — dropping');
      return null;
    }
    logger.warn(
      { dispatchId, type: event.type },
      'Truncated oversized event data to fit the frame size cap',
    );
    return truncated;
  }

  /** Cumulative `event_ack` ⇒ drop acked entries from the dispatch's buffer. */
  ack(dispatchId: string, lastSeq: number): void {
    const entry = this.active.get(dispatchId);
    if (!entry) return;
    entry.buffer.ack(lastSeq);
    // Once a terminal dispatch is fully acked AND its artifacts have settled,
    // retire it. Acking the terminal event races artifact collection — retiring
    // early would drop the refs before they were ever sent or made replayable.
    if (entry.terminal && entry.artifactsSettled && entry.buffer.size() === 0) {
      this.active.delete(dispatchId);
    }
  }

  /** `task_cancel` ⇒ cooperative (or forced) runtime cancellation. */
  async cancel(dispatchId: string, force = false): Promise<void> {
    const entry = this.active.get(dispatchId);
    if (!entry) {
      logger.info({ dispatchId }, 'Cancel for unknown dispatch ignored');
      return;
    }
    entry.cancelRequested = true;
    if (!entry.prepared) {
      // Still preparing: handleDispatch observes the flag after prepare and
      // discards the dispatch without ever starting the runtime.
      logger.info({ dispatchId }, 'Cancel recorded during prepare');
      return;
    }
    try {
      await this.runtimeManager.cancel(entry.executionId, { force });
      logger.info({ dispatchId, force }, 'Cancel requested on runtime');
    } catch (err) {
      logger.warn(
        { dispatchId, err: err instanceof Error ? err.message : String(err) },
        'Runtime cancel raised',
      );
    }
  }

  /**
   * Reconnect reconciliation (D12). For dispatches the server still wants
   * (`resumeDispatchIds`), re-send their unacked buffered events. For
   * `cancelDispatchIds`, cancel the runtime and discard the dispatch.
   */
  reconcileOnReconnect(resumeDispatchIds: string[], cancelDispatchIds: string[]): void {
    const resumeSet = new Set(resumeDispatchIds);
    const cancelSet = new Set(cancelDispatchIds);

    for (const dispatchId of cancelSet) {
      void this.cancel(dispatchId, false);
      this.active.delete(dispatchId);
    }

    for (const dispatchId of resumeSet) {
      const entry = this.active.get(dispatchId);
      if (!entry) continue;
      const pending: BufferedEvent[] = entry.buffer.pending();
      for (const { seq, event } of pending) {
        this.sink.send(taskEventFrame(dispatchId, seq, event));
      }
      if (entry.terminal && entry.artifacts && entry.artifacts.length > 0) {
        // The artifacts frame is not seq-tracked; re-send it for dispatches
        // that finished while disconnected (server side dedups by overwrite).
        this.sink.send(artifactsFrame(dispatchId, entry.artifacts));
      }
      logger.info({ dispatchId, replayed: pending.length }, 'Replayed pending events on reconnect');
    }
  }

  /**
   * Graceful shutdown: cancel every in-flight runtime, await the run loops so
   * their terminal `failed`/`completed` events flush through the sink, then
   * clear state. Disconnect-vs-shutdown differ: a shutdown DOES cancel work.
   */
  async shutdown(): Promise<void> {
    const entries = [...this.active.values()];
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.terminal) {
          await this.cancel(entry.dispatchId, false);
        }
      }),
    );
    await Promise.allSettled(entries.map((entry) => entry.done));
    this.active.clear();
  }

  /** Test/diagnostic accessor: whether a dispatch is currently tracked. */
  has(dispatchId: string): boolean {
    return this.active.has(dispatchId);
  }
}
