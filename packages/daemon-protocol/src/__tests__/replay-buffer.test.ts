import { describe, expect, it } from 'vitest';
import { EventReplayBuffer } from '../replay-buffer.js';
import type { RuntimeEvent } from '@open-tag/core-types';

function statusEvent(message: string): RuntimeEvent {
  return { type: 'status', message };
}

describe('EventReplayBuffer — append/seq', () => {
  it('assigns monotonically increasing 1-based seqs', () => {
    const buf = new EventReplayBuffer();
    expect(buf.append(statusEvent('a'))).toBe(1);
    expect(buf.append(statusEvent('b'))).toBe(2);
    expect(buf.append(statusEvent('c'))).toBe(3);
    expect(buf.size()).toBe(3);
    expect(buf.nextSeqValue()).toBe(4);
  });

  it('pending() returns unacked entries in seq order', () => {
    const buf = new EventReplayBuffer();
    buf.append(statusEvent('a'));
    buf.append(statusEvent('b'));
    const pending = buf.pending();
    expect(pending.map((e) => e.seq)).toEqual([1, 2]);
    expect(pending.map((e) => (e.event as { message: string }).message)).toEqual(['a', 'b']);
  });

  it('pending() returns a copy that cannot mutate internal state', () => {
    const buf = new EventReplayBuffer();
    buf.append(statusEvent('a'));
    const pending = buf.pending();
    pending.pop();
    expect(buf.size()).toBe(1);
  });
});

describe('EventReplayBuffer — ack', () => {
  it('drops entries with seq <= lastSeq', () => {
    const buf = new EventReplayBuffer();
    buf.append(statusEvent('a'));
    buf.append(statusEvent('b'));
    buf.append(statusEvent('c'));
    buf.ack(2);
    expect(buf.pending().map((e) => e.seq)).toEqual([3]);
  });

  it('ack of the latest seq empties the buffer', () => {
    const buf = new EventReplayBuffer();
    buf.append(statusEvent('a'));
    buf.append(statusEvent('b'));
    buf.ack(2);
    expect(buf.size()).toBe(0);
    expect(buf.byteSize()).toBe(0);
  });

  it('a stale or duplicate ack is a no-op', () => {
    const buf = new EventReplayBuffer();
    buf.append(statusEvent('a'));
    buf.append(statusEvent('b'));
    buf.ack(1);
    buf.ack(1); // duplicate
    buf.ack(0); // stale
    expect(buf.pending().map((e) => e.seq)).toEqual([2]);
  });

  it('seq keeps advancing across acks (no reuse)', () => {
    const buf = new EventReplayBuffer();
    buf.append(statusEvent('a'));
    buf.ack(1);
    expect(buf.append(statusEvent('b'))).toBe(2);
  });
});

describe('EventReplayBuffer — overflow (D12: detectable, never silent drop)', () => {
  it('overflows on maxCount and does not drop the oldest', () => {
    const buf = new EventReplayBuffer({ maxCount: 2 });
    buf.append(statusEvent('a'));
    buf.append(statusEvent('b'));
    expect(buf.isOverflowed()).toBe(false);
    buf.append(statusEvent('c')); // 3rd exceeds maxCount=2
    expect(buf.isOverflowed()).toBe(true);
    // oldest entries are preserved; the overflowing entry is simply not retained
    expect(buf.pending().map((e) => (e.event as { message: string }).message)).toEqual(['a', 'b']);
  });

  it('overflows on maxBytes', () => {
    const oneEventBytes = JSON.stringify(statusEvent('a')).length;
    const buf = new EventReplayBuffer({ maxBytes: oneEventBytes });
    buf.append(statusEvent('a'));
    expect(buf.isOverflowed()).toBe(false);
    buf.append(statusEvent('b')); // would exceed the single-event byte budget
    expect(buf.isOverflowed()).toBe(true);
    expect(buf.size()).toBe(1);
  });

  it('overflow is sticky and seq still advances for failed dispatch accounting', () => {
    const buf = new EventReplayBuffer({ maxCount: 1 });
    buf.append(statusEvent('a'));
    const overflowingSeq = buf.append(statusEvent('b'));
    expect(buf.isOverflowed()).toBe(true);
    expect(overflowingSeq).toBe(2);
    // further appends remain overflowed and keep advancing seq
    expect(buf.append(statusEvent('c'))).toBe(3);
    expect(buf.isOverflowed()).toBe(true);
  });

  it('defaults to 1000 entries / 5 MB', () => {
    const buf = new EventReplayBuffer();
    for (let i = 0; i < 1000; i += 1) {
      buf.append(statusEvent(`e${i}`));
    }
    expect(buf.isOverflowed()).toBe(false);
    buf.append(statusEvent('overflow'));
    expect(buf.isOverflowed()).toBe(true);
  });
});

describe('EventReplayBuffer — reset', () => {
  it('clears entries, bytes, seq, and the overflow flag', () => {
    const buf = new EventReplayBuffer({ maxCount: 1 });
    buf.append(statusEvent('a'));
    buf.append(statusEvent('b')); // overflow
    expect(buf.isOverflowed()).toBe(true);
    buf.reset();
    expect(buf.isOverflowed()).toBe(false);
    expect(buf.size()).toBe(0);
    expect(buf.byteSize()).toBe(0);
    expect(buf.append(statusEvent('fresh'))).toBe(1);
  });
});
