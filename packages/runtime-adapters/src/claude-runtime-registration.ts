import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import { resolveClaudeStartupConfig } from './claude-config.js';
import type { ClaudeCodeConfig } from './claude-code-adapter.js';
import type { ClaudeStartupEnv } from './claude-config.js';
import type { RuntimeAdapter, RuntimeRegistration } from './types.js';

interface RuntimeRegistrar {
  register(adapter: RuntimeAdapter): void;
}

interface RegisterClaudeRuntimeAdapterOptions {
  env?: ClaudeStartupEnv;
  imageDownloader?: ClaudeCodeConfig['imageDownloader'];
}

/**
 * Build the Claude Code {@link RuntimeRegistration} for the data-driven
 * `buildRuntimeManager` factory. Claude registers unconditionally — mirroring
 * Codex, which registers without global credentials. Per-agent BASE_URL /
 * API_KEY (carried via agents.runtimeEnv) supply the credentials at execution
 * time; the global baseUrl / authToken resolved here act only as an optional
 * fallback default.
 */
export function claudeRuntimeRegistration(
  options: RegisterClaudeRuntimeAdapterOptions = {},
): RuntimeRegistration {
  const { env = process.env, imageDownloader } = options;
  const { baseUrl, authToken } = resolveClaudeStartupConfig(env);
  return {
    isAvailable: () => true,
    create: () => new ClaudeCodeAdapter({ baseUrl, authToken, imageDownloader }),
  };
}

/**
 * Register Claude Code directly into a manager-like registrar. Retained for
 * direct callers; delegates to {@link claudeRuntimeRegistration} so the
 * credential resolution lives in one place.
 */
export function registerClaudeRuntimeAdapter(
  runtimeManager: RuntimeRegistrar,
  options: RegisterClaudeRuntimeAdapterOptions = {},
): boolean {
  runtimeManager.register(claudeRuntimeRegistration(options).create());
  return true;
}
