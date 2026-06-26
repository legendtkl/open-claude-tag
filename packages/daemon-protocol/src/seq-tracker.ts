/**
 * In-order, exactly-once sequence tracker used by the server (design D12).
 *
 * The daemon may redeliver events after a reconnect (replay) and the server
 * dedups by `(dispatchId, seq)`. One {@link SeqTracker} per dispatch turns the
 * possibly-duplicated, possibly-out-of-order stream of `seq`s into an in-order,
 * deliver-each-seq-exactly-once stream:
 *
 * - {@link accept} returns true the first time a `seq` becomes deliverable and
 *   only in order; it returns false for duplicates (already delivered) and for
 *   future seqs that are buffered until the gap fills.
 * - When a gap fills, the contiguous run of buffered future seqs is released in
 *   order via {@link drain}.
 *
 * Seqs are 1-based and contiguous (matching {@link EventReplayBuffer}); the
 * first deliverable seq is 1.
 */
export class SeqTracker {
  private lastDelivered = 0;
  private readonly buffered = new Set<number>();

  /**
   * Records `seq`. Returns true iff this call makes `seq` deliverable for the
   * first time and in order (i.e. `seq === lastDelivered + 1`). Out-of-order
   * future seqs are buffered (return false) and released later by {@link drain};
   * duplicates (`seq <= lastDelivered`) and already-buffered seqs return false.
   */
  accept(seq: number): boolean {
    if (seq <= this.lastDelivered) {
      return false; // duplicate / replay of an already-delivered seq
    }
    if (seq !== this.lastDelivered + 1) {
      this.buffered.add(seq); // future seq, hold until the gap fills
      return false;
    }
    this.lastDelivered = seq;
    return true;
  }

  /**
   * After an in-order {@link accept}, returns the contiguous run of buffered
   * seqs that are now deliverable, in order, advancing `lastDelivered` past
   * them. Returns an empty array when nothing is ready.
   */
  drain(): number[] {
    const released: number[] = [];
    let next = this.lastDelivered + 1;
    while (this.buffered.has(next)) {
      this.buffered.delete(next);
      this.lastDelivered = next;
      released.push(next);
      next += 1;
    }
    return released;
  }

  /** The highest seq delivered in order so far (0 before any delivery). */
  lastDeliveredSeq(): number {
    return this.lastDelivered;
  }

  /** Count of future seqs held pending an earlier gap. */
  bufferedCount(): number {
    return this.buffered.size;
  }
}
