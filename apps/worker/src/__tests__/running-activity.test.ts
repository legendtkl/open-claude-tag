import { describe, expect, it } from 'vitest';
import { appendRunningActivity, shouldFlushRunningCardUpdate } from '../running-activity.js';

describe('appendRunningActivity', () => {
  it('keeps only the latest 10 activity lines', () => {
    let activity: string[] = [];

    for (let index = 1; index <= 12; index += 1) {
      activity = appendRunningActivity(activity, `step ${index}`, 'progress');
    }

    expect(activity).toEqual([
      'step 3',
      'step 4',
      'step 5',
      'step 6',
      'step 7',
      'step 8',
      'step 9',
      'step 10',
      'step 11',
      'step 12',
    ]);
  });

  it('splits multiline stdout and prefixes each line', () => {
    const activity = appendRunningActivity([], 'line 1\n\nline 2', 'stdout');
    expect(activity).toEqual(['[stdout] line 1', '[stdout] line 2']);
  });

  it('prefixes reasoning summaries so they are distinguishable from tool output', () => {
    const activity = appendRunningActivity([], 'Inspecting existing worker flow', 'reasoning');
    expect(activity).toEqual(['[reasoning] Inspecting existing worker flow']);
  });

  it('deduplicates adjacent identical entries', () => {
    const first = appendRunningActivity([], 'Running: pnpm test', 'progress');
    const second = appendRunningActivity(first, 'Running: pnpm test', 'progress');
    expect(second).toEqual(['Running: pnpm test']);
  });

  it('truncates long lines to keep cards compact', () => {
    const activity = appendRunningActivity([], 'x'.repeat(200), 'stderr');
    expect(activity).toHaveLength(1);
    expect(activity[0]?.startsWith('[stderr] ')).toBe(true);
    expect(activity[0].length).toBeLessThanOrEqual(170);
    expect(activity[0]?.endsWith('...')).toBe(true);
  });
});

describe('shouldFlushRunningCardUpdate', () => {
  it('always flushes progress events immediately', () => {
    expect(
      shouldFlushRunningCardUpdate({
        now: 100,
        lastUpdatedAt: 99,
        source: 'progress',
      }),
    ).toBe(true);
  });

  it('flushes the first non-progress update immediately', () => {
    expect(
      shouldFlushRunningCardUpdate({
        now: 100,
        lastUpdatedAt: 0,
        source: 'status',
      }),
    ).toBe(true);
  });

  it('throttles chatty stdout updates within the interval', () => {
    expect(
      shouldFlushRunningCardUpdate({
        now: 1000,
        lastUpdatedAt: 200,
        source: 'stdout',
      }),
    ).toBe(false);
  });

  it('throttles chatty reasoning updates within the interval', () => {
    expect(
      shouldFlushRunningCardUpdate({
        now: 1000,
        lastUpdatedAt: 200,
        source: 'reasoning',
      }),
    ).toBe(false);
  });

  it('allows forced status updates even within the interval', () => {
    expect(
      shouldFlushRunningCardUpdate({
        now: 300,
        lastUpdatedAt: 200,
        source: 'status',
        force: true,
      }),
    ).toBe(true);
  });
});
