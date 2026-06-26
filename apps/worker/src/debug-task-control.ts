function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function shouldSkipTaskExecution(constraints: unknown): boolean {
  if (!isObjectRecord(constraints)) return false;
  return constraints.debugSkipExecution === true;
}
