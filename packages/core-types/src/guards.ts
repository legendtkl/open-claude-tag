/**
 * Narrow an unknown value to a plain string-keyed record.
 * Arrays are rejected; use a looser local check if array values are expected.
 */
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
