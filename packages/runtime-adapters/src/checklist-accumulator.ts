import type { PlanStep, PlanStepStatus, RuntimeEvent, ToolUseStatus } from '@open-tag/core-types';

/** A single row in the named-stage checklist. */
export type ChecklistStep = PlanStep;

/** Overall checklist rollup derived from the individual step statuses. */
export type ChecklistStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ChecklistSnapshot {
  steps: ChecklistStep[];
  status: ChecklistStatus;
}

const TOOL_USE_STATUS_TO_STEP: Record<ToolUseStatus, PlanStepStatus> = {
  pending: 'pending',
  running: 'running',
  done: 'done',
  failed: 'failed',
};

/**
 * Pure, deterministic fold of a `RuntimeEvent` stream into a checklist snapshot.
 *
 * - `plan_update` replaces the entire step set (the runtime's authoritative
 *   plan, e.g. TodoWrite).
 * - `tool_use` upserts a step keyed by tool name, so repeated calls to the same
 *   tool update one row rather than appending duplicates.
 * - All other event types are ignored.
 *
 * No clocks, randomness, or I/O — given the same event sequence it always yields
 * the same snapshot.
 */
export class ChecklistAccumulator {
  private steps: ChecklistStep[] = [];
  private readonly indexById = new Map<string, number>();

  constructor(events: Iterable<RuntimeEvent> = []) {
    this.applyAll(events);
  }

  apply(event: RuntimeEvent): this {
    switch (event.type) {
      case 'plan_update':
        this.replaceSteps(event.steps);
        break;
      case 'tool_use':
        this.upsertToolStep(event);
        break;
      default:
        // Unrelated events leave the checklist untouched.
        break;
    }
    return this;
  }

  applyAll(events: Iterable<RuntimeEvent>): this {
    for (const event of events) this.apply(event);
    return this;
  }

  snapshot(): ChecklistSnapshot {
    return {
      steps: this.steps.map((step) => ({ ...step })),
      status: this.deriveStatus(),
    };
  }

  private replaceSteps(steps: ChecklistStep[]): void {
    this.steps = steps.map((step) => ({ id: step.id, title: step.title, status: step.status }));
    this.indexById.clear();
    this.steps.forEach((step, i) => this.indexById.set(step.id, i));
  }

  private upsertToolStep(event: Extract<RuntimeEvent, { type: 'tool_use' }>): void {
    const id = `tool:${event.name}`;
    const status = TOOL_USE_STATUS_TO_STEP[event.status] ?? 'pending';
    const title = event.summary.trim() ? event.summary : event.name;
    const existing = this.indexById.get(id);
    if (existing !== undefined) {
      this.steps[existing] = { id, title, status };
    } else {
      this.indexById.set(id, this.steps.length);
      this.steps.push({ id, title, status });
    }
  }

  private deriveStatus(): ChecklistStatus {
    if (this.steps.length === 0) return 'pending';
    if (this.steps.some((step) => step.status === 'failed')) return 'failed';
    if (this.steps.every((step) => step.status === 'done' || step.status === 'skipped')) {
      return 'done';
    }
    if (this.steps.some((step) => step.status === 'running')) return 'running';
    return 'pending';
  }
}
