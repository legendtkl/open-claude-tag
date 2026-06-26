import type { RuntimeEvent } from '@open-tag/core-types';

/**
 * Bounded per-dispatch replay buffer used by the daemon (design D12).
 *
 * The daemon keeps every unacked `task_event` here so it can replay them on
 * reconnect. The buffer assigns a monotonically increasing `seq` to each
 * appended event; the server acks a cumulative `lastSeq`, which drops every
 * entry at or below it.
 *
 * Overflow semantics are deliberate (D12): when the buffer would exceed its
 * `maxCount` or `maxBytes` bound it does NOT drop the oldest entry — silently
 * dropping events would corrupt the at-most-once / in-order guarantee the data
 * plane depends on. Instead it enters a sticky `overflowed` state so the
 * dispatch can be failed deterministically. Bytes are measured on
 * `JSON.stringify(event).length`.
 */

export interface BufferedEvent {
  seq: number;
  event: RuntimeEvent;
}

export interface EventReplayBufferOptions {
  /** Max retained (unacked) entries before overflow. Default 1000. */
  maxCount?: number;
  /** Max retained (unacked) bytes before overflow. Default 5 MB. */
  maxBytes?: number;
}

const DEFAULT_MAX_COUNT = 1000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export class EventReplayBuffer {
  private readonly maxCount: number;
  private readonly maxBytes: number;
  private entries: BufferedEvent[] = [];
  private sizes: number[] = [];
  private totalBytes = 0;
  private nextSeq = 1;
  private overflowed = false;

  constructor(options: EventReplayBufferOptions = {}) {
    this.maxCount = options.maxCount ?? DEFAULT_MAX_COUNT;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /**
   * Appends an event, assigning and returning its `seq`. Even after overflow the
   * seq keeps advancing so the counter stays consistent, but the entry is not
   * retained (the dispatch is already doomed to fail).
   */
  append(event: RuntimeEvent): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;

    if (this.overflowed) {
      return seq;
    }

    const size = JSON.stringify(event).length;
    const wouldExceedCount = this.entries.length + 1 > this.maxCount;
    const wouldExceedBytes = this.totalBytes + size > this.maxBytes;
    if (wouldExceedCount || wouldExceedBytes) {
      this.overflowed = true;
      return seq;
    }

    this.entries.push({ seq, event });
    this.sizes.push(size);
    this.totalBytes += size;
    return seq;
  }

  /**
   * Drops every retained entry with `seq <= lastSeq` (cumulative ack). A stale
   * or duplicate ack (lastSeq below what is already acked) is a no-op.
   */
  ack(lastSeq: number): void {
    let dropCount = 0;
    while (dropCount < this.entries.length && this.entries[dropCount].seq <= lastSeq) {
      this.totalBytes -= this.sizes[dropCount];
      dropCount += 1;
    }
    if (dropCount > 0) {
      this.entries = this.entries.slice(dropCount);
      this.sizes = this.sizes.slice(dropCount);
    }
  }

  /** Returns the unacked entries in seq order (for replay on reconnect). */
  pending(): BufferedEvent[] {
    return this.entries.slice();
  }

  /** True once a bound was exceeded; sticky until {@link reset}. */
  isOverflowed(): boolean {
    return this.overflowed;
  }

  /** Number of retained (unacked) entries. */
  size(): number {
    return this.entries.length;
  }

  /** Retained (unacked) byte total. */
  byteSize(): number {
    return this.totalBytes;
  }

  /** The seq that the next {@link append} will assign. */
  nextSeqValue(): number {
    return this.nextSeq;
  }

  /** Clears all state, including the overflow flag and the seq counter. */
  reset(): void {
    this.entries = [];
    this.sizes = [];
    this.totalBytes = 0;
    this.nextSeq = 1;
    this.overflowed = false;
  }
}
