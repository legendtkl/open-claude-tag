/**
 * ChecklistFeedback — a LIVE, named-stage checklist surface for a single task
 * run (the "show your work" card).
 *
 * It folds every {@link RuntimeEvent} through a pure {@link ChecklistAccumulator}
 * and, whenever the resulting snapshot changes, sends or updates ONE checklist
 * card through the neutral {@link ChannelSender}. The card is a SEPARATE message
 * from the primary running-feedback card — additive, never a replacement.
 *
 * Invariants:
 * - No empty checklist: the card is only created once the accumulator has at
 *   least one step (e.g. a `plan_update`/TodoWrite or a `tool_use` arrived).
 * - No duplicate sends: a snapshot identical to the last delivered one is
 *   skipped, so repeated no-op events don't re-PATCH the card.
 * - Throttled: live updates respect the channel's `maxUpdateRateHz`. A change
 *   suppressed by the throttle is not lost — a later event (or {@link finalize})
 *   flushes the most recent snapshot.
 * - Clock is injected (`now`), so the throttle stays observable/deterministic in
 *   tests; no `Date.now()` lives in decision logic (mirrors the running card).
 */
import type { RuntimeEvent } from '@open-tag/core-types';
import { ChecklistAccumulator, type ChecklistSnapshot, type ChecklistStatus } from '@open-tag/runtime-adapters';
import type { Logger } from 'pino';
import type { ChannelSender, ConversationRef, DeliveryRef, OutboundMessage } from './channel-sender.js';

type ChecklistOutbound = Extract<OutboundMessage, { kind: 'checklist' }>;
/** The neutral checklist row + overall status the channel renders. */
type ChecklistStep = ChecklistOutbound['steps'][number];
type RunStatus = ChecklistOutbound['status'];

/** The channel advertises `maxUpdateRateHz: 5`; one update per 200ms at most. */
const CHANNEL_MAX_UPDATE_RATE_HZ = 5;
const CHECKLIST_UPDATE_MIN_INTERVAL_MS = Math.ceil(1000 / CHANNEL_MAX_UPDATE_RATE_HZ);

/**
 * Pure throttle decision, mirroring `shouldFlushRunningCardUpdate`. The first
 * delivery (`lastUpdatedAt === 0`) and any forced flush always pass; otherwise a
 * minimum interval gates the rate.
 */
export function shouldFlushChecklistUpdate(params: {
  now: number;
  lastUpdatedAt: number;
  intervalMs: number;
  force?: boolean;
}): boolean {
  const { now, lastUpdatedAt, intervalMs, force = false } = params;
  if (force || lastUpdatedAt === 0) return true;
  return now - lastUpdatedAt >= intervalMs;
}

/** Map the accumulator rollup onto the channel's narrower run status. */
function toRunStatus(status: ChecklistStatus): RunStatus {
  return status === 'done' || status === 'failed' ? status : 'running';
}

/** A delivered checklist view: rows plus the card-level run status. */
interface ChecklistView {
  steps: ChecklistStep[];
  status: RunStatus;
}

function liveView(snapshot: ChecklistSnapshot): ChecklistView {
  return {
    steps: snapshot.steps.map((step) => ({ id: step.id, title: step.title, status: step.status })),
    status: toRunStatus(snapshot.status),
  };
}

/**
 * Terminal view used on task completion: open rows are resolved to match the
 * outcome so the final card reads as fully done / failed rather than freezing
 * mid-flight. Completed/skipped/failed rows are left untouched (honest history).
 */
function finalView(snapshot: ChecklistSnapshot, outcome: RunStatus): ChecklistView {
  const steps = snapshot.steps.map((step) => {
    if (outcome === 'done' && (step.status === 'pending' || step.status === 'running')) {
      return { id: step.id, title: step.title, status: 'done' as const };
    }
    if (outcome === 'failed' && step.status === 'running') {
      return { id: step.id, title: step.title, status: 'failed' as const };
    }
    return { id: step.id, title: step.title, status: step.status };
  });
  return { steps, status: outcome };
}

export interface ChecklistFeedbackOptions {
  sender: ChannelSender;
  conversation: ConversationRef;
  title: string;
  /** Injectable clock for the throttle; defaults to the wall clock. */
  now?: () => number;
  /** Minimum ms between channel writes; defaults to the channel rate cap. */
  minIntervalMs?: number;
  logger?: Logger;
}

export class ChecklistFeedback {
  private readonly accumulator = new ChecklistAccumulator();
  private readonly sender: ChannelSender;
  private readonly conversation: ConversationRef;
  private readonly title: string;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly logger?: Logger;

  /** The single live card; null until the first step is delivered. */
  private ref: DeliveryRef | null = null;
  /** The last view actually written, to drop duplicate/no-op deliveries. */
  private lastSentSerialized: string | null = null;
  private lastUpdatedAt = 0;
  /**
   * A change has been folded in but not yet written (throttle-suppressed). The
   * worker forwards EVERY runtime event here, so the next (typically frequent)
   * event past the throttle window flushes the pending state — trailing
   * coalescing without a wall-clock timer.
   */
  private pending = false;

  constructor(options: ChecklistFeedbackOptions) {
    this.sender = options.sender;
    this.conversation = options.conversation;
    this.title = options.title;
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? CHECKLIST_UPDATE_MIN_INTERVAL_MS;
    this.logger = options.logger;
  }

  /** Fold one runtime event in; deliver a live update when the plan changed. */
  async onEvent(event: RuntimeEvent): Promise<void> {
    const mutates = event.type === 'plan_update' || event.type === 'tool_use';
    if (mutates) {
      this.accumulator.apply(event);
    } else if (!this.pending) {
      // Non-mutating event with nothing buffered: cheap exit, no snapshotting.
      return;
    }
    await this.deliver(liveView(this.accumulator.snapshot()), false);
  }

  /**
   * Flush the terminal snapshot, bypassing the throttle so the final state is
   * always delivered. No-op when no step was ever recorded (never post an empty
   * checklist for a task that emitted no plan/tool activity).
   */
  async finalize(outcome: RunStatus): Promise<void> {
    const snapshot = this.accumulator.snapshot();
    if (snapshot.steps.length === 0) return;
    await this.deliver(finalView(snapshot, outcome), true);
  }

  private async deliver(view: ChecklistView, force: boolean): Promise<void> {
    if (view.steps.length === 0) return;
    const serialized = JSON.stringify(view);
    if (serialized === this.lastSentSerialized) {
      this.pending = false;
      return;
    }
    const now = this.now();
    if (
      !shouldFlushChecklistUpdate({
        now,
        lastUpdatedAt: this.lastUpdatedAt,
        intervalMs: this.minIntervalMs,
        force,
      })
    ) {
      // Suppressed by the throttle; buffer it so a later event (or finalize())
      // re-reads the latest snapshot — the change is coalesced, never dropped.
      this.pending = true;
      return;
    }
    const msg: OutboundMessage = {
      kind: 'checklist',
      title: this.title,
      steps: view.steps,
      status: view.status,
    };
    try {
      this.ref = this.ref
        ? await this.sender.update(this.ref, msg)
        : await this.sender.send(this.conversation, msg);
      this.lastSentSerialized = serialized;
      this.lastUpdatedAt = now;
      this.pending = false;
    } catch (err) {
      // A checklist delivery failure must never crash task execution; the
      // primary feedback card carries the authoritative state. Leave it pending
      // so a subsequent event retries the write.
      this.pending = true;
      this.logger?.warn({ err, title: this.title }, 'Failed to deliver checklist card');
    }
  }
}
