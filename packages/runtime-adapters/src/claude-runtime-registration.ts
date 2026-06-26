import { ClaudeCodeAdapter } from './claude-code-adapter.js';
import { resolveClaudeStartupConfig } from './claude-config.js';
import type { ClaudeCodeConfig } from './claude-code-adapter.js';
import type { ClaudeStartupEnv } from './claude-config.js';
import type { RuntimeAdapter } from './types.js';

interface RuntimeRegistrar {
  register(adapter: RuntimeAdapter): void;
}

interface RegisterClaudeRuntimeAdapterOptions {
  env?: ClaudeStartupEnv;
  imageDownloader?: ClaudeCodeConfig['imageDownloader'];
}

export function registerClaudeRuntimeAdapter(
  runtimeManager: RuntimeRegistrar,
  options: RegisterClaudeRuntimeAdapterOptions = {},
): boolean {
  const { env = process.env, imageDownloader } = options;
  const { baseUrl, authToken } = resolveClaudeStartupConfig(env);

  // Register unconditionally — mirroring the Codex adapter, which registers
  // without global credentials. Per-agent BASE_URL / API_KEY (carried via
  // agents.runtimeEnv) supply the credentials at execution time; the global
  // baseUrl / authToken resolved here act only as an optional fallback default.
  runtimeManager.register(
    new ClaudeCodeAdapter({
      baseUrl,
      authToken,
      imageDownloader,
    }),
  );
  return true;
}
