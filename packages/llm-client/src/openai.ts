import OpenAI from 'openai';
import type { ChatMessage, ChatOptions, LlmClient, LlmClientConfig } from './types.js';

const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TIMEOUT_MS = 5000;

export class OpenAILlmClient implements LlmClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: LlmClientConfig) {
    this.model = config.model;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        max_tokens: maxTokens,
        temperature,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      },
      { timeout: timeoutMs },
    );

    return response.choices[0]?.message?.content ?? '';
  }

  provider(): string {
    return 'openai';
  }
}
