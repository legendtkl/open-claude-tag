/**
 * Cross-end integration test surface for `@open-tag/daemon`.
 *
 * Re-exports the REAL daemon connection/dispatch modules plus the scriptable
 * stub `RuntimeAdapter` so other apps (notably `apps/worker`) can wire the real
 * daemon client against the real worker gateway over a real WebSocket in one
 * vitest process — the cross-end gap Stage 6.1 closes.
 *
 * This barrel re-exports only what the integration suite needs and pulls in NO
 * test-framework code (the helpers below are framework-agnostic), so it compiles
 * on the normal `tsc` path. The published `files` list and runtime entrypoints
 * are unchanged; this module is consumed via the `./testing` subpath export,
 * which points at the built `dist` output like every other daemon module.
 */

// Real connection/reconnect/replay logic (exercises connection.ts + the
// DispatchManager it constructs internally).
export {
  ConnectionManager,
  FatalConnectionError,
  toWsUrl,
  resolveProxyForTarget,
  PING_INTERVAL_MS,
  INBOUND_SILENCE_DEADLINE_MS,
  type ConnectionManagerOptions,
} from './connection.js';

// Real dispatch manager (concurrency cap / busy rejection / replay / cancel).
export {
  DispatchManager,
  DEFAULT_MAX_CONCURRENT_DISPATCHES,
  resolveMaxConcurrentDispatches,
  type FrameSink,
} from './dispatch-manager.js';

// Backoff (injectable to force fast reconnect timing in tests).
export { Backoff, type BackoffOptions } from './backoff.js';

// Config type used to construct a ConnectionManager.
export type { DaemonConfig } from './config.js';

// Scriptable stub RuntimeAdapter + minimal RuntimeManager stand-in. This is the
// ONLY component stubbed on the daemon side per the Stage 6 contract.
export { StubAdapter, stubRuntimeManager, RecordingSink } from './__tests__/stub-adapter.js';
export { makeDispatchFrame, makeCompletedResult, happyScript } from './__tests__/fixtures.js';
