export interface ParsedSchedule {
  scheduledAt: Date;
  goal: string;
  timeDesc: string;
}

export function formatLocalTime(d: Date, tz = process.env.TZ ?? 'Asia/Shanghai'): string {
  return d.toLocaleString('zh-CN', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// Schedule wall-clock times ("今晚22点") are China time (UTC+8, which has no DST),
// matching `formatLocalTime`'s default zone. Compose the instant in a +8-shifted
// frame using only UTC getters/setters, so the result is the same absolute instant
// regardless of the runner's local timezone (a UTC CI runner and a UTC+8 dev box
// agree). Using `setHours`/`getDate` here would silently bind to the runner's TZ.
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

function chinaWallClockInstant(now: Date, hour: number, minute: number, dayOffset: number): Date {
  const shifted = new Date(now.getTime() + CHINA_OFFSET_MS);
  shifted.setUTCHours(hour, minute, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() + dayOffset);
  return new Date(shifted.getTime() - CHINA_OFFSET_MS);
}

/**
 * Parse "/schedule <time_expr> <goal>" args into a scheduled date + goal string.
 *
 * Supported time expressions (must be a prefix of the input string):
 *   N分钟后  <goal>           — N minutes from now
 *   N小时后  <goal>           — N hours from now
 *   今天/今晚/今日 HH点 | HH:MM  <goal>  — Today at specified time
 *   明天 HH点 | HH:MM  <goal>            — Tomorrow at specified time
 *   ISO-8601 timestamp  <goal>           — Exact datetime
 *
 * Returns null if the time expression cannot be parsed or the goal is empty.
 */
export function parseScheduleArgs(input: string, now = new Date()): ParsedSchedule | null {
  let m: RegExpMatchArray | null;

  // "N分钟后 <goal>" — N minutes from now
  m = input.match(/^(\d+)\s*分钟后\s+([\s\S]+)$/);
  if (m) {
    const mins = parseInt(m[1], 10);
    const scheduledAt = new Date(now.getTime() + mins * 60_000);
    return { scheduledAt, goal: m[2].trim(), timeDesc: `in ${mins} min (${formatLocalTime(scheduledAt)})` };
  }

  // "N小时后 <goal>" — N hours from now
  m = input.match(/^(\d+)\s*小时后\s+([\s\S]+)$/);
  if (m) {
    const hrs = parseInt(m[1], 10);
    const scheduledAt = new Date(now.getTime() + hrs * 3_600_000);
    return { scheduledAt, goal: m[2].trim(), timeDesc: `in ${hrs} hr (${formatLocalTime(scheduledAt)})` };
  }

  // "今天/今晚/今日 HH点 | HH:MM <goal>" — today at specified China-time
  m = input.match(/^(?:今天|今晚|今日)\s*(\d{1,2})(?::(\d{2}))?[点时]?\s+([\s\S]+)$/);
  if (m) {
    const hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    let scheduledAt = chinaWallClockInstant(now, hour, minute, 0);
    // If the time has already passed today, roll over to tomorrow.
    if (scheduledAt <= now) scheduledAt = chinaWallClockInstant(now, hour, minute, 1);
    return { scheduledAt, goal: m[3].trim(), timeDesc: formatLocalTime(scheduledAt) };
  }

  // "明天 HH点 | HH:MM <goal>" — tomorrow at specified China-time
  m = input.match(/^明天\s*(\d{1,2})(?::(\d{2}))?[点时]?\s+([\s\S]+)$/);
  if (m) {
    const hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const scheduledAt = chinaWallClockInstant(now, hour, minute, 1);
    return { scheduledAt, goal: m[3].trim(), timeDesc: formatLocalTime(scheduledAt) };
  }

  // ISO-8601 timestamp  <goal>
  m = input.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z)?)\s+([\s\S]+)$/);
  if (m) {
    const scheduledAt = new Date(m[1]);
    if (isNaN(scheduledAt.getTime())) return null;
    return { scheduledAt, goal: m[2].trim(), timeDesc: formatLocalTime(scheduledAt) };
  }

  return null;
}
