import type { RunningCardSource } from './runtime-event-routing.js';

const RUNNING_ACTIVITY_MAX_ENTRIES = 10;
const RUNNING_ACTIVITY_LINE_MAX_LENGTH = 160;
const RUNNING_CARD_UPDATE_INTERVAL_MS = 1500;

function truncateActivityLine(line: string): string {
  return line.length > RUNNING_ACTIVITY_LINE_MAX_LENGTH
    ? `${line.slice(0, RUNNING_ACTIVITY_LINE_MAX_LENGTH - 3)}...`
    : line;
}

function normalizeActivityLine(line: string): string | null {
  const normalized = line.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return truncateActivityLine(normalized);
}

export function appendRunningActivity(
  activity: string[],
  rawMessage: string,
  source: RunningCardSource,
): string[] {
  const prefix =
    source === 'stdout' || source === 'stderr' || source === 'reasoning'
      ? `[${source}] `
      : '';
  const nextActivity = [...activity];

  for (const line of rawMessage.split(/\r?\n/g)) {
    const normalizedLine = normalizeActivityLine(line);
    if (!normalizedLine) {
      continue;
    }

    const entry = `${prefix}${normalizedLine}`;
    if (nextActivity[nextActivity.length - 1] === entry) {
      continue;
    }

    nextActivity.push(entry);
  }

  return nextActivity.slice(-RUNNING_ACTIVITY_MAX_ENTRIES);
}

export function shouldFlushRunningCardUpdate(params: {
  now: number;
  lastUpdatedAt: number;
  source: RunningCardSource;
  force?: boolean;
}): boolean {
  const { now, lastUpdatedAt, source, force = false } = params;

  if (force || lastUpdatedAt === 0 || source === 'progress') {
    return true;
  }

  return now - lastUpdatedAt >= RUNNING_CARD_UPDATE_INTERVAL_MS;
}
