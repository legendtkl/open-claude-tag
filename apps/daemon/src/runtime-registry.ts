import {
  buildRuntimeManager as buildRuntimeManagerFromRegistrations,
  claudeRuntimeRegistration,
  CodexAdapter,
  CocoAdapter,
  type RuntimeManager,
} from '@open-tag/runtime-adapters';
import { logger } from './logger.js';
import { resolveCodexBinary, resolveCocoBinary } from './capabilities.js';

/**
 * Builds the daemon's `RuntimeManager` through the shared, data-driven
 * `buildRuntimeManager` factory — the same single source the worker uses
 * (`apps/worker/src/main.ts`), minus the Feishu image downloader: the daemon
 * receives images inline in the dispatch (D11) and materializes them itself, so
 * no platform downloader is wired in.
 *
 * Claude registers unconditionally; Codex / Coco register only when their binary
 * is resolvable, so an unavailable-binary host holds Claude alone. `doctor` warns
 * up front when no CLI runtime resolves.
 */
export function buildRuntimeManager(env: NodeJS.ProcessEnv = process.env): RuntimeManager {
  // Pass the RESOLVED path, not undefined-on-PATH-hit: the SDK's
  // codexPathOverride must point at the user's installed CLI, or it silently
  // runs its own bundled (older) codex binary with a stale default model.
  const codexBinaryPath = resolveCodexBinary(env);
  // Coco resolves from the user's installed CLI (login shell / PATH); it is not
  // an npm dependency so the path is passed straight through.
  const cocoBinaryPath = resolveCocoBinary(env);

  // Claude registers unconditionally; per-agent BASE_URL / API_KEY (runtimeEnv)
  // supply credentials at execution time, with global ANTHROPIC_* env as an
  // optional fallback default. Drive that fallback from the SAME injected env
  // the codex/coco lines (and the diagnostics below) use, not process.env.
  const manager = buildRuntimeManagerFromRegistrations([
    claudeRuntimeRegistration({ env }),
    {
      isAvailable: () => Boolean(codexBinaryPath),
      create: () => new CodexAdapter({ binaryPath: codexBinaryPath }),
    },
    {
      isAvailable: () => Boolean(cocoBinaryPath),
      create: () => new CocoAdapter({ binaryPath: cocoBinaryPath }),
    },
  ]);

  // A usable global credential fallback hinges on an auth token, not the base
  // URL (which has a default endpoint).
  logger.info(
    { globalFallback: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) },
    'Registered ClaudeCodeAdapter',
  );
  if (codexBinaryPath) {
    logger.info({ binaryPath: codexBinaryPath }, 'Registered CodexAdapter');
  } else {
    logger.warn('Codex runtime not registered: no codex binary resolvable');
  }
  if (cocoBinaryPath) {
    logger.info({ binaryPath: cocoBinaryPath }, 'Registered CocoAdapter');
  } else {
    logger.warn('Coco runtime not registered: no coco binary resolvable');
  }

  return manager;
}
