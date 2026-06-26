import { isObjectRecord as isRecord } from '@open-tag/core-types';

export { isRecord };

export function getNestedDelegationConstraints(
  constraints: Record<string, unknown>,
): Record<string, unknown> | null {
  const delegationPackage = constraints.delegationPackage;
  if (!isRecord(delegationPackage)) return null;

  const nestedConstraints = delegationPackage.constraints;
  return isRecord(nestedConstraints) ? nestedConstraints : null;
}

export function getEffectiveTaskConstraints(
  constraints: Record<string, unknown>,
): Record<string, unknown> {
  const nestedConstraints = getNestedDelegationConstraints(constraints);
  if (!nestedConstraints) return constraints;

  const effectiveConstraints = { ...nestedConstraints };
  for (const [key, value] of Object.entries(constraints)) {
    if (value !== undefined) {
      effectiveConstraints[key] = value;
    }
  }
  return effectiveConstraints;
}
