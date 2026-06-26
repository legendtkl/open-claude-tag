import { describe, expect, it, vi } from 'vitest';
import type { RuntimeEvent } from '@open-tag/core-types';
import { ChecklistFeedback, shouldFlushChecklistUpdate } from '../checklist-feedback.js';
import type { ChannelSender, ConversationRef, DeliveryRef, OutboundMessage } from '../channel-sender.js';

const CONVERSATION: ConversationRef = { kind: 'lark', scopeId: 'chat-1', reply: { parentId: 'm-1' } };

function makeRef(id: string): DeliveryRef {
  return { kind: 'lark', logicalMessageId: id, revision: 0, physicalIds: [id] };
}

function makeSender(): ChannelSender & {
  send: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async (_to: ConversationRef, _msg: OutboundMessage) => makeRef('checklist-1'));
  const update = vi.fn(async (ref: DeliveryRef, _msg: OutboundMessage) => ref);
  return { send, update } as never;
}

/** A clock the test advances explicitly so the throttle stays deterministic. */
function fakeClock(start = 1000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

const planUpdate = (steps: Array<[string, string, string]>): RuntimeEvent =>
  ({
    type: 'plan_update',
    steps: steps.map(([id, title, status]) => ({ id, title, status })),
  }) as RuntimeEvent;

describe('shouldFlushChecklistUpdate', () => {
  it('always flushes the first delivery and any forced flush', () => {
    expect(shouldFlushChecklistUpdate({ now: 5, lastUpdatedAt: 0, intervalMs: 200 })).toBe(true);
    expect(
      shouldFlushChecklistUpdate({ now: 5, lastUpdatedAt: 4, intervalMs: 200, force: true }),
    ).toBe(true);
  });

  it('gates by the minimum interval otherwise', () => {
    expect(shouldFlushChecklistUpdate({ now: 100, lastUpdatedAt: 50, intervalMs: 200 })).toBe(false);
    expect(shouldFlushChecklistUpdate({ now: 300, lastUpdatedAt: 50, intervalMs: 200 })).toBe(true);
  });
});

describe('ChecklistFeedback', () => {
  it('creates the card on the first plan_update, then update()s as steps change', async () => {
    const sender = makeSender();
    const clock = fakeClock();
    const checklist = new ChecklistFeedback({
      sender,
      conversation: CONVERSATION,
      title: 'Do the thing',
      now: clock.now,
      minIntervalMs: 200,
    });

    // First plan_update → a fresh checklist card is sent.
    await checklist.onEvent(planUpdate([['s1', 'Write tests', 'running']]));
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.update).not.toHaveBeenCalled();
    const sentMsg = sender.send.mock.calls[0][1] as Extract<OutboundMessage, { kind: 'checklist' }>;
    expect(sentMsg.kind).toBe('checklist');
    expect(sentMsg.title).toBe('Do the thing');
    expect(sentMsg.status).toBe('running');
    expect(sentMsg.steps).toEqual([{ id: 's1', title: 'Write tests', status: 'running' }]);

    // A later step transition past the throttle window → update() the same card.
    clock.advance(500);
    await checklist.onEvent(planUpdate([['s1', 'Write tests', 'done']]));
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.update).toHaveBeenCalledTimes(1);
    const [updatedRef, updatedMsg] = sender.update.mock.calls[0] as [
      DeliveryRef,
      Extract<OutboundMessage, { kind: 'checklist' }>,
    ];
    expect(updatedRef.physicalIds).toEqual(['checklist-1']);
    expect(updatedMsg.steps).toEqual([{ id: 's1', title: 'Write tests', status: 'done' }]);
    expect(updatedMsg.status).toBe('done');
  });

  it('posts NO checklist when the stream carries no plan_update / tool_use', async () => {
    const sender = makeSender();
    const checklist = new ChecklistFeedback({
      sender,
      conversation: CONVERSATION,
      title: 'No plan',
      now: fakeClock().now,
    });

    const events: RuntimeEvent[] = [
      { type: 'status', message: 'thinking' } as RuntimeEvent,
      { type: 'reasoning', summary: 'pondering' } as RuntimeEvent,
      { type: 'stdout', data: 'hello' } as RuntimeEvent,
    ];
    for (const event of events) await checklist.onEvent(event);
    await checklist.finalize('done');

    expect(sender.send).not.toHaveBeenCalled();
    expect(sender.update).not.toHaveBeenCalled();
  });

  it('upserts a tool_use step into one row', async () => {
    const sender = makeSender();
    const clock = fakeClock();
    const checklist = new ChecklistFeedback({
      sender,
      conversation: CONVERSATION,
      title: 'Tools',
      now: clock.now,
      minIntervalMs: 200,
    });

    await checklist.onEvent({
      type: 'tool_use',
      name: 'Bash',
      summary: 'run ls',
      status: 'running',
    } as RuntimeEvent);
    clock.advance(300);
    await checklist.onEvent({
      type: 'tool_use',
      name: 'Bash',
      summary: 'run ls',
      status: 'done',
    } as RuntimeEvent);

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.update).toHaveBeenCalledTimes(1);
    const updatedMsg = sender.update.mock.calls[0][1] as Extract<
      OutboundMessage,
      { kind: 'checklist' }
    >;
    expect(updatedMsg.steps).toHaveLength(1);
    expect(updatedMsg.steps[0].status).toBe('done');
  });

  it('coalesces throttled changes and flushes the latest on finalize', async () => {
    const sender = makeSender();
    const clock = fakeClock();
    const checklist = new ChecklistFeedback({
      sender,
      conversation: CONVERSATION,
      title: 'Throttle',
      now: clock.now,
      minIntervalMs: 200,
    });

    await checklist.onEvent(planUpdate([['s1', 'A', 'running']])); // first → send
    // Two rapid changes inside the throttle window are suppressed (not dropped).
    await checklist.onEvent(planUpdate([['s1', 'A', 'running'], ['s2', 'B', 'pending']]));
    await checklist.onEvent(planUpdate([['s1', 'A', 'running'], ['s2', 'B', 'running']]));
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.update).not.toHaveBeenCalled();

    // finalize() bypasses the throttle and writes the resolved terminal view.
    await checklist.finalize('done');
    expect(sender.update).toHaveBeenCalledTimes(1);
    const finalMsg = sender.update.mock.calls[0][1] as Extract<
      OutboundMessage,
      { kind: 'checklist' }
    >;
    expect(finalMsg.status).toBe('done');
    expect(finalMsg.steps).toEqual([
      { id: 's1', title: 'A', status: 'done' },
      { id: 's2', title: 'B', status: 'done' },
    ]);
  });

  it('flushes a throttle-suppressed change on a later non-mutating event', async () => {
    const sender = makeSender();
    const clock = fakeClock();
    const checklist = new ChecklistFeedback({
      sender,
      conversation: CONVERSATION,
      title: 'Trailing',
      now: clock.now,
      minIntervalMs: 200,
    });

    await checklist.onEvent(planUpdate([['s1', 'A', 'running']])); // first → send
    await checklist.onEvent(planUpdate([['s1', 'A', 'done']])); // within window → buffered
    expect(sender.update).not.toHaveBeenCalled();

    // The high-frequency stream carries the buffered change out once the window
    // has elapsed, even though this event itself does not mutate the checklist.
    clock.advance(500);
    await checklist.onEvent({ type: 'stdout', data: 'log line' } as RuntimeEvent);

    expect(sender.update).toHaveBeenCalledTimes(1);
    const flushed = sender.update.mock.calls[0][1] as Extract<OutboundMessage, { kind: 'checklist' }>;
    expect(flushed.steps).toEqual([{ id: 's1', title: 'A', status: 'done' }]);

    // A further non-mutating event with nothing buffered does not re-send.
    await checklist.onEvent({ type: 'stdout', data: 'more' } as RuntimeEvent);
    expect(sender.update).toHaveBeenCalledTimes(1);
  });

  it('does not re-send when the snapshot is unchanged', async () => {
    const sender = makeSender();
    const clock = fakeClock();
    const checklist = new ChecklistFeedback({
      sender,
      conversation: CONVERSATION,
      title: 'Idempotent',
      now: clock.now,
      minIntervalMs: 200,
    });

    await checklist.onEvent(planUpdate([['s1', 'A', 'running']]));
    clock.advance(500);
    await checklist.onEvent(planUpdate([['s1', 'A', 'running']])); // identical → skip
    await checklist.finalize('done'); // s1 running → done (changes) → one update

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.update).toHaveBeenCalledTimes(1);
  });
});
