import { createLogger } from '@open-tag/observability';

/**
 * Shared daemon logger.
 *
 * The credential secret is never passed to this logger: the `connect`/`status`
 * paths log only `redactConfig(...)` output (secret replaced by a marker), and
 * no other module ever puts `machineSecret` into a log object. This invariant is
 * enforced by `config.test.ts` (asserts the redacted view omits the secret) —
 * design §10 "secret never logged".
 */
export const logger = createLogger('daemon');
