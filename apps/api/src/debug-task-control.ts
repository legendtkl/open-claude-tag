import type { NormalizedEvent } from '@open-tag/core-types';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractDebugPayload(raw: unknown): Record<string, unknown> | null {
  if (!isObjectRecord(raw)) return null;

  // processEvent() normalizes debug traffic through adaptSdkEvent(), so debug
  // metadata lives under raw.event.message after adaptation.
  const event = raw.event;
  if (isObjectRecord(event)) {
    const message = event.message;
    if (isObjectRecord(message) && isObjectRecord(message.__openClaudeTagDebug)) {
      return message.__openClaudeTagDebug;
    }
  }

  return null;
}

export function shouldSkipTaskExecutionForDebugEvent(event: NormalizedEvent): boolean {
  const debugPayload = extractDebugPayload(event.content.raw);
  return debugPayload?.skipTaskExecution === true;
}
