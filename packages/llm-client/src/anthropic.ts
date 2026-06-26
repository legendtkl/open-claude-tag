import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatOptions, LlmClient, LlmClientConfig } from './types.js';

const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TIMEOUT_MS = 5000;

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(config: LlmClientConfig) {
    this.model = config.model;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Extract system message (Anthropic uses top-level system parameter)
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const systemText = systemMessages.map((m) => m.content).join('\n');

    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: maxTokens,
        temperature,
        ...(systemText ? { system: systemText } : {}),
        messages: nonSystemMessages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      },
      { timeout: timeoutMs },
    );

    const textBlock = response.content.find((block) => block.type === 'text');
    return textBlock?.text ?? '';
  }

  provider(): string {
    return 'anthropic';
  }
}
