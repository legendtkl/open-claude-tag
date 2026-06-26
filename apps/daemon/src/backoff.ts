/**
 * Exponential reconnect backoff with jitter (design D16).
 *
 * Base delay starts at 1 s and doubles per attempt up to a 60 s cap, with
 * ±20 % jitter applied to each computed delay. The schedule resets to the base
 * on a successful `hello` (the connection manager calls {@link reset}).
 */

export interface BackoffOptions {
  /** First delay, milliseconds. Default 1000. */
  baseMs?: number;
  /** Maximum delay, milliseconds. Default 60000. */
  maxMs?: number;
  /** Jitter fraction in [0,1). Default 0.2 (±20 %). */
  jitter?: number;
  /** Random source in [0,1). Injectable for deterministic tests. */
  random?: () => number;
}

const DEFAULT_BASE_MS = 1000;
const DEFAULT_MAX_MS = 60000;
const DEFAULT_JITTER = 0.2;

export class Backoff {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly jitter: number;
  private readonly random: () => number;
  private attempt = 0;

  constructor(options: BackoffOptions = {}) {
    this.baseMs = options.baseMs ?? DEFAULT_BASE_MS;
    this.maxMs = options.maxMs ?? DEFAULT_MAX_MS;
    this.jitter = options.jitter ?? DEFAULT_JITTER;
    this.random = options.random ?? Math.random;
  }

  /**
   * Returns the next delay (ms) and advances the attempt counter. The
   * pre-jitter delay is `min(base * 2^attempt, max)`; jitter then scales it by a
   * factor in `[1 - jitter, 1 + jitter)`. The result is always within those
   * bounds of the capped delay.
   */
  next(): number {
    const capped = Math.min(this.baseMs * 2 ** this.attempt, this.maxMs);
    this.attempt += 1;
    const factor = 1 - this.jitter + this.random() * (2 * this.jitter);
    return Math.round(capped * factor);
  }

  /**
   * The pre-jitter (deterministic) delay the next {@link next} would use, for
   * tests/diagnostics that assert the doubling schedule without jitter noise.
   */
  peekBase(): number {
    return Math.min(this.baseMs * 2 ** this.attempt, this.maxMs);
  }

  /** Resets the schedule to the base delay (after a successful hello). */
  reset(): void {
    this.attempt = 0;
  }

  /** Number of {@link next} calls since construction or the last {@link reset}. */
  attempts(): number {
    return this.attempt;
  }
}
