export interface ClaudeAuthEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
}

export interface ClaudeStartupEnv extends ClaudeAuthEnv {
  ANTHROPIC_BASE_URL?: string;
}

export function resolveClaudeAuthToken(env: ClaudeAuthEnv): string {
  return env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || '';
}

export function resolveClaudeStartupConfig(
  env: ClaudeStartupEnv,
): { baseUrl: string; authToken: string } {
  return {
    baseUrl: env.ANTHROPIC_BASE_URL ?? '',
    authToken: resolveClaudeAuthToken(env),
  };
}
