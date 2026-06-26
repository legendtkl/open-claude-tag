import type { LlmClient, LlmClientConfig } from './types.js';
import { AnthropicLlmClient } from './anthropic.js';
import { OpenAILlmClient } from './openai.js';

export function createLlmClient(config: LlmClientConfig): LlmClient {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicLlmClient(config);
    case 'openai':
      return new OpenAILlmClient(config);
    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}

/**
 * Create an LlmClient from environment variables.
 * Returns null if OPEN_TAG_LLM_PROVIDER is not set (graceful degradation).
 *
 * Env vars:
 *   OPEN_TAG_LLM_PROVIDER  - 'anthropic' | 'openai'
 *   OPEN_TAG_LLM_BASE_URL  - API base URL
 *   OPEN_TAG_LLM_API_KEY   - API key
 *   OPEN_TAG_LLM_MODEL     - Model name
 */
export function createLlmClientFromEnv(): LlmClient | null {
  const provider = process.env.OPEN_TAG_LLM_PROVIDER as 'anthropic' | 'openai' | undefined;
  if (!provider) return null;

  const baseUrl = process.env.OPEN_TAG_LLM_BASE_URL;
  const apiKey = process.env.OPEN_TAG_LLM_API_KEY;
  const model = process.env.OPEN_TAG_LLM_MODEL;

  if (!baseUrl || !apiKey || !model) return null;

  return createLlmClient({ provider, baseUrl, apiKey, model });
}
