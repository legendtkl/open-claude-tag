function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function shouldSkipTaskExecution(constraints: unknown): boolean {
  if (!isObjectRecord(constraints)) return false;
  return constraints.debugSkipExecution === true;
}

export function shouldSuppressLoopbackFeishuFeedback(
  constraints: unknown,
  feishuAppId?: string | null,
): boolean {
  if (feishuAppId) return false;
  if (!isObjectRecord(constraints)) return false;
  return constraints.debugLoopback === true;
}
