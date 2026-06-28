import { CLAUDE_CODE_DESCRIPTOR } from './claude-code-adapter.js';
import { CODEX_DESCRIPTOR } from './codex-adapter.js';
import type { RuntimeName } from '@open-tag/core-types';
import type { RuntimeDescriptor } from './types.js';

/**
 * Lookup from the PERSISTED runtime key (`name()` — `claude_code` underscore,
 * `codex`) to its open {@link RuntimeDescriptor}. The map key is the persisted
 * name; `descriptor.id` is the separate open/hyphen id. Proxy adapters (e.g. the
 * worker's RemoteRuntimeAdapter) resolve their descriptor from the underlying
 * runtime name through here instead of redefining capabilities.
 *
 * Keyed by {@link RuntimeName} (issue #16) so the descriptor registry stays in
 * compile-time lockstep with the runtime-name SoT: adding/removing a name in
 * `KNOWN_RUNTIME_NAMES` forces a matching descriptor change here. This also makes
 * the `value is RuntimeName` guards backed by {@link getRuntimeDescriptor} sound —
 * a descriptor can only exist for a known name.
 */
export const RUNTIME_DESCRIPTORS_BY_NAME: Readonly<Record<RuntimeName, RuntimeDescriptor>> = {
  claude_code: CLAUDE_CODE_DESCRIPTOR,
  codex: CODEX_DESCRIPTOR,
};

/**
 * Resolve a descriptor by persisted `name()`. Returns undefined for unknown
 * runtimes. Uses an own-key check so inherited `Object.prototype` members
 * (`toString`, `constructor`, …) are never mistaken for a registered runtime —
 * callers rely on this for membership/validation, not just lookup.
 */
export function getRuntimeDescriptor(name: string): RuntimeDescriptor | undefined {
  return Object.hasOwn(RUNTIME_DESCRIPTORS_BY_NAME, name)
    ? RUNTIME_DESCRIPTORS_BY_NAME[name as RuntimeName]
    : undefined;
}
