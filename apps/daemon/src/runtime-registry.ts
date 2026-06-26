import {
  RuntimeManager,
  registerClaudeRuntimeAdapter,
  CodexAdapter,
  CocoAdapter,
} from '@open-tag/runtime-adapters';
import { logger } from './logger.js';
import { resolveCodexBinary, resolveCocoBinary } from './capabilities.js';

/**
 * Builds a local `RuntimeManager` with the Claude Code and Codex adapters
 * registered exactly as the worker does (`apps/worker/src/main.ts:2052-2068`),
 * minus the Feishu image downloader: the daemon receives images inline in the
 * dispatch (D11) and materializes them itself, so no platform downloader is
 * wired in.
 *
 * Codex is registered only when a binary is resolvable; otherwise the manager
 * holds Claude alone. With neither runtime the manager is empty and dispatches
 * will fail at adapter selection — `doctor` warns about this up front.
 */
export function buildRuntimeManager(env: NodeJS.ProcessEnv = process.env): RuntimeManager {
  const manager = new RuntimeManager();

  // Claude registers unconditionally; per-agent BASE_URL / API_KEY (runtimeEnv)
  // supply credentials at execution time, with global ANTHROPIC_* env as an
  // optional fallback default.
  // Drive the adapter's global fallback config from the SAME injected env the
  // codex/coco lines (and the diagnostic below) use, not process.env — otherwise
  // a caller-supplied env would configure the adapter and log inconsistently.
  registerClaudeRuntimeAdapter(manager, { env });
  // A usable global credential fallback hinges on an auth token, not the base
  // URL (which has a default endpoint). Keying this diagnostic on
  // ANTHROPIC_BASE_URL was misleading in two cases: a global API key/token with
  // no explicit base URL (real fallback, logged as none), and a base URL with
  // no token (no usable credential, logged as present).
  logger.info(
    { globalFallback: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) },
    'Registered ClaudeCodeAdapter',
  );

  // Pass the RESOLVED path, not undefined-on-PATH-hit: the SDK's
  // codexPathOverride must point at the user's installed CLI, or it silently
  // runs its own bundled (older) codex binary with a stale default model.
  const codexBinaryPath = resolveCodexBinary(env);
  if (codexBinaryPath) {
    manager.register(new CodexAdapter({ binaryPath: codexBinaryPath }));
    logger.info({ binaryPath: codexBinaryPath }, 'Registered CodexAdapter');
  } else {
    logger.warn('Codex runtime not registered: no codex binary resolvable');
  }

  // Coco resolves from the user's installed CLI (login shell / PATH); it is not
  // an npm dependency so the path is passed straight through.
  const cocoBinaryPath = resolveCocoBinary(env);
  if (cocoBinaryPath) {
    manager.register(new CocoAdapter({ binaryPath: cocoBinaryPath }));
    logger.info({ binaryPath: cocoBinaryPath }, 'Registered CocoAdapter');
  } else {
    logger.warn('Coco runtime not registered: no coco binary resolvable');
  }

  return manager;
}
