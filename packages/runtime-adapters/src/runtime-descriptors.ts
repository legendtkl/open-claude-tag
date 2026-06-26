import { CLAUDE_CODE_DESCRIPTOR } from './claude-code-adapter.js';
import { CODEX_DESCRIPTOR } from './codex-adapter.js';
import { COCO_DESCRIPTOR } from './coco-adapter.js';
import type { RuntimeDescriptor } from './types.js';

/**
 * Lookup from the PERSISTED runtime key (`name()` — `claude_code` underscore,
 * `codex`, `coco`) to its open {@link RuntimeDescriptor}. The map key is the
 * persisted name; `descriptor.id` is the separate open/hyphen id. Proxy adapters
 * (e.g. the worker's RemoteRuntimeAdapter) resolve their descriptor from the
 * underlying runtime name through here instead of redefining capabilities.
 */
export const RUNTIME_DESCRIPTORS_BY_NAME: Readonly<Record<string, RuntimeDescriptor>> = {
  claude_code: CLAUDE_CODE_DESCRIPTOR,
  codex: CODEX_DESCRIPTOR,
  coco: COCO_DESCRIPTOR,
};

/**
 * Resolve a descriptor by persisted `name()`. Returns undefined for unknown
 * runtimes. Uses an own-key check so inherited `Object.prototype` members
 * (`toString`, `constructor`, …) are never mistaken for a registered runtime —
 * callers rely on this for membership/validation, not just lookup.
 */
export function getRuntimeDescriptor(name: string): RuntimeDescriptor | undefined {
  return Object.hasOwn(RUNTIME_DESCRIPTORS_BY_NAME, name)
    ? RUNTIME_DESCRIPTORS_BY_NAME[name]
    : undefined;
}
