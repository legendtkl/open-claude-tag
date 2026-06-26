import { describe, expect, it } from 'vitest';
import { AgentAdmissionScheduler, parseSchedulerConfigFromEnv } from '../scheduler.js';

function createScheduler(now: () => number = () => 0, agentStartIntervalMs = 0) {
  return new AgentAdmissionScheduler({
    agentMaxConcurrency: 2,
    maxConcurrentAgentStarts: 3,
    agentStartIntervalMs,
    now,
  });
}

describe('AgentAdmissionScheduler', () => {
  it('caps running tasks per agent while allowing another agent to enter', () => {
    const scheduler = createScheduler();

    expect(scheduler.admit({ agentId: 'agent_a', taskId: 'task_1' }).admitted).toBe(true);
    expect(scheduler.admit({ agentId: 'agent_a', taskId: 'task_2' }).admitted).toBe(true);

    const capped = scheduler.admit({ agentId: 'agent_a', taskId: 'task_3' });
    expect(capped).toMatchObject({ admitted: false, reason: 'agent_concurrency' });

    const otherAgent = scheduler.admit({ agentId: 'agent_b', taskId: 'task_4' });
    expect(otherAgent.admitted).toBe(true);
  });

  it('keeps start slots separate from running slots', () => {
    const scheduler = createScheduler();
    const first = scheduler.admit({ agentId: 'agent_a', taskId: 'task_1' });
    const second = scheduler.admit({ agentId: 'agent_b', taskId: 'task_2' });
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    expect(scheduler.snapshot().startingCount).toBe(2);

    if (!first.admitted) throw new Error('expected first task to admit');
    first.handle.releaseStartSlot();
    expect(scheduler.snapshot().startingCount).toBe(1);
    expect(scheduler.snapshot().runningByAgent.agent_a).toBe(1);
  });

  it('rate limits repeated starts for the same agent', () => {
    let now = 0;
    const scheduler = createScheduler(() => now, 500);

    const first = scheduler.admit({ agentId: 'agent_a', taskId: 'task_1' });
    expect(first.admitted).toBe(true);
    if (!first.admitted) throw new Error('expected first task to admit');
    first.handle.releaseStartSlot();

    const delayed = scheduler.admit({ agentId: 'agent_a', taskId: 'task_2' });
    expect(delayed).toMatchObject({ admitted: false, reason: 'cold_start', retryAfterMs: 500 });

    now = 500;
    expect(scheduler.admit({ agentId: 'agent_a', taskId: 'task_2' }).admitted).toBe(true);
  });

  it('skips duplicate task admission until the running slot is released', () => {
    const scheduler = createScheduler();
    const admitted = scheduler.admit({ agentId: 'agent_a', taskId: 'task_1' });
    expect(admitted.admitted).toBe(true);

    expect(scheduler.admit({ agentId: 'agent_a', taskId: 'task_1' })).toMatchObject({
      admitted: false,
      reason: 'duplicate',
    });

    if (!admitted.admitted) throw new Error('expected task to admit');
    admitted.handle.releaseRunningSlot();
    expect(scheduler.admit({ agentId: 'agent_a', taskId: 'task_1' }).admitted).toBe(true);
  });

  it('defaults to unlimited server-side admission (limits enforced per-machine by the daemon)', () => {
    expect(parseSchedulerConfigFromEnv({})).toMatchObject({
      agentMaxConcurrency: Number.POSITIVE_INFINITY,
      maxConcurrentAgentStarts: Number.POSITIVE_INFINITY,
      agentStartIntervalMs: 0,
    });
    // Operator-supplied overrides are still validated.
    expect(parseSchedulerConfigFromEnv({ AGENT_MAX_CONCURRENCY: '3' })).toMatchObject({
      agentMaxConcurrency: 3,
    });
    expect(() => parseSchedulerConfigFromEnv({ AGENT_MAX_CONCURRENCY: '0' })).toThrow(
      'AGENT_MAX_CONCURRENCY must be a positive integer',
    );
  });

  it('admits unboundedly per agent under default (unlimited) config', () => {
    const scheduler = new AgentAdmissionScheduler(parseSchedulerConfigFromEnv({}));
    for (let i = 0; i < 50; i += 1) {
      expect(scheduler.admit({ agentId: 'agent_a', taskId: `task_${i}` }).admitted).toBe(true);
    }
    // Duplicate suppression still applies even when concurrency is unlimited.
    expect(scheduler.admit({ agentId: 'agent_a', taskId: 'task_0' })).toMatchObject({
      admitted: false,
      reason: 'duplicate',
    });
  });
});
