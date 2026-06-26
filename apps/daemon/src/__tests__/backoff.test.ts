import { describe, it, expect } from 'vitest';
import { Backoff } from '../backoff.js';

describe('Backoff', () => {
  it('follows the 1 s doubling schedule capped at 60 s (no jitter)', () => {
    const b = new Backoff({ jitter: 0, random: () => 0.5 });
    const delays = [b.next(), b.next(), b.next(), b.next(), b.next(), b.next(), b.next(), b.next()];
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  it('keeps every jittered delay within ±20 % of the capped base', () => {
    // Sweep the random source across [0,1) and assert bounds at each attempt.
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const b = new Backoff({ random: () => r });
      for (let attempt = 0; attempt < 8; attempt++) {
        const base = b.peekBase();
        const delay = b.next();
        expect(delay).toBeGreaterThanOrEqual(Math.round(base * 0.8));
        expect(delay).toBeLessThanOrEqual(Math.round(base * 1.2));
      }
    }
  });

  it('applies the full jitter band at the random extremes', () => {
    const low = new Backoff({ random: () => 0 }).next(); // factor 0.8
    const high = new Backoff({ random: () => 0.999999 }).next(); // factor ~1.2
    expect(low).toBe(800);
    expect(high).toBeCloseTo(1200, -1);
  });

  it('resets the schedule to the base after a successful hello', () => {
    const b = new Backoff({ jitter: 0 });
    b.next(); // 1000
    b.next(); // 2000
    expect(b.attempts()).toBe(2);
    b.reset();
    expect(b.attempts()).toBe(0);
    expect(b.next()).toBe(1000);
  });
});
