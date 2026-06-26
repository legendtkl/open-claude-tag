import { describe, it, expect } from 'vitest';
import { parseScheduleArgs } from '../schedule-utils.js';

// Fixed reference time: 2026-03-24 14:00:00 UTC+8
const NOW = new Date('2026-03-24T06:00:00.000Z'); // 14:00 CST

describe('parseScheduleArgs', () => {
  describe('N分钟后', () => {
    it('parses "30分钟后 implement feature"', () => {
      const result = parseScheduleArgs('30分钟后 implement feature', NOW);
      expect(result).not.toBeNull();
      expect(result!.goal).toBe('implement feature');
      const diffMs = result!.scheduledAt.getTime() - NOW.getTime();
      expect(diffMs).toBe(30 * 60_000);
    });

    it('parses with space "5 分钟后 do something"', () => {
      const result = parseScheduleArgs('5 分钟后 do something', NOW);
      expect(result).not.toBeNull();
      expect(result!.goal).toBe('do something');
      const diffMs = result!.scheduledAt.getTime() - NOW.getTime();
      expect(diffMs).toBe(5 * 60_000);
    });

    it('includes timeDesc with minutes count', () => {
      const result = parseScheduleArgs('10分钟后 test', NOW);
      expect(result!.timeDesc).toContain('in 10 min');
    });
  });

  describe('N小时后', () => {
    it('parses "2小时后 run tests"', () => {
      const result = parseScheduleArgs('2小时后 run tests', NOW);
      expect(result).not.toBeNull();
      expect(result!.goal).toBe('run tests');
      const diffMs = result!.scheduledAt.getTime() - NOW.getTime();
      expect(diffMs).toBe(2 * 3_600_000);
    });

    it('parses "1小时后 multi-word goal with spaces"', () => {
      const result = parseScheduleArgs('1小时后 multi-word goal with spaces', NOW);
      expect(result!.goal).toBe('multi-word goal with spaces');
    });

    it('includes timeDesc with hours count', () => {
      const result = parseScheduleArgs('3小时后 test', NOW);
      expect(result!.timeDesc).toContain('in 3 hr');
    });
  });

  describe('今天/今晚/今日 HH点', () => {
    it('parses "今晚22点 implement auth" — future time', () => {
      // NOW is 14:00, 22:00 is in the future
      const result = parseScheduleArgs('今晚22点 implement auth', NOW);
      expect(result).not.toBeNull();
      expect(result!.goal).toBe('implement auth');
      expect(result!.scheduledAt.getUTCHours()).toBe(14); // 22:00 CST = 14:00 UTC
    });

    it('parses "今天10点 ..." — past time rolls to tomorrow', () => {
      // NOW is 14:00 CST, 10:00 CST is already past
      const result = parseScheduleArgs('今天10点 do the task', NOW);
      expect(result).not.toBeNull();
      // Should be tomorrow 10:00
      const scheduledDay = result!.scheduledAt.getUTCDate();
      expect(scheduledDay).toBe(25); // March 25
    });

    it('parses "今日9点 ..." — past time rolls to tomorrow', () => {
      const result = parseScheduleArgs('今日9点 fix bug', NOW);
      expect(result!.scheduledAt.getUTCDate()).toBe(25);
    });

    it('parses HH:MM format "今晚22:30 goal"', () => {
      const result = parseScheduleArgs('今晚22:30 goal', NOW);
      expect(result).not.toBeNull();
      expect(result!.scheduledAt.getUTCMinutes()).toBe(30);
    });

    it('parses "今天时" variant', () => {
      const result = parseScheduleArgs('今天23时 last thing', NOW);
      expect(result).not.toBeNull();
      expect(result!.goal).toBe('last thing');
    });
  });

  describe('明天 HH点', () => {
    it('parses "明天9点 implement feature"', () => {
      const result = parseScheduleArgs('明天9点 implement feature', NOW);
      expect(result).not.toBeNull();
      expect(result!.goal).toBe('implement feature');
      // Tomorrow is March 25
      expect(result!.scheduledAt.getUTCDate()).toBe(25);
      // 9:00 CST = 01:00 UTC
      expect(result!.scheduledAt.getUTCHours()).toBe(1);
    });

    it('parses "明天9:30 build and test"', () => {
      const result = parseScheduleArgs('明天9:30 build and test', NOW);
      expect(result).not.toBeNull();
      expect(result!.scheduledAt.getUTCMinutes()).toBe(30);
    });

    it('parses multiline goal', () => {
      const result = parseScheduleArgs('明天9点 implement multi-turn-conversation', NOW);
      expect(result!.goal).toBe('implement multi-turn-conversation');
    });
  });

  describe('ISO-8601 timestamp', () => {
    it('parses "2026-03-25T09:00:00 do work" (no timezone — interpreted as local)', () => {
      const result = parseScheduleArgs('2026-03-25T09:00:00 do work', NOW);
      expect(result).not.toBeNull();
      expect(result!.goal).toBe('do work');
      // Date is valid and in the future relative to NOW
      expect(result!.scheduledAt).toBeInstanceOf(Date);
      expect(result!.scheduledAt.getTime()).toBeGreaterThan(NOW.getTime());
    });

    it('parses ISO with timezone offset "2026-03-25T09:00:00+08:00 goal"', () => {
      const result = parseScheduleArgs('2026-03-25T09:00:00+08:00 goal', NOW);
      expect(result).not.toBeNull();
      // 09:00+08:00 = 01:00 UTC
      expect(result!.scheduledAt.getUTCHours()).toBe(1);
    });

    it('parses ISO with Z suffix', () => {
      const result = parseScheduleArgs('2026-03-25T09:00:00Z goal', NOW);
      expect(result).not.toBeNull();
      expect(result!.scheduledAt.getUTCHours()).toBe(9);
    });

    it('returns null for invalid ISO date', () => {
      const result = parseScheduleArgs('2026-99-99T25:00:00 goal', NOW);
      expect(result).toBeNull();
    });
  });

  describe('invalid inputs', () => {
    it('returns null for empty string', () => {
      expect(parseScheduleArgs('', NOW)).toBeNull();
    });

    it('returns null for unrecognised time expression', () => {
      expect(parseScheduleArgs('下周 implement feature', NOW)).toBeNull();
    });

    it('returns null for time-only without goal', () => {
      expect(parseScheduleArgs('明天9点', NOW)).toBeNull();
    });

    it('returns null for goal-only without time', () => {
      expect(parseScheduleArgs('implement feature', NOW)).toBeNull();
    });

    it('returns null for garbage input', () => {
      expect(parseScheduleArgs('abc xyz 123', NOW)).toBeNull();
    });
  });

  describe('goal extraction', () => {
    it('trims leading/trailing whitespace from goal', () => {
      const result = parseScheduleArgs('30分钟后   implement feature   ', NOW);
      expect(result!.goal).toBe('implement feature');
    });

    it('preserves internal goal spacing', () => {
      const result = parseScheduleArgs('1小时后 run pnpm build && pnpm test', NOW);
      expect(result!.goal).toBe('run pnpm build && pnpm test');
    });
  });
});
