import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLlmClient, createLlmClientFromEnv } from '../factory.js';
import type { LlmClientConfig } from '../types.js';

describe('createLlmClient', () => {
  it('creates an Anthropic client', () => {
    const config: LlmClientConfig = {
      provider: 'anthropic',
      baseUrl: 'http://localhost:8080',
      apiKey: 'test-key',
      model: 'claude-haiku-4-5-20251001',
    };
    const client = createLlmClient(config);
    expect(client.provider()).toBe('anthropic');
  });

  it('creates an OpenAI client', () => {
    const config: LlmClientConfig = {
      provider: 'openai',
      baseUrl: 'http://localhost:8080',
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
    };
    const client = createLlmClient(config);
    expect(client.provider()).toBe('openai');
  });

  it('throws for unsupported provider', () => {
    const config = {
      provider: 'unsupported' as 'anthropic',
      baseUrl: 'http://localhost:8080',
      apiKey: 'test-key',
      model: 'model',
    };
    expect(() => createLlmClient(config)).toThrow('Unsupported LLM provider');
  });
});

describe('createLlmClientFromEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    const {
      OPEN_TAG_LLM_PROVIDER: _provider,
      OPEN_TAG_LLM_BASE_URL: _baseUrl,
      OPEN_TAG_LLM_API_KEY: _apiKey,
      OPEN_TAG_LLM_MODEL: _model,
      ...rest
    } = originalEnv;

    process.env = { ...rest };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns null when OPEN_TAG_LLM_PROVIDER is not set', () => {
    delete process.env.OPEN_TAG_LLM_PROVIDER;
    expect(createLlmClientFromEnv()).toBeNull();
  });

  it('returns null when required env vars are missing', () => {
    process.env.OPEN_TAG_LLM_PROVIDER = 'anthropic';
    // Missing BASE_URL, API_KEY, MODEL
    expect(createLlmClientFromEnv()).toBeNull();
  });

  it('creates client when all env vars are set', () => {
    process.env.OPEN_TAG_LLM_PROVIDER = 'anthropic';
    process.env.OPEN_TAG_LLM_BASE_URL = 'http://localhost:8080';
    process.env.OPEN_TAG_LLM_API_KEY = 'test-key';
    process.env.OPEN_TAG_LLM_MODEL = 'claude-haiku-4-5-20251001';

    const client = createLlmClientFromEnv();
    expect(client).not.toBeNull();
    expect(client!.provider()).toBe('anthropic');
  });

  it('creates OpenAI client from env', () => {
    process.env.OPEN_TAG_LLM_PROVIDER = 'openai';
    process.env.OPEN_TAG_LLM_BASE_URL = 'http://localhost:8080';
    process.env.OPEN_TAG_LLM_API_KEY = 'test-key';
    process.env.OPEN_TAG_LLM_MODEL = 'gpt-4o-mini';

    const client = createLlmClientFromEnv();
    expect(client).not.toBeNull();
    expect(client!.provider()).toBe('openai');
  });
});
