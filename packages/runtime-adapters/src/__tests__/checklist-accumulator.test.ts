import { describe, it, expect } from 'vitest';
import type { RuntimeEvent } from '@open-tag/core-types';
import { ChecklistAccumulator } from '../checklist-accumulator.js';

const planUpdate = (steps: { id: string; title: string; status: any }[]): RuntimeEvent => ({
  type: 'plan_update',
  steps,
});

const toolUse = (name: string, summary: string, status: any): RuntimeEvent => ({
  type: 'tool_use',
  name,
  summary,
  status,
});

describe('ChecklistAccumulator', () => {
  it('starts empty with pending status', () => {
    expect(new ChecklistAccumulator().snapshot()).toEqual({ steps: [], status: 'pending' });
  });

  it('plan_update replaces the entire step set', () => {
    const acc = new ChecklistAccumulator();
    acc.apply(
      planUpdate([
        { id: 'step-0', title: 'A', status: 'done' },
        { id: 'step-1', title: 'B', status: 'running' },
      ]),
    );
    acc.apply(planUpdate([{ id: 'step-0', title: 'C', status: 'pending' }]));

    expect(acc.snapshot().steps).toEqual([{ id: 'step-0', title: 'C', status: 'pending' }]);
  });

  it('tool_use appends a step then updates it in place', () => {
    const acc = new ChecklistAccumulator();
    acc.apply(toolUse('Bash', 'Running: pnpm test', 'running'));
    expect(acc.snapshot().steps).toEqual([
      { id: 'tool:Bash', title: 'Running: pnpm test', status: 'running' },
    ]);

    acc.apply(toolUse('Bash', 'Running: pnpm test', 'done'));
    // Same tool name → one row, updated in place rather than duplicated.
    expect(acc.snapshot().steps).toEqual([
      { id: 'tool:Bash', title: 'Running: pnpm test', status: 'done' },
    ]);
  });

  it('ignores unrelated event types', () => {
    const acc = new ChecklistAccumulator();
    acc.applyAll([
      { type: 'status', message: 'hi' },
      { type: 'progress', percent: 10, message: 'x' },
      { type: 'reasoning', summary: 'thinking' },
    ]);
    expect(acc.snapshot()).toEqual({ steps: [], status: 'pending' });
  });

  it('derives done when every step is done or skipped', () => {
    const acc = new ChecklistAccumulator([
      planUpdate([
        { id: 'a', title: 'A', status: 'done' },
        { id: 'b', title: 'B', status: 'skipped' },
      ]),
    ]);
    expect(acc.snapshot().status).toBe('done');
  });

  it('derives failed when any step failed (failed wins over running)', () => {
    const acc = new ChecklistAccumulator([
      planUpdate([
        { id: 'a', title: 'A', status: 'running' },
        { id: 'b', title: 'B', status: 'failed' },
      ]),
    ]);
    expect(acc.snapshot().status).toBe('failed');
  });

  it('derives running when a step is in progress and none failed', () => {
    const acc = new ChecklistAccumulator([
      planUpdate([
        { id: 'a', title: 'A', status: 'done' },
        { id: 'b', title: 'B', status: 'running' },
        { id: 'c', title: 'C', status: 'pending' },
      ]),
    ]);
    expect(acc.snapshot().status).toBe('running');
  });

  it('folds a mixed sequence of plan_update and tool_use into the expected snapshot', () => {
    const events: RuntimeEvent[] = [
      planUpdate([
        { id: 'step-0', title: 'Plan', status: 'done' },
        { id: 'step-1', title: 'Build', status: 'running' },
      ]),
      toolUse('Bash', 'Running: pnpm build', 'running'),
      toolUse('Bash', 'Running: pnpm build', 'done'),
      planUpdate([
        { id: 'step-0', title: 'Plan', status: 'done' },
        { id: 'step-1', title: 'Build', status: 'done' },
        { id: 'step-2', title: 'Ship', status: 'running' },
      ]),
    ];

    const snapshot = new ChecklistAccumulator(events).snapshot();
    // The latest plan_update is authoritative and replaces earlier tool rows.
    expect(snapshot).toEqual({
      steps: [
        { id: 'step-0', title: 'Plan', status: 'done' },
        { id: 'step-1', title: 'Build', status: 'done' },
        { id: 'step-2', title: 'Ship', status: 'running' },
      ],
      status: 'running',
    });
  });

  it('snapshot returns copies that do not mutate internal state', () => {
    const acc = new ChecklistAccumulator([planUpdate([{ id: 'a', title: 'A', status: 'pending' }])]);
    const snap = acc.snapshot();
    snap.steps[0].status = 'done';
    expect(acc.snapshot().steps[0].status).toBe('pending');
  });
});
