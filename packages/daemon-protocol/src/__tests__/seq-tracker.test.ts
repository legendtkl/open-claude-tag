import { describe, expect, it } from 'vitest';
import { SeqTracker } from '../seq-tracker.js';

describe('SeqTracker — in-order delivery', () => {
  it('accepts a contiguous 1-based stream exactly once', () => {
    const t = new SeqTracker();
    expect(t.accept(1)).toBe(true);
    expect(t.accept(2)).toBe(true);
    expect(t.accept(3)).toBe(true);
    expect(t.lastDeliveredSeq()).toBe(3);
  });

  it('does not accept seq 0 or a gap from empty (first deliverable is 1)', () => {
    const t = new SeqTracker();
    expect(t.accept(0)).toBe(false);
    expect(t.accept(2)).toBe(false); // buffered as a future seq
    expect(t.lastDeliveredSeq()).toBe(0);
  });
});

describe('SeqTracker — duplicates', () => {
  it('returns false for a replayed already-delivered seq', () => {
    const t = new SeqTracker();
    expect(t.accept(1)).toBe(true);
    expect(t.accept(1)).toBe(false);
    expect(t.accept(2)).toBe(true);
    expect(t.accept(2)).toBe(false);
    expect(t.lastDeliveredSeq()).toBe(2);
  });

  it('returns false for a future seq seen twice (already buffered)', () => {
    const t = new SeqTracker();
    expect(t.accept(3)).toBe(false);
    expect(t.accept(3)).toBe(false);
    expect(t.bufferedCount()).toBe(1);
  });
});

describe('SeqTracker — out-of-order buffering and drain', () => {
  it('buffers future seqs and releases them in order when the gap fills', () => {
    const t = new SeqTracker();
    expect(t.accept(2)).toBe(false); // future
    expect(t.accept(3)).toBe(false); // future
    expect(t.bufferedCount()).toBe(2);
    expect(t.drain()).toEqual([]); // nothing deliverable yet

    expect(t.accept(1)).toBe(true); // fills the gap
    expect(t.drain()).toEqual([2, 3]); // contiguous run released in order
    expect(t.lastDeliveredSeq()).toBe(3);
    expect(t.bufferedCount()).toBe(0);
  });

  it('drains only the contiguous run, leaving later gaps buffered', () => {
    const t = new SeqTracker();
    t.accept(2);
    t.accept(4); // not contiguous with 2
    expect(t.accept(1)).toBe(true);
    expect(t.drain()).toEqual([2]); // 3 is missing, so 4 stays buffered
    expect(t.lastDeliveredSeq()).toBe(2);
    expect(t.bufferedCount()).toBe(1);

    expect(t.accept(3)).toBe(true);
    expect(t.drain()).toEqual([4]);
    expect(t.lastDeliveredSeq()).toBe(4);
  });

  it('handles a realistic flap-then-replay: 1,2 then dup 1,2 then 3,4', () => {
    const t = new SeqTracker();
    const delivered: number[] = [];
    const feed = (seq: number) => {
      if (t.accept(seq)) {
        delivered.push(seq);
        delivered.push(...t.drain());
      }
    };
    // first stream
    feed(1);
    feed(2);
    // socket flap; daemon replays unacked 1,2 then continues
    feed(1); // dup
    feed(2); // dup
    feed(3);
    feed(4);
    expect(delivered).toEqual([1, 2, 3, 4]);
  });
});
