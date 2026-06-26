import { describe, expect, it, vi } from 'vitest';
import { failTaskCreatedPipeline } from '../task-pipeline-compensation.js';

function makeInput(overrides: Partial<Parameters<typeof failTaskCreatedPipeline>[0]> = {}) {
  return {
    taskId: 'task-1',
    goal: 'do the thing',
    error: new Error('feishu hiccup'),
    ackMessageId: 'om_ack',
    feedback: { updateFailed: vi.fn().mockResolvedValue(undefined) },
    persistFailedFeedbackState: vi.fn().mockResolvedValue(undefined),
    transitionTaskFailed: vi.fn().mockResolvedValue(undefined),
    logger: { error: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

describe('failTaskCreatedPipeline', () => {
  it('updates the feedback card, persists the state, and fails the task', async () => {
    const input = makeInput();
    await failTaskCreatedPipeline(input);

    expect(input.feedback!.updateFailed).toHaveBeenCalledWith('do the thing', 'feishu hiccup');
    expect(input.persistFailedFeedbackState).toHaveBeenCalledTimes(1);
    expect(input.transitionTaskFailed).toHaveBeenCalledWith('feishu hiccup');
  });

  it('skips card compensation when no ack was ever sent', async () => {
    const input = makeInput({ ackMessageId: null });
    await failTaskCreatedPipeline(input);

    expect(input.feedback!.updateFailed).not.toHaveBeenCalled();
    expect(input.persistFailedFeedbackState).not.toHaveBeenCalled();
    expect(input.transitionTaskFailed).toHaveBeenCalledTimes(1);
  });

  it('never throws and still fails the task when every feedback step rejects', async () => {
    const input = makeInput({
      feedback: { updateFailed: vi.fn().mockRejectedValue(new Error('card gone')) },
      persistFailedFeedbackState: vi.fn().mockRejectedValue(new Error('db down')),
    });
    await expect(failTaskCreatedPipeline(input)).resolves.toBeUndefined();
    expect(input.transitionTaskFailed).toHaveBeenCalledTimes(1);
  });

  it('never throws when the FAILED transition itself rejects', async () => {
    const input = makeInput({
      transitionTaskFailed: vi.fn().mockRejectedValue(new Error('state conflict')),
    });
    await expect(failTaskCreatedPipeline(input)).resolves.toBeUndefined();
    expect(input.logger.error).toHaveBeenCalledTimes(2);
  });
});
