export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** Max tokens to generate (default: 256) */
  maxTokens?: number;
  /** Sampling temperature (default: 0) */
  temperature?: number;
  /** Request timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
}

export interface LlmClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  provider(): string;
}

export interface LlmClientConfig {
  provider: 'anthropic' | 'openai';
  baseUrl: string;
  apiKey: string;
  model: string;
}
